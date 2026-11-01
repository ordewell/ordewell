import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import type { IRunnerSession, QueuedTaskMessage, ScriptExit, ScriptFullOutput, ScriptRun, ScriptStatus, StructuredEvent } from '../interfaces/IRunner';
import type { RunnerCommand } from '../models/RunnerCommand';
import { commandLine, type ScriptBody } from '../models/ScriptTask';
import type { PlacedLaunch, RunnerPlacement } from './executionLease';
import { planDirectLaunch, type LaunchDeps } from '../utils/launch';
import { killTree, spawnInOwnGroup } from '../utils/processTree';
import { augmentedPath } from '../utils/shellPath';
import { assertWorkspaceExists } from '../utils/workspace';
import type { TaskShell, ToolOutcome } from '../interfaces/IFileSystem';
import { AbstractRunner, AbstractRunnerSession, type RunnerSpawnOptions } from './AbstractRunner';
import { runnerEnv } from './harness/runnerEnv';
import { resolveResearchShell, type ResearchShell } from './researchShell';

/**
 * What runs a script task's attempt, where a runner id would name a coding
 * agent: no registered runner does, and no model is involved (ADR-0035).
 */
export const SCRIPT_RUNNER = 'script';

/** Stderr kept per step for the failure reason: the end is where a command says why it failed. */
const ERROR_TAIL_CHARS = 4000;

/**
 * How much of one step's output its log keeps: the head as it streams, then
 * the tail once the step ends. Every attempt's file keeps it for good, and a
 * build log can run to megabytes; the ends are where a reader looks.
 */
const LOG_HEAD_CHARS = 32_000;
const LOG_TAIL_CHARS = 16_000;

/** The session's own plain output, kept bounded; the task's output source keeps what a reader is shown. */
const OUTPUT_KEPT_CHARS = 256 * 1024;

/**
 * The most an attempt's own file keeps. It is a guard against a runaway
 * command filling the disk, not a budget: the log's ends are what is bounded
 * for reading, and this is the whole output a failure is looked up in.
 */
const FULL_OUTPUT_MAX_CHARS = 64 * 1024 * 1024;

/**
 * How long after a step's 'exit' its pipes get to close: long enough for its
 * last output to drain, short enough that a descendant still holding them
 * does not hold up the task.
 */
const CLOSE_GRACE_MS = 2000;

const NO_MODEL = 'A script task runs no model, so it takes no messages or commands.';

/** How the sealed shell says it ran nothing (`OwnSealedRuns.run`). */
const SEALED_REFUSAL = 'Not run: ';

export type ScriptSpawnFn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe'];
    detached: boolean;
    shell: boolean;
    windowsVerbatimArguments?: boolean;
    windowsHide: true;
  },
) => ChildProcess;

/** Every OS touchpoint is injectable, and production uses the defaults. */
export interface ScriptRunnerDeps {
  spawn?: ScriptSpawnFn;
  platform?: NodeJS.Platform;
  /** The PATH steps run under. Defaults to the augmented PATH a runner gets. */
  resolvePath?: () => Promise<string>;
  /** The interpreter a `script` body runs in. Defaults to the research shell (ADR-0011). */
  shell?: () => ResearchShell;
  isDirectory?: (dir: string) => boolean;
  /** How the launch seam looks a program up on Windows (ADR-0010); the real filesystem and environment unless set. */
  launch?: Pick<LaunchDeps, 'exists' | 'comSpec' | 'powerShell' | 'pathExt'>;
  /**
   * Where an attempt's whole output is streamed, beside its task log: the log
   * keeps only the ends of a long output, and a failure is often in the
   * middle. Prepares the file's directory and returns its path; none is kept
   * without it.
   */
  fullOutputFile?: (taskId: string, attempt: number) => string;
  /** The most characters that file keeps; the {@link FULL_OUTPUT_MAX_CHARS} guard unless a test sets one. */
  fullOutputMaxChars?: number;
}

/** What one step is launched as: a program and its arguments, or a script for the host shell. */
interface StepLaunch {
  file: string;
  args: string[];
  shell: boolean;
  verbatim?: boolean;
  /** Where it really runs, when that is not this host. */
  placed?: PlacedLaunch;
}

interface ScriptSessionSetup {
  body: ScriptBody;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: ScriptSpawnFn;
  platform: NodeJS.Platform;
  launch: LaunchDeps;
  shell: () => ResearchShell;
  fullOutput?: { file: string; maxChars: number };
  /** A read-only script runs here, or not at all (ADR-0055 D8). */
  sealed?: TaskShell;
  /** The lease's container, which every step runs in (ADR-0059 L5). */
  placement?: RunnerPlacement;
}

/**
 * One attempt of a script task (ADR-0035): its body run at the workspace root
 * with no model. `commands` run in order with no shell, each program resolved
 * through the launch seam (ADR-0010), stopping at the first that fails; a
 * `script` runs once, in the research shell's interpreter. Each step's command,
 * output and exit status are its events, which are the task's log. Its end is
 * handed on as the attempt's evidence ({@link onScriptExit}), and only then
 * does the session exit.
 *
 * Every step leads its own process group, so the time limit, a stop and the
 * task's end reach whatever it started in that group. A process that leaves
 * the group (`setsid`, `setpgrp`) is out of reach of a group signal, and once
 * its parent exits nothing ties it to the step: holding it is the work of a
 * boundary around the task, a container or a lease (#97, #99), not of a signal.
 *
 * A read-only script's steps run sealed instead (ADR-0055 D8), in the shell a
 * read-only task's commands use and in its throwaway worktree: Stop and the time
 * limit reach them through its signal, and what they print comes as each ends.
 *
 * Under a container lease every step runs there, by the lease's placement, in
 * place of all of that: the group this host signals is a client, and the
 * container is the boundary, whatever leaves a process group inside it.
 */
export class ScriptSession extends AbstractRunnerSession {
  private readonly events = new EventEmitter();
  private readonly endListeners: Array<(exit: ScriptExit) => void> = [];
  private readonly steps: ScriptRun[];
  private readonly children: ChildProcess[] = [];
  private child: ChildProcess | null = null;
  /** The step under way, where a lease runs it. */
  private placed: PlacedLaunch | null = null;
  private output = '';
  private running = true;
  private stopped = false;
  private timedOut = false;
  private errorTail = '';
  private logged = 0;
  private logTail = '';
  private omitted = 0;
  private full: { file: string; stream: fs.WriteStream; written: number; dropped: number; failed: boolean } | null = null;
  /** Aborted to end a sealed step, which has no process of its own here to signal. */
  private readonly sealedEnd = new AbortController();
  private markGone!: () => void;
  private readonly gone = new Promise<void>((resolve) => { this.markGone = resolve; });

  constructor(id: string, taskId: string, private readonly setup: ScriptSessionSetup) {
    super(id, taskId);
    const { body } = setup;
    this.steps = 'commands' in body ? body.commands.map((argv) => ({ argv })) : [{ script: body.script }];
  }

  /** Whoever spawned it attaches its listeners when the spawn resolves, so the body starts a macrotask later. */
  begin(): void {
    setImmediate(() => { void this.run(); });
  }

  private async run(): Promise<void> {
    this.openFullOutput();
    const limit = setTimeout(() => this.expire(), this.setup.body.timeoutMs);
    limit.unref?.();
    let exit: ScriptExit = { outcome: 'passed' };
    for (const step of this.steps) {
      const named = 'argv' in step ? { command: commandLine(step.argv) } : {};
      // Ended between steps, the next one is not logged as run: it never was.
      const status = this.stopped || this.timedOut ? null : await this.runStep(step);
      if (this.timedOut) exit = { outcome: 'timed-out', ...named, timeoutMs: this.setup.body.timeoutMs, errorTail: status ? this.errorTail : '' };
      else if (this.stopped) exit = { outcome: 'stopped', ...named };
      else if (status && !passed(status)) exit = { outcome: 'failed', ...named, status, errorTail: this.errorTail };
      if (exit.outcome !== 'passed') break;
    }
    clearTimeout(limit);
    this.running = false;
    for (const child of this.children) killTree(child, { platform: this.setup.platform });
    const fullOutput = await this.closeFullOutput();
    if (fullOutput) exit = { ...exit, fullOutput };
    for (const listener of this.endListeners) {
      // One listener that throws must not keep the evidence from the rest, or the session from exiting.
      try {
        listener(exit);
      } catch (err) {
        console.error(`[ScriptSession] a listener threw on the end of ${this.id}:`, err);
      }
    }
    this.baseHandleExit(exit.outcome === 'passed' ? 0 : 1);
    this.markGone();
  }

  private async runStep(step: ScriptRun): Promise<ScriptStatus> {
    this.emit({ type: 'script_run', ...step });
    const started = Date.now();
    this.errorTail = '';
    let status: ScriptStatus;
    try {
      if (this.setup.sealed) status = await this.sealedStep(step, this.setup.sealed);
      else {
        const launch = this.setup.placement ? await this.placedLaunch(step, this.setup.placement) : await this.launchOf(step);
        if (this.stopped || this.timedOut) {
          launch.placed?.ended();
          status = { code: null, signal: null, error: 'it was ended before it started' };
        } else status = await this.spawnStep(launch);
      }
    } catch (err) {
      status = { code: null, signal: null, error: err instanceof Error ? err.message : String(err) };
    }
    this.flushLogTail();
    this.emit({ type: 'script_exit', durationMs: Date.now() - started, ...(this.timedOut ? { timedOut: true } : {}), ...status });
    return status;
  }

  /**
   * A step through the sealed shell: from the worktree root it was cut at, the
   * only place a sealed run may start, and on into the task's folder. A refusal
   * ran nothing, so it says it could not start rather than that it failed.
   */
  private sealedStep(step: ScriptRun, shell: TaskShell): Promise<ScriptStatus> {
    if (!shell.hold) return Promise.resolve({ code: null, signal: null, error: 'this host cannot run it sealed' });
    return shell.hold(async (runs) => {
      const root = runs.worktrees.find((tree) => this.setup.cwd === tree || this.setup.cwd.startsWith(`${tree}${path.sep}`));
      if (root === undefined) return { code: null, signal: null, error: `${this.setup.cwd} is no worktree of this task` };
      const inside = path.relative(root, this.setup.cwd);
      const line = 'argv' in step ? step.argv.map(shellQuoted).join(' ') : step.script;
      const outcome = await runs.run(inside ? `cd ${shellQuoted(inside)} && ${line}` : line, root);
      if (outcome.output) this.printError(outcome.output.endsWith('\n') ? outcome.output : `${outcome.output}\n`);
      return sealedStatus(outcome);
    }, this.sealedEnd.signal);
  }

  /**
   * What a lease launches for a step. Nothing of this host's goes with it: a
   * script is the container's own `sh`, whatever shell this host would have
   * picked, and only what the lease hands over crosses.
   */
  private async placedLaunch(step: ScriptRun, placement: RunnerPlacement): Promise<StepLaunch> {
    const [command, ...args] = 'argv' in step ? step.argv : ['sh', '-c', step.script];
    const placed = await placement.place({ command, args, env: {}, files: [] });
    return { file: placed.command, args: placed.args, shell: false, placed };
  }

  /**
   * An argument vector is never joined into a shell string: on POSIX it is
   * exec'd as written, and on Windows the launch seam finds the program the
   * way CreateProcess will not. A script goes to the research shell's
   * interpreter, the one the planner's own commands use.
   */
  private async launchOf(step: ScriptRun): Promise<StepLaunch> {
    if ('argv' in step) {
      const [named, ...args] = step.argv;
      // The seam reads a program named by its path against the host's own
      // directory; the step runs from the workspace root, so it is read there.
      const program = this.setup.platform === 'win32' && path.win32.basename(named) !== named && !path.win32.isAbsolute(named)
        ? path.win32.resolve(this.setup.cwd, named)
        : named;
      const plan = await planDirectLaunch(program, args, this.setup.launch);
      return { file: plan.file, args: plan.args, shell: false, ...(plan.verbatim ? { verbatim: true } : {}) };
    }
    const shell = this.setup.shell();
    return shell.file === null
      ? { file: step.script, args: [], shell: true }
      : { file: shell.file, args: [...shell.args, step.script], shell: false };
  }

  private spawnStep(launch: StepLaunch): Promise<ScriptStatus> {
    return new Promise((resolve) => {
      let settled = false;
      const stdout = new StringDecoder('utf8');
      const stderr = new StringDecoder('utf8');
      const finish = (status: ScriptStatus) => {
        if (settled) return;
        settled = true;
        this.print(stdout.end());
        this.printError(stderr.end());
        this.child = null;
        this.placed = null;
        launch.placed?.ended();
        resolve(status);
      };
      this.placed = launch.placed ?? null;
      const child = spawnInOwnGroup((detached) => this.setup.spawn(launch.file, launch.args, {
        cwd: this.setup.cwd,
        env: launch.placed ? { ...this.setup.env, ...launch.placed.env } : this.setup.env,
        // Nothing answers a prompt: a step that asks for input fails rather than waits.
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
        shell: launch.shell,
        ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
        windowsHide: true,
      }), this.setup.platform);
      this.child = child;
      this.children.push(child);
      child.stdout?.on('data', (chunk: Buffer) => this.print(stdout.write(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => this.printError(stderr.write(chunk)));
      child.on('error', (err) => finish({ code: null, signal: null, error: err.message }));
      // 'close', not 'exit': the step's last output may still be draining at its exit.
      child.on('close', (code, signal) => finish({ code, signal }));
      child.once('exit', (code, signal) => {
        const grace = setTimeout(() => finish({ code, signal }), CLOSE_GRACE_MS);
        grace.unref?.();
      });
    });
  }

  private expire(): void {
    if (!this.running) return;
    this.timedOut = true;
    this.endStep();
  }

  /** Ends the step under way, at each place it may be: a client killed here leaves what it started in a container running. */
  private endStep(): void {
    this.sealedEnd.abort();
    this.placed?.stop();
    if (this.child) killTree(this.child, { platform: this.setup.platform });
  }

  private print(text: string): void {
    if (!text) return;
    this.output = (this.output + text).slice(-OUTPUT_KEPT_CHARS);
    this.outputEmitter.emit('output', text);
    this.saveOutput(text);
    this.logOutput(text);
  }

  private printError(text: string): void {
    if (!text) return;
    this.errorTail = (this.errorTail + text).slice(-ERROR_TAIL_CHARS);
    this.print(text);
  }

  private openFullOutput(): void {
    const target = this.setup.fullOutput;
    if (!target) return;
    const stream = fs.createWriteStream(target.file);
    const full = { file: target.file, stream, written: 0, dropped: 0, failed: false };
    // A full disk or a missing directory loses the file, never the task's run or its verdict.
    stream.on('error', (err) => {
      if (!full.failed) console.error(`[ScriptSession] could not save the output of ${this.id} to ${target.file}:`, err);
      full.failed = true;
    });
    this.full = full;
  }

  private saveOutput(text: string): void {
    const full = this.full;
    if (!full || full.failed) return;
    const kept = text.slice(0, Math.max(0, this.setup.fullOutput!.maxChars - full.written));
    full.dropped += text.length - kept.length;
    if (!kept) return;
    full.written += kept.length;
    full.stream.write(kept);
  }

  /** Resolves once the file is on disk, so a reader of the exit finds it whole. */
  private async closeFullOutput(): Promise<ScriptFullOutput | undefined> {
    const full = this.full;
    if (!full) return undefined;
    this.full = null;
    if (!full.failed && full.dropped > 0) full.stream.write(`\n[Ordewell stopped saving output here: ${full.dropped} more characters were not saved]\n`);
    await new Promise<void>((resolve) => {
      // A stream that failed to open is already closed, and says so only once.
      if (full.stream.closed) { resolve(); return; }
      full.stream.once('close', () => resolve());
      full.stream.end();
    });
    return full.failed ? undefined : { file: full.file, droppedChars: full.dropped };
  }

  /** Streamed into the log until the step's head is full; past it, only a tail is kept, for {@link flushLogTail}. */
  private logOutput(text: string): void {
    const room = LOG_HEAD_CHARS - this.logged;
    const head = room > 0 ? text.slice(0, room) : '';
    if (head) {
      this.logged += head.length;
      this.emit({ type: 'script_output', text: head });
    }
    const rest = text.slice(head.length);
    if (!rest) return;
    this.logTail += rest;
    if (this.logTail.length > LOG_TAIL_CHARS) {
      this.omitted += this.logTail.length - LOG_TAIL_CHARS;
      this.logTail = this.logTail.slice(-LOG_TAIL_CHARS);
    }
  }

  private flushLogTail(): void {
    if (this.logTail) this.emit({ type: 'script_output', text: this.logTail, ...(this.omitted ? { omittedChars: this.omitted } : {}) });
    this.logged = 0;
    this.logTail = '';
    this.omitted = 0;
  }

  private emit(event: StructuredEvent): void {
    this.events.emit('event', event);
  }

  /** Ends the step under way and every one after it; resolves once the session has exited. */
  stop(): Promise<void> {
    if (this.running && !this.stopped) {
      this.stopped = true;
      this.endStep();
    }
    return this.gone;
  }

  kill(): void {
    void this.stop();
  }

  getOutput(): string { return this.output; }
  /** Nothing reads a step's input. */
  write(): void {}
  turnState(): 'working' | 'idle' { return this.running ? 'working' : 'idle'; }
  /** A script has no turns. */
  onTurnEnd(): void {}
  onEvent(listener: (event: StructuredEvent) => void): void { this.events.on('event', listener); }
  sendMessage(): string { throw new Error(NO_MODEL); }
  forceSend(): string { throw new Error(NO_MODEL); }
  forceSendQueued(): boolean { return false; }
  removeQueued(): boolean { return false; }
  queued(): QueuedTaskMessage[] { return []; }
  /** There is no turn to interrupt: Stop ends a script. */
  async interrupt(): Promise<void> {}
  nativeSessionId(): string | null { return null; }
  commands(): RunnerCommand[] { return []; }
  invokeCommand(): string { throw new Error(NO_MODEL); }
  answerPermission(): boolean { return false; }
  /** With no runner, nothing calls `task_complete`: the exit status is the evidence. */
  onTaskComplete(): void {}
  onToolCheckpoint(): void {}
  onScriptExit(listener: (exit: ScriptExit) => void): void { this.endListeners.push(listener); }
}

/**
 * Starts script task attempts (ADR-0035), as a runner starts a coding agent's,
 * so the task log, the merge gate, the Merge-all exclusion and the
 * tracked-file check meet one the way they meet an ops task. It reads only the
 * spawn's `script` body, `cwd` and `env`: there is no model, mode or prompt.
 * The step environment is the one a runner gets — the host's, cleaned, under
 * the workspace's own variables (ADR-0016).
 */
export class ScriptRunner extends AbstractRunner<ScriptSession> {
  private spawned = 0;

  constructor(private readonly deps: ScriptRunnerDeps = {}) {
    super();
  }

  async spawn(opts: RunnerSpawnOptions): Promise<IRunnerSession> {
    const body = opts.script;
    if (!body) throw new Error(`Task "${opts.title ?? opts.taskId}" has no script body: only a script task runs here.`);
    assertWorkspaceExists(opts.cwd, { isDirectory: this.deps.isDirectory });
    const resolvePath = this.deps.resolvePath ?? augmentedPath;
    const platform = this.deps.platform ?? process.platform;
    const PATH = await resolvePath();
    this.spawned += 1;
    const fullOutput = this.fullOutputFor(opts);
    const session = new ScriptSession(`script-${opts.taskId}-${this.spawned}`, opts.taskId, {
      body,
      cwd: opts.cwd,
      env: runnerEnv(PATH, opts.env),
      spawn: this.deps.spawn ?? ((file, args, options) => nodeSpawn(file, args, options)),
      platform,
      launch: { ...this.deps.launch, platform, resolvePath },
      shell: this.deps.shell ?? (() => resolveResearchShell()),
      ...(opts.sealed ? { sealed: opts.sealed } : {}),
      ...(opts.placement ? { placement: opts.placement } : {}),
      ...(fullOutput ? { fullOutput: { file: fullOutput, maxChars: this.deps.fullOutputMaxChars ?? FULL_OUTPUT_MAX_CHARS } } : {}),
    });
    this.registerSession(session.id, session);
    session.begin();
    return session;
  }

  /** An attempt with no number has no place to keep a file: a log would not know which attempt it was. */
  private fullOutputFor(opts: RunnerSpawnOptions): string | undefined {
    if (!this.deps.fullOutputFile || opts.attempt === undefined) return undefined;
    try {
      return this.deps.fullOutputFile(opts.taskId, opts.attempt);
    } catch (err) {
      console.error(`[ScriptRunner] could not prepare a file for the output of ${opts.taskId}:`, err);
      return undefined;
    }
  }
}

/** A word as a POSIX shell reads it back: a sealed run takes one line, and an argument vector stays what it was. */
function shellQuoted(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A sealed run has a shell's outcome, not a process's, and one the shell turned down ran nothing. */
function sealedStatus(outcome: ToolOutcome): ScriptStatus {
  if (outcome.success) return { code: 0, signal: null };
  if (outcome.output.startsWith(SEALED_REFUSAL)) return { code: null, signal: null, error: outcome.output };
  return { code: 1, signal: outcome.signal ?? null };
}

function passed(status: ScriptStatus): boolean {
  return status.code === 0 && !status.signal && status.error === undefined;
}


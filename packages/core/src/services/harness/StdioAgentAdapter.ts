import type { ChildProcess } from 'child_process';
import { augmentedPath, withPath } from '../../utils/shellPath';
import { planDirectLaunch, isExecutableResolved, ExecutableNotFoundError } from '../../utils/launch';
import { assertWorkspaceExists } from '../../utils/workspace';
import { killTree } from '../../utils/processTree';
import { LineBuffer, type AgentAdapter, type AgentEvent, type AgentProcessDeps, type AgentStartOptions } from './AgentAdapter';

/** Stderr kept for the failure message; a dying CLI's last words are the only useful diagnostic. */
const STDERR_TAIL_CHARS = 4000;
/** An idle agent that chatters must not grow the between-turn buffer without bound. */
const BETWEEN_TURN_EVENT_CAP = 50;

/**
 * Event kinds never carried across a turn boundary. Reply text belongs to the
 * turn that produced it, and the two terminal kinds would settle the *next*
 * turn the moment it opened — a trailing `turn/completed` after a fatal error
 * would leave the following message answered by nothing at all.
 */
const TURN_SCOPED_EVENTS = new Set(['assistant_text', 'turn_end', 'error']);

export interface SpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Shared plumbing for the agents that speak newline-delimited JSON over stdio.
 *
 * One long-lived process per planner session (ADR-0009, T3): spawned at
 * `start`, fed one message per turn, disposed at the session boundary. The
 * alternative — respawning per turn — pays a cold start on every message
 * *including each corrective re-emit*, and re-reads the repository from
 * scratch when it cannot resume.
 *
 * Subclasses own their agent's protocol: what to spawn, how to phrase a user
 * turn, and how to read one protocol line. Everything below — line framing,
 * turn lifecycle, abort, stderr capture, premature-exit detection — is the
 * same for all of them.
 */
export abstract class StdioAgentAdapter implements AgentAdapter {
  abstract readonly agentId: string;

  protected process: ChildProcess | null = null;
  protected sessionId: string | null = null;
  private readonly stdout = new LineBuffer();
  private stderrTail = '';
  private exited: { code: number | null; signal: string | null } | null = null;
  /** Set for the duration of a turn. Outside one, events are buffered rather than dropped. */
  private turnEmit: ((event: AgentEvent) => void) | null = null;
  /**
   * Events the agent produced between turns — in practice the startup warnings
   * that arrive during the handshake. Dropping them hid the one diagnostic
   * that explains a planner which cannot read the workspace, so they are held
   * until a turn exists to show them in.
   */
  private betweenTurns: AgentEvent[] = [];
  private disposed = false;
  /** Resolves when the process ends, so a handshake can lose the race instead of waiting out its timeout. */
  protected processEnded!: Promise<void>;
  /** The environment the agent was spawned under, for any side process a handshake needs. */
  protected spawnEnv: NodeJS.ProcessEnv = {};
  private markEnded: (() => void) | null = null;

  constructor(protected deps: AgentProcessDeps) {}

  /** The command line that starts this agent in its read-only mode. */
  protected abstract spawnSpec(opts: AgentStartOptions): SpawnSpec;

  /** The bytes written to stdin to open one user turn. Must end with a newline. */
  protected abstract turnPayload(message: string): string;

  /**
   * Interpret one line of the agent's protocol, emitting normalized events.
   * Emitting `turn_end` ends the turn; emitting `error` ends it as a failure.
   */
  protected abstract handleLine(line: string, emit: (event: AgentEvent) => void): void;

  /** Protocol handshake, if the agent needs one before it accepts a turn. */
  protected async handshake(_opts: AgentStartOptions): Promise<void> {}

  async start(opts: AgentStartOptions): Promise<void> {
    // Checked before anything else: a workspace deleted out from under a
    // stale `process.cwd()` otherwise surfaces as `spawn`'s ENOENT, which
    // reads as a missing agent binary rather than a missing directory.
    assertWorkspaceExists(opts.cwd, { isDirectory: this.deps.isDirectory });
    this.processEnded = new Promise<void>((resolve) => { this.markEnded = resolve; });
    const spec = this.spawnSpec(opts);
    const resolvePath = this.deps.resolvePath ?? augmentedPath;
    // Same PATH treatment as model discovery and the headless runner: the
    // agent binary must resolve wherever the user installed it, even under the
    // minimal PATH a GUI-launched host inherits.
    const PATH = await resolvePath();

    this.spawnEnv = withPath(process.env, PATH, spec.env);
    // On POSIX this hands back `spec` untouched; on Windows it resolves the
    // agent's `.exe` (or routes its `.cmd` shim through cmd.exe), because
    // CreateProcess performs no PATHEXT lookup of its own.
    const launch = await planDirectLaunch(spec.command, spec.args, {
      platform: this.deps.platform,
      resolvePath,
    });
    if (!isExecutableResolved(spec.command, launch, PATH, { platform: this.deps.platform, exists: this.deps.exists })) {
      throw new ExecutableNotFoundError(spec.command, PATH);
    }
    this.process = this.deps.spawn(launch.file, launch.args, {
      env: this.spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      windowsVerbatimArguments: launch.verbatim,
    });

    // Every protocol line goes to `handleLine`, turn or no turn: an agent's
    // handshake and its session-id announcement both arrive before the first
    // message is sent, and dropping them left the handshake waiting on a reply
    // that had already come and gone.
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.stdout.push(chunk.toString(), (line) => this.handleLine(line, (event) => {
        if (this.turnEmit) this.turnEmit(event);
        else if (!TURN_SCOPED_EVENTS.has(event.type) && this.betweenTurns.length < BETWEEN_TURN_EVENT_CAP) {
          this.betweenTurns.push(event);
        }
      }));
    });
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    this.process.on('exit', (code, signal) => { this.exited = { code, signal }; this.markEnded?.(); });
    this.process.on('error', (err) => {
      this.stderrTail = (this.stderrTail + `\n${err.message}`).slice(-STDERR_TAIL_CHARS);
      this.exited = { code: -1, signal: null };
      this.markEnded?.();
    });

    await this.handshake(opts);
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    if (!this.process) throw new Error(`${this.agentId} planner session is not started`);
    if (this.exited) {
      onEvent({ type: 'error', message: this.exitMessage() });
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.turnEmit = null;
        signal?.removeEventListener('abort', onAbort);
        this.process?.removeListener('exit', onExit);
        this.process?.removeListener('error', onExit);
        resolve();
      };

      const emit = (event: AgentEvent) => {
        onEvent(event);
        if (event.type === 'turn_end' || event.type === 'error') finish();
      };

      // A process that dies mid-turn must surface its stderr, not hang the
      // planner behind a `turn_end` that will never come.
      const onExit = () => {
        if (settled) return;
        onEvent({ type: 'error', message: this.exitMessage() });
        finish();
      };
      const onAbort = () => {
        if (settled) return;
        // Stop means stop: the agent is holding real context we are abandoning,
        // so the process goes with the turn rather than being left running.
        this.dispose();
        finish();
      };

      this.turnEmit = emit;
      this.process!.once('exit', onExit);
      this.process!.once('error', onExit);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });

      const buffered = this.betweenTurns;
      this.betweenTurns = [];
      for (const event of buffered) {
        emit(event);
        if (settled) return;
      }

      try {
        this.process!.stdin!.write(this.turnPayload(message));
      } catch (err) {
        onEvent({ type: 'error', message: `Could not send to ${this.agentId}: ${err instanceof Error ? err.message : String(err)}` });
        finish();
      }
    });
  }

  nativeSessionId(): string | null { return this.sessionId; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.turnEmit = null;
    const proc = this.process;
    this.process = null;
    // Tree-wide, because on Windows the direct child may be the cmd.exe shim
    // rather than the agent. The forced follow-up is scheduled and unref'd, so
    // a disposed planner is never the reason the host refuses to exit.
    killTree(proc, { platform: this.deps.platform });
  }

  /** Write one raw protocol line to the agent. */
  protected writeLine(payload: unknown): void {
    this.process?.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  /** Fail-safe contract: a dead agent reports its own last words, never an empty bubble. */
  protected exitMessage(): string {
    const how = this.exited?.signal
      ? `was killed (${this.exited.signal})`
      : `exited with code ${this.exited?.code ?? 'unknown'}`;
    const tail = this.stderrTail.trim();
    return `The ${this.agentId} planner ${how}.${tail ? `\n\n${tail}` : ''}`;
  }

  /** Parse a protocol line, ignoring the non-JSON banners some CLIs print. */
  protected static parse<T>(line: string): T | null {
    try {
      const value = JSON.parse(line);
      return typeof value === 'object' && value !== null ? (value as T) : null;
    } catch {
      return null;
    }
  }
}

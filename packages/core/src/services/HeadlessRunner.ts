import { spawn as nodeSpawn, execSync, ChildProcess } from 'child_process';
import type { Writable } from 'stream';
import { ITerminalRunner, ITerminalSession } from '../interfaces/ITerminalRunner';
import { buildRunnerInvocation } from './buildRunnerArgs';
import { AbstractTerminalSession, AbstractRunner } from './AbstractRunner';
import { augmentedPath, withPath } from '../utils/shellPath';
import { stripAnsi, wrapWithPty, type PtyWrapOptions } from '../utils/shell';
import { planDirectLaunch, type LaunchDeps, type LaunchPlan } from '../utils/launch';
import { killTree } from '../utils/processTree';

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: Array<'pipe' | 'ignore'>;
    cwd: string;
    /** Set by the Windows batch route, where `args` is already a quoted command line. */
    windowsVerbatimArguments?: boolean;
  },
) => ChildProcess;

/** Test seam: every OS touchpoint is injectable; production uses the defaults. */
export interface HeadlessRunnerDeps {
  spawnImpl?: SpawnFn;
  hasScriptCmd?: () => boolean;
  resolvePath?: () => Promise<string>;
  /**
   * Overrides for executable resolution ({@link planDirectLaunch}). Only the
   * Windows branch consults them, so a POSIX test never needs to pass anything.
   */
  launchDeps?: LaunchDeps;
}

/**
 * `script` is POSIX-only, and the probe reflects that: `which` does not exist
 * on Windows, so `execSync` throws and the answer is a correct `false`. The
 * PTY wrapper (`wrapWithPty`) is therefore never reached there — which is the
 * intended outcome, not a lucky one.
 */
function defaultHasScriptCmd(): boolean {
  if (process.platform === 'win32') return false;
  try { execSync('which script', { stdio: 'ignore' }); return true; } catch { return false; }
}

export class HeadlessSession extends AbstractTerminalSession {
  private process: ChildProcess | null = null;
  private outputBuffer = '';
  private controlStream: Writable | null = null;

  constructor(id: string, taskId: string, private spawnImpl: SpawnFn) {
    super(id, taskId);
  }

  get isStarted(): boolean { return this.process !== null; }

  start(launch: LaunchPlan, cwd: string, resolvedPath: string, env?: Record<string, string>, options?: { controlChannel?: boolean }): void {
    // Killed while the spawn was still in flight — starting now leaks an agent
    // nobody is watching.
    if (this.exited || this.process) return;

    const stdio: Array<'pipe' | 'ignore'> = ['pipe', 'pipe', 'pipe'];
    if (options?.controlChannel) stdio.push('pipe');

    this.process = this.spawnImpl(launch.file, launch.args, {
      env: withPath(process.env, resolvedPath, env),
      stdio,
      cwd,
      windowsVerbatimArguments: launch.verbatim,
    });

    // A surface that opened the wrapper's control channel (PTY resizes) writes
    // into this pipe. EPIPE after the child dies is not worth surfacing — the
    // wrapper is gone, the resize is moot.
    if (options?.controlChannel) {
      // The extra pipe is a Duplex; only the writable half is used here.
      this.controlStream = (this.process.stdio?.[3] as Writable | null) ?? null;
      this.controlStream?.on('error', () => {});
    }

    const onData = (data: Buffer) => {
      const raw = data.toString();
      this.outputBuffer += stripAnsi(raw);
      this.outputEmitter.emit('output', raw);
    };
    this.process.stdout?.on('data', onData);
    this.process.stderr?.on('data', onData);

    this.process.on('close', (code) => { this.baseHandleExit(code ?? -1); });
    this.process.on('error', (err) => {
      this.outputBuffer += `\nProcess error: ${err.message}\n`;
      this.outputEmitter.emit('output', `\nProcess error: ${err.message}\n`);
      this.baseHandleExit(-1);
    });
  }

  kill(): void {
    // Tree-wide: on Windows the direct child may be a cmd.exe shim, and killing
    // it would leave the runner itself alive and still editing the workspace.
    killTree(this.process);
    // No child means no 'close' event, so watchers would never settle.
    if (!this.process) this.baseHandleExit(-1);
  }

  getOutput(): string { return this.outputBuffer; }

  write(text: string): void {
    if (this.process?.stdin && !this.process.killed) {
      this.process.stdin.write(text);
    }
  }

  /** PTY resize requests from a surface that owns the terminal rendering the wrapper. */
  writeControl(text: string): void {
    if (this.controlStream && !this.controlStream.destroyed) {
      this.controlStream.write(text);
    }
  }
}

export type RunnerSpawnOptions = Parameters<ITerminalRunner['spawn']>[0];

/** Everything needed to start one runner process, resolved before any child exists. */
export interface PreparedLaunch {
  launch: LaunchPlan;
  resolvedPath: string;
  env: Record<string, string>;
  /** True when the invocation was wrapped in `script` to allocate a PTY. */
  pty: boolean;
}

export class HeadlessRunner extends AbstractRunner<HeadlessSession> {
  private spawnImpl: SpawnFn;
  private hasScriptCmd: () => boolean;
  private resolvePath: () => Promise<string>;
  private launchDeps: LaunchDeps;

  /**
   * Session shape: a piped subprocess is not a terminal, so runners get their
   * non-interactive subcommand. The VS Code runner owns a pseudoterminal and
   * overrides this to true. Autonomy is a separate axis (see `ResolveContext`)
   * and stays on either way — no surface has a human answering permission
   * prompts on the orchestrator's behalf.
   */
  protected readonly defaultInteractive: boolean = false;

  constructor(deps: HeadlessRunnerDeps = {}) {
    super();
    this.spawnImpl = deps.spawnImpl ?? nodeSpawn;
    this.hasScriptCmd = deps.hasScriptCmd ?? defaultHasScriptCmd;
    this.resolvePath = deps.resolvePath ?? augmentedPath;
    this.launchDeps = { resolvePath: this.resolvePath, ...deps.launchDeps };
  }

  protected createSession(id: string, taskId: string): HeadlessSession {
    return new HeadlessSession(id, taskId, this.spawnImpl);
  }

  /** Everything up to, but not including, spawning — so a surface that owns its own child reaches the same decisions. */
  protected async prepareLaunch(opts: RunnerSpawnOptions, ptyOptions?: PtyWrapOptions): Promise<PreparedLaunch> {
    const interactive = this.defaultInteractive;

    const invocation = buildRunnerInvocation({
      runner: opts.runner,
      prompt: opts.prompt,
      modelId: opts.modelId,
      thinkingEffort: opts.thinkingEffort,
      modelVariants: opts.modelVariants,
      mode: opts.mode,
      headless: opts.headless ?? true,
      interactive,
      cwd: opts.cwd,
      registry: opts.registry!,
    });

    // Manifest `requiresTty` means "needs one even when piped"; an interactive
    // session is the agent's TUI, so it needs one without declaring it. Both
    // gated on `script`, which does not exist on Windows.
    const manifest = opts.registry?.get(opts.runner)?.manifest;
    const pty = (manifest?.runner.requiresTty === true || interactive) && this.hasScriptCmd();

    // Same PATH treatment as model discovery: the runner binary must resolve
    // wherever the user installed it, even under a GUI-minimal PATH.
    const resolvedPath = await this.resolvePath();

    const { command, args } = pty
      ? wrapWithPty(invocation.command, invocation.args, ptyOptions)
      : { command: invocation.command, args: invocation.args };

    return {
      launch: await planDirectLaunch(command, args, this.launchDeps),
      resolvedPath,
      env: invocation.env,
      pty,
    };
  }

  async spawn(opts: RunnerSpawnOptions): Promise<ITerminalSession> {
    const id = `ordewell-${opts.taskId.slice(0, 8)}`;
    const session = this.createSession(id, opts.taskId);
    const prepared = await this.prepareLaunch(opts);

    const modeStr = opts.mode === 'plan' ? 'plan' : 'build';
    console.error(`[headless] Starting ${opts.runner} [${modeStr}] (${opts.modelId || 'default'}) for task ${opts.taskId.slice(0, 8)}${prepared.pty ? ' (PTY)' : ''}`);

    session.start(prepared.launch, opts.cwd, prepared.resolvedPath, prepared.env);
    this.registerSession(id, session);
    return session;
  }
}

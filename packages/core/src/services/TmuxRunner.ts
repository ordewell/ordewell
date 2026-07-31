import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { ITerminalSession } from '../interfaces/ITerminalRunner';
import { buildRunnerInvocation } from './buildRunnerArgs';
import { AbstractTerminalSession, AbstractRunner } from './AbstractRunner';
import { augmentedPath } from '../utils/shellPath';
import { posixShellQuote, stripAnsi } from '../utils/shell';
import { tmuxSessionName, tmuxSocketName, tmuxWindowName } from '../utils/tmux';

const EXIT_RE = /<<<ORDEWELL_TMUX_EXIT:(\d+)>>>/;

export type ExecFileFn = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const defaultExecFile: ExecFileFn = async (command, args) => {
  const { stdout, stderr } = await execFileAsync(command, args);
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** Test seam: every OS touchpoint is injectable; production uses the defaults. */
export interface TmuxRunnerDeps {
  port: number;
  execFileImpl?: ExecFileFn;
  resolvePath?: () => Promise<string>;
  pollIntervalMs?: number;
  logDir?: string;
}

class TmuxSession extends AbstractTerminalSession {
  private outputBuffer = '';
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    id: string,
    taskId: string,
    private tmuxSession: string,
    private windowName: string,
    private execFileImpl: ExecFileFn,
    private pollIntervalMs: number,
    private logPath: string,
    private socket: string,
  ) {
    super(id, taskId);
  }

  private get target(): string {
    return `${this.tmuxSession}:${this.windowName}`;
  }

  /** Every tmux call must name the daemon's own socket; an unprefixed one
   * silently targets the shared default server (see `tmuxSocketName`). */
  private tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.execFileImpl('tmux', ['-L', this.socket, ...args]);
  }

  /**
   * Runs the invocation in a fresh tmux window, tailed via `pipe-pane` into a
   * log file rather than polling `capture-pane` snapshots — a byte-exact
   * stream needs no diff/resync heuristics. The command is wrapped so the
   * window survives its own exit (an `exec`'d login shell), which is what
   * lets the user keep poking at a finished task's terminal.
   */
  async start(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
    writeFileSync(this.logPath, '');

    const envAssignments = Object.entries(env ?? {})
      .map(([k, v]) => `${k}=${posixShellQuote(v)}`)
      .join(' ');
    const inner = [command, ...args].map(posixShellQuote).join(' ');
    const prefix = envAssignments ? `env ${envAssignments} ` : '';
    const loginShell = process.env.SHELL || '/bin/bash';
    const shellCmd = `${prefix}${inner}; printf '\\n<<<ORDEWELL_TMUX_EXIT:%s>>>\\n' "$?"; exec ${posixShellQuote(loginShell)} -l`;

    await this.tmux(['new-window', '-t', this.tmuxSession, '-n', this.windowName, '-c', cwd, shellCmd]);
    await this.tmux(['pipe-pane', '-t', this.target, `cat >> ${posixShellQuote(this.logPath)}`]);

    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  private poll(): void {
    if (this.exited) return;
    let content: string;
    try {
      content = existsSync(this.logPath) ? readFileSync(this.logPath, 'utf8') : '';
    } catch {
      return;
    }
    if (content.length <= this.offset) return;

    const diff = content.slice(this.offset);
    this.offset = content.length;
    this.outputBuffer += stripAnsi(diff);
    this.outputEmitter.emit('output', diff);

    // Scan the accumulated tail, not just this read: pipe-pane can flush half
    // the sentinel in one write and the rest in the next, and a marker split
    // across two reads must still be seen exactly once.
    const match = this.outputBuffer.slice(-4096).match(EXIT_RE);
    if (match) this.finish(Number(match[1]));
  }

  /**
   * A task finishing (or being killed) stops observation, but never the
   * window itself on the sentinel path — only `kill()` closes the window.
   * Piping is turned off and the log file removed either way, so a finished
   * task doesn't leave a `cat` process appending to it for the rest of the
   * daemon's life.
   */
  private finish(code: number): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tmux(['pipe-pane', '-t', this.target]).catch(() => {});
    try {
      unlinkSync(this.logPath);
    } catch {
      /* already gone */
    }
    this.baseHandleExit(code);
  }

  kill(): void {
    this.tmux(['kill-window', '-t', this.target]).catch(() => {});
    this.finish(-1);
  }

  getOutput(): string {
    return this.outputBuffer;
  }

  write(text: string): void {
    this.tmux(['send-keys', '-t', this.target, '-l', text]).catch(() => {});
  }
}

/**
 * Runs tasks in a real tmux window instead of a piped subprocess, so a user
 * can open a genuine, interactive terminal on any task (running or
 * finished) from outside Ordewell's own process. `ITerminalSession` hides the
 * transport from `VerdictEngine`/`PoolAwareRunner`, so orchestration is
 * unchanged — this is a drop-in replacement for `HeadlessRunner`.
 */
export class TmuxRunner extends AbstractRunner<TmuxSession> {
  private sessionName: string;
  private socket: string;
  private execFileImpl: ExecFileFn;
  private resolvePath: () => Promise<string>;
  private pollIntervalMs: number;
  private logDir: string;
  /** Retries get a freshly named window so a failed attempt's output stays inspectable. */
  private attempts = new Map<string, number>();
  private ready: Promise<void> | null = null;

  constructor(deps: TmuxRunnerDeps) {
    super();
    this.sessionName = tmuxSessionName(deps.port);
    this.socket = tmuxSocketName(deps.port);
    this.execFileImpl = deps.execFileImpl ?? defaultExecFile;
    this.resolvePath = deps.resolvePath ?? augmentedPath;
    this.pollIntervalMs = deps.pollIntervalMs ?? 500;
    this.logDir = deps.logDir ?? tmpdir();
  }

  /**
   * Reaps a session orphaned by a crashed prior daemon on the same port, then
   * creates a fresh one. Memoized: `spawn` awaits it too, so a task spawned
   * before startup's own call has settled never lands in a missing session —
   * and a settled failure clears the memo so the next spawn can retry.
   */
  ensureSession(): Promise<void> {
    this.ready ??= this.createFreshSession().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  /** Every tmux call must name this daemon's socket; see `tmuxSocketName`. */
  private tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.execFileImpl('tmux', ['-L', this.socket, ...args]);
  }

  private async createFreshSession(): Promise<void> {
    try {
      await this.tmux(['has-session', '-t', this.sessionName]);
      await this.tmux(['kill-session', '-t', this.sessionName]);
    } catch {
      /* no stale session */
    }
    await this.tmux(['new-session', '-d', '-s', this.sessionName]);
    await this.configureScrolling();
  }

  /**
   * Makes an attached runner terminal scrollable with the mouse wheel and
   * Page Up/Down. A fresh tmux session ships with `mouse off`, a 2000-line
   * scrollback, and no PageUp binding — none of which lets a user page back
   * through a finished task's output, which is the whole point of opening its
   * window. Scoping is harmless: the daemon owns a private socket
   * (`tmuxSocketName`), so these server-wide options touch nothing but its
   * own session. Best-effort so an ancient or stripped tmux cannot stop tasks
   * from spawning — the session still works without the scroll comforts.
   */
  private async configureScrolling(): Promise<void> {
    try {
      // `history-limit` only governs windows created after it is set, so it
      // must run before any `new-window` — once, here at session creation.
      await this.tmux(['set-option', '-g', 'history-limit', '100000']);
      // Wheel-aware copy mode: with `mouse on`, wheel-up enters copy mode and
      // scrolls the pane's scrollback instead of going to the inner app.
      await this.tmux(['set-option', '-g', 'mouse', 'on']);
      // PageUp enters copy mode scrolled up one page; without a root binding it
      // is delivered to the inner app and never reaches tmux's scrollback.
      await this.tmux(['bind-key', '-n', 'PageUp', 'copy-mode', '-u']);
      // PageUp/PageDown then page through the scrollback inside copy mode, in
      // both key tables so the bindings hold regardless of `mode-keys`.
      await this.tmux(['bind-key', '-T', 'copy-mode', 'PageUp', 'send-keys', '-X', 'page-up']);
      await this.tmux(['bind-key', '-T', 'copy-mode', 'PageDown', 'send-keys', '-X', 'page-down']);
      await this.tmux(['bind-key', '-T', 'copy-mode-vi', 'PageUp', 'send-keys', '-X', 'page-up']);
      await this.tmux(['bind-key', '-T', 'copy-mode-vi', 'PageDown', 'send-keys', '-X', 'page-down']);
    } catch {
      /* scroll comforts unavailable — session still usable */
    }
  }

  /**
   * Called on daemon shutdown — the one guarantee against leaked tmux
   * processes. Kills the whole server, not just the session: the socket
   * belongs to this daemon alone, so nothing else can be on it, and a runner
   * that somehow escaped its session would otherwise keep running (and keep
   * billing) unattached for as long as the server lived.
   */
  async killSession(): Promise<void> {
    this.ready = null;
    try {
      await this.tmux(['kill-server']);
    } catch {
      /* already gone */
    }
  }

  async spawn(opts: {
    taskId: string;
    runner: string;
    prompt: string;
    modelId?: string;
    thinkingEffort?: string;
    modelVariants?: string[];
    mode?: string;
    headless?: boolean;
    cwd: string;
    registry?: import('../plugins/RunnerRegistry').RunnerRegistry;
    planSessionId?: string;
  }): Promise<ITerminalSession> {
    const invocation = buildRunnerInvocation({
      runner: opts.runner,
      prompt: opts.prompt,
      modelId: opts.modelId,
      thinkingEffort: opts.thinkingEffort,
      modelVariants: opts.modelVariants,
      mode: opts.mode,
      headless: opts.headless ?? true,
      registry: opts.registry!,
    });

    await this.ensureSession();

    // Attempts are counted per plan-scoped task: task ids like "task-1" repeat
    // across plans, and mixing their counters would mislabel retry windows.
    const attemptKey = `${opts.planSessionId ?? ''}:${opts.taskId}`;
    const attempt = (this.attempts.get(attemptKey) ?? 0) + 1;
    this.attempts.set(attemptKey, attempt);
    const base = tmuxWindowName(opts.taskId, opts.planSessionId);
    const windowName = attempt > 1 ? `${base}-${attempt}` : base;

    // The window name is already unique per plan, task and attempt, so it also
    // keys the session registry and the log file — two live sessions must
    // never share a log, or their output streams would cross-contaminate.
    const id = `ordewell-${windowName}`;
    const session = new TmuxSession(
      id,
      opts.taskId,
      this.sessionName,
      windowName,
      this.execFileImpl,
      this.pollIntervalMs,
      join(this.logDir, `${id}.log`),
      this.socket,
    );

    invocation.env = { ...invocation.env, PATH: await this.resolvePath() };
    await session.start(invocation.command, invocation.args, opts.cwd, invocation.env);
    this.registerSession(id, session);
    return session;
  }
}

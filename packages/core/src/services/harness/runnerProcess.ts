import type { ChildProcess } from 'child_process';
import { Socket } from 'net';
import { StringDecoder } from 'string_decoder';
import { augmentedPath } from '../../utils/shellPath';
import { planDirectLaunch, isExecutableResolved, ExecutableNotFoundError } from '../../utils/launch';
import { assertWorkspaceExists } from '../../utils/workspace';
import { killTree, spawnInOwnGroup } from '../../utils/processTree';
import { workspaceEnvOf } from '../workspaceEnv';
import { runnerEnv } from './runnerEnv';
import type { AgentProcessDeps } from './AgentAdapter';
import type { PlacedLaunch } from '../executionLease';

/** Stderr kept for the failure message; a dying CLI's last words are the only useful diagnostic. */
const STDERR_TAIL_CHARS = 4000;

/**
 * How long after 'exit' the pipes get to close before the process is ended
 * anyway. Long enough for a dead CLI's buffered output to drain; short enough
 * that a descendant still holding its stdout or stderr does not hang the turn.
 */
const CLOSE_GRACE_MS = 2000;

/**
 * Let go of the pipes of a runner that has exited, for a descendant that still
 * holds them: one setsid'd out of the group outlives Stop, and its pipes alone
 * would keep the host alive for as long as it runs. Unref'd rather than
 * destroyed, so the host can exit without the holder's next write meeting a
 * closed pipe — SIGPIPE would end a process that is not ours to stop — and
 * still drained, so a full pipe never blocks it either. The pipes close, and
 * their handles go, when the holder lets go of them.
 */
function releasePipes(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (stream instanceof Socket) stream.unref();
  }
  for (const stream of [child.stdout, child.stderr]) {
    if (stream instanceof Socket) stream.resume();
  }
}

export interface RunnerCommand {
  command: string;
  args: string[];
  /**
   * Variables set over the workspace's own (ADR-0016), so they win. Handed the
   * workspace's, for a runner whose value merges into one of them.
   */
  env?: (workspace: Record<string, string>) => Record<string, string>;
  /** Paths on this host, named in `args`, that the process reads, for a placement to bring along (ADR-0059 L5). */
  files?: readonly string[];
  /**
   * Names this launch must not inherit from the host or the workspace — the
   * credentials a native-shell planner keeps out of its process (ADR-0036 N2.2).
   */
  envDrop?: (name: string) => boolean;
  /**
   * Where the process starts, when not in the workspace it serves, whose
   * variables it still gets. A placement starts its runner where it puts it,
   * so a placed launch cannot name one.
   */
  cwd?: string;
}

export interface RunnerExit {
  code: number | null;
  signal: string | null;
}

/**
 * The one runner process a structured adapter drives (ADR-0018), whatever its
 * protocol: launched under the cleaned environment in its own process group,
 * its output decoded as UTF-8, its stderr tail kept for the failure message,
 * its end observable, and its whole tree killed on dispose.
 *
 * Constructed before it is started, so an adapter can tie a resource to
 * {@link ended} while it is still deciding what to launch.
 */
export class RunnerProcess {
  /** Resolves when the process ends — or fails to spawn — so a handshake can lose the race instead of waiting out its timeout. */
  readonly ended: Promise<void>;
  private markEnded!: () => void;
  private child: ChildProcess | null = null;
  /** Disposed before, or while, it launched: nothing may be spawned for an owner that has gone. */
  private disposed = false;
  private exitStatus: RunnerExit | null = null;
  /** The process itself reported its end, before its pipes drained; see {@link hasExited}. */
  private exitReported = false;
  private stderrTail = '';
  private spawnEnv: NodeJS.ProcessEnv = {};
  /** What a lease launched in this process's place, where one did (ADR-0059 L5). */
  private placed: PlacedLaunch | null = null;
  /** Stdout readers' end-of-stream flushes, for an end the pipe itself never reports. */
  private readonly stdoutEnds = new Set<() => void>();

  constructor(private readonly deps: AgentProcessDeps) {
    this.ended = new Promise<void>((resolve) => { this.markEnded = resolve; });
  }

  /**
   * Launch the process, then run the adapter's `handshake` on it. A handshake
   * that throws takes the process down with it: no caller keeps an adapter
   * whose start threw, so a process left running here — a refused handshake,
   * one that timed out — would have no owner.
   *
   * `command` is asked for only once `cwd` is known to exist, and `handshake`
   * is called in the same tick as the spawn, so a listener it attaches hears
   * the process's first output.
   */
  async start(cwd: string, command: (workspace: Record<string, string>) => RunnerCommand, handshake: (child: ChildProcess) => Promise<void>): Promise<void> {
    try {
      await this.launch(cwd, command, handshake);
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  private async launch(cwd: string, describe: (workspace: Record<string, string>) => RunnerCommand, handshake: (child: ChildProcess) => Promise<void>): Promise<void> {
    // Checked before anything else: a workspace deleted out from under a
    // stale `process.cwd()` otherwise surfaces as `spawn`'s ENOENT, which
    // reads as a missing runner binary rather than a missing directory.
    assertWorkspaceExists(cwd, { isDirectory: this.deps.isDirectory });
    const workspace = await (this.deps.workspaceEnv ?? workspaceEnvOf)(cwd);
    const asked = describe(workspace);
    const { placement } = this.deps;
    if (placement && asked.cwd) throw new Error('A placed runner starts where its placement puts it, not in a directory of this host.');
    if (placement) this.placed = await placement.place({ command: asked.command, args: asked.args, env: asked.env?.(workspace) ?? {}, files: asked.files ?? [] });
    const placed = this.placed;
    const command: RunnerCommand = placed ? { command: placed.command, args: placed.args, env: () => placed.env } : asked;
    const resolvePath = this.deps.resolvePath ?? augmentedPath;
    // Same PATH treatment as model discovery: the
    // binary must resolve wherever the user installed it, even under the
    // minimal PATH a GUI-launched host inherits.
    const PATH = await resolvePath();
    // On POSIX this hands back the command untouched; on Windows it resolves
    // the real `.exe` (or routes a `.cmd` shim through cmd.exe), because
    // CreateProcess performs no PATHEXT lookup of its own.
    const launch = await planDirectLaunch(command.command, command.args, {
      platform: this.deps.platform,
      resolvePath,
    });
    if (!isExecutableResolved(command.command, launch, PATH, { platform: this.deps.platform, exists: this.deps.exists })) {
      throw new ExecutableNotFoundError(command.command, PATH);
    }
    // The awaits above leave room for a dispose: a Stop takes the adapter back
    // while its start runs on, and a dispose finds no child to kill yet.
    if (this.disposed) throw new Error('The runner was stopped before it launched.');
    // Placed, the workspace's variables stay here: they are this host's, and a lease says what crosses (ADR-0059 L5).
    this.spawnEnv = runnerEnv(PATH, placed ? {} : workspace, command.env?.(workspace), command.envDrop);

    const child = spawnInOwnGroup((detached) => this.deps.spawn(launch.file, launch.args, {
      env: this.spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: asked.cwd ?? cwd,
      windowsVerbatimArguments: launch.verbatim,
      detached,
    }), this.deps.platform);
    this.child = child;

    const stderrText = new StringDecoder('utf8');
    child.stderr?.on('data', (chunk: Buffer) => this.appendStderr(stderrText.write(chunk)));
    // A write racing the process's death (a turn, an interrupt, a permission
    // answer) fails with EPIPE asynchronously; unheard, it crashes the host.
    // The close path already reports the death, with its stderr tail.
    child.stdin?.on('error', () => {});
    // 'close', not 'exit': Node can report 'exit' while the pipes are still
    // draining, so a listener told then reads a process's last words as never
    // having arrived. 'close' is after both stdout and stderr have ended.
    child.on('close', (code, signal) => this.end({ code, signal }));
    // 'close' waits on every holder of the pipes, and a descendant can hold
    // them past the runner's own death — an inherited stderr, a process
    // setsid'd out of the group that Stop's group signal cannot reach.
    child.once('exit', (code, signal) => {
      // Liveness, unlike the turn's last words, does not wait for the pipes: a
      // descendant holding them keeps 'close' away for the whole grace, and a
      // runner that has exited can take no further turn meanwhile.
      this.exitReported = true;
      const grace = setTimeout(() => {
        for (const flush of [...this.stdoutEnds]) flush();
        this.end({ code, signal });
        releasePipes(child);
      }, CLOSE_GRACE_MS);
      grace.unref?.();
      void this.ended.then(() => clearTimeout(grace));
    });
    child.on('error', (err) => {
      this.appendStderr(`\n${err.message}`);
      this.end({ code: -1, signal: null });
    });

    await handshake(child);
  }

  /**
   * Hear the process's stdout as text, until the returned function is called.
   * A read can end inside a multibyte character; decoding each chunk alone
   * turns both halves into U+FFFD.
   *
   * `onEnd`, when given, fires once the stream has ended — after the decoder's
   * own remainder is handed over. Its job is the framing layer's leftover: a
   * pipe can close with a complete line still buffered but unterminated, and
   * nothing else will come to flush it.
   */
  readStdout(onText: (text: string) => void, onEnd?: () => void): () => void {
    const child = this.child;
    if (!child?.stdout) return () => {};
    const decoder = new StringDecoder('utf8');
    const onData = (chunk: Buffer) => onText(decoder.write(chunk));
    const stop = () => {
      this.stdoutEnds.delete(onStreamEnd);
      child.stdout?.removeListener('data', onData);
      child.stdout?.removeListener('end', onStreamEnd);
    };
    // Also called when the process ended without its pipe doing so; what a
    // descendant writes after that is not the runner's.
    const onStreamEnd = () => {
      stop();
      const tail = decoder.end();
      if (tail) onText(tail);
      onEnd?.();
    };
    child.stdout.on('data', onData);
    child.stdout.on('end', onStreamEnd);
    this.stdoutEnds.add(onStreamEnd);
    return stop;
  }

  /** The environment the process was spawned under, for any side process a handshake needs. */
  get env(): NodeJS.ProcessEnv { return this.spawnEnv; }

  /** How the process ended; null while it runs. */
  get exit(): RunnerExit | null { return this.exitStatus; }

  /**
   * Whether the process has ended, for any reason. Unlike {@link exit} this is
   * true from its own 'exit', not only once 'close' has drained the pipes: a
   * runner that has exited can take no further turn even while a descendant
   * holds its stdout or stderr.
   */
  get hasExited(): boolean { return this.exitStatus !== null || this.exitReported; }

  /** The exit code a listener is told: -1 for a signal or a spawn failure. */
  get exitCode(): number { return this.exitStatus?.code ?? -1; }

  /** How the process ended, as the end of a sentence. */
  describeExit(): string {
    return this.exitStatus?.signal
      ? `was killed (${this.exitStatus.signal})`
      : `exited with code ${this.exitStatus?.code ?? 'unknown'}`;
  }

  /** Fail-safe contract: a dead runner reports its own last words, never an empty bubble. */
  withStderrTail(headline: string): string {
    const tail = this.stderrTail.trim();
    return `${headline}${tail ? `\n\n${tail}` : ''}`;
  }

  /**
   * Tree-wide, because the direct child may be a CLI whose shells, MCP servers
   * and test runs would outlive it — or, on Windows, the cmd.exe shim rather
   * than the runner. The forced follow-up is scheduled and unref'd, so a
   * disposed runner is never the reason the host refuses to exit.
   */
  dispose(): void {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    killTree(child, { platform: this.deps.platform });
    if (child) this.placed?.stop();
    else this.placedEnded();
  }

  private end(exit: RunnerExit): void {
    this.placedEnded();
    this.exitStatus = exit;
    this.markEnded();
  }

  private placedEnded(): void {
    this.placed?.ended();
    this.placed = null;
  }

  private appendStderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
  }
}

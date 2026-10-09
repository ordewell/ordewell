import type { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { augmentedPath } from '../../utils/shellPath';
import { planDirectLaunch, isExecutableResolved, ExecutableNotFoundError } from '../../utils/launch';
import { assertWorkspaceExists } from '../../utils/workspace';
import { killTree, spawnInOwnGroup } from '../../utils/processTree';
import { workspaceEnvOf } from '../workspaceEnv';
import { runnerEnv } from './runnerEnv';
import type { AgentProcessDeps } from './AgentAdapter';

/** Stderr kept for the failure message; a dying CLI's last words are the only useful diagnostic. */
const STDERR_TAIL_CHARS = 4000;

export interface RunnerCommand {
  command: string;
  args: string[];
  /**
   * Variables set over the workspace's own (ADR-0016), so they win. Handed the
   * workspace's, for a runner whose value merges into one of them.
   */
  env?: (workspace: Record<string, string>) => Record<string, string>;
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
  private exitStatus: RunnerExit | null = null;
  private stderrTail = '';
  private spawnEnv: NodeJS.ProcessEnv = {};

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
  async start(cwd: string, command: () => RunnerCommand, handshake: (child: ChildProcess) => Promise<void>): Promise<void> {
    try {
      await this.launch(cwd, command, handshake);
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  private async launch(cwd: string, describe: () => RunnerCommand, handshake: (child: ChildProcess) => Promise<void>): Promise<void> {
    // Checked before anything else: a workspace deleted out from under a
    // stale `process.cwd()` otherwise surfaces as `spawn`'s ENOENT, which
    // reads as a missing runner binary rather than a missing directory.
    assertWorkspaceExists(cwd, { isDirectory: this.deps.isDirectory });
    const command = describe();
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
    const workspace = await (this.deps.workspaceEnv ?? workspaceEnvOf)(cwd);
    this.spawnEnv = runnerEnv(PATH, workspace, command.env?.(workspace));

    const child = spawnInOwnGroup((detached) => this.deps.spawn(launch.file, launch.args, {
      env: this.spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      windowsVerbatimArguments: launch.verbatim,
      detached,
    }), this.deps.platform);
    this.child = child;

    const stderrText = new StringDecoder('utf8');
    child.stderr?.on('data', (chunk: Buffer) => this.appendStderr(stderrText.write(chunk)));
    // A write racing the process's death (a turn, an interrupt, a permission
    // answer) fails with EPIPE asynchronously; unheard, it crashes the host.
    // The exit path already reports the death, with its stderr tail.
    child.stdin?.on('error', () => {});
    child.on('exit', (code, signal) => { this.exitStatus = { code, signal }; this.markEnded(); });
    child.on('error', (err) => {
      this.appendStderr(`\n${err.message}`);
      this.exitStatus = { code: -1, signal: null };
      this.markEnded();
    });

    await handshake(child);
  }

  /**
   * Hear the process's stdout as text, until the returned function is called.
   * A read can end inside a multibyte character; decoding each chunk alone
   * turns both halves into U+FFFD.
   */
  readStdout(onText: (text: string) => void): () => void {
    const child = this.child;
    if (!child?.stdout) return () => {};
    const decoder = new StringDecoder('utf8');
    const onData = (chunk: Buffer) => onText(decoder.write(chunk));
    child.stdout.on('data', onData);
    return () => { child.stdout?.removeListener('data', onData); };
  }

  /** The environment the process was spawned under, for any side process a handshake needs. */
  get env(): NodeJS.ProcessEnv { return this.spawnEnv; }

  /** How the process ended; null while it runs. */
  get exit(): RunnerExit | null { return this.exitStatus; }

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
    const child = this.child;
    this.child = null;
    killTree(child, { platform: this.deps.platform });
  }

  private appendStderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
  }
}

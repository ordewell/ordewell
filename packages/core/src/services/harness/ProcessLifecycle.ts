import type { ChildProcess } from 'child_process';
import { RunnerProcess, type RunnerCommand } from './runnerProcess';
import { prepareNativeShell } from './nativeShellLaunch';
import type { AgentProcessDeps, AgentStartOptions } from './AgentAdapter';
import type { NativeShellLauncher } from '../sandbox/nativeShellLauncher';

/**
 * What every structured adapter owes the one runner process it drives
 * (ADR-0018 L1), whatever it speaks to it: the {@link RunnerProcess}, whether
 * it is still alive, who hears it end, how a dead one is reported, and what the
 * process owns being freed with it.
 *
 * Stdio line framing sits on top of this for Claude Code and Codex; OpenCode,
 * an HTTP server process, uses it without any framing.
 */
export abstract class ProcessLifecycle {
  protected process: ChildProcess | null = null;
  /** What this process is to the user — a planner or a task's runner — for the words a failure is reported in. */
  protected role: 'planner' | 'task' = 'planner';
  protected readonly runner: RunnerProcess;
  /**
   * What the process owns, by name: the MCP config file holding its token, the
   * sealed shell launcher and its sandbox. One registry rather than a field
   * and a cleanup per adapter, so a resource an adapter claims cannot be the
   * one its cleanup forgot.
   */
  private readonly owned = new Map<string, () => void>();
  private disposed = false;

  constructor(protected deps: AgentProcessDeps) {
    this.runner = new RunnerProcess(deps);
    // A resource lives no longer than its process: a runner that died on its
    // own would otherwise leave its token on disk until someone disposed it.
    void this.runner.ended.then(() => this.freeOwned());
  }

  /** Fail-safe contract: a dead process reports its own last words, never an empty bubble. */
  protected abstract exitMessage(): string;

  get exited(): boolean { return this.runner.hasExited; }

  /** Resolves when the process ends, so a handshake can lose the race instead of waiting out its timeout. */
  protected get processEnded(): Promise<void> { return this.runner.ended; }

  /** Whether {@link dispose} has run, for a loop that must stop once the process is gone. */
  protected get isDisposed(): boolean { return this.disposed; }

  onProcessExit(listener: (code: number, lastWords?: string) => void): void {
    void this.runner.ended.then(() => listener(this.runner.exitCode, this.exitMessage()));
  }

  /**
   * Launch the process and run `handshake` on it. A start that throws takes
   * the process down and frees what the adapter owns with it: no caller keeps
   * an adapter whose start threw.
   */
  protected async startProcess(cwd: string, command: (workspace: Record<string, string>) => RunnerCommand | Promise<RunnerCommand>, handshake: (child: ChildProcess) => Promise<void>): Promise<void> {
    try {
      await this.runner.start(cwd, command, (child) => {
        this.process = child;
        return handshake(child);
      });
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  /**
   * Hand `release` to the process: it runs once, when the process ends or the
   * adapter is disposed, whichever comes first. A second claim on a name frees
   * the first, so a process launched again does not leak its predecessor's.
   * A claim made after the adapter was disposed is freed at once.
   */
  protected own(name: string, release: () => void): void {
    this.owned.get(name)?.();
    this.owned.delete(name);
    if (this.disposed) {
      release();
      return;
    }
    let done = false;
    this.owned.set(name, () => {
      if (done) return;
      done = true;
      release();
    });
  }

  /** Prepare this planner's own shell (ADR-0036 N2) and own it, or null when the start did not ask for one. */
  protected async ownNativeShell(opts: AgentStartOptions): Promise<NativeShellLauncher | null> {
    const prepared = await prepareNativeShell(opts, this.deps);
    if (!prepared) return null;
    this.own('native-shell', prepared.release);
    return prepared.launcher;
  }

  /**
   * Frees what the process owns, then ends its whole process tree. Idempotent:
   * every path that gives up on the process — a stop, a refused start, a
   * turn's abort — ends here.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.process = null;
    this.freeOwned();
    this.runner.dispose();
  }

  private freeOwned(): void {
    // Newest first, as a stack: a resource may rest on one claimed before it.
    const releases = [...this.owned.values()].reverse();
    this.owned.clear();
    for (const release of releases) release();
  }
}

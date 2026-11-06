import type { DaemonProbe, DaemonStopOutcome } from '@ordewell/core/daemon-client';
import type { ActionResult, DaemonStatus } from '../../shared/bridge';
import { decideAttach, type AttachDecision, type Holding } from './attachPlan';
import type { LiveRun } from './liveRuns';

/** A daemon this app started: a utility process in production, anything in a test. */
export interface OwnedProcess {
  readonly pid: number | undefined;
  onExit(cb: (code: number) => void): void;
  /** Ask it to stop and wait for it to go. */
  stop(): Promise<void>;
}

export interface DaemonManagerDeps {
  port: number;
  app: { version: string; contract: number };
  probe(port: number): Promise<DaemonProbe>;
  fork(port: number): OwnedProcess;
  /** Stop a daemon this app did not start, the way `ordewell stop --server` does. */
  stopExternal(port: number): Promise<DaemonStopOutcome>;
  /** Runs live on the connected daemon; undefined when that cannot be told. */
  liveRuns(): Promise<LiveRun[] | undefined>;
  logPath: string;
  /** Defaults to setTimeout; a test drives it by hand. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  readyTimeoutMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  reconnectMs?: number;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/**
 * Finds the daemon, attaches to it or starts the bundled one, and keeps the
 * windows told which (ADR-0063 H2, H3). The decision itself is
 * `decideAttach`; this class owns what follows from it: the process it
 * started, the probes while a daemon is away, and the restart a mismatch
 * offers.
 */
export class DaemonManager {
  private status: DaemonStatus;
  private holding: Holding = 'none';
  private child: OwnedProcess | undefined;
  private restartedUnasked = false;
  private restartedForMismatch = false;
  private shuttingDown = false;
  private cancelTimer: (() => void) | undefined;
  private attempt = 0;
  private readonly listeners = new Set<(status: DaemonStatus) => void>();
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly reconnectMs: number;

  constructor(private readonly deps: DaemonManagerDeps) {
    this.status = { state: 'connecting', port: deps.port };
    this.setTimer = deps.setTimer ?? defaultTimer;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 15_000;
    this.pollMs = deps.pollMs ?? 250;
    this.heartbeatMs = deps.heartbeatMs ?? 5_000;
    this.reconnectMs = deps.reconnectMs ?? 2_000;
  }

  get port(): number {
    return this.deps.port;
  }

  current(): DaemonStatus {
    return this.status;
  }

  /** Whether quitting this app stops the daemon, and every run in it (ADR-0063 H5). */
  get owned(): boolean {
    return this.holding === 'owned';
  }

  isConnected(): boolean {
    return this.status.state === 'connected';
  }

  /** Runs live on the connected daemon, or undefined when that cannot be told. */
  liveRuns(): Promise<LiveRun[] | undefined> {
    return this.deps.liveRuns();
  }

  onStatus(listener: (status: DaemonStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The first probe, and the same probe again behind *Retry now*. */
  async connect(): Promise<void> {
    this.clearTimer();
    if (this.status.state !== 'reconnecting') this.set({ state: 'connecting', port: this.port });
    await this.apply(decideAttach(await this.deps.probe(this.port), this.deps.app.contract, this.holding));
  }

  async retry(): Promise<ActionResult> {
    await this.connect();
    return { ok: true };
  }

  /** *Start a daemon*: only once the port is free again and the app did not own the one that left. */
  async start(): Promise<ActionResult> {
    if (this.status.state !== 'reconnecting' && this.status.state !== 'failed') {
      return { ok: false, message: 'There is nothing to start: a daemon is already answering, or the port is held.' };
    }
    this.clearTimer();
    const probe = await this.deps.probe(this.port);
    if (probe.kind !== 'unreachable') {
      await this.apply(decideAttach(probe, this.deps.app.contract, this.holding));
      return { ok: false, message: `Port ${this.port} is answering again; reconnected instead of starting another.` };
    }
    this.restartedUnasked = false;
    await this.startOwned();
    return this.isConnected() ? { ok: true } : { ok: false, message: this.describeFailure() };
  }

  /**
   * *Restart daemon* on a mismatch (H3): refused while a run is live there,
   * since stopping that daemon stops the run, and refused when that cannot be
   * told, for the same reason.
   */
  async restart(): Promise<ActionResult> {
    if (this.status.state !== 'mismatch') return { ok: false, message: 'Only a daemon of another version is restarted.' };
    const live = await this.deps.liveRuns();
    if (live === undefined) {
      return { ok: false, message: 'Could not tell whether a run is live on that daemon, so it was left running.' };
    }
    if (live.length > 0) {
      const names = live.map((run) => `“${run.goal}” in ${run.workspace}`).join(', ');
      return { ok: false, message: `A run is live on that daemon (${names}), so it can't restart now.` };
    }

    const outcome = await this.deps.stopExternal(this.port);
    if (outcome.kind === 'unverifiable') {
      return { ok: false, message: `The daemon on :${this.port} could not name its own process, so nothing was signalled. Stop it with \`ordewell stop --server\`.` };
    }
    if (outcome.kind === 'no-pid-file' || outcome.kind === 'unreadable-pid-file') {
      return { ok: false, message: `No PID file names the daemon on :${this.port}. Stop it with \`ordewell stop --server\`, then retry.` };
    }
    if (!(await this.waitUntilFree())) {
      return { ok: false, message: `The daemon on :${this.port} was asked to stop and is still answering.` };
    }
    this.holding = 'none';
    this.restartedUnasked = false;
    await this.startOwned();
    return this.isConnected() ? { ok: true } : { ok: false, message: this.describeFailure() };
  }

  /** A request or socket found nothing listening: probe now instead of at the next heartbeat. */
  noteUnreachable(): void {
    if (this.status.state !== 'connected' || this.holding !== 'attached') return;
    void this.connect();
  }

  /** On quit: an owned daemon stops with the app, an attached one is left running (H5). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearTimer();
    const child = this.child;
    this.child = undefined;
    if (child) await child.stop();
  }

  private async apply(decision: AttachDecision): Promise<void> {
    if (this.shuttingDown) return;
    switch (decision.action) {
      case 'attach':
        // A daemon that answers while this app's child is up is that child:
        // startOwned only reaches here once the PIDs agree.
        if (this.holding !== 'owned') this.holding = 'attached';
        this.attempt = 0;
        this.restartedForMismatch = false;
        this.set({
          state: 'connected',
          port: this.port,
          owned: this.holding === 'owned',
          daemon: { contract: decision.contract, ...(decision.version !== undefined ? { version: decision.version } : {}) },
        });
        if (this.holding === 'attached') this.scheduleHeartbeat();
        return;
      case 'own':
        await this.startOwned();
        return;
      case 'reconnect':
        this.attempt += 1;
        this.set({ state: 'reconnecting', port: this.port, attempt: this.attempt, canStart: true });
        this.cancelTimer = this.setTimer(() => { void this.connect(); }, this.reconnectMs);
        return;
      case 'mismatch':
        if (decision.restart) {
          await this.stopChild();
          // The bundled entry answers the same way each time it starts, so a
          // second mismatch is a broken build, not a stale daemon: show it
          // rather than restart in a loop.
          if (this.restartedForMismatch) {
            this.fail(`The bundled daemon speaks contract ${decision.contract ?? 'none'}; this app was built for ${this.deps.app.contract}.`);
            return;
          }
          this.restartedForMismatch = true;
          await this.startOwned();
          return;
        }
        this.set({
          state: 'mismatch',
          port: this.port,
          daemon: {
            ...(decision.version !== undefined ? { version: decision.version } : {}),
            ...(decision.contract !== undefined ? { contract: decision.contract } : {}),
          },
          app: this.deps.app,
        });
        return;
      case 'unauthorized':
        this.set({ state: 'unauthorized', port: this.port, tokenPresented: decision.tokenPresented });
        return;
      case 'port-taken':
        this.set({ state: 'port-taken', port: this.port });
        return;
    }
  }

  private async startOwned(): Promise<void> {
    if (this.shuttingDown) return;
    this.set({ state: 'connecting', port: this.port });
    let child: OwnedProcess;
    try {
      child = this.deps.fork(this.port);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    this.child = child;
    let exited = false;
    child.onExit(() => {
      exited = true;
      this.onChildExit(child);
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    while (!this.shuttingDown) {
      const probe = await this.deps.probe(this.port);
      if (probe.kind === 'daemon' && probe.identity.pid === child.pid) {
        this.holding = 'owned';
        await this.apply(decideAttach(probe, this.deps.app.contract, 'owned'));
        return;
      }
      if (exited || (probe.kind !== 'unreachable' && probe.kind !== 'daemon')) {
        // The child lost the port, most often to a daemon another client
        // started in the same moment: judge whatever holds it now, as a
        // stranger, and never try to take it again from here.
        if (this.child === child) this.child = undefined;
        if (probe.kind === 'unreachable') {
          this.fail('The bundled daemon exited before it answered.');
          return;
        }
        this.holding = 'none';
        await this.apply(decideAttach(probe, this.deps.app.contract, 'none'));
        return;
      }
      if (Date.now() >= deadline) {
        this.fail(`The bundled daemon did not answer within ${Math.round(this.readyTimeoutMs / 1000)}s.`);
        return;
      }
      await this.sleep(this.pollMs);
    }
  }

  private onChildExit(child: OwnedProcess): void {
    if (this.shuttingDown || this.child !== child) return;
    this.child = undefined;
    this.holding = 'none';
    // A daemon that crashes once is started again; one that keeps crashing is
    // shown with its log rather than restarted in a loop.
    if (!this.restartedUnasked && this.status.state === 'connected') {
      this.restartedUnasked = true;
      void this.startOwned();
      return;
    }
    if (this.status.state === 'connected') this.fail('The daemon this app started has exited.');
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.holding = 'none';
    if (child) await child.stop();
  }

  private async waitUntilFree(): Promise<boolean> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if ((await this.deps.probe(this.port)).kind === 'unreachable') return true;
      await this.sleep(this.pollMs);
    }
    return false;
  }

  private scheduleHeartbeat(): void {
    this.clearTimer();
    this.cancelTimer = this.setTimer(() => {
      void this.deps.probe(this.port).then((probe) => {
        if (this.status.state !== 'connected' || this.holding !== 'attached') return;
        return this.apply(decideAttach(probe, this.deps.app.contract, 'attached'));
      });
    }, this.heartbeatMs);
  }

  private fail(message: string): void {
    this.set({ state: 'failed', port: this.port, message, logPath: this.deps.logPath });
  }

  private describeFailure(): string {
    return this.status.state === 'failed' ? `${this.status.message} Check ${this.status.logPath}.` : `The daemon is ${this.status.state}.`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.setTimer(resolve, ms); });
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private set(status: DaemonStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

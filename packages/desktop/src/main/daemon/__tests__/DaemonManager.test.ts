import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_CONTRACT, type DaemonProbe, type DaemonStopOutcome } from '@ordewell/core/daemon-client';
import type { DaemonStatus } from '../../../shared/bridge';
import { DaemonManager, type DaemonManagerDeps, type OwnedProcess } from '../DaemonManager';
import { findLiveRuns, type DaemonGet, type LiveRun } from '../liveRuns';

const PORT = 3742;
const CONTRACT = 1;

interface FakeChild extends OwnedProcess {
  exit(code?: number): void;
  stopped: boolean;
}

/**
 * A port and whatever holds it. `fork` puts a child on it that answers as a
 * daemon of `childContract` once `answerAfter` probes have gone by, the way a
 * starting server is unreachable for a moment.
 */
function world(initial: DaemonProbe) {
  let holder: DaemonProbe = initial;
  let nextPid = 500;
  const children: FakeChild[] = [];
  const state = { childContract: CONTRACT as number | undefined, answerAfter: 0, forkThrows: undefined as string | undefined };

  const probe = vi.fn(async (): Promise<DaemonProbe> => holder);
  const fork = vi.fn((): OwnedProcess => {
    if (state.forkThrows) throw new Error(state.forkThrows);
    const pid = nextPid++;
    const listeners: Array<(code: number) => void> = [];
    let pending = state.answerAfter;
    const child: FakeChild = {
      pid,
      stopped: false,
      onExit: (cb) => { listeners.push(cb); },
      stop: vi.fn(async () => {
        child.stopped = true;
        if (holder.kind === 'daemon' && holder.identity.pid === pid) holder = { kind: 'unreachable' };
        for (const listener of listeners) listener(0);
      }),
      exit: (code = 1) => {
        if (holder.kind === 'daemon' && holder.identity.pid === pid) holder = { kind: 'unreachable' };
        for (const listener of listeners) listener(code);
      },
    };
    children.push(child);
    // The child takes the port only after a few probes have seen it empty.
    probe.mockImplementation(async () => {
      if (pending > 0) {
        pending -= 1;
        return holder;
      }
      if (holder.kind === 'unreachable' && !child.stopped) {
        holder = { kind: 'daemon', identity: { pid, version: '9.9.9', ...(state.childContract !== undefined ? { contract: state.childContract } : {}) } };
      }
      return holder;
    });
    return child;
  });

  return {
    probe,
    fork,
    children,
    state,
    set(next: DaemonProbe) { holder = next; },
    get holder() { return holder; },
  };
}

type World = ReturnType<typeof world>;

const managers: DaemonManager[] = [];

function manager(w: World, overrides: Partial<DaemonManagerDeps> = {}): { daemon: DaemonManager; statuses: DaemonStatus[] } {
  const daemon = new DaemonManager({
    port: PORT,
    app: { version: '0.12.3', contract: CONTRACT },
    probe: w.probe,
    fork: w.fork,
    stopExternal: vi.fn(async (): Promise<DaemonStopOutcome> => ({ kind: 'no-pid-file' })),
    liveRuns: vi.fn(async (): Promise<LiveRun[] | undefined> => []),
    logPath: '/tmp/server.log',
    pollMs: 1,
    readyTimeoutMs: 500,
    // Long enough that no background probe runs inside a test unless it waits for one.
    heartbeatMs: 60_000,
    reconnectMs: 60_000,
    ...overrides,
  });
  managers.push(daemon);
  const statuses: DaemonStatus[] = [];
  daemon.onStatus((status) => statuses.push(status));
  return { daemon, statuses };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((daemon) => daemon.shutdown()));
});

const foreign = (contract: number | undefined, version = '0.12.1'): DaemonProbe => ({
  kind: 'daemon',
  identity: { pid: 42, version, ...(contract !== undefined ? { contract } : {}) },
});

describe('DaemonManager: attach', () => {
  it('attaches to a daemon of the same contract and never forks', async () => {
    const w = world(foreign(CONTRACT));
    const { daemon } = manager(w);
    await daemon.connect();
    expect(daemon.current()).toEqual({ state: 'connected', port: PORT, owned: false, daemon: { contract: CONTRACT, version: '0.12.1' } });
    expect(daemon.owned).toBe(false);
    expect(w.fork).not.toHaveBeenCalled();
  });

  it('attaches whatever the patch version: only the contract decides', async () => {
    const w = world(foreign(CONTRACT, '0.99.0'));
    const { daemon } = manager(w);
    await daemon.connect();
    expect(daemon.isConnected()).toBe(true);
  });

  it('leaves an attached daemon running on shutdown', async () => {
    const w = world(foreign(CONTRACT));
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => ({ kind: 'stale' }));
    const { daemon } = manager(w, { stopExternal });
    await daemon.connect();
    await daemon.shutdown();
    expect(stopExternal).not.toHaveBeenCalled();
    expect(w.holder.kind).toBe('daemon');
  });

  it('shows reconnecting when the attached daemon goes, and never takes the port by itself', async () => {
    const w = world(foreign(CONTRACT));
    const { daemon } = manager(w);
    await daemon.connect();
    w.set({ kind: 'unreachable' });
    daemon.noteUnreachable();
    await vi.waitFor(() => expect(daemon.current().state).toBe('reconnecting'));
    expect(daemon.current()).toEqual({ state: 'reconnecting', port: PORT, attempt: 1, canStart: true });
    await daemon.retry();
    expect(daemon.current()).toMatchObject({ state: 'reconnecting', attempt: 2 });
    expect(w.fork).not.toHaveBeenCalled();
  });

  it('reconnects on its own once the daemon answers again', async () => {
    const w = world(foreign(CONTRACT));
    const { daemon } = manager(w, { reconnectMs: 5 });
    await daemon.connect();
    w.set({ kind: 'unreachable' });
    daemon.noteUnreachable();
    await vi.waitFor(() => expect(daemon.current().state).toBe('reconnecting'));
    w.set(foreign(CONTRACT));
    await vi.waitFor(() => expect(daemon.current().state).toBe('connected'));
    expect(daemon.owned).toBe(false);
  });

  it('starts and owns a daemon when asked while reconnecting', async () => {
    const w = world(foreign(CONTRACT));
    const { daemon } = manager(w);
    await daemon.connect();
    w.set({ kind: 'unreachable' });
    await daemon.retry();
    expect(daemon.current().state).toBe('reconnecting');
    expect(await daemon.start()).toEqual({ ok: true });
    expect(daemon.owned).toBe(true);
    expect(w.fork).toHaveBeenCalledTimes(1);
  });

  it('refuses to start a daemon while one answers', async () => {
    const w = world(foreign(CONTRACT));
    const { daemon } = manager(w);
    await daemon.connect();
    const result = await daemon.start();
    expect(result.ok).toBe(false);
    expect(w.fork).not.toHaveBeenCalled();
  });

  it('reconnects instead of starting when the daemon is back by the time Start is pressed', async () => {
    const w = world(foreign(CONTRACT));
    const { daemon } = manager(w);
    await daemon.connect();
    w.set({ kind: 'unreachable' });
    await daemon.retry();
    w.set(foreign(CONTRACT));
    const result = await daemon.start();
    expect(result.ok).toBe(false);
    expect(daemon.current().state).toBe('connected');
    expect(w.fork).not.toHaveBeenCalled();
  });
});

describe('DaemonManager: own', () => {
  it('forks the bundled daemon on a free port and owns it once its own PID answers', async () => {
    const w = world({ kind: 'unreachable' });
    w.state.answerAfter = 3;
    const { daemon, statuses } = manager(w);
    await daemon.connect();
    expect(w.fork).toHaveBeenCalledWith(PORT);
    expect(daemon.current()).toEqual({ state: 'connected', port: PORT, owned: true, daemon: { contract: CONTRACT, version: '9.9.9' } });
    expect(statuses[0]).toEqual({ state: 'connecting', port: PORT });
  });

  it('stops the daemon it owns on shutdown', async () => {
    const w = world({ kind: 'unreachable' });
    const { daemon } = manager(w);
    await daemon.connect();
    await daemon.shutdown();
    expect(w.children[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it('restarts an owned daemon that exits unasked, once', async () => {
    const w = world({ kind: 'unreachable' });
    const { daemon } = manager(w);
    await daemon.connect();
    w.children[0]?.exit(1);
    await vi.waitFor(() => expect(w.fork).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(daemon.isConnected()).toBe(true));
    expect(daemon.owned).toBe(true);

    w.children[1]?.exit(1);
    await vi.waitFor(() => expect(daemon.current().state).toBe('failed'));
    expect(w.fork).toHaveBeenCalledTimes(2);
    expect(daemon.current()).toMatchObject({ state: 'failed', logPath: '/tmp/server.log' });
  });

  it('fails with the reason when the bundled daemon cannot be forked', async () => {
    const w = world({ kind: 'unreachable' });
    w.state.forkThrows = 'The bundled daemon is missing at /x; build @ordewell/web first.';
    const { daemon } = manager(w);
    await daemon.connect();
    expect(daemon.current()).toEqual({
      state: 'failed',
      port: PORT,
      message: 'The bundled daemon is missing at /x; build @ordewell/web first.',
      logPath: '/tmp/server.log',
    });
  });

  it('fails when the child exits before it answers', async () => {
    const w = world({ kind: 'unreachable' });
    w.state.answerAfter = 1_000;
    const { daemon } = manager(w);
    const connecting = daemon.connect();
    await vi.waitFor(() => expect(w.children).toHaveLength(1));
    w.children[0]?.exit(1);
    await connecting;
    expect(daemon.current()).toMatchObject({ state: 'failed', message: 'The bundled daemon exited before it answered.' });
  });

  it('fails when the child does not answer in time', async () => {
    const w = world({ kind: 'unreachable' });
    w.state.answerAfter = 1_000_000;
    const { daemon } = manager(w, { readyTimeoutMs: 30 });
    await daemon.connect();
    expect(daemon.current()).toMatchObject({ state: 'failed', message: 'The bundled daemon did not answer within 0s.' });
  });

  it('stops the child it gave up on, so Retry cannot mistake it for someone else\'s daemon', async () => {
    const w = world({ kind: 'unreachable' });
    w.state.answerAfter = 1_000_000;
    const { daemon } = manager(w, { readyTimeoutMs: 30 });
    await daemon.connect();
    expect(w.children).toHaveLength(1);
    expect(w.children[0]?.stop).toHaveBeenCalledTimes(1);
    // A second start forks anew; the first is not left running beside it.
    w.state.answerAfter = 0;
    await daemon.retry();
    expect(w.children.filter((child) => !child.stopped)).toHaveLength(daemon.owned ? 1 : 0);
    expect(daemon.current()).toMatchObject({ state: 'connected', owned: true });
  });

  it('judges a daemon that won the port race as a stranger', async () => {
    const w = world({ kind: 'unreachable' });
    w.state.answerAfter = 1_000;
    const { daemon } = manager(w);
    const connecting = daemon.connect();
    await vi.waitFor(() => expect(w.children).toHaveLength(1));
    // Another client's daemon took the port; this app's child loses the bind and exits.
    w.set(foreign(CONTRACT));
    w.probe.mockImplementation(async () => w.holder);
    w.children[0]?.exit(1);
    await connecting;
    expect(daemon.current()).toMatchObject({ state: 'connected', owned: false });
  });

  it('restarts an owned daemon of another contract once, then shows the broken build', async () => {
    const w = world({ kind: 'unreachable' });
    w.state.childContract = 2;
    const { daemon } = manager(w);
    await daemon.connect();
    expect(w.fork).toHaveBeenCalledTimes(2);
    expect(w.children[0]?.stop).toHaveBeenCalled();
    expect(w.children[1]?.stop).toHaveBeenCalled();
    expect(daemon.current()).toMatchObject({ state: 'failed', message: 'The bundled daemon speaks contract 2; this app was built for 1.' });
  });
});

describe('DaemonManager: version mismatch', () => {
  it('shows a stranger of another contract without driving it', async () => {
    const w = world(foreign(2, '0.13.0'));
    const { daemon } = manager(w);
    await daemon.connect();
    expect(daemon.current()).toEqual({
      state: 'mismatch',
      port: PORT,
      daemon: { version: '0.13.0', contract: 2 },
      app: { version: '0.12.3', contract: CONTRACT },
    });
    expect(w.fork).not.toHaveBeenCalled();
  });

  it('treats a daemon too old to name a contract as a mismatch', async () => {
    const w = world(foreign(undefined, '0.11.0'));
    const { daemon } = manager(w);
    await daemon.connect();
    expect(daemon.current()).toMatchObject({ state: 'mismatch', daemon: { version: '0.11.0' } });
  });

  it('restarts the stranger with the bundled daemon and owns it, when nothing is live there', async () => {
    const w = world(foreign(2));
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => {
      w.set({ kind: 'unreachable' });
      return { kind: 'stopped', pid: 42, filePid: 42 };
    });
    const { daemon } = manager(w, { stopExternal });
    await daemon.connect();
    expect(await daemon.restart()).toEqual({ ok: true });
    expect(stopExternal).toHaveBeenCalledWith(PORT);
    expect(daemon.current()).toMatchObject({ state: 'connected', owned: true });
  });

  it('refuses the restart while a run is live there, and names it', async () => {
    const w = world(foreign(2));
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => ({ kind: 'stale' }));
    const liveRuns = vi.fn(async (): Promise<LiveRun[]> => [{ sessionId: 's1', goal: 'Ship it', workspace: '/w' }]);
    const { daemon } = manager(w, { stopExternal, liveRuns });
    await daemon.connect();
    const result = await daemon.restart();
    expect(result).toEqual({ ok: false, message: 'A run is live on that daemon (“Ship it” in /w), so it can\'t restart now.' });
    expect(stopExternal).not.toHaveBeenCalled();
    expect(daemon.current().state).toBe('mismatch');
  });

  /** The daemon's answers as it gives them mid-run: the plan saved approved, the run said by the list's `run`. */
  const daemonWith = (rows: unknown[], sessions: Record<string, unknown>): DaemonGet => async (routeId, params) => {
    if (routeId === 'workspaces.list') return { ok: true, data: { workspaces: ['/w'] } };
    if (routeId === 'sessions.list') return { ok: true, data: rows };
    const id = params && typeof params === 'object' ? Reflect.get(params, 'id') : undefined;
    return routeId === 'sessions.get' && typeof id === 'string' && id in sessions ? { ok: true, data: sessions[id] } : { ok: false };
  };

  it('refuses the restart under a run whose plan is saved approved, as a run\'s plan is', async () => {
    const w = world(foreign(2));
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => ({ kind: 'stale' }));
    const get = daemonWith(
      [{ id: 's1', status: 'approved', goal: 'Ship it', run: { live: true, done: 1, total: 3 } }],
      { s1: { meta: { status: 'approved' }, run: { tasks: [], activity: { starting: false, running: true, scheduled: false, advancesOnItsOwn: true } } } },
    );
    const { daemon } = manager(w, { stopExternal, liveRuns: () => findLiveRuns(get) });
    await daemon.connect();
    expect(await daemon.restart()).toEqual({ ok: false, message: 'A run is live on that daemon (“Ship it” in /w), so it can\'t restart now.' });
    expect(stopExternal).not.toHaveBeenCalled();
    expect(daemon.current().state).toBe('mismatch');
  });

  it('restarts under a run another host holds: it goes on there, not in this daemon', async () => {
    const w = world(foreign(2));
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => {
      w.set({ kind: 'unreachable' });
      return { kind: 'stopped', pid: 42, filePid: 42 };
    });
    const get = daemonWith([{ id: 's1', status: 'approved', goal: 'Joined', run: { live: true } }], { s1: { meta: { status: 'approved' } } });
    const { daemon } = manager(w, { stopExternal, liveRuns: () => findLiveRuns(get) });
    await daemon.connect();
    expect(await daemon.restart()).toEqual({ ok: true });
    expect(stopExternal).toHaveBeenCalledWith(PORT);
  });

  it('refuses the restart when the daemon says work is live, though its list names no run', async () => {
    // An older daemon lists no `run`, and its running plan reads approved; its own word on /api/server still holds.
    const w = world({ kind: 'daemon', identity: { pid: 42, version: '0.12.1', contract: 2, live: true } });
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => ({ kind: 'stale' }));
    const get = daemonWith([{ id: 's1', status: 'approved', goal: 'Ship it' }], {});
    const { daemon } = manager(w, { stopExternal, liveRuns: () => findLiveRuns(get) });
    await daemon.connect();
    const result = await daemon.restart();
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toMatch(/under way on that daemon/);
    expect(stopExternal).not.toHaveBeenCalled();
  });

  it('refuses the restart when it cannot tell whether a run is live', async () => {
    const w = world(foreign(2));
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => ({ kind: 'stale' }));
    const { daemon } = manager(w, { stopExternal, liveRuns: async () => undefined });
    await daemon.connect();
    expect((await daemon.restart()).ok).toBe(false);
    expect(stopExternal).not.toHaveBeenCalled();
  });

  it('signals nothing it cannot verify, and says how to stop it by hand', async () => {
    const w = world(foreign(2));
    const { daemon } = manager(w, { stopExternal: async () => ({ kind: 'unverifiable', filePid: 7 }) });
    await daemon.connect();
    const result = await daemon.restart();
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('ordewell stop --server');
    expect(w.fork).not.toHaveBeenCalled();
  });

  it('refuses a restart outside a mismatch', async () => {
    const w = world(foreign(CONTRACT));
    const { daemon } = manager(w);
    await daemon.connect();
    expect((await daemon.restart()).ok).toBe(false);
  });
});

/**
 * This build's contract against a daemon of 0.13.1 from before the Explorer
 * read the workspace folder itself: it answers contract 2 and the same version
 * as this app, and refuses repo "." in a folder that is not a repository.
 */
describe('DaemonManager: a daemon from before workspace-folder reads', () => {
  const THIS_APP = { version: '0.13.1', contract: DAEMON_CONTRACT };
  const before = (live?: boolean): DaemonProbe => ({
    kind: 'daemon',
    identity: { pid: 42, version: '0.13.1', contract: 2, ...(live !== undefined ? { live } : {}) },
  });

  it('shows the mismatch, naming both contracts, and drives nothing there', async () => {
    const w = world(before(false));
    const { daemon } = manager(w, { app: THIS_APP });
    await daemon.connect();
    expect(daemon.current()).toEqual({
      state: 'mismatch',
      port: PORT,
      daemon: { version: '0.13.1', contract: 2 },
      app: THIS_APP,
    });
    expect(daemon.isConnected()).toBe(false);
    expect(w.fork).not.toHaveBeenCalled();
  });

  it('leaves it running, and its run with it, while a run is live there', async () => {
    const w = world(before(true));
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => ({ kind: 'stale' }));
    const liveRuns = vi.fn(async (): Promise<LiveRun[]> => [{ sessionId: 's1', goal: 'Ship it', workspace: '/ags-repos' }]);
    const { daemon } = manager(w, { app: THIS_APP, stopExternal, liveRuns });
    await daemon.connect();

    expect(await daemon.restart()).toEqual({ ok: false, message: 'A run is live on that daemon (“Ship it” in /ags-repos), so it can\'t restart now.' });
    expect(stopExternal).not.toHaveBeenCalled();
    expect(w.fork).not.toHaveBeenCalled();
    expect(daemon.current().state).toBe('mismatch');
  });

  it('leaves it running when it says work is under way, though it lists no run', async () => {
    const w = world(before(true));
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => ({ kind: 'stale' }));
    const { daemon } = manager(w, { app: THIS_APP, stopExternal });
    await daemon.connect();

    const result = await daemon.restart();
    expect(result.ok ? '' : result.message).toMatch(/under way on that daemon/);
    expect(stopExternal).not.toHaveBeenCalled();
  });

  it('replaces it with the bundled daemon once it is idle, and owns that one', async () => {
    const w = world(before(false));
    w.state.childContract = DAEMON_CONTRACT;
    const stopExternal = vi.fn(async (): Promise<DaemonStopOutcome> => {
      w.set({ kind: 'unreachable' });
      return { kind: 'stopped', pid: 42, filePid: 42 };
    });
    const { daemon } = manager(w, { app: THIS_APP, stopExternal });
    await daemon.connect();

    expect(await daemon.restart()).toEqual({ ok: true });
    expect(stopExternal).toHaveBeenCalledWith(PORT);
    expect(daemon.current()).toMatchObject({ state: 'connected', owned: true, daemon: { contract: DAEMON_CONTRACT } });
  });

  it('names a stale bundled daemon, built from an older core, instead of driving it', async () => {
    const w = world({ kind: 'unreachable' });
    w.state.childContract = 2;
    const { daemon } = manager(w, { app: THIS_APP });
    await daemon.connect();
    expect(daemon.current()).toMatchObject({ state: 'failed', message: `The bundled daemon speaks contract 2; this app was built for ${DAEMON_CONTRACT}.` });
  });
});

describe('DaemonManager: refusals', () => {
  it('shows unauthorized when the token file is missing, and does not attach', async () => {
    const w = world({ kind: 'unauthorized', tokenPresented: false });
    const { daemon } = manager(w);
    await daemon.connect();
    expect(daemon.current()).toEqual({ state: 'unauthorized', port: PORT, tokenPresented: false });
    expect(w.fork).not.toHaveBeenCalled();
  });

  it('shows unauthorized when the token presented is refused', async () => {
    const w = world({ kind: 'unauthorized', tokenPresented: true });
    const { daemon } = manager(w);
    await daemon.connect();
    expect(daemon.current()).toEqual({ state: 'unauthorized', port: PORT, tokenPresented: true });
  });

  it('shows port-taken when something else holds the port', async () => {
    const w = world({ kind: 'unverifiable' });
    const { daemon } = manager(w);
    await daemon.connect();
    expect(daemon.current()).toEqual({ state: 'port-taken', port: PORT });
    expect(w.fork).not.toHaveBeenCalled();
  });
});

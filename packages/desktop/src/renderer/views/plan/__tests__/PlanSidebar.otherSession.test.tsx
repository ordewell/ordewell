import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonHost } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { runTask } from '../../changes/__tests__/fixtures';
import { Sessions } from '../PlanSidebar';
import { IDLE_LIST_MS, LIVE_LIST_MS } from '../useSessionList';

let hosts: DaemonHost[] = [];
afterEach(() => { for (const host of hosts) host.dispose(); hosts = []; vi.useRealTimers(); });

const TASKS = [surfaceTask({ id: 't1', order: 1, title: 'Parse the config' })];
const ACTIVE = { starting: false, running: true, scheduled: true, resumable: false, advancesOnItsOwn: true };

/** The status shape in a session's row: the spinner is data-status="running". */
function rowStatus(goal: RegExp): string | null {
  const row = screen.getByRole('button', { name: goal });
  return row.querySelector('[data-status]')?.getAttribute('data-status') ?? null;
}

describe('Sessions: a run in a session that is not the open one', () => {
  it('keeps the running session running after another is selected, and settles it when its run ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // What the daemon really knows: s1's run is live in the pool. Its saved file says approved throughout.
    let aLive: { done: number; total: number } | null = null;
    const daemon = fakeDaemon({
      'sessions.load': (params) => ok({ ok: true, plan: surfacePlan(TASKS, params?.id === 's1' ? 'approved' : 'draft'), goal: params?.id === 's1' ? 'Ship the parser' : 'Fix flaky CI' }),
      'sessions.list': () => ok([
        { id: 's1', goal: 'Ship the parser', status: 'approved', taskCount: 1, updatedAt: '2026-11-03T09:00:00.000Z', ...(aLive ? { run: { live: true, ...aLive } } : {}) },
        { id: 's2', goal: 'Fix flaky CI', status: 'draft', taskCount: 1, updatedAt: '2026-11-03T08:00:00.000Z' },
      ]),
      'sessions.get': () => ok({ meta: { id: 's2', goal: 'Fix flaky CI' }, plan: surfacePlan(TASKS, 'draft') }),
    });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.open('s1'));
    render(<Sessions host={host} />);
    await screen.findByRole('button', { name: /Ship the parser/ });

    // s1 runs, while it is the open session.
    aLive = { done: 0, total: 1 };
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, {
        type: 'run_snapshot', sessionId: 's1', stream: 'd1', seq: 0,
        view: { tasks: [runTask({ id: 't1', order: 1, title: 'Parse the config', status: 'in_progress' })], runMerge: null, handoff: null, mergeResult: null, activity: ACTIVE },
      });
    });
    expect(await screen.findByRole('button', { name: /Ship the parser.*Running 0\/1/ })).toBeInTheDocument();
    expect(rowStatus(/Ship the parser/)).toBe('running');

    // Select s2: s1's run carries on in the daemon (nothing closed it).
    await act(() => host.open('s2'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByRole('button', { name: /Fix flaky CI/ })).toHaveAttribute('aria-current', 'true');
    expect(within(screen.getByRole('button', { name: /Ship the parser/ })).getByText(/Running/)).toBeInTheDocument();
    expect(rowStatus(/Ship the parser/)).toBe('running');
    expect(daemon.calls('sessions.close')).toHaveLength(0);

    // Back to s1: its socket speaks for its row again, and its run was never stopped.
    await act(() => host.open('s1'));
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, {
        type: 'run_snapshot', sessionId: 's1', stream: 'd2', seq: 0,
        view: { tasks: [runTask({ id: 't1', order: 1, title: 'Parse the config', status: 'in_progress' })], runMerge: null, handoff: null, mergeResult: null, activity: ACTIVE },
      });
    });
    expect(await screen.findByRole('button', { name: /Ship the parser.*Running 0\/1/ })).toHaveAttribute('aria-current', 'true');
    expect(daemon.calls('sessions.close')).toHaveLength(0);
    await act(() => host.open('s2'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(rowStatus(/Ship the parser/)).toBe('running');

    // s1's run settles while s2 stays open: a cached "running" must not outlive it.
    aLive = null;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(rowStatus(/Ship the parser/)).not.toBe('running');
    expect(screen.getByRole('button', { name: /Ship the parser/ })).not.toHaveTextContent(/Running/);
  });

  it("finds a run another host starts in a row that was idle, and reads no faster than the list's cadence", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let leased = false;
    const daemon = fakeDaemon({
      'sessions.load': () => ok({ ok: true, plan: surfacePlan(TASKS, 'draft'), goal: 'Fix flaky CI' }),
      // A daemon that predates `run` lists s1 the same way, Approved and nothing more.
      'sessions.list': () => ok([
        { id: 's1', goal: 'Ship the parser', status: 'approved', taskCount: 1, updatedAt: '2026-11-03T09:00:00.000Z', ...(leased ? { run: { live: true } } : {}) },
        { id: 's2', goal: 'Fix flaky CI', status: 'draft', taskCount: 1, updatedAt: '2026-11-03T08:00:00.000Z' },
      ]),
    });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.open('s2'));
    render(<Sessions host={host} />);
    expect(await screen.findByRole('button', { name: /Ship the parser.*Approved/ })).toBeInTheDocument();
    expect(rowStatus(/Ship the parser/)).not.toBe('running');
    const before = daemon.calls('sessions.list').length;

    // A VS Code window starts s1: its lease says so, and nothing reaches this window but the list.
    leased = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_LIST_MS); });
    expect(rowStatus(/Ship the parser/)).toBe('running');
    // Its holder gives no counts: the row says Running, and no "n/m" it cannot know.
    expect(within(screen.getByRole('button', { name: /Ship the parser/ })).getByText('Running')).toBeInTheDocument();
    expect(daemon.calls('sessions.list').length - before).toBe(1);

    // Live, the list is read every LIVE_LIST_MS, one read at a time: a minute is twelve, not a storm.
    const live = daemon.calls('sessions.list').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(daemon.calls('sessions.list').length - live).toBe(60_000 / LIVE_LIST_MS);

    leased = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_LIST_MS); });
    expect(rowStatus(/Ship the parser/)).not.toBe('running');
    // Idle again, the cadence slows back.
    const idle = daemon.calls('sessions.list').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(daemon.calls('sessions.list').length - idle).toBe(60_000 / IDLE_LIST_MS);
  });

  it('reads nothing while the window is hidden or the daemon away, and at once when either comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    try {
      const daemon = fakeDaemon({ 'sessions.list': () => ok([{ id: 's1', goal: 'Ship the parser', status: 'approved', taskCount: 1, run: { live: true } }]) });
      const host = new DaemonHost('/work/acme');
      hosts.push(host);
      render(<Sessions host={host} />);
      await screen.findByRole('button', { name: /Ship the parser/ });
      const reads = (): number => daemon.calls('sessions.list').length;

      visibility = 'hidden';
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      let at = reads();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(reads()).toBe(at);
      visibility = 'visible';
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(reads()).toBe(at + 1);

      act(() => daemon.setStatus({ state: 'reconnecting', port: 3700, attempt: 1, canStart: false }));
      at = reads();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(reads()).toBe(at);
      // The last list stays, inert (W15).
      expect(screen.getByRole('button', { name: /Ship the parser/ })).toBeDisabled();
      act(() => daemon.setStatus(daemon.connected));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(reads()).toBe(at + 1);
    } finally {
      // The own property hid jsdom's; deleting it brings that back.
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it('keeps one read at a time when the open session changes mid-read, and none after the list is gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending: Array<() => void> = [];
    const rows = [
      { id: 's1', goal: 'Ship the parser', status: 'approved', taskCount: 1, updatedAt: '2026-11-03T09:00:00.000Z' },
      { id: 's2', goal: 'Fix flaky CI', status: 'draft', taskCount: 1, updatedAt: '2026-11-03T08:00:00.000Z' },
    ];
    const daemon = fakeDaemon({
      'sessions.load': (params) => ok({ ok: true, plan: surfacePlan(TASKS, 'draft'), goal: params?.id === 's1' ? 'Ship the parser' : 'Fix flaky CI' }),
      'sessions.list': () => new Promise((resolve) => { pending.push(() => resolve(ok(rows))); }),
    });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    const view = render(<Sessions host={host} />);
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    // The open session changes while the first read is out: the next waits for it, so no older answer lands after a newer one.
    await act(() => host.open('s2'));
    expect(daemon.calls('sessions.list')).toHaveLength(1);
    await act(async () => { pending.shift()?.(); await vi.advanceTimersByTimeAsync(0); });
    expect(daemon.calls('sessions.list')).toHaveLength(2);
    await act(async () => { pending.shift()?.(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('button', { name: /Fix flaky CI/ })).toHaveAttribute('aria-current', 'true');

    // Gone with a read still out: its answer lands on nothing, and no timer reads again.
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_LIST_MS); });
    expect(pending).toHaveLength(1);
    view.unmount();
    pending.shift()?.();
    await vi.advanceTimersByTimeAsync(5 * IDLE_LIST_MS);
    expect(daemon.calls('sessions.list')).toHaveLength(3);
  });

  it('reads the open row from the list while a VS Code window holds it, at the live cadence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // VS Code holds s1 and runs it: this window can only draw the saved file, which says approved throughout.
    const sessionHeld = { holder: { hostId: 'h1', pid: 4242, host: { kind: 'vscode' }, since: '2026-11-03T09:00:00.000Z', heartbeatAt: '2026-11-03T09:00:00.000Z', runnerGroups: [] } };
    let holderLive = true;
    const daemon = fakeDaemon({
      'sessions.load': { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'held', code: 'session_held', sessionHeld } },
      'sessions.get': () => ok({ meta: { id: 's1', goal: 'Ship the parser' }, plan: surfacePlan(TASKS, 'approved') }),
      // Another host's run is its lease's word, with no counts (OrchestratorPool.runActivity).
      'sessions.list': () => ok([
        { id: 's1', goal: 'Ship the parser', status: 'approved', taskCount: 1, updatedAt: '2026-11-03T09:00:00.000Z', ...(holderLive ? { run: { live: true } } : {}) },
      ]),
    });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.open('s1'));
    expect(host.getSnapshot().readOnly).toBe(true);
    render(<Sessions host={host} />);

    const row = await screen.findByRole('button', { name: /Ship the parser/ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(rowStatus(/Ship the parser/)).toBe('running');

    // The holder's run ends: the open row settles within one live read, not the idle one.
    holderLive = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_LIST_MS); });
    expect(screen.getByRole('button', { name: /Ship the parser.*Approved/ })).toBeInTheDocument();
    expect(rowStatus(/Ship the parser/)).not.toBe('running');
    expect(daemon.calls('sessions.close')).toHaveLength(0);
  });

  it("drops a row's run, and keeps the row, when a later read fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    fakeDaemon({
      'sessions.list': () => (fail
        ? { ok: false, status: 500, error: 'The daemon could not list the sessions.' }
        : ok([{ id: 's1', goal: 'Ship the parser', status: 'approved', taskCount: 1, run: { live: true, done: 1, total: 3 } }])),
    });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    render(<Sessions host={host} />);
    expect(await screen.findByRole('button', { name: /Ship the parser.*Running 1\/3/ })).toBeInTheDocument();
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_LIST_MS); });
    expect(screen.getByRole('button', { name: /Ship the parser.*Approved/ })).toBeInTheDocument();
    expect(screen.queryByText('The daemon could not list the sessions.')).not.toBeInTheDocument();
  });
});

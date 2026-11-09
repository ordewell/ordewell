import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider } from '../../../frame/store';
import { DaemonHost, daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { registerViews } from '../../index';
import { resetTaskViews } from '../../task/taskView';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { runTask } from '../../changes/__tests__/fixtures';
import { FrameStore } from '../../../frame/store';
import { register, relativeTime, Sessions, sessionStatus } from '../PlanSidebar';

// Monaco needs a browser; these views never open a file.
vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

let hosts: DaemonHost[] = [];
afterEach(() => { for (const host of hosts) host.dispose(); hosts = []; });

const TASKS = [surfaceTask({ id: 't1', order: 1, title: 'Parse the config' })];

describe('Sessions', () => {
  it('shows the open session\'s row as its plan moves on, not as it was first listed', async () => {
    let status = 'draft';
    const daemon = fakeDaemon({
      'sessions.load': () => ok({ ok: true, plan: surfacePlan(TASKS, status === 'draft' ? 'draft' : 'running'), goal: 'Ship the parser' }),
      'sessions.list': () => ok([{ id: 's1', goal: 'Ship the parser', status, taskCount: 1, updatedAt: '2026-11-03T09:00:00.000Z' }]),
    });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.open('s1'));
    render(<Sessions host={host} />);
    expect(await screen.findByRole('button', { name: /Ship the parser.*Draft/ })).toBeInTheDocument();

    // Approving starts the run: the daemon's row says so, and nothing about the session or its goal changed.
    status = 'running';
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }], stream: 'd1', seq: 1 });
    });
    expect(await screen.findByRole('button', { name: /Ship the parser.*Running/ })).toBeInTheDocument();
  });

  it('reads the open session\'s live run, Running n/m, where its saved plan still says Approved', async () => {
    const daemon = fakeDaemon({
      'sessions.load': () => ok({ ok: true, plan: surfacePlan(TASKS, 'approved'), goal: 'Ship the parser' }),
      // The saved plan's status, which stays approved for as long as its run lasts.
      'sessions.list': () => ok([{ id: 's1', goal: 'Ship the parser', status: 'approved', taskCount: 1, updatedAt: '2026-11-03T09:00:00.000Z' }]),
    });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.open('s1'));
    render(<Sessions host={host} />);
    expect(await screen.findByRole('button', { name: /Ship the parser.*Approved/ })).toBeInTheDocument();

    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, {
        type: 'run_snapshot', sessionId: 's1', stream: 'd1', seq: 0,
        view: {
          tasks: [runTask({ id: 't1', order: 1, title: 'Parse the config', status: 'in_progress' })], runMerge: null, handoff: null, mergeResult: null,
          activity: { starting: false, running: true, scheduled: true, resumable: false, advancesOnItsOwn: true },
        },
      });
    });
    expect(await screen.findByRole('button', { name: /Ship the parser.*Running 0\/1/ })).toBeInTheDocument();
  });

  it('says when nothing has been planned yet', async () => {
    fakeDaemon({ 'sessions.list': () => ok([]) });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    render(<Sessions host={host} />);
    expect(await screen.findByText('No sessions yet. Describe a goal to the planner.')).toBeInTheDocument();
  });

  it('keeps the last list, inert, while the daemon is away, and claims no wait of its own (W15)', async () => {
    const daemon = fakeDaemon({ 'sessions.list': () => ok([{ id: 's1', goal: 'Ship the parser', status: 'draft', taskCount: 1 }]) });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    render(<Sessions host={host} />);
    expect(await screen.findByRole('button', { name: /Ship the parser/ })).toBeEnabled();

    act(() => daemon.setStatus({ state: 'reconnecting', port: 3700, attempt: 1, canStart: false }));
    expect(screen.getByRole('button', { name: /Ship the parser/ })).toBeDisabled();
    expect(screen.queryByText(/Waiting|Loading/)).not.toBeInTheDocument();
  });
});

describe('the Sessions sidebar in the frame', () => {
  let offs: Array<() => void> = [];
  afterEach(() => { for (const off of offs) off(); offs = []; resetDaemonHosts(); resetTaskViews(); });

  it('folds Sessions by its header while Needs you stays open and New session stays offered, and keeps the choice across an activity switch', async () => {
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, plan: surfacePlan(TASKS, 'running'), goal: 'Ship the parser' }),
      'sessions.list': () => ok([{ id: 's1', goal: 'Ship the parser', status: 'running', taskCount: 1 }]),
    });
    const store = new FrameStore({ workspace: '/work/acme', platform: 'linux' });
    offs.push(registerFrameCommands(store), registerViews(store.api));
    const host = daemonHost('/work/acme');
    render(<FrameProvider value={store}><Frame daemon={{ state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } }} /></FrameProvider>);
    await act(() => host.open('s1'));
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, {
        type: 'run_snapshot', sessionId: 's1', stream: 'd1', seq: 0,
        view: {
          tasks: [runTask({ id: 't1', order: 1, title: 'Parse the config', status: 'in_progress' })], runMerge: null, handoff: null, mergeResult: null,
          escalations: [{ id: 'failed:t1:1', kind: 'failed', task: { id: 't1', ref: '#1', title: 'Parse the config' }, attempt: 1, reason: 'Tests failed (exit 1).', options: [{ id: 'retry', label: 'Retry' }] }],
        },
      });
    });
    const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('navigation', { name: 'Sessions' }));
    const sessions = (): HTMLElement => sidebar().getByRole('button', { name: 'Sessions' });
    const needsYou = (): HTMLElement => sidebar().getByRole('button', { name: /^Needs you/ });
    expect(await sidebar().findByRole('button', { name: /Ship the parser/ })).toBeInTheDocument();
    expect(sessions()).toHaveAttribute('aria-expanded', 'true');
    expect(needsYou()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(sessions());
    expect(sessions()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('button', { name: /Ship the parser/ })).not.toBeInTheDocument();
    expect(needsYou()).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar().getByText('Tests failed (exit 1).')).toBeInTheDocument();
    const newSession = vi.spyOn(host, 'newSession').mockImplementation(() => {});
    fireEvent.click(sidebar().getByRole('button', { name: 'New session' }));
    expect(newSession).toHaveBeenCalledOnce();

    const views = within(screen.getByRole('tablist', { name: 'Views' }));
    fireEvent.click(views.getByRole('tab', { name: 'Explorer' }));
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).not.toBeInTheDocument();
    fireEvent.click(views.getByRole('tab', { name: /^Sessions/ }));
    expect(sessions()).toHaveAttribute('aria-expanded', 'false');
    expect(needsYou()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(sessions());
    expect(await sidebar().findByRole('button', { name: /Ship the parser/ })).toBeInTheDocument();
  });
});

describe('the New session command', () => {
  it('is offered, and not while the daemon is away (W15)', () => {
    fakeDaemon({ 'sessions.list': () => ok([]) });
    const store = new FrameStore({ workspace: '/work/acme', platform: 'linux' });
    const off = register(store.api);
    try {
      expect(store.enabledCommands().map((command) => command.id)).toContain('session.new');
      act(() => store.api.setReadOnly(true));
      expect(store.enabledCommands().map((command) => command.id)).not.toContain('session.new');
    } finally { off(); }
  });
});

describe('sessionStatus', () => {
  it('names a settled session by the status the rest of the app draws', () => {
    expect(sessionStatus('completed')).toEqual({ status: 'passed', word: 'Settled' });
    expect(sessionStatus('running')).toEqual({ status: 'running', word: 'Running' });
    expect(sessionStatus('paused')).toEqual({ status: 'not-started', word: 'Paused' });
  });
});

describe('relativeTime', () => {
  it('says how long ago, in the largest unit that fits', () => {
    const now = Date.parse('2026-11-04T12:00:00.000Z');
    expect(relativeTime('2026-11-04T11:58:00.000Z', now)).toBe('2 minutes ago');
    expect(relativeTime('2026-11-02T12:00:00.000Z', now)).toBe('2 days ago');
  });

  it('marks the row of a session it joined in another daemon with the joined glyph (W16)', async () => {
    const SINCE = '2026-11-04T10:00:00.000Z';
    const sessionHeld = { holder: { hostId: 'h1', pid: 48200, host: { kind: 'daemon', port: 49213, ownerPid: 48120 }, since: SINCE, heartbeatAt: SINCE, runnerGroups: [] } };
    const daemon = fakeDaemon({
      'sessions.load': { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'held', code: 'session_held', sessionHeld } },
      'sessions.get': ok({ meta: { id: 's1', goal: 'Add SSO login' }, plan: { status: 'running', phase: 'executing', pendingTasks: TASKS } }),
      'sessions.list': ok([
        { id: 's1', goal: 'Add SSO login', status: 'running', taskCount: 1 },
        { id: 's2', goal: 'Ship the parser', status: 'draft', taskCount: 1 },
      ]),
    });
    daemon.joinWith({ ok: true, holder: { port: 49213, pid: 48200, ownerPid: 48120, version: '0.12.3', contract: 1, since: SINCE } });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.open('s1'));
    render(<Sessions host={host} />);

    expect(await screen.findByRole('button', { name: /Add SSO login Joined · TUI pid 48120/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ship the parser/ })).not.toHaveTextContent('⇄');
  });
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../../../../shared/bridge';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { registerViews } from '../../index';
import { resetTaskViews } from '../../task/taskView';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';

vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

const WORKSPACE = '/work/acme';
const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };
const AWAY: DaemonStatus = { state: 'reconnecting', port: 3700, attempt: 2, canStart: false };

const PLAN = surfacePlan([
  surfaceTask({ id: 't1', order: 1, title: 'Read the auth module' }),
  surfaceTask({ id: 't2', order: 2, title: 'Add the login button', status: 'failed' }),
]);

const SAVED = {
  meta: { id: 's1', goal: 'Ship the parser' },
  plan: {
    phase: 'executing',
    status: 'running',
    generatedAt: '2026-11-03T09:00:00.000Z',
    lastUpdated: '2026-11-03T09:00:00.000Z',
    runners: ['claude-code'],
    pendingTasks: PLAN.tasks,
    executionLog: [],
  },
} as unknown;

const HELD = {
  holder: {
    hostId: 'other-host',
    pid: 4242,
    host: { kind: 'vscode' },
    since: '2026-11-03T09:00:00.000Z',
    heartbeatAt: '2026-11-03T09:00:00.000Z',
    runnerGroups: [],
  },
};

let offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  resetDaemonHosts();
  resetTaskViews();
});

interface World {
  daemon: ReturnType<typeof fakeDaemon>;
  setStatus(status: DaemonStatus): void;
  confirm: ReturnType<typeof vi.fn>;
}

/** A bridge whose status the test pushes, with the desktop's other narrow calls stubbed. */
function world(initial: DaemonStatus, answers: Parameters<typeof fakeDaemon>[0] = {}): World {
  const daemon = fakeDaemon({
    'sessions.load': ok({ ok: true, plan: PLAN, goal: 'Ship the parser' }),
    'sessions.get': ok(SAVED),
    ...answers,
  });
  let status = initial;
  const listeners = new Set<(status: DaemonStatus) => void>();
  Object.assign(window.ordewell.daemon, {
    status: async () => status,
    onStatus: (cb: (status: DaemonStatus) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
  });
  const confirm = vi.fn(async () => true);
  const retry = vi.fn(async () => ({ ok: false, message: 'Still no daemon.' }));
  Object.assign(window.ordewell.daemon, {
    status: async () => status,
    onStatus: (cb: (status: DaemonStatus) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    retry,
  });
  Object.assign(window.ordewell, {
    dialog: { confirm },
    prefs: {
      get: async () => ({ theme: 'system', layouts: {}, notifications: true, keepRunningInTray: false, editorCommand: '' }),
      set: async () => ({ theme: 'system', layouts: {}, notifications: true, keepRunningInTray: false, editorCommand: '' }),
    },
    notify: { show: vi.fn(async () => ({ ok: true })), setBadge: vi.fn(async () => undefined), onClick: () => () => undefined },
  });
  return {
    daemon,
    confirm,
    setStatus: (next) => { status = next; for (const cb of [...listeners]) cb(next); },
  };
}

function mount(daemon: DaemonStatus): { store: FrameStore; host: ReturnType<typeof daemonHost> } {
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  const host = daemonHost(WORKSPACE);
  render(<FrameProvider value={store}><Frame daemon={daemon} /></FrameProvider>);
  return { store, host };
}

const body = (): HTMLElement => document.querySelector('.frame-body') as HTMLElement;

describe('the connection banners', () => {
  it('says how long the daemon has been away, makes the plan read-only, and resyncs when it returns', async () => {
    const w = world(AWAY);
    mount(AWAY);

    const banner = await screen.findByRole('region', { name: 'Reconnecting to the daemon…' });
    expect(banner).toHaveClass('frame-banner-warning');
    expect(banner).toHaveTextContent('Last seen');
    expect(body()).toHaveAttribute('inert');

    fireEvent.click(within(banner).getByRole('button', { name: 'Retry now' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Still no daemon.'));

    act(() => w.setStatus(CONNECTED));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reconnecting to the daemon…' })).not.toBeInTheDocument());
    expect(body()).not.toHaveAttribute('inert');
    expect(screen.getByRole('status')).toHaveTextContent('Reconnected to the daemon.');
  });

  it('names a version mismatch and what it costs', async () => {
    world({ state: 'mismatch', port: 3700, daemon: { version: '0.12.3', contract: 4 }, app: { version: '0.13.0', contract: 5 } });
    mount({ state: 'mismatch', port: 3700, daemon: { version: '0.12.3', contract: 4 }, app: { version: '0.13.0', contract: 5 } });
    const banner = await screen.findByRole('region', { name: 'The running daemon is another version' });
    expect(banner).toHaveTextContent('contract 4');
    expect(banner).toHaveTextContent('contract 5');
  });
});

describe('a session a VS Code window holds (W16)', () => {
  const held = (): Parameters<typeof world>[1] => ({
    'sessions.load': { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'This session is open in VS Code.', code: 'session_held', sessionHeld: HELD } },
    'sessions.get': ok(SAVED),
  });
  const CARD = 'This session is open in a VS Code window';

  it('says the app cannot join it, and shows its saved state read-only with the holder named', async () => {
    world(CONNECTED, held());
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));

    const banner = await screen.findByRole('region', { name: CARD });
    expect(banner).toHaveTextContent(`(extension host pid 4242, since ${new Date(HELD.holder.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).`);
    expect(banner).toHaveTextContent("VS Code runs it inside its own window, so the app can't join it.");
    expect(host.getSnapshot().readOnly).toBe(true);
    expect(screen.getByText('⊡ Read-only · held by VS Code (pid 4242)')).toBeInTheDocument();
    expect(document.querySelector('.frame-status')).toHaveTextContent('held by VS Code (pid 4242) · read-only');
  });

  it('starts a new session here with the held goal in the composer, not sent', async () => {
    const w = world(CONNECTED, held());
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));

    fireEvent.click(within(await screen.findByRole('region', { name: CARD })).getByRole('button', { name: 'Start a new session here' }));

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message the planner' })).toHaveValue('Ship the parser'));
    expect(host.getSnapshot()).toMatchObject({ held: null, readOnly: false });
    expect(screen.queryByRole('region', { name: CARD })).not.toBeInTheDocument();
    expect(w.daemon.calls('plans.converseMessage')).toEqual([]);
  });

  it('watches read-only on request, reading the saved state again', async () => {
    const w = world(CONNECTED, held());
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));
    const reads = w.daemon.calls('sessions.get').length;

    fireEvent.click(within(await screen.findByRole('region', { name: CARD })).getByRole('button', { name: 'Watch read-only' }));

    await waitFor(() => expect(w.daemon.calls('sessions.get').length).toBeGreaterThan(reads));
  });

  it('shows a refused take over and its reason, and the session stays held', async () => {
    const w = world(CONNECTED, held());
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));

    fireEvent.click(within(await screen.findByRole('region', { name: CARD })).getByRole('button', { name: 'Take over…' }));

    const refusal = await screen.findByRole('region', { name: 'Take over refused' });
    expect(w.confirm).toHaveBeenCalledOnce();
    expect(refusal).toHaveTextContent('VS Code (extension host pid 4242) is still running and holds this session. Close the session there, then take it over again.');
    expect(screen.getByRole('status')).toHaveTextContent('VS Code (extension host pid 4242) is still running');
    expect(screen.getByRole('region', { name: CARD })).toBeInTheDocument();
  });

  it('shows a take over that succeeded', async () => {
    let freed = false;
    const w = world(CONNECTED, {
      ...held(),
      'sessions.load': () => (freed
        ? ok({ ok: true, plan: PLAN, goal: 'Ship the parser' })
        : { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'held', code: 'session_held', sessionHeld: HELD } }),
    });
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));
    freed = true;

    fireEvent.click(within(await screen.findByRole('region', { name: CARD })).getByRole('button', { name: 'Take over…' }));

    expect(await screen.findByRole('region', { name: 'Taken over' })).toHaveTextContent('This window now runs the session.');
    expect(screen.queryByRole('region', { name: CARD })).not.toBeInTheDocument();
    expect(w.daemon.calls('sessions.load')).toHaveLength(2);
  });

  it('shows that Refresh ran, and what it found', async () => {
    const w = world(CONNECTED, held());
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));
    const banner = await screen.findByRole('region', { name: CARD });
    expect(banner).not.toHaveTextContent('Checked');

    fireEvent.click(within(banner).getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Checked again: still held by VS Code (pid 4242).'));
    expect(screen.getByRole('region', { name: CARD })).toHaveTextContent('Checked at');
    expect(w.daemon.calls('sessions.load')).toHaveLength(2);
  });

  it('shows that the read-only chip\'s Refresh ran too', async () => {
    const w = world(CONNECTED, held());
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));
    const banner = await screen.findByRole('region', { name: CARD });
    const chipRefresh = screen.getAllByRole('button', { name: 'Refresh' }).find((button) => !banner.contains(button));
    if (!chipRefresh) throw new Error('no Refresh beside the read-only chip');

    fireEvent.click(chipRefresh);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Checked again: still held by VS Code (pid 4242).'));
    expect(w.daemon.calls('sessions.load')).toHaveLength(2);
  });
});

describe('a session another Ordewell daemon holds (W16)', () => {
  const SINCE = '2026-11-04T10:00:00.000Z';
  const TUI_HELD = { holder: { hostId: 'h1', pid: 48200, host: { kind: 'daemon', port: 49213, ownerPid: 48120 }, since: SINCE, heartbeatAt: SINCE, runnerGroups: [] } };
  const HOLDER = { port: 49213, pid: 48200, ownerPid: 48120, version: '0.12.3', contract: 1, since: SINCE };
  const heldByTui = { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'held', code: 'session_held', sessionHeld: TUI_HELD } } as const;

  it('joins it and names the holder in the header, the status bar and nowhere as a refusal', async () => {
    const w = world(CONNECTED, { 'sessions.load': heldByTui, 'sessions.get': ok(SAVED) });
    w.daemon.joinWith({ ok: true, holder: HOLDER });
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));

    const chip = await screen.findByText('⇄ Joined · TUI pid 48120');
    expect(chip).toHaveAttribute('title', expect.stringContaining('port 49213'));
    expect(chip).toHaveAttribute('title', expect.stringContaining('0.12.3'));
    expect(screen.getByText("Live in the TUI's daemon on port 49213 (pid 48200), shared with the TUI.")).toBeInTheDocument();
    const status = document.querySelector('.frame-status');
    expect(status).toHaveTextContent('· joined :49213');
    expect(status).toHaveTextContent('held by TUI (pid 48120) · joined');
    expect(screen.queryByRole('region', { name: /held|VS Code/i })).not.toBeInTheDocument();
    expect(host.getSnapshot().readOnly).toBe(false);
    expect(body()).not.toHaveAttribute('inert');
  });

  it('says the holder has exited, and continues the session here when asked', async () => {
    let held = true;
    const w = world(CONNECTED, { 'sessions.load': () => (held ? heldByTui : ok({ ok: true, plan: PLAN, goal: 'Ship the parser' })), 'sessions.get': ok(SAVED) });
    w.daemon.joinWith({ ok: true, holder: HOLDER });
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));

    held = false;
    w.daemon.joinWith({ ok: false, reason: 'free', message: 'Nothing holds this session now.' });
    act(() => w.daemon.close('s1'));

    const gone = await screen.findByRole('region', { name: 'The TUI that held this session has exited.' });
    expect(gone).toHaveTextContent('Nothing is running it now.');
    // Nothing still claims the holder holds it: the chip and the status bar say it exited.
    expect(screen.getByText('⊡ Read-only · the TUI exited')).toBeInTheDocument();
    expect(document.querySelector('.frame-status')).toHaveTextContent('TUI (pid 48120) exited · read-only');
    expect(document.querySelector('.frame-status')).not.toHaveTextContent('held by');
    fireEvent.click(within(gone).getByRole('button', { name: 'Continue here' }));

    await waitFor(() => expect(w.daemon.calls('sessions.load')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'The TUI that held this session has exited.' })).not.toBeInTheDocument());
    expect(screen.queryByText(/⇄ Joined/)).not.toBeInTheDocument();
  });

  it('names the holder\'s port in the Reconnecting bar while its daemon is away, and offers no Continue here', async () => {
    const w = world(CONNECTED, { 'sessions.load': heldByTui, 'sessions.get': ok(SAVED) });
    w.daemon.joinWith({ ok: true, holder: HOLDER });
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));

    w.daemon.joinWith({ ok: false, reason: 'unreachable', message: 'The daemon that holds this session no longer answers on :49213.' });
    act(() => w.daemon.close('s1'));

    const away = await screen.findByRole('region', { name: "Reconnecting to the TUI's daemon on :49213…" });
    expect(away).not.toHaveTextContent(':3700');
    expect(within(away).queryByRole('button', { name: 'Continue here' })).not.toBeInTheDocument();

    w.daemon.joinWith({ ok: true, holder: HOLDER });
    await waitFor(() => expect(screen.queryByRole('region', { name: /Reconnecting to the TUI/ })).not.toBeInTheDocument(), { timeout: 15_000 });
  });

  it('names why a join was refused, and keeps the saved state on screen read-only', async () => {
    const message = "The TUI's daemon is 0.9.0 (contract 0); this app speaks contract 1, so it can't join.";
    const w = world(CONNECTED, { 'sessions.load': heldByTui, 'sessions.get': ok(SAVED) });
    w.daemon.joinWith({ ok: false, reason: 'mismatch', message });
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));

    const banner = await screen.findByRole('region', { name: "Can't join the TUI (pid 48120)" });
    expect(banner).toHaveTextContent(message);
    expect(within(banner).getByRole('button', { name: 'Watch read-only' })).toBeInTheDocument();
    expect(host.getSnapshot().readOnly).toBe(true);
    expect(document.querySelector('.frame-status')).toHaveTextContent('held by TUI (pid 48120) · read-only');
  });
});

describe('the restored-session banner', () => {
  it('says the run was not live, never calls an interrupted task passed, and resumes it', async () => {
    const w = world(CONNECTED, {
      'sessions.get': ok(SAVED),
      'sessions.load': ok({ ok: true, plan: PLAN, goal: 'Ship the parser' }),
    });
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));

    const banner = await screen.findByRole('region', { name: 'Restored from disk' });
    expect(banner).toHaveTextContent('not verified');
    fireEvent.click(within(banner).getByRole('button', { name: 'Resume run' }));
    await waitFor(() => expect(w.daemon.calls('plans.execute')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Restored from disk' })).not.toBeInTheDocument());
  });

  it('can be dismissed without resuming anything', async () => {
    const w = world(CONNECTED, {
      'sessions.get': ok(SAVED),
      'sessions.load': ok({ ok: true, plan: PLAN, goal: 'Ship the parser' }),
    });
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));
    const banner = await screen.findByRole('region', { name: 'Restored from disk' });
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Restored from disk' })).not.toBeInTheDocument());
    expect(w.daemon.calls('plans.execute')).toHaveLength(0);
  });
});

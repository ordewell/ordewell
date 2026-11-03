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
const SIZES = { sidebar: 260, right: 360, bottom: 240 };
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
      get: async () => ({ theme: 'system', panes: SIZES, notifications: true, keepRunningInTray: false, editorCommand: '' }),
      set: async () => ({ theme: 'system', panes: SIZES, notifications: true, keepRunningInTray: false, editorCommand: '' }),
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
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux', sizes: SIZES });
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

describe('the held-session banner', () => {
  const held = (): Parameters<typeof world>[1] => ({
    'sessions.load': { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'This session is open in VS Code.', code: 'session_held', sessionHeld: HELD } },
    'sessions.get': ok(SAVED),
  });

  it('names the holder, shows the saved state read-only, and offers only what ADR-0049 allows', async () => {
    const w = world(CONNECTED, held());
    const { host } = mount(CONNECTED);
    await act(() => host.open('s1'));

    const banner = await screen.findByRole('region', { name: 'Held by VS Code (pid 4242)' });
    expect(banner).toHaveTextContent('open in another Ordewell host');
    expect(host.getSnapshot().readOnly).toBe(true);

    fireEvent.click(within(banner).getByRole('button', { name: 'Take over…' }));
    await waitFor(() => expect(w.confirm).toHaveBeenCalledOnce());
    expect(w.daemon.calls('sessions.load')).toHaveLength(2);
    // Still held, so the banner and the read-only state stay.
    expect(await screen.findByRole('region', { name: 'Held by VS Code (pid 4242)' })).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('region', { name: 'Held by VS Code (pid 4242)' })).getByRole('button', { name: 'View read-only' }));
    await waitFor(() => expect(w.daemon.calls('sessions.get').length).toBeGreaterThanOrEqual(3));
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

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonCallResult, DaemonStatus } from '../../../shared/bridge';
import { registerFrameCommands } from '../../frame/commands';
import { Frame } from '../../frame/Frame';
import { FrameProvider, FrameStore } from '../../frame/store';
import { resetDaemonHosts } from '../../session/DaemonHost';
import { registerViews } from '../index';
import { resetTaskViews } from '../task/taskView';

// Monaco needs a browser; the stubs here never open a file.
vi.mock('../../monaco', async () => (await import('../../test/monacoMock')).fakeMonacoModule());

const SIZES = { sidebar: 260, right: 360, bottom: 240 };
const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };

/** The slice of the preload bridge the views touch, pushed by hand. */
function stubBridge(first: DaemonStatus): { push(status: DaemonStatus): void; retry: ReturnType<typeof vi.fn> } {
  const listeners = new Set<(status: DaemonStatus) => void>();
  const retry = vi.fn(async () => ({ ok: false, message: 'Still no daemon.' }));
  const call = vi.fn(async (): Promise<DaemonCallResult> => ({
    ok: true, status: 200, data: [{ id: 's1', goal: 'Ship the frame', status: 'running', taskCount: 2, updatedAt: '2026-11-03T09:00:00.000Z' }],
  }));
  Object.defineProperty(window, 'ordewell', {
    configurable: true,
    value: {
      daemon: {
        status: async () => first,
        onStatus: (cb: (status: DaemonStatus) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        call,
        retry,
        subscribe: () => () => undefined,
        subscribeChild: () => () => undefined,
      },
    },
  });
  return { push: (status) => { for (const cb of listeners) cb(status); }, retry };
}

let offs: Array<() => void> = [];
beforeEach(() => { offs = []; });
afterEach(() => {
  for (const off of offs) off();
  resetDaemonHosts();
  resetTaskViews();
});

function mount(daemon: DaemonStatus): FrameStore {
  const store = new FrameStore({ workspace: '/work/acme', platform: 'linux', sizes: SIZES });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  render(<FrameProvider value={store}><Frame daemon={daemon} /></FrameProvider>);
  return store;
}

describe('the view stubs', () => {
  it('register every seam a later slice fills, and take it all back', () => {
    stubBridge(CONNECTED);
    const store = new FrameStore({ workspace: '/work/acme', platform: 'linux', sizes: SIZES });
    const off = registerViews(store.api);
    const state = store.getSnapshot();
    expect(state.sidebars.map((s) => `${s.activity}/${s.id}`).sort()).toEqual([
      'changes/checkout', 'changes/review', 'explorer/files', 'git/branches', 'plan/needs-you', 'plan/sessions', 'plan/tasks',
    ]);
    expect(Object.keys(state.tabKinds).sort()).toEqual(['commit-diff', 'commits', 'diff', 'file', 'plan', 'settings', 'task']);
    expect(state.panels.map((p) => `${p.region}/${p.id}`).sort()).toEqual(['bottom/terminal', 'right/planner']);
    expect(state.slots.map((s) => s.slot).sort()).toEqual([
      'popover.needsYou', 'status.lease', 'status.runners', 'status.usage', 'title.breadcrumb', 'title.scope',
    ]);
    expect(state.commands.map((c) => c.id)).toContain('explorer.quickOpen');
    off();
    const after = store.getSnapshot();
    expect([after.sidebars, after.panels, after.slots, after.commands, after.banners]).toEqual([[], [], [], [], []]);
    expect(after.tabKinds).toEqual({});
  });

  it('fill the frame: sessions in the Plan sidebar, the planner, the scope, and a diff tab naming its scope', async () => {
    stubBridge(CONNECTED);
    const store = mount(CONNECTED);
    expect(await screen.findByText('Ship the frame')).toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: 'Plan' })).getByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message the planner' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Your checkout');
    expect(screen.getByRole('group', { name: 'Plan view' })).toBeInTheDocument();

    act(() => store.api.openTab({ kind: 'diff', id: 'src/a.ts', title: 'a.ts', scope: { kind: 'integration', sessionId: 's1' } }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', expect.stringContaining('diff'));
    expect(within(screen.getByRole('tabpanel')).getByText('Integration vs base')).toBeInTheDocument();
  });

  it('show the daemon as a banner while it is away, and say a refused retry', async () => {
    const away: DaemonStatus = { state: 'reconnecting', port: 3700, attempt: 2, canStart: false };
    const bridge = stubBridge(away);
    mount(away);
    const banner = await screen.findByRole('region', { name: 'Reconnecting to the daemon…' });
    expect(banner).toHaveClass('frame-banner-warning');
    expect(banner).toHaveTextContent('Nothing answers on 127.0.0.1:3700 (attempt 2).');
    fireEvent.click(within(banner).getByRole('button', { name: 'Retry now' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Still no daemon.'));
    expect(bridge.retry).toHaveBeenCalledOnce();

    act(() => bridge.push(CONNECTED));
    expect(screen.queryByRole('region', { name: 'Reconnecting to the daemon…' })).not.toBeInTheDocument();
  });
});

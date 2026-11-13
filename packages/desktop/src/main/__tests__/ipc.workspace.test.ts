import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
  nativeTheme: { on: () => undefined, shouldUseDarkColors: false },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {},
  shell: {},
}));

import { CHANNELS } from '../../shared/bridge';
import { registerIpc, type IpcDeps } from '../ipc';

/**
 * The daemon keeps one session per id and refuses one another project holds,
 * which it can only tell from a call that says whose it means: a window's
 * calls and sockets name the window's own workspace, never one the page picks.
 */
describe('a window\'s daemon calls name its workspace', () => {
  const calls: Array<{ path: string }> = [];
  const streams: string[] = [];
  const welcomed = vi.fn();
  let context: { kind: 'workspace'; path: string } | { kind: 'welcome' };

  beforeEach(() => {
    handlers.clear();
    calls.length = 0;
    streams.length = 0;
    context = { kind: 'workspace', path: '/b' };
    const proxy = {
      call: (request: { path: string }) => { calls.push(request); return Promise.resolve({ ok: true, status: 200, body: {} }); },
      stream: (path: string) => { streams.push(path); return () => undefined; },
    };
    // What this test does not reach answers any call with nothing.
    const inert = (): unknown => new Proxy(() => inert(), { get: (_target, key) => (key === 'then' ? undefined : inert()) });
    registerIpc({
      appVersion: '0', contract: 1, devOrigin: undefined,
      daemon: inert(), recents: inert(), projects: inert(), prefs: inert(), updates: inert(), notifications: inert(), terminals: inert(),
      windows: { contextOf: () => context, openWelcome: welcomed, broadcast: () => undefined },
      proxy,
      holders: { route: () => undefined },
    } as unknown as IpcDeps);
  });

  const event = { senderFrame: { parent: null, url: 'app://renderer/index.html' }, sender: { id: 1, on: () => undefined, isDestroyed: () => false, send: () => undefined } } as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);

  it('sends a call on a live session with the window\'s workspace', async () => {
    await invoke(CHANNELS.daemonCall, 'plans.stop', { sessionId: 's1' });
    await invoke(CHANNELS.daemonCall, 'runners.setEnabled', { id: 'claude-code' }, { enabled: true });

    expect(calls.map((c) => c.path)).toEqual(['/api/plans/s1/stop?workspace=%2Fb', '/api/runners/claude-code']);
  });

  it('opens a session\'s socket, and a child\'s, with the window\'s workspace', () => {
    invoke(CHANNELS.daemonSubscribe, { sessionId: 's1' });
    invoke(CHANNELS.daemonSubscribe, { rootId: 's1', childId: 'c1' });

    expect(streams).toEqual(['/ws/session/s1?workspace=%2Fb', '/ws/session/s1/child/c1?workspace=%2Fb']);
  });

  it('opens the welcome window for the new-window request', async () => {
    await invoke(CHANNELS.appNewWindow);
    expect(welcomed).toHaveBeenCalledTimes(1);
  });

  it('names none from a window with no workspace', async () => {
    context = { kind: 'welcome' };
    await invoke(CHANNELS.daemonCall, 'plans.stop', { sessionId: 's1' });

    expect(calls.map((c) => c.path)).toEqual(['/api/plans/s1/stop']);
  });
});

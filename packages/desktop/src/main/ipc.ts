import { BrowserWindow, dialog, ipcMain, nativeTheme, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { CHANNELS, EVENTS, type AppInfo, type ConfirmSpec, type StreamDelivery, type StreamEvent } from '../shared/bridge';
import { isAppPage } from '../shared/csp';
import { buildRequest, childStreamPath, sessionStreamPath, type BuildResult } from '../shared/routes';
import type { DaemonManager } from './daemon/DaemonManager';
import type { DaemonProxy } from './daemon/proxy';
import { validPref, type PrefsStore } from './prefs';
import type { RecentsStore } from './recents';
import type { UpdateController } from './updater';
import type { WindowManager } from './windows';

export interface IpcDeps {
  appVersion: string;
  contract: number;
  devOrigin: string | undefined;
  windows: WindowManager;
  daemon: DaemonManager;
  proxy: DaemonProxy;
  recents: RecentsStore;
  prefs: PrefsStore;
  updates: UpdateController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function confirmSpec(value: unknown): ConfirmSpec | undefined {
  if (!isRecord(value)) return undefined;
  const { message, detail, confirmLabel, cancelLabel } = value;
  if (typeof message !== 'string' || typeof confirmLabel !== 'string') return undefined;
  if (detail !== undefined && typeof detail !== 'string') return undefined;
  if (cancelLabel !== undefined && typeof cancelLabel !== 'string') return undefined;
  return { message, confirmLabel, ...(detail !== undefined ? { detail } : {}), ...(cancelLabel !== undefined ? { cancelLabel } : {}) };
}

export function currentTheme(): AppInfo['theme'] {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/**
 * The main half of `window.ordewell` (ADR-0060 H4). Each handler first checks
 * that the call came from the top frame of a window this app opened on its
 * own page, then checks every argument again: the preload's types bind a
 * well-behaved page, not a compromised one.
 */
export function registerIpc(deps: IpcDeps): void {
  const { windows, daemon, proxy, recents, prefs } = deps;
  const streams = new Map<number, { owner: number; close: () => void }>();
  const watched = new Set<number>();
  let nextSubscription = 1;

  function trusted(event: IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) return false;
    return isAppPage(frame.url, deps.devOrigin) && windows.contextOf(event.sender) !== undefined;
  }

  function handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('Refused: not an Ordewell window.');
      return fn(event, ...args);
    });
  }

  function closeStreamsOf(contents: WebContents): void {
    for (const [id, stream] of streams) {
      if (stream.owner !== contents.id) continue;
      stream.close();
      streams.delete(id);
    }
  }

  function openStream(event: IpcMainInvokeEvent, built: BuildResult): number {
    if (!built.ok) throw new Error(built.error);
    const contents = event.sender;
    const subscription = nextSubscription++;
    const deliver = (streamEvent: StreamEvent): void => {
      if (contents.isDestroyed()) return;
      const delivery: StreamDelivery = { subscription, event: streamEvent };
      contents.send(EVENTS.stream, delivery);
      if (streamEvent.kind === 'closed') streams.delete(subscription);
    };
    streams.set(subscription, { owner: contents.id, close: proxy.stream(built.request.path, deliver) });
    if (!watched.has(contents.id)) {
      watched.add(contents.id);
      const id = contents.id;
      // A window that reloads or closes leaves no socket open behind it.
      contents.on('destroyed', () => { closeStreamsOf(contents); watched.delete(id); });
      contents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) closeStreamsOf(contents); });
    }
    return subscription;
  }

  handle(CHANNELS.appInfo, (): AppInfo => ({
    version: deps.appVersion,
    contract: deps.contract,
    platform: process.platform,
    theme: currentTheme(),
  }));
  handle(CHANNELS.appContext, (event) => windows.contextOf(event.sender));

  handle(CHANNELS.appOpenWorkspace, async (event, path) => {
    let chosen: string | undefined;
    if (path === undefined) {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options = { title: 'Open a workspace', properties: ['openDirectory' as const, 'createDirectory' as const] };
      const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      if (picked.canceled) return undefined;
      chosen = picked.filePaths[0];
    } else if (typeof path === 'string') {
      // A page may reopen what the picker once chose, never name a new folder:
      // anything new comes through the native dialog the user answered.
      const recent = recents.list().find((entry) => entry.path === path);
      if (!recent || recent.missing) return undefined;
      chosen = recent.path;
    }
    if (!chosen) return undefined;
    const key = windows.openWorkspace(chosen);
    recents.touch(key);
    return key;
  });
  handle(CHANNELS.appRecentWorkspaces, () => recents.list());
  handle(CHANNELS.appForgetWorkspace, (_event, path) => {
    if (typeof path !== 'string') throw new Error('path must be a string');
    return recents.forget(path);
  });

  handle(CHANNELS.daemonStatus, () => daemon.current());
  handle(CHANNELS.daemonRetry, () => daemon.retry());
  handle(CHANNELS.daemonStart, () => daemon.start());
  handle(CHANNELS.daemonRestart, () => daemon.restart());
  handle(CHANNELS.daemonCall, async (_event, routeId, params, body) => {
    const built = buildRequest(routeId, params, body);
    if (!built.ok) return { ok: false, error: built.error };
    return proxy.call(built.request);
  });
  handle(CHANNELS.daemonSubscribe, (event, target) => {
    if (!isRecord(target)) throw new Error('subscribe takes a target');
    if ('sessionId' in target) return openStream(event, sessionStreamPath(target.sessionId));
    return openStream(event, childStreamPath(target.rootId, target.childId));
  });
  handle(CHANNELS.daemonUnsubscribe, (event, subscription) => {
    if (typeof subscription !== 'number') return;
    const stream = streams.get(subscription);
    // One window cannot close another's socket by guessing its number.
    if (!stream || stream.owner !== event.sender.id) return;
    stream.close();
    streams.delete(subscription);
  });

  handle(CHANNELS.dialogConfirm, async (event, raw) => {
    const spec = confirmSpec(raw);
    if (!spec) throw new Error('confirm takes { message, confirmLabel, detail?, cancelLabel? }');
    const options = {
      type: 'question' as const,
      message: spec.message,
      ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
      buttons: [spec.confirmLabel, spec.cancelLabel ?? 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return answer.response === 0;
  });

  handle(CHANNELS.prefsGet, () => prefs.get());
  handle(CHANNELS.prefsSet, (_event, key, value) => {
    const change = validPref(key, value);
    if (!change) throw new Error(`Refused preference ${String(key)}`);
    const next = prefs.set(change);
    if (change.theme) nativeTheme.themeSource = change.theme;
    return next;
  });
  handle(CHANNELS.updateState, () => ({ state: deps.updates.state() }));

  daemon.onStatus((status) => windows.broadcast(EVENTS.daemonStatus, status));
  nativeTheme.on('updated', () => windows.broadcast(EVENTS.theme, currentTheme()));
}

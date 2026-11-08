import { spawn } from 'node:child_process';
import { BrowserWindow, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { CHANNELS, EVENTS, type AppInfo, type ConfirmSpec, type NotificationClick, type NotificationRequest, type StreamDelivery, type StreamEvent, type TerminalDelivery } from '../shared/bridge';
import { isAppPage } from '../shared/csp';
import { buildRequest, childStreamPath, liveSessionOf, namingWorkspace, segmentError, sessionStreamPath, type BuildResult } from '../shared/routes';
import type { DaemonManager } from './daemon/DaemonManager';
import type { HolderConnections, HolderProxy } from './daemon/holders';
import type { DaemonProxy } from './daemon/proxy';
import type { AttentionNotifier } from './notifications';
import { validPref, type PrefsStore } from './prefs';
import { droppedFolder } from './droppedFolder';
import type { ProjectOpener } from './projectOpener';
import type { RecentsStore } from './recents';
import { Shell } from './shell';
import { bringForward } from './testWindows';
import { webLink } from './terminal/link';
import type { TerminalChannel } from './terminal/TerminalChannel';
import type { TerminalHost } from './terminal/TerminalHost';
import type { UpdateController } from './updater';
import type { WindowManager } from './windows';

export interface IpcDeps {
  appVersion: string;
  contract: number;
  devOrigin: string | undefined;
  windows: WindowManager;
  daemon: DaemonManager;
  proxy: DaemonProxy;
  /** The daemons that hold sessions a window joined (ADR-0063 H8). */
  holders: HolderConnections;
  recents: RecentsStore;
  /** Where a chosen folder opens: focus, switch this window, or a new one (projectSwitch.ts). */
  projects: ProjectOpener;
  prefs: PrefsStore;
  updates: UpdateController;
  notifications: AttentionNotifier;
  terminals: { channel: TerminalChannel; host: TerminalHost };
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

function notificationRequest(value: unknown): NotificationRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { id, title, body, sessionId, taskId } = value;
  if (typeof id !== 'string' || !id || typeof title !== 'string' || typeof body !== 'string') return undefined;
  if (sessionId !== undefined && typeof sessionId !== 'string') return undefined;
  if (taskId !== undefined && typeof taskId !== 'string') return undefined;
  return {
    id,
    title,
    body,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

export function currentTheme(): AppInfo['theme'] {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/**
 * The main half of `window.ordewell` (ADR-0063 H4). Each handler first checks
 * that the call came from the top frame of a window this app opened on its
 * own page, then checks every argument again: the preload's types bind a
 * well-behaved page, not a compromised one.
 */
export function registerIpc(deps: IpcDeps): void {
  const { windows, daemon, proxy, holders, recents, prefs } = deps;
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
    holders.leaveAll(contents.id);
  }

  /** The daemon a window's call or socket for `sessionId` goes to: the holder's when it joined it, else its own. */
  function targetOf(event: IpcMainInvokeEvent, sessionId: string | undefined): HolderProxy {
    return holders.route(event.sender.id, sessionId) ?? proxy;
  }

  function openStream(event: IpcMainInvokeEvent, built: BuildResult, sessionId: unknown): number {
    if (!built.ok) throw new Error(built.error);
    const contents = event.sender;
    const subscription = nextSubscription++;
    const deliver = (streamEvent: StreamEvent): void => {
      if (contents.isDestroyed()) return;
      const delivery: StreamDelivery = { subscription, event: streamEvent };
      contents.send(EVENTS.stream, delivery);
      if (streamEvent.kind === 'closed') streams.delete(subscription);
    };
    const target = targetOf(event, typeof sessionId === 'string' ? sessionId : undefined);
    streams.set(subscription, { owner: contents.id, close: target.stream(built.request.path, deliver) });
    watchStreams(contents);
    return subscription;
  }

  function watchStreams(contents: WebContents): void {
    if (watched.has(contents.id)) return;
    watched.add(contents.id);
    const id = contents.id;
    // A window that reloads or closes leaves no socket open behind it, and no
    // holder joined: a connection nothing uses is closed.
    contents.on('destroyed', () => { closeStreamsOf(contents); watched.delete(id); });
    contents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) closeStreamsOf(contents); });
  }

  handle(CHANNELS.appInfo, (): AppInfo => ({
    version: deps.appVersion,
    contract: deps.contract,
    platform: process.platform,
    theme: currentTheme(),
  }));
  handle(CHANNELS.appContext, (event) => windows.contextOf(event.sender));

  handle(CHANNELS.appOpenWorkspace, async (event, path, options) => {
    const from = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const choice = { newWindow: isRecord(options) && options.newWindow === true };
    if (path === undefined) return deps.projects.pick(from, choice);
    // A page may reopen what the picker once chose, never name a new folder:
    // anything new comes through the native dialog the user answered.
    const recent = typeof path === 'string' ? recents.list().find((entry) => entry.path === path) : undefined;
    if (!recent || recent.missing) return undefined;
    return deps.projects.open(from, recent.path, choice);
  });
  handle(CHANNELS.appOpenDroppedFolder, async (event, path) => {
    const dropped = droppedFolder(path);
    if (!dropped.ok) return { ok: false, message: dropped.message };
    await deps.projects.open(BrowserWindow.fromWebContents(event.sender) ?? undefined, dropped.path);
    return { ok: true };
  });
  handle(CHANNELS.appReportLiveWork, (event, kinds) => { deps.projects.report(event.sender, kinds); });
  handle(CHANNELS.appRecentWorkspaces, () => recents.list());
  handle(CHANNELS.appForgetWorkspace, (_event, path) => {
    if (typeof path !== 'string') throw new Error('path must be a string');
    return recents.forget(path);
  });
  handle(CHANNELS.appUnforgetWorkspace, (_event, path) => {
    if (typeof path !== 'string') throw new Error('path must be a string');
    return recents.unforget(path);
  });
  handle(CHANNELS.appRememberRecent, (_event, path, facts) => { recents.remember(path, facts); });

  handle(CHANNELS.daemonStatus, () => daemon.current());
  handle(CHANNELS.daemonRetry, () => daemon.retry());
  handle(CHANNELS.daemonStart, () => daemon.start());
  handle(CHANNELS.daemonRestart, () => daemon.restart());
  // A window's calls on a session say whose session they mean: the daemon
  // refuses an id another project holds rather than serve that one.
  const windowWorkspace = (event: IpcMainInvokeEvent): string | undefined => {
    const context = windows.contextOf(event.sender);
    return context?.kind === 'workspace' ? context.path : undefined;
  };
  handle(CHANNELS.daemonCall, async (event, routeId, params, body) => {
    const built = buildRequest(routeId, namingWorkspace(routeId, params, windowWorkspace(event)), body);
    if (!built.ok) return { ok: false, error: built.error };
    return targetOf(event, liveSessionOf(routeId, params)).call(built.request);
  });
  handle(CHANNELS.daemonSubscribe, (event, target) => {
    if (!isRecord(target)) throw new Error('subscribe takes a target');
    const workspace = windowWorkspace(event);
    if ('sessionId' in target) return openStream(event, sessionStreamPath(target.sessionId, workspace), target.sessionId);
    return openStream(event, childStreamPath(target.rootId, target.childId, workspace), target.rootId);
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

  handle(CHANNELS.notifyShow, (event, raw) => {
    const request = notificationRequest(raw);
    if (!request) return { ok: false, message: 'A notification needs an id, a title and a body.' };
    return deps.notifications.show(request, () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) {
        bringForward(win);
      } else {
        // The window that asked is gone: the user still asked for the item, so the app comes forward.
        windows.show();
      }
      if (event.sender.isDestroyed()) return;
      const click: NotificationClick = {
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      };
      event.sender.send(EVENTS.notifyClick, click);
    });
  });
  handle(CHANNELS.notifySetBadge, (_event, count) => {
    deps.notifications.setBadge(typeof count === 'number' ? count : 0);
  });

  const files = new Shell(
    {
      openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => { shell.showItemInFolder(path); },
      launch: (program, args) => new Promise((resolve, reject) => {
        const child = spawn(program, args, { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      }),
    },
    () => prefs.get().editorCommand,
  );
  // The workspace is the window's own, never one the page names (ADR-0063 H6).
  const workspaceOfCaller = (event: IpcMainInvokeEvent): string => {
    const context = windows.contextOf(event.sender);
    if (context?.kind !== 'workspace') throw new Error('Refused: this window has no workspace.');
    return context.path;
  };
  // The page names a session; which daemon holds it, and its token, main reads
  // itself from the window's own workspace (ADR-0063 H8).
  handle(CHANNELS.daemonJoin, async (event, sessionId) => {
    const problem = segmentError(sessionId);
    if (problem) throw new Error(`sessionId ${problem}`);
    const workspace = workspaceOfCaller(event);
    watchStreams(event.sender);
    return holders.join(event.sender.id, workspace, sessionId as string);
  });
  handle(CHANNELS.daemonLeave, (event, sessionId) => {
    if (typeof sessionId === 'string') holders.leave(event.sender.id, sessionId);
  });
  handle(CHANNELS.shellOpenInEditor, (event, target) => files.openInEditor(workspaceOfCaller(event), target));
  handle(CHANNELS.shellReveal, (event, target) => files.reveal(workspaceOfCaller(event), target));
  handle(CHANNELS.shellOpenExternal, async (_event, url) => {
    const link = webLink(url);
    if (!link || !link.startsWith('https:')) return { ok: false, message: 'Only https pages open from here.' };
    await shell.openExternal(link);
    return { ok: true };
  });

  // A window that reloads or closes leaves no shell running behind it (ADR-0062 G11).
  const terminalWatched = new Set<number>();
  const callerOf = (event: IpcMainInvokeEvent): Parameters<TerminalChannel['open']>[0] => {
    const contents = event.sender;
    if (!terminalWatched.has(contents.id)) {
      const id = contents.id;
      terminalWatched.add(id);
      contents.on('destroyed', () => { deps.terminals.host.closeOwner(id); terminalWatched.delete(id); });
      contents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) deps.terminals.host.closeOwner(id);
      });
    }
    const context = windows.contextOf(contents);
    return {
      owner: contents.id,
      // The launcher has no checkout; a login opens in home there, and every
      // other terminal is refused by the channel without one.
      ...(context?.kind === 'workspace' ? { workspace: context.path } : {}),
      send: (terminal, terminalEvent) => {
        if (!contents.isDestroyed()) contents.send(EVENTS.terminal, { id: terminal, event: terminalEvent } satisfies TerminalDelivery);
      },
    };
  };
  handle(CHANNELS.terminalOpen, (event, spec) => deps.terminals.channel.open(callerOf(event), spec));
  handle(CHANNELS.terminalWrite, (event, id, data) => { deps.terminals.channel.write(callerOf(event), id, data); });
  handle(CHANNELS.terminalResize, (event, id, cols, rows) => { deps.terminals.channel.resize(callerOf(event), id, cols, rows); });
  handle(CHANNELS.terminalOpenLink, async (_event, url) => {
    const link = webLink(url);
    if (!link) return { ok: false, message: 'Only http and https links open from the terminal.' };
    await shell.openExternal(link);
    return { ok: true };
  });
  handle(CHANNELS.terminalClose, (event, id) => { deps.terminals.channel.close(callerOf(event), id); });

  daemon.onStatus((status) => windows.broadcast(EVENTS.daemonStatus, status));
  nativeTheme.on('updated', () => windows.broadcast(EVENTS.theme, currentTheme()));
}

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  CHANNELS,
  EVENTS,
  type AppInfo,
  type DaemonStatus,
  type MenuCommand,
  type NotificationClick,
  type NotificationRequest,
  type OrdewellBridge,
  type StreamDelivery,
  type TerminalDelivery,
  type TerminalEvent,
  type StreamEvent,
  type SubscribeTarget,
  type Unsubscribe,
} from '../shared/bridge';

/**
 * `window.ordewell` (ADR-0063 H4). The page gets these functions and nothing
 * else: no `ipcRenderer`, no channel names, no token. Each call is one invoke
 * whose arguments main checks again; a stream is a number main hands back,
 * whose frames arrive on one event channel and are routed here by that number.
 */

function listen<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const streamListeners = new Map<number, (event: StreamEvent) => void>();
ipcRenderer.on(EVENTS.stream, (_event, delivery: StreamDelivery) => {
  const cb = streamListeners.get(delivery.subscription);
  if (!cb) return;
  if (delivery.event.kind === 'closed') streamListeners.delete(delivery.subscription);
  cb(delivery.event);
});

function subscribe(target: SubscribeTarget, cb: (event: StreamEvent) => void): Unsubscribe {
  let subscription: number | undefined;
  let cancelled = false;
  void (ipcRenderer.invoke(CHANNELS.daemonSubscribe, target) as Promise<number>).then(
    (id) => {
      if (cancelled) {
        void ipcRenderer.invoke(CHANNELS.daemonUnsubscribe, id);
        return;
      }
      subscription = id;
      streamListeners.set(id, cb);
    },
    (err: unknown) => cb({ kind: 'closed', code: 1008, reason: err instanceof Error ? err.message : String(err) }),
  );
  return () => {
    cancelled = true;
    if (subscription === undefined) return;
    streamListeners.delete(subscription);
    void ipcRenderer.invoke(CHANNELS.daemonUnsubscribe, subscription);
  };
}

const terminalListeners = new Map<number, (event: TerminalEvent) => void>();
ipcRenderer.on(EVENTS.terminal, (_event, delivery: TerminalDelivery) => {
  const cb = terminalListeners.get(delivery.id);
  if (!cb) return;
  if (delivery.event.kind === 'exit') terminalListeners.delete(delivery.id);
  cb(delivery.event);
});
let nextTerminal = 1;

const bridge: OrdewellBridge = {
  app: {
    info: () => ipcRenderer.invoke(CHANNELS.appInfo),
    context: () => ipcRenderer.invoke(CHANNELS.appContext),
    onThemeChange: (cb) => listen<AppInfo['theme']>(EVENTS.theme, cb),
    onMenuCommand: (cb) => listen<MenuCommand>(EVENTS.menuCommand, cb),
    openWorkspace: (path, options) => ipcRenderer.invoke(CHANNELS.appOpenWorkspace, path, options),
    newWindow: () => ipcRenderer.invoke(CHANNELS.appNewWindow),
    recentWorkspaces: () => ipcRenderer.invoke(CHANNELS.appRecentWorkspaces),
    onRecentsChange: (cb) => listen<undefined>(EVENTS.recentsChanged, () => cb()),
    reportLiveWork: (kinds) => ipcRenderer.invoke(CHANNELS.appReportLiveWork, kinds),
    forgetWorkspace: (path) => ipcRenderer.invoke(CHANNELS.appForgetWorkspace, path),
    unforgetWorkspace: (path) => ipcRenderer.invoke(CHANNELS.appUnforgetWorkspace, path),
    rememberRecent: (path, facts) => ipcRenderer.invoke(CHANNELS.appRememberRecent, path, facts),
    // Only the preload can turn a dropped File into its path (contextIsolation
    // hides File.path); a File the page made itself has none, and is refused.
    openDroppedFolder: async (file) => {
      let path = '';
      try { path = webUtils.getPathForFile(file); } catch { path = ''; }
      return ipcRenderer.invoke(CHANNELS.appOpenDroppedFolder, path);
    },
  },
  daemon: {
    status: () => ipcRenderer.invoke(CHANNELS.daemonStatus),
    onStatus: (cb) => listen<DaemonStatus>(EVENTS.daemonStatus, cb),
    retry: () => ipcRenderer.invoke(CHANNELS.daemonRetry),
    start: () => ipcRenderer.invoke(CHANNELS.daemonStart),
    restart: () => ipcRenderer.invoke(CHANNELS.daemonRestart),
    call: (routeId, params, body) => ipcRenderer.invoke(CHANNELS.daemonCall, routeId, params, body),
    subscribe: (sessionId, cb) => subscribe({ sessionId }, cb),
    subscribeChild: (rootId, childId, cb) => subscribe({ rootId, childId }, cb),
    join: (sessionId) => ipcRenderer.invoke(CHANNELS.daemonJoin, sessionId),
    leave: (sessionId) => ipcRenderer.invoke(CHANNELS.daemonLeave, sessionId),
  },
  dialog: {
    confirm: (spec) => ipcRenderer.invoke(CHANNELS.dialogConfirm, spec),
  },
  prefs: {
    get: () => ipcRenderer.invoke(CHANNELS.prefsGet),
    set: (key, value) => ipcRenderer.invoke(CHANNELS.prefsSet, key, value),
  },
  update: {
    state: () => ipcRenderer.invoke(CHANNELS.updateState),
  },
  notify: {
    show: (request: NotificationRequest) => ipcRenderer.invoke(CHANNELS.notifyShow, request),
    setBadge: (count) => ipcRenderer.invoke(CHANNELS.notifySetBadge, count),
    onClick: (cb) => listen<NotificationClick>(EVENTS.notifyClick, cb),
  },
  shell: {
    openInEditor: (target) => ipcRenderer.invoke(CHANNELS.shellOpenInEditor, target),
    reveal: (target) => ipcRenderer.invoke(CHANNELS.shellReveal, target),
    openExternal: (url) => ipcRenderer.invoke(CHANNELS.shellOpenExternal, url),
  },
  terminal: {
    async open(spec, onEvent) {
      // The number is chosen here so the listener is in place before main
      // starts the shell: the prompt's first bytes may be sent before the
      // reply to this call arrives.
      const id = nextTerminal++;
      terminalListeners.set(id, onEvent);
      try {
        const result = (await ipcRenderer.invoke(CHANNELS.terminalOpen, { ...spec, id })) as Awaited<ReturnType<OrdewellBridge['terminal']['open']>>;
        if (!result.ok) terminalListeners.delete(id);
        return result;
      } catch (err) {
        terminalListeners.delete(id);
        throw err;
      }
    },
    write: (id, data) => ipcRenderer.invoke(CHANNELS.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke(CHANNELS.terminalResize, id, cols, rows),
    async close(id) {
      terminalListeners.delete(id);
      await ipcRenderer.invoke(CHANNELS.terminalClose, id);
    },
    openLink: (url) => ipcRenderer.invoke(CHANNELS.terminalOpenLink, url),
  },
};

contextBridge.exposeInMainWorld('ordewell', bridge);

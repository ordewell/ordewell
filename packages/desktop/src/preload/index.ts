import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  CHANNELS,
  EVENTS,
  type AppInfo,
  type DaemonStatus,
  type OrdewellBridge,
  type StreamDelivery,
  type StreamEvent,
  type SubscribeTarget,
  type Unsubscribe,
} from '../shared/bridge';

/**
 * `window.ordewell` (ADR-0060 H4). The page gets these functions and nothing
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

const bridge: OrdewellBridge = {
  app: {
    info: () => ipcRenderer.invoke(CHANNELS.appInfo),
    context: () => ipcRenderer.invoke(CHANNELS.appContext),
    onThemeChange: (cb) => listen<AppInfo['theme']>(EVENTS.theme, cb),
    openWorkspace: (path) => ipcRenderer.invoke(CHANNELS.appOpenWorkspace, path),
    recentWorkspaces: () => ipcRenderer.invoke(CHANNELS.appRecentWorkspaces),
    forgetWorkspace: (path) => ipcRenderer.invoke(CHANNELS.appForgetWorkspace, path),
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
};

contextBridge.exposeInMainWorld('ordewell', bridge);

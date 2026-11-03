/**
 * `window.ordewell`: the one bridge between a renderer and main (ADR-0060 H4).
 * The types are shared so the preload, main's handlers and the renderer cannot
 * drift; every argument is still checked again in main, since a renderer can
 * call `ipcRenderer` channels with anything once it is compromised.
 */

import type { RouteId, RouteParams } from './routes';

export interface AppInfo {
  version: string;
  /** The daemon contract this app speaks (ADR-0060 H3). */
  contract: number;
  platform: string;
  theme: 'light' | 'dark';
}

/** Which window this renderer is: main knows, so a renderer never names its own workspace. */
export type WindowContext = { kind: 'welcome' } | { kind: 'workspace'; path: string };

export interface RecentWorkspace {
  path: string;
  name: string;
  openedAt: string;
  /** The folder is gone: the entry can only be forgotten. */
  missing: boolean;
}

export interface DaemonIdentityView {
  version?: string;
  contract?: number;
}

/**
 * The connection as main sees it. Each state carries what the window needs to
 * draw its card (design W15) without asking again.
 */
export type DaemonStatus =
  | { state: 'connecting'; port: number }
  /** `owned`: this app started it and stops it on quit (ADR-0060 H2). */
  | { state: 'connected'; port: number; owned: boolean; daemon: DaemonIdentityView }
  /** An attached daemon went away: main probes again. `canStart` once the port is free. */
  | { state: 'reconnecting'; port: number; attempt: number; canStart: boolean }
  | { state: 'mismatch'; port: number; daemon: DaemonIdentityView; app: { version: string; contract: number } }
  /** A daemon answers but refuses this user's token, or there is none to read. */
  | { state: 'unauthorized'; port: number; tokenPresented: boolean }
  /** Something that is not a daemon holds the port. */
  | { state: 'port-taken'; port: number }
  | { state: 'failed'; port: number; message: string; logPath: string };

export type DaemonCallResult =
  | { ok: true; status: number; data: unknown }
  /** `status` is absent when no response came back at all. */
  | { ok: false; status?: number; error: string; data?: unknown };

export type StreamEvent =
  | { kind: 'frame'; frame: unknown }
  | { kind: 'closed'; code: number; reason: string };

export interface ActionResult {
  ok: boolean;
  /** Why it was refused, worded for the user. */
  message?: string;
}

export interface ConfirmSpec {
  message: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
}

/** The sizes of the frame's resizable panes, in CSS pixels. */
export interface PaneSizes {
  sidebar: number;
  right: number;
  bottom: number;
}

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  panes: PaneSizes;
}

export interface UpdateState {
  state: 'disabled';
}

export type Unsubscribe = () => void;

export interface OrdewellBridge {
  app: {
    info(): Promise<AppInfo>;
    context(): Promise<WindowContext>;
    onThemeChange(cb: (theme: AppInfo['theme']) => void): Unsubscribe;
    /** With no path, the native folder picker; with one, a recent entry. Focuses an open window (H6). */
    openWorkspace(path?: string): Promise<string | undefined>;
    recentWorkspaces(): Promise<RecentWorkspace[]>;
    forgetWorkspace(path: string): Promise<RecentWorkspace[]>;
  };
  daemon: {
    status(): Promise<DaemonStatus>;
    onStatus(cb: (status: DaemonStatus) => void): Unsubscribe;
    retry(): Promise<ActionResult>;
    start(): Promise<ActionResult>;
    restart(): Promise<ActionResult>;
    call(routeId: RouteId, params?: RouteParams, body?: unknown): Promise<DaemonCallResult>;
    subscribe(sessionId: string, cb: (event: StreamEvent) => void): Unsubscribe;
    subscribeChild(rootId: string, childId: string, cb: (event: StreamEvent) => void): Unsubscribe;
  };
  dialog: {
    confirm(spec: ConfirmSpec): Promise<boolean>;
  };
  prefs: {
    get(): Promise<Prefs>;
    set<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<Prefs>;
  };
  update: {
    state(): Promise<UpdateState>;
  };
}

/** Invoke channels, one per bridge call; `event` channels flow main → renderer. */
export const CHANNELS = {
  appInfo: 'ordewell:app.info',
  appContext: 'ordewell:app.context',
  appOpenWorkspace: 'ordewell:app.openWorkspace',
  appRecentWorkspaces: 'ordewell:app.recentWorkspaces',
  appForgetWorkspace: 'ordewell:app.forgetWorkspace',
  daemonStatus: 'ordewell:daemon.status',
  daemonRetry: 'ordewell:daemon.retry',
  daemonStart: 'ordewell:daemon.start',
  daemonRestart: 'ordewell:daemon.restart',
  daemonCall: 'ordewell:daemon.call',
  daemonSubscribe: 'ordewell:daemon.subscribe',
  daemonUnsubscribe: 'ordewell:daemon.unsubscribe',
  dialogConfirm: 'ordewell:dialog.confirm',
  prefsGet: 'ordewell:prefs.get',
  prefsSet: 'ordewell:prefs.set',
  updateState: 'ordewell:update.state',
} as const;

export const EVENTS = {
  theme: 'ordewell:event.theme',
  daemonStatus: 'ordewell:event.daemonStatus',
  stream: 'ordewell:event.stream',
} as const;

/** What `daemonSubscribe` takes: a session's socket, or one of its child plans'. */
export type SubscribeTarget = { sessionId: string } | { rootId: string; childId: string };

export interface StreamDelivery {
  subscription: number;
  event: StreamEvent;
}

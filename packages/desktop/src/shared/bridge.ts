/**
 * `window.ordewell`: the one bridge between a renderer and main (ADR-0063 H4).
 * The types are shared so the preload, main's handlers and the renderer cannot
 * drift; every argument is still checked again in main, since a renderer can
 * call `ipcRenderer` channels with anything once it is compromised.
 */

import type { RouteId, RouteParams } from './routes';
import type { TerminalScope } from './terminalScope';

export interface AppInfo {
  version: string;
  /** The daemon contract this app speaks (ADR-0063 H3). */
  contract: number;
  platform: string;
  theme: 'light' | 'dark';
}

/** Which window this renderer is: main knows, so a renderer never names its own workspace. */
export type WindowContext = { kind: 'welcome' } | { kind: 'workspace'; path: string };

/** A workspace's git, as the welcome window last saw it: one repository's branch, or a folder of them (ADR-0014). */
export type RecentGit =
  | { kind: 'branch'; name: string }
  | { kind: 'detached' }
  | { kind: 'repos'; count: number }
  | { kind: 'none' };

/** The newest session the daemon listed for a workspace, kept so its card draws before the daemon answers. */
export interface RecentSession {
  id: string;
  goal: string;
  /** The daemon's plan status: `draft`, `approved`, `rejected`, `running` or `completed`. */
  status: string;
  updatedAt: string;
}

/** What the welcome window may record about a recent workspace once the daemon tells it. */
export interface RecentFacts {
  git?: RecentGit;
  lastSession?: RecentSession;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  /** The path with home as `~`; main says it since the page does not know home. */
  displayPath: string;
  openedAt: string;
  /** The folder is gone: the entry can only be forgotten. */
  missing: boolean;
  git?: RecentGit;
  lastSession?: RecentSession;
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
  /** `owned`: this app started it and stops it on quit (ADR-0063 H2). */
  | { state: 'connected'; port: number; owned: boolean; daemon: DaemonIdentityView }
  /** An attached daemon went away: main probes again. `canStart` once the port is free. */
  | { state: 'reconnecting'; port: number; attempt: number; canStart: boolean }
  | { state: 'mismatch'; port: number; daemon: DaemonIdentityView; app: { version: string; contract: number } }
  /** A daemon answers but refuses this user's token, or there is none to read. */
  | { state: 'unauthorized'; port: number; tokenPresented: boolean }
  /** Something that is not a daemon holds the port. */
  | { state: 'port-taken'; port: number }
  | { state: 'failed'; port: number; message: string; logPath: string };

/** The daemon that holds a session this window joined (ADR-0063 H8), for the joined chip and status bar. */
export interface HolderView {
  port: number;
  /** The daemon's process. */
  pid: number;
  /** The TUI the daemon serves, when it is a TUI's private daemon. */
  ownerPid?: number;
  version?: string;
  /** Absent when the holder is known only from the lease, as after it exited. */
  contract?: number;
  /** When it took the session. */
  since: string;
}

/**
 * Why a held session was not joined: `free`, nothing holds it any longer;
 * `vscode`, its host runs it in-process with nothing to join; `own`, this
 * app's daemon is the holder; the rest are each a reason the join failed.
 */
export type JoinRefusal = 'free' | 'vscode' | 'own' | 'no-host' | 'token' | 'unreachable' | 'mismatch';

export type JoinResult =
  | { ok: true; holder: HolderView }
  | { ok: false; reason: JoinRefusal; message: string };

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

export type ClipboardReadResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

export interface ConfirmSpec {
  message: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
}

/**
 * How the user left one workspace's window (docs/desktop/design.md, Sizing).
 * A size is kept only once the user dragged it: until then the window's width
 * band decides it.
 */
export interface SavedLayout {
  sidebar?: number;
  plan?: number;
  terminal?: number;
  activity?: string;
  sidebarOpen?: boolean;
  planOpen?: boolean;
  terminalOpen?: boolean;
}

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  /**
   * Each workspace's layout, by its path. Setting it merges: a window sends
   * only its own workspace's entry.
   */
  layouts: Record<string, SavedLayout>;
  /** Desktop notifications when something needs the user or a run ends. */
  notifications: boolean;
  /** Keep the app running in the tray when its last window closes and no run is live (H5). */
  keepRunningInTray: boolean;
  /** Reopen, on a launch with no folder named, the project windows open when the app last quit. */
  reopenProjects: boolean;
  /** The project windows open when the app last quit. Main writes it; a page cannot. */
  openProjects: string[];
  /** Whether Settings' Advanced section is open; it starts closed and stays as the user left it. */
  settingsAdvancedOpen: boolean;
  /**
   * The command "Open in editor" runs instead of the OS default, such as
   * `code --goto {file}:{line}`; empty uses the default. Main reads it from the
   * prefs file only: a page can never set it, since it names a program to run.
   */
  editorCommand: string;
}

/** One OS notification. The id is how the same wait is shown once, however often a view re-reads it. */
export interface NotificationRequest {
  id: string;
  title: string;
  body: string;
  /** The session the item belongs to; the window that asked is focused on click. */
  sessionId?: string;
  /** The task tab to open when the notification is clicked; absent opens the plan. */
  taskId?: string;
}

/** What a clicked notification asks the renderer to open. */
export interface NotificationClick {
  sessionId?: string;
  taskId?: string;
}

/** A file in the user's checkout, named the way the read routes name it. */
export interface ShellTarget {
  /** The repository, `.` for the workspace root. */
  repo: string;
  /** From the repository root; absent reveals the repository itself. */
  path?: string;
  line?: number;
}

export interface UpdateState {
  /** `disabled` until installers are signed (ADR-0063): the app never fetches an update on its own. */
  state: 'disabled' | 'checking';
}

/** Where a terminal opens: a repo of the window's workspace, and the scope the view is in. */
export interface TerminalOpenSpec {
  repo: string;
  scope: TerminalScope;
  cols: number;
  rows: number;
  /**
   * Start this agent's own login instead of a shell. Only the runner id
   * crosses: main resolves the argv from core, so a page never names a
   * program to run (ADR-0052).
   */
  login?: { runner: string };
}

export type TerminalOpenResult =
  /** `id` names the terminal in every later call; `cwd` is the directory the shell started in. */
  | { ok: true; id: number; cwd: string; shell: string }
  | { ok: false; message: string };

export type TerminalEvent =
  | { kind: 'data'; data: string }
  | { kind: 'exit'; exitCode: number; signal?: number }
  /** The shell's line editor joined the word link: Option+Left/Right moves by words in it (ADR-0069). */
  | { kind: 'words' };

export interface TerminalDelivery {
  id: number;
  event: TerminalEvent;
}

export type Unsubscribe = () => void;

/** The frame commands (renderer/frame/commands.ts) the application menu offers; the menu names no other. */
export type MenuCommand = 'layout.reset' | 'terminal.toggle';

/**
 * What a project window has going that switching it to another folder would
 * leave behind: a run, something in Needs you, an open checkpoint, a planner
 * turn. The page says which; main words them, so a page cannot write the
 * question it is asked.
 */
export const LIVE_WORK_KINDS = ['run', 'needsYou', 'checkpoint', 'planner'] as const;
export type LiveWorkKind = (typeof LIVE_WORK_KINDS)[number];

export interface OpenWorkspaceOptions {
  /** Open it in a window of its own rather than switching this one. */
  newWindow?: boolean;
}

export interface OrdewellBridge {
  app: {
    info(): Promise<AppInfo>;
    context(): Promise<WindowContext>;
    onThemeChange(cb: (theme: AppInfo['theme']) => void): Unsubscribe;
    /** An application-menu item that runs one of the frame's commands in the focused window. */
    onMenuCommand(cb: (command: MenuCommand) => void): Unsubscribe;
    /**
     * With no path, the native folder picker; with one, a recent entry.
     * Focuses an open window (H6); from a project window with nothing live it
     * switches that window, and with live work it asks to open a new one.
     * Undefined when nothing was opened.
     */
    openWorkspace(path?: string, options?: OpenWorkspaceOptions): Promise<string | undefined>;
    /** The welcome window beside whatever is open, as File → New Window does. */
    newWindow(): Promise<void>;
    recentWorkspaces(): Promise<RecentWorkspace[]>;
    /** The recents changed in another window or from the menu, so a list drawn from them is stale. */
    onRecentsChange(cb: () => void): Unsubscribe;
    /** What this window has live now; asked about before the window switches folder. */
    reportLiveWork(kinds: readonly LiveWorkKind[]): Promise<void>;
    forgetWorkspace(path: string): Promise<RecentWorkspace[]>;
    /** Forget's Undo: only an entry this app forgot comes back. */
    unforgetWorkspace(path: string): Promise<RecentWorkspace[]>;
    /** Records a recent workspace's branch and last session; a path not in the list is ignored. */
    rememberRecent(path: string, facts: RecentFacts): Promise<void>;
    /**
     * Opens a folder dropped on the window. The preload turns the dropped file
     * into its path; main opens it only when it is a directory, and refuses
     * anything else in words the page shows.
     */
    openDroppedFolder(file: File): Promise<ActionResult>;
  };
  daemon: {
    status(): Promise<DaemonStatus>;
    onStatus(cb: (status: DaemonStatus) => void): Unsubscribe;
    retry(): Promise<ActionResult>;
    start(): Promise<ActionResult>;
    restart(): Promise<ActionResult>;
    call(routeId: RouteId, params?: RouteParams, body?: unknown): Promise<DaemonCallResult>;
    subscribe(sessionId: string, cb: (event: StreamEvent) => void): Unsubscribe;
    /**
     * Join the daemon that holds `sessionId` (ADR-0063 H8): main reads which
     * one from the lease, so the page names only the session. Until `leave`,
     * this window's calls and socket for that session go to the holder.
     */
    join(sessionId: string): Promise<JoinResult>;
    leave(sessionId: string): Promise<void>;
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
  /**
   * What the OS shows attention with: a desktop notification for a new wait or
   * a run's end, and the count on the Dock, the taskbar or the launcher badge.
   * Main decides whether the user has muted notifications; the renderer never
   * does (the setting is app-local, like the theme).
   */
  notify: {
    show(request: NotificationRequest): Promise<ActionResult>;
    setBadge(count: number): Promise<void>;
    /** A click on a notification this app showed: focus comes first, then this. */
    onClick(cb: (click: NotificationClick) => void): Unsubscribe;
  };
  /**
   * What the OS does with a file of the user's checkout. Main knows the window's
   * workspace and resolves the path inside it, so a page names a repo and a
   * path and never an absolute one. Only the checkout has files on disk (W8).
   */
  shell: {
    openInEditor(target: ShellTarget): Promise<ActionResult>;
    reveal(target: ShellTarget): Promise<ActionResult>;
    /** Opens an https page in the OS browser, such as a runner's install docs; anything else is refused. */
    openExternal(url: string): Promise<ActionResult>;
  };
  /**
   * The built-in terminal (ADR-0062 G11). The shells are main's: a page asks
   * for one by repo and scope and main picks the directory, so it cannot start a
   * shell anywhere else. Output and the exit come back on one event channel to
   * the callback given to `open`; the listener exists before the shell does, so
   * its first bytes are not lost.
   */
  terminal: {
    open(spec: TerminalOpenSpec, onEvent: (event: TerminalEvent) => void): Promise<TerminalOpenResult>;
    write(id: number, data: string): Promise<void>;
    resize(id: number, cols: number, rows: number): Promise<void>;
    close(id: number): Promise<void>;
    /** Option+Left/Right: a word move the shell makes only at its own prompt, never bytes typed (ADR-0069). */
    word(id: number, direction: 'left' | 'right'): Promise<void>;
    /** Opens an http(s) address in the OS browser; anything else is refused. The page has no other way out (security.ts). */
    openLink(url: string): Promise<ActionResult>;
  };
  /**
   * The system clipboard's plain text, through main: the session grants the
   * page no web clipboard permission (security.ts). Each call is honoured only
   * while the user is pressing a key or clicking in this window; any other
   * time, and on any failure, the result says why, worded for the user.
   */
  clipboard: {
    readText(): Promise<ClipboardReadResult>;
    writeText(text: string): Promise<ActionResult>;
  };
}

/** Invoke channels, one per bridge call; `event` channels flow main → renderer. */
export const CHANNELS = {
  appInfo: 'ordewell:app.info',
  appContext: 'ordewell:app.context',
  appOpenWorkspace: 'ordewell:app.openWorkspace',
  appNewWindow: 'ordewell:app.newWindow',
  appRecentWorkspaces: 'ordewell:app.recentWorkspaces',
  appForgetWorkspace: 'ordewell:app.forgetWorkspace',
  appUnforgetWorkspace: 'ordewell:app.unforgetWorkspace',
  appRememberRecent: 'ordewell:app.rememberRecent',
  appOpenDroppedFolder: 'ordewell:app.openDroppedFolder',
  appReportLiveWork: 'ordewell:app.reportLiveWork',
  daemonStatus: 'ordewell:daemon.status',
  daemonRetry: 'ordewell:daemon.retry',
  daemonStart: 'ordewell:daemon.start',
  daemonRestart: 'ordewell:daemon.restart',
  daemonCall: 'ordewell:daemon.call',
  daemonSubscribe: 'ordewell:daemon.subscribe',
  daemonUnsubscribe: 'ordewell:daemon.unsubscribe',
  daemonJoin: 'ordewell:daemon.join',
  daemonLeave: 'ordewell:daemon.leave',
  dialogConfirm: 'ordewell:dialog.confirm',
  prefsGet: 'ordewell:prefs.get',
  prefsSet: 'ordewell:prefs.set',
  updateState: 'ordewell:update.state',
  notifyShow: 'ordewell:notify.show',
  notifySetBadge: 'ordewell:notify.setBadge',
  shellOpenInEditor: 'ordewell:shell.openInEditor',
  shellReveal: 'ordewell:shell.reveal',
  shellOpenExternal: 'ordewell:shell.openExternal',
  terminalOpen: 'ordewell:terminal.open',
  terminalWrite: 'ordewell:terminal.write',
  terminalResize: 'ordewell:terminal.resize',
  terminalClose: 'ordewell:terminal.close',
  terminalOpenLink: 'ordewell:terminal.openLink',
  terminalWord: 'ordewell:terminal.word',
  clipboardReadText: 'ordewell:clipboard.readText',
  clipboardWriteText: 'ordewell:clipboard.writeText',
} as const;

export const EVENTS = {
  theme: 'ordewell:event.theme',
  daemonStatus: 'ordewell:event.daemonStatus',
  stream: 'ordewell:event.stream',
  terminal: 'ordewell:event.terminal',
  notifyClick: 'ordewell:event.notifyClick',
  menuCommand: 'ordewell:event.menuCommand',
  recentsChanged: 'ordewell:event.recentsChanged',
} as const;

/** What `daemonSubscribe` takes: a session's socket, or one of its child plans'. */
export type SubscribeTarget = { sessionId: string } | { rootId: string; childId: string };

export interface StreamDelivery {
  subscription: number;
  event: StreamEvent;
}

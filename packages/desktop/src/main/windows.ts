import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from 'electron';
import type { WindowContext } from '../shared/bridge';
import { canvasColour, titleBarOverlay, workspaceChrome } from './chrome';
import { guardClose } from './lifecycle';
import { bringForward, showWhenReady, windowsHidden } from './testWindows';

export interface WindowManagerOptions {
  preloadPath: string;
  /** The page every window loads: the app's own scheme, or the dev server in development. */
  pageUrl: string;
  devTools: boolean;
  /** Whether the OS, or the user's theme preference, has the app dark. */
  dark(): boolean;
  /**
   * Whether closing this window may go ahead, asked before it closes; it
   * answers undefined when there is nothing to ask (ADR-0062 G11).
   */
  confirmClose?(win: BrowserWindow): Promise<boolean> | undefined;
}

/** The key a workspace's window is found by: its real path, so a symlink and its target are one workspace (H6). */
export function workspaceKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function titleOf(key: string): string {
  return `${basename(key) || key} — Ordewell`;
}

/**
 * The app's windows: one welcome window, and one per workspace (ADR-0063 H6).
 * Main, not the page, knows which window is which, so a renderer can never
 * claim another workspace by naming it.
 */
export class WindowManager {
  private welcome: BrowserWindow | undefined;
  private readonly workspaces = new Map<string, BrowserWindow>();
  private readonly contexts = new Map<number, WindowContext>();

  constructor(private readonly options: WindowManagerOptions) {}

  openWelcome(): BrowserWindow {
    if (this.welcome && !this.welcome.isDestroyed()) return this.focus(this.welcome);
    this.welcome = this.create({ kind: 'welcome' }, 'Ordewell', { width: 1000, height: 720 });
    this.welcome.on('closed', () => { this.welcome = undefined; });
    return this.welcome;
  }

  /**
   * Focus the workspace's window when it has one, or open it. The welcome
   * window it came from closes; asked from a project window, a welcome window
   * the user opened beside it stays.
   */
  openWorkspace(path: string, options: { closeWelcome?: boolean } = {}): string {
    const key = workspaceKey(path);
    const existing = this.windowOf(key);
    if (existing) {
      this.focus(existing);
    } else {
      const chrome = workspaceChrome(process.platform, this.options.dark());
      const win = this.create({ kind: 'workspace', path: key }, titleOf(key), { width: 1280, height: 820, ...chrome });
      this.workspaces.set(key, win);
      // Looked up when it closes, not taken now: the window may have switched workspace since.
      win.on('closed', () => {
        const now = this.workspaceOf(win);
        if (now !== undefined) this.workspaces.delete(now);
      });
    }
    if ((options.closeWelcome ?? true) && this.welcome && !this.welcome.isDestroyed()) this.welcome.close();
    return key;
  }

  /** The window a workspace is open in, if any. */
  windowOf(key: string): BrowserWindow | undefined {
    const win = this.workspaces.get(key);
    return win && !win.isDestroyed() ? win : undefined;
  }

  isWelcome(win: BrowserWindow): boolean {
    return win === this.welcome;
  }

  /**
   * Show another workspace in a project window, as an editor does: the page
   * loads again for it, so its streams, terminals and joined holders close
   * through the navigation every reload goes through (ADR-0063 H8), and a
   * joined session goes on with its holder. The caller has checked that
   * nothing live is left behind, and that no other window has the workspace.
   */
  switchWorkspace(win: BrowserWindow, path: string): string {
    const key = workspaceKey(path);
    const previous = this.workspaceOf(win);
    if (previous === undefined || win.isDestroyed()) throw new Error('Only a project window can switch workspace.');
    if (this.windowOf(key)) throw new Error('That workspace is open in another window.');
    this.workspaces.delete(previous);
    this.workspaces.set(key, win);
    this.contexts.set(win.webContents.id, { kind: 'workspace', path: key });
    win.setTitle(titleOf(key));
    void win.loadURL(this.options.pageUrl);
    return key;
  }

  /** What a sender is, or undefined for one this app did not open. */
  contextOf(contents: WebContents): WindowContext | undefined {
    return this.contexts.get(contents.id);
  }

  /** The workspace whose window this is, for closing it while its run goes on. */
  workspaceOf(win: BrowserWindow): string | undefined {
    for (const [key, candidate] of this.workspaces) if (candidate === win) return key;
    return undefined;
  }

  all(): BrowserWindow[] {
    return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && this.contexts.has(win.webContents.id));
  }

  broadcast(channel: string, payload: unknown): void {
    for (const win of this.all()) win.webContents.send(channel, payload);
  }

  /**
   * Repaint what main draws itself when the theme changes: every window's
   * canvas (the colour a resize or a reload shows before the page paints) and
   * the window controls' overlay.
   */
  retheme(): void {
    const dark = this.options.dark();
    for (const win of this.all()) win.setBackgroundColor(canvasColour(dark));
    if (process.platform === 'darwin') return;
    const overlay = titleBarOverlay(dark);
    for (const win of this.workspaces.values()) if (!win.isDestroyed()) win.setTitleBarOverlay(overlay);
  }

  /** Bring a window back from the tray or the Dock: the last one used, or the welcome window. */
  show(): void {
    const [first] = this.all();
    if (first) this.focus(first);
    else this.openWelcome();
  }

  private focus(win: BrowserWindow): BrowserWindow {
    bringForward(win);
    return win;
  }

  private create(context: WindowContext, title: string, shape: BrowserWindowConstructorOptions): BrowserWindow {
    // A test run never shows its windows (testWindows.ts). A hidden page would
    // otherwise be throttled and stop painting, so it keeps rendering at its real size.
    const hidden = windowsHidden();
    const win = new BrowserWindow({
      ...shape,
      minWidth: 720,
      minHeight: 520,
      title,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: canvasColour(this.options.dark()),
      webPreferences: {
        preload: this.options.preloadPath,
        // ADR-0063 H4: the page gets the bridge and nothing of Node or Electron.
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        spellcheck: false,
        devTools: this.options.devTools,
        backgroundThrottling: !hidden,
      },
    });
    const id = win.webContents.id;
    this.contexts.set(id, context);
    win.on('closed', () => { this.contexts.delete(id); });
    const confirmClose = this.options.confirmClose;
    if (confirmClose) win.on('close', guardClose(() => confirmClose(win), () => win.close()));
    showWhenReady(win);
    void win.loadURL(this.options.pageUrl);
    return win;
  }
}

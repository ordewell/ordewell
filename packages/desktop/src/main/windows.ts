import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import type { WindowContext } from '../shared/bridge';

export interface WindowManagerOptions {
  preloadPath: string;
  /** The page every window loads: the app's own scheme, or the dev server in development. */
  pageUrl: string;
  devTools: boolean;
  backgroundColor(): string;
}

/** The key a workspace's window is found by: its real path, so a symlink and its target are one workspace (H6). */
export function workspaceKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The app's windows: one welcome window, and one per workspace (ADR-0060 H6).
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
    this.welcome = this.create({ kind: 'welcome' }, 'Ordewell', { width: 880, height: 640 });
    this.welcome.on('closed', () => { this.welcome = undefined; });
    return this.welcome;
  }

  /** Focus the workspace's window when it has one, or open it, and close the welcome window it came from. */
  openWorkspace(path: string): string {
    const key = workspaceKey(path);
    const existing = this.workspaces.get(key);
    if (existing && !existing.isDestroyed()) {
      this.focus(existing);
    } else {
      const win = this.create({ kind: 'workspace', path: key }, `${basename(key)} — Ordewell`, { width: 1280, height: 820 });
      this.workspaces.set(key, win);
      win.on('closed', () => { this.workspaces.delete(key); });
    }
    if (this.welcome && !this.welcome.isDestroyed()) this.welcome.close();
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

  /** Bring a window back from the tray or the Dock: the last one used, or the welcome window. */
  show(): void {
    const [first] = this.all();
    if (first) this.focus(first);
    else this.openWelcome();
  }

  private focus(win: BrowserWindow): BrowserWindow {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  private create(context: WindowContext, title: string, size: { width: number; height: number }): BrowserWindow {
    const win = new BrowserWindow({
      ...size,
      minWidth: 640,
      minHeight: 480,
      title,
      show: false,
      backgroundColor: this.options.backgroundColor(),
      webPreferences: {
        preload: this.options.preloadPath,
        // ADR-0060 H4: the page gets the bridge and nothing of Node or Electron.
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
      },
    });
    const id = win.webContents.id;
    this.contexts.set(id, context);
    win.on('closed', () => { this.contexts.delete(id); });
    win.once('ready-to-show', () => win.show());
    void win.loadURL(this.options.pageUrl);
    return win;
  }
}

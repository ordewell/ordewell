import type { Menu, MenuItemConstructorOptions, Task } from 'electron';
import { NEW_WINDOW_SWITCH } from './launch';

/**
 * The app icon's own menu offers New Window on every OS, as VS Code's does.
 * macOS and Windows are wired here; Linux reads it from the .desktop file's
 * `new-window` Action, which electron-builder.yml (`linux.desktop`) writes for
 * the deb and scripts/install/desktop.sh for the AppImage.
 */

/** electron-builder.yml's appId, which NSIS stamps on the shortcuts it makes. */
export const APP_USER_MODEL_ID = 'ai.ordewell.desktop';

export interface OsEntriesApp {
  dock?: { setMenu(menu: Menu): void };
  setUserTasks(tasks: Task[]): boolean;
  setAppUserModelId(id: string): void;
}

export interface OsEntriesOptions {
  app: OsEntriesApp;
  platform: NodeJS.Platform;
  packaged: boolean;
  /** osSurfacesAllowed(): a hidden test run leaves the user's Dock and taskbar alone. */
  allowed: boolean;
  execPath: string;
  buildMenu: (template: MenuItemConstructorOptions[]) => Menu;
  newWindow: () => void;
}

export function registerNewWindowEntries(options: OsEntriesOptions): void {
  const { app, platform } = options;
  if (!options.allowed) return;
  if (platform === 'darwin') {
    // The running app's own action: the Dock menu belongs to this process, so
    // nothing needs relaunching. Recent folders reach it via addRecentDocument.
    app.dock?.setMenu(options.buildMenu([{ label: 'New Window', click: () => options.newWindow() }]));
    return;
  }
  // From a source checkout execPath is electron.exe, which would need the app's
  // path ahead of the switch; the jump list is a packaged app's alone.
  if (platform !== 'win32' || !options.packaged) return;
  // Without an explicit id Windows derives one from the executable's path,
  // which does not match the id NSIS put on the Start menu and desktop
  // shortcuts: a pinned icon and its running window would be two taskbar
  // buttons, and the jump list would attach to the unpinned one.
  app.setAppUserModelId(APP_USER_MODEL_ID);
  // A task starts a second process, which the single-instance lock hands to
  // this one as a `second-instance` launch (launch.ts).
  app.setUserTasks([{
    program: options.execPath,
    arguments: NEW_WINDOW_SWITCH,
    iconPath: options.execPath,
    iconIndex: 0,
    title: 'New Window',
    description: 'Open a new Ordewell window',
  }]);
}

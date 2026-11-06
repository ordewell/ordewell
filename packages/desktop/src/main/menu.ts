import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommand, RecentWorkspace } from '../shared/bridge';

/** What the menu's own items do; each runs for the focused window, or with none. */
export interface MenuActions {
  /** A frame command, run in the focused window as the palette would. */
  command(id: MenuCommand): void;
  openFolder(): void;
  openRecent(path: string): void;
  clearRecents(): void;
  /** The welcome window, beside whatever is open. */
  newWindow(): void;
}

export interface MenuOptions {
  platform: NodeJS.Platform;
  dev: boolean;
  appName: string;
  /** Newest first, as the store keeps them. */
  recents: readonly RecentWorkspace[];
  actions: MenuActions;
}

/**
 * The application menu. Electron's default one closes the window on Cmd/Ctrl+W
 * and reloads it on Cmd/Ctrl+R, and a menu accelerator fires before the page
 * sees the key: the frame's Close tab would close the window instead. So every
 * submenu is spelled out here, and Close Window moves to Shift+W, as editors do.
 * An item of the frame's own, such as Reset Layout, goes to the focused window
 * through `command`, which runs it there as the palette would. The File menu is
 * the same on every platform, so a folder opens the same way from any window.
 */
export function menuTemplate({ platform, dev, appName, recents, actions }: MenuOptions): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const command = actions.command;
  const separator: MenuItemConstructorOptions = { type: 'separator' };
  const app: MenuItemConstructorOptions[] = mac
    ? [{
        label: appName,
        submenu: [
          { role: 'about' }, separator,
          { role: 'services' }, separator,
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, separator,
          { role: 'quit' },
        ],
      }]
    : [];
  return [
    ...app,
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => actions.openFolder() },
        { label: 'Open Recent', submenu: openRecent(platform, recents, actions) },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => actions.newWindow() },
        separator,
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(mac ? [] : [separator, { role: 'quit' } as const]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, separator,
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(dev ? [{ role: 'reload' } as const, { role: 'toggleDevTools' } as const, separator] : []),
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, separator,
        { role: 'togglefullscreen' }, separator,
        { label: 'Reset Layout', click: () => command('layout.reset') },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(mac ? [separator, { role: 'front' } as const] : [])],
    },
  ];
}

/**
 * Open Recent: each folder by its name, with its path only where two share a
 * name. A folder that is gone is left out; the welcome window still shows it,
 * with Forget.
 */
function openRecent(platform: NodeJS.Platform, recents: readonly RecentWorkspace[], actions: MenuActions): MenuItemConstructorOptions[] {
  const present = recents.filter((recent) => !recent.missing);
  const names = new Map<string, number>();
  for (const recent of present) names.set(recent.name, (names.get(recent.name) ?? 0) + 1);
  // Elsewhere a single & marks the item's access key, and would swallow the character after it.
  const literal = (label: string): string => (platform === 'darwin' ? label : label.replaceAll('&', '&&'));
  const entries: MenuItemConstructorOptions[] = present.length === 0
    ? [{ label: 'No Recent Folders', enabled: false }]
    : present.map((recent) => ({
        label: literal((names.get(recent.name) ?? 0) > 1 ? `${recent.name} — ${recent.displayPath}` : recent.name),
        click: () => actions.openRecent(recent.path),
      }));
  return [
    ...entries,
    { type: 'separator' },
    { label: 'Clear Recently Opened', enabled: recents.length > 0, click: () => actions.clearRecents() },
  ];
}

import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '../shared/bridge';

/**
 * The application menu. Electron's default one closes the window on Cmd/Ctrl+W
 * and reloads it on Cmd/Ctrl+R, and a menu accelerator fires before the page
 * sees the key: the frame's Close tab would close the window instead. So every
 * submenu is spelled out here, and Close Window moves to Shift+W, as editors do.
 * An item of the frame's own, such as Reset Layout, goes to the focused window
 * through `command`, which runs it there as the palette would.
 */
export function menuTemplate(platform: NodeJS.Platform, dev: boolean, appName: string, command: (id: MenuCommand) => void): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
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

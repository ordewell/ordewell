import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { RecentWorkspace } from '../../shared/bridge';
import { menuTemplate, type MenuActions } from '../menu';

/** The chords the workspace frame binds (renderer/frame/commands.ts, views), in Electron's spelling. */
const FRAME_CHORDS = [
  'CmdOrCtrl+K', 'CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+4', 'CmdOrCtrl+,',
  'CmdOrCtrl+B', 'CmdOrCtrl+L', 'Ctrl+`', 'CmdOrCtrl+Shift+A', 'CmdOrCtrl+Shift+Enter',
  'CmdOrCtrl+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'CmdOrCtrl+\\', 'CmdOrCtrl+P',
];

/** Roles whose default accelerator is one of the frame's. */
const ROLES_ON_FRAME_CHORDS = new Set(['fileMenu', 'windowMenu', 'viewMenu', 'appMenu', 'editMenu']);

const quiet: MenuActions = { command: () => {}, openFolder: () => {}, openRecent: () => {}, clearRecents: () => {}, newWindow: () => {} };

function template(platform: NodeJS.Platform, dev = false, recents: RecentWorkspace[] = [], actions: Partial<MenuActions> = {}): MenuItemConstructorOptions[] {
  return menuTemplate({ platform, dev, appName: 'Ordewell', recents, actions: { ...quiet, ...actions } });
}

function recent(path: string, name: string, extra: Partial<RecentWorkspace> = {}): RecentWorkspace {
  return { path, name, displayPath: path.replace('/home/me', '~'), openedAt: '2026-11-03T00:00:00.000Z', missing: false, ...extra };
}

function submenu(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  return Array.isArray(item?.submenu) ? item.submenu : [];
}

function file(platform: NodeJS.Platform, recents: RecentWorkspace[] = [], actions: Partial<MenuActions> = {}): MenuItemConstructorOptions[] {
  return submenu(template(platform, false, recents, actions).find((item) => item.label === 'File'));
}

const click = (item: MenuItemConstructorOptions | undefined): void => { item?.click?.({} as never, undefined, {} as never); };

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
}

describe('menuTemplate', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    for (const dev of [false, true]) {
      it(`binds none of the frame's chords on ${platform}${dev ? ' in development' : ''}`, () => {
        const all = items(template(platform, dev, [recent('/home/me/a', 'a')]));
        for (const item of all) {
          if (item.accelerator) expect(FRAME_CHORDS).not.toContain(item.accelerator);
          if (item.role) expect(ROLES_ON_FRAME_CHORDS.has(item.role)).toBe(false);
          // A close without its own chord would take Electron's default, Cmd/Ctrl+W.
          if (item.role === 'close') expect(item.accelerator).toBe('CmdOrCtrl+Shift+W');
        }
      });
    }
  }

  it('reloads and opens devtools only in development', () => {
    const roles = (dev: boolean): unknown[] => items(template('linux', dev)).map((item) => item.role);
    expect(roles(false)).not.toContain('reload');
    expect(roles(false)).not.toContain('toggleDevTools');
    expect(roles(true)).toContain('reload');
  });

  it('puts the app menu and quit where each platform expects them', () => {
    const mac = template('darwin');
    expect(mac[0]?.label).toBe('Ordewell');
    const linux = items(template('linux'));
    expect(linux.some((item) => item.role === 'quit')).toBe(true);
  });

  it('runs Reset Layout in the frame, from the View menu as the spec puts it', () => {
    const command = vi.fn();
    const view = template('darwin', false, [], { command }).find((item) => item.label === 'View');
    const reset = items(Array.isArray(view?.submenu) ? view.submenu : []).find((item) => item.label === 'Reset Layout');
    expect(reset?.accelerator).toBeUndefined();
    reset?.click?.({} as never, undefined, {} as never);
    expect(command).toHaveBeenCalledWith('layout.reset');
  });

  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`opens folders from the File menu the same way on ${platform}`, () => {
      const labels = file(platform).map((item) => item.label ?? item.type ?? item.role);
      const tail = platform === 'darwin' ? [] : ['separator', 'quit'];
      expect(labels).toEqual(['Open Folder…', 'Open Recent', 'New Window', 'separator', 'Close Window', ...tail]);
      expect(file(platform).find((item) => item.label === 'Open Folder…')?.accelerator).toBe('CmdOrCtrl+O');
      expect(file(platform).find((item) => item.label === 'New Window')?.accelerator).toBe('CmdOrCtrl+Shift+N');
    });
  }

  it('runs Open Folder… and New Window through their actions', () => {
    const openFolder = vi.fn();
    const newWindow = vi.fn();
    const menu = file('linux', [], { openFolder, newWindow });
    click(menu.find((item) => item.label === 'Open Folder…'));
    click(menu.find((item) => item.label === 'New Window'));
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(newWindow).toHaveBeenCalledTimes(1);
  });

  it('lists the recents newest first by folder name, then Clear Recently Opened', () => {
    const openRecent = vi.fn();
    const clearRecents = vi.fn();
    const recents = [recent('/home/me/api', 'api'), recent('/home/me/web', 'web')];
    const open = submenu(file('darwin', recents, { openRecent, clearRecents }).find((item) => item.label === 'Open Recent'));
    expect(open.map((item) => item.label ?? item.type)).toEqual(['api', 'web', 'separator', 'Clear Recently Opened']);
    click(open[1]);
    expect(openRecent).toHaveBeenCalledWith('/home/me/web');
    click(open[3]);
    expect(clearRecents).toHaveBeenCalledTimes(1);
  });

  it('adds the path to a name two recents share, and leaves out a folder that is gone', () => {
    const recents = [recent('/home/me/a/app', 'app'), recent('/home/me/gone', 'gone', { missing: true }), recent('/home/me/b/app', 'app')];
    const open = submenu(file('linux', recents).find((item) => item.label === 'Open Recent'));
    expect(open.map((item) => item.label ?? item.type)).toEqual(['app — ~/a/app', 'app — ~/b/app', 'separator', 'Clear Recently Opened']);
  });

  it('keeps an ampersand in a folder name from turning into an access key on Windows and Linux', () => {
    const open = submenu(file('win32', [recent('/home/me/R&D', 'R&D')]).find((item) => item.label === 'Open Recent'));
    expect(open[0]?.label).toBe('R&&D');
  });

  it('shows an empty Open Recent with Clear Recently Opened disabled', () => {
    const open = submenu(file('linux').find((item) => item.label === 'Open Recent'));
    expect(open.map((item) => [item.label ?? item.type, item.enabled])).toEqual([
      ['No Recent Folders', false],
      ['separator', undefined],
      ['Clear Recently Opened', false],
    ]);
  });
});

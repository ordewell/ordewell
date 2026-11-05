import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { menuTemplate } from '../menu';

/** The chords the workspace frame binds (renderer/frame/commands.ts, views), in Electron's spelling. */
const FRAME_CHORDS = [
  'CmdOrCtrl+K', 'CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+4', 'CmdOrCtrl+,',
  'CmdOrCtrl+B', 'CmdOrCtrl+L', 'Ctrl+`', 'CmdOrCtrl+Shift+A', 'CmdOrCtrl+Shift+Enter',
  'CmdOrCtrl+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'CmdOrCtrl+\\', 'CmdOrCtrl+P',
];

/** Roles whose default accelerator is one of the frame's. */
const ROLES_ON_FRAME_CHORDS = new Set(['fileMenu', 'windowMenu', 'viewMenu', 'appMenu', 'editMenu']);

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
}

describe('menuTemplate', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    for (const dev of [false, true]) {
      it(`binds none of the frame's chords on ${platform}${dev ? ' in development' : ''}`, () => {
        const all = items(menuTemplate(platform, dev, 'Ordewell', () => {}));
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
    const roles = (dev: boolean): unknown[] => items(menuTemplate('linux', dev, 'Ordewell', () => {})).map((item) => item.role);
    expect(roles(false)).not.toContain('reload');
    expect(roles(false)).not.toContain('toggleDevTools');
    expect(roles(true)).toContain('reload');
  });

  it('puts the app menu and quit where each platform expects them', () => {
    const mac = menuTemplate('darwin', false, 'Ordewell', () => {});
    expect(mac[0]?.label).toBe('Ordewell');
    const linux = items(menuTemplate('linux', false, 'Ordewell', () => {}));
    expect(linux.some((item) => item.role === 'quit')).toBe(true);
  });

  it('runs Reset Layout in the frame, from the View menu as the spec puts it', () => {
    const command = vi.fn();
    const view = menuTemplate('darwin', false, 'Ordewell', command).find((item) => item.label === 'View');
    const reset = items(Array.isArray(view?.submenu) ? view.submenu : []).find((item) => item.label === 'Reset Layout');
    expect(reset?.accelerator).toBeUndefined();
    reset?.click?.({} as never, undefined, {} as never);
    expect(command).toHaveBeenCalledWith('layout.reset');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Menu, MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { APP_USER_MODEL_ID, registerNewWindowEntries, type OsEntriesOptions } from '../osEntries';

function fake(platform: NodeJS.Platform, overrides: Partial<OsEntriesOptions> = {}) {
  const app = { dock: { setMenu: vi.fn() }, setUserTasks: vi.fn(() => true), setAppUserModelId: vi.fn() };
  const templates: MenuItemConstructorOptions[][] = [];
  const newWindow = vi.fn();
  const menu = {} as Menu;
  registerNewWindowEntries({
    app,
    platform,
    packaged: true,
    allowed: true,
    execPath: 'C:\\Programs\\Ordewell\\Ordewell.exe',
    buildMenu: (template) => { templates.push(template); return menu; },
    newWindow,
    ...overrides,
  });
  return { app, templates, newWindow, menu };
}

describe('registerNewWindowEntries', () => {
  it('gives the macOS Dock a New Window item that runs the in-app action', () => {
    const { app, templates, newWindow, menu } = fake('darwin');
    expect(app.dock.setMenu).toHaveBeenCalledWith(menu);
    expect(templates).toHaveLength(1);
    expect(templates[0].map((item) => item.label)).toEqual(['New Window']);
    const click = templates[0][0].click as () => void;
    click();
    expect(newWindow).toHaveBeenCalledOnce();
    expect(app.setUserTasks).not.toHaveBeenCalled();
  });

  it('gives a packaged Windows app a jump-list task relaunching with --new-window, under the installer shortcut id', () => {
    const { app } = fake('win32');
    expect(app.setAppUserModelId).toHaveBeenCalledWith(APP_USER_MODEL_ID);
    expect(app.setUserTasks).toHaveBeenCalledWith([expect.objectContaining({
      program: 'C:\\Programs\\Ordewell\\Ordewell.exe',
      arguments: '--new-window',
      title: 'New Window',
    })]);
    expect(app.dock.setMenu).not.toHaveBeenCalled();
  });

  it('leaves the jump list alone from a source checkout, where execPath is Electron itself', () => {
    const { app } = fake('win32', { packaged: false });
    expect(app.setUserTasks).not.toHaveBeenCalled();
    expect(app.setAppUserModelId).not.toHaveBeenCalled();
  });

  it('sets nothing on Linux, whose entry is the .desktop file', () => {
    const { app } = fake('linux');
    expect(app.setUserTasks).not.toHaveBeenCalled();
    expect(app.dock.setMenu).not.toHaveBeenCalled();
  });

  it('touches no OS surface in a hidden test run', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const { app } = fake(platform, { allowed: false });
      expect(app.dock.setMenu).not.toHaveBeenCalled();
      expect(app.setUserTasks).not.toHaveBeenCalled();
      expect(app.setAppUserModelId).not.toHaveBeenCalled();
    }
  });

  it('matches the appId electron-builder.yml gives the installer', () => {
    const yml = readFileSync(join(__dirname, '../../../electron-builder.yml'), 'utf8');
    expect(yml).toMatch(new RegExp(`^appId: ${APP_USER_MODEL_ID.replace(/\./g, '\\.')}$`, 'm'));
  });
});

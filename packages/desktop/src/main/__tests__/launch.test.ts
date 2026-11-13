import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchAction, launchDataOf, NEW_WINDOW_SWITCH, OpenProjectsMemory, parseLaunchArgs, type LaunchRequest } from '../launch';

let dir: string;
let project: string;
let other: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ow-launch-'));
  project = path.join(dir, 'project');
  other = path.join(dir, 'other project');
  mkdirSync(project);
  mkdirSync(other);
  writeFileSync(path.join(dir, 'notes.txt'), 'not a folder');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const exe = path.join(tmpdir(), 'Ordewell');
const packaged = (...args: string[]): LaunchRequest => parseLaunchArgs({ argv: [exe, ...args], cwd: dir, defaultApp: false });
const none: LaunchRequest = { folders: [], newWindow: false, ignored: [] };

describe('parseLaunchArgs', () => {
  it('opens a folder named by its absolute path', () => {
    expect(packaged(project)).toEqual({ ...none, folders: [project] });
  });

  it('reads a relative folder against the directory the launch was made from', () => {
    expect(packaged('project')).toEqual({ ...none, folders: [project] });
    expect(packaged('.')).toEqual({ ...none, folders: [dir] });
    expect(packaged(path.join('project', '..', 'other project'))).toEqual({ ...none, folders: [other] });
  });

  it('accepts a file:// URI, as a Linux launcher passes %U', () => {
    expect(packaged(pathToFileURL(other).href)).toEqual({ ...none, folders: [other] });
  });

  it('skips Electron, Chromium and OS switches, and reads --new-window', () => {
    expect(packaged('-psn_0_12345', '--no-sandbox', '--inspect=0', '--user-data-dir=/x')).toEqual(none);
    expect(packaged(NEW_WINDOW_SWITCH)).toEqual({ ...none, newWindow: true });
    expect(packaged('--allow-file-access-from-files', '--', project)).toEqual({ ...none, folders: [project] });
  });

  it('skips the app itself in an unpackaged run, wherever the switches put it', () => {
    const electron = path.join(dir, 'electron');
    const app = path.join(dir, 'app');
    mkdirSync(app);
    expect(parseLaunchArgs({ argv: [electron, app], cwd: dir, defaultApp: true })).toEqual(none);
    expect(parseLaunchArgs({ argv: [electron, '--inspect=0', '--remote-debugging-port=0', app, '--user-data-dir=/x'], cwd: dir, defaultApp: true })).toEqual(none);
    expect(parseLaunchArgs({ argv: [electron, app, 'project', NEW_WINDOW_SWITCH], cwd: dir, defaultApp: true })).toEqual({ folders: [project], newWindow: true, ignored: [] });
  });

  it('sets aside a file, a missing path and another scheme, keeping the folders given', () => {
    expect(packaged('notes.txt', 'missing', 'https://example.com', project, project, other))
      .toEqual({ folders: [project, other], newWindow: false, ignored: ['notes.txt', 'missing', 'https://example.com'] });
    expect(packaged('file://%00')).toEqual({ ...none, ignored: ['file://%00'] });
  });

  it('reads Windows paths, drive letters and backslashes, on any host', () => {
    const win = path.win32;
    const cwd = win.join('C:\\', 'Users', 'me');
    const seen: string[] = [];
    const parse = (...args: string[]): LaunchRequest => parseLaunchArgs({
      argv: [win.join(cwd, 'AppData', 'Local', 'Programs', 'Ordewell', 'Ordewell.exe'), ...args],
      cwd,
      defaultApp: false,
      path: win,
      isDirectory: (folder) => { seen.push(folder); return true; },
    });
    expect(parse('code\\acme', 'D:\\work\\billing', '..\\shared').folders)
      .toEqual([win.join(cwd, 'code', 'acme'), win.join('D:\\', 'work', 'billing'), win.join('C:\\', 'Users', 'shared')]);
    expect(seen).toEqual([win.join(cwd, 'code', 'acme'), win.join('D:\\', 'work', 'billing'), win.join('C:\\', 'Users', 'shared')]);
  });
});

describe('launchDataOf', () => {
  it('takes the argv and directory a second launch sent, and nothing malformed', () => {
    expect(launchDataOf({ argv: [exe, project], cwd: dir })).toEqual({ argv: [exe, project], cwd: dir });
    for (const bad of [undefined, null, 'x', {}, { argv: [exe, 1], cwd: dir }, { argv: [exe], cwd: '' }, { argv: 'x', cwd: dir }]) {
      expect(launchDataOf(bad)).toBeUndefined();
    }
  });
});

describe('launchAction', () => {
  const plain = none;
  const exists = (folder: string): boolean => folder !== path.join(dir, 'gone');

  it('opens the folders a launch names, before anything else', () => {
    const request = { ...none, folders: [project], newWindow: true };
    expect(launchAction({ request, first: true, reopen: true, remembered: [other], isDirectory: exists })).toEqual({ kind: 'open', folders: [project] });
    expect(launchAction({ request, first: false, reopen: true, remembered: [], isDirectory: exists })).toEqual({ kind: 'open', folders: [project] });
  });

  it('opens the welcome window for --new-window, on a first launch or a second', () => {
    const request = { ...none, newWindow: true };
    expect(launchAction({ request, first: true, reopen: true, remembered: [other], isDirectory: exists })).toEqual({ kind: 'welcome' });
    expect(launchAction({ request, first: false, reopen: true, remembered: [], isDirectory: exists })).toEqual({ kind: 'welcome' });
  });

  it('brings the app forward on a plain second launch, reopening nothing', () => {
    expect(launchAction({ request: plain, first: false, reopen: true, remembered: [project], isDirectory: exists })).toEqual({ kind: 'show' });
    expect(launchAction({ request: { ...none, ignored: ['missing'] }, first: false, reopen: true, remembered: [], isDirectory: exists })).toEqual({ kind: 'show' });
  });

  it('reopens last session\'s projects that still exist on a plain first launch', () => {
    const gone = path.join(dir, 'gone');
    expect(launchAction({ request: plain, first: true, reopen: true, remembered: [project, gone, other], isDirectory: exists }))
      .toEqual({ kind: 'open', folders: [project, other] });
    expect(launchAction({ request: { ...none, ignored: ['missing'] }, first: true, reopen: true, remembered: [project], isDirectory: exists }))
      .toEqual({ kind: 'open', folders: [project] });
  });

  it('opens the welcome window when there is nothing to reopen, or the user turned reopening off', () => {
    expect(launchAction({ request: plain, first: true, reopen: true, remembered: [], isDirectory: exists })).toEqual({ kind: 'welcome' });
    expect(launchAction({ request: plain, first: true, reopen: true, remembered: [path.join(dir, 'gone')], isDirectory: exists })).toEqual({ kind: 'welcome' });
    expect(launchAction({ request: plain, first: true, reopen: false, remembered: [project], isDirectory: exists })).toEqual({ kind: 'welcome' });
  });
});

describe('OpenProjectsMemory', () => {
  it('follows the project windows as they open, switch and close', () => {
    const memory = new OpenProjectsMemory();
    memory.changed([project], 1);
    memory.changed([project, other], 2);
    memory.changed([other], 1);
    expect(memory.list()).toEqual([other]);
  });

  it('keeps what was open just before the last window closed', () => {
    const memory = new OpenProjectsMemory();
    memory.changed([project, other], 2);
    memory.changed([other], 1);
    memory.changed([], 0);
    expect(memory.list()).toEqual([other]);
    // The Dock or the tray brings a window back, and what opens next is the new desk.
    memory.changed([project], 1);
    expect(memory.list()).toEqual([project]);
  });

  it('forgets the projects when only the welcome window is left', () => {
    const memory = new OpenProjectsMemory();
    memory.changed([project], 2);
    memory.changed([], 1);
    expect(memory.list()).toEqual([]);
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonFile, writeJsonFile } from '../jsonFile';
import { DEFAULT_PREFS, MAX_LAYOUTS, PrefsStore, validPref } from '../prefs';
import { droppedFolder } from '../droppedFolder';
import { MAX_RECENTS, RecentsStore, displayPath } from '../recents';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ow-desktop-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('jsonFile', () => {
  it('reads undefined for a missing or damaged file', () => {
    expect(readJsonFile(join(dir, 'absent.json'))).toBeUndefined();
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(readJsonFile(join(dir, 'bad.json'))).toBeUndefined();
  });

  it('writes a file only its owner can read, creating its directory', () => {
    const file = join(dir, 'nested', 'x.json');
    writeJsonFile(file, { a: 1 });
    expect(readJsonFile(file)).toEqual({ a: 1 });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('RecentsStore', () => {
  const at = (iso: string) => () => new Date(iso);

  it('lists newest first and moves a reopened workspace to the top', () => {
    const file = join(dir, 'recents.json');
    let now = '2026-11-01T00:00:00.000Z';
    const store = new RecentsStore(file, () => true, () => new Date(now));
    store.touch('/a');
    now = '2026-11-02T00:00:00.000Z';
    store.touch('/b');
    now = '2026-11-03T00:00:00.000Z';
    expect(store.touch('/a').map((r) => [r.path, r.openedAt])).toEqual([
      ['/a', '2026-11-03T00:00:00.000Z'],
      ['/b', '2026-11-02T00:00:00.000Z'],
    ]);
  });

  it('names each entry by its folder and marks one that is gone', () => {
    const store = new RecentsStore(join(dir, 'recents.json'), (path) => path !== '/gone', at('2026-11-03T00:00:00.000Z'), '/home/me');
    store.touch('/gone');
    store.touch('/Users/me/repo');
    expect(store.list()).toEqual([
      { path: '/Users/me/repo', name: 'repo', displayPath: '/Users/me/repo', openedAt: '2026-11-03T00:00:00.000Z', missing: false },
      { path: '/gone', name: 'gone', displayPath: '/gone', openedAt: '2026-11-03T00:00:00.000Z', missing: true },
    ]);
  });

  it('keeps at most MAX_RECENTS', () => {
    const store = new RecentsStore(join(dir, 'recents.json'), () => true, at('2026-11-03T00:00:00.000Z'));
    for (let i = 0; i < MAX_RECENTS + 3; i += 1) store.touch(`/w${i}`);
    const list = store.list();
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0]?.path).toBe(`/w${MAX_RECENTS + 2}`);
  });

  it('forgets one entry', () => {
    const store = new RecentsStore(join(dir, 'recents.json'), () => true, at('2026-11-03T00:00:00.000Z'));
    store.touch('/a');
    store.touch('/b');
    expect(store.forget('/a').map((r) => r.path)).toEqual(['/b']);
  });

  it('remembers a branch and a last session for a listed workspace only, and keeps them when reopened', () => {
    const store = new RecentsStore(join(dir, 'recents.json'), () => true, at('2026-11-03T00:00:00.000Z'));
    store.touch('/a');
    const lastSession = { id: 's1', goal: 'Add SSO login', status: 'running', updatedAt: '2026-11-03T00:00:00.000Z' };
    expect(store.remember('/a', { git: { kind: 'branch', name: 'main' }, lastSession })).toBe(true);
    expect(store.remember('/never-opened', { git: { kind: 'branch', name: 'main' } })).toBe(false);
    store.touch('/b');
    store.touch('/a');
    expect(store.list()[0]).toMatchObject({ path: '/a', git: { kind: 'branch', name: 'main' }, lastSession });
    expect(store.list().map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('refuses facts that are not well formed or are too long', () => {
    const store = new RecentsStore(join(dir, 'recents.json'), () => true, at('2026-11-03T00:00:00.000Z'));
    store.touch('/a');
    expect(store.remember('/a', { git: { kind: 'branch', name: '' } })).toBe(false);
    expect(store.remember('/a', { git: { kind: 'repos', count: -1 } })).toBe(false);
    expect(store.remember('/a', { lastSession: { id: 's', goal: 'x'.repeat(501), status: 'running', updatedAt: '' } })).toBe(false);
    expect(store.remember('/a', 'nonsense')).toBe(false);
    expect(store.remember(42, { git: { kind: 'none' } })).toBe(false);
    expect(store.list()[0]).not.toHaveProperty('git');
  });

  it('puts a forgotten entry back in its place, and nothing it did not forget', () => {
    let now = '2026-11-01T00:00:00.000Z';
    const store = new RecentsStore(join(dir, 'recents.json'), () => true, () => new Date(now));
    store.touch('/c');
    store.touch('/b');
    now = '2026-11-02T00:00:00.000Z';
    store.touch('/a');
    store.forget('/b');
    expect(store.unforget('/b').map((r) => [r.path, r.openedAt])).toEqual([
      ['/a', '2026-11-02T00:00:00.000Z'],
      ['/b', '2026-11-01T00:00:00.000Z'],
      ['/c', '2026-11-01T00:00:00.000Z'],
    ]);
    expect(store.unforget('/elsewhere').map((r) => r.path)).toEqual(['/a', '/b', '/c']);
  });

  it('clears every entry, and tells its listeners each time the list changes', () => {
    const store = new RecentsStore(join(dir, 'recents.json'), () => true, at('2026-11-03T00:00:00.000Z'));
    const seen: string[][] = [];
    store.onChange((list) => seen.push(list.map((r) => r.path)));
    store.touch('/a');
    store.touch('/b');
    expect(store.clear()).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(seen).toEqual([['/a'], ['/b', '/a'], []]);
  });

  it('does not tell its listeners about a remembered fact, which reorders nothing', () => {
    const store = new RecentsStore(join(dir, 'recents.json'), () => true, at('2026-11-03T00:00:00.000Z'));
    store.touch('/a');
    let calls = 0;
    store.onChange(() => { calls += 1; });
    expect(store.remember('/a', { git: { kind: 'branch', name: 'main' } })).toBe(true);
    expect(calls).toBe(0);
  });

  it('skips malformed entries and starts afresh from a damaged file', () => {
    const file = join(dir, 'recents.json');
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ path: '/ok', openedAt: 'x' }, { path: 3 }, null, { path: '', openedAt: 'x' }] }));
    expect(new RecentsStore(file, () => true).list().map((r) => r.path)).toEqual(['/ok']);
    writeFileSync(file, 'garbage');
    expect(new RecentsStore(file, () => true).list()).toEqual([]);
  });
});

describe('displayPath', () => {
  const home = join(sep, 'Users', 'me');

  it('writes home as ~', () => {
    expect(displayPath(join(home, 'code', 'acme'), home)).toBe(`~${sep}code${sep}acme`);
    expect(displayPath(home, home)).toBe('~');
  });

  it('leaves a path outside home, or one that only starts with its name, alone', () => {
    expect(displayPath(join(sep, 'srv', 'x'), home)).toBe(join(sep, 'srv', 'x'));
    expect(displayPath(`${home}2${sep}x`, home)).toBe(`${home}2${sep}x`);
  });
});

describe('droppedFolder', () => {
  it('opens an absolute directory', () => {
    expect(droppedFolder(dir)).toEqual({ ok: true, path: dir });
  });

  it('refuses a file, a missing path, a relative path and an empty one', () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'x');
    for (const raw of [file, join(dir, 'gone'), 'relative/dir', '', undefined, 3]) {
      expect(droppedFolder(raw)).toEqual({ ok: false, message: 'Drop one folder.' });
    }
  });
});

describe('prefs', () => {
  it('accepts only a known theme', () => {
    expect(validPref('theme', 'dark')).toEqual({ theme: 'dark' });
    expect(validPref('theme', 'neon')).toBeUndefined();
    expect(validPref('workspace', '/etc')).toBeUndefined();
    expect(validPref('__proto__', 'dark')).toBeUndefined();
  });

  it('starts dark, and keeps a theme the user already saved', () => {
    expect(DEFAULT_PREFS.theme).toBe('dark');
    const file = join(dir, 'prefs.json');
    expect(new PrefsStore(file).get().theme).toBe('dark');
    writeFileSync(file, JSON.stringify({ notifications: false }));
    expect(new PrefsStore(file).get().theme).toBe('dark');
    for (const saved of ['system', 'light', 'dark'] as const) {
      writeFileSync(file, JSON.stringify({ theme: saved }));
      expect(new PrefsStore(file).get().theme).toBe(saved);
    }
    // A later write of something else (a dragged pane) leaves the saved theme alone.
    writeFileSync(file, JSON.stringify({ theme: 'system' }));
    expect(new PrefsStore(file).set({ layouts: { '/repo': { sidebar: 300 } } }).theme).toBe('system');
  });

  it('accepts all three themes and refuses a non-string one', () => {
    for (const theme of ['system', 'light', 'dark'] as const) expect(validPref('theme', theme)).toEqual({ theme });
    expect(validPref('theme', 1)).toBeUndefined();
    expect(validPref('theme', undefined)).toBeUndefined();
  });

  it('accepts the two desktop attention preferences only as booleans', () => {
    expect(validPref('notifications', false)).toEqual({ notifications: false });
    expect(validPref('keepRunningInTray', true)).toEqual({ keepRunningInTray: true });
    expect(validPref('notifications', 'no')).toBeUndefined();
    expect(validPref('keepRunningInTray', 1)).toBeUndefined();
  });

  it('remembers whether Settings\' Advanced section is open, as a boolean, closed by default', () => {
    expect(validPref('settingsAdvancedOpen', true)).toEqual({ settingsAdvancedOpen: true });
    expect(validPref('settingsAdvancedOpen', 'open')).toBeUndefined();
    expect(DEFAULT_PREFS.settingsAdvancedOpen).toBe(false);
  });

  it('accepts a workspace layout only with sane sizes and booleans', () => {
    expect(validPref('layouts', { '/repo': { sidebar: 300.4, plan: 320, terminalOpen: true, activity: 'git' } }))
      .toEqual({ layouts: { '/repo': { sidebar: 300, plan: 320, terminalOpen: true, activity: 'git' } } });
    expect(validPref('layouts', { '/repo': { sidebar: -1 } })).toBeUndefined();
    expect(validPref('layouts', { '/repo': { plan: Infinity } })).toBeUndefined();
    expect(validPref('layouts', { '/repo': { terminal: 1e9 } })).toBeUndefined();
    expect(validPref('layouts', { '/repo': { planOpen: 'yes' } })).toBeUndefined();
    expect(validPref('layouts', { '/repo': { activity: '../../etc' } })).toEqual({ layouts: { '/repo': {} } });
    expect(validPref('layouts', '300')).toBeUndefined();
    expect(validPref('layouts', [])).toBeUndefined();
    const hostile = JSON.parse('{"__proto__": {"sidebar": 300}}') as unknown;
    expect(validPref('layouts', hostile)).toBeUndefined();
  });

  it('merges one workspace layout into the others, forgetting the oldest past the cap', () => {
    const file = join(dir, 'prefs.json');
    const store = new PrefsStore(file);
    store.set({ layouts: { '/a': { sidebar: 300 } } });
    expect(store.set({ layouts: { '/b': { plan: 400 } } }).layouts).toEqual({ '/a': { sidebar: 300 }, '/b': { plan: 400 } });
    expect(store.set({ layouts: { '/a': { sidebar: 320 } } }).layouts).toEqual({ '/b': { plan: 400 }, '/a': { sidebar: 320 } });
    for (let i = 0; i < MAX_LAYOUTS; i += 1) store.set({ layouts: { [`/w${i}`]: {} } });
    const kept = Object.keys(store.get().layouts);
    expect(kept).toHaveLength(MAX_LAYOUTS);
    expect(kept).not.toContain('/b');
    expect(kept.at(-1)).toBe(`/w${MAX_LAYOUTS - 1}`);
  });

  it('never takes the editor command from a page, only from the file', () => {
    expect(validPref('editorCommand', 'rm -rf /')).toBeUndefined();
    const file = join(dir, 'prefs.json');
    writeFileSync(file, JSON.stringify({ editorCommand: 'code -r' }));
    const store = new PrefsStore(file);
    expect(store.get().editorCommand).toBe('code -r');
    expect(store.set({ theme: 'dark' }).editorCommand).toBe('code -r');
    writeFileSync(file, JSON.stringify({ editorCommand: 7 }));
    expect(new PrefsStore(file).get().editorCommand).toBe('');
  });

  it('reads defaults, keeps a set value and drops unknown keys from the file', () => {
    const file = join(dir, 'prefs.json');
    const store = new PrefsStore(file);
    expect(store.get()).toEqual(DEFAULT_PREFS);
    expect(store.set({ theme: 'light' })).toEqual({ ...DEFAULT_PREFS, theme: 'light' });
    writeFileSync(file, JSON.stringify({ theme: 'light', injected: true }));
    expect(new PrefsStore(file).get()).toEqual({ ...DEFAULT_PREFS, theme: 'light' });
    writeFileSync(file, JSON.stringify({ theme: 'neon' }));
    expect(new PrefsStore(file).get()).toEqual(DEFAULT_PREFS);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'neon' });
  });
});

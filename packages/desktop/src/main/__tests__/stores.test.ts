import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonFile, writeJsonFile } from '../jsonFile';
import { DEFAULT_PREFS, PrefsStore, validPref } from '../prefs';
import { MAX_RECENTS, RecentsStore } from '../recents';

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
    const store = new RecentsStore(join(dir, 'recents.json'), (path) => path !== '/gone', at('2026-11-03T00:00:00.000Z'));
    store.touch('/gone');
    store.touch('/Users/me/repo');
    expect(store.list()).toEqual([
      { path: '/Users/me/repo', name: 'repo', openedAt: '2026-11-03T00:00:00.000Z', missing: false },
      { path: '/gone', name: 'gone', openedAt: '2026-11-03T00:00:00.000Z', missing: true },
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

  it('skips malformed entries and starts afresh from a damaged file', () => {
    const file = join(dir, 'recents.json');
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ path: '/ok', openedAt: 'x' }, { path: 3 }, null, { path: '', openedAt: 'x' }] }));
    expect(new RecentsStore(file, () => true).list().map((r) => r.path)).toEqual(['/ok']);
    writeFileSync(file, 'garbage');
    expect(new RecentsStore(file, () => true).list()).toEqual([]);
  });
});

describe('prefs', () => {
  it('accepts only a known theme', () => {
    expect(validPref('theme', 'dark')).toEqual({ theme: 'dark' });
    expect(validPref('theme', 'neon')).toBeUndefined();
    expect(validPref('workspace', '/etc')).toBeUndefined();
    expect(validPref('__proto__', 'dark')).toBeUndefined();
  });

  it('reads defaults, keeps a set value and drops unknown keys from the file', () => {
    const file = join(dir, 'prefs.json');
    const store = new PrefsStore(file);
    expect(store.get()).toEqual(DEFAULT_PREFS);
    expect(store.set({ theme: 'light' })).toEqual({ theme: 'light' });
    writeFileSync(file, JSON.stringify({ theme: 'light', injected: true }));
    expect(new PrefsStore(file).get()).toEqual({ theme: 'light' });
    writeFileSync(file, JSON.stringify({ theme: 'neon' }));
    expect(new PrefsStore(file).get()).toEqual(DEFAULT_PREFS);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'neon' });
  });
});

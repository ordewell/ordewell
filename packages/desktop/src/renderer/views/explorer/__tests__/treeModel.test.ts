import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../../../files/api';
import { flatten, parentOf, sortEntries, windowOf, type DirState } from '../treeModel';

const file = (path: string): TreeEntry => ({ name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'file', ignored: false });
const dir = (path: string): TreeEntry => ({ name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'directory', ignored: false });

describe('sortEntries', () => {
  it('lists folders first and numbers in order, whatever order the daemon sent', () => {
    const sorted = sortEntries([file('b10.ts'), file('b9.ts'), dir('src'), file('a.ts'), dir('docs')]);
    expect(sorted.map((e) => e.name)).toEqual(['docs', 'src', 'a.ts', 'b9.ts', 'b10.ts']);
  });

  it('lists a repository among the folders, as the workspace folder\'s view shows it', () => {
    const repo: TreeEntry = { name: 'api', path: 'api', kind: 'repository', ignored: false };
    expect(sortEntries([file('notes.md'), dir('web'), repo, dir('docs')]).map((e) => e.name)).toEqual(['api', 'docs', 'web', 'notes.md']);
  });
});

describe('flatten', () => {
  const dirs = new Map<string, DirState>([
    ['', { entries: sortEntries([dir('src'), file('README.md'), dir('docs')]), loading: false }],
    ['src', { entries: [file('src/a.ts')], loading: false }],
  ]);

  it('draws a folder\'s children only while it is open', () => {
    expect(flatten(dirs, new Set()).map((r) => r.type === 'entry' && r.entry.path)).toEqual(['docs', 'src', 'README.md']);
    const open = flatten(dirs, new Set(['src']));
    expect(open.map((r) => r.type === 'entry' && `${r.depth}:${r.entry.path}`)).toEqual(['0:docs', '0:src', '1:src/a.ts', '0:README.md']);
  });

  it('notes a folder that is loading, failed or empty, in its place', () => {
    const states = new Map<string, DirState>([
      ['', { entries: [dir('a'), dir('b'), dir('c')], loading: false }],
      ['b', { loading: false, error: 'It went wrong.' }],
      ['c', { entries: [], loading: false }],
    ]);
    const rows = flatten(states, new Set(['a', 'b', 'c']));
    expect(rows.filter((r) => r.type === 'note').map((r) => r.type === 'note' && [r.tone, r.text])).toEqual([
      ['loading', 'Loading…'], ['error', 'It went wrong.'], ['empty', 'Empty'],
    ]);
  });

  it('keeps the entries of a folder that is being read again', () => {
    const rows = flatten(new Map([['', { entries: [file('a.ts')], loading: true }]]), new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'entry' });
  });

  it('never opens a file or a repository', () => {
    const odd: TreeEntry = { name: 'sub', path: 'sub', kind: 'repository', ignored: false };
    const rows = flatten(new Map([['', { entries: [odd], loading: false }]]), new Set(['sub']));
    expect(rows).toEqual([{ type: 'entry', entry: odd, depth: 0, expanded: false }]);
  });
});

describe('windowOf', () => {
  it('draws the rows in view and a margin around them', () => {
    expect(windowOf(1000, 240, 480, 24, 2)).toEqual({ start: 8, end: 32 });
  });

  it('stays inside the list', () => {
    expect(windowOf(5, 0, 480, 24)).toEqual({ start: 0, end: 5 });
    expect(windowOf(0, 0, 480, 24)).toEqual({ start: 0, end: 0 });
  });
});

describe('parentOf', () => {
  it('names the folder above a path, and the root for a top-level one', () => {
    expect(parentOf('src/a/b.ts')).toBe('src/a');
    expect(parentOf('b.ts')).toBe('');
  });
});

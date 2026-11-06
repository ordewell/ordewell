import { describe, expect, it } from 'vitest';
import { describeError, FilesError, parseContent, parseFind, parseRepos, parseTree } from '../api';

describe('the daemon answers, read defensively', () => {
  it('reads a tree, dropping a status it does not know', () => {
    const entries = parseTree({ entries: [
      { name: 'a.ts', path: 'src/a.ts', kind: 'file', ignored: false, status: 'M', taskId: 't1' },
      { name: 'b.ts', path: 'src/b.ts', kind: 'file', status: 'X' },
    ] });
    expect(entries).toEqual([
      { name: 'a.ts', path: 'src/a.ts', kind: 'file', ignored: false, status: 'M', taskId: 't1' },
      { name: 'b.ts', path: 'src/b.ts', kind: 'file', ignored: false },
    ]);
  });

  it('refuses an answer of another shape', () => {
    expect(parseTree({ entries: [{ name: 'a' }] })).toBeUndefined();
    expect(parseTree(null)).toBeUndefined();
    expect(parseContent({ kind: 'text', text: 'x', size: 1 })).toBeUndefined();
    expect(parseContent({ kind: 'too-large', size: 9 })).toBeUndefined();
    expect(parseFind({ matches: [{ line: 3 }] })).toBeUndefined();
    expect(parseRepos({ repos: [{ branch: 'main' }] })).toBeUndefined();
  });

  it('reads the three kinds of content', () => {
    expect(parseContent({ kind: 'text', text: 'hi', hash: 'h', size: 2 })).toEqual({ kind: 'text', text: 'hi', hash: 'h', size: 2 });
    expect(parseContent({ kind: 'binary', size: 5 })).toEqual({ kind: 'binary', size: 5 });
    expect(parseContent({ kind: 'too-large', size: 9, limit: 4 })).toEqual({ kind: 'too-large', size: 9, limit: 4 });
  });

  it('reads matches and repos', () => {
    expect(parseFind({ matches: [{ path: 'a.ts', line: 3, preview: 'x' }, { path: 'b.ts' }], truncated: true })).toEqual({
      matches: [{ path: 'a.ts', line: 3, preview: 'x' }, { path: 'b.ts' }],
      truncated: true,
    });
    expect(parseRepos({ repos: [{ repo: '.', branch: 'main' }, { repo: 'lib', detached: true }] })).toEqual([
      { repo: '.', branch: 'main', detached: false },
      { repo: 'lib', branch: null, detached: true },
    ]);
  });
});

describe('describeError', () => {
  it('words each code the daemon names, and passes anything else through', () => {
    expect(describeError(new FilesError('The worktree is gone.', 'gone'))).toBe('The worktree is gone. Showing your checkout instead.');
    expect(describeError(new FilesError('x', 'stale'))).toMatch(/changed on disk/);
    expect(describeError(new FilesError('x', 'path_refused'))).toMatch(/does not show/);
    expect(describeError(new FilesError('x', 'path_not_found'))).toMatch(/not in this scope/);
    expect(describeError(new FilesError('x', 'not_checkout'))).toMatch(/Only your checkout/);
    expect(describeError(new FilesError('Odd.', 'unreadable'))).toBe('Odd.');
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('text')).toBe('text');
  });
});

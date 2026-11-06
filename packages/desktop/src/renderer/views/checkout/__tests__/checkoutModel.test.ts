import { describe, expect, it } from 'vitest';
import { INITIAL_HOST_STATE } from '@ordewell/ui';
import { canAmend, changedPaths, hunkAfterLine, liveLandingBranch, parseCheckoutStatus, parseRepoInfo, pathsToStage, sliceHunk } from '../checkoutModel';
import { checkoutDiffTabId, parseCheckoutDiffTabId } from '../checkoutTabs';
import { parsePatch } from '../../changes/changesModel';
import { HANDOFF, runView } from '../../changes/__tests__/fixtures';

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -20,2 +20,2 @@',
  ' twenty',
  '-old',
  '+new',
  '',
].join('\n');

describe('the checkout model', () => {
  it('reads git\'s four status lists, with `?` for untracked and `U` for conflicts', () => {
    expect(parseCheckoutStatus({
      staged: [{ path: 'a.ts', status: 'A' }],
      unstaged: [{ path: 'b.ts', status: 'D' }],
      untracked: ['notes.txt'],
      conflicted: ['routes.ts'],
    })).toEqual({
      staged: [{ path: 'a.ts', status: 'A' }],
      changes: [{ path: 'b.ts', status: 'D' }, { path: 'notes.txt', status: '?' }],
      conflicted: [{ path: 'routes.ts', status: 'U' }],
    });
    expect(parseCheckoutStatus({ staged: [] })).toBeUndefined();
  });

  it('reads the branch, upstream and head each action reasons about', () => {
    expect(parseRepoInfo({ repos: [{ repo: '.', branch: 'main', detached: false, head: 'abc', upstream: 'origin/main', ahead: 2, behind: 1 }] }))
      .toEqual([{ repo: '.', branch: 'main', detached: false, head: 'abc', upstream: 'origin/main', ahead: 2, behind: 1 }]);
    expect(parseRepoInfo({ repos: [{ branch: 'main' }] })).toBeUndefined();
  });

  it('offers amend only while the last commit is on no remote', () => {
    expect(canAmend({ repo: '.', branch: 'main', detached: false, head: 'a', upstream: null, ahead: 0, behind: 0 })).toBe(true);
    expect(canAmend({ repo: '.', branch: 'main', detached: false, head: 'a', upstream: 'origin/main', ahead: 2, behind: 0 })).toBe(true);
    expect(canAmend({ repo: '.', branch: 'main', detached: false, head: 'a', upstream: 'origin/main', ahead: 0, behind: 0 })).toBe(false);
    expect(canAmend({ repo: '.', branch: null, detached: true, head: null, upstream: null, ahead: 0, behind: 0 })).toBe(false);
  });

  it('names every path Stage all and Discard all act on', () => {
    const status = parseCheckoutStatus({
      staged: [{ path: 'a.ts', status: 'M' }],
      unstaged: [{ path: 'b.ts', status: 'M' }],
      untracked: ['notes.txt'],
      conflicted: ['routes.ts'],
    })!;
    expect(pathsToStage(status)).toEqual(['b.ts', 'notes.txt', 'routes.ts']);
    expect(changedPaths(status)).toEqual(['a.ts', 'b.ts', 'notes.txt', 'routes.ts']);
  });

  it('cuts one hunk with the file header, so stage takes exactly what was shown', () => {
    const first = sliceHunk(PATCH, 0)!;
    expect(first.startsWith('diff --git a/src/app.ts b/src/app.ts\n')).toBe(true);
    expect(first).toContain('@@ -1,3 +1,3 @@');
    expect(first).not.toContain('@@ -20,2 +20,2 @@');
    expect(parsePatch(first).hunks).toHaveLength(1);

    const second = sliceHunk(PATCH, 1)!;
    expect(second).toContain('@@ -20,2 +20,2 @@');
    expect(second).not.toContain('@@ -1,3 +1,3 @@');
    expect(sliceHunk(PATCH, 2)).toBeUndefined();
  });

  it('puts a hunk\'s action under its last drawn line, and falls back to the change region when only hunks are drawn', () => {
    const patch = parsePatch(PATCH);
    const full = { lines: { modified: Array.from({ length: 30 }, (_, i) => i + 1) } };
    expect(hunkAfterLine(full, patch.hunks[0]!)).toBe(3);
    expect(hunkAfterLine(full, patch.hunks[1]!)).toBe(21);

    const partial = { lines: { modified: [1, 2, 3, 0, 20, 21] } };
    expect(hunkAfterLine(partial, patch.hunks[1]!)).toBe(6);
  });

  it('gives the staged and working diffs of one file distinct tab ids in the checkout scope', () => {
    expect(parseCheckoutDiffTabId(checkoutDiffTabId('.', 'src/app.ts', 'unstaged'))).toEqual({ repo: '.', path: 'src/app.ts', kind: 'unstaged' });
    expect(parseCheckoutDiffTabId(checkoutDiffTabId('web', 'routes.ts', 'staged'))).toEqual({ repo: 'web', path: 'routes.ts', kind: 'staged' });
    expect(parseCheckoutDiffTabId('other:src/app.ts')).toBeUndefined();
  });

  it('notes the landing branch only while the run is live and is the branch checked out', () => {
    const live = { ...INITIAL_HOST_STATE, isExecuting: true, run: runView([], HANDOFF) };
    expect(liveLandingBranch(live, '.', 'main')).toBe('main');
    expect(liveLandingBranch(live, '.', 'feature')).toBeUndefined();
    expect(liveLandingBranch({ ...live, isExecuting: false }, '.', 'main')).toBeUndefined();
  });
});

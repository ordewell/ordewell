import { describe, expect, it } from 'vitest';
import {
  changeLetter, commentMessage, conflictRows, diffSides, isFinished, matchesFilter, parsePatch, parseTaskDiffList,
  reviewableTasks, taskFilePatch,
} from '../changesModel';
import { runTask, runView, worktree } from './fixtures';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '',
].join('\n');

describe('the task diff list', () => {
  it('reads each file with its counts, a binary change without any', () => {
    const list = parseTaskDiffList('[repo .] src/a.ts: +3 -1\n[repo web] logo.png: binary change\n');
    expect(list.files).toEqual([
      { repo: '.', path: 'src/a.ts', added: 3, removed: 1 },
      { repo: 'web', path: 'logo.png', added: null, removed: null },
    ]);
    expect(list.savedPatch).toBeUndefined();
  });

  it('notes a list read from a saved patch, whose worktree is gone', () => {
    const list = parseTaskDiffList('The patch attempt 2 saved, against commit abc123; its worktree is gone.\n[repo .] a.ts: +1 -0');
    expect(list.savedPatch).toMatch(/^The patch attempt 2 saved/);
    expect(list.files).toHaveLength(1);
  });

  it('drops the path form\'s heading line before the patch', () => {
    expect(taskFilePatch(`[repo .] src/a.ts: +1 -1\n${PATCH}`)).toBe(PATCH);
    expect(taskFilePatch(PATCH)).toBe(PATCH);
  });

  it('names git\'s status letters as the sidebar shows them', () => {
    expect([changeLetter('A'), changeLetter('D'), changeLetter('M'), changeLetter('R100'), changeLetter(undefined)]).toEqual(['A', 'D', 'M', 'M', undefined]);
  });
});

describe('a file\'s two sides', () => {
  it('undoes the patch on the file as it is now, the whole file on each side', () => {
    const sides = diffSides(parsePatch(PATCH), 'one\nTWO\nthree\n');
    expect(sides).toEqual({
      original: 'one\ntwo\nthree\n',
      modified: 'one\nTWO\nthree\n',
      lines: { original: [1, 2, 3], modified: [1, 2, 3] },
      partial: false,
    });
  });

  it('draws the hunks alone when the file moved on, a shared separator between them', () => {
    const later = PATCH.replace('@@ -1,3 +1,3 @@', '@@ -10,3 +10,3 @@');
    const sides = diffSides(parsePatch(later), 'something else entirely\n');
    expect(sides.partial).toBe(true);
    expect(sides.original.split('\n')[0]).toBe(sides.modified.split('\n')[0]);
    expect(sides.lines.modified).toEqual([0, 10, 11, 12]);
    expect(sides.lines.original).toEqual([0, 10, 11, 12]);
  });

  it('knows a new, a deleted and a binary file', () => {
    expect(parsePatch('new file mode 100644\n@@ -0,0 +1 @@\n+hi\n').added).toBe(true);
    expect(parsePatch('deleted file mode 100644\n@@ -1 +0,0 @@\n-hi\n').deleted).toBe(true);
    expect(parsePatch('Binary files a/x.png and b/x.png differ\n').binary).toBe(true);
  });
});

describe('the sidebar\'s groups', () => {
  const run = runView([
    runTask({ id: 't1', order: 1, title: 'Add the login button', status: 'completed', isolation: worktree('integrated') }),
    runTask({ id: 't2', order: 2, title: 'Read the docs', status: 'completed', isolation: { state: 'none' } }),
    runTask({ id: 't3', order: 3, title: 'Wire SSO', status: 'in_progress', isolation: worktree('active') }),
    runTask({ id: 't4', order: 4, title: 'Fix routes', status: 'failed', isolation: worktree('conflict', { conflictRepo: 'web', conflictFiles: ['routes.ts'] }) }),
    runTask({ id: 't5', order: 5, title: 'Fix tests', status: 'failed', isolation: worktree('conflict', { resolver: 't6' }) }),
  ]);

  it('group files under every task the run gave a worktree, in plan order', () => {
    expect(reviewableTasks(run).map(({ task, label }) => `${label} ${task.id}`)).toEqual(['1 t1', '3 t3', '4 t4', '5 t5']);
  });

  it('put each conflict at the top, a repair under way as progress', () => {
    expect(conflictRows(run)).toEqual([
      { taskId: 't4', label: '4', title: 'Fix routes', repo: 'web', files: ['routes.ts'], repairing: false },
      { taskId: 't5', label: '5', title: 'Fix tests', repo: '.', files: [], repairing: true },
    ]);
  });

  it('filter on path or task title, blind to case', () => {
    expect(matchesFilter('', 'anything')).toBe(true);
    expect(matchesFilter('LOGIN', 'src/login.tsx')).toBe(true);
    expect(matchesFilter('sso', 'src/a.ts', 'Wire SSO')).toBe(true);
    expect(matchesFilter('nope', 'src/a.ts', 'Wire SSO')).toBe(false);
  });

  it('call a task finished when it reads no more messages', () => {
    expect(['completed', 'failed', 'skipped', 'in_progress', 'pending'].map((status) => isFinished({ status }))).toEqual([true, true, true, false, false]);
  });
});

describe('a line comment', () => {
  it('quotes the file, the lines and the code it is about', () => {
    const text = commentMessage(
      { repo: 'web', path: 'src/Login.tsx', side: 'modified', startLine: 13, endLine: 14, quote: 'return <SsoButton\n  provider="okta" />', body: ' Use the provider from config. ' },
      'your change',
    );
    expect(text).toBe('On web/src/Login.tsx, lines 13–14 of your change:\n> return <SsoButton\n>   provider="okta" />\n\nUse the provider from config.');
  });

  it('says when it is about the line before the change', () => {
    expect(commentMessage({ repo: '.', path: 'a.ts', side: 'original', startLine: 2, endLine: 2, quote: 'two', body: 'Why drop this?' }, 'task #3\'s change'))
      .toBe('On a.ts, line 2 (before your change) of task #3\'s change:\n> two\n\nWhy drop this?');
  });
});

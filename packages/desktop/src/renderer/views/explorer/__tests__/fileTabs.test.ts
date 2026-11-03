import { describe, expect, it } from 'vitest';
import { clearDraft, DIRTY_MARK, hasDraft, setDraft, stripDirtyMark, withDirtyMark } from '../drafts';
import { fileTabId, fileTabTitle, parseFileTabId, scopeTag } from '../fileTabs';

describe('a file tab\'s id', () => {
  it('is the path in the workspace\'s own repo, and carries the repo in another', () => {
    expect(fileTabId('.', 'src/a.ts')).toBe('src/a.ts');
    expect(fileTabId('api', 'src/a.ts')).toBe('api//src/a.ts');
  });

  it('reads back to the repo and path it was made from', () => {
    for (const [repo, path] of [['.', 'src/a.ts'], ['api', 'src/a.ts'], ['a/b', 'c.ts']] as const) {
      expect(parseFileTabId(fileTabId(repo, path))).toEqual({ repo, path });
    }
  });
});

describe('a file tab\'s title', () => {
  it('names the scope after the file, except for the checkout', () => {
    const session = { sessionId: 's1', integration: [], tasks: [{ id: 't3', order: 3, title: 'x', state: 'running' as const, repos: [] }] };
    expect(fileTabTitle('src/a.ts', { kind: 'checkout' }, session)).toBe('a.ts');
    expect(fileTabTitle('src/a.ts', { kind: 'integration', sessionId: 's1' }, session)).toBe('a.ts (Integration)');
    expect(fileTabTitle('src/a.ts', { kind: 'task', sessionId: 's1', taskId: 't3' }, session)).toBe('a.ts (Task #3)');
    expect(scopeTag({ kind: 'task', sessionId: 's1', taskId: 'gone' }, session)).toBe('Task');
  });
});

describe('drafts', () => {
  it('keep unsaved text until it is cleared', () => {
    expect(hasDraft('k')).toBe(false);
    setDraft('k', { text: 'x', baseHash: 'h' });
    expect(hasDraft('k')).toBe(true);
    clearDraft('k');
    expect(hasDraft('k')).toBe(false);
  });

  it('mark a title once, and unmark it', () => {
    expect(withDirtyMark('a.ts', true)).toBe(`${DIRTY_MARK}a.ts`);
    expect(withDirtyMark(`${DIRTY_MARK}a.ts`, true)).toBe(`${DIRTY_MARK}a.ts`);
    expect(withDirtyMark(`${DIRTY_MARK}a.ts`, false)).toBe('a.ts');
    expect(stripDirtyMark('a.ts')).toBe('a.ts');
  });
});

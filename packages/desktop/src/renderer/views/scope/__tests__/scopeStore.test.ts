import { describe, expect, it } from 'vitest';
import { deriveSession, optionsFor, sameScope, scopeName, taskTouches, type ScopeState } from '../scopeStore';

const RUN = {
  run: {
    tasks: [
      { id: 't1', order: 1, title: 'Parser', isolation: { state: 'integrated', branch: 'b1', worktree: 'w1', repos: ['.'] } },
      {
        id: 't2', order: 2, title: 'Server', isolation: { state: 'active', branch: 'b2', worktree: 'w2', repos: ['api'] },
        subtasks: [{ id: 't2.1', order: 3, title: 'Route', isolation: { state: 'conflict', branch: 'b3', worktree: 'w3', repos: [] } }],
      },
      { id: 't4', order: 4, title: 'Docs', isolation: { state: 'none' } },
    ],
    handoff: { repos: [{ path: 'api', integrationBranch: 'ordewell/s1-api', landed: [] }], landed: [] },
  },
};

describe('deriveSession', () => {
  it('offers a worktree for each task that has one, subtasks included, and the integration branch of each repo', () => {
    const session = deriveSession('s1', RUN);
    expect(session.tasks.map((t) => [t.id, t.order, t.state, t.repos])).toEqual([
      ['t1', 1, 'landed', ['.']], ['t2', 2, 'running', ['api']], ['t2.1', 3, 'conflict', []],
    ]);
    expect(session.integration).toEqual([{ repo: 'api', branch: 'ordewell/s1-api' }]);
  });

  it('offers nothing for a session that has not run, or an answer of another shape', () => {
    for (const data of [{}, null, { run: { tasks: 'no' } }, 'x']) {
      expect(deriveSession('s1', data)).toEqual({ sessionId: 's1', integration: [], tasks: [] });
    }
  });
});

describe('taskTouches', () => {
  const task = (repos: string[]) => ({ id: 't', order: 1, title: 't', state: 'running' as const, repos });
  it('matches a task to the repos it changed', () => {
    expect(taskTouches(task(['api']), 'api', 2)).toBe(true);
    expect(taskTouches(task(['/work/api']), 'api', 2)).toBe(true);
    expect(taskTouches(task(['api']), 'web', 2)).toBe(false);
  });
  it('gives a task that names no repo to a single-repo workspace only', () => {
    expect(taskTouches(task([]), '.', 1)).toBe(true);
    expect(taskTouches(task([]), 'api', 2)).toBe(false);
    expect(taskTouches(task(['x']), '.', 1)).toBe(true);
  });
});

describe('optionsFor', () => {
  const base: ScopeState = {
    repos: [{ repo: 'api', branch: 'main', detached: false }, { repo: 'web', branch: null, detached: false }],
    repo: 'api', scopes: {}, notice: undefined, session: deriveSession('s1', RUN),
  };

  it('lists the checkout first, with its branch', () => {
    expect(optionsFor({ ...base, session: undefined }, 'api')).toEqual([{ scope: { kind: 'checkout' }, label: 'Your checkout', detail: 'main' }]);
  });

  it('adds the integration branch and the tasks of that repo', () => {
    const labels = optionsFor(base, 'api').map((o) => [o.label, o.detail]);
    expect(labels).toEqual([
      ['Your checkout', 'main'], ['Integration branch', 'ordewell/s1-api'], ['Task #2 worktree', 'Server'],
    ]);
  });

  it('offers a repo only what touched it', () => {
    expect(optionsFor(base, 'web').map((o) => o.label)).toEqual(['Your checkout']);
  });
});

describe('scopes', () => {
  it('compare by kind, session and task', () => {
    expect(sameScope({ kind: 'checkout' }, { kind: 'checkout' })).toBe(true);
    expect(sameScope({ kind: 'integration', sessionId: 'a' }, { kind: 'integration', sessionId: 'a' })).toBe(true);
    expect(sameScope({ kind: 'integration', sessionId: 'a' }, { kind: 'integration', sessionId: 'b' })).toBe(false);
    expect(sameScope({ kind: 'task', sessionId: 'a', taskId: '1' }, { kind: 'task', sessionId: 'a', taskId: '2' })).toBe(false);
    expect(sameScope({ kind: 'task', sessionId: 'a', taskId: '1' }, { kind: 'integration', sessionId: 'a' })).toBe(false);
  });

  it('are named for the title bar and the sidebar', () => {
    const session = deriveSession('s1', RUN);
    expect(scopeName({ kind: 'checkout' }, session)).toBe('Your checkout');
    expect(scopeName({ kind: 'integration', sessionId: 's1' }, session)).toBe('Integration branch');
    expect(scopeName({ kind: 'task', sessionId: 's1', taskId: 't1' }, session)).toBe('Task #1');
    expect(scopeName({ kind: 'task', sessionId: 's1', taskId: 'zz' }, session)).toBe('Task worktree');
  });
});

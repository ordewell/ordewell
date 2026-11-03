import { describe, expect, it } from 'vitest';
import { taskOf, terminalLabel, terminalScopeDecision } from '../terminalScope';

const task = (state: string, order = 3) => ({ order, state });

describe('terminalScopeDecision (design: Terminal rule, ADR-0062 G11)', () => {
  it('always opens in the user\'s checkout', () => {
    expect(terminalScopeDecision({ kind: 'checkout' }, undefined)).toEqual({ ok: true });
  });

  it('refuses the integration branch, which has no worktree', () => {
    const decision = terminalScopeDecision({ kind: 'integration', sessionId: 's' }, undefined);
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toMatch(/no worktree/);
  });

  it('refuses a task worktree while the task, or its repair, is running, and says which task', () => {
    for (const state of ['running', 'repairing']) {
      const decision = terminalScopeDecision({ kind: 'task', sessionId: 's', taskId: 't' }, task(state));
      expect(decision.ok).toBe(false);
      expect(!decision.ok && decision.reason).toContain('Task #3 is running');
    }
  });

  it('opens in a task worktree once the task has stopped, whatever it ended as', () => {
    for (const state of ['landed', 'conflict', 'kept']) {
      expect(terminalScopeDecision({ kind: 'task', sessionId: 's', taskId: 't' }, task(state))).toEqual({ ok: true });
    }
  });

  it('refuses a task it cannot find', () => {
    const decision = terminalScopeDecision({ kind: 'task', sessionId: 's', taskId: 't' }, undefined);
    expect(!decision.ok && decision.reason).toMatch(/no worktree/);
  });
});

describe('terminalLabel', () => {
  it('names the scope, and the repo only when the workspace has several', () => {
    expect(terminalLabel({ kind: 'checkout' }, undefined, '.', 1)).toBe('Your checkout');
    expect(terminalLabel({ kind: 'checkout' }, undefined, 'api', 2)).toBe('Your checkout · api');
    expect(terminalLabel({ kind: 'task', sessionId: 's', taskId: 't' }, { order: 4 }, '.', 1)).toBe('Task #4 worktree');
    expect(terminalLabel({ kind: 'task', sessionId: 's', taskId: 't' }, { order: 4 }, 'web', 2)).toBe('Task #4 worktree · web');
  });
});

describe('taskOf', () => {
  const session = {
    run: {
      tasks: [
        { id: 'a', order: 1, isolation: { state: 'integrated' } },
        { id: 'b', order: 2, isolation: { state: 'active' }, subtasks: [{ id: 'c', order: 3, isolation: { state: 'conflict' } }] },
        { id: 'd', order: 4 },
      ],
    },
  };

  it('reads a task\'s state from the saved isolation, subtasks included', () => {
    expect(taskOf(session, 'a')).toEqual({ order: 1, state: 'landed' });
    expect(taskOf(session, 'b')).toEqual({ order: 2, state: 'running' });
    expect(taskOf(session, 'c')).toEqual({ order: 3, state: 'conflict' });
  });

  it('finds nothing for a task without isolation, an unknown task, or an answer of another shape', () => {
    expect(taskOf(session, 'd')).toBeUndefined();
    expect(taskOf(session, 'zzz')).toBeUndefined();
    expect(taskOf(null, 'a')).toBeUndefined();
    expect(taskOf({ run: { tasks: 'no' } }, 'a')).toBeUndefined();
  });
});

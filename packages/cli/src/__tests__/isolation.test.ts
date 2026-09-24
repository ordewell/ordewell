import { describe, it, expect } from 'vitest';
import { isolationOfPlan } from '../isolation';

const record = (taskId: string, order: number, status: string) => ({
  taskId, order, title: `Task ${taskId}`, branch: `ordewell/r1/${order}-${taskId}`, worktree: `/ws/.ordewell/worktrees/r1/${order}-${taskId}`, status, linked: [],
});

const plan = {
  tasks: [],
  isolation: {
    resolvers: {},
    run: {
      id: 'r1', workspaceRoot: '/ws', baseRef: 'abc123', integrationBranch: 'ordewell/r1/integration',
      tasks: {
        b: record('b', 2, 'merged'),
        a: record('a', 1, 'merged'),
        c: record('c', 3, 'conflict'),
        d: record('d', 4, 'failed'),
        e: record('e', 5, 'active'),
      },
    },
  },
};

describe('isolationOfPlan', () => {
  it('lists what landed in plan order, not record order', () => {
    expect(isolationOfPlan(plan)!.handoff).toEqual({
      branch: 'ordewell/r1/integration',
      baseRef: 'abc123',
      landed: [{ taskId: 'a', order: 1, title: 'Task a' }, { taskId: 'b', order: 2, title: 'Task b' }],
    });
  });

  it('names each task\'s state the way a surface shows it', () => {
    const { tasks } = isolationOfPlan(plan)!;
    expect(Object.fromEntries(Object.entries(tasks).map(([id, t]) => [id, t.state]))).toEqual({
      a: 'integrated', b: 'integrated', c: 'conflict', d: 'kept', e: 'active',
    });
    expect(tasks.c.branch).toBe('ordewell/r1/3-c');
  });

  it.each([null, undefined, {}, { tasks: [] }, { isolation: {} }, 'nope'])('says nothing for %j', (payload) => {
    expect(isolationOfPlan(payload)).toBeNull();
  });
});

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
    const landed = [{ taskId: 'a', order: 1, title: 'Task a' }, { taskId: 'b', order: 2, title: 'Task b' }];
    expect(isolationOfPlan(plan)!.handoff).toEqual({
      repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abc123', landed }],
      landed,
    });
  });

  it('names each task\'s state the way a surface shows it', () => {
    const { tasks } = isolationOfPlan(plan)!;
    expect(Object.fromEntries(Object.entries(tasks).map(([id, t]) => [id, t.state]))).toEqual({
      a: 'integrated', b: 'integrated', c: 'conflict', d: 'kept', e: 'active',
    });
    expect(tasks.c.branch).toBe('ordewell/r1/3-c');
  });

  it('reads a repo-group record as it reads the ADR-0013 one, for a group of one', () => {
    const groupRecord = (taskId: string, order: number, status: string) => ({
      taskId, order, title: `Task ${taskId}`, branch: `ordewell/r1/${order}-${taskId}`, workspace: `/ws/.ordewell/worktrees/r1/${order}-${taskId}`, status,
      repos: { '.': { worktree: `/ws/.ordewell/worktrees/r1/${order}-${taskId}`, linked: [], ...(status === 'merged' ? { changed: true } : {}) } },
      ...(status === 'conflict' ? { conflictRepo: '.' } : {}),
    });
    const groupPlan = {
      tasks: [],
      isolation: {
        resolvers: {},
        run: {
          id: 'r1', workspaceRoot: '/ws', shared: [],
          repos: [{ path: '.', root: '/ws', baseRef: 'abc123', integrationBranch: 'ordewell/r1/integration' }],
          tasks: {
            b: groupRecord('b', 2, 'merged'),
            a: groupRecord('a', 1, 'merged'),
            c: groupRecord('c', 3, 'conflict'),
            d: groupRecord('d', 4, 'failed'),
            e: groupRecord('e', 5, 'active'),
          },
        },
      },
    };

    expect(isolationOfPlan(groupPlan)).toEqual(isolationOfPlan(plan));
    expect(isolationOfPlan(groupPlan)!.tasks.c).toEqual({
      state: 'conflict', branch: 'ordewell/r1/3-c', worktree: '/ws/.ordewell/worktrees/r1/3-c', repos: [], conflictRepo: '.',
    });
  });

  it.each([null, undefined, {}, { tasks: [] }, { isolation: {} }, 'nope'])('says nothing for %j', (payload) => {
    expect(isolationOfPlan(payload)).toBeNull();
  });
});

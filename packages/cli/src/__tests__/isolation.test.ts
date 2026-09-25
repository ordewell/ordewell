import { describe, it, expect } from 'vitest';
import { isolationOfPlan, isRepoGroup, mergeOutcome, repoResultLines, taskRepoNames } from '../isolation';
import type { HandoffView } from '../tui/state';

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

const t = (order: number) => ({ taskId: `t${order}`, order, title: `Task ${order}` });
const group: HandoffView = {
  repos: [
    { path: 'api', integrationBranch: 'ordewell/r1/integration', baseRef: 'aaa', landed: [t(1), t(2), t(3)] },
    { path: 'web', integrationBranch: 'ordewell/r1/integration', baseRef: 'bbb', landed: [t(3)] },
    { path: 'infra', integrationBranch: 'ordewell/r1/integration', baseRef: 'ccc', landed: [] },
  ],
  landed: [t(1), t(2), t(3)],
};
const single: HandoffView = {
  repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'aaa', landed: [t(1)] }],
  landed: [t(1)],
};

describe('a repo group in a handoff', () => {
  it('is any handoff but a lone repo at the workspace root', () => {
    expect(isRepoGroup(group)).toBe(true);
    expect(isRepoGroup({ ...group, repos: [group.repos[0]] })).toBe(true);
    expect(isRepoGroup(single)).toBe(false);
  });

  it('says per repo what landed, or that there is nothing to merge', () => {
    expect(repoResultLines(group)).toEqual(['api: 3 tasks landed', 'web: 1 task landed', 'infra: nothing to merge']);
  });

  it('names the repos of a task, and none for a group of one', () => {
    expect(taskRepoNames({ state: 'integrated', repos: ['api', 'web'] })).toEqual(['api', 'web']);
    expect(taskRepoNames({ state: 'integrated', repos: ['.'] })).toEqual([]);
    expect(taskRepoNames({ state: 'active' })).toEqual([]);
  });
});

describe('what Merge all says', () => {
  const branch = 'ordewell/r1/integration';

  it('words a group of one as before', () => {
    expect(mergeOutcome({ outcome: 'merged' }, branch, false)).toEqual({ ok: true, message: `Merged ${branch} into your checked-out branch.` });
    expect(mergeOutcome({ outcome: 'conflict', repo: '.', files: ['a.txt'] }, branch, false)).toEqual({
      ok: false,
      message: `Merging ${branch} conflicted, so it was aborted — your tree is as it was. Merge it with git and resolve the conflict there.`,
    });
    expect(mergeOutcome({ outcome: 'failed', repo: '.' }, branch, false)).toEqual({
      ok: false,
      message: `Could not merge ${branch} — finish or abort the merge already in progress, then try again.`,
    });
  });

  it('says a group merged into every repository', () => {
    expect(mergeOutcome({ outcome: 'merged' }, branch, true)).toEqual({ ok: true, message: `Merged ${branch} into the checked-out branch of every repository.` });
  });

  it('names each repo that blocked it, why, and its files, and says the branches can be merged by hand', () => {
    const { ok, message } = mergeOutcome({
      outcome: 'blocked',
      blocked: [
        { repo: 'api', reason: 'conflict', files: ['src/a.ts'] },
        { repo: 'web', reason: 'uncommitted-changes', files: ['index.html'] },
      ],
    }, branch, true);

    expect(ok).toBe(false);
    expect(message).toContain('api would conflict in src/a.ts; web has uncommitted changes to index.html');
    expect(message).toContain(`Each repository's ${branch} is a plain branch you can merge by hand.`);
  });

  it('says which repos had landed when git without merge-tree stopped part-way', () => {
    const { message } = mergeOutcome({ outcome: 'conflict', repo: 'web', files: ['w.txt'], landed: ['api'] }, branch, true);

    expect(message).toContain('conflicted in web (w.txt)');
    expect(message).toContain('api was merged already and stays merged.');
  });
});

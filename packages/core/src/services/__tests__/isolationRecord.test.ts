import { describe, it, expect } from 'vitest';
import { handoffOf, isolationViewOfPlan, migratePlanIsolation, taskIsolationOf, taskIsolationsOf, type Adr0013PlanIsolation, type Adr0013TaskRecord } from '../isolationRecord';
import { capConflictFiles } from '../conflictFiles';
import type { IsolationRun, IsolationTaskRecord, IsolationTaskStatus, PlanIsolation } from '../../interfaces/IWorktreeIsolation';

const legacyTask = (taskId: string, order: number, status: IsolationTaskStatus, linked: string[] = []): Adr0013TaskRecord => ({
  taskId, order, title: `Task ${taskId}`, branch: `ordewell/r1/${order}-${taskId}`, worktree: `/work/app/.ordewell/worktrees/r1/${order}-${taskId}`, status, linked,
});

// As 0.4.23 wrote it to `LegacyPlanState.isolation`.
const legacy = (over: Partial<Adr0013PlanIsolation['run']> = {}, resolvers: Record<string, string> = {}): Adr0013PlanIsolation => ({
  run: {
    id: 'r1',
    workspaceRoot: '/work/app',
    baseRef: '0123abcd',
    baseBranch: 'main',
    integrationBranch: 'ordewell/r1/integration',
    tasks: {},
    ...over,
  },
  resolvers,
});

describe('migratePlanIsolation', () => {
  it('turns an ADR-0013 run into a group of one at `.`, keeping its refs', () => {
    expect(migratePlanIsolation(legacy())).toEqual({
      run: {
        id: 'r1',
        workspaceRoot: '/work/app',
        repos: [{ path: '.', root: '/work/app', baseRef: '0123abcd', baseBranch: 'main', integrationBranch: 'ordewell/r1/integration' }],
        shared: [],
        sharedRepos: [],
        tasks: {},
      },
      resolvers: {},
    });
  });

  it('converts a task record in every status', () => {
    const tasks = {
      a: legacyTask('a', 1, 'active', ['node_modules', '.env']),
      k: legacyTask('k', 2, 'kept'),
      c: legacyTask('c', 3, 'conflict'),
      f: legacyTask('f', 4, 'failed'),
      m: legacyTask('m', 5, 'merged'),
    };

    const { run } = migratePlanIsolation(legacy({ tasks }));

    const wt = (name: string) => `/work/app/.ordewell/worktrees/r1/${name}`;
    expect(run.tasks).toEqual({
      a: {
        taskId: 'a', order: 1, title: 'Task a', branch: 'ordewell/r1/1-a', workspace: wt('1-a'), status: 'active',
        repos: { '.': { worktree: wt('1-a'), linked: ['node_modules', '.env'] } },
      },
      k: {
        taskId: 'k', order: 2, title: 'Task k', branch: 'ordewell/r1/2-k', workspace: wt('2-k'), status: 'kept',
        repos: { '.': { worktree: wt('2-k'), linked: [] } },
      },
      c: {
        taskId: 'c', order: 3, title: 'Task c', branch: 'ordewell/r1/3-c', workspace: wt('3-c'), status: 'conflict',
        repos: { '.': { worktree: wt('3-c'), linked: [] } },
        conflictRepo: '.',
      },
      f: {
        taskId: 'f', order: 4, title: 'Task f', branch: 'ordewell/r1/4-f', workspace: wt('4-f'), status: 'failed',
        repos: { '.': { worktree: wt('4-f'), linked: [] } },
      },
      m: {
        taskId: 'm', order: 5, title: 'Task m', branch: 'ordewell/r1/5-m', workspace: wt('5-m'), status: 'merged',
        repos: { '.': { worktree: wt('5-m'), linked: [], changed: true } },
      },
    });
  });

  it('keeps which resolver task resolves which conflict', () => {
    const state = legacy({ tasks: { c: legacyTask('c', 1, 'conflict'), r: legacyTask('r', 2, 'active') } }, { r: 'c' });

    expect(migratePlanIsolation(state).resolvers).toEqual({ r: 'c' });
  });

  it('leaves the base branch out for a run started on a detached HEAD', () => {
    const { run } = migratePlanIsolation(legacy({ baseBranch: undefined }));

    expect(run.repos).toEqual([{ path: '.', root: '/work/app', baseRef: '0123abcd', integrationBranch: 'ordewell/r1/integration' }]);
    expect('baseBranch' in run.repos[0]).toBe(false);
  });

  it('hands off a converted run exactly as the ADR-0013 run would have: its branch, its base, what landed in plan order', () => {
    const tasks = { m2: legacyTask('m2', 2, 'merged'), c: legacyTask('c', 3, 'conflict'), m1: legacyTask('m1', 1, 'merged') };
    const landed = [
      { taskId: 'm1', order: 1, title: 'Task m1' },
      { taskId: 'm2', order: 2, title: 'Task m2' },
    ];

    expect(handoffOf(migratePlanIsolation(legacy({ tasks })).run)).toEqual({
      repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: '0123abcd', baseBranch: 'main', landed }],
      landed,
    });
  });

  it('carries neither a base branch nor a detached marker for a record that never noted its branch', () => {
    const { run } = migratePlanIsolation(legacy({ baseBranch: undefined }));

    expect(handoffOf(run).repos[0]).not.toHaveProperty('baseBranch');
    expect(handoffOf(run).repos[0]).not.toHaveProperty('startedDetached');
  });

  it('leaves a record already in the repo-group shape as it is', () => {
    const current: PlanIsolation = {
      run: {
        id: 'r2',
        workspaceRoot: '/work/app',
        repos: [{ path: '.', root: '/work/app', baseRef: 'feedbeef', integrationBranch: 'ordewell/r2/integration' }],
        shared: [],
        sharedRepos: [],
        tasks: {},
      },
      resolvers: { x: 'y' },
    };

    expect(migratePlanIsolation(structuredClone(current))).toEqual(current);
  });
});

describe('handoffOf', () => {
  it('says a run started on a detached HEAD, so it is told from a record that never noted its branch', () => {
    const run: IsolationRun = {
      id: 'r1', workspaceRoot: '/work/app',
      repos: [{ path: '.', root: '/work/app', baseRef: '0123abcd', startedDetached: true, integrationBranch: 'ordewell/r1/integration' }],
      shared: [], sharedRepos: [], tasks: {},
    };

    expect(handoffOf(run).repos[0]).toMatchObject({ startedDetached: true });
    expect(handoffOf(run).repos[0]).not.toHaveProperty('baseBranch');
  });

  it('names the files a landed task was repaired for, and leaves other landed tasks without them', () => {
    const repaired: IsolationTaskRecord = {
      taskId: 'r', order: 1, title: 'Task r', branch: 'ordewell/r1/1-r', workspace: '/wt/1-r',
      status: 'merged', repos: { '.': { worktree: '/wt/1-r', linked: [], changed: true } },
      repairs: 1, repairedFiles: ['a.ts', 'b.ts'],
    };
    const plain: IsolationTaskRecord = {
      taskId: 'p', order: 2, title: 'Task p', branch: 'ordewell/r1/2-p', workspace: '/wt/2-p',
      status: 'merged', repos: { '.': { worktree: '/wt/2-p', linked: [], changed: true } },
    };
    const run: IsolationRun = {
      id: 'r1', workspaceRoot: '/work/app',
      repos: [{ path: '.', root: '/work/app', baseRef: '0123abcd', integrationBranch: 'ordewell/r1/integration' }],
      shared: [], sharedRepos: [],
      tasks: { r: repaired, p: plain },
    };

    const landed = [
      { taskId: 'r', order: 1, title: 'Task r', repairedFiles: ['a.ts', 'b.ts'] },
      { taskId: 'p', order: 2, title: 'Task p' },
    ];
    expect(handoffOf(run)).toEqual({
      repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: '0123abcd', landed }],
      landed,
    });
  });
});

describe('which tasks a surface offers Revert on', () => {
  const merged = (over: Partial<IsolationTaskRecord> = {}): IsolationTaskRecord => ({
    taskId: 't', order: 1, title: 'Task t', branch: 'ordewell/r1/1-t', workspace: '/work/1-t', status: 'merged',
    repos: { '.': { worktree: '/work/1-t', linked: [], changed: true, landedTip: 'aaaa' } }, ...over,
  });
  const repos = [{ path: '.', root: '/work', baseRef: 'base', integrationBranch: 'ordewell/r1/integration' }];
  const run = (tasks: Record<string, IsolationTaskRecord>, landings?: Record<string, Record<string, string[]>>): IsolationRun => ({
    id: 'r1', workspaceRoot: '/work', repos, shared: [], sharedRepos: [], tasks, ...(landings ? { landings } : {}),
  });
  const landings = { t: { '.': ['aaaa'] } };

  it('marks a landing with a merge of its own', () => {
    expect(taskIsolationsOf(run({ t: merged() })).t).toMatchObject({ state: 'integrated', revertible: true });
  });

  it('marks a task whose new record landed nothing over merges still on the branch', () => {
    const relanded = merged({ repos: { '.': { worktree: '/work/1-t', linked: [], changed: false } } });

    expect(taskIsolationsOf(run({ t: relanded }, landings)).t).toMatchObject({ state: 'integrated', revertible: true });
    expect(taskIsolationsOf(run({ t: relanded })).t).not.toHaveProperty('revertible');
  });

  it('marks a task with no record left', () => {
    expect(taskIsolationsOf(run({}, landings)).t).toEqual({ state: 'none', revertible: true });
  });

  it.each(['kept', 'failed', 'conflict'] as const)('marks a task whose later attempt ended %s', (status) => {
    expect(taskIsolationsOf(run({ t: merged({ status }) }, landings)).t).toMatchObject({ revertible: true });
    expect(taskIsolationsOf(run({ t: merged({ status }) })).t).not.toHaveProperty('revertible');
  });

  it.each(['active', 'repairing'] as const)('does not mark a task %s again, which a revert would refuse', (status) => {
    expect(taskIsolationsOf(run({ t: merged({ status }) }, landings)).t).not.toHaveProperty('revertible');
  });

  it('does not mark work in the user\'s branch', () => {
    expect(taskIsolationsOf(run({ t: merged({ inHead: true }) }, landings)).t).not.toHaveProperty('revertible');
  });

  it('reads the same from a saved plan', () => {
    expect(isolationViewOfPlan({ isolation: { run: run({}, landings), resolvers: {} } })?.tasks.t).toEqual({ state: 'none', revertible: true });
  });

  it('does not mark a task a resolver carried, whose work no merge of its own holds', () => {
    const carried = { t: { '.': ['bbbb'] } };

    expect(taskIsolationsOf({ ...run({ t: merged() }, landings), carried }).t).not.toHaveProperty('revertible');
    expect(taskIsolationsOf({ ...run({}, landings), carried }).t).toBeUndefined();
  });
});

describe('taskIsolationOf', () => {
  const base: IsolationTaskRecord = {
    taskId: 'c', order: 1, title: 'Task c', branch: 'ordewell/r1/1-c', workspace: '/work/app/.ordewell/worktrees/r1/1-c',
    status: 'conflict', repos: { '.': { worktree: '/work/app/.ordewell/worktrees/r1/1-c', linked: [] } }, conflictRepo: '.',
  };

  it('carries the conflicting files onto the surface view', () => {
    expect(taskIsolationOf({ ...base, conflictFiles: ['a.ts', 'b.ts'] }, 2)).toMatchObject({ conflictFiles: ['a.ts', 'b.ts'] });
  });

  it('leaves conflictFiles out when the record has none', () => {
    expect(taskIsolationOf(base, 2)).not.toHaveProperty('conflictFiles');
  });

  it('shows a repair in flight as repairing, with its attempt out of the most a task may have', () => {
    const repairing: IsolationTaskRecord = { ...base, status: 'repairing', repairs: 1, repairBase: { '.': 'abc' }, conflictFiles: ['a.ts'], repairedFiles: ['a.ts'] };
    expect(taskIsolationOf(repairing, 2)).toEqual({
      state: 'repairing', branch: 'ordewell/r1/1-c', worktree: '/work/app/.ordewell/worktrees/r1/1-c', repos: [],
      conflictRepo: '.', conflictFiles: ['a.ts'], repair: { attempt: 1, limit: 2 }, repairedFiles: ['a.ts'],
    });
  });

  it('keeps what repairs a conflicted or landed task went through, and says nothing of repair before the first', () => {
    expect(taskIsolationOf({ ...base, repairs: 2, repairedFiles: ['a.ts'] }, 2)).toMatchObject({ state: 'conflict', repair: { attempt: 2, limit: 2 }, repairedFiles: ['a.ts'] });
    expect(taskIsolationOf({ ...base, status: 'merged', repairs: 1, repairedFiles: ['a.ts'] }, 2)).toMatchObject({ state: 'integrated', repair: { attempt: 1, limit: 2 } });
    expect(taskIsolationOf(base, 2)).not.toHaveProperty('repair');
    expect(taskIsolationOf(base, 2)).not.toHaveProperty('repairedFiles');
  });
});

describe('isolationViewOfPlan', () => {
  const record = (taskId: string, order: number, status: IsolationTaskStatus) => ({
    taskId, order, title: `Task ${taskId}`, branch: `ordewell/r1/${order}-${taskId}`, worktree: `/ws/.ordewell/worktrees/r1/${order}-${taskId}`, status, linked: [],
  });

  // As 0.4.23 saved it: one repo, its refs on the run itself.
  const plan = {
    tasks: [],
    isolation: {
      resolvers: {},
      run: {
        id: 'r1', workspaceRoot: '/ws', baseRef: 'abc123', baseBranch: 'main', integrationBranch: 'ordewell/r1/integration',
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

  it('lists what landed in plan order, not record order', () => {
    const landed = [{ taskId: 'a', order: 1, title: 'Task a' }, { taskId: 'b', order: 2, title: 'Task b' }];
    expect(isolationViewOfPlan(plan)!.handoff).toEqual({
      repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abc123', baseBranch: 'main', landed }],
      landed,
    });
  });

  it('names each task\'s state the way a surface shows it', () => {
    const { tasks } = isolationViewOfPlan(plan)!;
    expect(Object.fromEntries(Object.entries(tasks).map(([id, t]) => [id, t.state]))).toEqual({
      a: 'integrated', b: 'integrated', c: 'conflict', d: 'kept', e: 'active',
    });
    expect(tasks.c).toMatchObject({ branch: 'ordewell/r1/3-c', conflictRepo: '.' });
  });

  it('reads a repo-group record as it reads the ADR-0013 one, for a group of one', () => {
    const groupRecord = (taskId: string, order: number, status: IsolationTaskStatus) => ({
      taskId, order, title: `Task ${taskId}`, branch: `ordewell/r1/${order}-${taskId}`, workspace: `/ws/.ordewell/worktrees/r1/${order}-${taskId}`, status,
      repos: { '.': { worktree: `/ws/.ordewell/worktrees/r1/${order}-${taskId}`, linked: [], ...(status === 'merged' ? { changed: true } : {}) } },
      ...(status === 'conflict' ? { conflictRepo: '.' } : {}),
    });
    const groupPlan = {
      tasks: [],
      isolation: {
        resolvers: {},
        run: {
          id: 'r1', workspaceRoot: '/ws', shared: [], sharedRepos: [],
          repos: [{ path: '.', root: '/ws', baseRef: 'abc123', baseBranch: 'main', integrationBranch: 'ordewell/r1/integration' }],
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

    expect(isolationViewOfPlan(groupPlan)).toEqual(isolationViewOfPlan(plan));
  });

  it.each([null, undefined, {}, { tasks: [] }, { isolation: {} }, { isolation: { run: { repos: [] } } }, 'nope'])('says nothing for %j', (payload) => {
    expect(isolationViewOfPlan(payload)).toBeNull();
  });

  const currentRecord = (taskId: string, order: number, status: IsolationTaskStatus, extra: Record<string, unknown> = {}) => {
    const workspace = `/ws/.ordewell/worktrees/r1/${order}-${taskId}`;
    return {
      taskId, order, title: `Task ${taskId}`, branch: `ordewell/r1/${order}-${taskId}`, workspace, status,
      repos: { '.': { worktree: workspace, linked: [], ...(status === 'merged' ? { changed: true } : {}) } },
      ...(status === 'conflict' ? { conflictRepo: '.' } : {}),
      ...extra,
    };
  };
  const currentPlan = (tasks: Record<string, unknown>) => ({
    tasks: [],
    isolation: {
      resolvers: {},
      run: {
        id: 'r1', workspaceRoot: '/ws', shared: [], sharedRepos: [],
        repos: [{ path: '.', root: '/ws', baseRef: 'abc123', baseBranch: 'main', integrationBranch: 'ordewell/r1/integration' }],
        tasks,
      },
    },
  });

  it('reads a repairing task and the files a landed one was repaired for (ADR-0015)', () => {
    const repairingPlan = currentPlan({
      r: currentRecord('r', 1, 'repairing', { conflictFiles: ['a.ts'], repairs: 1, repairedFiles: ['a.ts'] }),
      m: currentRecord('m', 2, 'merged', { repairs: 1, repairedFiles: ['b.ts'] }),
    });

    const { tasks, handoff } = isolationViewOfPlan(repairingPlan)!;
    expect(tasks.r).toMatchObject({ state: 'repairing', conflictFiles: ['a.ts'], repairedFiles: ['a.ts'] });
    expect(handoff.landed).toEqual([{ taskId: 'm', order: 2, title: 'Task m', repairedFiles: ['b.ts'] }]);
  });

  it('fills in the repair attempt only when the caller knows the limit, which a saved plan never carries', () => {
    const repairingPlan = currentPlan({ r: currentRecord('r', 1, 'repairing', { repairs: 1, repairedFiles: ['a.ts'] }) });

    expect(isolationViewOfPlan(repairingPlan)!.tasks.r).not.toHaveProperty('repair');
    expect(isolationViewOfPlan(repairingPlan, 2)!.tasks.r).toMatchObject({ repair: { attempt: 1, limit: 2 } });
  });

  it('leaves a task whose work is already in the user\'s branch out of the handoff (ADR-0020)', () => {
    const inHeadPlan = currentPlan({
      m: currentRecord('m', 1, 'merged', { inHead: true }),
      n: currentRecord('n', 2, 'merged'),
    });

    expect(isolationViewOfPlan(inHeadPlan)!.handoff.landed).toEqual([{ taskId: 'n', order: 2, title: 'Task n' }]);
  });

  it('leaves a task whose saved status this build does not know out, and keeps the rest', () => {
    const futurePlan = currentPlan({
      x: currentRecord('x', 1, 'merged', { status: 'future-status' }),
      n: currentRecord('n', 2, 'merged'),
    });

    expect(Object.keys(isolationViewOfPlan(futurePlan)!.tasks)).toEqual(['n']);
  });

  it('reads the detached marker and the base branch from a saved run, and leaves each off when absent', () => {
    const groupPlan = {
      isolation: {
        run: {
          id: 'r1', workspaceRoot: '/ws', shared: [], sharedRepos: [],
          repos: [
            { path: 'api', root: '/ws/api', baseRef: 'aaa', startedDetached: true, integrationBranch: 'ordewell/r1/integration' },
            { path: 'web', root: '/ws/web', baseRef: 'bbb', baseBranch: 'develop', integrationBranch: 'ordewell/r1/integration' },
          ],
          tasks: {},
        },
      },
    };

    const repos = isolationViewOfPlan(groupPlan)!.handoff.repos;
    expect(repos.map((r) => r.startedDetached)).toEqual([true, undefined]);
    expect(repos.map((r) => r.baseBranch)).toEqual([undefined, 'develop']);
  });
});

describe('capConflictFiles', () => {  it('joins every file when there are no more than the cap', () => {
    expect(capConflictFiles(['a.ts', 'b.ts'])).toBe('a.ts, b.ts');
  });

  it('caps the list and counts the rest', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    expect(capConflictFiles(files)).toBe('a.ts, b.ts, c.ts, d.ts, e.ts, +2 more');
  });
});

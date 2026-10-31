import { describe, it, expect } from 'vitest';
import { selectReadyTasks, startWaits, unmetDependencies, mergeGate, type ReadinessInput, type Readiness, type StartWait } from '../readiness';
import { createTask, type Task } from '../../models/Task';
import type { IsolationTaskRecord, IsolationTaskStatus } from '../../interfaces/IWorktreeIsolation';

function storeOf(tasks: Task[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    allTasks: tasks as ReadonlyArray<Readonly<Task>>,
    isCompleted: (id: string) => byId.get(id)?.status === 'completed',
    isFailed: (id: string) => byId.get(id)?.status === 'failed',
    isSkipped: (id: string) => byId.get(id)?.status === 'skipped',
    isOps: (id: string) => byId.get(id)?.ops === true,
    get: (id: string) => byId.get(id),
    resolveTaskRunner: (t: Readonly<Task>) => t.assignedRunner,
  };
}

function record(taskId: string, status: IsolationTaskStatus): IsolationTaskRecord {
  return { taskId, order: 1, title: taskId, branch: `b/${taskId}`, workspace: `/wt/${taskId}`, status, repos: {} };
}

function runsOf(records: Record<string, IsolationTaskRecord> = {}) {
  return {
    openRecord: (taskId: string) => records[taskId],
    awaitsMerge: (taskId: string) => records[taskId]?.status === 'merged' && !records[taskId]?.inHead,
  };
}

function input(tasks: Task[], overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    store: storeOf(tasks),
    onHold: new Set(),
    approved: () => true,
    runs: runsOf(),
    active: 0,
    maxParallel: 3,
    merging: false,
    startsHeld: false,
    completing: new Set(),
    queued: new Set(),
    ...overrides,
  };
}

/** Why the scheduler passed over a task with a prompt. */
const why = (readiness: Readiness, taskId: string): StartWait[] | undefined => readiness.excluded.find((e) => e.task.id === taskId)?.waits;

/** Whether a dependency on `depId` is met: the work behind it is on the integration branch. */
const met = (depId: string, store: ReturnType<typeof storeOf>, runs = runsOf()) => unmetDependencies({ dependencies: [depId] }, store, runs).length === 0;

/** How many times judging `tasks` read the whole plan: a task judged by scanning it reads once per task. */
function planReads(tasks: Task[]): number {
  const store = storeOf(tasks);
  let reads = 0;
  selectReadyTasks(input(tasks, { store: { ...store, get allTasks() { reads++; return store.allTasks; } } }));
  return reads;
}

describe('selectReadyTasks', () => {
  it('reads the whole plan no more often for a plan ten times the size, through a skip and in a loop', () => {
    const plan = (n: number) => [
      createTask({ id: 'skipped', order: 0, title: 'Skipped', prompt: 'x', status: 'skipped' }),
      ...Array.from({ length: n }, (_, i) => createTask({ id: `t${i}`, order: i + 1, title: `T${i}`, prompt: 'x', dependencies: ['skipped'] })),
      createTask({ id: 'check', order: n + 1, title: 'Check', prompt: 'x', loop: { body: ['t0'], maxRounds: 2 } }),
    ];

    expect(planReads(plan(100))).toBe(planReads(plan(10)));
  });

  it('offers pending AI tasks with a prompt, lowest order first', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' });

    const { ready, candidateCount } = selectReadyTasks(input([t2, t1]));

    expect(ready.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(candidateCount).toBe(2);
  });

  it.each([
    ['user task', createTask({ id: 'u1', order: 1, title: 'Check', type: 'user' })],
    ['promptless AI task', createTask({ id: 'a1', order: 2, title: 'Later' })],
    ['completed task', createTask({ id: 'c1', order: 3, title: 'Done', prompt: 'x', status: 'completed' })],
  ])('holds back a %s', (_label, task) => {
    const { ready, excluded } = selectReadyTasks(input([task]));

    expect(ready).toHaveLength(0);
    // A promptless or user task is not an AI task with work the log should name.
    if (task.type === 'ai' && task.prompt) expect(excluded.map((e) => e.task.id)).toEqual([task.id]);
    else expect(excluded).toHaveLength(0);
  });

  it('names every reason a pending AI task was passed over', () => {
    const held = createTask({ id: 'h1', order: 1, title: 'Held', prompt: 'x' });
    const dep = createTask({ id: 'd1', order: 3, title: 'Dep', prompt: 'x', dependencies: ['missing'] });

    const readiness = selectReadyTasks(input([held, dep], { onHold: new Set(['h1']) }));

    expect(readiness.ready).toHaveLength(0);
    expect(why(readiness, 'h1')).toEqual([{ kind: 'on-hold' }]);
    expect(why(readiness, 'd1')).toEqual([{ kind: 'dependencies', waiting: ['missing'] }]);
  });

  it('keeps the runner connection hold reason until it is released', () => {
    const task = createTask({ id: 'r1', order: 1, title: 'Research', prompt: 'investigate', taskMode: 'plan', research: true });
    const reason = 'could not connect to Ordewell\'s tools; start it again';
    const onHold = new Map([[task.id, reason]]);
    const state = input([task], { onHold });

    expect(selectReadyTasks(state).ready).toEqual([]);
    expect(why(selectReadyTasks(state), task.id)).toEqual([{ kind: 'on-hold', reason }]);
    expect(startWaits(task, state, { queued: false })).toEqual([]);

    onHold.delete(task.id);
    expect(selectReadyTasks(state).ready.map((ready) => ready.id)).toEqual([task.id]);
  });

  it('holds back a task outside the user\'s approval record, however ready it is (ADR-0035)', () => {
    const approved = createTask({ id: 't1', order: 1, title: 'Approved', prompt: 'x' });
    const added = createTask({ id: 't2', order: 2, title: 'Added since', prompt: 'x' });

    const readiness = selectReadyTasks(input([approved, added], { approved: (id) => id === 't1' }));

    expect(readiness.ready.map((t) => t.id)).toEqual(['t1']);
    expect(why(readiness, 't2')).toEqual([{ kind: 'unapproved' }]);
  });

  it('does not start a dependent until its dependency has completed', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] });

    const readiness = selectReadyTasks(input([t1, t2]));
    expect(readiness.ready.map((t) => t.id)).toEqual(['t1']);
    expect(why(readiness, 't2')).toEqual([{ kind: 'dependencies', waiting: ['t1'] }]);
  });

  it('frees a dependent once its dependency completed', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', status: 'completed' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] });

    expect(selectReadyTasks(input([t1, t2])).ready.map((t) => t.id)).toEqual(['t2']);
  });

  it('blocks a dependent whose dependency failed', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', status: 'failed' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] });

    expect(why(selectReadyTasks(input([t1, t2])), 't2')).toEqual([{ kind: 'blocked', failed: ['t1'] }, { kind: 'dependencies', waiting: ['t1'] }]);
  });

  it('waits for a dependency to land before starting a dependent in an isolated run', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', status: 'completed' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] });

    const unlanded = selectReadyTasks(input([t1, t2], { runs: runsOf({ t1: record('t1', 'active') }) }));
    expect(unlanded.ready).toHaveLength(0);
    expect(why(unlanded, 't2')).toEqual([{ kind: 'dependencies', waiting: ['t1'] }]);

    const landed = selectReadyTasks(input([t1, t2], { runs: runsOf({ t1: record('t1', 'merged') }) }));
    expect(landed.ready.map((t) => t.id)).toEqual(['t2']);
  });

  it('offers nothing when the slots are already full, though it counts what could start', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });

    const { ready, candidateCount, excluded } = selectReadyTasks(input([t1], { active: 1, maxParallel: 1 }));

    expect(ready).toHaveLength(0);
    expect(candidateCount).toBe(1);
    expect(excluded).toHaveLength(0);
  });

  it('caps the offered tasks at the free slots but counts every candidate', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' });

    const { ready, candidateCount } = selectReadyTasks(input([t1, t2], { maxParallel: 1 }));

    expect(ready.map((t) => t.id)).toEqual(['t1']);
    expect(candidateCount).toBe(2);
  });
});

describe('a dependency', () => {
  const completed = storeOf([createTask({ id: 't1', order: 1, title: 'First', prompt: 'x', status: 'completed' })]);
  const pending = storeOf([createTask({ id: 't1', order: 1, title: 'First', prompt: 'x' })]);

  it('is unmet while it has not completed', () => {
    expect(met('t1', pending)).toBe(false);
  });

  it('is met once it completed and no isolation run gates it', () => {
    expect(met('t1', completed)).toBe(true);
  });

  it('is unmet until its isolated work has merged', () => {
    expect(met('t1', completed, runsOf({ t1: record('t1', 'conflict') }))).toBe(false);
    expect(met('t1', completed, runsOf({ t1: record('t1', 'merged') }))).toBe(true);
  });
});

describe('behind a skipped dependency', () => {
  // T -> skipped V -> F: the skip lands none of V's work, but F's work is
  // still what T is meant to build on.
  const front = (status: Task['status'] = 'pending') => createTask({ id: 'f1', order: 1, title: 'Front', prompt: 'x', status });
  const skipped = createTask({ id: 'v2', order: 2, title: 'Verify', prompt: 'x', status: 'skipped', dependencies: ['f1'] });
  const tail = createTask({ id: 't3', order: 3, title: 'Tail', prompt: 'x', dependencies: ['v2'] });

  it('holds the dependent while the work behind the skip is unfinished, naming it', () => {
    const readiness = selectReadyTasks(input([front(), skipped, tail]));
    expect(readiness.ready.map((t) => t.id)).toEqual(['f1']);
    expect(why(readiness, 't3')).toEqual([{ kind: 'dependencies', waiting: ['f1'] }]);
    expect(met('v2', storeOf([front('in_progress'), skipped, tail]))).toBe(false);
  });

  it('lets it go once that work completed and, in an isolated run, merged into the integration branch', () => {
    const done = [front('completed'), skipped, tail];
    expect(selectReadyTasks(input(done, { runs: runsOf({ f1: record('f1', 'active') }) })).ready).toEqual([]);
    expect(selectReadyTasks(input(done, { runs: runsOf({ f1: record('f1', 'merged') }) })).ready.map((t) => t.id)).toEqual(['t3']);
    expect(selectReadyTasks(input(done)).ready.map((t) => t.id)).toEqual(['t3']);
  });

  it('lets the dependent go at once when nothing stands behind the skip', () => {
    const alone = createTask({ id: 'v2', order: 2, title: 'Verify', prompt: 'x', status: 'skipped' });
    expect(selectReadyTasks(input([alone, tail])).ready.map((t) => t.id)).toEqual(['t3']);
  });

  it('releases the dependents of a skipped failed task (ADR-0034)', () => {
    const failedThenSkipped = createTask({ id: 'v2', order: 2, title: 'Verify', prompt: 'x', status: 'skipped' });
    const tasks = [front('completed'), { ...failedThenSkipped, dependencies: ['f1'] }, tail];
    expect(selectReadyTasks(input(tasks)).ready.map((t) => t.id)).toEqual(['t3']);
  });

  it('is not held by a failed task behind the skip, or one blocked by it: skipping released them', () => {
    expect(selectReadyTasks(input([front('failed'), skipped, tail])).ready.map((t) => t.id)).toEqual(['t3']);

    const root = createTask({ id: 'r0', order: 0, title: 'Root', prompt: 'x', status: 'failed' });
    const waitsOnRoot = { ...front(), dependencies: ['r0'] };
    expect(selectReadyTasks(input([root, waitsOnRoot, skipped, tail])).ready.map((t) => t.id)).toEqual(['t3']);
  });

  it('still names a failed task the dependent also depends on directly', () => {
    const both = { ...tail, dependencies: ['v2', 'f1'] };
    expect(why(selectReadyTasks(input([front('failed'), skipped, both])), 't3')).toEqual([{ kind: 'blocked', failed: ['f1'] }, { kind: 'dependencies', waiting: ['f1'] }]);
  });

  it('walks a chain of skips through to the work behind them', () => {
    const second = createTask({ id: 's3', order: 3, title: 'Also skipped', prompt: 'x', status: 'skipped', dependencies: ['v2'] });
    const end = createTask({ id: 't4', order: 4, title: 'End', prompt: 'x', dependencies: ['s3'] });
    const held = selectReadyTasks(input([front('in_progress'), skipped, second, end]));
    expect(held.ready).toEqual([]);
    expect(why(held, 't4')).toEqual([{ kind: 'dependencies', waiting: ['f1'] }]);
    expect(selectReadyTasks(input([front('completed'), skipped, second, end])).ready.map((t) => t.id)).toEqual(['t4']);
  });

  it('walks a cycle of skips once', () => {
    const a = createTask({ id: 'a1', order: 1, title: 'A', prompt: 'x', status: 'skipped', dependencies: ['b2', 'f1'] });
    const b = createTask({ id: 'b2', order: 2, title: 'B', prompt: 'x', status: 'skipped', dependencies: ['a1'] });
    const end = createTask({ id: 't4', order: 4, title: 'End', prompt: 'x', dependencies: ['b2'] });
    expect(met('b2', storeOf([front(), a, b, end]))).toBe(false);
    expect(met('b2', storeOf([front('completed'), a, b, end]))).toBe(true);
  });
});

describe('the blocked wait', () => {
  it('reads a failed dependency', () => {
    const failed = createTask({ id: 't1', order: 1, title: 'Failed', prompt: 'x', status: 'failed' });
    const dependent = createTask({ id: 't2', order: 2, title: 'Dependent', prompt: 'x', dependencies: ['t1'] });
    expect(startWaits(dependent, input([failed, dependent]))).toContainEqual({ kind: 'blocked', failed: ['t1'] });
  });

  it('does not block a task without dependencies', () => {
    const task = createTask({ id: 't1', order: 1, title: 'Free', prompt: 'x' });
    expect(startWaits(task, input([task]))).toEqual([]);
  });
});

describe('the merge gate (ADR-0020)', () => {
  const done = createTask({ id: 't1', order: 1, title: 'Change', prompt: 'x', status: 'completed' });
  const opsTask = createTask({ id: 'o2', order: 2, title: 'Deploy', prompt: 'x', ops: true, dependencies: ['t1'] });
  const userTask = createTask({ id: 'u3', order: 3, title: 'Check', type: 'user', dependencies: ['t1'] });
  const changeTask = createTask({ id: 't4', order: 4, title: 'Follow-up', prompt: 'x', dependencies: ['t1'] });
  const tasks = [done, opsTask, userTask, changeTask];
  const landed = (inHead: boolean) => runsOf({ t1: { ...record('t1', 'merged'), ...(inHead ? { inHead: true as const } : {}) } });

  it('holds an ops task whose change dependency has landed but is not merged, and reports it and the user task gated', () => {
    const { ready, gated } = selectReadyTasks(input(tasks, { runs: landed(false) }));
    expect(ready.map((t) => t.id)).toEqual(['t4']);
    expect(gated.map((t) => t.id)).toEqual(['o2', 'u3']);
  });

  it('reports gated only a task nothing else holds back (ADR-0035)', () => {
    const { gated } = selectReadyTasks(input(tasks, { runs: landed(false), approved: (id) => id !== 'o2', onHold: new Set(['u3']) }));
    expect(gated).toEqual([]);
  });

  it('lets it go once that work is in the user\'s branch', () => {
    const { ready, gated } = selectReadyTasks(input(tasks, { runs: landed(true) }));
    expect(ready.map((t) => t.id)).toEqual(['o2', 't4']);
    expect(gated).toEqual([]);
  });

  it('starts no ops task while a merge is under way', () => {
    const { ready } = selectReadyTasks(input(tasks, { runs: landed(true), merging: true }));
    expect(ready.map((t) => t.id)).toEqual(['t4']);
  });

  it('names the unmerged dependencies of an ops or user task, and none of a change task', () => {
    const store = storeOf(tasks);
    expect(mergeGate(opsTask, store, landed(false))).toEqual(['t1']);
    expect(mergeGate(userTask, store, landed(false))).toEqual(['t1']);
    expect(mergeGate(changeTask, store, landed(false))).toEqual([]);
    expect(mergeGate(opsTask, store, landed(true))).toEqual([]);
  });

  it('has nothing to wait for without an isolation run', () => {
    expect(mergeGate(opsTask, storeOf(tasks), runsOf())).toEqual([]);
  });

  describe('over the whole dependency closure', () => {
    // The real case: an ops task depends on a verification that landed no
    // commits, which depends on the fix whose commit is still only on the
    // integration branch.
    const fix = createTask({ id: 'f1', order: 1, title: 'Fix', prompt: 'x', status: 'completed' });
    const verify = createTask({ id: 'v2', order: 2, title: 'Verify', prompt: 'x', status: 'completed', dependencies: ['f1'] });
    const pack = createTask({ id: 'o3', order: 3, title: 'Pack', prompt: 'x', ops: true, dependencies: ['v2'] });
    const fixLanded = (inHead: boolean) => runsOf({ f1: { ...record('f1', 'merged'), ...(inHead ? { inHead: true as const } : {}) } });

    it('holds an ops task whose dependency\'s own dependency has landed but is not merged, naming it', () => {
      const chain = [fix, verify, pack];
      expect(mergeGate(pack, storeOf(chain), fixLanded(false))).toEqual(['f1']);
      const { ready, gated } = selectReadyTasks(input(chain, { runs: fixLanded(false) }));
      expect(ready).toEqual([]);
      expect(gated.map((t) => t.id)).toEqual(['o3']);
    });

    it('lets it go once Merge all brought that work into the user\'s branch', () => {
      const { ready, gated } = selectReadyTasks(input([fix, verify, pack], { runs: fixLanded(true) }));
      expect(ready.map((t) => t.id)).toEqual(['o3']);
      expect(gated).toEqual([]);
    });

    it('holds a user task the same way', () => {
      const check = createTask({ id: 'u3', order: 3, title: 'Check', type: 'user', dependencies: ['v2'] });
      expect(mergeGate(check, storeOf([fix, verify, check]), fixLanded(false))).toEqual(['f1']);
      expect(mergeGate(check, storeOf([fix, verify, check]), fixLanded(true))).toEqual([]);
    });

    it('is not held by a skipped ancestor, though one before it still counts', () => {
      // Its record says landed, unmerged work: only the skip keeps it out.
      const skipped = createTask({ id: 'v2', order: 2, title: 'Verify', prompt: 'x', status: 'skipped', dependencies: ['f1'] });
      const runs = runsOf({ v2: record('v2', 'merged'), f1: record('f1', 'merged') });
      expect(mergeGate(pack, storeOf([fix, skipped, pack]), runs)).toEqual(['f1']);
      const merged = runsOf({ v2: record('v2', 'merged'), f1: { ...record('f1', 'merged'), inHead: true } });
      expect(mergeGate(pack, storeOf([fix, skipped, pack]), merged)).toEqual([]);
    });

    it('names an ancestor reached by two paths once', () => {
      const left = createTask({ id: 'l2', order: 2, title: 'Left', prompt: 'x', status: 'completed', dependencies: ['f1'] });
      const right = createTask({ id: 'r3', order: 3, title: 'Right', prompt: 'x', status: 'completed', dependencies: ['f1'] });
      const deploy = createTask({ id: 'o4', order: 4, title: 'Deploy', prompt: 'x', ops: true, dependencies: ['l2', 'r3'] });
      const runs = runsOf({ f1: record('f1', 'merged'), r3: record('r3', 'merged') });
      expect(mergeGate(deploy, storeOf([fix, left, right, deploy]), runs)).toEqual(['r3', 'f1']);
    });

    it('walks a dependency cycle once', () => {
      const a = createTask({ id: 'a1', order: 1, title: 'A', prompt: 'x', status: 'completed', dependencies: ['b2'] });
      const b = createTask({ id: 'b2', order: 2, title: 'B', prompt: 'x', status: 'completed', dependencies: ['a1'] });
      const ops = createTask({ id: 'o3', order: 3, title: 'Ops', prompt: 'x', ops: true, dependencies: ['b2'] });
      const runs = runsOf({ a1: record('a1', 'merged') });
      expect(mergeGate(ops, storeOf([a, b, ops]), runs)).toEqual(['a1']);
    });
  });
});

describe('the start rule', () => {
  const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'x', assignedRunner: 'codex' });

  it('lists every wait in order, the reason first', () => {
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'x', dependencies: ['t1'] });
    expect(startWaits(t2, input([t1, t2], { approved: () => false, startsHeld: true }))).toEqual([
      { kind: 'unapproved' },
      { kind: 'dependencies', waiting: ['t1'] },
      { kind: 'start-hold' },
    ]);
  });

  it('holds a task Mark complete is landing', () => {
    expect(startWaits(t1, input([t1], { completing: new Set(['t1']) }))).toEqual([{ kind: 'completing' }]);
  });

  it('holds every task on a runner waiting for its usage limit to reset, and only those', () => {
    // Spread over createTask, which drops the awaiting reason only a run sets.
    const paused: Task = { ...createTask({ id: 'p0', order: 0, title: 'Paused', prompt: 'x', assignedRunner: 'codex' }), status: 'awaiting_user', awaitingReason: 'usage-limit' };
    const other = createTask({ id: 't2', order: 2, title: 'Other', prompt: 'x', assignedRunner: 'claude-code' });
    const readiness = selectReadyTasks(input([paused, t1, other]));
    expect(readiness.ready.map((t) => t.id)).toEqual(['t2']);
    expect(why(readiness, 't1')).toEqual([{ kind: 'usage-limit', runner: 'codex' }]);
  });

  it('does not hold a script task for the usage limit of a runner the plan stored for it: it runs on none', () => {
    const paused: Task = { ...createTask({ id: 'p0', order: 0, title: 'Paused', prompt: 'x', assignedRunner: 'codex' }), status: 'awaiting_user', awaitingReason: 'usage-limit' };
    const script = createTask({ id: 's1', order: 3, title: 'Push', type: 'script', commands: [['git', 'push']], assignedRunner: 'codex' });
    expect(selectReadyTasks(input([paused, script])).ready.map((t) => t.id)).toEqual(['s1']);
  });

  it('says a task that started, has no prompt, or is the user\'s waits for that', () => {
    const user = createTask({ id: 'u1', order: 1, title: 'Check', type: 'user' });
    const empty = createTask({ id: 'a1', order: 2, title: 'Later' });
    const running = createTask({ id: 'r1', order: 3, title: 'Running', prompt: 'x', status: 'in_progress' });
    const all = input([user, empty, running]);
    expect(startWaits(user, all)).toEqual([{ kind: 'by-hand' }]);
    expect(startWaits(empty, all)).toEqual([{ kind: 'no-prompt' }]);
    expect(startWaits(running, all)).toEqual([{ kind: 'started' }]);
  });

  describe('for a start the user forced (ADR-0034)', () => {
    const failed = createTask({ id: 'a', order: 1, title: 'A', prompt: 'x', status: 'failed' });
    const underWay = createTask({ id: 'b', order: 2, title: 'B', prompt: 'x', status: 'in_progress' });
    const blockedDep = createTask({ id: 'c', order: 3, title: 'C', prompt: 'x', dependencies: ['a', 'b'] });
    const forced = createTask({ id: 'd', order: 4, title: 'D', prompt: 'x', dependencies: ['a', 'c'] });
    const plan = [failed, underWay, blockedDep, forced];

    it('goes past a failure, a hold and a planner turn, but waits on the work still under way, through what the failure blocks', () => {
      const rule = input(plan, { onHold: new Set(['d']), startsHeld: true });
      expect(startWaits(forced, rule)).toEqual([
        { kind: 'on-hold' },
        { kind: 'blocked', failed: ['a'] },
        { kind: 'dependencies', waiting: ['a', 'c'] },
        { kind: 'start-hold' },
      ]);
      expect(startWaits(forced, rule, { queued: false })).toEqual([{ kind: 'dependencies', waiting: ['b'] }]);
    });

    it('queued, says so, and waits for a planner turn', () => {
      const rule = input(plan, { startsHeld: true, queued: new Set(['d']) });
      expect(startWaits(forced, rule, { queued: true, pastGate: [] })).toEqual([{ kind: 'queued', waiting: ['b'] }, { kind: 'start-hold' }]);
    });

    it('goes past the whole gate made now, and only the gate it was confirmed past once queued', () => {
      const fix = createTask({ id: 'f1', order: 1, title: 'Fix', prompt: 'x', status: 'completed' });
      const docs = createTask({ id: 'f2', order: 2, title: 'Docs', prompt: 'x', status: 'completed' });
      const deploy = createTask({ id: 'o3', order: 3, title: 'Deploy', prompt: 'x', ops: true, dependencies: ['f1', 'f2'] });
      const rule = input([fix, docs, deploy], { runs: runsOf({ f1: record('f1', 'merged'), f2: record('f2', 'merged') }) });
      expect(startWaits(deploy, rule)).toEqual([{ kind: 'merge-gate', unmerged: ['f1', 'f2'] }]);
      expect(startWaits(deploy, rule, { queued: false })).toEqual([]);
      expect(startWaits(deploy, rule, { queued: true, pastGate: ['f1'] })).toEqual([{ kind: 'merge-gate', unmerged: ['f2'] }]);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { escalationAct, escalations, type Escalation, type EscalationInput, type EscalationRun } from '../escalations';
import { planStartWaits } from '../readiness';
import { createTask, type Task } from '../../models/Task';
import type { PendingApproval } from '../PendingApprovals';
import type { RunMergeView } from '../SessionMessage';

// Spread over the result: createTask keeps only what a new task can have, and these are tasks mid-run.
const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  ({ ...createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, status: 'approved', ...over }), ...over });

const OPEN: EscalationRun = { open: true, advancing: false, merging: false, autoMerges: false, mergesAtClose: false, merge: null, id: null, blocked: null };

const failedVerdict = (reported: 'failed' | 'blocked'): Task['verdict'] => ({ outcome: 'fail', reason: 'it did not hold', checks: [], decidedAt: '2026-10-30T00:00:00Z', reported });

const runnerRequest = (id: string, taskId: string, over: Partial<PendingApproval['request']> = {}): PendingApproval => ({
  id, createdAt: '2026-10-30T00:00:00Z', request: { kind: 'runner_tool', subject: 'rm -rf build', scope: 'rm', taskId, ...over },
});

interface Setup {
  run?: Partial<EscalationRun>;
  approvals?: PendingApproval[];
  live?: string[];
  attempts?: Record<string, number>;
  checkpoints?: Record<string, string>;
  added?: string[];
  onHold?: Record<string, string>;
  unmerged?: string[];
  queued?: string[];
  startsHeld?: boolean;
  merging?: boolean;
  /** Conflicted task id → the task out to resolve it. */
  resolvers?: Record<string, string>;
  startsAlone?: string[];
  /** Loops' checks between rounds that nothing will run. */
  stranded?: string[];
  /** Tasks a loop carried on with no scheduler starts. */
  carried?: string[];
  /** Filled with each task whose attempt the list read. */
  attemptsRead?: string[];
}

function listFor(tasks: Task[], setup: Setup = {}): Escalation[] {
  const all = tasks.flatMap(function walk(t): Task[] { return [t, ...t.subtasks.flatMap(walk)]; });
  const byId = new Map(all.map((t) => [t.id, t]));
  const unmerged = new Set(setup.unmerged ?? []);
  const onHold = new Map(Object.entries(setup.onHold ?? {}));
  const waits = planStartWaits({
    store: {
      allTasks: all,
      get: (id) => byId.get(id),
      isCompleted: (id) => byId.get(id)?.status === 'completed',
      isSkipped: (id) => byId.get(id)?.status === 'skipped',
      isOps: (id) => byId.get(id)?.ops === true || byId.get(id)?.type === 'script',
      resolveTaskRunner: (t) => t.assignedRunner,
    },
    onHold,
    approved: (id) => !(setup.added ?? []).includes(id),
    runs: { openRecord: () => undefined, awaitsMerge: (id) => unmerged.has(id) },
    merging: setup.merging ?? false,
    startsHeld: setup.startsHeld ?? false,
    completing: new Set(),
    queued: new Set(setup.queued ?? []),
    conflictResolver: (id) => setup.resolvers?.[id],
  });
  const input: EscalationInput = {
    tasks,
    waits,
    approvals: setup.approvals ?? [],
    attempt: (t) => {
      setup.attemptsRead?.push(t.id);
      return setup.attempts?.[t.id] ?? 0;
    },
    live: (id) => (setup.live ?? []).includes(id),
    checkpoint: (id) => setup.checkpoints?.[id],
    waitsForApproval: (id) => (setup.added ?? []).includes(id),
    startQueued: (id) => (setup.startsAlone ?? []).includes(id),
    holdReason: (id) => onHold.get(id),
    loopRunsOn: (id) => !(setup.stranded ?? []).includes(id),
    carried: (id) => (setup.carried ?? []).includes(id),
    run: { ...OPEN, ...setup.run },
  };
  return escalations(input);
}

describe('what the list reads', () => {
  it('reads the attempt of no task nothing waits on: after a reload each read is a directory listing', () => {
    const attemptsRead: string[] = [];

    listFor([
      task('done', 1, { status: 'completed' }),
      task('next', 2, { dependencies: ['failed'] }),
      task('failed', 3, { status: 'failed', verdict: failedVerdict('failed') }),
    ], { attemptsRead });

    expect(attemptsRead).toEqual(['failed']);
  });
});

describe('a loop\'s check between rounds that nothing will run (ADR-0045 L5)', () => {
  const check = (bodyStatus: Task['status'] = 'completed') => [
    task('c', 1, { status: 'failed', verdict: failedVerdict('failed'), loop: { body: ['b'], maxRounds: 3 } }),
    task('b', 2, { status: bodyStatus, dependencies: ['c'] }),
  ];

  it('offers its next round once its body has landed', () => {
    const [entry] = listFor(check(), { stranded: ['c'] });
    expect(entry).toMatchObject({ kind: 'failed', reason: 'Its fix has landed, and nothing runs its round 2 of 3.' });
    expect(entry.options[0]).toEqual({ id: 'run', label: 'Start round 2 of 3' });
    expect(entry.options.map((o) => o.id)).toContain('retry');
  });

  it('says what is left before that, with no start the seam would refuse', () => {
    const [entry] = listFor(check('pending'), { stranded: ['c'] });
    expect(entry.reason).toBe('Its loop stopped between rounds: nothing runs it again, and #2 has not landed. Execute the plan and the loop goes on.');
    expect(entry.options.map((o) => o.id)).not.toContain('run');
  });

  it('is left out once anything will run it', () => {
    expect(listFor(check('pending')).filter((e) => e.task?.id === 'c')).toEqual([]);
  });
});

describe('a loop carried on with no scheduler (ADR-0045 L5)', () => {
  const closed = { run: { open: false } };
  const body = () => [task('b', 1, { status: 'approved' })];

  it('opens the run for its own tasks, and no others', () => {
    expect(listFor(body(), { ...closed, added: ['b'] })).toEqual([]);
    expect(listFor(body(), { ...closed, added: ['b'], carried: ['b'] }).map((e) => e.kind)).toEqual(['unapproved']);
  });
});

/** Each row's id, and the option ids it offers: what the table pins. */
const shape = (list: readonly Escalation[]) => list.map(({ id, kind, options }) => ({ id, kind, options: options.map((o) => o.id) }));

const continuable: Partial<Task> = { runnerSessionId: 'sess-1', runnerSessionOwner: 'claude-code', assignedRunner: 'claude-code' };

describe('what waits on a person, task by task', () => {
  const failed: Partial<Task> = { status: 'failed', verdict: failedVerdict('blocked') };

  it.each<[string, Task[], Setup, ReturnType<typeof shape>]>([
    ['a runner approval, with its own answers', [task('t1', 1, { status: 'in_progress' })], { live: ['t1'], attempts: { t1: 2 }, approvals: [runnerRequest('ap-1', 't1')] },
      [{ id: 'approval:t1:2:ap-1', kind: 'approval', options: ['allow', 'deny'] }]],
    ['a runner approval that offers a grant for the task', [task('t1', 1, { status: 'in_progress' })], { live: ['t1'], attempts: { t1: 1 }, approvals: [runnerRequest('ap-2', 't1', { allowForTask: true })] },
      [{ id: 'approval:t1:1:ap-2', kind: 'approval', options: ['allow', 'allow-for-task', 'deny'] }]],
    ['two approvals on one task, each its own', [task('t1', 1, { status: 'in_progress' })], { live: ['t1'], attempts: { t1: 1 }, approvals: [runnerRequest('ap-1', 't1'), runnerRequest('ap-2', 't1')] },
      [{ id: 'approval:t1:1:ap-1', kind: 'approval', options: ['allow', 'deny'] }, { id: 'approval:t1:1:ap-2', kind: 'approval', options: ['allow', 'deny'] }]],
    ['a checkpoint with its runner there', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'checkpoint' })], { live: ['t1'], attempts: { t1: 3 }, checkpoints: { t1: 'Ship it?' }, run: { advancing: true } },
      [{ id: 'checkpoint:t1:3', kind: 'checkpoint', options: ['approve', 'reject', 'skip'] }]],
    ['a checkpoint reloaded from disk, with no runner left to hear it', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'checkpoint' })], { attempts: { t1: 3 } },
      [{ id: 'checkpoint:t1:3', kind: 'checkpoint', options: ['retry', 'skip', 'complete'] }]],
    ['input, with its runner there', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'input' })], { live: ['t1'], attempts: { t1: 1 }, run: { advancing: true } },
      [{ id: 'input:t1:1', kind: 'input', options: ['reply', 'skip'] }]],
    ['input reloaded from disk', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'input' })], { attempts: { t1: 1 } },
      [{ id: 'input:t1:1', kind: 'input', options: ['retry', 'skip', 'complete'] }]],
    ['an awaiting task saved with no reason reads as input', [task('t1', 1, { status: 'awaiting_user' })], { attempts: { t1: 1 } },
      [{ id: 'input:t1:1', kind: 'input', options: ['retry', 'skip', 'complete'] }]],
    ['a landing conflict', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'conflict' })], { attempts: { t1: 1 } },
      [{ id: 'conflict:t1:1', kind: 'conflict', options: ['resolve-conflict', 'retry', 'skip', 'complete'] }]],
    ['an ops task that changed tracked files', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'files-changed', ops: true })], { attempts: { t1: 1 } },
      [{ id: 'files-changed:t1:1', kind: 'files-changed', options: ['retry', 'skip', 'complete'] }]],
    ['a usage-limit pause with no scheduled resume', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'usage-limit', ...continuable })], { attempts: { t1: 1 } },
      [{ id: 'usage-limit:t1:1', kind: 'usage-limit', options: ['resume', 'skip', 'complete'] }]],
    ['a usage-limit pause with no session to resume', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'usage-limit' })], { attempts: { t1: 1 } },
      [{ id: 'usage-limit:t1:1', kind: 'usage-limit', options: ['retry', 'skip', 'complete'] }]],
    ['a failed task, with Mark complete held back while the run could still move it', [task('t1', 1, failed)], { attempts: { t1: 2 }, run: { advancing: true } },
      [{ id: 'failed:t1:2', kind: 'failed', options: ['retry', 'skip'] }]],
    ['a failed task once the run has ended on it', [task('t1', 1, failed)], { attempts: { t1: 2 } },
      [{ id: 'failed:t1:2', kind: 'failed', options: ['retry', 'skip', 'complete'] }]],
    ['a failed task with a session to continue', [task('t1', 1, { ...failed, ...continuable })], { attempts: { t1: 1 } },
      [{ id: 'failed:t1:1', kind: 'failed', options: ['retry', 'continue', 'skip', 'complete'] }]],
    ['a loop out of rounds', [task('c', 1, { status: 'failed', verdict: failedVerdict('failed'), loop: { body: ['b'], maxRounds: 2 }, loopRound: 2 }), task('b', 2, { status: 'skipped', dependencies: ['c'] })], { attempts: { c: 2 } },
      [{ id: 'out-of-rounds:c:2', kind: 'out-of-rounds', options: ['retry', 'skip', 'complete'] }]],
    ['a loop stopped by a skipped body task, whose check is the only thing left to list', [task('c', 1, { status: 'failed', verdict: failedVerdict('failed'), loop: { body: ['b'], maxRounds: 3 } }), task('b', 2, { status: 'skipped', dependencies: ['c'] })], { attempts: { c: 1 } },
      [{ id: 'failed:c:1', kind: 'failed', options: ['retry', 'skip', 'complete'] }]],
    ['a loop stopped by a failed body task lists the body task once, not its check', [task('c', 1, { status: 'failed', verdict: failedVerdict('failed'), loop: { body: ['b'], maxRounds: 3 } }), task('b', 2, { ...failed, dependencies: ['c'] })], { attempts: { b: 1, c: 1 } },
      [{ id: 'failed:b:1', kind: 'failed', options: ['retry', 'skip', 'complete'] }]],
    ['a blocked dependent lists its cause, once', [task('t1', 1, failed), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t2'] })], { attempts: { t1: 1 } },
      [{ id: 'failed:t1:1', kind: 'failed', options: ['retry', 'skip', 'complete'] }]],
    ['a subtask is listed as a task is', [task('t1', 1, { status: 'in_progress', subtasks: [task('s1', 1, { status: 'awaiting_user', awaitingReason: 'input' })] })], { live: ['s1'], attempts: { s1: 1 }, run: { advancing: true } },
      [{ id: 'input:s1:1', kind: 'input', options: ['reply', 'skip'] }]],
  ])('%s', (_name, tasks, setup, expected) => {
    expect(shape(listFor(tasks, setup))).toEqual(expected);
  });

  it.each<[string, Task[], Setup]>([
    ['a usage-limit pause with a scheduled resume', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2026-10-30T12:00:00Z' })], {}],
    ['a loop check between rounds', [task('c', 1, { status: 'failed', verdict: failedVerdict('failed'), loop: { body: ['b'], maxRounds: 3 } }), task('b', 2, { status: 'in_progress', dependencies: ['c'] })], { live: ['b'] }],
    ['a task at work', [task('t1', 1, { status: 'in_progress' })], { live: ['t1'] }],
    ['a completed task', [task('t1', 1, { status: 'completed' })], {}],
    ['a skipped task', [task('t1', 1, { status: 'skipped' })], {}],
    ['a planner approval, which times out by itself and has no task', [task('t1', 1, { status: 'in_progress' })], { live: ['t1'], approvals: [{ id: 'ap-3', createdAt: '2026-10-30T00:00:00Z', request: { kind: 'shell_command', subject: 'npm test', scope: 'npm' } }] }],
    ['a runner approval of a task the plan no longer holds', [task('t1', 1, { status: 'in_progress' })], { live: ['t1'], approvals: [runnerRequest('ap-4', 'gone')] }],
  ])('leaves out %s', (_name, tasks, setup) => {
    expect(listFor(tasks, setup)).toEqual([]);
  });
});

describe('what only a person can start', () => {
  const landed = { taskId: 't1', order: 1, title: 'Task t1' };
  const merge: RunMergeView = { waitingAtGate: false, paused: false, repos: [], landed: [landed] };
  // Pinned, not recomputed: a change of what the id is built from retells every live Merge all.
  const MERGE_ALL = 'merge-all:r1:da4b67039c7c';
  const AT_GATE = 'merge-gate:t2:0:da4b67039c7c';
  const gated: Task[] = [task('t1', 1, { status: 'completed' }), task('t2', 2, { type: 'script', commands: [['npm', 'publish']], dependencies: ['t1'] })];

  it.each<[string, Task[], Setup, ReturnType<typeof shape>]>([
    ['a task at its merge gate', gated, { unmerged: ['t1'], run: { merge: { ...merge, waitingAtGate: true }, id: 'r1' } },
      [{ id: AT_GATE, kind: 'merge-gate', options: ['merge-all', 'force-start'] }]],
    ['a user task at its merge gate', [task('t1', 1, { status: 'completed' }), task('t2', 2, { type: 'user', dependencies: ['t1'] })], { unmerged: ['t1'], run: { merge: { ...merge, waitingAtGate: true }, id: 'r1' } },
      [{ id: AT_GATE, kind: 'merge-gate', options: ['merge-all', 'complete'] }]],
    ['a user task done by hand', [task('t1', 1, { type: 'user' })], {},
      [{ id: 'by-hand:t1:0', kind: 'by-hand', options: ['complete'] }]],
    ['a user task added since the approval, which needs none', [task('t1', 1, { type: 'user' })], { added: ['t1'] },
      [{ id: 'by-hand:t1:0', kind: 'by-hand', options: ['complete'] }]],
    ['a task added since the user approved the plan', [task('t1', 1)], { added: ['t1'] },
      [{ id: 'unapproved:t1:0', kind: 'unapproved', options: ['run'] }]],
    ['a task on hold', [task('t1', 1)], { onHold: { t1: 'cancelled; retry or force start to run it again' } },
      [{ id: 'on-hold:t1:0', kind: 'on-hold', options: ['retry', 'force-start'] }]],
    ['a user task on hold, which no runner starts', [task('t1', 1, { type: 'user' })], { onHold: { t1: 'marked not done; retry or force start to run it again' } },
      [{ id: 'on-hold:t1:0', kind: 'on-hold', options: ['complete'] }]],
    ['a reverted task behind a dependency, which the seam would not retry yet', [task('t1', 1), task('t2', 2, { dependencies: ['t1'], reverted: true })], { onHold: { t1: 'stopped', t2: 'reverted; retry or force start to run it again' } },
      [{ id: 'on-hold:t1:0', kind: 'on-hold', options: ['retry', 'force-start'] }, { id: 'on-hold:t2:0', kind: 'on-hold', options: ['force-start'] }]],
    ['a reverted task behind a failed dependency', [task('t1', 1, { status: 'failed' }), task('t2', 2, { dependencies: ['t1'], reverted: true })], { attempts: { t1: 1 }, onHold: { t2: 'reverted; retry or force start to run it again' } },
      [{ id: 'failed:t1:1', kind: 'failed', options: ['retry', 'skip', 'complete'] }, { id: 'on-hold:t2:0', kind: 'on-hold', options: ['force-start'] }]],
    ['a task with nothing to run', [task('t1', 1, { prompt: undefined })], {},
      [{ id: 'no-prompt:t1:0', kind: 'no-prompt', options: ['skip'] }]],
    ['landed work with nothing left to move it', [task('t1', 1, { status: 'completed' })], { run: { open: false, merge, id: 'r1' } },
      [{ id: MERGE_ALL, kind: 'merge-all', options: ['merge-all'] }]],
    ['a merge owed beside a failure the run ended on', [task('t1', 1, { status: 'completed' }), task('t2', 2, { status: 'failed' })], { attempts: { t2: 1 }, run: { merge, id: 'r1' } },
      [{ id: 'failed:t2:1', kind: 'failed', options: ['retry', 'skip', 'complete'] }, { id: MERGE_ALL, kind: 'merge-all', options: ['merge-all'] }]],
    ['a run a dirty checkout turned away, first', [task('t1', 1, { status: 'failed' })], { attempts: { t1: 1 }, run: { blocked: 4, advancing: true } },
      [{ id: 'blocked-run:4', kind: 'blocked-run', options: ['stash', 'run-without-isolation'] }, { id: 'failed:t1:1', kind: 'failed', options: ['retry', 'skip'] }]],
  ])('%s', (_name, tasks, setup, expected) => {
    expect(shape(listFor(tasks, setup))).toEqual(expected);
  });

  it.each<[string, Task[], Setup]>([
    ['a task ready to start', [task('t1', 1)], {}],
    ['a task waiting on a dependency still at work', [task('t1', 1, { status: 'in_progress' }), task('t2', 2, { dependencies: ['t1'] })], { live: ['t1'] }],
    ['a user task waiting on a dependency still at work', [task('t1', 1, { status: 'in_progress' }), task('t2', 2, { type: 'user', dependencies: ['t1'] })], { live: ['t1'] }],
    ['a task added since the approval, its dependency still at work', [task('t1', 1, { status: 'in_progress' }), task('t2', 2, { dependencies: ['t1'] })], { live: ['t1'], added: ['t2'] }],
    ['a held task, its dependency still at work', [task('t1', 1, { status: 'in_progress' }), task('t2', 2, { dependencies: ['t1'] })], { live: ['t1'], onHold: { t2: 'cancelled' } }],
    ['a body task waiting for its check', [task('c', 1, { status: 'in_progress', loop: { body: ['b'], maxRounds: 3 } }), task('b', 2, { dependencies: ['c'] })], { live: ['c'] }],
    ['a force start queued behind its dependency', [task('t1', 1, { status: 'in_progress' }), task('t2', 2, { dependencies: ['t1'] })], { live: ['t1'], queued: ['t2'] }],
    ['a gate that merges by itself', gated, { unmerged: ['t1'], run: { autoMerges: true, id: 'r1' } }],
    ['a task held back by a planner turn', [task('t1', 1, { type: 'script', commands: [['ls']] })], { startsHeld: true }],
    ['an ops task behind a Merge all under way', [task('t1', 1, { type: 'script', commands: [['ls']] })], { merging: true }],
    ['a task on a runner that waits on its reset', [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2026-10-30T12:00:00Z' }), task('t2', 2)], {}],
    ['a task nobody approved, in a run a lone start opened', [task('t1', 1)], { added: [] }],
    ['landed work while the run still moves', [task('t1', 1, { status: 'completed' }), task('t2', 2, { status: 'in_progress' })], { live: ['t2'], run: { advancing: true, merge, id: 'r1' } }],
    ['landed work a Merge all is already merging', [task('t1', 1, { status: 'completed' })], { run: { merging: true, merge, id: 'r1' } }],
    ['landed work the run\'s close is about to merge by itself', [task('t1', 1, { status: 'completed' })], { run: { open: false, mergesAtClose: true, merge, id: 'r1' } }],
    ['a user task with no run open', [task('t1', 1, { type: 'user' })], { run: { open: false } }],
    ['a merge gate with no run open', gated, { unmerged: ['t1'], run: { open: false } }],
    ['a task on hold with no run open', [task('t1', 1)], { onHold: { t1: 'cancelled' }, run: { open: false } }],
  ])('leaves out %s', (_name, tasks, setup) => {
    expect(listFor(tasks, setup)).toEqual([]);
  });

  it('names a gate\'s unmerged work, and asks before a start goes past it', () => {
    const [only] = listFor(gated, { unmerged: ['t1'], run: { id: 'r1' } });
    expect(only.reason).toBe('Waits for Merge all: the work of #1 is not merged into your branch yet.');
    expect(only.options.find((o) => o.id === 'force-start')?.confirm).toBe('It waits for Merge all: the work of #1 is not merged into your branch yet, so it would act without it. Starting it now is kept on the task.');
  });

  it('names a Merge all by what it would merge, so work landing later is another wait', () => {
    const done = [task('t1', 1, { status: 'completed' }), task('t2', 2, { status: 'completed' })];
    const idOf = (taskIds: string[], attempts: Record<string, number>, id = 'r1') =>
      listFor(done, { attempts, run: { open: false, id, merge: { ...merge, landed: taskIds.map((taskId, order) => ({ taskId, order, title: taskId })) } } })[0].id;
    const first = idOf(['t1'], { t1: 1 });

    expect(idOf(['t1'], { t1: 1, t2: 1 })).toBe(first);
    expect(idOf(['t2'], { t1: 1, t2: 1 })).not.toBe(first);
    expect(idOf(['t1', 't2'], { t1: 1, t2: 1 })).not.toBe(first);
    expect(idOf(['t1'], { t1: 2 })).not.toBe(first);
    expect(idOf(['t1'], { t1: 1 }, 'r2')).not.toBe(first);
  });

  it('holds no task on a run\'s own wait', () => {
    expect(listFor([task('t1', 1, { status: 'completed' })], { run: { open: false, merge, id: 'r1' } })).toEqual([{
      id: MERGE_ALL,
      kind: 'merge-all',
      reason: 'The run\'s landed work waits for Merge all: #1.',
      options: [{ id: 'merge-all', label: 'Merge all' }],
    }]);
  });
});

describe('a conflict with a resolver out to it (ADR-0015)', () => {
  const conflicted = () => task('t1', 1, { status: 'awaiting_user', awaitingReason: 'conflict' });
  const closed = { open: false };

  it('leaves the conflict out while the resolver works on it, a scheduler will start it, or it is queued', () => {
    const resolvers = { t1: 'r1' };
    expect(listFor([conflicted(), task('r1', 2, { status: 'in_progress' })], { resolvers, live: ['r1'], run: closed })).toEqual([]);
    expect(listFor([conflicted(), task('r1', 2, { status: 'approved' })], { resolvers })).toEqual([]);
    expect(listFor([conflicted(), task('r1', 2, { status: 'approved' })], { resolvers, startsAlone: ['r1'], run: closed })).toEqual([]);
  });

  it('lists the resolver in its place once it is the wait, and the same wait only once', () => {
    const failed = task('r1', 2, { status: 'failed', verdict: { outcome: 'fail', reason: 'no', checks: [], decidedAt: '' } });
    expect(shape(listFor([conflicted(), failed], { resolvers: { t1: 'r1' } })).map((e) => [e.kind, e.id])).toEqual([['failed', 'failed:r1:0']]);
    expect(shape(listFor([conflicted(), task('r1', 2)], { resolvers: { t1: 'r1' }, onHold: { r1: 'stopped' } })).map((e) => e.kind)).toEqual(['on-hold']);
  });

  it('offers to start a resolver nothing will start, and never a second one', () => {
    const [listed] = listFor([conflicted(), task('r1', 2, { status: 'approved' })], { resolvers: { t1: 'r1' }, run: closed });

    expect(listed).toMatchObject({ kind: 'conflict', resolver: 'r1', task: { id: 't1' } });
    expect(listed.options.map((o) => o.id)).toEqual(['start-resolver', 'retry', 'skip', 'complete']);
    expect(escalationAct(listed, 'start-resolver')).toEqual({ kind: 'command', command: { command: 'run_task', task: 'r1' } });
  });
});

describe('an escalation\'s other fields', () => {
  it('names its task, attempt, approval and reason, and has no deadline or default', () => {
    const [only] = listFor([task('t1', 1, { status: 'in_progress' })], { live: ['t1'], attempts: { t1: 2 }, approvals: [runnerRequest('ap-1', 't1')] });
    expect(only).toEqual({
      id: 'approval:t1:2:ap-1',
      kind: 'approval',
      task: { id: 't1', ref: '#1', title: 'Task t1' },
      attempt: 2,
      approval: 'ap-1',
      reason: 'Its runner asks: rm -rf build',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny', note: 'optional' },
      ],
    });
  });

  it('carries the whole checkpoint question as its reason', () => {
    const [only] = listFor([task('t1', 1, { status: 'awaiting_user', awaitingReason: 'checkpoint' })], { live: ['t1'], checkpoints: { t1: 'Ship it?' }, run: { advancing: true } });
    expect(only.reason).toBe('Checkpoint: Ship it?');
  });

  it('asks before an AI task is marked complete, and not before a manual one is', () => {
    const [ai] = listFor([task('t1', 1, { status: 'awaiting_user', awaitingReason: 'files-changed', ops: true })]);
    expect(ai.options.find((o) => o.id === 'complete')?.confirm).toMatch(/^Mark task #1 "Task t1" complete\? You vouch/);
    const [manual] = listFor([task('t1', 1, { type: 'user' })]);
    expect(manual.options.find((o) => o.id === 'complete')?.confirm).toBeUndefined();
  });
});

describe('what an id names', () => {
  const ids = (tasks: Task[], setup: Setup = {}) => listFor(tasks, setup).map((e) => e.id);
  const waiting = (over: Partial<Task> = {}) => [task('t1', 1, { status: 'awaiting_user', awaitingReason: 'input', ...over })];

  it('adds the waits the attempt has ended, and nothing for its first', () => {
    expect(ids(waiting(), { attempts: { t1: 1 } })).toEqual(['input:t1:1']);
    expect(ids(waiting({ waitsEnded: 2 }), { attempts: { t1: 1 } })).toEqual(['input:t1:1:2']);
  });

  it('adds them to a wait with no attempt, and a task waiting for approval again', () => {
    expect(ids([task('t1', 1, { type: 'user', waitsEnded: 2 })])).toEqual(['by-hand:t1:0:2']);
    expect(ids([task('t1', 1, { waitsEnded: 1 })], { added: ['t1'] })).toEqual(['unapproved:t1:0:1']);
  });

  it('names what a merge gate waits to have merged, so another gate is another wait', () => {
    const gated = [task('t1', 1, { status: 'completed' }), task('t2', 2, { type: 'script', commands: [['npm', 'publish']], dependencies: ['t1'] })];
    const merge: RunMergeView = { waitingAtGate: true, paused: false, repos: [], landed: [{ taskId: 't1', order: 1, title: 'Task t1' }] };
    const first = ids(gated, { unmerged: ['t1'], attempts: { t1: 1 }, run: { merge, id: 'r1' } });
    const retried = ids(gated, { unmerged: ['t1'], attempts: { t1: 2 }, run: { merge, id: 'r1' } });

    expect(first).toEqual(['merge-gate:t2:0:4db5deff3c79']);
    expect(retried).toEqual(['merge-gate:t2:0:19bbd5473f96']);
  });

  it('keeps the attempt alone in naming a run\'s own waits', () => {
    expect(ids([], { run: { blocked: 3 } })).toEqual(['blocked-run:3']);
  });
});

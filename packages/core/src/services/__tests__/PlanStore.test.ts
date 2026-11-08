import { describe, it, expect, beforeEach } from 'vitest';
import { PlanStore } from '../PlanStore';
import { createTask } from '../../models/Task';
import { blockingFailures } from '../blocking';
import type { Task, TaskSnapshot } from '../../models/Task';

function makeSnapshot(taskId: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  const task = createTask({ id: taskId, title: taskId });
  return {
    ...task,
    completedAt: 1700000000000,
    retryCount: 0,
    finalized: false,
    ...overrides,
  };
}

describe('PlanStore execution log', () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it('starts with an empty execution log', () => {
    expect(store.getExecutionLog()).toEqual([]);
  });

  describe('appendToLog', () => {
    it('appends a snapshot to the log', () => {
      const snap = makeSnapshot('task-1');
      store.appendToLog(snap);
      expect(store.getExecutionLog()).toHaveLength(1);
      expect(store.getExecutionLog()[0].id).toBe('task-1');
    });

    it('deduplicates by task ID keeping the latest', () => {
      const first = makeSnapshot('task-1', { completedAt: 1, retryCount: 0 });
      const second = makeSnapshot('task-1', { completedAt: 2, retryCount: 1, finalized: true });
      store.appendToLog(first);
      store.appendToLog(second);
      expect(store.getExecutionLog()).toHaveLength(1);
      expect(store.getExecutionLog()[0].completedAt).toBe(2);
      expect(store.getExecutionLog()[0].retryCount).toBe(1);
    });

    it('keeps snapshots for different task IDs', () => {
      store.appendToLog(makeSnapshot('task-1'));
      store.appendToLog(makeSnapshot('task-2'));
      expect(store.getExecutionLog()).toHaveLength(2);
    });
  });

  describe('clearLog', () => {
    it('resets the execution log', () => {
      store.appendToLog(makeSnapshot('task-1'));
      expect(store.getExecutionLog()).toHaveLength(1);
      store.clearLog();
      expect(store.getExecutionLog()).toEqual([]);
    });
  });

  describe('load preserves execution log', () => {
    it('rebuilds taskMap but does not clear the execution log', () => {
      store.appendToLog(makeSnapshot('task-1'));
      const task = createTask({ id: 'task-a', title: 'A' });
      store.load([task], ['claude-code']);

      expect(store.get('task-a')).toBeDefined();
      expect(store.getExecutionLog()).toHaveLength(1);
      expect(store.getExecutionLog()[0].id).toBe('task-1');
    });
  });

  describe('structural removals leave no terminal record behind', () => {
    it('remove() leaves no completed record behind', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1' });
      const t2 = createTask({ id: 't2', title: 'Task 2' });
      store.load([t1, t2], ['claude-code']);
      store.markCompleted('t1');

      store.remove('t1');

      expect(store.isCompleted('t1')).toBe(false);
      expect(store.completedCount).toBe(0);
    });

    it('remove() leaves no failed record behind', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1' });
      const t2 = createTask({ id: 't2', title: 'Task 2' });
      store.load([t1, t2], ['claude-code']);
      store.markFailed('t1');

      store.remove('t1');

      expect(store.isFailed('t1')).toBe(false);
      expect(store.isAnyFailed()).toBe(false);
    });

    it('remove() releases a dependent that was blocked on the removed task', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1', status: 'failed' });
      const t2 = createTask({ id: 't2', title: 'Task 2', dependencies: ['t1'] });
      store.load([t1, t2], ['claude-code']);
      store.markFailed('t1');
      expect(blockingFailures(store.allTasks).has('t2')).toBe(true);

      store.remove('t1');

      expect(blockingFailures(store.allTasks).has('t2')).toBe(false);
      expect(store.get('t2')!.dependencies).toEqual([]);
    });
  });
});

describe('PlanStore.load — a saved blocked status', () => {
  // Files written before ADR-0034 may hold 'blocked'; nothing stores it now,
  // so it reads as the task that was waiting, not a status with no way out.
  const saved = (id: string, extra: Partial<Task> = {}): Task => ({ ...createTask({ id, title: id, ...extra }), status: 'blocked' } as unknown as Task);

  it('reads a stored blocked task, top-level or subtask, as pending', () => {
    const parent = { ...saved('p'), subtasks: [saved('s', { dependencies: ['x'] })] } as Task;
    const store = new PlanStore();
    store.load([createTask({ id: 'x', title: 'x', status: 'completed' }), parent], ['claude-code']);

    expect(store.get('p')!.status).toBe('pending');
    expect(store.get('s')!.status).toBe('pending');
  });

  it('leaves the blocked rule to the plan: a completed dependency does not block, a failed one does', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'a', title: 'a', status: 'completed' }), saved('b', { dependencies: ['a'] })], ['claude-code']);
    expect(blockingFailures(store.allTasks).has('b')).toBe(false);

    store.markFailed('a');
    expect([...blockingFailures(store.allTasks).keys()]).toEqual(['b']);
  });
});

describe('PlanStore.resetForRun', () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it('flips AI tasks to approved but preserves completed ones by default', () => {
    store.load([
      createTask({ id: 'a', title: 'A', status: 'completed' }),
      createTask({ id: 'b', title: 'B', status: 'pending' }),
      createTask({ id: 'c', title: 'C', status: 'failed' }),
    ], ['claude-code']);

    store.resetForRun();

    expect(store.get('a')!.status).toBe('completed');
    expect(store.get('b')!.status).toBe('approved');
    expect(store.get('c')!.status).toBe('approved');
  });

  it('re-approves everything for a fresh plan commit with preserveCompleted: false', () => {
    store.load([
      createTask({ id: 'a', title: 'A', status: 'completed' }),
      createTask({ id: 'b', title: 'B', status: 'pending' }),
    ], ['claude-code']);
    // load() records 'a' as completed; a fresh commit starts the run over.
    store.resetForRun({ preserveCompleted: false });

    expect(store.get('a')!.status).toBe('approved');
    expect(store.isCompleted('a')).toBe(false);
    expect(store.completedCount).toBe(0);
    expect(store.get('b')!.status).toBe('approved');
  });

  it('leaves user tasks untouched', () => {
    store.load([
      createTask({ id: 'a', title: 'A', type: 'user', status: 'pending' }),
      createTask({ id: 'b', title: 'B', status: 'pending' }),
    ], ['claude-code']);

    store.resetForRun();

    expect(store.get('a')!.status).toBe('pending');
    expect(store.get('b')!.status).toBe('approved');
  });

  // Bug: Execute cleared a hand-picked few of the attempt's fields, so a task it readied kept the verdict, the force start and the question of the attempt before.
  it.each<[string, (s: PlanStore) => void]>([
    ['resetForRun', (s) => s.resetForRun()],
    ['readyFailed', (s) => s.readyFailed(() => false)],
  ])('%s readies a task from nothing its last attempt earned, but the hold and carry-over it is still owed', (_name, ready) => {
    store.load([{
      ...createTask({ id: 't', title: 'T', assignedRunner: 'claude-code' }),
      status: 'failed',
      verdict: { outcome: 'fail', reason: 'no', checks: [], decidedAt: 'now' },
      handoff: { summary: 'Half.', findings: [], findingCount: 0 },
      outputSummary: { reviewReason: 'half', logTail: '', capturedAt: 'now' },
      forcedPastGate: ['Earlier work'],
      parkedQuestion: 'Which one?',
      carriedFrom: 'codex',
      reverted: true,
      runnerSessionId: 'session-1',
      attempted: true,
    }], ['claude-code', 'codex']);

    ready(store);

    const task = store.get('t')!;
    expect(task).toMatchObject({ status: 'approved', carriedFrom: 'codex', reverted: true, runnerSessionId: 'session-1', attempted: true });
    for (const field of ['verdict', 'handoff', 'outputSummary', 'forcedPastGate', 'parkedQuestion'] as const) expect(task, field).not.toHaveProperty(field);
  });
});

describe('PlanStore completion and failure have one source', () => {
  function expectConsistent(store: PlanStore): void {
    for (const t of store.allTasks) {
      expect(store.isCompleted(t.id), `isCompleted(${t.id})`).toBe(t.status === 'completed');
      expect(store.isFailed(t.id), `isFailed(${t.id})`).toBe(t.status === 'failed');
    }
    expect(store.completedCount).toBe(store.allTasks.filter((t) => t.status === 'completed').length);
    expect(store.failedCount).toBe(store.allTasks.filter((t) => t.status === 'failed').length);
    expect(store.isAnyFailed()).toBe(store.allTasks.some((t) => t.status === 'failed'));
    expect(store.isAllComplete()).toBe(store.allTasks.every((t) => t.status === 'completed'));
  }

  function plan(): Task[] {
    return [
      createTask({ id: 'a', title: 'A', status: 'completed' }),
      createTask({ id: 'b', title: 'B', status: 'failed', dependencies: ['a'] }),
      createTask({ id: 'c', title: 'C', status: 'pending', dependencies: ['b'] }),
      createTask({ id: 'd', title: 'D', type: 'user', status: 'completed' }),
      createTask({ id: 'e', title: 'E', status: 'pending' }),
    ];
  }

  const ops: [string, (store: PlanStore) => void][] = [
    ['load', () => {}],
    ['markCompleted', (s) => s.markCompleted('c')],
    ['markFailed', (s) => s.markFailed('a')],
    ['markInProgress', (s) => { s.markCompleted('e'); s.markInProgress('e'); }],
    ['markPending', (s) => { s.markFailed('e'); s.markPending('e'); }],
    ['markAwaitingUser', (s) => { s.markCompleted('e'); s.markAwaitingUser('e'); }],
    ['retry', (s) => { s.markFailed('b'); s.retry('b'); }],
    ['remove', (s) => s.remove('a')],
    ['update', (s) => s.update('a', { title: 'A2' })],
    ['resetForRun (preserve)', (s) => { s.markFailed('e'); s.resetForRun(); }],
    ['resetForRun (fresh)', (s) => { s.markFailed('e'); s.resetForRun({ preserveCompleted: false }); }],
  ];

  it.each(ops)('agrees with task.status after %s', (_name, op) => {
    const store = new PlanStore();
    store.load(plan(), ['claude-code']);
    op(store);
    expectConsistent(store);
  });

  // generatePlan loads a new plan and then resets it fresh. A completed id the
  // new plan reuses must not stay "done" for its dependents while its own
  // status says it is ready to run again.
  it('does not leave a reused completed id satisfying dependents after a fresh reset', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'x', title: 'X', status: 'completed' })], ['claude-code']);
    store.load([
      createTask({ id: 'x', title: 'X again', status: 'completed' }),
      createTask({ id: 'y', title: 'Y', dependencies: ['x'] }),
    ], ['claude-code']);

    store.resetForRun({ preserveCompleted: false });

    expect(store.get('x')!.status).toBe('approved');
    expect(store.isCompleted('x')).toBe(false);
    expectConsistent(store);
  });

  it('notifies after resetForRun like the other structural ops', () => {
    const store = new PlanStore();
    store.load(plan(), ['claude-code']);
    let calls = 0;
    store.onMutate = () => { calls++; };
    store.resetForRun();
    expect(calls).toBe(1);
  });
});

describe('PlanStore keeps an awaiting reason only while the task waits', () => {
  function waiting(): PlanStore {
    const store = new PlanStore();
    store.load([createTask({ id: 'a', title: 'A', status: 'in_progress' })], ['claude-code']);
    store.markAwaitingUser('a', 'input');
    return store;
  }

  it('saves the reason with the status', () => {
    expect(waiting().get('a')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
  });

  it('replaces the reason on a new wait, and a wait with none leaves none', () => {
    const store = waiting();
    store.markAwaitingUser('a', 'checkpoint');
    expect(store.get('a')!.awaitingReason).toBe('checkpoint');
    store.markAwaitingUser('a');
    expect(store.get('a')!).not.toHaveProperty('awaitingReason');
  });

  it.each<[string, (store: PlanStore) => void]>([
    ['markInProgress', (s) => s.markInProgress('a')],
    ['markCompleted', (s) => s.markCompleted('a')],
    ['markFailed', (s) => s.markFailed('a')],
    ['markPending', (s) => s.markPending('a')],
    ['retry', (s) => s.retry('a')],
  ])('drops it on %s', (_name, op) => {
    const store = waiting();
    op(store);
    expect(store.get('a')!).not.toHaveProperty('awaitingReason');
  });
});

describe('PlanStore owns its tasks', () => {
  it('load() changes neither the caller\'s array nor its task objects', () => {
    const tasks = [
      createTask({ id: 'a', title: 'A', status: 'failed', subtasks: [createTask({ id: 'a1', title: 'A1', status: 'failed' })] }),
      createTask({ id: 'b', title: 'B', dependencies: ['a'] }),
    ];
    const before = structuredClone(tasks);
    const store = new PlanStore();

    store.load(tasks, ['claude-code']);
    store.markCompleted('b');
    store.setTaskVerdict('b', { outcome: 'pass', reason: 'r', checks: [], decidedAt: 'now' });
    store.markFailed('a1');
    store.remove('a');

    expect(tasks).toEqual(before);
    expect(store.get('b')!.status).toBe('completed');
  });

  it('keeps its own view when a returned array is changed', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'a', title: 'A' })], ['claude-code']);

    // @ts-expect-error — the getters hand out readonly views
    expect(() => store.planTasks.push(createTask({ id: 'z', title: 'Z' }))).toThrow();
    // @ts-expect-error — the getters hand out readonly views
    expect(() => store.allTasks.pop()).toThrow();
    expect(store.allTasks.map((t) => t.id)).toEqual(['a']);
  });

  it('hands out snapshots that later status changes do not reach', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'a', title: 'A' })], ['claude-code']);
    const snap = store.snapshot();

    store.markCompleted('a');
    expect(snap[0].status).toBe('pending');

    snap[0].status = 'failed';
    expect(store.get('a')!.status).toBe('completed');
  });

  it('keeps in a snapshot the usage it was taken with, sharing it rather than copying it', () => {
    const store = new PlanStore();
    const usage = { attempt: 1, runner: 'claude-code', startedAt: '2026-01-01T00:00:00.000Z', wallTimeMs: 0, totals: { inputTokens: 5 }, byModel: [] };
    store.load([createTask({ id: 'a', title: 'A', attemptUsage: [usage] })], ['claude-code']);
    const snap = store.snapshot();
    expect(store.snapshot()[0].attemptUsage).toBe(snap[0].attemptUsage);

    store.recordAttemptUsage('a', 1, { source: 'test', model: 'm', inputTokens: 7 }, '2026-01-01T00:00:01.000Z');
    store.startAttemptUsage('a', 2, 'claude-code', '2026-01-01T00:00:02.000Z');
    store.endAttemptUsage('a', 1, '2026-01-01T00:00:03.000Z');

    expect(snap[0].attemptUsage).toEqual([usage]);
    expect(store.get('a')!.attemptUsage).toHaveLength(2);
    expect(store.get('a')!.attemptUsage![0].totals.inputTokens).toBe(12);
  });
});

describe('PlanStore.load of a plan with a task on a runner outside its set', () => {
  it('throws and keeps the plan it held', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'kept', order: 1, title: 'Kept', assignedRunner: 'claude-code' })], ['claude-code']);

    expect(() => store.load([createTask({ id: 'n1', order: 1, title: 'Foreign', assignedRunner: 'codex' })], ['claude-code']))
      .toThrow('not in the plan\'s runner set');

    expect(store.allTasks.map((t) => t.id)).toEqual(['kept']);
    expect(store.get('n1')).toBeUndefined();
  });
});

describe('PlanStore counts the waits a task has ended (ADR-0053)', () => {
  const load = (status: Task['status'] = 'pending') => {
    const store = new PlanStore();
    store.load([{ ...createTask({ id: 't', title: 't' }), status }], ['claude-code']);
    return store;
  };

  it('counts none for work under way that reaches its first wait', () => {
    const store = load('in_progress');
    store.markAwaitingUser('t', 'checkpoint');
    expect(store.get('t')?.waitsEnded).toBeUndefined();
  });

  it('counts each wait a task moves off, within an attempt', () => {
    const store = load('in_progress');
    store.markAwaitingUser('t', 'input');
    store.markInProgress('t');
    store.markAwaitingUser('t', 'input');
    store.markInProgress('t');
    expect(store.get('t')?.waitsEnded).toBe(2);
  });

  it('counts nothing for a task told again what it is already waiting on', () => {
    const store = load('in_progress');
    store.markAwaitingUser('t', 'conflict');
    store.markAwaitingUser('t', 'conflict');
    expect(store.get('t')?.waitsEnded).toBeUndefined();
  });

  it('counts a task taken back and done again, which has no attempt to tell them apart', () => {
    const store = load();
    store.markCompleted('t');
    store.retry('t');
    expect(store.get('t')?.waitsEnded).toBe(2);
  });

  it('starts over with an attempt, whose number tells its waits apart', () => {
    const store = load('in_progress');
    store.markAwaitingUser('t', 'input');
    store.markInProgress('t');
    store.markFailed('t');
    store.retry('t');
    store.markAttemptStarted('t');
    expect(store.get('t')).toMatchObject({ status: 'in_progress' });
    expect(store.get('t')?.waitsEnded).toBeUndefined();
  });
});

describe('PlanStore.retry', () => {
  it('starts a fresh attempt from nothing it earned, its record of having run kept', () => {
    const store = new PlanStore();
    store.load([{
      ...createTask({ id: 't', title: 'T', assignedRunner: 'claude-code' }),
      status: 'completed',
      verdict: { outcome: 'pass', reason: 'ok', checks: [], decidedAt: 'now' },
      handoff: { summary: 'Done.', findings: [], findingCount: 0 },
      forcedPastGate: ['Earlier work'],
      carriedFrom: 'codex',
      loopRound: 2,
      runnerSessionId: 'session-1',
      attempted: true,
    }], ['claude-code', 'codex']);

    store.retry('t');

    const task = store.get('t')!;
    expect(task).toMatchObject({ status: 'pending', runnerSessionId: 'session-1', attempted: true });
    for (const field of ['verdict', 'handoff', 'forcedPastGate', 'carriedFrom', 'loopRound'] as const) expect(task[field], field).toBeUndefined();
  });

  it('keeps a loop\'s round on a resume after a usage limit (ADR-0045 L7)', () => {
    const store = new PlanStore();
    store.load([{ ...createTask({ id: 't', title: 'T', assignedRunner: 'claude-code' }), status: 'awaiting_user', awaitingReason: 'usage-limit', loopRound: 2 }], ['claude-code']);
    store.retry('t', { sameRound: true });
    expect(store.get('t')).toMatchObject({ status: 'pending', loopRound: 2 });
    expect(store.get('t')).not.toHaveProperty('awaitingReason');
  });
});

describe('PlanStore.revision', () => {
  const record = { inputTokens: 1 } as unknown as Parameters<PlanStore['recordAttemptUsage']>[2];

  function loaded() {
    const store = new PlanStore();
    store.load([
      createTask({ id: 'a', title: 'A', status: 'awaiting_user', awaitingReason: 'usage-limit', attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: 'then', wallTimeMs: 0, totals: {}, byModel: [] }] }),
      createTask({ id: 'b', title: 'B' }),
    ], ['claude-code']);
    return store;
  }

  // Each write a save or a status has to hear of: one left off this list, and off the counter, is a change the disk never gets.
  const writes: Array<[string, (store: PlanStore) => void]> = [
    ['add', (s) => s.add({ title: 'C' })],
    ['remove', (s) => s.remove('b')],
    ['update', (s) => s.update('b', { title: 'B2' })],
    ['resetForRun', (s) => s.resetForRun()],
    ['readyFailed', (s) => { s.markFailed('b'); const after = s.revision; s.readyFailed(() => false); expect(s.revision).toBeGreaterThan(after); }],
    ['releaseMadeManual', (s) => s.releaseMadeManual()],
    ['markCompleted', (s) => s.markCompleted('b')],
    ['markFailed', (s) => s.markFailed('b')],
    ['markSkipped', (s) => s.markSkipped('b', 'no')],
    ['markInProgress', (s) => s.markInProgress('b')],
    ['markAttempted', (s) => s.markAttempted('b')],
    ['markAttemptStarted', (s) => s.markAttemptStarted('b')],
    ['parkQuestion', (s) => s.parkQuestion('b', 'why?')],
    ['markAwaitingUser', (s) => s.markAwaitingUser('b', 'usage-limit')],
    ['setTaskResumeAt', (s) => s.setTaskResumeAt('a', 'later')],
    ['markPending', (s) => s.markPending('a')],
    ['retry', (s) => s.retry('a')],
    ['markReverted', (s) => s.markReverted('a')],
    ['startRoundsOver', (s) => s.startRoundsOver('a')],
    ['repeat', (s) => s.repeat('a')],
    ['setForcedPastGate', (s) => s.setForcedPastGate('a', ['b'])],
    ['endWait', (s) => s.endWait('a')],
    ['setTaskVerdict', (s) => s.setTaskVerdict('a', { outcome: 'pass' } as Task['verdict'])],
    ['setTaskOutputSummary', (s) => s.setTaskOutputSummary('a', undefined)],
    ['setTaskRunnerSessionId', (s) => s.setTaskRunnerSessionId('a', 'native', 'claude-code')],
    ['setCarriedFrom', (s) => s.setCarriedFrom('a', 'codex')],
    ['clearCarriedFrom', (s) => s.clearCarriedFrom('a')],
    ['startAttemptUsage', (s) => s.startAttemptUsage('b', 1, 'claude-code', 'now')],
    ['recordAttemptUsage', (s) => s.recordAttemptUsage('a', 1, record, 'now')],
    ['endAttemptUsage', (s) => s.endAttemptUsage('a', 1, 'now')],
    ['setTaskAttemptSkills', (s) => s.setTaskAttemptSkills('a', [])],
    ['load', (s) => s.load([createTask({ id: 'z', title: 'Z' })], ['claude-code'])],
  ];

  it.each(writes)('moves on %s', (_name, write) => {
    const store = loaded();
    const before = store.revision;

    write(store);

    expect(store.revision).toBeGreaterThan(before);
  });

  it('stays put for what only reads', () => {
    const store = loaded();
    const before = store.revision;

    store.snapshot();
    store.statusMark();
    store.get('a');
    store.isOps('a');
    store.isFinished();

    expect(store.revision).toBe(before);
  });

  it('reads a new status mark after a write, and the same one with none', () => {
    const store = loaded();
    const mark = store.statusMark();

    expect(store.statusMark()).toBe(mark);
    store.markCompleted('b');
    expect(store.statusMark()).not.toBe(mark);
  });
});

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * The run's transitions as the orchestrator takes them (`nextRunState`), and
 * the run verbs a Session calls: `beginRun`, `joinRun` and `adoptEdit`.
 */

const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";
const NOW = new Date('2026-10-11T17:00:00Z');
const RESUME_AT = '2026-10-11T20:11:00.000Z';

function setup() {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${sessions.length + 1}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions: 3 }),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    runSettings: () => ({ mergeAtGatesAutomatically: false }),
  });
  const events: string[] = [];
  orchestrator.subscribe({ onExecutionComplete: () => events.push('complete') });
  const task = (id: string): Readonly<Task> => orchestrator.storeInstance.get(id)!;
  const spawned = () => runner.spawn.mock.calls.map(([o]) => o.taskId);
  const session = (taskId: string) => [...sessions].reverse().find((s) => s.taskId === taskId)!;
  return { orchestrator, events, task, spawned, session };
}

function hitLimitInTurn(session: FakeRunnerSession): void {
  session.emitEvent({ type: 'error', message: LIMIT });
  session.emitOutput(`${LIMIT}\n`);
  session.emitTurnEnd('failed');
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) await flushMicrotasks();
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A run ended on a failure: `t1` failed, `t2` waits on it, and `t3` is on another runner. */
async function endedOnFailure() {
  const ctx = setup();
  ctx.orchestrator.loadPlan([
    createTask({ id: 't1', order: 1, title: 'Fails', prompt: 'do first', assignedRunner: 'codex' }),
    createTask({ id: 't2', order: 2, title: 'Blocked', prompt: 'do second', dependencies: ['t1'] }),
  ], ['claude-code', 'codex']);
  await ctx.orchestrator.approveReview();
  ctx.session('t1').reportComplete({ status: 'failed', summary: 'could not' });
  await until(() => ctx.events.includes('complete'));
  expect(ctx.orchestrator.awaitsResume).toBe(true);
  expect(ctx.orchestrator.isScheduling).toBe(false);
  ctx.events.length = 0;
  return ctx;
}

describe('a task started alone in a run that ended on a failure, paused on a usage limit', () => {
  it('holds the run open with no end said, and at the reset goes on alone and ends the run once', async () => {
    const { orchestrator, events, task, spawned, session } = await endedOnFailure();
    await orchestrator.forceStartTask('t2');
    hitLimitInTurn(session('t2'));
    await until(() => task('t2').status === 'awaiting_user');
    await flushMicrotasks();

    // The pause holds the run it came to, however that run stood (ADR-0018 U1).
    expect(orchestrator.runs.isOpen).toBe(true);
    expect(events).toEqual([]);
    expect(orchestrator.awaitsResume).toBe(true);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawned().length === 3);
    session('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => task('t2').status === 'completed');
    await flushMicrotasks();

    expect(spawned()).toEqual(['t1', 't2', 't2']);
    expect(events).toEqual(['complete']);
    // Still the run a retry of the failed task continues.
    expect(orchestrator.isScheduling).toBe(false);
    expect(orchestrator.awaitsResume).toBe(true);
  });

  it('stays held through a retry of the failure, and the reset gives back the plan\'s run', async () => {
    const { orchestrator, task, spawned, session } = await endedOnFailure();
    await orchestrator.forceStartTask('t2');
    hitLimitInTurn(session('t2'));
    await until(() => task('t2').status === 'awaiting_user');

    await orchestrator.retryTask('t1');
    await flushMicrotasks();
    // Held: nothing new starts, even on the runner with no limit.
    expect(spawned()).toEqual(['t1', 't2']);
    expect(orchestrator.isScheduling).toBe(false);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawned().length === 4);
    expect(orchestrator.isScheduling).toBe(true);
    expect(spawned().slice(2).sort()).toEqual(['t1', 't2']);
  });
});

describe('beginRun', () => {
  it('starts afresh from a held run with nothing at work, its paused task with it', async () => {
    const { orchestrator, task, spawned, session } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' })]);
    await orchestrator.approveReview();
    hitLimitInTurn(session('t1'));
    await until(() => task('t1').status === 'awaiting_user');
    expect(orchestrator.awaitsResume).toBe(true);

    await orchestrator.beginRun('user');

    expect(orchestrator.isScheduling).toBe(true);
    expect(orchestrator.awaitsResume).toBe(false);
    expect(task('t1')).toMatchObject({ status: 'in_progress' });
    expect(task('t1').resumeAt).toBeUndefined();
    expect(spawned()).toEqual(['t1', 't1']);
    // The old reset resumes nothing: the run begun has already started it.
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    expect(spawned()).toEqual(['t1', 't1']);
  });

  it('gives a failed task a fresh start and clears the execution log', async () => {
    const { orchestrator, spawned } = await endedOnFailure();
    expect(orchestrator.storeInstance.getExecutionLog().length).toBeGreaterThan(0);

    await orchestrator.beginRun('user');

    expect(orchestrator.isScheduling).toBe(true);
    expect(orchestrator.storeInstance.getExecutionLog()).toEqual([]);
    expect(spawned()).toEqual(['t1', 't1']);
  });

  it('ends at once, finished, when nothing is left to run', async () => {
    const { orchestrator, events, session, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Done', prompt: 'do first' })]);
    await orchestrator.approveReview();
    session('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => task('t1').status === 'completed');
    await flushMicrotasks();
    events.length = 0;

    await orchestrator.beginRun('user');

    expect(orchestrator.status).toBe('completed');
    expect(events).toContain('complete');
  });
});

describe('a task stopped on its own', () => {
  const HELD = 'cancelled; retry or force start to run it again';

  /** `t1` was cancelled while the run was going; `t2` is independent and still running. */
  async function stoppedOne() {
    const ctx = setup();
    ctx.orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Audit', prompt: 'audit' }),
      createTask({ id: 't2', order: 2, title: 'Other', prompt: 'other' }),
    ]);
    await ctx.orchestrator.approveReview();
    await ctx.orchestrator.cancelTask('t1');
    expect(ctx.orchestrator.holdReason('t1')).toBe(HELD);
    return ctx;
  }

  it('stays held when the plan is started again, and its row still says so', async () => {
    const { orchestrator, task, spawned } = await stoppedOne();

    await orchestrator.beginRun('user');

    expect(spawned()).toEqual(['t1', 't2', 't2']);
    expect(task('t1').status).not.toBe('in_progress');
    expect(orchestrator.holdReason('t1')).toBe(HELD);
  });

  it('stays held through the user\'s Stop of the whole run and the start after it', async () => {
    const { orchestrator, spawned } = await stoppedOne();

    orchestrator.stop();
    await orchestrator.beginRun('user');

    expect(spawned()).toEqual(['t1', 't2', 't2']);
    expect(orchestrator.holdReason('t1')).toBe(HELD);
  });

  it('runs again when it is retried', async () => {
    const { orchestrator, spawned } = await stoppedOne();
    await orchestrator.beginRun('user');

    await orchestrator.retryTask('t1');

    expect(orchestrator.holdReason('t1')).toBeNull();
    expect(spawned().filter((id) => id === 't1')).toHaveLength(2);
  });

  it('runs again when it is force started', async () => {
    const { orchestrator, spawned } = await stoppedOne();
    await orchestrator.beginRun('user');

    await orchestrator.forceStartTask('t1');

    expect(orchestrator.holdReason('t1')).toBeNull();
    expect(spawned().filter((id) => id === 't1')).toHaveLength(2);
  });

  it('stays held when the plan is edited and loaded as the same plan', async () => {
    const { orchestrator } = await stoppedOne();
    const tasks = orchestrator.storeInstance.planTasks.map((t) => ({ ...t, subtasks: [] }));

    orchestrator.loadPlan(tasks, ['claude-code'], true);

    expect(orchestrator.holdReason('t1')).toBe(HELD);
  });

  it('is released when a different plan is loaded', async () => {
    const { orchestrator } = await stoppedOne();
    const tasks = orchestrator.storeInstance.planTasks.map((t) => ({ ...t, subtasks: [] }));

    orchestrator.loadPlan(tasks, ['claude-code']);

    expect(orchestrator.holdReason('t1')).toBeNull();
  });
});

describe('a task marked not done', () => {
  it('stays held when the plan is started again', async () => {
    const { orchestrator, spawned } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Done', prompt: 'do', status: 'completed' })]);
    await orchestrator.markTaskIncomplete('t1');

    await orchestrator.beginRun('user');

    expect(spawned()).toEqual([]);
    expect(orchestrator.holdReason('t1')).toBe('marked not done; retry or force start to run it again');
  });
});

describe('joinRun', () => {
  it('makes tasks started on their own the plan\'s run, so what waits on them starts', async () => {
    const { orchestrator, task, spawned, session } = setup();
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Alone', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'After', prompt: 'do second', dependencies: ['t1'] }),
    ]);
    await orchestrator.forceStartTask('t1');
    expect(orchestrator.isScheduling).toBe(false);

    await orchestrator.joinRun('user');
    expect(orchestrator.isScheduling).toBe(true);
    session('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => spawned().length === 2);

    expect(spawned()).toEqual(['t1', 't2']);
    expect(task('t2').status).toBe('in_progress');
  });

  it('only ticks a run the scheduler already drives', async () => {
    const { orchestrator, spawned } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'One', prompt: 'do first' })]);
    await orchestrator.approveReview();
    await orchestrator.joinRun('user');
    expect(orchestrator.isScheduling).toBe(true);
    expect(spawned()).toEqual(['t1']);
  });
});

describe('adoptEdit', () => {
  it('loads an edit between runs as the plan the next run starts from', () => {
    const { orchestrator, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'One', prompt: 'do first' })]);
    orchestrator.adoptEdit([
      createTask({ id: 't1', order: 1, title: 'One', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Added', prompt: 'do second' }),
    ], ['claude-code']);
    expect(task('t2').status).toBe('approved');
    expect(orchestrator.isScheduling).toBe(false);
  });

  it('leaves a failed task as it stands in an edit between runs: only Execute gives it a fresh chance', () => {
    const { orchestrator, task } = setup();
    const verdict = { outcome: 'fail' as const, reason: 'broke', checks: [], decidedAt: '2026-10-31T00:00:00Z' };
    const outputSummary = { reviewReason: 'broke', logTail: '', capturedAt: '2026-10-31T00:00:00Z' };
    const failed = createTask({ id: 't1', order: 1, title: 'One', prompt: 'do first', status: 'failed', verdict, outputSummary });
    orchestrator.loadPlan([failed]);

    orchestrator.adoptEdit([{ ...failed, prompt: 'do it better' }], ['claude-code']);

    expect(task('t1')).toMatchObject({ status: 'failed', prompt: 'do it better', verdict, outputSummary });
  });

  it('reconciles an edit into a run that ended on a failure, which keeps the failure for the retry', async () => {
    const { orchestrator, task } = await endedOnFailure();
    const tasks = orchestrator.storeInstance.planTasks.map((t) => ({ ...t, subtasks: [] }));
    orchestrator.adoptEdit([...tasks, createTask({ id: 't3', order: 3, title: 'Added', prompt: 'do third' })], ['claude-code', 'codex']);

    expect(task('t1').status).toBe('failed');
    expect(orchestrator.awaitsResume).toBe(true);
    expect(orchestrator.isReviewApproved).toBe(true);
  });
});

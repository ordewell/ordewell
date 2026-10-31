import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfig, FakeRunnerSession, makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { loadSession, saveSession } from '../../utils/sessionStore';
import { blockingFailures } from '../blocking';
import type { IRunner } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { TaskOrchestrator } from '../TaskOrchestrator';

/**
 * Someone walks away, the host restarts, and they come back (ADR-0053). Each
 * case leaves a real run's plan on disk, reads it back as a new host would and
 * opens it in a new Session.
 */

const SESSION = 'session-reload';
const INTERRUPTED = 'It was interrupted when Ordewell stopped, and nothing is running it now.';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-reload-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  ({ ...createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over }), ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

function host(isolation?: FakeWorktreeIsolation, config?: Partial<IConfig>) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const session = makeSession({ isolation, ...(config ? { config: fakeConfig(config) } : {}), runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner });
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const spawned = () => spawn.mock.calls.map(([opts]) => opts.taskId);
  const start = () => session.execute({ command: 'run_plan' }, { kind: 'user' });
  const report = async (taskId: string, status: 'done' | 'failed' | 'blocked') => {
    latest(taskId).reportComplete({ status, summary: `${taskId} ${status}`, ...(status === 'done' ? {} : { reason: `${taskId} ${status}` }) });
    await vi.waitFor(() => expect(taskOf(session, taskId)?.status).toBe(status === 'done' ? 'completed' : 'failed'));
  };
  return { session, latest, spawned, start, report };
}

/** A host that ran these tasks, its first spawns under way. */
async function running(tasks: Task[], first: number, isolation?: FakeWorktreeIsolation) {
  const env = host(isolation);
  env.session.loadPlan(plan(tasks), 'goal', testWorkspace, { persist: false });
  await env.start();
  await vi.waitFor(() => expect(env.spawned()).toHaveLength(first));
  return env;
}

/** The plan as the host that ran it left it on disk, read back and opened by a new host. */
function reopened(from: ReturnType<typeof host>, isolation?: FakeWorktreeIsolation, config?: Partial<IConfig>) {
  saveSession(from.session.planState!, 'goal', dir, SESSION);
  from.session.destroy();
  const env = host(isolation, config);
  env.session.loadPlan(loadSession(SESSION, dir)!.plan, 'goal', testWorkspace, { persist: false });
  return env;
}

const blockedBy = (env: ReturnType<typeof host>, taskId: string) => blockingFailures(env.session.planTasks).get(taskId) ?? [];

describe('a repair owed through a reload (ADR-0015)', () => {
  const CONFIG = { maxParallelSessions: 1, conflictRepairAttempts: 2 };

  /** t1's second landing conflicted with t2 in the only slot, so its repair waits: then the host goes. */
  async function owed() {
    const isolation = new FakeWorktreeIsolation();
    isolation.outcomes.set('t1', 'conflict');
    const before = host(isolation, CONFIG);
    before.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', testWorkspace, { persist: false });
    await before.start();
    before.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(before.spawned()).toEqual(['t1', 't1']));
    before.latest('t1').emitExit(1);
    await vi.waitFor(() => expect(before.spawned()).toEqual(['t1', 't1', 't2']));
    await (before.session as unknown as { orchestrator: TaskOrchestrator }).orchestrator.markTaskComplete('t1');
    expect(taskOf(before.session, 't1')?.status).toBe('pending');
    expect(before.session.escalations()).toEqual([]);
    return { before, isolation };
  }

  it('lists the conflict after the load: nothing starts the repair now, so it waits on the user', async () => {
    const { before, isolation } = await owed();

    const env = reopened(before, isolation, CONFIG);

    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' });
    const listed = env.session.escalations().find((e) => e.task?.id === 't1');
    expect(listed).toMatchObject({ kind: 'conflict' });
    expect(listed?.options.map((o) => o.id)).toEqual(['resolve-conflict', 'retry', 'skip', 'complete']);
    expect(env.spawned()).toEqual([]);
    env.session.destroy();
  });

  it('repairs it at the next Execute, with the repair the record has left', async () => {
    const { before, isolation } = await owed();
    const env = reopened(before, isolation, CONFIG);

    await env.start();

    await vi.waitFor(() => expect(env.spawned()).toContain('t1'));
    expect(isolation.taskIdsFor('reopen')).toEqual(['t1', 't1']);
    env.session.destroy();
  });

  it('takes a resolver added after the load, and starts it', async () => {
    const { before, isolation } = await owed();
    const env = reopened(before, isolation, CONFIG);

    await env.session.resolveConflictAsTask('t1');

    const resolver = env.session.planTasks.at(-1)!;
    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));
    env.session.destroy();
  });
});

describe('a failed task through a reload', () => {
  it('stays failed with its verdict and report, keeps its dependents blocked and stays in the inbox', async () => {
    const before = await running([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3)], 2);
    await before.report('t1', 'failed');
    await before.report('t3', 'done');

    const env = reopened(before);

    expect(taskOf(env.session, 't1')).toMatchObject({
      status: 'failed',
      verdict: { outcome: 'fail', reason: 'The runner reported the task failed: t1 failed', reported: 'failed' },
      outputSummary: { reviewReason: 'The runner reported the task failed: t1 failed' },
    });
    expect(blockedBy(env, 't2')).toEqual(['t1']);
    expect(env.session.escalations()).toEqual([expect.objectContaining({
      id: 'failed:t1:1',
      kind: 'failed',
      reason: 'The runner reported the task failed: t1 failed',
    })]);
    expect(env.session.escalations()[0].options.map((o) => o.id)).toEqual(['retry', 'continue', 'skip', 'complete']);
    expect(env.spawned()).toEqual([]);
    env.session.destroy();
  });

  it('answers Retry after the load: that one task runs again, and its pass lifts the block', async () => {
    const before = await running([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], 1);
    await before.report('t1', 'failed');
    const env = reopened(before);

    expect(await env.session.answerEscalation('failed:t1:1', 'retry')).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(env.spawned()).toEqual(['t1']));
    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'in_progress', verdict: undefined });
    expect(env.session.escalations()).toEqual([]);
    await env.report('t1', 'done');
    expect(blockedBy(env, 't2')).toEqual([]);
    expect(env.spawned()).toEqual(['t1']);
    env.session.destroy();
  });

  it('gets its fresh chance from Execute: it runs again, and then what it blocked', async () => {
    const before = await running([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], 1);
    await before.report('t1', 'failed');
    const env = reopened(before);

    expect(await env.start()).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(env.spawned()).toEqual(['t1']));
    expect(env.session.escalations()).toEqual([]);
    await env.report('t1', 'done');
    await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't2']));
    env.session.destroy();
  });

  it('leaves the failure alone when the user force-starts what it blocks', async () => {
    const before = await running([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], 1);
    await before.report('t1', 'failed');
    const env = reopened(before);

    expect(await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' })).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(env.spawned()).toEqual(['t2']));
    expect(taskOf(env.session, 't1')?.status).toBe('failed');
    expect(env.session.escalations().map((e) => e.id)).toEqual(['failed:t1:1']);
    env.session.destroy();
  });
});

describe('a task running when the host died', () => {
  it('is failed and listed with why, its dependents blocked, and nothing starts', async () => {
    const before = await running([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], 1);

    const env = reopened(before);

    expect(taskOf(env.session, 't1')).toMatchObject({
      status: 'failed',
      attempted: true,
      verdict: { outcome: 'fail', reason: INTERRUPTED },
    });
    expect(taskOf(env.session, 't1')?.verdict?.reported).toBeUndefined();
    expect(blockedBy(env, 't2')).toEqual(['t1']);
    expect(env.session.escalations()).toEqual([expect.objectContaining({ id: 'failed:t1:1', kind: 'failed', reason: INTERRUPTED })]);
    expect(env.spawned()).toEqual([]);
    env.session.destroy();
  });

  it('gets a new attempt from Retry, or from Execute', async () => {
    const before = await running([task('t1', 1), task('t2', 2)], 2);

    const env = reopened(before);

    expect(await env.session.answerEscalation('failed:t2:1', 'retry')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.spawned()).toEqual(['t2']));
    await env.report('t2', 'done');
    await env.start();
    await vi.waitFor(() => expect(env.spawned()).toEqual(['t2', 't1']));
    env.session.destroy();
  });

  it('gets a new attempt from Retry in an isolated run too', async () => {
    const isolation = new FakeWorktreeIsolation();
    const before = await running([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], 1, isolation);

    const env = reopened(before, isolation);
    await vi.waitFor(() => expect(env.session.planState?.isolation).toBeTruthy());

    expect(await env.session.answerEscalation('failed:t1:1', 'retry')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.spawned()).toEqual(['t1']));
    env.session.destroy();
  });

  it('counts a subtask too', async () => {
    const parent = task('parent', 1, { subtasks: [task('sub', 1)] });
    const before = await running([parent], 2);
    expect(taskOf(before.session, 'sub')?.status).toBe('in_progress');

    const env = reopened(before);

    expect(env.session.escalations().map((e) => [e.task?.id, e.reason])).toEqual([['parent', INTERRUPTED], ['sub', INTERRUPTED]]);
    env.session.destroy();
  });

  it('stops a loop as any failure does when it is a body task, and rounds start over when it is the check', async () => {
    const looped = [task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }), task('fix', 2, { dependencies: ['check'] })];
    const body = await running(looped, 1);
    await body.report('check', 'failed');
    await vi.waitFor(() => expect(body.spawned()).toEqual(['check', 'fix']));
    await body.report('fix', 'done');
    await vi.waitFor(() => expect(body.spawned()).toEqual(['check', 'fix', 'check']));

    const env = reopened(body);

    expect(taskOf(env.session, 'check')).toMatchObject({ status: 'failed', loopRound: 2, verdict: { reason: INTERRUPTED } });
    expect(env.session.escalations().map((e) => [e.kind, e.reason])).toEqual([['failed', INTERRUPTED]]);
    await env.start();
    await vi.waitFor(() => expect(env.spawned()).toEqual(['check']));
    expect(taskOf(env.session, 'check')?.loopRound).toBeUndefined();
    env.session.destroy();
  });
});

describe('a loop through a reload', () => {
  const looped = (maxRounds: number): Task[] => [
    task('check', 1, { loop: { body: ['fix'], maxRounds } }),
    task('fix', 2, { dependencies: ['check'] }),
    task('ship', 3, { dependencies: ['check'] }),
  ];

  it('keeps a check out of rounds in the inbox, and Execute starts its rounds over', async () => {
    const before = await running(looped(2), 1);
    await before.report('check', 'failed');
    await vi.waitFor(() => expect(before.spawned()).toEqual(['check', 'fix']));
    await before.report('fix', 'done');
    await vi.waitFor(() => expect(before.spawned()).toEqual(['check', 'fix', 'check']));
    await before.report('check', 'failed');

    const env = reopened(before);

    expect(taskOf(env.session, 'check')).toMatchObject({ status: 'failed', loopRound: 2 });
    expect(blockedBy(env, 'ship')).toEqual(['check']);
    expect(env.session.escalations().map((e) => [e.kind, e.reason])).toEqual([['out-of-rounds', 'Its loop ran out of rounds: it failed round 2 of 2.']]);

    await env.start();
    await vi.waitFor(() => expect(env.spawned()).toEqual(['check']));
    expect(taskOf(env.session, 'check')?.loopRound).toBeUndefined();
    env.session.destroy();
  });

  it('keeps a check that could not check failed, and Execute runs it as round 1', async () => {
    const before = await running(looped(3), 1);
    await before.report('check', 'blocked');

    const env = reopened(before);

    expect(env.session.escalations().map((e) => e.kind)).toEqual(['failed']);
    await env.start();
    await vi.waitFor(() => expect(env.spawned()).toEqual(['check']));
    expect(taskOf(env.session, 'check')?.loopRound).toBeUndefined();
    env.session.destroy();
  });

  it('leaves a check between rounds out of the inbox, and Execute goes on with its body', async () => {
    const before = await running(looped(3), 1);
    await before.report('check', 'failed');
    await vi.waitFor(() => expect(before.spawned()).toEqual(['check', 'fix']));

    const env = reopened(before);

    expect(taskOf(env.session, 'check')?.status).toBe('failed');
    await env.start();
    await vi.waitFor(() => expect(env.spawned()).toEqual(['fix']));
    env.session.destroy();
  });

  it('lists a body task that failed in place of its check, and answering Retry runs the body', async () => {
    const before = await running(looped(3), 1);
    await before.report('check', 'failed');
    await vi.waitFor(() => expect(before.spawned()).toEqual(['check', 'fix']));
    await before.report('fix', 'failed');

    const env = reopened(before);

    expect(env.session.escalations().map((e) => e.id)).toEqual(['failed:fix:1']);
    expect(await env.session.answerEscalation('failed:fix:1', 'retry')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.spawned()).toEqual(['fix']));
    env.session.destroy();
  });
});

describe('an edit of a reloaded plan outside a run', () => {
  it('leaves a failure alone', async () => {
    const before = await running([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3)], 2);
    await before.report('t1', 'failed');
    await before.report('t3', 'done');
    const env = reopened(before);

    await env.session.updateTask('t1', { prompt: 'do t1 better' });

    expect(taskOf(env.session, 't1')).toMatchObject({
      status: 'failed',
      prompt: 'do t1 better',
      verdict: { outcome: 'fail' },
      outputSummary: { reviewReason: 'The runner reported the task failed: t1 failed' },
    });
    expect(blockedBy(env, 't2')).toEqual(['t1']);
    expect(env.session.escalations().map((e) => e.id)).toEqual(['failed:t1:1']);
    env.session.destroy();
  });
});

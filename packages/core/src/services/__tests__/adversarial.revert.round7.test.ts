import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * ADR-0054: a reverted task is "pending, on a chosen hold like a stopped
 * task's", and "a retry or a force start releases it". A force start asked
 * while its dependency is still held lifts that hold only for the queued start
 * (`queueBehindDependencies`), and a Stop withdraws the queued start but not
 * the release it made: the task is left pending, unheld and not queued, so the
 * scheduler runs it once its dependency lands, which a new Execute must not do.
 */

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });
const ops = (id: string, order: number, over: Partial<Task> = {}) => task(id, order, { ops: true, ...over });

function setup(isolation = new FakeWorktreeIsolation()) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (o: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(), notifications: fakeNotification(), runner, output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => '/repo',
  });
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const status = (taskId: string) => orchestrator.storeInstance.get(taskId)!.status;
  const started = (taskId: string) => sessions.filter((s) => s.taskId === taskId).length;
  const pass = async (taskId: string) => {
    latest(taskId).reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(status(taskId)).toBe('completed'));
  };
  return { orchestrator, isolation, sessions, latest, status, started, pass };
}

describe('a reverted task behind a dependency, after a withdrawn force start', () => {
  it('is not run by the scheduler because a Stop withdrew the queued start', async () => {
    const { orchestrator, started, status, pass } = setup();
    orchestrator.loadPlan([task('A', 1), task('B', 2, { dependencies: ['A'] })]);
    await orchestrator.approveReview();
    for (const id of ['A', 'B']) {
      await vi.waitFor(() => expect(started(id)).toBeGreaterThan(0));
      await pass(id);
    }

    await orchestrator.revertTask('A');
    expect(orchestrator.holdReason('B')).toBe('reverted; retry or force start to run it again');

    // What the inbox offers a reverted task behind its dependency: force start
    // it now, and it waits for the dependency in the queue.
    await orchestrator.forceStartTask('B');
    expect(orchestrator.holdReason('B')).toBeNull();
    expect(orchestrator.startQueuedFor('B')).toBe(true);

    // A Stop withdraws the queued start.
    orchestrator.stop('user');
    expect(orchestrator.startQueuedFor('B')).toBe(false);

    // The user starts the dependency again and lets the plan run.
    await orchestrator.forceStartTask('A');
    await vi.waitFor(() => expect(started('A')).toBe(2));
    await orchestrator.joinRun('user');
    await pass('A');
    // Nothing the user asked to start after the Stop, so B stays held.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(orchestrator.holdReason('B')).toBe('reverted; retry or force start to run it again');
    expect(started('B')).toBe(1);
    expect(status('B')).toBe('pending');
  });

  it('is held again when the scheduler it was left to is stopped', async () => {
    const { orchestrator, started, pass } = setup();
    orchestrator.loadPlan([task('A', 1), task('B', 2, { dependencies: ['A'] })]);
    await orchestrator.approveReview();
    for (const id of ['A', 'B']) {
      await vi.waitFor(() => expect(started(id)).toBeGreaterThan(0));
      await pass(id);
    }
    await orchestrator.revertTask('A');
    await orchestrator.forceStartTask('A');
    await vi.waitFor(() => expect(started('A')).toBe(2));
    await orchestrator.joinRun('user');

    // With a scheduler driving the run the start is left to it, not queued.
    await orchestrator.forceStartTask('B');
    expect(orchestrator.holdReason('B')).toBeNull();
    expect(orchestrator.startQueuedFor('B')).toBe(false);

    orchestrator.stop('user');

    expect(orchestrator.holdReason('B')).toBe('reverted; retry or force start to run it again');
  });
});

/**
 * ADR-0054: "only a start asked of a task already skipped runs it again". A
 * start parked on a dirty tree was asked before the revert retired the
 * resolver, so replaying it is that start, not a new one asked of a skipped task.
 */
describe('a resolver start a dirty tree parked, replayed after the revert retired it', () => {
  async function parked(start: (env: ReturnType<typeof setup>, resolver: string) => Promise<unknown>, over: Partial<Task> = {}) {
    const env = setup();
    const { orchestrator, isolation, started, pass } = env;
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(started('t1')).toBe(1));
    await pass('t1');
    orchestrator.stop();
    await vi.waitFor(() => expect(orchestrator.runs.isOpen).toBe(false));
    const resolver = orchestrator.storeInstance.add({ title: 'Resolve', prompt: 'merge it', assignedRunner: 'claude-code', ...over });
    orchestrator.storeInstance.update(resolver.id, over.status ? { status: over.status, runnerSessionId: 'saved' } : {});
    orchestrator.runs.linkResolver(resolver.id, 't1');

    // A dirty tree parks a start only where no run goes on: its records gone, as a retry's are, over merges a revert can still take.
    const run = orchestrator.runs.current!;
    (run.landedTasks ??= {}).t1 = run.tasks.t1;
    delete run.tasks.t1;

    const blocked: string[] = [];
    orchestrator.subscribe({ onIsolationBlocked: ({ reason }) => blocked.push(reason) });
    isolation.availability = { active: false, reason: 'dirty' };
    await start(env, resolver.id);
    expect(blocked).toEqual(['dirty']);

    expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'reverted' });
    expect(orchestrator.storeInstance.get(resolver.id)).toMatchObject({ status: 'skipped' });
    isolation.availability = { active: true, repos: ['.'], shared: [] };
    return { ...env, resolver: resolver.id };
  }

  it('does not run on a force start', async () => {
    const { orchestrator, started, resolver } = await parked(({ orchestrator: o }, id) => o.forceStartTask(id));

    await expect(orchestrator.continueBlockedRun('stash')).rejects.toThrow('was skipped after this start was asked for');

    expect(started(resolver)).toBe(0);
    expect(orchestrator.storeInstance.get(resolver)).toMatchObject({ status: 'skipped' });
  });

  it('does not run on a continue', async () => {
    const { orchestrator, started, resolver } = await parked(({ orchestrator: o }, id) => o.continueTask(id, 'again'), { status: 'failed' });

    await expect(orchestrator.continueBlockedRun('stash')).rejects.toThrow('was skipped after this start was asked for');

    expect(started(resolver)).toBe(0);
    expect(orchestrator.storeInstance.get(resolver)).toMatchObject({ status: 'skipped' });
  });

  it('still runs when the start was asked of a task already skipped', async () => {
    const env = setup();
    const { orchestrator, isolation, started } = env;
    orchestrator.loadPlan([task('t1', 1), task('t2', 2)]);
    await orchestrator.skipTask('t2', 'not this one');
    isolation.availability = { active: false, reason: 'dirty' };
    await orchestrator.forceStartTask('t2');
    expect(started('t2')).toBe(0);

    isolation.availability = { active: true, repos: ['.'], shared: [] };
    await orchestrator.approveReview().catch(() => undefined);
    await orchestrator.continueBlockedRun('stash');

    await vi.waitFor(() => expect(started('t2')).toBe(1));
  });
});

/**
 * ADR-0054: a gate reads git's answer as last read, and "a saved answer goes
 * stale both ways". A merge the user takes back out has to close its gate, and
 * to keep a closing run from saying everything is merged.
 */
describe('a merge the user takes back out', () => {
  it('closes the gate of what has not started yet', async () => {
    const { orchestrator, isolation, started, pass } = setup();
    orchestrator.loadPlan([
      task('A', 1),
      ops('opened', 2, { dependencies: ['A'] }),
      task('D', 3, { dependencies: ['A'] }),
      ops('later', 4, { dependencies: ['D'] }),
    ]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(started('A')).toBe(1));
    await pass('A');
    await vi.waitFor(() => expect(started('D')).toBe(1));

    isolation.mergedByHand.add('A');
    await orchestrator.tick();
    await vi.waitFor(() => expect(started('opened')).toBe(1));
    await pass('opened');
    expect(orchestrator.runs.current?.tasks.A.inHead).toBe(true);

    isolation.mergedByHand.delete('A');
    isolation.mergedByHand.add('D');
    await pass('D');
    await vi.waitFor(() => expect(orchestrator.runs.current?.tasks.A.inHead).toBeUndefined());

    expect(started('later')).toBe(0);
    expect(orchestrator.getMergeGate('later')).toEqual(['A']);
  });

  it('keeps the run from clearing as merged, and hands the work over', async () => {
    const { orchestrator, isolation, started, pass } = setup();
    const handoffs: unknown[] = [];
    orchestrator.subscribe({ onIsolationHandoff: (handoff) => handoffs.push(handoff) });
    orchestrator.loadPlan([task('A', 1), ops('opened', 2, { dependencies: ['A'] })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(started('A')).toBe(1));
    await pass('A');
    isolation.mergedByHand.add('A');
    await orchestrator.tick();
    await vi.waitFor(() => expect(started('opened')).toBe(1));

    isolation.mergedByHand.delete('A');
    await pass('opened');
    await vi.waitFor(() => expect(handoffs).toHaveLength(1));

    expect(isolation.calls.map((c) => c.op)).not.toContain('discard');
    expect(handoffs[0]).toMatchObject({ landed: [expect.objectContaining({ taskId: 'A' })] });
  });
});

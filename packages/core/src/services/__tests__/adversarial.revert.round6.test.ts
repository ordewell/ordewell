import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * ADR-0054: "No await between these: a persist must never see the records gone
 * with the tasks not back" and "A crash does the same through pruneOrphans,
 * since the saved run still has the tasks landed". Retiring a reverted task's
 * resolver saves the run while `takeBack` is only halfway through the plan
 * changes; with a chain, the other reverted tasks are still completed.
 */

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

describe('the plan a revert saves halfway', () => {
  it('never has the records gone while the reverted task is still said to be complete', async () => {
    const isolation = new FakeWorktreeIsolation();
    const sessions: FakeRunnerSession[] = [];
    const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
      sessions.push(session);
      return session;
    });
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig({ conflictRepairAttempts: 0 }),
      notifications: fakeNotification(),
      runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner,
      output: new BufferedTaskOutputSource(),
      isolation,
      workspaceRoot: () => '/repo',
    });
    orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await orchestrator.approveReview();
    for (const id of ['t1', 't2']) {
      await vi.waitFor(() => expect(sessions.some((s) => s.taskId === id)).toBe(true));
      sessions.filter((s) => s.taskId === id).at(-1)!.reportComplete({ status: 'done', summary: '' });
      await vi.waitFor(() => expect(orchestrator.storeInstance.get(id)!.status).toBe('completed'));
    }

    // A resolver out to the dependent, which the revert retires first: that
    // retirement is a save of the run on its own (IsolationRunController.takeResolver).
    const resolver = orchestrator.storeInstance.add({ title: 'Resolve', prompt: 'merge it' });
    orchestrator.runs.linkResolver(resolver.id, 't2');

    const halfway: string[] = [];
    const off = orchestrator.subscribe({
      onIsolationChanged: () => {
        const run = orchestrator.runs.current;
        const recorded = run?.tasks.t1 !== undefined || run?.tasks.t2 !== undefined || run?.landings?.t1 !== undefined || run?.landings?.t2 !== undefined;
        const statuses = [orchestrator.storeInstance.get('t2')?.status, orchestrator.storeInstance.get('t1')?.status];
        if (!recorded && statuses.some((s) => s !== 'pending')) halfway.push(statuses.join('/'));
      },
    });
    await orchestrator.revertTask('t1');
    off();

    expect(halfway).toEqual([]);
  });
});

/**
 * ADR-0054: a revert retires a task's resolver ("its merge would land the
 * attempt the revert ends", and "so a retry is free"), and that retirement has
 * to cover a start already admitted when the revert arrives. The audit covers
 * a dependent's admitted start while the revert is still reading; a resolver
 * whose claim is delayed past the revert is the same start, later.
 */
function raceSetup() {
  const isolation = new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({}),
    notifications: fakeNotification(),
    runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
  });
  const started = (id: string) => spawn.mock.calls.filter(([o]) => o.taskId === id).length;
  return { isolation, orchestrator, sessions, spawn, started };
}

describe('a resolver start admitted before the revert', () => {
  it('does not continue the resolver the revert retired', async () => {
    const { isolation, orchestrator, sessions, started } = raceSetup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(sessions.some((s) => s.taskId === 't1')).toBe(true));
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
    orchestrator.stop();
    await vi.waitFor(() => expect(orchestrator.runs.isOpen).toBe(false));
    const resolver = orchestrator.storeInstance.add({ title: 'Resolve', prompt: 'merge it', assignedRunner: 'claude-code' });
    orchestrator.storeInstance.update(resolver.id, { status: 'failed', runnerSessionId: 'saved' });
    orchestrator.runs.linkResolver(resolver.id, 't1');

    let release!: () => void;
    const activation = new Promise<void>((resolve) => { release = resolve; });
    const originalActive = isolation.isActive.bind(isolation);
    (isolation as unknown as { isActive: (root: string) => Promise<unknown> }).isActive = async (root: string) => {
      await activation;
      return originalActive(root);
    };

    const continuing = orchestrator.continueTask(resolver.id, 'again').catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reverting = orchestrator.revertTask('t1');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get(resolver.id)).toMatchObject({ status: 'skipped' }));

    release();
    const [refused] = await Promise.all([continuing, reverting]);

    expect(refused).toMatchObject({ message: expect.stringContaining('was skipped after this start was asked for') });
    expect(started(resolver.id)).toBe(0);
    expect(orchestrator.storeInstance.get(resolver.id)).toMatchObject({ status: 'skipped' });
  });

  it('does not start the resolver the revert retired', async () => {
    const { isolation, orchestrator, sessions, started } = raceSetup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(sessions.some((s) => s.taskId === 't1')).toBe(true));
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
    // The run closes, so the force start's activation is a real await, as git's is.
    orchestrator.stop();
    await vi.waitFor(() => expect(orchestrator.runs.isOpen).toBe(false));
    const resolver = orchestrator.storeInstance.add({ title: 'Resolve', prompt: 'merge it' });
    orchestrator.runs.linkResolver(resolver.id, 't1');

    let release!: () => void;
    const activation = new Promise<void>((resolve) => { release = resolve; });
    const originalActive = isolation.isActive.bind(isolation);
    (isolation as unknown as { isActive: (root: string) => Promise<unknown> }).isActive = async (root: string) => {
      await activation;
      return originalActive(root);
    };

    // The user's start is already in its act (opening the run) when the revert arrives.
    const forcing = orchestrator.forceStartTask(resolver.id).catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reverting = orchestrator.revertTask('t1');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending'));
    await vi.waitFor(() => expect(orchestrator.startsHeld).toBe(false));
    expect(orchestrator.storeInstance.get(resolver.id)).toMatchObject({ status: 'skipped' });

    release();
    await Promise.all([forcing, reverting]);

    expect(started(resolver.id)).toBe(0);
    expect(orchestrator.storeInstance.get(resolver.id)).toMatchObject({ status: 'skipped' });
  });
});

/**
 * The claim reads the task's status so that a start cannot bring back what was
 * skipped under it, and must let through every start asked of a task already
 * skipped: those are how a user runs one again.
 */
describe('a task skipped before its start was asked for', () => {
  async function skipped() {
    const env = raceSetup();
    env.orchestrator.loadPlan([task('t1', 1), task('t2', 2)]);
    await env.orchestrator.approveReview();
    await vi.waitFor(() => expect(env.sessions.some((s) => s.taskId === 't1')).toBe(true));
    env.orchestrator.stop();
    await vi.waitFor(() => expect(env.orchestrator.runs.isOpen).toBe(false));
    await env.orchestrator.skipTask('t2', 'not this one');
    expect(env.orchestrator.storeInstance.get('t2')).toMatchObject({ status: 'skipped' });
    return env;
  }

  it('runs on a force start', async () => {
    const { orchestrator, started } = await skipped();
    const before = started('t2');
    await orchestrator.forceStartTask('t2');
    expect(started('t2')).toBe(before + 1);
    expect(orchestrator.storeInstance.get('t2')).toMatchObject({ status: 'in_progress' });
  });

  it('runs on a retry', async () => {
    const { orchestrator, started } = await skipped();
    const before = started('t2');
    await orchestrator.retryTask('t2');
    await orchestrator.forceStartTask('t2');
    await vi.waitFor(() => expect(started('t2')).toBe(before + 1));
  });

  it('runs on a continue', async () => {
    const { orchestrator, sessions, started } = await skipped();
    const before = started('t2');
    await orchestrator.forceStartTask('t2');
    sessions.filter((s) => s.taskId === 't2').at(-1)!.reportComplete({ status: 'failed', summary: 'no' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t2')!.status).toBe('failed'));
    await orchestrator.skipTask('t2', 'not this one');
    orchestrator.storeInstance.update('t2', { runnerSessionId: 'saved' });
    await orchestrator.continueTask('t2', 'once more');
    expect(started('t2')).toBe(before + 2);
  });
});

/**
 * ADR-0054: "one that stood on the work through a task that left still does",
 * and "a dependent at work was cut from a tip holding the work being removed".
 * A plan edit removing a dependency while its dependent is at work strips the
 * plan's link; the dependent's worktree was cut before the edit, so it still
 * stands on the dependency. `landedOn` is written at landing from the plan as
 * it stands then, which no longer knows the chain.
 */
async function removedWhileAtWork() {
  const env = raceSetup();
  const { isolation, orchestrator, sessions } = env;
  isolation.changes.set('B', []);
  orchestrator.loadPlan([
    task('A', 1),
    task('B', 2, { dependencies: ['A'] }),
    task('C', 3, { dependencies: ['B'] }),
  ]);
  await orchestrator.approveReview();
  const done = (id: string) => vi.waitFor(() => expect(orchestrator.storeInstance.get(id)!.status).toBe('completed'));
  await vi.waitFor(() => expect(sessions.some((s) => s.taskId === 'A')).toBe(true));
  sessions.filter((s) => s.taskId === 'A').at(-1)!.reportComplete({ status: 'done', summary: '' });
  await done('A');
  await vi.waitFor(() => expect(sessions.some((s) => s.taskId === 'B')).toBe(true));
  sessions.filter((s) => s.taskId === 'B').at(-1)!.reportComplete({ status: 'done', summary: '' });
  await done('B');
  await vi.waitFor(() => expect(orchestrator.getAttempt('C')?.phase).toBe('running'));

  // The edit removes B while C is at work; C's worktree was cut before it.
  await orchestrator.releaseTask('B');
  orchestrator.storeInstance.remove('B');
  return env;
}

describe('a dependent that lands after its dependency left the plan', () => {
  it('is not left at work while the work it stands on is reverted', async () => {
    const { orchestrator } = await removedWhileAtWork();

    const result = await orchestrator.revertTask('A');

    // Its worktree was cut from the tip holding A and the plan edit cannot
    // change that: the revert waits for it, or refuses because it cannot tell.
    expect(result.outcome).toBe('refused');
    expect(orchestrator.storeInstance.get('C')).toMatchObject({ status: 'in_progress' });
  });

  it('is not left landed when the work it stood on is reverted', async () => {
    const { orchestrator, sessions } = await removedWhileAtWork();
    sessions.filter((s) => s.taskId === 'C').at(-1)!.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('C')!.status).toBe('completed'));

    const preview = await orchestrator.revertPreview('A');
    if (preview.revertible) {
      expect(preview.tasks.map((t) => t.taskId)).toContain('C');
      await orchestrator.revertTask('A');
      expect(orchestrator.runs.current?.landings?.C).toBeUndefined();
    } else {
      // Refusing what it cannot place is the other correct answer.
      expect(preview.reason).toBeDefined();
    }
  });

  it('is found the same when the edit only takes the link off a task still in the plan', async () => {
    const { orchestrator, sessions } = raceSetup();
    orchestrator.loadPlan([task('A', 1), task('C', 2, { dependencies: ['A'] })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(sessions.some((s) => s.taskId === 'A')).toBe(true));
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('A')!.status).toBe('completed'));
    await vi.waitFor(() => expect(orchestrator.getAttempt('C')?.phase).toBe('running'));

    orchestrator.storeInstance.update('C', { dependencies: [] });

    expect(await orchestrator.revertTask('A')).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('Task C') });
    sessions.filter((s) => s.taskId === 'C').at(-1)!.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('C')!.status).toBe('completed'));
    expect(await orchestrator.revertPreview('A')).toMatchObject({ revertible: true, tasks: expect.arrayContaining([expect.objectContaining({ taskId: 'C', dependent: true })]) });
  });

  it('is not reached through a link taken off before it started: it starts from the tip as it is then', async () => {
    const { orchestrator, sessions } = raceSetup();
    orchestrator.loadPlan([task('A', 1), task('C', 2, { dependencies: ['A'] })]);
    orchestrator.storeInstance.update('C', { dependencies: [] });
    await orchestrator.approveReview();
    for (const id of ['A', 'C']) {
      await vi.waitFor(() => expect(sessions.some((s) => s.taskId === id)).toBe(true));
      sessions.filter((s) => s.taskId === id).at(-1)!.reportComplete({ status: 'done', summary: '' });
      await vi.waitFor(() => expect(orchestrator.storeInstance.get(id)!.status).toBe('completed'));
    }

    expect(orchestrator.revertScope('A').taskIds).toEqual(['A']);
  });
});

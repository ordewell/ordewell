import { describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Adversarial, execution review: a Stop and a run's own close are not the same
 * thing, and neither may leave a workspace the run no longer has a record for.
 */

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

function setup() {
  const isolation = new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
  });
  return { orchestrator, isolation, spawn, sessions };
}

describe('a Stop while an attempt is preparing its workspace', () => {
  it('keeps the record and worktree the prepare made after the Stop', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('t1', 1)]);
    let prepared!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { prepared = resolve; });
    const got = new Promise<void>((resolve) => { entered = resolve; });
    const prepare = env.isolation.prepare.bind(env.isolation);
    vi.spyOn(env.isolation, 'prepare').mockImplementation(async (...args) => { entered(); await gate; return prepare(...args); });

    const starting = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await got;
    env.orchestrator.stop();
    prepared();
    await starting;
    await flushMicrotasks(20);

    // The ended-while-opening path lets a fresh attempt's worktree go as the
    // Stop keeps one (ADR-0013): off active, so no prune takes it for an
    // orphan. The decision check must not skip it now that the lease throws.
    expect(env.isolation.calls.filter((c) => c.op === 'release')).toEqual([{ op: 'release', taskId: 't1', keep: true }]);
    expect(env.orchestrator.runs.planIsolation?.run.tasks.t1?.status).toBe('kept');
    expect(env.orchestrator.storeInstance.get('t1')?.status).toBe('pending');
  });

  it('leaves the worktree of the start that followed the Stop', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('t1', 1)]);
    let prepared!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { prepared = resolve; });
    const got = new Promise<void>((resolve) => { entered = resolve; });
    const prepare = env.isolation.prepare.bind(env.isolation);
    vi.spyOn(env.isolation, 'prepare')
      .mockImplementationOnce(async (...args) => { entered(); await gate; return prepare(...args); })
      .mockImplementation(prepare);

    const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await got;
    env.orchestrator.stop();
    const second = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await flushMicrotasks(20);
    prepared();
    await Promise.all([first, second]);
    await flushMicrotasks(20);

    // The late prepare's record is in the run the Stop ended; a release reaches only the current one.
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.isolation.taskIdsFor('release')).toEqual([]);
    expect(env.orchestrator.runs.planIsolation?.run.tasks.t1).toBeDefined();
    expect(env.orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
  });
});

describe('a run closing under an explicit start', () => {
  it('does not answer a force start as stopped when no Stop came', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('t1', 1)]);
    let entered!: () => void;
    let assessed!: () => void;
    const got = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { assessed = resolve; });
    env.isolation.isActive = async () => { entered(); await gate; return { active: true }; };

    const starting = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await got;
    // A settled run's own tick closes it, with nothing running.
    await env.orchestrator.tick();
    assessed();

    expect(await starting).toBe('ok');
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
  });

  it('does not answer a Resume now as stopped when no Stop came', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('t1', 1)]);
    await env.orchestrator.forceStartTask('t1');
    // A limit whose reset could not be read holds no run: a settle closes it, and may close the one its resume opens.
    const [paused] = env.sessions;
    paused.emitEvent({ type: 'error', message: 'Rate limit exceeded. Please try again later.' });
    paused.emitTurnEnd('failed');
    await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' }));
    await env.orchestrator.tick();
    let entered!: () => void;
    let assessed!: () => void;
    const got = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { assessed = resolve; });
    env.isolation.isActive = async () => { entered(); await gate; return { active: true }; };

    const resuming = env.orchestrator.resumeNow('t1').then(() => 'ok', (err: unknown) => err);
    await got;
    await env.orchestrator.tick();
    assessed();

    expect(await resuming).toBe('ok');
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(2));
    expect(env.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-1' });
  });
});

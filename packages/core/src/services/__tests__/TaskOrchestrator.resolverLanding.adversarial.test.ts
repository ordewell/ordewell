import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Adversarial: a task's worktree is not torn down under a landing that
 * belongs to it but was started by another task — the conflict resolver a
 * passed verdict or Mark complete lands the conflicted task through
 * (`Landing.landResolved`). A delete of the conflicted task while its
 * resolver lands waits for the merge, and a retry is refused, as they are
 * under the task's own Mark complete (the release takes the workspace admin
 * lock, a landing holds the turn, so nothing else orders them).
 */

function setup(config: Parameters<typeof fakeConfig>[0] = {}) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${opts.taskId}-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const isolation = new FakeWorktreeIsolation();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(config),
    notifications: fakeNotification(),
    runner,
    childPlanRunner: runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const ops = () => isolation.calls.map((c) => ('taskId' in c ? `${c.op}:${c.taskId}` : c.op));
  return { orchestrator, isolation, latest, ops };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

/** t1 conflicted and waits on the user; t2, its resolver, is running. */
async function resolving() {
  const env = setup({ conflictRepairAttempts: 0 });
  env.isolation.outcomes.set('t1', 'conflict');
  env.orchestrator.loadPlan([change('t1', 1), change('t2', 2)]);
  await env.orchestrator.forceStartTask('t1');
  env.latest('t1').reportComplete({ status: 'done', summary: '' });
  await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));
  await env.orchestrator.forceStartTask('t2');
  env.orchestrator.runs.linkResolver('t2', 't1');
  // The resolver brought t1's branch along, so landing t1 now merges clean.
  env.isolation.outcomes.set('t1', 'merged');
  return env;
}

describe('execution audit: a release waits for a landing started by a resolver', () => {
  it('holds a delete of the conflicted task until a passed resolver has landed it', async () => {
    const env = await resolving();
    const openMerge = env.isolation.holdIntegration('t1');
    env.latest('t2').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(2));

    let released = false;
    const release = env.orchestrator.releaseTask('t1').then(() => { released = true; });
    await flushMicrotasks();
    expect(released).toBe(false);
    expect(env.isolation.taskIdsFor('release')).toEqual([]);

    openMerge();
    await release;
    const ops = env.ops();
    expect(ops.lastIndexOf('release:t1')).toBeGreaterThan(ops.lastIndexOf('integrate:t1'));
  });

  it('refuses a retry of the conflicted task while its resolver lands it, and lands it', async () => {
    const env = await resolving();
    const openMerge = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t2');
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(2));

    await expect(env.orchestrator.retryTask('t1')).rejects.toThrow('is being marked complete: its work is landing');
    expect(env.isolation.taskIdsFor('release')).toEqual([]);

    openMerge();
    await marked;
    expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('completed');
  });

  it('does not release the conflicted task while its resolver lands it', async () => {
    const env = await resolving();
    const openMerge = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t2');
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(2));

    // What PlanEditor.removeTask calls for the conflicted task while the resolver lands it.
    let released = false;
    const release = env.orchestrator.releaseTask('t1').then(() => { released = true; });
    await flushMicrotasks();
    expect(released).toBe(false);
    expect(env.isolation.taskIdsFor('release')).toEqual([]);

    openMerge();
    await marked;
    await release;
    const ops = env.ops();
    expect(ops.lastIndexOf('release:t1')).toBeGreaterThan(ops.lastIndexOf('integrate:t1'));
  });
});

/**
 * Mark complete of the conflicted task and its resolver's landing of it can
 * overlap: each holds the task, and neither's end may let go of the other's
 * hold. Every `integrate:t1` after the first (the conflict) is one of them.
 */
describe('execution audit: overlapping landings of one task each hold it', () => {
  const landingsOfT1 = (env: Awaited<ReturnType<typeof resolving>>) => env.isolation.taskIdsFor('integrate').filter((id) => id === 't1').length - 1;

  /** Mark complete of t1 lands, held; then t2 passes and its resolver landing of t1 queues behind it, held. */
  async function overlapping(env: Awaited<ReturnType<typeof resolving>>) {
    const openOwn = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t1');
    await vi.waitFor(() => expect(landingsOfT1(env)).toBe(1));
    return {
      marked,
      openOwn,
      resolverLands: async () => {
        const openResolver = env.isolation.holdIntegration('t1');
        env.latest('t2').reportComplete({ status: 'done', summary: '' });
        await vi.waitFor(() => expect(landingsOfT1(env)).toBe(2));
        return openResolver;
      },
    };
  }

  it('holds a delete begun after both queued until the later landing settles', async () => {
    const env = await resolving();
    const { marked, openOwn, resolverLands } = await overlapping(env);
    const openResolver = await resolverLands();

    let released = false;
    const release = env.orchestrator.releaseTask('t1').then(() => { released = true; });
    openOwn();
    await marked;
    await flushMicrotasks();

    // The resolver's merge is still in t1's worktree.
    expect(released).toBe(false);
    expect(env.isolation.taskIdsFor('release')).toEqual([]);
    await expect(env.orchestrator.retryTask('t1')).rejects.toThrow('is being marked complete: its work is landing');

    openResolver();
    await release;
    const ops = env.ops();
    expect(ops.lastIndexOf('release:t1')).toBeGreaterThan(ops.lastIndexOf('integrate:t1'));
    expect(env.orchestrator.storeInstance.getExecutionLog().filter((s) => s.id === 't1')).toHaveLength(1);
  });

  it('holds a delete begun under the first landing for a second one that began before it settled', async () => {
    const env = await resolving();
    const { marked, openOwn, resolverLands } = await overlapping(env);

    let released = false;
    const release = env.orchestrator.releaseTask('t1').then(() => { released = true; });
    await flushMicrotasks();
    const openResolver = await resolverLands();
    openOwn();
    await marked;
    await flushMicrotasks();

    expect(released).toBe(false);
    expect(env.isolation.taskIdsFor('release')).toEqual([]);
    await expect(env.orchestrator.retryTask('t1')).rejects.toThrow('is being marked complete: its work is landing');

    openResolver();
    await release;
    const ops = env.ops();
    expect(ops.lastIndexOf('release:t1')).toBeGreaterThan(ops.lastIndexOf('integrate:t1'));
  });
});

describe('execution audit: a later landing does not undo the one that completed the task', () => {
  it('keeps the conflicted task completed when its resolver landing fails after Mark complete landed it', async () => {
    const env = await resolving();
    const openOwn = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t1');
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(2));
    const openResolver = env.isolation.holdIntegration('t1');
    env.latest('t2').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(3));

    openOwn();
    await marked;
    expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('completed');
    // git cannot check the second merge of work that has already landed.
    env.isolation.outcomes.set('t1', 'failed');
    openResolver();
    await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t2')!.status).toBe('completed'));
    await flushMicrotasks();

    expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('completed');
  });
});

describe('execution audit: no landing of a task begins while it is being released', () => {
  it('does not land the conflicted task through a resolver that passes while its worktree is torn down', async () => {
    const env = await resolving();
    const release = env.isolation.release.bind(env.isolation);
    vi.spyOn(env.isolation, 'release').mockImplementation(async (run, taskId, opts) => {
      if (taskId === 't1') {
        env.latest('t2').reportComplete({ status: 'done', summary: '' });
        await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t2')!.status).toBe('completed'));
      }
      return release(run, taskId, opts);
    });

    await env.orchestrator.releaseTask('t1');
    await flushMicrotasks();

    // Only the merge that conflicted: none was begun under the teardown.
    expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(1);
    expect(env.orchestrator.storeInstance.get('t1')!.status).not.toBe('completed');
  });

  it('does not land a task marked complete while its worktree is torn down', async () => {
    const env = await resolving();
    const release = env.isolation.release.bind(env.isolation);
    vi.spyOn(env.isolation, 'release').mockImplementation(async (run, taskId, opts) => {
      if (taskId === 't1') await env.orchestrator.markTaskComplete('t1');
      return release(run, taskId, opts);
    });

    await env.orchestrator.releaseTask('t1');

    expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(1);
    expect(env.orchestrator.storeInstance.get('t1')!.status).not.toBe('completed');
  });
});

describe('a Stop while a resolver lands a delegated task (ADR-0055 D8, D9)', () => {
  /**
   * The one landing that outlives a Stop: the resolver's attempt has ended and
   * the delegated task waits on the user, so the Stop puts neither back to
   * pending, and the landing goes on under the resolver's admission.
   */
  async function stoppedMidLanding(over: { stop: boolean }) {
    const env = setup({ conflictRepairAttempts: 0 });
    env.isolation.outcomes.set('d', 'conflict');
    env.orchestrator.loadPlan([
      change('d', 1, { type: 'delegated', goal: 'do d', budget: { tokens: 1_000 }, protectedPaths: ['tests/'] }),
      change('c', 2, { dependencies: ['d'], taskMode: 'plan' }),
      change('r', 3),
    ]);
    await env.orchestrator.forceStartTask('d');
    env.latest('d').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('d')!.status).toBe('awaiting_user'));
    await env.orchestrator.forceStartTask('r');
    env.orchestrator.runs.linkResolver('r', 'd');
    env.isolation.outcomes.set('d', 'merged');

    const openMerge = env.isolation.holdIntegration('d');
    env.latest('r').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 'd')).toHaveLength(2));
    if (over.stop) env.orchestrator.stop();
    openMerge();
    await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('d')!.status).toBe('completed'));
    await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('r')!.status).toBe('completed'));
    await flushMicrotasks();
    return env;
  }

  it('starts its check when nothing stopped the run', async () => {
    const env = await stoppedMidLanding({ stop: false });
    await vi.waitFor(() => expect(env.latest('c')).toBeDefined());
  });

  it('lands it and leaves its check where it is', async () => {
    const env = await stoppedMidLanding({ stop: true });
    expect(env.latest('c')).toBeUndefined();
    expect(env.orchestrator.storeInstance.get('c')!.status).toBe('pending');
  });
});

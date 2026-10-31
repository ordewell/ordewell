import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Adversarial: a force start queued behind its dependencies, re-judged as it
 * opens its run. ADR-0034 and `startForced`'s own docstring say one that
 * something holds back again meanwhile goes back in the queue and never
 * starts past a dependency still under way.
 */

function setup(isolation = new FakeWorktreeIsolation()) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${opts.taskId}-${sessions.length + 1}`);
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
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const notices: string[] = [];
  orchestrator.subscribe({ onIsolationNotice: ({ message }) => notices.push(message) });
  const store = orchestrator.storeInstance;
  const spawned = (taskId: string) => spawn.mock.calls.filter(([o]) => o.taskId === taskId).map(([o]) => o);
  const status = (taskId: string) => store.get(taskId)!.status;
  return { orchestrator, isolation, store, spawn, spawned, status, notices };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

/** Run `edit` while the run the start opens checks whether it isolates, which awaits git. */
function editWhileOpening(env: ReturnType<typeof setup>, edit: () => void): void {
  const isActive = env.isolation.isActive.bind(env.isolation);
  let edited = false;
  env.isolation.isActive = async (root) => {
    if (!edited) {
      edited = true;
      edit();
    }
    return isActive(root);
  };
}

describe('adversarial: a queued force start re-reads the task as it opens its run', () => {
  it('goes back to the queue when a dependency becomes unmet while its run opens', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('a', 1), change('c', 2, { dependencies: ['a'] })]);
    // No run yet: the force start is queued behind a.
    expect(await env.orchestrator.forceStartTask('c')).toMatch(/starts once task "Task a" finishes/);
    env.store.add({ id: 'b', order: 3, title: 'Task b', prompt: 'do b', type: 'ai' });
    editWhileOpening(env, () => env.store.update('c', { dependencies: ['a', 'b'] }));

    // Completing a releases c to start; the edit added b, which is unfinished.
    await env.orchestrator.markTaskComplete('a');
    await flushMicrotasks();

    expect(env.spawned('c')).toHaveLength(0);
    expect(env.orchestrator.startsPending).toBe(true);
  });

  it('a start made now does not start past a dependency an edit adds while its run opens', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('c', 2)]);
    env.store.add({ id: 'b', order: 1, title: 'Task b', prompt: 'do b', type: 'ai' });
    editWhileOpening(env, () => env.store.update('c', { dependencies: ['b'] }));

    await env.orchestrator.forceStartTask('c');

    expect(env.spawned('c')).toHaveLength(0);
  });

  it('a Stop while its run opens leaves the queued start unstarted, and says it was stopped', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('a', 1), change('c', 2, { dependencies: ['a'] })]);
    expect(await env.orchestrator.forceStartTask('c')).toMatch(/starts once task "Task a" finishes/);
    editWhileOpening(env, () => env.orchestrator.stop());

    await env.orchestrator.markTaskComplete('a');
    await flushMicrotasks();

    expect(env.spawned('c')).toHaveLength(0);
    expect(env.notices).toContainEqual(expect.stringContaining('did not start once its dependencies finished'));
    expect(env.status('c')).toBe('pending');
  });

  it('starts when the dependency it was queued behind finishes, with nothing else holding it back', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('a', 1), change('c', 2, { dependencies: ['a'] })]);
    expect(await env.orchestrator.forceStartTask('c')).toMatch(/starts once task "Task a" finishes/);

    await env.orchestrator.markTaskComplete('a');

    await vi.waitFor(() => expect(env.spawned('c')).toHaveLength(1));
    expect(env.status('c')).toBe('in_progress');
  });
});

describe('whose run a queued research start opens', () => {
  it.each([
    ['the supervisor', { research: true, actor: 'supervisor', level: 'act' }, 'supervisor'],
    ['a subplanner, which has no user to act for (ADR-0056 M6)', { research: true, actor: 'subplanner', depth: 1 }, 'supervisor'],
    ['a planner turn', { research: true, actor: 'planner-turn' }, 'user'],
  ] as const)('is that of the task %s started', async (_who, researchOrigin, origin) => {
    const env = setup();
    const origins: string[] = [];
    env.orchestrator.subscribe({ onRunStarted: (run) => origins.push(run.origin) });
    env.orchestrator.loadPlan([change('a', 1), change('r', 2, { dependencies: ['a'], research: true })]);
    env.store.update('r', { researchOrigin });
    env.orchestrator.startAtGate('r');

    await env.orchestrator.markTaskComplete('a');

    await vi.waitFor(() => expect(env.spawned('r')).toHaveLength(1));
    expect(origins).toEqual([origin]);
  });
});

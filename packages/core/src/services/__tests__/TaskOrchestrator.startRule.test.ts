import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * One rule for whether a task can start, and starts that claim the task as it
 * stands when they claim it. Driven through the orchestrator's public
 * controls; only the runner process and git are faked.
 */
function setup(isolation = new FakeWorktreeIsolation(), opts: Pick<Parameters<typeof TaskOrchestrator.compose>[0], 'isApproved' | 'runSettings'> & { config?: Partial<IConfig> } = {}) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${opts.taskId}-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(opts.config),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    ...(opts.isApproved ? { isApproved: opts.isApproved } : {}),
    ...(opts.runSettings ? { runSettings: opts.runSettings } : {}),
  });
  const notices: string[] = [];
  orchestrator.subscribe({ onIsolationNotice: ({ message }) => notices.push(message) });
  const store = orchestrator.storeInstance;
  const spawned = (taskId: string) => spawn.mock.calls.filter(([o]) => o.taskId === taskId).map(([o]) => o);
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const status = (taskId: string) => store.get(taskId)!.status;
  return { orchestrator, isolation, store, spawn, spawned, latest, status, notices };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

/** Edit the task while the run it starts in decides whether it isolates, which awaits git. */
function editWhileOpening(env: ReturnType<typeof setup>, taskId: string, changes: Partial<Task>): void {
  const isActive = env.isolation.isActive.bind(env.isolation);
  env.isolation.isActive = async (root) => {
    env.store.update(taskId, changes);
    return isActive(root);
  };
}

describe('an explicit start runs the task as it stands when it claims it', () => {
  it('starts when the fake repository cannot provide a base diff', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('t1', 1)]);
    await env.orchestrator.forceStartTask('t1');
    expect(env.spawned('t1')).toHaveLength(1);
    expect(env.orchestrator.holdReason('t1')).toBeNull();
  });
  it('a force start, edited while its run opened', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('t1', 1)]);
    editWhileOpening(env, 't1', { prompt: 'do t1, as edited', assignedModel: { modelId: 'edited-model', modelLabel: 'Edited' } });

    await env.orchestrator.forceStartTask('t1');

    expect(env.spawned('t1')).toHaveLength(1);
    expect(env.spawned('t1')[0].prompt).toContain('do t1, as edited');
    expect(env.spawned('t1')[0].modelId).toBe('edited-model');
  });

  it('a continue, edited while its run opened', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('t1', 1)]);
    await env.orchestrator.forceStartTask('t1');
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));
    await flushMicrotasks();
    expect(env.orchestrator.runs.isOpen).toBe(false);
    editWhileOpening(env, 't1', { assignedModel: { modelId: 'edited-model', modelLabel: 'Edited' } });

    await env.orchestrator.continueTask('t1', 'and the docs');

    expect(env.spawned('t1')).toHaveLength(2);
    expect(env.spawned('t1')[1].modelId).toBe('edited-model');
  });
});

describe('a planner turn\'s start hold holds a queued force start too (ADR-0029)', () => {
  it('one forced past a failure, whose other dependency finishes during the turn, starts once the hold is released', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('a', 1), change('b', 2), change('c', 3, { dependencies: ['a', 'b'] })]);
    await env.orchestrator.approveReview();
    env.latest('a').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(env.status('a')).toBe('failed'));
    expect(await env.orchestrator.forceStartTask('c')).toMatch(/starts once task "Task b" finishes/);
    const release = env.orchestrator.holdStarts();

    env.latest('b').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.status('b')).toBe('completed'));
    await flushMicrotasks();
    expect(env.spawned('c')).toHaveLength(0);

    release();
    await env.orchestrator.tick();
    expect(env.spawned('c')).toHaveLength(1);
  });
});

describe('Mark complete while the task\'s spawn is under way', () => {
  /** A scheduled run whose one task is claimed, its worktree made, and its runner still starting. */
  async function spawning() {
    const env = setup();
    let started!: () => void;
    const spawn = env.spawn.getMockImplementation()!;
    env.spawn.mockImplementationOnce(async (opts) => {
      await new Promise<void>((resolve) => { started = resolve; });
      return spawn(opts);
    });
    env.orchestrator.loadPlan([change('t1', 1)]);
    // Its tick waits on the spawn the test holds.
    void env.orchestrator.approveReview();
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    return { ...env, started: () => started() };
  }

  it('leaves the task to the landing: not back to not started, never started again, and completed once it lands', async () => {
    const env = await spawning();
    const land = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t1');
    await flushMicrotasks();

    env.started();
    await flushMicrotasks();
    expect(env.status('t1')).toBe('in_progress');
    await env.orchestrator.tick();
    expect(env.spawn).toHaveBeenCalledTimes(1);

    land();
    await marked;
    expect(env.status('t1')).toBe('completed');
    expect(env.orchestrator.getAttempt('t1')).toBeUndefined();
  });

  it('keeps the worktree being landed when the attempt ended while it was made', async () => {
    const env = setup();
    let made!: () => void;
    const prepare = env.isolation.prepare.bind(env.isolation);
    env.isolation.prepare = async (task, run) => {
      const prepared = await prepare(task, run);
      await new Promise<void>((resolve) => { made = resolve; });
      return prepared;
    };
    env.orchestrator.loadPlan([change('t1', 1)]);
    void env.orchestrator.approveReview();
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('prepare')).toEqual(['t1']));
    const land = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t1');
    await flushMicrotasks();

    made();
    await flushMicrotasks();
    land();
    await marked;

    expect(env.isolation.calls).not.toContainEqual({ op: 'release', taskId: 't1', keep: false });
    expect(env.status('t1')).toBe('completed');
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['a Continue', (env: ReturnType<typeof setup>) => env.orchestrator.continueTask('t1', 'and the docs')],
    ['a force start', (env: ReturnType<typeof setup>) => env.orchestrator.forceStartTask('t1')],
  ])('lands the worktree %s of a failed task was making, though its prepare had dropped the last record', async (_, start) => {
    const env = setup();
    env.orchestrator.loadPlan([change('t1', 1), change('t2', 2, { dependencies: ['t1'] })]);
    await env.orchestrator.forceStartTask('t1');
    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('failed'));
    await flushMicrotasks();
    // As git's does: the last attempt's record goes as its worktree is taken down, and the new one is only written once the new worktree is made.
    let made!: () => void;
    const prepare = env.isolation.prepare.bind(env.isolation);
    env.isolation.prepare = async (task, run, ...rest) => {
      delete run.tasks[task.id];
      await new Promise<void>((resolve) => { made = resolve; });
      return prepare(task, run, ...rest);
    };
    void start(env);
    await vi.waitFor(() => expect(made).toBeDefined());

    const marked = env.orchestrator.markTaskComplete('t1');
    await flushMicrotasks();
    made();
    await marked;

    expect(env.isolation.taskIdsFor('integrate')).toEqual(['t1']);
    expect(env.status('t1')).toBe('completed');
  });
});

describe('merge at gates automatically', () => {
  it('does not merge for an ops task at its gate that the user has not approved (ADR-0035)', async () => {
    const env = setup(new FakeWorktreeIsolation(), { isApproved: (id) => id !== 'o2', runSettings: () => ({ mergeAtGatesAutomatically: true }) });
    env.orchestrator.loadPlan([change('c1', 1), change('o2', 2, { ops: true, dependencies: ['c1'] })]);
    await env.orchestrator.approveReview();

    env.latest('c1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.status('c1')).toBe('completed'));
    await flushMicrotasks();

    expect(env.orchestrator.getMergeGate('o2')).toEqual(['c1']);
    expect(env.isolation.calls.map((c) => c.op)).not.toContain('mergeIntoCheckedOut');
  });
});

describe('a conflict repair follows on from the start whose work it repairs (ADR-0029)', () => {
  /** Task 1 force-started, and Mark complete landing its work onto a conflict, held mid-landing. */
  async function landingOntoConflict() {
    const env = setup(new FakeWorktreeIsolation(), { config: { conflictRepairAttempts: 1 } });
    env.isolation.outcomes.set('t1', 'conflict');
    env.orchestrator.loadPlan([change('t1', 1)]);
    await env.orchestrator.forceStartTask('t1');
    const land = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t1');
    await flushMicrotasks();
    return { ...env, land, marked };
  }

  it('starts the repair Mark complete\'s landing is owed', async () => {
    const env = await landingOntoConflict();

    env.land();
    await env.marked;

    await vi.waitFor(() => expect(env.spawned('t1')).toHaveLength(2));
  });

  it('withdraws it on a Stop that came while the work landed', async () => {
    const env = await landingOntoConflict();

    env.orchestrator.stop();
    env.land();
    await env.marked;
    await flushMicrotasks();

    expect(env.spawned('t1')).toHaveLength(1);
    expect(env.status('t1')).toBe('awaiting_user');
  });
});

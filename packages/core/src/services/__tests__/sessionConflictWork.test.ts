import { describe, it, expect, vi } from 'vitest';
import { fakeConfig, FakeRunnerSession, makeSession, taskOf } from './sessionTestKit';
import { FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { SessionMessage, SessionNotice } from '../SessionMessage';
import type { TaskOrchestrator } from '../TaskOrchestrator';
import type { Session } from '../createSession';
import { taskRowView } from '../../taskRow/view';
import { taskLogHeaderView } from '../../taskRow/logHeader';
import { EMPTY_TASK_LOG_FOLLOW } from '../../conversation/taskLogFollow';

/**
 * One worker per conflict, and a repair that waits (ADR-0015): each order of
 * events a real run can reach, through a real Session with fake runners.
 */

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

function host(config: Partial<IConfig> = {}) {
  const isolation = new FakeWorktreeIsolation();
  isolation.outcomes.set('t1', 'conflict');
  isolation.conflictFiles.set('t1', ['a.ts']);
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const messages: SessionMessage[] = [];
  const notices: SessionNotice[] = [];
  const session = makeSession({
    isolation,
    config: fakeConfig({ conflictRepairAttempts: 2, ...config }),
    runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner,
    broadcast: (m) => messages.push(m),
    onNotice: (n) => notices.push(n),
  });
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const pass = (taskId: string) => latest(taskId).reportComplete({ status: 'done', summary: '' });
  const spawned = () => spawn.mock.calls.map(([o]) => o.taskId);
  const orchestrator = (session as unknown as { orchestrator: TaskOrchestrator }).orchestrator;
  const status = () => [...messages].reverse().find((m): m is Extract<SessionMessage, { type: 'status_update' }> => m.type === 'status_update');
  const execute = () => session.execute({ command: 'run_plan' }, { kind: 'user' });
  return { session, isolation, orchestrator, latest, pass, spawned, status, notices, execute };
}

const resolverOf = (session: Session) => session.planTasks.find((t) => t.title.startsWith('Resolve merge conflict'));
const resolvers = (session: Session) => session.planTasks.filter((t) => t.title.startsWith('Resolve merge conflict'));

/** t1's landing conflicted and its one repair is spent: the conflict waits on the user, and nothing runs. */
async function waitingConflict(config: Partial<IConfig> = {}, tasks: Task[] = [task('t1', 1)]) {
  const env = host({ conflictRepairAttempts: 0, ...config });
  env.session.loadPlan(plan(tasks), 'goal', '/repo');
  await env.execute();
  env.pass('t1');
  await vi.waitFor(() => expect(taskOf(env.session, 't1')?.status).toBe('awaiting_user'));
  return env;
}

/**
 * t1's first repair failed, so its conflict waits on the user with a repair
 * left, and t2 holds the only slot. Mark complete conflicts again, and t1 is
 * owed its next repair: the state the report's run reached.
 */
async function waitingRepair(config: Partial<IConfig> = {}) {
  const env = host({ maxParallelSessions: 1, ...config });
  env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', '/repo');
  await env.execute();
  env.pass('t1');
  await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't1']));
  env.latest('t1').emitExit(1);
  await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't1', 't2']));
  await env.orchestrator.markTaskComplete('t1');
  expect(taskOf(env.session, 't1')?.status).toBe('pending');
  return env;
}

/** The same, reached with no scheduler: tasks started by hand, so only the owed repair itself starts it. */
async function waitingRepairByHand() {
  const env = host({ maxParallelSessions: 1, conflictRepairAttempts: 1 });
  env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', '/repo');
  await env.orchestrator.forceStartTask('t1');
  env.latest('t1').emitExit(1);
  await vi.waitFor(() => expect(taskOf(env.session, 't1')?.status).toBe('failed'));
  await env.orchestrator.forceStartTask('t2');
  await env.orchestrator.markTaskComplete('t1');
  expect(taskOf(env.session, 't1')?.status).toBe('pending');
  expect(env.orchestrator.isScheduling).toBe(false);
  return env;
}

/** t1's conflict waits with a repair left, and a resolver not started: t2 took the slot, then a Stop ended the run. */
async function stoppedWithResolver() {
  const env = host({ maxParallelSessions: 1 });
  env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', '/repo');
  await env.execute();
  env.pass('t1');
  await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't1']));
  env.latest('t1').emitExit(1);
  await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't1', 't2']));
  await env.session.resolveConflictAsTask('t1');
  await env.session.execute({ command: 'stop_run' }, { kind: 'user' });
  expect(taskOf(env.session, 't1')?.status).toBe('awaiting_user');
  expect(resolverOf(env.session)?.status).not.toBe('in_progress');
  return { ...env, resolver: resolverOf(env.session)! };
}

const mine = { kind: 'user' } as const;

describe('a resolver with no scheduler to start it', () => {
  /** t1's conflict waits on the user, and a Stop ended the run: nothing would start anything. */
  async function stoppedConflict(config: Partial<IConfig> = {}) {
    const env = await waitingConflict(config);
    await env.session.execute({ command: 'stop_run' }, mine);
    expect(env.orchestrator.isScheduling).toBe(false);
    return env;
  }

  it('starts it as it is added: the user asked for the conflict to be resolved', async () => {
    const { session, spawned } = await stoppedConflict();

    await session.resolveConflictAsTask('t1');

    const resolver = resolverOf(session)!;
    await vi.waitFor(() => expect(spawned()).toContain(resolver.id));
    expect(taskOf(session, resolver.id)?.status).toBe('in_progress');
  });

  it('lands the task through it with no scheduler, then ends the run', async () => {
    const env = await stoppedConflict();
    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;
    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));
    env.isolation.outcomes.set('t1', 'merged');

    env.pass(resolver.id);

    await vi.waitFor(() => expect(taskOf(env.session, 't1')?.status).toBe('completed'));
    expect(env.orchestrator.isScheduling).toBe(false);
  });

  it('waits for a slot within the Parallel limit, and takes the first that frees', async () => {
    const env = await waitingConflict({ maxParallelSessions: 1 }, [task('t1', 1), task('t2', 2)]);
    await env.session.execute({ command: 'stop_run' }, mine);
    await env.orchestrator.forceStartTask('t2');
    const before = env.spawned().length;

    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;
    await flushMicrotasks();
    expect(env.spawned()).toHaveLength(before);
    expect(env.orchestrator.startsPending).toBe(true);

    env.pass('t2');

    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));
  });

  it('holds back for a planner turn, and starts when it ends', async () => {
    const env = await stoppedConflict();
    const release = env.orchestrator.holdStarts();

    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;
    await flushMicrotasks();
    expect(env.spawned()).not.toContain(resolver.id);

    release();
    await env.orchestrator.tick();

    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));
  });

  it('says why when its runner is on a usage limit, and waits for the reset', async () => {
    const env = await stoppedConflict();
    const paused = env.orchestrator.storeInstance.add(task('t3', 3));
    env.orchestrator.storeInstance.markAwaitingUser(paused.id, 'usage-limit');

    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;
    await flushMicrotasks();

    expect(env.spawned()).not.toContain(resolver.id);
    expect(env.notices.map((n) => n.message)).toContainEqual(expect.stringMatching(/has not started: its runner is on a usage limit/));
    expect(env.orchestrator.startsPending).toBe(true);
  });

  it('is withdrawn by a Stop, the conflict listed with the way to start it again', async () => {
    const env = await waitingConflict({ maxParallelSessions: 1 }, [task('t1', 1), task('t2', 2)]);
    await env.session.execute({ command: 'stop_run' }, mine);
    await env.orchestrator.forceStartTask('t2');
    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;

    await env.session.execute({ command: 'stop_run' }, mine);
    await flushMicrotasks();

    expect(env.spawned()).not.toContain(resolver.id);
    expect(env.orchestrator.startsPending).toBe(false);
    const [listed] = env.session.escalations();
    expect(listed).toMatchObject({ kind: 'conflict', task: { id: 't1' } });
    expect(listed.options.map((o) => o.id)).toContain('start-resolver');
    expect(await env.session.answerEscalation(listed.id, 'start-resolver')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));
  });

  it('is left to the scheduler in a scheduled run, which starts it as it starts any task', async () => {
    const env = await waitingConflict();
    const queuedBefore = env.orchestrator.startsPending;

    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;

    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));
    expect(queuedBefore).toBe(false);
    expect(env.orchestrator.startsPending).toBe(false);
    expect(env.orchestrator.isScheduling).toBe(true);
  });
});

describe('one worker per conflict', () => {
  it('refuses a second resolver for the same conflict, and names the one it has', async () => {
    const { session } = await waitingConflict({ maxParallelSessions: 1 }, [task('t1', 1), task('t2', 2)]);

    await session.resolveConflictAsTask('t1');
    await expect(session.resolveConflictAsTask('t1')).rejects.toThrow(/already resolves/);

    expect(resolvers(session)).toHaveLength(1);
  });

  it('adds no resolver beside a repair owed a slot, and says how to take the conflict back', async () => {
    const { session } = await waitingRepair();

    await expect(session.resolveConflictAsTask('t1')).rejects.toThrow(/Stop it to withdraw the repair/);

    expect(resolvers(session)).toHaveLength(0);
  });

  it('adds no resolver beside a repair at work', async () => {
    const env = host();
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');
    await env.execute();
    env.pass('t1');
    await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't1']));

    await expect(env.session.resolveConflictAsTask('t1')).rejects.toThrow(/is repairing its conflict/);

    expect(resolvers(env.session)).toHaveLength(0);
  });

  it('starts no repair of a conflict that has a resolver: Execute runs the resolver alone', async () => {
    const { session, execute, spawned, resolver } = await stoppedWithResolver();
    const before = spawned().filter((id) => id === 't1').length;

    await execute();
    await vi.waitFor(() => expect(spawned()).toContain('t2'));
    await flushMicrotasks();

    expect(spawned().filter((id) => id === 't1')).toHaveLength(before);
    expect(session.isExecuting).toBe(true);
    expect(taskOf(session, 't1')?.status).toBe('approved');
    expect(resolver.id).toBeDefined();
  });

  it('refuses to force a start of the conflicted task beside its resolver', async () => {
    const { session, spawned, execute } = await stoppedWithResolver();
    const before = spawned().length;
    await execute();

    const outcome = await session.execute({ command: 'force_start', task: 't1' }, mine);

    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/already resolves|is resolving/) });
    expect(spawned().filter((id) => id === 't1')).toHaveLength(2);
    expect(spawned().length).toBeGreaterThanOrEqual(before);
  });

  it('skips a resolver left behind when the task lands another way, and it runs nothing', async () => {
    const { session, isolation, spawned, resolver, status } = await stoppedWithResolver();
    isolation.outcomes.set('t1', 'merged');

    await session.execute({ command: 'mark_complete', task: 't1', confirmed: true }, mine);

    expect(taskOf(session, 't1')?.status).toBe('completed');
    expect(taskOf(session, resolver.id)).toMatchObject({ status: 'skipped', skipReason: expect.stringContaining('not needed') });
    await session.execute({ command: 'run_plan' }, mine);
    await flushMicrotasks();
    expect(spawned()).not.toContain(resolver.id);
    expect(status()).toBeDefined();
  });

  it('keeps the resolver when Mark complete conflicts again, and no repair starts beside it', async () => {
    const { session, spawned, resolver } = await stoppedWithResolver();

    await session.execute({ command: 'mark_complete', task: 't1', confirmed: true }, mine);

    expect(taskOf(session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' });
    expect(taskOf(session, resolver.id)?.status).not.toBe('skipped');
    expect(spawned().filter((id) => id === 't1')).toHaveLength(2);
  });

  it('skips a resolver not started when the task is retried: the retry starts over from the tip', async () => {
    const { session, spawned, resolver } = await stoppedWithResolver();

    await session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, mine);

    expect(taskOf(session, resolver.id)).toMatchObject({ status: 'skipped', skipReason: expect.stringContaining('not needed') });
    await vi.waitFor(() => expect(spawned().filter((id) => id === 't1')).toHaveLength(3));
    expect(spawned()).not.toContain(resolver.id);
  });

  it('refuses a retry or a skip of the task while its resolver is at work', async () => {
    const env = await waitingConflict();
    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;
    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));

    const retry = await env.session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, mine);
    const skip = await env.session.execute({ command: 'skip_task', task: 't1' }, mine);

    expect(retry).toMatchObject({ ok: false, message: expect.stringContaining('is resolving') });
    expect(skip).toMatchObject({ ok: false, message: expect.stringContaining('is resolving') });
    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' });
  });

  it('skips a resolver not started when the task is skipped', async () => {
    const { session, resolver } = await stoppedWithResolver();

    await session.execute({ command: 'skip_task', task: 't1' }, mine);

    expect(taskOf(session, resolver.id)).toMatchObject({ status: 'skipped', skipReason: expect.stringContaining('not needed') });
  });

  it('frees the conflict for another worker when the resolver is skipped or removed', async () => {
    const { session, resolver } = await stoppedWithResolver();

    await session.execute({ command: 'skip_task', task: resolver.id }, mine);
    await session.resolveConflictAsTask('t1');
    const second = session.planTasks.at(-1)!;
    expect(second.id).not.toBe(resolver.id);

    await session.removeTask(second.id);
    await expect(session.resolveConflictAsTask('t1')).resolves.not.toBeNull();
  });

  it('ends the resolver with the conflicted task when the user removes that task, at work or not', async () => {
    const env = await waitingConflict();
    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;
    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));

    await env.session.removeTask('t1');

    expect(env.orchestrator.getAttempt(resolver.id)).toBeUndefined();
    expect(taskOf(env.session, resolver.id)).toMatchObject({ status: 'skipped', skipReason: expect.stringContaining('not needed') });
  });

  it('skips the resolver of a conflicted task a planner edit took out of the plan', async () => {
    const { session, orchestrator, resolver } = await stoppedWithResolver();

    orchestrator.adoptEdit(session.planTasks.filter((t) => t.id !== 't1'), ['claude-code']);

    expect(taskOf(session, resolver.id)).toMatchObject({ status: 'skipped', skipReason: expect.stringContaining('not needed') });
  });

  it.each([['discarded', 'discardRun'], ['cleaned up', 'cleanupRun']] as const)('skips a resolver not started when the run is %s: the branch it would merge has gone', async (_, act) => {
    const { session, resolver, spawned } = await stoppedWithResolver();

    await session[act]();

    expect(taskOf(session, resolver.id)).toMatchObject({ status: 'skipped', skipReason: expect.stringContaining('not needed') });
    expect(spawned()).not.toContain(resolver.id);
  });

  it('leaves a conflict waiting through an edit between runs: an edit is nobody answering it', async () => {
    const { session, orchestrator } = await stoppedWithResolver();

    orchestrator.adoptEdit(session.planTasks, ['claude-code']);

    expect(taskOf(session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' });
  });

  it('lands the task through its resolver, as it always has', async () => {
    const env = await waitingConflict();
    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;
    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));
    env.isolation.outcomes.set('t1', 'merged');

    env.pass(resolver.id);

    await vi.waitFor(() => expect(taskOf(env.session, 't1')?.status).toBe('completed'));
    expect(taskOf(env.session, resolver.id)?.status).toBe('completed');
  });
});

// The conflict goes out at once and the repair's wait is the second change of
// its second, so a surface reads it as that second ends: these wait for it.
describe('a repair that waits for a slot', () => {
  const statusOf = (env: { status: ReturnType<typeof host>['status'] }, id: string) => env.status()!.tasks.find((t) => t.id === id)!;
  const rowOf = (env: Parameters<typeof statusOf>[0], id: string) => {
    const status = statusOf(env, id);
    return taskRowView({ ...status, type: 'ai', order: 1, dependencies: [] });
  };

  it.each([['a scheduled run', waitingRepair], ['tasks started by hand', waitingRepairByHand]])('reads as waiting for a free slot in %s, not as a conflict to act on', async (_, reach) => {
    const env = await reach();

    await vi.waitFor(() => expect(statusOf(env, 't1').isolation).toMatchObject({ state: 'conflict', repairWaits: 'slot', conflictFiles: ['a.ts'] }));
    const row = rowOf(env, 't1');
    expect(row.conflict).toBeNull();
    expect(row.repairWaiting).toMatchObject({ label: 'Repair waits for a free slot', files: 'a.ts' });
    expect(row.actions).toContain('cancel');
  });

  it('says so in the task log\'s header', async () => {
    const env = await waitingRepair();
    await vi.waitFor(() => expect(statusOf(env, 't1').isolation).toMatchObject({ repairWaits: 'slot' }));
    const { status: taskStatus, isolation } = statusOf(env, 't1');

    const header = taskLogHeaderView({ status: taskStatus, repairWaits: isolation?.state === 'conflict' ? isolation.repairWaits : undefined }, EMPTY_TASK_LOG_FOLLOW, 0, 0);

    expect(header.state).toEqual({ kind: 'todo', label: 'Repair waits for a free slot' });
  });

  it.each([['a scheduled run', waitingRepair], ['tasks started by hand', waitingRepairByHand]])('is not listed in %s: it starts by itself', async (_, reach) => {
    const env = await reach();

    expect(env.session.escalations().filter((e) => e.task?.id === 't1')).toEqual([]);
  });

  it('says what it waits for when that is a planner\'s turn', async () => {
    const env = host({ maxParallelSessions: 2 });
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');
    await env.execute();
    env.pass('t1');
    await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't1']));
    env.latest('t1').emitExit(1);
    await vi.waitFor(() => expect(taskOf(env.session, 't1')?.status).toBe('awaiting_user'));
    const release = env.orchestrator.holdStarts();

    await env.orchestrator.markTaskComplete('t1');
    env.orchestrator.storeInstance.onMutate?.();

    await vi.waitFor(() => expect(rowOf(env, 't1').repairWaiting?.label).toBe('Repair waits for the planner\'s turn to end'));
    release();
  });

  it('keeps the repair owed through an edit while it waits for a planner\'s turn, with nothing running', async () => {
    const env = host();
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', '/repo');
    await env.orchestrator.forceStartTask('t1');
    await env.orchestrator.forceStartTask('t2');
    env.latest('t1').emitExit(1);
    await vi.waitFor(() => expect(taskOf(env.session, 't1')?.status).toBe('failed'));
    const release = env.orchestrator.holdStarts();
    await env.orchestrator.markTaskComplete('t1');
    env.pass('t2');
    await vi.waitFor(() => expect(taskOf(env.session, 't2')?.status).toBe('completed'));
    expect(taskOf(env.session, 't1')?.status).toBe('pending');

    env.orchestrator.adoptEdit(env.session.planTasks, ['claude-code']);
    release();
    await env.orchestrator.tick();

    await vi.waitFor(() => expect(env.spawned().filter((id) => id === 't1')).toHaveLength(2));
    expect(env.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'repairing' });
  });

  it('starts a scheduled run\'s repair exactly as before, once the slot frees', async () => {
    const env = await waitingRepair();
    env.isolation.outcomes.set('t1', 'merged');

    env.pass('t2');

    await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't1', 't2', 't1']));
    expect(env.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'repairing', repair: { attempt: 2, limit: 2 } });
    env.pass('t1');
    await vi.waitFor(() => expect(taskOf(env.session, 't1')?.status).toBe('completed'));
  });

  it('waits past a slot for its runner\'s usage limit, and is still owed', async () => {
    const env = await waitingRepairByHand();
    const paused = env.orchestrator.storeInstance.add(task('t3', 3));
    env.orchestrator.storeInstance.markAwaitingUser(paused.id, 'usage-limit');
    const before = env.spawned().length;

    env.pass('t2');
    await vi.waitFor(() => expect(taskOf(env.session, 't2')?.status).toBe('completed'));
    await flushMicrotasks();

    expect(env.spawned()).toHaveLength(before);
    expect(env.orchestrator.startsPending).toBe(true);
    await vi.waitFor(() => expect(rowOf(env, 't1').repairWaiting?.label).toBe('Repair waits for its runner\'s usage limit to reset'));
  });
});

describe('Stop on a conflict', () => {
  const waitsOnYou = (session: Session) => {
    expect(taskOf(session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' });
    expect(session.escalations().find((e) => e.task?.id === 't1')).toMatchObject({ kind: 'conflict' });
    expect(session.escalations().find((e) => e.task?.id === 't1')?.options.map((o) => o.id)).toEqual(expect.arrayContaining(['resolve-conflict', 'retry', 'skip']));
  };

  it.each([['a scheduled run', waitingRepair], ['tasks started by hand', waitingRepairByHand]])('withdraws the repair owed in %s and leaves the conflict waiting with its options', async (_, reach) => {
    const env = await reach();

    const outcome = await env.session.execute({ command: 'stop_task', task: 't1' }, mine);

    expect(outcome).toMatchObject({ ok: true, message: expect.stringContaining('its merge conflict waits for you') });
    waitsOnYou(env.session);
    env.pass('t2');
    await vi.waitFor(() => expect(taskOf(env.session, 't2')?.status).toBe('completed'));
    await flushMicrotasks();
    expect(env.spawned().filter((id) => id === 't1')).toHaveLength(env.orchestrator.isScheduling ? 2 : 1);
    waitsOnYou(env.session);
  });

  it('leaves a resolver free to be added once the repair is withdrawn', async () => {
    const env = await waitingRepair();
    await env.session.execute({ command: 'stop_task', task: 't1' }, mine);

    await expect(env.session.resolveConflictAsTask('t1')).resolves.not.toBeNull();

    expect(resolvers(env.session)).toHaveLength(1);
  });

  it('owes nothing once the task is skipped, so it holds no run open', async () => {
    const env = await waitingRepairByHand();

    await env.session.execute({ command: 'skip_task', task: 't1' }, mine);

    expect(env.orchestrator.repairWait('t1')).toBeNull();
    env.pass('t2');
    await vi.waitFor(() => expect(taskOf(env.session, 't2')?.status).toBe('completed'));
    await flushMicrotasks();
    expect(env.orchestrator.startsPending).toBe(false);
  });

  it.each([['a scheduled run', waitingRepair], ['tasks started by hand', waitingRepairByHand]])('the run\'s Stop leaves the conflict of %s waiting too, nothing stranded', async (_, reach) => {
    const env = await reach();

    await env.session.execute({ command: 'stop_run' }, mine);

    waitsOnYou(env.session);
    expect(env.orchestrator.startsPending).toBe(false);
  });

  it('stops a repair at work the same way: its conflict waits, on no hold', async () => {
    const env = host();
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');
    await env.execute();
    env.pass('t1');
    await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't1']));

    const outcome = await env.session.execute({ command: 'stop_task', task: 't1' }, mine);

    expect(outcome).toMatchObject({ ok: true, message: expect.stringContaining('its merge conflict waits for you') });
    waitsOnYou(env.session);
    expect(env.orchestrator.holdReason('t1')).toBeNull();
  });

  it('refuses in words the user can act on when the conflict is already waiting', async () => {
    const { session } = await waitingConflict();

    const outcome = await session.execute({ command: 'stop_task', task: 't1' }, mine);

    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/not running.*merge conflict.*add a resolver task, retry it, skip it or mark it complete/i) });
  });

  it('points at the resolver when that is what is working on the conflict', async () => {
    const env = await waitingConflict();
    await env.session.resolveConflictAsTask('t1');
    const resolver = resolverOf(env.session)!;
    await vi.waitFor(() => expect(env.spawned()).toContain(resolver.id));

    const outcome = await env.session.execute({ command: 'stop_task', task: 't1' }, mine);

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(`"${resolver.title}"`) });
  });
});

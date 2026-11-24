import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession, taskOf, fakeConfig, testWorkspace } from './sessionTestKit';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { ExecutionActor } from '../../models/Execution';
import type { ExecutionCommand } from '../ExecutionCommands';
import type { Session } from '../createSession';
import type { SessionMessage } from '../SessionMessage';

/**
 * A run the scheduler drives that nothing moves on but a person: nothing at
 * work, nothing on its way, nothing able to start. The status update says so
 * (`activity.waitsOnUser`), so a follower that cannot answer a manual task's
 * wait (`ordewell run --unattended`) can tell it holds the run from one that
 * waits beside work still going on.
 */

const USER: ExecutionActor = { kind: 'user' };

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });
const manual = (id: string, order: number, over: Partial<Task> = {}) => task(id, order, { type: 'user', assignedRunner: undefined, taskMode: undefined, prompt: undefined, ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

type StatusUpdate = Extract<SessionMessage, { type: 'status_update' }>;

function setup(maxParallelSessions = 3) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const runnerSession = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(runnerSession);
    return runnerSession;
  });
  const runner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner;
  /** Each status update, with the plan's statuses as it went out. */
  const updates: { update: StatusUpdate; statuses: Record<string, string> }[] = [];
  // Set once made: the session broadcasts as it is built, before it can be read.
  const built: { session?: Session } = {};
  const broadcast = (msg: SessionMessage) => {
    if (msg.type !== 'status_update' || !built.session) return;
    const statuses = Object.fromEntries(built.session.planTasks.map((t) => [t.id, t.status]));
    updates.push({ update: msg, statuses });
  };
  const made = makeSession({ runner, scriptRunner: runner, broadcast, config: fakeConfig({ autonomousMode: true, maxParallelSessions }) });
  built.session = made;
  return {
    session: made,
    spawn,
    updates,
    latest: (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!,
    load: (tasks: Task[]) => made.loadPlan(plan(tasks), 'goal', testWorkspace, { persist: false }),
    run: (command: ExecutionCommand) => made.execute(command, USER),
    status: (id: string) => taskOf(made, id)!.status,
    lastUpdate: () => updates.at(-1)?.update,
  };
}

describe('a pending manual task that everything left needs', () => {
  it('leaves the run waiting on the user, and the status update and the run view say so beside its wait', async () => {
    const env = setup();
    env.load([manual('u1', 1), task('t2', 2, { dependencies: ['u1'] })]);
    expect(env.session.activity.waitsOnUser).toBe(false);

    const outcome = await env.run({ command: 'run_plan' });

    expect(outcome).toMatchObject({ ok: true, message: 'The plan is running; nothing could start yet. Read the plan to see what each task waits on.' });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.session.activity).toMatchObject({ running: false, starting: false, scheduled: true, waitsOnUser: true });
    await vi.waitFor(() => expect(env.lastUpdate()?.activity?.waitsOnUser).toBe(true));
    expect(env.lastUpdate()?.escalations?.map((e) => [e.kind, e.task?.id])).toEqual([['by-hand', 'u1']]);
    // What a second follower joining the run reads first.
    expect(env.session.runSnapshot()).toMatchObject({ activity: { waitsOnUser: true } });
  });

  it('moves again once it is marked complete: what needs it starts, and the run no longer waits on the user', async () => {
    const env = setup();
    env.load([manual('u1', 1), task('t2', 2, { dependencies: ['u1'] })]);
    await env.run({ command: 'run_plan' });

    expect(await env.run({ command: 'mark_complete', task: 'u1' })).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(env.session.activity.waitsOnUser).toBe(false);
    await vi.waitFor(() => expect(env.lastUpdate()?.activity?.waitsOnUser).toBe(false));
  });
});

describe('a pending manual task beside work still going on', () => {
  it('does not leave the run waiting on the user while a task runs, only once it has ended', async () => {
    const env = setup();
    env.load([manual('u1', 1), task('t2', 2), task('t3', 3, { dependencies: ['u1', 't2'] })]);
    await env.run({ command: 'run_plan' });
    await vi.waitFor(() => expect(env.status('t2')).toBe('in_progress'));

    expect(env.session.activity.waitsOnUser).toBe(false);
    expect(env.updates.some(({ update }) => update.activity?.waitsOnUser)).toBe(false);

    env.latest('t2').reportComplete({ status: 'done', summary: 'done' });
    await vi.waitFor(() => expect(env.status('t2')).toBe('completed'));
    await vi.waitFor(() => expect(env.session.activity.waitsOnUser).toBe(true));
    await vi.waitFor(() => expect(env.lastUpdate()?.activity?.waitsOnUser).toBe(true));
  });

  it('never says it waits on the user while a task can still start, a slot freeing between them', async () => {
    const env = setup(1);
    env.load([manual('u1', 1), task('t2', 2), task('t3', 3), task('t4', 4, { dependencies: ['u1', 't2', 't3'] })]);
    await env.run({ command: 'run_plan' });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    const first = env.status('t2') === 'in_progress' ? 't2' : 't3';
    const second = first === 't2' ? 't3' : 't2';

    env.latest(first).reportComplete({ status: 'done', summary: 'done' });
    await vi.waitFor(() => expect(env.status(second)).toBe('in_progress'));
    env.latest(second).reportComplete({ status: 'done', summary: 'done' });
    await vi.waitFor(() => expect(env.status(second)).toBe('completed'));
    await vi.waitFor(() => expect(env.lastUpdate()?.activity?.waitsOnUser).toBe(true));

    // Every update that said so went out once both AI tasks had ended.
    const said = env.updates.filter(({ update }) => update.activity?.waitsOnUser);
    expect(said.length).toBeGreaterThan(0);
    for (const { statuses } of said) expect([statuses.t2, statuses.t3]).toEqual(['completed', 'completed']);
  });
});

describe('a run nothing waits in', () => {
  it('does not wait on the user once it has ended, or before it starts', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    expect(env.session.activity.waitsOnUser).toBe(false);

    await env.run({ command: 'run_plan' });
    env.latest('t1').reportComplete({ status: 'done', summary: 'done' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));
    await vi.waitFor(() => expect(env.session.activity.scheduled).toBe(false));

    expect(env.session.activity.waitsOnUser).toBe(false);
  });
});

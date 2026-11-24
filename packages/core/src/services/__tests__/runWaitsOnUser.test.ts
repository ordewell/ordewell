import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession, taskOf, fakeConfig, testWorkspace } from './sessionTestKit';
import { heldPlanner } from './supervisorTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { IsolationMergeResult, IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import type { TaskOrchestrator } from '../TaskOrchestrator';
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

function plan(tasks: Task[], over: Partial<LegacyPlanState> = {}): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, ...over };
}

type StatusUpdate = Extract<SessionMessage, { type: 'status_update' }>;

interface Setup {
  maxParallelSessions?: number;
  aiService?: ReturnType<typeof heldPlanner>['aiService'];
  isolation?: FakeWorktreeIsolation;
  settings?: Partial<GlobalRunSettings>;
  config?: Partial<IConfig>;
}

function setup(maxParallelSessions = 3, options: Setup = {}) {
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
  /** What says the run has ended: none of it may go out while a task waits on a person. */
  const ended: string[] = [];
  const broadcast = (msg: SessionMessage) => {
    if (msg.type === 'execution_complete' || msg.type === 'run_concluded' || msg.type === 'execution_stopped') ended.push(msg.type);
    if (msg.type !== 'status_update' || !built.session) return;
    const statuses = Object.fromEntries(built.session.planTasks.map((t) => [t.id, t.status]));
    updates.push({ update: msg, statuses });
  };
  const made = makeSession({
    runner, scriptRunner: runner, broadcast,
    config: fakeConfig({ autonomousMode: true, maxParallelSessions, ...options.config }),
    aiService: options.aiService,
    isolation: options.isolation,
    ...(options.isolation ? { workspaceRoot: () => '/repo' } : {}),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', ...options.settings } }),
  });
  built.session = made;
  const workspace = options.isolation ? '/repo' : testWorkspace;
  return {
    session: made,
    spawn,
    updates,
    ended,
    latest: (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!,
    orchestrator: (made as unknown as { orchestrator: TaskOrchestrator }).orchestrator,
    load: (tasks: Task[], over: Partial<LegacyPlanState> = {}) => made.loadPlan(plan(tasks, over), 'goal', workspace, { persist: false }),
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

/**
 * What still moves the run though nothing is at work and nothing is ready: the
 * check reads each before it says the run waits on the user, and a follower
 * that believed it then would return from a run that goes on.
 */
describe('a pending manual task, with the run moved on by something else', () => {
  /** A run that waits on the user: u1 is manual, and t2 needs it. */
  async function waitingOnUser(options: Setup = {}) {
    const env = setup(3, options);
    env.load([manual('u1', 1), task('t2', 2, { dependencies: ['u1'] })]);
    await env.run({ command: 'run_plan' });
    await vi.waitFor(() => expect(env.session.activity.waitsOnUser).toBe(true));
    return env;
  }

  it('does not wait on the user while a start is admitted and not yet claimed', async () => {
    const env = await waitingOnUser();

    // What the command seam holds while a start it carries out awaits before it claims (ExecutionCommands).
    const admission = env.orchestrator.admitStart();
    expect(env.session.activity).toMatchObject({ starting: true, waitsOnUser: false });

    admission.release();
    expect(env.session.activity.waitsOnUser).toBe(true);
  });

  it('does not wait on the user while a planner turn holds starts, though nothing is ready to start', async () => {
    const planner = heldPlanner();
    const env = await waitingOnUser({ aiService: planner.aiService });

    const turn = env.session.continueConversation('look at the plan again');
    await vi.waitFor(() => expect(planner.calls).toHaveLength(1));
    expect(env.orchestrator.startsHeld).toBe(true);
    expect(env.session.activity.waitsOnUser).toBe(false);
    expect(env.session.runSnapshot()).toMatchObject({ activity: { waitsOnUser: false } });

    planner.calls[0].finish({ kind: 'message', text: 'Nothing to change.', researchLog: [] });
    await turn;
    expect(env.orchestrator.startsHeld).toBe(false);
    await vi.waitFor(() => expect(env.session.activity.waitsOnUser).toBe(true));
  });

  it('does not say it waits on the user while an automatic Merge all at a gate is under way', async () => {
    let releaseMerge!: () => void;
    const mergeHeld = new Promise<void>((resolve) => { releaseMerge = resolve; });
    let mergeStarted = false;
    class HeldMerge extends FakeWorktreeIsolation {
      override async mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult> {
        mergeStarted = true;
        await mergeHeld;
        return super.mergeIntoCheckedOut(run);
      }
    }
    const env = setup(3, { isolation: new HeldMerge(), settings: { mergeAtGatesAutomatically: true }, config: { worktreeIsolation: true } });
    env.load([manual('u1', 1), task('a1', 2), task('o2', 3, { ops: true, dependencies: ['a1'] })]);
    await env.run({ command: 'run_plan' });
    await vi.waitFor(() => expect(env.status('a1')).toBe('in_progress'));

    env.latest('a1').reportComplete({ status: 'done', summary: 'done' });
    await vi.waitFor(() => expect(mergeStarted).toBe(true));
    await vi.waitFor(() => expect(env.status('a1')).toBe('completed'));
    // What the merge's own events send while it is held, a by-hand wait listed beside the gate's.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(env.orchestrator.isMerging).toBe(true);
    expect(env.session.activity.waitsOnUser).toBe(false);
    const duringMerge = env.updates.length;

    releaseMerge();
    await vi.waitFor(() => expect(env.spawn.mock.calls.map(([opts]) => opts.taskId)).toContain('o2'));
    // Every update from a1's end until o2 started, the merge's included, said the run moves on its own.
    const started = env.updates.findIndex(({ statuses }) => statuses.o2 === 'in_progress');
    const said = started < 0 ? env.updates : env.updates.slice(0, started);
    expect(said.length).toBeGreaterThanOrEqual(duringMerge);
    expect(said.some(({ update }) => update.escalations?.some((e) => e.kind === 'by-hand'))).toBe(true);
    expect(said.filter(({ update }) => update.activity?.waitsOnUser).map(({ statuses }) => statuses)).toEqual([]);
  });

  it('waits on the user in a carried loop with no scheduler, once its next round waits to be started', async () => {
    const env = setup();
    env.load(
      [task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }), task('fix', 2, { dependencies: ['check'] })],
      { approvedTasks: ['check'] },
    );
    expect(await env.run({ command: 'run_task', task: 'check' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.status('check')).toBe('in_progress'));

    env.latest('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
    await vi.waitFor(() => expect(env.status('check')).toBe('failed'));
    await vi.waitFor(() => expect(env.session.escalations().map((e) => [e.kind, e.task?.id])).toContainEqual(['unapproved', 'fix']));

    // No scheduler drives this run: only the carried loop starts anything, and nothing of it can start unasked.
    expect(env.session.activity).toMatchObject({ scheduled: false, running: false, waitsOnUser: true });
    await vi.waitFor(() => expect(env.lastUpdate()?.activity?.waitsOnUser).toBe(true));
  });
});

/**
 * A task's own wait that only a person moves on: the run stays open behind it
 * and says it waits on the user, with the wait listed, and nothing ends it, so
 * `ordewell run --unattended` has the escalation alone to return on.
 */
describe('a task whose own wait only a person moves on', () => {
  type Kind = 'conflict' | 'landing-failed' | 'files-changed' | 'usage-limit';

  /** What `kind` needs of the session, and how its task ends its attempt. */
  function waitOn(kind: Kind) {
    const isolation = new FakeWorktreeIsolation();
    if (kind === 'conflict') isolation.outcomes.set('t1', 'conflict');
    if (kind === 'landing-failed') isolation.outcomes.set('t1', 'failed');
    if (kind === 'files-changed') isolation.changedFiles = ['package.json'];
    const end = (session: FakeRunnerSession): void => {
      if (kind !== 'usage-limit') return session.reportComplete({ status: 'done', summary: 'done' });
      // No reset time: nothing resumes it by itself.
      session.emitEvent({ type: 'error', message: 'Rate limit exceeded. Please try again later.' });
      session.emitOutput('Rate limit exceeded. Please try again later.\n');
      session.emitTurnEnd('failed');
    };
    return { isolation, end, over: kind === 'files-changed' ? { ops: true } : {} };
  }

  it.each<[Kind, boolean]>([
    ['conflict', false], ['landing-failed', false], ['files-changed', false], ['usage-limit', false],
    ['conflict', true], ['landing-failed', true], ['files-changed', true], ['usage-limit', true],
  ])('lists %s, and the run stays open waiting on the user (beside a failed task: %s)', async (kind, besideFailed) => {
    const { isolation, end, over } = waitOn(kind);
    const env = setup(3, { isolation, config: { worktreeIsolation: true } });
    env.load([task('t1', 1, over), ...(besideFailed ? [task('f2', 2)] : [])]);
    await env.run({ command: 'run_plan' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('in_progress'));
    if (besideFailed) {
      await vi.waitFor(() => expect(env.status('f2')).toBe('in_progress'));
      env.latest('f2').reportComplete({ status: 'failed', summary: 'It broke.', reason: 'It broke.' });
      await vi.waitFor(() => expect(env.status('f2')).toBe('failed'));
    }

    end(env.latest('t1'));

    await vi.waitFor(() => expect(env.status('t1')).toBe('awaiting_user'));
    expect(env.orchestrator.storeInstance.get('t1')!.awaitingReason).toBe(kind);
    await vi.waitFor(() => expect(env.lastUpdate()?.activity?.waitsOnUser).toBe(true));
    expect(env.lastUpdate()?.escalations?.map((e) => [e.kind, e.task?.id])).toContainEqual([kind, 't1']);
    expect(env.session.escalations().map((e) => [e.kind, e.task?.id])).toContainEqual([kind, 't1']);
    expect(env.session.runSnapshot()).toMatchObject({ activity: { waitsOnUser: true } });
    // Nothing concludes the run: its waiting task is no failure (TaskOrchestrator's settleRun).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(env.session.activity.scheduled).toBe(true);
    expect(env.ended).toEqual([]);
  });
});

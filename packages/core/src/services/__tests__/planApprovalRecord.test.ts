import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeSession, FakeRunnerSession, taskOf, fakeConfig, testWorkspace } from './sessionTestKit';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { ExecutionActor } from '../../models/Execution';
import * as sessionStore from '../../utils/sessionStore';
import { SURFACE_CONTROLS } from '../surfaceControls';

/**
 * Plan approval is the user's act, kept on the plan as its own record
 * (ADR-0029): the plan-level status is what surfaces display, and a host that
 * rewrites it — VS Code set it back to draft after every run that ended on a
 * failure — must not take the approval with it.
 */

const PLANNER: ExecutionActor = { kind: 'planner-turn' };
const NOT_APPROVED = /not approved/;

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });

function draft(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'draft', runners: ['claude-code'], lastUpdated: now };
}

function setup(saveSession?: typeof sessionStore.saveSession) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const s = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(s);
    return s;
  });
  const session = makeSession({
    runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner,
    config: fakeConfig({ autonomousMode: true, maxParallelSessions: 3 }),
    ...(saveSession ? { saveSession } : {}),
  });
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  return { session, spawn, latest };
}

/** Execute plan, then a run that ends with t1 failed and t2 done. */
async function runEndedWithAFailure(env: ReturnType<typeof setup>, workspace = testWorkspace) {
  env.session.loadPlan(draft([task('t1', 1), task('t2', 2)]), 'goal', workspace, { persist: false });
  await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
  env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
  env.latest('t2').reportComplete({ status: 'done', summary: '' });
  await vi.waitFor(() => {
    expect(taskOf(env.session, 't1')!.status).toBe('failed');
    expect(taskOf(env.session, 't2')!.status).toBe('completed');
  });
  await vi.waitFor(() => expect(env.session.isExecuting).toBe(false));
}

describe('plan approval is read from the approval record, never from the display status', () => {
  it('survives a run that ended with a failure, whatever a host then wrote to the plan status', async () => {
    const env = setup();
    await runEndedWithAFailure(env);
    // What VS Code's status_update handler wrote on the shared plan object.
    env.session.planState!.status = 'draft';

    const outcome = await env.session.execute({ command: 'run_plan' }, PLANNER);

    expect(outcome.message).not.toMatch(NOT_APPROVED);
    expect(outcome.ok).toBe(true);
  });

  it('survives a stopped run: the planner may run the plan again and retry an approved task', async () => {
    const env = setup();
    env.session.loadPlan(draft([task('t1', 1)]), 'goal', testWorkspace, { persist: false });
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await env.session.execute({ command: 'stop_run' }, { kind: 'user' });
    // What VS Code's execution_stopped handler wrote.
    env.session.planState!.status = 'draft';

    expect(await env.session.execute({ command: 'run_plan' }, PLANNER)).toMatchObject({ ok: true });
    await env.session.execute({ command: 'stop_run' }, { kind: 'user' });
    env.session.planState!.status = 'draft';
    expect(await env.session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, PLANNER)).toMatchObject({ ok: true });
    expect(env.spawn).toHaveBeenCalledTimes(3);
  });

  describe('across a reload from the session store', () => {
    let workspace: string;
    beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-approval-')); });
    afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

    it('stays approved, even when the saved status says draft', async () => {
      const env = setup(sessionStore.saveSession);
      await runEndedWithAFailure(env, workspace);
      env.session.planState!.status = 'draft';
      const id = sessionStore.saveSession(env.session.planState!, 'goal', workspace, env.session.sessionId).id;

      const reloaded = setup(sessionStore.saveSession);
      reloaded.session.loadPlan(sessionStore.loadSession(id, workspace)!.plan, 'goal', workspace, { sessionId: id });

      expect(await reloaded.session.execute({ command: 'run_plan' }, PLANNER)).toMatchObject({ ok: true });
    });

    it('travels with a fork of the session, whatever the status says', async () => {
      const env = setup(sessionStore.saveSession);
      await runEndedWithAFailure(env, workspace);
      env.session.planState!.status = 'draft';

      const fork = env.session.forkConversation();
      const forked = setup(sessionStore.saveSession);
      forked.session.loadPlan(sessionStore.loadSession(fork.sessionId, workspace)!.plan, 'goal', workspace, { sessionId: fork.sessionId });

      expect(await forked.session.execute({ command: 'run_plan' }, PLANNER)).toMatchObject({ ok: true });
    });

    it('keeps a plan saved before approval had its own record approved when its status said so', async () => {
      const legacy: LegacyPlanState = { ...draft([task('t1', 1)]), status: 'running' };
      const id = sessionStore.saveSession(legacy, 'goal', workspace, 'legacy').id;
      const env = setup(sessionStore.saveSession);
      env.session.loadPlan(sessionStore.loadSession(id, workspace)!.plan, 'goal', workspace, { sessionId: id });

      expect(await env.session.execute({ command: 'run_plan' }, PLANNER)).toMatchObject({ ok: true });
    });
  });

  it('is never given by a status alone on a plan the user never executed', async () => {
    const env = setup();
    env.session.loadPlan(draft([task('t1', 1)]), 'goal', testWorkspace, { persist: false });
    // A surface's display status is not the user's approval.
    env.session.planState!.status = 'running';

    for (const command of [{ command: 'run_plan' }, { command: 'run_task', task: 't1' }] as const) {
      expect(await env.session.execute(command, PLANNER)).toMatchObject({ ok: false, message: expect.stringMatching(NOT_APPROVED) });
    }
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it('is not given by the user starting one task: the plan stays unapproved', async () => {
    const env = setup();
    env.session.loadPlan(draft([task('t1', 1), task('t2', 2)]), 'goal', testWorkspace, { persist: false });
    await env.session.execute({ command: 'force_start', task: 't1' }, { kind: 'user' });
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.session.isExecuting).toBe(false));

    expect((await env.session.execute({ command: 'run_plan' }, PLANNER)).message)
      .toBe(`The user has not approved this plan yet: they approve it themselves (${SURFACE_CONTROLS.unknown.approvePlan}). Ask them to.`);
  });

  it('still leaves a task added after the approval unapproved (ADR-0029)', async () => {
    const env = setup();
    await runEndedWithAFailure(env);
    env.session.planState!.status = 'draft';
    const plan = env.session.planState!;
    env.session.loadPlan({ ...plan, tasks: [...plan.tasks, task('t3', 3)] }, 'goal', testWorkspace, { persist: false });

    expect((await env.session.execute({ command: 'run_task', task: 't3' }, PLANNER)).message)
      .toBe('Task #3 "Task t3" was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.');
  });
});

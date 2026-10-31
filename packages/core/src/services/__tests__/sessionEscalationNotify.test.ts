import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeConfig, FakeRunnerSession, makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, failInterruptedTasks, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { NotifyRun } from '../escalationNotifier';

/**
 * The notify command through a real Session (ADR-0053): driven by what a run
 * really left waiting, with no surface attached, and never in a run's way.
 */

const COMMAND = ['notify-me'];

function runner() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  return { sessions, spawn, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner };
}

const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  ({ ...createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over }), ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

function setup(over: { run?: NotifyRun; isolation?: FakeWorktreeIsolation; command?: string[] } = {}) {
  const r = runner();
  const run = vi.fn<NotifyRun>(over.run ?? (async () => {}));
  const build = () => makeSession({ runner: r.runner, isolation: over.isolation, config: fakeConfig({ notifyCommand: over.command ?? COMMAND }), runNotifyCommand: run });
  const session = build();
  const latest = (taskId: string) => r.sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const load = (tasks: Task[], into = session) => into.loadPlan(plan(tasks), 'goal', testWorkspace, { persist: false });
  const start = () => session.execute({ command: 'run_plan' }, { kind: 'user' });
  const told = () => run.mock.calls.map(([, env]) => env.ORDEWELL_ESCALATION_ID);
  const fail = async (taskId: string) => {
    latest(taskId).reportComplete({ status: 'failed', summary: 'nope', reason: 'nope' });
    await vi.waitFor(() => expect(taskOf(session, taskId)?.status).toBe('failed'));
  };
  return { session, build, run, latest, load, start, told, fail, ...r };
}

describe('the notify command in a run', () => {
  it('runs once for a failed task, however many status updates carry it, and again for the retry\'s failure', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2)]);
    await env.start();
    await env.fail('t1');
    await vi.waitFor(() => expect(env.told()).toEqual(['failed:t1:1']));

    env.latest('t2').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(taskOf(env.session, 't2')?.status).toBe('completed'));
    expect(env.told()).toEqual(['failed:t1:1']);

    await env.session.answerEscalation('failed:t1:1', 'retry');
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(3));
    await env.fail('t1');

    await vi.waitFor(() => expect(env.told()).toEqual(['failed:t1:1', 'failed:t1:2']));
    expect(env.run.mock.calls[0]).toEqual([COMMAND, {
      ORDEWELL_ESCALATION_ID: 'failed:t1:1',
      ORDEWELL_ESCALATION_KIND: 'failed',
      ORDEWELL_ESCALATION_TASK: '#1 Task t1',
      ORDEWELL_ESCALATION_REASON: 'The runner reported the task failed: nope',
    }]);
  });

  it('tells of a runner approval, a checkpoint and a run a dirty checkout turned away', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();
    env.latest('t1').requestPermission('s1-perm-1', 'Write', { file_path: '/repo/a.txt' }, []);
    await vi.waitFor(() => expect(env.told()).toEqual(['approval:t1:1:s1-perm-1']));

    void env.latest('t1').callCheckpoint('Drop the table?');
    await vi.waitFor(() => expect(env.told()).toEqual(['approval:t1:1:s1-perm-1', 'checkpoint:t1:1']));

    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'dirty' };
    const blocked = setup({ isolation });
    blocked.load([task('t1', 1)]);
    await blocked.start();
    await vi.waitFor(() => expect(blocked.run.mock.calls.map(([, e]) => e.ORDEWELL_ESCALATION_KIND)).toEqual(['blocked-run']));
  });

  it('tells of landed work once nothing moves, and does not tell it again when the session is reloaded', async () => {
    const isolation = new FakeWorktreeIsolation();
    const env = setup({ isolation });
    const landing = plan([task('t1', 1)]);
    env.session.loadPlan(landing, 'goal', testWorkspace, { persist: false });
    await env.start();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.run.mock.calls.map(([, e]) => e.ORDEWELL_ESCALATION_KIND)).toEqual(['merge-all']));
    const saved = structuredClone(env.session.planState!);
    env.run.mockClear();

    const reopened = env.build();
    reopened.loadPlan(saved, 'goal', testWorkspace, { persist: false });
    expect(reopened.escalations().map((e) => e.kind)).toEqual(['merge-all']);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(env.run).not.toHaveBeenCalled();
  });

  it('sends nothing for what already waits when a session loads, and tells what comes after', async () => {
    const env = setup();
    env.load([
      task('t1', 1, { status: 'awaiting_user', awaitingReason: 'input' }),
      task('t2', 2, { status: 'awaiting_user', awaitingReason: 'checkpoint' }),
    ]);
    expect(env.session.escalations().map((e) => e.id)).toEqual(['input:t1:0', 'checkpoint:t2:0']);

    await env.session.answerEscalation('input:t1:0', 'skip');
    expect(env.run).not.toHaveBeenCalled();

    await env.session.answerEscalation('checkpoint:t2:0', 'retry');
    await vi.waitFor(() => expect(env.latest('t2')).toBeDefined());
    env.latest('t2').requestPermission('s1-perm-1', 'Write', { file_path: '/repo/a.txt' }, []);
    await vi.waitFor(() => expect(env.told()).toHaveLength(1));
    expect(env.told()[0]).toMatch(/^approval:t2:/);
  });

  it('sends nothing for a failed or an interrupted task a restart finds, and tells the failure that comes after', async () => {
    const env = setup();
    env.load([
      task('t1', 1, { status: 'failed', verdict: { outcome: 'fail', reason: 'nope', checks: [], decidedAt: '2026-10-30T00:00:00Z' } }),
      task('t2', 2),
    ]);
    const saved = structuredClone(env.session.planState!);
    saved.tasks[1].status = 'in_progress';
    failInterruptedTasks(saved.tasks, '2026-10-30T00:00:01Z');
    env.session.destroy();

    const session = env.build();
    session.loadPlan(saved, 'goal', testWorkspace, { persist: false });
    expect(session.escalations().map((e) => e.id)).toEqual(['failed:t1:0', 'failed:t2:0']);
    await session.answerEscalation('failed:t2:0', 'retry');
    await vi.waitFor(() => expect(env.latest('t2')).toBeDefined());
    expect(env.run).not.toHaveBeenCalled();

    env.latest('t2').reportComplete({ status: 'failed', summary: 'nope', reason: 'nope' });
    await vi.waitFor(() => expect(env.told()).toEqual(['failed:t2:1']));
    session.destroy();
  });

  it('tells a new plan of its own waits, though a plan before it used the same ids', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();
    await env.fail('t1');
    await vi.waitFor(() => expect(env.told()).toEqual(['failed:t1:1']));

    env.load([task('t1', 1)]);
    await env.start();
    await env.fail('t1');

    await vi.waitFor(() => expect(env.told()).toEqual(['failed:t1:1', 'failed:t1:1']));
  });

  it.each<[string, (env: ReturnType<typeof setup>) => void]>([
    ['closed', (env) => env.session.destroy()],
    ['left for another plan', (env) => env.load([task('other', 1)])],
    ['reset', (env) => env.session.reset()],
  ])('says nothing of the landed work a stopped run leaves as its session is %s', async (_how, leave) => {
    const env = setup({ isolation: new FakeWorktreeIsolation() });
    env.load([task('t1', 1), task('t2', 2)]);
    await env.start();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')?.status).toBe('completed'));

    leave(env);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(env.run).not.toHaveBeenCalled();
  });

  it.each<[string, NotifyRun]>([
    ['fails', async () => { throw new Error('exited with code 1'); }],
    ['throws as it starts', () => { throw new Error('spawn EINVAL'); }],
    ['never answers', () => new Promise(() => {})],
  ])('leaves the run alone when the command %s', async (_how, run) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = setup({ run });
    env.load([task('t1', 1), task('t2', 2), task('t3', 3, { dependencies: ['t2'] })]);
    await env.start();
    await env.fail('t1');
    await vi.waitFor(() => expect(env.told()).toEqual(['failed:t1:1']));

    env.latest('t2').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.latest('t3')).toBeDefined());
    env.latest('t3').reportComplete({ status: 'done', summary: 'ok' });

    await vi.waitFor(() => expect(taskOf(env.session, 't3')?.status).toBe('completed'));
    warn.mockRestore();
  });

  it('runs the real command with no surface attached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-notify-'));
    const told = join(dir, 'told');
    const script = `require('fs').writeFileSync(${JSON.stringify(told)}, process.env.ORDEWELL_ESCALATION_ID)`;
    const r = runner();
    const session = makeSession({ runner: r.runner, config: fakeConfig({ notifyCommand: [process.execPath, '-e', script] }), broadcast: () => {} });
    session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    r.sessions[0].reportComplete({ status: 'failed', summary: 'nope', reason: 'nope' });

    await vi.waitFor(() => expect(readFileSync(told, 'utf8')).toBe('failed:t1:1'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts no command while none is set', async () => {
    const env = setup({ command: [] });
    env.load([task('t1', 1)]);
    await env.start();
    await env.fail('t1');
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(env.run).not.toHaveBeenCalled();
  });
});

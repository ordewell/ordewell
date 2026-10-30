import { describe, expect, it, vi } from 'vitest';
import { fakeConfig, FakeRunnerSession, makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { IRunner } from '../../interfaces/IRunner';
import type { SessionMessage } from '../SessionMessage';
import type { NotifyRun } from '../escalationNotifier';

/**
 * Adversarial (ADR-0053): a Merge all is the run's own wait, and a run can have
 * more than one. A run that lands more work after a Merge all keeps its id, so
 * only the attempts the id names tell the second wait from the first; and a run
 * whose end merges by itself is announced before that merge, which must not read
 * as a wait, though a run stopped there, or a merge that stopped, is one.
 */

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

function setup(autoMerge = false, isolation = new FakeWorktreeIsolation()) {
  const messages: SessionMessage[] = [];
  const r = runner();
  const notify = vi.fn<NotifyRun>(async () => {});
  const session = makeSession({
    runner: r.runner,
    isolation,
    broadcast: (m) => messages.push(m),
    config: fakeConfig({ notifyCommand: ['notify-me'] }),
    runNotifyCommand: notify,
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, mergeAtGatesAutomatically: autoMerge, supervisorLevel: 'off' } }),
  });
  const latest = (taskId: string) => r.sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const load = (tasks: Task[]) => session.loadPlan(plan(tasks), 'goal', testWorkspace, { persist: false });
  const started = () => session.execute({ command: 'run_plan' }, { kind: 'user' });
  const attempts = (taskId: string) => r.sessions.filter((s) => s.taskId === taskId).length;
  const carried = () => messages.flatMap((m) => (m.type === 'status_update' ? m.escalations ?? [] : [])).map((e) => e.id);
  const told = () => notify.mock.calls.map(([, env]) => env.ORDEWELL_ESCALATION_ID);
  const fail = async (taskId: string) => {
    latest(taskId).reportComplete({ status: 'failed', summary: 'nope', reason: 'nope' });
    await vi.waitFor(() => expect(taskOf(session, taskId)?.status).toBe('failed'));
  };
  return { session, messages, latest, load, started, attempts, carried, told, fail };
}

describe('adversarial: one Merge all per run is not one Merge all per id', () => {
  it('tells again when more work lands after a Merge all, which keeps the run\'s id', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2)]);
    await env.started();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await env.fail('t2');
    await vi.waitFor(() => expect(env.session.escalations().some((e) => e.kind === 'merge-all')).toBe(true));

    const first = env.session.escalations().find((e) => e.kind === 'merge-all')!;
    await vi.waitFor(() => expect(env.told()).toContain(first.id));
    expect(await env.session.answerEscalation(first.id, 'merge-all')).toMatchObject({ ok: true });
    // The retry continues the same run, as a run with a holdout is continued.
    expect(await env.session.answerEscalation('failed:t2:1', 'retry')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.attempts('t2')).toBe(2));
    env.latest('t2').reportComplete({ status: 'done', summary: 'fixed' });

    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.kind)).toEqual(['merge-all']));
    const second = env.session.escalations()[0];
    expect(second.id.split(':').slice(0, 2)).toEqual(first.id.split(':').slice(0, 2));
    expect(second.id).not.toBe(first.id);
    await vi.waitFor(() => expect(env.told().filter((id) => id === second.id)).toHaveLength(1));
    expect(env.told().filter((id) => id === first.id)).toHaveLength(1);
    expect(await env.session.answerEscalation(first.id, 'merge-all')).toMatchObject({ ok: false, outcome: 'refused' });
  });

  it('leaves out a Merge all the run merges at its end by itself, and tells nobody of it', async () => {
    const env = setup(true);
    env.load([task('t1', 1)]);
    await env.started();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    // The run's end, auto-merge and close all happen before this message.
    await vi.waitFor(() => expect(env.messages.map((m) => m.type)).toContain('execution_complete'));

    expect(env.carried()).toEqual([]);
    expect(env.told()).toEqual([]);
  });

  it('leaves out the same Merge all at the end of a task run on its own', async () => {
    const env = setup(true);
    env.load([task('t1', 1), task('t2', 2)]);
    expect(await env.session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.attempts('t1')).toBe(1));
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.messages.map((m) => m.type)).toContain('execution_complete'));

    expect(env.carried()).toEqual([]);
    expect(env.told()).toEqual([]);
  });

  it('lists and tells a Merge all when a Stop leaves landed work, though the run would have merged it', async () => {
    const env = setup(true);
    env.load([task('t1', 1), task('t2', 2)]);
    await env.started();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.attempts('t2')).toBe(1));
    await vi.waitFor(() => expect(env.session.runMergeView()).not.toBeNull());

    expect(await env.session.execute({ command: 'stop_run' }, { kind: 'user' })).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.kind)).toEqual(['merge-all']));
    const [{ id }] = env.session.escalations();
    await vi.waitFor(() => expect(env.told()).toEqual([id]));
  });

  it('lists and tells a Merge all the run\'s end could not finish', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.mergeResult = { outcome: 'failed', repo: '.' };
    const env = setup(true, isolation);
    env.load([task('t1', 1)]);
    await env.started();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.messages.map((m) => m.type)).toContain('execution_complete'));

    const [{ id, kind }] = env.session.escalations();
    expect(kind).toBe('merge-all');
    expect(env.told()).toEqual([id]);
  });

  it('tells a later end\'s Merge all that stopped, after an earlier one merged by itself', async () => {
    const isolation = new FakeWorktreeIsolation();
    const env = setup(true, isolation);
    env.load([task('t1', 1), task('t2', 2)]);
    await env.started();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await env.fail('t2');
    await vi.waitFor(() => expect(env.session.runMergeView()).toBeNull());
    await vi.waitFor(() => expect(env.told()).toEqual(['failed:t2:1']));

    isolation.mergeResult = { outcome: 'failed', repo: '.' };
    expect(await env.session.answerEscalation('failed:t2:1', 'retry')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.attempts('t2')).toBe(2));
    env.latest('t2').reportComplete({ status: 'done', summary: 'fixed' });

    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.kind)).toEqual(['merge-all']));
    const [{ id }] = env.session.escalations();
    await vi.waitFor(() => expect(env.told()).toEqual(['failed:t2:1', id]));
  });
});

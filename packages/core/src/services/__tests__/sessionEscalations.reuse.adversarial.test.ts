import { describe, expect, it, vi } from 'vitest';
import { fakeConfig, FakeRunnerSession, makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { NotifyRun } from '../escalationNotifier';

/**
 * Adversarial (ADR-0053): an id names a wait, not a task and an attempt. A
 * structured runner can ask twice within one attempt — a second checkpoint, or
 * a second turn end after the user's reply to the first — and the second wait
 * is another wait. It must get its own id, so a surface holding the first id
 * cannot answer the second question, and so the notify command tells of it.
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

function setup(isolation?: FakeWorktreeIsolation) {
  const r = runner();
  const notify = vi.fn<NotifyRun>(async () => {});
  const session = makeSession({ runner: r.runner, isolation, config: fakeConfig({ notifyCommand: ['notify-me'] }), runNotifyCommand: notify });
  const latest = (taskId: string) => r.sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const load = (tasks: Task[]) => session.loadPlan(plan(tasks), 'goal', testWorkspace, { persist: false });
  const start = () => session.execute({ command: 'run_plan' }, { kind: 'user' });
  const ids = () => session.escalations().map((e) => e.id);
  const told = () => notify.mock.calls.map(([, env]) => env.ORDEWELL_ESCALATION_ID);
  return { session, latest, load, start, ids, told, spawn: r.spawn };
}

describe('adversarial: one attempt can wait twice', () => {
  it('gives a second checkpoint its own id, and refuses the answer meant for the first', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();

    void env.latest('t1').callCheckpoint('Drop the table?');
    await vi.waitFor(() => expect(env.ids()).toEqual(['checkpoint:t1:1']));
    const first = env.session.escalations()[0].id;
    expect(await env.session.answerEscalation(first, 'approve')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.ids()).toEqual([]));

    // The runner goes on in the same attempt and asks a different question.
    void env.latest('t1').callCheckpoint('Delete production?');
    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.reason)).toEqual(['Checkpoint: Delete production?']));
    const second = env.session.escalations()[0];

    expect(second.id).not.toBe(first);
    await expect(env.session.answerEscalation(first, 'approve')).resolves.toMatchObject({ ok: false, outcome: 'refused' });
    await vi.waitFor(() => expect(env.session.escalations()).toHaveLength(1));
  });

  it('tells the notify command of a second wait for input in the same attempt', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();

    // A turn ends without task_complete: the completion reminder goes first, then the wait for input.
    env.latest('t1').emitTurnEnd('completed');
    env.latest('t1').emitTurnEnd('completed');
    await vi.waitFor(() => expect(env.ids()).toEqual(['input:t1:1']));
    expect(await env.session.answerEscalation('input:t1:1', 'reply', 'first answer')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.ids()).toEqual([]));

    // The runner read the reply, worked on, and ended its turn again.
    env.latest('t1').emitTurnEnd('completed');
    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.kind)).toEqual(['input']));
    const second = env.session.escalations()[0];

    expect(second.id).not.toBe('input:t1:1');
    expect(taskOf(env.session, 't1')?.status).toBe('awaiting_user');
    await vi.waitFor(() => expect(env.told()).toEqual(['input:t1:1', second.id]));
  });
});

describe('adversarial: every other way a task comes back to a wait', () => {
  it('tells a user task taken back a second time, and refuses the answer to the first', async () => {
    const env = setup();
    env.load([task('t1', 1), task('u1', 2, { type: 'user', prompt: undefined })]);
    await env.start();
    const takeBack = async () => {
      expect(await env.session.answerEscalation(env.ids()[0], 'complete')).toMatchObject({ ok: true });
      expect(await env.session.execute({ command: 'mark_not_done', task: 'u1', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });
      return env.ids()[0];
    };

    const first = await takeBack();
    const second = await takeBack();

    expect(first).toMatch(/^on-hold:u1:0/);
    expect(second).toMatch(/^on-hold:u1:0/);
    expect(second).not.toBe(first);
    expect(await env.session.answerEscalation(first, 'complete')).toMatchObject({ ok: false, outcome: 'refused' });
    await vi.waitFor(() => expect(env.told()).toEqual(['by-hand:u1:0', first, second]));
  });

  it('tells a merge gate on a retry\'s work, and refuses a force start confirmed past the first attempt\'s', async () => {
    const env = setup(new FakeWorktreeIsolation());
    env.load([task('t1', 1), task('t2', 2, { ops: true, dependencies: ['t1'] })]);
    await env.start();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.kind)).toEqual(['merge-gate']));
    const first = env.ids()[0];

    expect(await env.session.execute({ command: 'revert_task', task: 't1', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(await env.session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.spawn.mock.calls.filter(([o]) => o.taskId === 't1')).toHaveLength(2));
    env.latest('t1').reportComplete({ status: 'done', summary: 'again' });
    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.kind)).toEqual(['merge-gate']));
    const second = env.ids()[0];

    expect(second).not.toBe(first);
    expect(await env.session.answerEscalation(first, 'force-start', undefined, true)).toMatchObject({ ok: false, outcome: 'refused' });
    expect(env.spawn.mock.calls.filter(([o]) => o.taskId === 't2')).toEqual([]);
    await vi.waitFor(() => expect(env.told().filter((id) => id.startsWith('merge-gate'))).toEqual([first, second]));
  });

  it('tells a stash replay the dirty checkout turned away again, and refuses the answer to the first', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'dirty' };
    // Something wrote to the checkout again before the replay looked at it.
    vi.spyOn(isolation, 'stash').mockResolvedValue();
    const env = setup(isolation);
    env.load([task('t1', 1)]);
    await env.start();
    const first = env.ids()[0];

    expect(await env.session.answerEscalation(first, 'stash')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.kind)).toEqual(['blocked-run']));
    const second = env.ids()[0];

    expect(second).not.toBe(first);
    expect(await env.session.answerEscalation(first, 'run-without-isolation')).toMatchObject({ ok: false, outcome: 'refused' });
    await vi.waitFor(() => expect(env.told()).toEqual([first, second]));
  });

  it('keeps a later wait\'s id across a reload, and still refuses the answer to the first', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();
    env.latest('t1').emitTurnEnd('completed');
    env.latest('t1').emitTurnEnd('completed');
    await vi.waitFor(() => expect(env.ids()).toEqual(['input:t1:1']));
    await env.session.answerEscalation('input:t1:1', 'reply', 'first answer');
    await vi.waitFor(() => expect(env.ids()).toEqual([]));
    env.latest('t1').emitTurnEnd('completed');
    await vi.waitFor(() => expect(env.ids()).toHaveLength(1));
    const [second] = env.ids();
    const saved = JSON.parse(JSON.stringify(env.session.planState)) as LegacyPlanState;

    const reopened = makeSession({ runner: runner().runner });
    reopened.loadPlan(saved, 'goal', testWorkspace, { persist: false });

    expect(reopened.escalations().map((e) => e.id)).toEqual([second]);
    expect(await reopened.answerEscalation('input:t1:1', 'retry')).toMatchObject({ ok: false, outcome: 'refused' });
  });
});

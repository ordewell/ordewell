import { describe, expect, it, vi } from 'vitest';
import { FakeRunnerSession, makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { startAttemptUsage } from '../../models/Usage';
import type { IRunner } from '../../interfaces/IRunner';
import type { SessionMessage } from '../SessionMessage';
import { EMPTY_RUN, reduceRun } from '../runView';

/**
 * The escalation list through a real Session (ADR-0053): what a run really
 * left waiting, answered by `answerEscalation` and reaching every surface on
 * the status stream. A step that ends in `expectStreamed` also proves a
 * client folding the stream holds the list the Session derives.
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

function plan(tasks: Task[], over: Partial<LegacyPlanState> = {}): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, ...over };
}

function setup(isolation?: FakeWorktreeIsolation) {
  const messages: SessionMessage[] = [];
  const r = runner();
  const session = makeSession({ runner: r.runner, isolation, broadcast: (m) => messages.push(m) });
  const latest = (taskId: string) => r.sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const load = (tasks: Task[], over: Partial<LegacyPlanState> = {}) => session.loadPlan(plan(tasks, over), 'goal', testWorkspace, { persist: false });
  const start = () => session.execute({ command: 'run_plan' }, { kind: 'user' });
  const ids = () => session.escalations().map((e) => e.id);
  const fail = async (taskId: string) => {
    latest(taskId).reportComplete({ status: 'failed', summary: 'nope', reason: 'nope' });
    await vi.waitFor(() => expect(taskOf(session, taskId)?.status).toBe('failed'));
  };
  const timeline = () => messages.flatMap((m) => (m.type === 'execution_action' ? [m.record] : []));
  /** What a client that folded the stream from the start holds. */
  const streamed = () => messages.reduce((view, m) => reduceRun(view, m), EMPTY_RUN).escalations;
  const expectStreamed = () => expect(streamed()).toEqual(session.escalations());
  return { session, messages, latest, load, start, ids, fail, timeline, streamed, expectStreamed, ...r };
}

describe('answering what a run left waiting', () => {
  it('answers a runner approval, and the list and the stream both drop it', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();
    env.latest('t1').requestPermission('s1-perm-1', 'Write', { file_path: '/repo/a.txt' }, []);

    const [escalation] = env.session.escalations();
    expect(escalation).toMatchObject({ id: 'approval:t1:1:s1-perm-1', kind: 'approval', approval: 's1-perm-1' });
    env.expectStreamed();

    expect(await env.session.answerEscalation(escalation.id, 'allow')).toMatchObject({ ok: true });

    expect(env.ids()).toEqual([]);
    env.expectStreamed();
    expect(env.timeline().at(-1)).toMatchObject({ command: 'answer_approval', actor: 'user', outcome: 'done' });
  });

  it('refuses the same answer twice, the second as stale, and nothing else happens', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();
    env.latest('t1').requestPermission('s1-perm-1', 'Write', { file_path: '/repo/a.txt' }, []);
    const [{ id }] = env.session.escalations();

    await env.session.answerEscalation(id, 'deny', 'write it elsewhere');
    const kept = env.timeline().length;

    expect(await env.session.answerEscalation(id, 'allow')).toEqual({ ok: false, outcome: 'refused', message: 'That is no longer waiting on you: it was answered, or the run moved on. Nothing was changed.' });
    expect(env.timeline()).toHaveLength(kept);
  });

  it('approves a checkpoint, and the runner hears it', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();
    const heard = env.latest('t1').callCheckpoint('Drop the table?');
    await vi.waitFor(() => expect(env.ids()).toEqual(['checkpoint:t1:1']));
    expect(env.session.escalations()[0].reason).toBe('Checkpoint: Drop the table?');
    env.expectStreamed();

    await env.session.answerEscalation('checkpoint:t1:1', 'approve');

    expect(await heard).toEqual({ kind: 'continue' });
    expect(env.ids()).toEqual([]);
  });

  it('rejects a checkpoint with the note as its reason', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();
    const heard = env.latest('t1').callCheckpoint('Drop the table?');
    await vi.waitFor(() => expect(env.ids()).toEqual(['checkpoint:t1:1']));

    await env.session.answerEscalation('checkpoint:t1:1', 'reject', 'not on production');

    expect(await heard).toEqual({ kind: 'rejected', reason: 'not on production' });
  });

  it('gives a retried task\'s new failure its own id, and refuses the old one', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.start();
    await env.fail('t1');
    expect(env.ids()).toEqual(['failed:t1:1']);
    env.expectStreamed();

    expect(await env.session.answerEscalation('failed:t1:1', 'retry')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(2));
    expect(env.ids()).toEqual([]);
    await env.fail('t1');

    expect(env.ids()).toEqual(['failed:t1:2']);
    expect(await env.session.answerEscalation('failed:t1:1', 'retry')).toMatchObject({ ok: false, outcome: 'refused' });
    env.expectStreamed();
  });

  it('keeps a skip\'s note as its reason, and lets the dependent go', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.start();
    await env.fail('t1');

    expect(await env.session.answerEscalation('failed:t1:1', 'skip', 'covered elsewhere')).toMatchObject({ ok: true });

    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'skipped', skipReason: 'covered elsewhere' });
    await vi.waitFor(() => expect(env.latest('t2')).toBeDefined());
  });

  it('lands Mark complete only with the user\'s yes, once the run has ended on the failure', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.start();
    await env.fail('t1');
    await vi.waitFor(() => expect(env.session.escalations()[0].options.map((o) => o.id)).toContain('complete'));

    const asked = await env.session.answerEscalation('failed:t1:1', 'complete');
    expect(asked).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/^Mark task #1 "Task t1" complete\? .* it needs your explicit yes\.$/) });
    expect(taskOf(env.session, 't1')?.status).toBe('failed');

    expect(await env.session.answerEscalation('failed:t1:1', 'complete', undefined, true)).toMatchObject({ ok: true });
    expect(taskOf(env.session, 't1')?.status).toBe('completed');
  });

  it('marks a user task done by hand with no question, which lets the run finish', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { type: 'user', prompt: undefined, dependencies: ['t1'] })]);
    await env.start();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.ids()).toEqual(['by-hand:t2:0']));
    env.expectStreamed();

    expect(await env.session.answerEscalation('by-hand:t2:0', 'complete')).toMatchObject({ ok: true });

    expect(taskOf(env.session, 't2')?.status).toBe('completed');
    expect(env.ids()).toEqual([]);
    env.expectStreamed();
  });

  it('starts a task added since the approval, which the run left for the user', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2)], { approved: true, approvedTasks: ['t1'] });
    await env.session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' });
    // Joined by someone whose start approves nothing, so t2 stays outside the approval record.
    await env.session.execute({ command: 'run_plan' }, { kind: 'supervisor', level: 'act' });
    await vi.waitFor(() => expect(env.ids()).toEqual(['unapproved:t2:0']));
    env.expectStreamed();

    expect(await env.session.answerEscalation('unapproved:t2:0', 'run')).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(env.latest('t2')).toBeDefined());
    expect(env.ids()).toEqual([]);
  });

  it('retries a task the user cancelled, whose hold is the wait', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2)]);
    await env.start();
    await env.session.execute({ command: 'stop_task', task: 't1' }, { kind: 'user' });
    env.latest('t2').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.ids()).toEqual(['on-hold:t1:1']));
    expect(env.session.escalations()[0].reason).toBe('On hold: cancelled; retry or force start to run it again');
    env.expectStreamed();

    expect(await env.session.answerEscalation('on-hold:t1:1', 'retry')).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(env.spawn.mock.calls.filter(([o]) => o.taskId === 't1')).toHaveLength(2));
    expect(env.ids()).toEqual([]);
  });
});

describe('the run\'s own waits', () => {
  // Pinned, not recomputed: the digest of attempt 1 of t1.
  const AT_GATE = 'merge-gate:t2:0:4db5deff3c79';

  /** t1 landed, and the ops task t2 waits at its merge gate. */
  async function atGate() {
    const isolation = new FakeWorktreeIsolation();
    const env = setup(isolation);
    env.load([task('t1', 1), task('t2', 2, { ops: true, dependencies: ['t1'] })]);
    await env.start();
    await vi.waitFor(() => expect(env.latest('t1')).toBeDefined());
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.ids()).toEqual([AT_GATE]));
    return env;
  }

  it('lists a merge gate, and a Merge all from it lets the task start', async () => {
    const env = await atGate();
    expect(env.session.escalations()[0].reason).toBe('Waits for Merge all: the work of #1 is not merged into your branch yet.');
    env.expectStreamed();

    expect(await env.session.answerEscalation(AT_GATE, 'merge-all')).toMatchObject({ ok: true, payload: { kind: 'merge', result: { outcome: 'merged' } } });

    await vi.waitFor(() => expect(env.latest('t2')).toBeDefined());
    expect(env.ids()).toEqual([]);
    env.expectStreamed();
  });

  it('holds a force start past the gate back for the same question the row asks', async () => {
    const env = await atGate();

    expect(await env.session.answerEscalation(AT_GATE, 'force-start')).toMatchObject({ ok: false, outcome: 'refused' });
    expect(env.latest('t2')).toBeUndefined();

    expect(await env.session.answerEscalation(AT_GATE, 'force-start', undefined, true)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.latest('t2')).toBeDefined());
  });

  it('lists landed work once the run has ended, and a Merge all closes it', async () => {
    const isolation = new FakeWorktreeIsolation();
    const env = setup(isolation);
    env.load([task('t1', 1)]);
    await env.start();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.kind)).toEqual(['merge-all']));
    env.expectStreamed();

    const [{ id }] = env.session.escalations();
    expect(await env.session.answerEscalation(id, 'merge-all')).toMatchObject({ ok: true });

    expect(env.ids()).toEqual([]);
    env.expectStreamed();
  });

  it('lists a Merge all git would not take until it is taken, with what stopped it in the answer', async () => {
    const isolation = new FakeWorktreeIsolation();
    const env = setup(isolation);
    env.load([task('t1', 1)]);
    await env.start();
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.kind)).toEqual(['merge-all']));
    isolation.mergeResult = { outcome: 'conflict', repo: '.', files: ['a.ts'] };

    const [{ id }] = env.session.escalations();
    expect(await env.session.answerEscalation(id, 'merge-all')).toMatchObject({ ok: false, outcome: 'refused', payload: { kind: 'merge', result: { outcome: 'conflict' } } });

    expect(env.ids()).toEqual([id]);
    env.expectStreamed();
  });

  it('lists a run a dirty checkout turned away, and stashing replays it', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'dirty' };
    const env = setup(isolation);
    env.load([task('t1', 1)]);
    await env.start();

    expect(env.session.escalations().map((e) => e.kind)).toEqual(['blocked-run']);
    env.expectStreamed();
    isolation.availability = { active: true };

    const [{ id }] = env.session.escalations();
    expect(await env.session.answerEscalation(id, 'stash')).toEqual({ ok: true, message: 'Stashed your changes: the run goes on.' });

    await vi.waitFor(() => expect(env.latest('t1')).toBeDefined());
    expect(env.ids()).toEqual([]);
    env.expectStreamed();
  });

  it('adds a resolver task for a landing conflict', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.outcomes.set('t1', 'conflict');
    const env = setup(isolation);
    env.load([task('t1', 1), task('t2', 2)]);
    await env.start();
    env.latest('t2').reportComplete({ status: 'done', summary: 'ok' });
    env.latest('t1').reportComplete({ status: 'done', summary: 'ok' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')?.status).toBe('awaiting_user'));
    await vi.waitFor(() => expect(env.ids()).toContain('conflict:t1:1'));
    env.expectStreamed();

    expect(await env.session.answerEscalation('conflict:t1:1', 'resolve-conflict')).toMatchObject({ ok: true, message: expect.stringContaining('resolves the conflict of task #1') });

    expect(env.session.planTasks.length).toBe(3);
  });
});

describe('a reload', () => {
  const paused: Partial<Task> = { status: 'awaiting_user', attemptUsage: [startAttemptUsage(2, 'claude-code', '2026-10-30T00:00:00Z')] };

  it('derives the same list from what was saved, with no run behind it', () => {
    const tasks = [
      task('t1', 1, { ...paused, awaitingReason: 'input' }),
      task('t2', 2, { ...paused, awaitingReason: 'checkpoint' }),
      task('t3', 3, { ...paused, status: 'failed' }),
      task('t4', 4, { dependencies: ['t3'] }),
    ];
    const env = setup();
    env.load(tasks);

    // The failed task's dependent is blocked, so its cause alone is listed.
    expect(taskOf(env.session, 't3')?.status).toBe('failed');
    expect(env.ids()).toEqual(['input:t1:2', 'checkpoint:t2:2', 'failed:t3:2']);
    expect(env.session.runSnapshot().escalations).toEqual(env.session.escalations());
  });

  it('lists a usage-limit pause whose resume a load cancelled', () => {
    const env = setup();
    env.load([task('t1', 1, { ...paused, awaitingReason: 'usage-limit', resumeAt: new Date(Date.now() + 3_600_000).toISOString() })]);

    expect(env.ids()).toEqual(['usage-limit:t1:2']);
  });

  it('retries a task that was waiting for input and has no runner left', async () => {
    const env = setup();
    env.load([task('t1', 1, { ...paused, awaitingReason: 'input' })]);

    expect(env.session.escalations()[0].options.map((o) => o.id)).not.toContain('reply');
    expect(await env.session.answerEscalation('input:t1:2', 'retry')).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(env.latest('t1')).toBeDefined());
    await flushMicrotasks();
  });
});

describe('no plan', () => {
  it('has nothing waiting, and refuses any answer', async () => {
    const env = setup();
    expect(env.session.escalations()).toEqual([]);
    expect(await env.session.answerEscalation('failed:t1:1', 'retry')).toMatchObject({ ok: false, outcome: 'refused' });
  });
});

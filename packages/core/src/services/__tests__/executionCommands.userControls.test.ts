import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession, taskOf, fakeConfig, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { SessionMessage } from '../SessionMessage';
import type { ExecutionActor } from '../../models/Execution';
import type { ExecutionCommand } from '../ExecutionCommands';

/**
 * The user's own controls at the command seam (ADR-0029): each is checked,
 * kept in the timeline with who asked, and saved before any surface hears of
 * it, as the commands the planner and the supervisor share are.
 */

const USER: ExecutionActor = { kind: 'user' };
const PLANNER: ExecutionActor = { kind: 'planner-turn' };
const ACT: ExecutionActor = { kind: 'supervisor', level: 'act' };

function runner() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  return { sessions, spawn, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner };
}

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });

function plan(tasks: Task[], over: Partial<LegacyPlanState> = {}): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, ...over };
}

const paused = (id: string, order: number): Task => ({
  ...task(id, order),
  status: 'awaiting_user',
  awaitingReason: 'usage-limit',
  resumeAt: new Date(Date.now() + 3_600_000).toISOString(),
  runnerSessionId: `native-${id}`,
});

function setup(opts: { isolation?: FakeWorktreeIsolation; maxParallel?: number } = {}) {
  const messages: SessionMessage[] = [];
  const r = runner();
  const session = makeSession({
    runner: r.runner,
    isolation: opts.isolation,
    config: fakeConfig({ autonomousMode: true, maxParallelSessions: opts.maxParallel ?? 3 }),
    broadcast: (m) => messages.push(m),
  });
  const latest = (taskId: string) => r.sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const spawned = (taskId: string) => r.spawn.mock.calls.map(([o]) => o).filter((o) => o.taskId === taskId);
  const timeline = () => messages.flatMap((m) => (m.type === 'execution_action' ? [m] : []));
  const run = (command: ExecutionCommand, actor: ExecutionActor = USER) => session.execute(command, actor);
  const load = (tasks: Task[], over: Partial<LegacyPlanState> = {}) => session.loadPlan(plan(tasks, over), 'goal', testWorkspace, { persist: false });
  return { session, messages, timeline, latest, spawned, run, load, ...r };
}

/** The id a `message_task` answers, through the seam as the user. */
async function sendTaskMessage(env: ReturnType<typeof setup>, taskId: string, text: string): Promise<string> {
  const outcome = await env.run({ command: 'message_task', task: taskId, text }, USER);
  if (outcome.payload?.kind !== 'message') throw new Error('message_task answered without an id');
  return outcome.payload.id;
}

describe('Resume now at the seam', () => {
  it('resumes a paused task from the Session\'s control as the user\'s retry_task from session, kept in the timeline', async () => {
    const env = setup();
    env.load([paused('t1', 1)]);

    await env.session.execute({ command: 'retry_task', task: 't1', from: 'session' }, { kind: 'user' });

    expect(env.spawned('t1')).toHaveLength(1);
    expect(env.timeline().at(-1)).toMatchObject({
      record: { command: 'retry_task', actor: 'user', outcome: 'done', task: { id: 't1', ref: '#1' } },
      text: 'You resumed task #1 "Task t1" in its saved session.',
    });
  });
});

describe('force_start', () => {
  it('starts a task past its merge gate, as the user confirmed, and keeps it in the timeline', async () => {
    const env = setup({ isolation: new FakeWorktreeIsolation() });
    env.load([task('t1', 1), task('o2', 2, { ops: true, dependencies: ['t1'] })]);
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.session.mergeGate('o2')).toEqual(['t1']));

    const outcome = await env.run({ command: 'force_start', task: 'o2' });

    expect(outcome).toEqual({ ok: true, message: 'Started task #2 "Task o2".' });
    expect(env.spawned('o2')).toHaveLength(1);
    expect(env.timeline().at(-1)).toMatchObject({
      record: { command: 'force_start', actor: 'user', outcome: 'done', task: { id: 'o2', ref: '#2' } },
      text: 'You force started task #2 "Task o2".',
    });
  });

  it('answers the line saying it is queued behind its dependencies, as its payload', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    const outcome = await env.run({ command: 'force_start', task: 't2' });

    const line = 'Task "Task t2" is approved and starts once task "Task t1" finishes.';
    expect(outcome).toEqual({ ok: true, message: line, payload: { kind: 'queued', line } });
    expect(env.spawned('t2')).toHaveLength(0);
    expect(await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' })).toMatchObject({ ok: true, payload: { kind: 'queued', line } });
    expect(env.timeline().map((m) => m.record.command)).toEqual(['run_plan', 'force_start', 'force_start']);
  });
});

describe('refusals worded for who asked', () => {
  it('names the user\'s controls to the user, and the tools to a planner', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect((await env.run({ command: 'retry_task', task: 't1', from: 'fresh' })).message)
      .toBe('Task #1 "Task t1" is running: stop it first, or send it a message.');
    expect((await env.run({ command: 'retry_task', task: 't1', from: 'fresh' }, PLANNER)).message)
      .toBe('Task #1 "Task t1" is running: stop it first with stop_task, or steer it with message_task.');
    expect((await env.run({ command: 'stop_task', task: 'gone' })).message).toBe('There is no task "gone" in this plan.');
    expect((await env.run({ command: 'stop_task', task: 'gone' }, PLANNER)).message).toMatch(/^No task matches "gone" in the current plan\. Name it by id/);
  });
});

describe('mark_complete and mark_not_done', () => {
  it('lands a task the user vouches for, and takes the completion back, each kept in the timeline', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);

    expect(await env.run({ command: 'mark_complete', task: 't1', confirmed: true })).toEqual({ ok: true, message: 'Marked task #1 "Task t1" complete.' });
    expect(taskOf(env.session, 't1')!.status).toBe('completed');
    expect(await env.run({ command: 'mark_not_done', task: 't1', confirmed: true })).toEqual({ ok: true, message: 'Marked task #1 "Task t1" not done: it waits until you retry or start it.' });
    expect(taskOf(env.session, 't1')!.status).toBe('pending');
    expect(env.timeline().map((m) => m.text)).toEqual([
      'You marked task #1 "Task t1" complete.',
      'You marked task #1 "Task t1" not done.',
    ]);
  });

  it('refuses what there is nothing to mark, in the user\'s words', async () => {
    const env = setup();
    env.load([task('t1', 1, { status: 'completed' }), task('t2', 2)]);

    expect((await env.run({ command: 'mark_complete', task: 't1' })).message).toBe('Task #1 "Task t1" has already completed.');
    expect((await env.run({ command: 'mark_not_done', task: 't2' })).message).toBe('Task #2 "Task t2" has not completed, so there is nothing to mark not done.');
  });

  it('goes through the command seam as the user', async () => {
    const env = setup();
    env.load([task('t1', 1)]);

    await env.session.execute({ command: 'mark_complete', task: 't1', confirmed: true }, { kind: 'user' });
    await env.session.execute({ command: 'mark_not_done', task: 't1', confirmed: true }, { kind: 'user' });

    expect(env.timeline().map((m) => m.record.command)).toEqual(['mark_complete', 'mark_not_done']);
  });

  it.each([['a planner turn', PLANNER], ['the supervisor at Act', ACT]] as const)('never lets %s Mark complete, whose verdicts come from evidence', async (_who, actor) => {
    const env = setup();
    env.load([task('t1', 1)]);

    const outcome = await env.run({ command: 'mark_complete', task: 't1' }, actor);

    expect(outcome).toEqual({ ok: false, outcome: 'refused', message: expect.stringMatching(/^Mark complete is the user's alone/) });
    expect(taskOf(env.session, 't1')!.status).toBe('pending');
    expect(env.timeline().at(-1)!.record).toMatchObject({ command: 'mark_complete', outcome: 'refused' });
  });
});

describe('interrupt_task', () => {
  it('stops the running turn, keeping the session, and refuses a model', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(await env.run({ command: 'interrupt_task', task: 't1' })).toEqual({ ok: true, message: 'Interrupted task #1 "Task t1": it waits for your message.' });
    expect(env.latest('t1').interrupts).toBe(1);
    expect((await env.run({ command: 'interrupt_task', task: 't1' }, PLANNER)).message).toMatch(/^Interrupt is the user's own control/);
    expect(env.latest('t1').interrupts).toBe(1);
    env.latest('t1').state = 'working';
    await env.session.execute({ command: 'interrupt_task', task: 't1' }, { kind: 'user' });
    expect(env.timeline().map((m) => m.text)).toEqual([
      'You started the plan.',
      'You interrupted task #1 "Task t1".',
      expect.stringMatching(/^The planner asked to interrupt task #1 "Task t1"; refused: Interrupt is the user's own control/),
      'You interrupted task #1 "Task t1".',
    ]);
  });

  it('refuses a task with no turn running', async () => {
    const env = setup();
    env.load([task('t1', 1)]);

    expect((await env.run({ command: 'interrupt_task', task: 't1' })).message).toBe('Task #1 "Task t1" is not running (it has not started): there is no turn to interrupt.');
  });
});

describe('force sending and taking back task messages', () => {
  it('force sends a message, interrupting the turn, and refuses a model a force send', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    const outcome = await env.run({ command: 'message_task', task: 't1', text: 'stop and use the cache', force: true });

    expect(outcome).toEqual({ ok: true, message: 'Sent to task #1 "Task t1" now: its turn is interrupted, and the runner reads it next.', payload: { kind: 'message', id: 'msg-1' } });
    expect(env.latest('t1').interrupts).toBe(1);
    expect(env.timeline().at(-1)!.text).toBe('You force sent task #1 "Task t1" a message: "stop and use the cache"');
    expect((await env.run({ command: 'message_task', task: 't1', text: 'now', force: true }, PLANNER)).message).toMatch(/^Force send is the user's own control/);
  });

  it('force sends a queued message, and takes one back, refusing one already delivered', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    const first = await sendTaskMessage(env, 't1', 'first');
    const second = await sendTaskMessage(env, 't1', 'second');

    expect(await env.run({ command: 'force_send_queued', task: 't1', id: first })).toEqual({ ok: true, message: 'Sent your queued message to task #1 "Task t1" now: its turn is interrupted, and the runner reads it next.' });
    expect(env.latest('t1').interrupts).toBe(1);
    expect(await env.run({ command: 'remove_queued', task: 't1', id: second })).toEqual({ ok: true, message: 'Took back your queued message to task #1 "Task t1".' });
    expect(env.latest('t1').queued()).toEqual([]);
    expect(env.latest('t1').delivered).toEqual(['first']);
    expect((await env.run({ command: 'remove_queued', task: 't1', id: second })).message).toBe('That message to task #1 "Task t1" was already delivered or taken back.');
    expect(env.timeline().slice(-3).map((m) => m.text)).toEqual([
      'You force sent a queued message to task #1 "Task t1".',
      'You took back a queued message to task #1 "Task t1".',
      'You asked to take back a queued message to task #1 "Task t1"; refused: That message to task #1 "Task t1" was already delivered or taken back.',
    ]);
  });
});

describe('cancel_resume', () => {
  it('keeps a paused task from resuming on its own, and refuses one with no resume scheduled', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2)]);
    await env.run({ command: 'force_start', task: 't1' });
    const reset = new Date(Date.now() + 3_600_000);
    const time = `${reset.getUTCHours() % 12 || 12}:${String(reset.getUTCMinutes()).padStart(2, '0')}${reset.getUTCHours() >= 12 ? 'pm' : 'am'}`;
    const limit = `You've hit your session limit · resets ${time} (UTC)`;
    env.latest('t1').emitEvent({ type: 'error', message: limit });
    env.latest('t1').emitOutput(`${limit}\n`);
    env.latest('t1').emitTurnEnd('failed');
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.resumeAt).toBeDefined());
    env.messages.length = 0;

    expect(await env.run({ command: 'cancel_resume', task: 't1' })).toEqual({ ok: true, message: 'Task #1 "Task t1" no longer resumes on its own at its usage limit\'s reset: resume it when you choose.' });
    expect(taskOf(env.session, 't1')!.resumeAt).toBeUndefined();
    expect((await env.run({ command: 'cancel_resume', task: 't1' })).message).toBe('Task #1 "Task t1" has no resume scheduled.');
    expect((await env.run({ command: 'cancel_resume', task: 't2' }, ACT)).message).toMatch(/^Cancelling a scheduled resume is the user's own control/);
    expect(env.timeline().map((m) => [m.record.command, m.record.outcome])).toEqual([
      ['cancel_resume', 'done'], ['cancel_resume', 'refused'], ['cancel_resume', 'refused'],
    ]);
    expect(env.timeline()[0].text).toBe('You cancelled the scheduled resume of task #1 "Task t1".');
  });
});

/** t1 running and waiting at a checkpoint; `answer` is what the runner's call resolves to. */
async function atCheckpoint() {
  const env = setup();
  env.load([task('t1', 1), task('t2', 2)]);
  await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
  const answer = env.latest('t1').callCheckpoint('Drop the table?');
  await vi.waitFor(() => expect(env.session.awaitsCheckpoint('t1')).toBe(true));
  return { ...env, answer };
}

describe('answer_checkpoint', () => {
  it('lets the task go on when the user approves', async () => {
    const env = await atCheckpoint();

    expect(await env.run({ command: 'answer_checkpoint', task: 't1', answer: 'approve' })).toEqual({ ok: true, message: 'Approved the checkpoint of task #1 "Task t1": it goes on.' });
    await expect(env.answer).resolves.toEqual({ kind: 'continue' });
    expect(env.timeline().at(-1)!.text).toBe('You approved the checkpoint of task #1 "Task t1".');
  });

  it('sends the runner the user\'s reason when they reject', async () => {
    const env = await atCheckpoint();

    expect(await env.run({ command: 'answer_checkpoint', task: 't1', answer: 'reject', reason: 'not on production' })).toMatchObject({ ok: true });
    await expect(env.answer).resolves.toEqual({ kind: 'rejected', reason: 'not on production' });
    expect(env.timeline().at(-1)!.text).toBe('You rejected the checkpoint of task #1 "Task t1": "not on production"');
  });

  it('refuses a task not waiting at one', async () => {
    const env = await atCheckpoint();

    expect((await env.run({ command: 'answer_checkpoint', task: 't2', answer: 'approve' })).message)
      .toBe('Task #2 "Task t2" is not waiting at a checkpoint: it was answered already, withdrawn, or has no runner left to hear it.');
    expect(env.session.awaitsCheckpoint('t1')).toBe(true);
  });

  describe('by anyone but the user, and the supervisor at Act', () => {
    it.each([
      ['a planner turn', PLANNER as ExecutionActor, /^A checkpoint is the user's to answer in their own turn.*from the task's checkpoint card \(Approve or Reject\).*Only the supervisor at Act answers one, in a wake-up turn\.$/],
      ['autorun', { kind: 'autorun' } as ExecutionActor, /^A checkpoint is the user's to answer in their own turn.*checkpoint card/],
      ['the supervisor at Watch', { kind: 'supervisor', level: 'watch' } as ExecutionActor, /^You are the supervisor at Watch.*cannot answer a checkpoint.*checkpoint card/],
      ['the supervisor with the supervisor off', { kind: 'supervisor', level: 'off' } as ExecutionActor, /^The supervisor is off.*cannot answer a checkpoint.*checkpoint card/],
    ])('refuses %s, saying who answers instead, and leaves the runner waiting', async (_who, actor, words) => {
      const env = await atCheckpoint();

      expect(await env.run({ command: 'answer_checkpoint', task: 't1', answer: 'approve' }, actor)).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(words) });
      expect(await env.run({ command: 'answer_checkpoint', task: 't1', answer: 'reject', reason: 'no' }, actor)).toMatchObject({ ok: false, outcome: 'refused' });
      expect(env.session.awaitsCheckpoint('t1')).toBe(true);
      expect(env.timeline().at(-1)!.record).toMatchObject({ command: 'answer_checkpoint', outcome: 'refused' });
    });
  });

  describe('by the supervisor at Act', () => {
    it('refuses a rejection with no reason, which would leave the runner nothing to act on', async () => {
      const env = await atCheckpoint();

      for (const reason of [undefined, '   ']) {
        expect((await env.run({ command: 'answer_checkpoint', task: 't1', answer: 'reject', ...(reason !== undefined ? { reason } : {}) }, ACT)).message)
          .toBe('A rejection needs a reason: the runner is told it, and acts on it. Say what it should do instead.');
      }
      expect(env.session.awaitsCheckpoint('t1')).toBe(true);
    });

    it('refuses a checkpoint already answered, as it does the user', async () => {
      const env = await atCheckpoint();
      await env.run({ command: 'answer_checkpoint', task: 't1', answer: 'approve' });

      expect(await env.run({ command: 'answer_checkpoint', task: 't1', answer: 'approve' }, ACT)).toMatchObject({
        ok: false,
        outcome: 'refused',
        message: 'Task #1 "Task t1" is not waiting at a checkpoint: it was answered already, withdrawn, or has no runner left to hear it.',
      });
      expect(env.timeline().at(-1)!.text).toBe('The supervisor asked to answer the checkpoint of task #1 "Task t1"; refused: Task #1 "Task t1" is not waiting at a checkpoint: it was answered already, withdrawn, or has no runner left to hear it.');
    });

    it('lets the task go on when it approves, and the timeline names the supervisor', async () => {
      const env = await atCheckpoint();

      expect(await env.run({ command: 'answer_checkpoint', task: 't1', answer: 'approve' }, ACT)).toEqual({ ok: true, message: 'Approved the checkpoint of task #1 "Task t1": it goes on.' });
      await expect(env.answer).resolves.toEqual({ kind: 'continue' });
      expect(env.timeline().at(-1)).toMatchObject({
        record: { command: 'answer_checkpoint', actor: 'supervisor', level: 'act', outcome: 'done', task: { id: 't1', ref: '#1' } },
        text: 'Approved the checkpoint of task #1 "Task t1": by supervisor.',
      });
    });

    it('tells the runner its reason when it rejects, and the timeline keeps the reason', async () => {
      const env = await atCheckpoint();

      expect(await env.run({ command: 'answer_checkpoint', task: 't1', answer: 'reject', reason: 'the table is read by the billing job' }, ACT))
        .toEqual({ ok: true, message: 'Rejected the checkpoint of task #1 "Task t1": the runner is told the reason.' });
      await expect(env.answer).resolves.toEqual({ kind: 'rejected', reason: 'the table is read by the billing job' });
      expect(env.timeline().at(-1)).toMatchObject({
        record: { actor: 'supervisor', level: 'act', outcome: 'done', detail: 'the table is read by the billing job' },
        text: 'Rejected the checkpoint of task #1 "Task t1": by supervisor: "the table is read by the billing job"',
      });
    });
  });
});

describe('message_task to a task at a checkpoint', () => {
  const message = (env: Awaited<ReturnType<typeof atCheckpoint>>, actor: ExecutionActor) => env.run({ command: 'message_task', task: 't1', text: 'go ahead' }, actor);

  it('tells the user to approve or reject it, as before', async () => {
    const env = await atCheckpoint();

    expect(await message(env, USER)).toMatchObject({ ok: false, outcome: 'refused', message: 'Task #1 "Task t1" is at a checkpoint: approve or reject it instead.' });
  });

  it('tells a planner turn that the user answers it from the task\'s checkpoint card', async () => {
    const env = await atCheckpoint();

    expect(await message(env, PLANNER)).toMatchObject({
      ok: false,
      outcome: 'refused',
      message: 'Task #1 "Task t1" is at a checkpoint, which a message does not answer: the user answers it from the task\'s checkpoint card (Approve or Reject). Tell them what the runner asks and what you would answer, with why.',
    });
  });

  it('tells the supervisor at Act to answer it with answer_checkpoint, or leave it to the user', async () => {
    const env = await atCheckpoint();

    expect(await message(env, ACT)).toMatchObject({
      ok: false,
      outcome: 'refused',
      message: 'Task #1 "Task t1" is at a checkpoint, which a message does not answer: answer it with answer_checkpoint (approve, or reject with a reason), or leave it to the user and tell them why.',
    });
  });

  it('delivers nothing, and keeps the refusal in the timeline', async () => {
    const env = await atCheckpoint();

    await message(env, ACT);

    expect(env.latest('t1').delivered).toEqual([]);
    expect(env.latest('t1').messages).toEqual([]);
    expect(env.session.awaitsCheckpoint('t1')).toBe(true);
    expect(env.timeline().at(-1)!.record).toMatchObject({ command: 'message_task', actor: 'supervisor', outcome: 'refused' });
  });
});

describe('approve_review', () => {
  it('approves every task in the plan and runs it, and refuses a model', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { status: 'draft' });

    expect((await env.run({ command: 'approve_review' }, PLANNER)).message).toMatch(/^Approving the review is the user's own control/);
    expect(env.spawned('t1')).toHaveLength(0);
    await env.session.execute({ command: 'approve_review' }, { kind: 'user' });

    expect(env.spawned('t1')).toHaveLength(1);
    expect(env.session.isApproved('t2')).toBe(true);
    expect(env.timeline().at(-1)).toMatchObject({ record: { command: 'approve_review', actor: 'user', outcome: 'done' }, text: 'You approved the plan, which starts it.' });
  });
});

describe('the user\'s answer_approval', () => {
  async function asking() {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    env.latest('t1').requestPermission('p1', 'Bash', { command: 'git push' }, [{ type: 'addRules' }]);
    await vi.waitFor(() => expect(env.session.outstandingApprovals()).toHaveLength(1));
    return env;
  }

  it.each([
    ['allow', { decision: 'allow' }, 'You allowed a request of task #1 "Task t1".'],
    ['allowForTask', { decision: 'allowForTask' }, 'You allowed a request of task #1 "Task t1" for the rest of the task.'],
  ] as const)('answers "%s", which only the user may', async (answer, decision, line) => {
    const env = await asking();

    expect(await env.run({ command: 'answer_approval', task: 't1', answer })).toMatchObject({ ok: true });
    expect(env.latest('t1').answers).toEqual([{ id: 'p1', decision }]);
    expect(env.timeline().at(-1)!.text).toBe(line);
  });

  it('denies with the note, and refuses an escalation, which hands a request to the user', async () => {
    const env = await asking();

    expect((await env.run({ command: 'answer_approval', task: 't1', answer: 'escalate' })).message).toBe('"escalate" is not an answer: use "allow", "allowForTask" or "deny".');
    expect(await env.run({ command: 'answer_approval', task: 't1', answer: 'deny', note: 'not to main' })).toMatchObject({ ok: true });
    expect(env.latest('t1').answers).toEqual([{ id: 'p1', decision: { decision: 'deny', note: 'not to main' } }]);
    expect(env.timeline().at(-1)!.text).toBe('You denied a request of task #1 "Task t1" with the note "not to main".');
  });
});

describe('the user\'s merge_all', () => {
  async function landed(tasks: Task[], mergeResult?: FakeWorktreeIsolation['mergeResult']) {
    const isolation = new FakeWorktreeIsolation();
    if (mergeResult) isolation.mergeResult = mergeResult;
    const env = setup({ isolation });
    env.load(tasks);
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    return env;
  }

  it('answers the whole merge result, and that the run goes on, for the Merge all card', async () => {
    const env = await landed([task('t1', 1), task('o2', 2, { ops: true, dependencies: ['t1'] })]);
    await vi.waitFor(() => expect(env.session.mergeGate('o2')).toEqual(['t1']));

    expect(await env.run({ command: 'merge_all' })).toEqual({
      ok: true,
      message: 'Merged the run\'s landed work into your branch. Tasks waiting at a merge gate for it can start.',
      payload: { kind: 'merge', result: { outcome: 'merged' } },
    });
    expect(env.messages.map((m) => m.type)).not.toContain('run_closed');
    expect(env.timeline().at(-1)!.text).toBe('You merged the run\'s work into your branch.');
  });

  it('says the run closed when the merge left nothing to hand over', async () => {
    const env = await landed([task('t1', 1)]);
    await vi.waitFor(() => expect(env.session.runMergeView()).not.toBeNull());

    const merged = await env.session.execute({ command: 'merge_all' }, { kind: 'user' });
    expect(merged).toMatchObject({ ok: true, payload: { kind: 'merge', result: { outcome: 'merged' } } });
    expect(env.messages.map((m) => m.type)).toContain('run_closed');
    expect(env.timeline().at(-1)!.record).toMatchObject({ command: 'merge_all', actor: 'user', outcome: 'done' });
  });

  it('answers a merge that stopped as refused, with the result the card shows', async () => {
    const conflict = { outcome: 'conflict' as const, repo: '.', files: ['src/a.ts'] };
    const env = await landed([task('t1', 1), task('o2', 2, { ops: true, dependencies: ['t1'] })], conflict);
    await vi.waitFor(() => expect(env.session.mergeGate('o2')).toEqual(['t1']));

    expect(await env.run({ command: 'merge_all' })).toEqual({
      ok: false, outcome: 'refused',
      message: 'Merge all stopped: it conflicts in .: src/a.ts. Nothing was merged.',
      payload: { kind: 'merge', result: conflict },
    });
    expect(await env.session.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: false, outcome: 'refused', payload: { kind: 'merge', result: conflict } });
  });
});

describe('the user\'s stop_run with nothing running', () => {
  it('is an ok no-op that keeps nothing in the timeline, while a planner is still told there is no run', async () => {
    const env = setup();
    env.load([task('t1', 1)]);

    expect(await env.run({ command: 'stop_run' })).toEqual({ ok: true, message: 'Nothing is running: there is nothing to stop.' });
    expect(env.timeline()).toEqual([]);
    expect(env.messages.map((m) => m.type)).not.toContain('execution_stopped');
    expect(await env.run({ command: 'stop_run' }, PLANNER)).toMatchObject({ ok: false, message: 'Nothing is running: there is no run to stop.' });
  });
});

describe('the user\'s controls are the user\'s', () => {
  const commands: Array<[string, ExecutionCommand]> = [
    ['force_start', { command: 'force_start', task: 't2' }],
    ['mark_complete', { command: 'mark_complete', task: 't1' }],
    ['mark_not_done', { command: 'mark_not_done', task: 't1' }],
    ['revert_task', { command: 'revert_task', task: 't1', confirmed: true }],
    ['interrupt_task', { command: 'interrupt_task', task: 't1' }],
    ['a force send', { command: 'message_task', task: 't1', text: 'now', force: true }],
    ['force_send_queued', { command: 'force_send_queued', task: 't1', id: 'msg-1' }],
    ['remove_queued', { command: 'remove_queued', task: 't1', id: 'msg-1' }],
    ['cancel_resume', { command: 'cancel_resume', task: 't1' }],
    ['approve_review', { command: 'approve_review' }],
  ];
  const actors: Array<[string, ExecutionActor]> = [['a planner turn', PLANNER], ['the supervisor at Act', ACT], ['autorun', { kind: 'autorun' }]];

  it.each(commands.flatMap(([name, command]) => actors.map(([who, actor]) => [name, who, command, actor] as const)))(
    'refuses %s to %s, keeping the refusal, and changes nothing',
    async (_name, _who, command, actor) => {
      const env = setup();
      env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
      await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
      const before = env.session.planTasks.map((t) => t.status);

      const outcome = await env.run(command, actor);

      expect(outcome).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/is the user's (own control|alone)/) });
      expect(env.session.planTasks.map((t) => t.status)).toEqual(before);
      expect(env.spawned('t2')).toHaveLength(0);
      expect(env.latest('t1').interrupts).toBe(0);
      expect(env.timeline().at(-1)!.record).toMatchObject({ command: command.command, outcome: 'refused' });
    },
  );
});

describe('a control on a task while Mark complete lands its work', () => {
  async function landing(failFirst: boolean) {
    const isolation = new FakeWorktreeIsolation();
    const env = setup({ isolation });
    env.load([task('t1', 1), task('t2', 2)]);
    await env.run({ command: 'run_task', task: 't1' });
    if (failFirst) {
      env.latest('t1').emitExit(1);
      await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('failed'));
    }
    // Stopped first, as a manual override of a running task must be.
    if (!failFirst) await env.run({ command: 'stop_run' });
    const openMerge = isolation.holdIntegration('t1');
    const marked = env.run({ command: 'mark_complete', task: 't1', confirmed: true });
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1']));
    return { env, openMerge, marked };
  }

  const refused = { ok: false, message: 'Task #1 "Task t1" is being marked complete: its work is landing.' };

  it('refuses a retry and a skip of a failed task', async () => {
    const { env, openMerge, marked } = await landing(true);

    expect(await env.run({ command: 'retry_task', task: 't1', from: 'fresh' })).toMatchObject(refused);
    expect(await env.run({ command: 'skip_task', task: 't1' })).toMatchObject(refused);
    openMerge();
    await marked;

    expect(taskOf(env.session, 't1')!.status).toBe('completed');
  });

  it('refuses a stop of a task marked complete while it ran', async () => {
    const { env, openMerge, marked } = await landing(false);

    expect(await env.run({ command: 'stop_task', task: 't1' })).toMatchObject(refused);
    openMerge();
    await marked;

    expect(taskOf(env.session, 't1')!.status).toBe('completed');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@ordewell/core';
import { daemonHarness, task } from './daemonHarness';

/**
 * Every control a surface sends the daemon (ADR-0029) reaches the command seam
 * as the user: it answers in the seam's words, and keeps exactly one line in
 * the timeline, whichever route carried it.
 */

type Harness = ReturnType<typeof daemonHarness>;

let harness: Harness;
afterEach(() => harness?.session.destroy());

function start(tasks: Task[], over?: Parameters<Harness['load']>[1]): Harness {
  harness = daemonHarness();
  harness.load(tasks, over);
  return harness;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Queue a task message through the daemon, answering the id a surface reads. */
async function queueMessage(h: Harness, taskId: string, text: string): Promise<string> {
  const body = await json(await h.command({ command: 'message_task', task: taskId, text }));
  return String((body.payload as { id: string }).id);
}

describe('a control from the daemon lands one execution_action line, worded by the seam', () => {
  it('Mark complete and Mark not done answer the seam\'s line', async () => {
    const h = start([task('t1', 1)]);

    const complete = await h.command({ command: 'mark_complete', task: 't1', confirmed: true });
    expect(await json(complete)).toEqual({ ok: true, message: 'Marked task #1 "Task t1" complete.' });
    expect(h.timeline().map((m) => m.text)).toEqual(['You marked task #1 "Task t1" complete.']);

    const undone = await h.command({ command: 'mark_not_done', task: 't1', confirmed: true });
    expect(await json(undone)).toEqual({ ok: true, message: 'Marked task #1 "Task t1" not done: it waits until you retry or start it.' });
    expect(h.timeline().map((m) => m.record.command)).toEqual(['mark_complete', 'mark_not_done']);
  });

  it('names a task by its order too, as the seam resolves it', async () => {
    const h = start([task('t1', 1), task('t2', 2)]);

    const res = await h.command({ command: 'mark_complete', task: '#2', confirmed: true });

    expect(await json(res)).toEqual({ ok: true, message: 'Marked task #2 "Task t2" complete.' });
    expect(h.timeline()).toHaveLength(1);
  });

  it('refuses an AI task\'s override that carries no yes, and changes nothing', async () => {
    const h = start([task('t1', 1)]);

    const res = await h.command({ command: 'mark_complete', task: 't1' });
    const refusal = await json(res) as { error: string; code: string };

    expect(res.status).toBe(400);
    expect(refusal.code).toBe('refused');
    expect(refusal.error).toContain('needs the user\'s explicit yes');
    expect(h.session.planState!.tasks[0].status).toBe('pending');
    expect(h.timeline().map((m) => m.record.outcome)).toEqual(['refused']);
  });

  it('refuses an override of a task in a plan that is running, whatever the yes', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });

    const res = await h.command({ command: 'mark_complete', task: 't1', confirmed: true });

    expect(res.status).toBe(400);
    expect((await json(res) as { error: string }).error).toContain('Stop the run first');
    expect(h.session.planState!.tasks[0].status).toBe('in_progress');
  });

  it('answers a refusal as the seam words it, and keeps it once', async () => {
    const h = start([task('t1', 1, { status: 'completed' })]);

    const res = await h.command({ command: 'mark_complete', task: 't1', confirmed: true });

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'Task #1 "Task t1" has already completed.', code: 'refused' });
    expect(h.timeline().map((m) => m.record.outcome)).toEqual(['refused']);
  });

  it('answers a task the plan lacks as the seam does, not as a bare 404', async () => {
    const h = start([task('t1', 1)]);

    const res = await h.command({ command: 'mark_complete', task: 'ghost' });

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'There is no task "ghost" in this plan.', code: 'refused' });
  });

  it('Force start answers the line saying it is queued behind its dependencies', async () => {
    const h = start([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    h.forgetTimeline();

    const res = await h.command({ command: 'force_start', task: 't2' });

    const queued = 'Task "Task t2" is approved and starts once task "Task t1" finishes.';
    expect(await json(res)).toEqual({ ok: true, message: queued, payload: { kind: 'queued', line: queued } });
    expect(h.timeline().map((m) => m.record.command)).toEqual(['force_start']);
  });

  it('Force start of a free task answers that it started', async () => {
    const h = start([task('t1', 1)]);

    const res = await h.command({ command: 'force_start', task: 't1' });

    expect(await json(res)).toEqual({ ok: true, message: 'Started task #1 "Task t1".' });
    expect(h.timeline().map((m) => m.text)).toEqual(['You force started task #1 "Task t1".']);
  });

  it('Interrupt stops the running turn', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    h.forgetTimeline();

    const res = await h.command({ command: 'interrupt_task', task: 't1' });

    expect(await json(res)).toEqual({ ok: true, message: 'Interrupted task #1 "Task t1": it waits for your message.' });
    expect(h.latest('t1').interrupts).toBe(1);
    expect(h.timeline().map((m) => m.text)).toEqual(['You interrupted task #1 "Task t1".']);
  });

  it('Resume now resumes a task paused on a usage limit in its saved session', async () => {
    const h = start([{
      ...task('t1', 1),
      status: 'awaiting_user',
      awaitingReason: 'usage-limit',
      resumeAt: new Date(Date.now() + 3_600_000).toISOString(),
      runnerSessionId: 'native-t1',
    }]);

    const res = await h.command({ command: 'retry_task', task: 't1', from: 'session' });

    expect(await json(res)).toEqual({ ok: true, message: 'Resumed task #1 "Task t1" in its saved session.' });
    expect(h.timeline().map((m) => m.record.command)).toEqual(['retry_task']);
  });

  it('cancelling a scheduled resume answers the seam\'s line, and refuses a task with none', async () => {
    const h = start([task('t1', 1), task('t2', 2)]);
    await h.session.execute({ command: 'force_start', task: 't1' }, { kind: 'user' });
    const reset = new Date(Date.now() + 3_600_000);
    const time = `${reset.getUTCHours() % 12 || 12}:${String(reset.getUTCMinutes()).padStart(2, '0')}${reset.getUTCHours() >= 12 ? 'pm' : 'am'}`;
    const limit = `You've hit your session limit · resets ${time} (UTC)`;
    h.latest('t1').emitEvent({ type: 'error', message: limit });
    h.latest('t1').emitOutput(`${limit}\n`);
    h.latest('t1').emitTurnEnd('failed');
    await vi.waitFor(() => expect(h.session.planTasks[0].resumeAt).toBeDefined());
    h.forgetTimeline();

    const cancelled = await h.command({ command: 'cancel_resume', task: 't1' });
    const none = await h.command({ command: 'cancel_resume', task: 't2' });

    expect(await json(cancelled)).toEqual({ ok: true, message: 'Task #1 "Task t1" no longer resumes on its own at its usage limit\'s reset: resume it when you choose.' });
    expect(none.status).toBe(400);
    expect(await json(none)).toEqual({ error: 'Task #2 "Task t2" has no resume scheduled.', code: 'refused' });
    expect(h.timeline().map((m) => [m.record.command, m.record.outcome])).toEqual([['cancel_resume', 'done'], ['cancel_resume', 'refused']]);
  });

  it('answers a checkpoint through the seam, and keeps 409 for one nobody waits at', async () => {
    const h = start([task('t1', 1), task('t2', 2)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    h.forgetTimeline();
    const approved = h.latest('t1').callCheckpoint('Drop the table?');
    await vi.waitFor(() => expect(h.session.awaitsCheckpoint('t1')).toBe(true));

    const res = await h.post('tasks/t1/checkpoint/approve');

    expect(await json(res)).toEqual({ ok: true, message: 'Approved the checkpoint of task #1 "Task t1": it goes on.' });
    await expect(approved).resolves.toEqual({ kind: 'continue' });
    expect(h.timeline().map((m) => m.text)).toEqual(['You approved the checkpoint of task #1 "Task t1".']);

    const none = await h.post('tasks/t2/checkpoint/approve');
    expect(none.status).toBe(409);
    expect(await json(none)).toMatchObject({ code: 'checkpoint_not_waiting' });
  });

  it('hands a raise on an approval to the seam, and leaves a bare approval without one', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    h.latest('t1').callCheckpoint('More budget?');
    await vi.waitFor(() => expect(h.session.awaitsCheckpoint('t1')).toBe(true));

    // A task with no budget: the seam's own refusal proves the raise reached it.
    const res = await h.post('tasks/t1/checkpoint/approve', { raiseTokens: 800000 });

    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'Task #1 "Task t1" holds no budget: only a delegated task\'s child can be raised.' });
    expect(h.session.awaitsCheckpoint('t1')).toBe(true);
  });

  it('hands an approval\'s words to the seam, for a delegated task\'s answer', async () => {
    const h = start([task('t1', 1)]);
    const execute = vi.spyOn(h.session, 'execute');
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    h.latest('t1').callCheckpoint('Which rounding?');
    await vi.waitFor(() => expect(h.session.awaitsCheckpoint('t1')).toBe(true));

    await h.post('tasks/t1/checkpoint/approve', { reason: ' Half away from zero. ' });

    expect(execute).toHaveBeenCalledWith({ command: 'answer_checkpoint', task: 't1', answer: 'approve', reason: 'Half away from zero.' }, expect.anything());
  });

  it('refuses a raise that is not a whole number of tokens', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    h.latest('t1').callCheckpoint('More budget?');
    await vi.waitFor(() => expect(h.session.awaitsCheckpoint('t1')).toBe(true));

    const res = await h.post('tasks/t1/checkpoint/approve', { raiseTokens: 'lots' });

    expect(res.status).toBe(400);
    expect(h.session.awaitsCheckpoint('t1')).toBe(true);
  });

  it('finds the checkpoint of a task named by its order, as the seam does', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    const answer = h.latest('t1').callCheckpoint('Drop the table?');
    await vi.waitFor(() => expect(h.session.awaitsCheckpoint('t1')).toBe(true));

    const res = await h.post('tasks/1/checkpoint/approve');

    expect(res.status).toBe(200);
    await expect(answer).resolves.toEqual({ kind: 'continue' });
  });

  it('rejects a checkpoint with the user\'s reason, trimmed', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    h.forgetTimeline();
    const answer = h.latest('t1').callCheckpoint('Drop the table?');
    await vi.waitFor(() => expect(h.session.awaitsCheckpoint('t1')).toBe(true));

    const res = await h.post('tasks/t1/checkpoint/reject', { reason: '  not on production  ' });

    expect(res.status).toBe(200);
    await expect(answer).resolves.toEqual({ kind: 'rejected', reason: 'not on production' });
    expect(h.timeline().map((m) => m.text)).toEqual(['You rejected the checkpoint of task #1 "Task t1": "not on production"']);
  });

  it('force sends a message, and force sends and takes back a queued one', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });

    const forced = await h.command({ command: 'message_task', task: 't1', text: 'stop and use the cache', force: true });
    expect(await json(forced)).toMatchObject({ ok: true, payload: { kind: 'message', id: 'msg-1' } });
    expect(h.timeline().at(-1)!.text).toBe('You force sent task #1 "Task t1" a message: "stop and use the cache"');

    const first = await queueMessage(h, 't1', 'first');
    h.forgetTimeline();
    const sent = await h.command({ command: 'force_send_queued', task: 't1', id: first });
    // Queued after the force send: one queued before it would have gone with it (ADR-0023, F1).
    const second = await queueMessage(h, 't1', 'second');
    const removed = await h.command({ command: 'remove_queued', task: 't1', id: second });

    expect(await json(sent)).toEqual({ ok: true, message: 'Sent your queued message to task #1 "Task t1" now: its turn is interrupted, and the runner reads it next.' });
    expect(await json(removed)).toEqual({ ok: true, message: 'Took back your queued message to task #1 "Task t1".' });
    expect(h.timeline().map((m) => m.record.command)).toEqual(['force_send_queued', 'message_task', 'remove_queued']);
  });

  it('refuses a queued message already delivered, in the seam\'s words', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    const id = await queueMessage(h, 't1', 'first');
    await h.command({ command: 'force_send_queued', task: 't1', id });
    h.forgetTimeline();

    const res = await h.command({ command: 'remove_queued', task: 't1', id });

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'That message to task #1 "Task t1" was already delivered or taken back.', code: 'refused' });
    expect(h.timeline().map((m) => m.record.outcome)).toEqual(['refused']);
  });

  it('approves the review, answering the plan it set going', async () => {
    const h = start([task('t1', 1)], { status: 'draft' });

    const res = await h.post('review/approve');

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ plan: { tasks: [{ id: 't1' }] }, message: 'Approved the plan: it runs, each task starting once its dependencies finish.' });
    expect(h.timeline().map((m) => m.text)).toEqual(['You approved the plan, which starts it.']);
  });

  it('runs and stops with the seam\'s words', async () => {
    const h = start([task('t1', 1)]);

    const run = await h.post('execute');
    const stop = await h.post('stop');

    expect(await json(run)).toMatchObject({ status: 'running', message: expect.stringContaining('The plan is running') });
    expect(await json(stop)).toMatchObject({ status: 'stopped', message: expect.stringContaining('Stopped the run') });
    expect(h.timeline().map((m) => m.record.command)).toEqual(['run_plan', 'stop_run']);
  });

  it('a Stop with nothing running keeps nothing in the timeline', async () => {
    const h = start([task('t1', 1)]);

    const stop = await h.post('stop');

    expect(await json(stop)).toEqual({ status: 'stopped', message: 'Nothing is running: there is nothing to stop.' });
    expect(h.timeline()).toEqual([]);
  });

  it('answers a runner request the user allows, or denies with a note, through the seam', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    h.latest('t1').requestPermission('p1', 'Bash', { command: 'git push' }, [{ type: 'addRules' }]);
    h.latest('t1').requestPermission('p2', 'Bash', { command: 'rm -rf dist' });
    await vi.waitFor(() => expect(h.session.outstandingApprovals()).toHaveLength(2));
    h.forgetTimeline();

    const [first, second] = h.session.outstandingApprovals();
    const allowed = await h.app.request(`/api/approvals/s1/${first.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'allowForTask' }) });
    const denied = await h.app.request(`/api/approvals/s1/${second.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'deny', note: 'not now' }) });

    expect(await json(allowed)).toEqual({ ok: true, granted: true, decision: 'allowForTask' });
    expect(await json(denied)).toEqual({ ok: true, granted: false, decision: 'deny' });
    expect(h.latest('t1').answers).toEqual([
      { id: 'p1', decision: { decision: 'allowForTask' } },
      { id: 'p2', decision: { decision: 'deny', note: 'not now' } },
    ]);
    expect(h.timeline().map((m) => m.text)).toEqual([
      'You allowed a request of task #1 "Task t1" for the rest of the task.',
      'You denied a request of task #1 "Task t1" with the note "not now".',
    ]);
  });
});

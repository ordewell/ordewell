import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { ctx, hitLimit, prose, RESUME_AT, settled, supervised, task, until, type Env } from './supervisorTestKit';
import type { ExecutionActor } from '../../models/Execution';
import type { Task } from '../../models/Task';

/**
 * Round 5 of the reload, loop and autorun review: the round-4 fix for "a
 * made-manual task at a usage limit left the run held" covers the task that is
 * already manual when the limit hits, and the task a later verdict sweeps. A
 * direct edit that makes a paused task manual is neither, so the run stays
 * held, with no inbox entry, until the limit resets. Its report's other
 * findings are here too: what Execute and run_plan do to an open run with
 * nothing live or under a hold, and a body task behind its loop's check.
 */

const NOW = new Date('2026-10-11T18:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); });

const USER: ExecutionActor = { kind: 'user' };
const PLANNER: ExecutionActor = { kind: 'planner-turn' };
const BY_HAND: Partial<Task> = { type: 'user', userSteps: [{ order: 1, instruction: 'do it by hand', completed: false }] };
const manual = (id: string, order: number) => task(id, order, BY_HAND);

async function paused(env: Env, id: string): Promise<void> {
  await until(() => env.run.spawnedIds().includes(id));
  hitLimit(env.run.of(id));
  await until(() => !!taskOf(env.session, id)?.resumeAt);
  await settled();
}

async function failed(env: Env, id: string): Promise<void> {
  await until(() => env.run.spawnedIds().includes(id));
  env.run.of(id).reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
  await until(() => taskOf(env.session, id)?.status === 'failed');
  await settled();
}

describe('a direct edit that makes a paused task manual', () => {
  it('ends the pause and lets the run go on, with no resume promised', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 1 } });
    await until(() => env.run.spawnedIds().includes('t1'));
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')?.status === 'awaiting_user');
    await settled();
    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'ai', awaitingReason: 'usage-limit' });
    expect(taskOf(env.session, 't1')?.resumeAt).toBeDefined();

    expect(await env.session.updateTask('t1', { type: 'user', userSteps: [{ order: 1, instruction: 'do it by hand', completed: false }] })).not.toBeNull();
    await settled();

    // The manual task is the user's to do, and the pause it was under is over.
    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'user', status: 'pending' });
    expect(taskOf(env.session, 't1')?.resumeAt).toBeUndefined();
    expect(env.session.activity.resumable).toBe(false);
    // The run carries on with what the pause held back, and the task is listed by hand.
    await until(() => env.run.spawnedIds().includes('t2'));
    expect(env.session.escalations().find((e) => e.task?.id === 't1')?.kind).toBe('by-hand');
    env.session.destroy();
  });

  it('tells the surfaces as the edit lands: what they hold says the pause is over', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'off' } });
    await paused(env, 't1');

    await env.session.updateTask('t1', BY_HAND);
    await settled();

    const last = env.messages.flatMap((m) => (m.type === 'status_update' ? [m] : [])).at(-1);
    expect(last?.tasks.find((t) => t.id === 't1')).toMatchObject({ status: 'pending' });
    expect(last?.activity?.resumable).toBe(false);
    expect(last?.escalations?.find((e) => e.task?.id === 't1')).toMatchObject({ kind: 'by-hand' });
    env.session.destroy();
  });

  it('leaves the hold of another task waiting on the same reset', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2), task('t3', 3)], { settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 2 } });
    await until(() => env.run.spawnedIds().includes('t2'));
    await paused(env, 't1');
    await paused(env, 't2');

    await env.session.updateTask('t1', BY_HAND);
    await settled();

    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'user', status: 'pending' });
    expect(taskOf(env.session, 't2')?.resumeAt).toBeDefined();
    expect(env.session.activity.resumable).toBe(true);
    expect(env.run.spawnedIds()).not.toContain('t3');
    env.session.destroy();
  });

  it('owes no start when a planner\'s edit also moves it to another runner: a manual task never takes one', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { execute: false, settings: { supervisorLevel: 'off' }, plan: { runners: ['claude-code', 'codex'] } });
    expect((await env.session.execute({ command: 'run_task', task: 't1' }, USER)).ok).toBe(true);
    await paused(env, 't1');

    void env.session.continueConversation('make it manual');
    await until(() => env.planner.calls.length === 1);
    expect((await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 't1', changes: { type: 'user', userSteps: ['do it by hand'], assignedRunner: 'codex' } }] } as never, ctx)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Changed.'));
    await settled();

    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'user', status: 'pending' });
    expect(taskOf(env.session, 't1')?.carriedFrom).toBeUndefined();
    expect(env.session.activity).toMatchObject({ resumable: false, advancesOnItsOwn: false });
    env.session.destroy();
  });

  it('frees a failed task the same way, in a run or not: it has nothing to retry', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'off' } });
    await failed(env, 't1');

    await env.session.updateTask('t1', BY_HAND);
    await settled();

    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'user', status: 'pending' });
    expect(env.session.escalations().find((e) => e.task?.id === 't1')).toMatchObject({ kind: 'by-hand' });
    env.session.destroy();
  });

  it('leaves a runner still at a question its wait', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    await until(() => env.run.spawnedIds().includes('t1'));
    env.run.of('t1').waitForInput();
    await until(() => taskOf(env.session, 't1')?.status === 'awaiting_user');
    await settled();

    await env.session.updateTask('t1', BY_HAND);
    await settled();

    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'user', status: 'awaiting_user', awaitingReason: 'input' });
    env.session.destroy();
  });
});

describe('Execute and run_plan on a scheduled run waiting on a person, with nothing live', () => {
  async function waiting() {
    const env = await supervised([task('t0', 1), manual('t1', 2)], { settings: { supervisorLevel: 'off' } });
    await failed(env, 't0');
    expect(env.session.activity).toMatchObject({ running: false, scheduled: true });
    return env;
  }

  it.each([['the user\'s Execute', USER], ['a planner\'s run_plan', PLANNER]])('%s joins it: the failure stays for a retry, and nothing runs again', async (_name, actor) => {
    const env = await waiting();

    const outcome = await env.session.execute({ command: 'run_plan' }, actor);
    await settled();

    expect(outcome.ok).toBe(true);
    expect(outcome.message).not.toContain('already running: ');
    expect(env.run.spawnedIds()).toEqual(['t0']);
    expect(taskOf(env.session, 't0')).toMatchObject({ status: 'failed' });
    expect(env.session.activity.scheduled).toBe(true);
    env.session.destroy();
  });

  it('starts what Execute approved in it', async () => {
    const env = await waiting();
    await env.session.addTask({ id: 't3', title: 'Added', type: 'ai', prompt: 'do t3' });
    await settled();

    expect((await env.session.execute({ command: 'run_plan' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().length === 2);

    expect(env.run.spawnedIds().filter((id) => id === 't0')).toHaveLength(1);
    env.session.destroy();
  });
});

describe('Execute and run_plan under a usage-limit hold', () => {
  it.each([['the user\'s Execute', USER], ['a planner\'s run_plan', PLANNER]])('%s on a scheduled run keeps the resume and the failure, and starts nothing', async (_name, actor) => {
    const env = await supervised([task('t0', 1), task('t1', 2), task('t2', 3)], { settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 2 } });
    await until(() => env.run.spawnedIds().includes('t1'));
    await failed(env, 't0');
    await until(() => env.run.spawnedIds().includes('t2'));
    await paused(env, 't1');
    await paused(env, 't2');
    const spawned = env.run.spawnedIds().length;

    const outcome = await env.session.execute({ command: 'run_plan' }, actor);
    await settled();

    expect(outcome).toMatchObject({ ok: true, message: expect.stringContaining('A usage limit holds the run') });
    expect(env.run.spawnedIds()).toHaveLength(spawned);
    expect(taskOf(env.session, 't0')).toMatchObject({ status: 'failed' });
    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'awaiting_user', resumeAt: RESUME_AT });
    expect(env.session.activity.resumable).toBe(true);
    env.session.destroy();
  });

  it('on a task started alone makes the plan the run its reset gives back, and takes no pause back before then', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { execute: false, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 't1' }, USER)).ok).toBe(true);
    await paused(env, 't1');

    expect((await env.session.execute({ command: 'run_plan' }, USER)).ok).toBe(true);
    await settled();

    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'awaiting_user', resumeAt: RESUME_AT });

    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
    env.run.of('t1').reportComplete({ status: 'done', summary: 'done' });
    await until(() => env.run.spawnedIds().includes('t2'));
    env.session.destroy();
  });

  it('gives what failed the fresh chance Execute gives, in the run the reset gives back', async () => {
    const env = await supervised([task('t0', 1), task('t1', 2)], { execute: false, settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 2 } });
    expect((await env.session.execute({ command: 'run_task', task: 't0' }, USER)).ok).toBe(true);
    expect((await env.session.execute({ command: 'run_task', task: 't1' }, USER)).ok).toBe(true);
    await failed(env, 't0');
    await paused(env, 't1');

    expect((await env.session.execute({ command: 'run_plan' }, USER)).ok).toBe(true);
    await settled();

    expect(env.run.spawnedIds().filter((id) => id === 't0')).toHaveLength(1);
    expect(taskOf(env.session, 't0')?.status).not.toBe('failed');
    env.session.destroy();
  });

  it('with work live, a planner\'s run_plan starts no ready script past the hold, and the hold stays', async () => {
    const script = task('s', 3, { type: 'script', commands: [['true']] });
    const env = await supervised([task('t1', 1), task('t2', 2), script], { execute: false, settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: true, maxParallelSessions: 2 } });
    expect((await env.session.execute({ command: 'run_task', task: 't1' }, USER)).ok).toBe(true);
    expect((await env.session.execute({ command: 'run_task', task: 't2' }, USER)).ok).toBe(true);
    await paused(env, 't1');
    expect(env.session.activity).toMatchObject({ running: true, resumable: true });

    expect(await env.session.execute({ command: 'run_plan' }, PLANNER)).toMatchObject({ ok: true, message: expect.stringContaining('A usage limit holds the run') });
    await settled();

    expect(env.scripts.spawnedIds()).toEqual([]);
    expect(env.session.activity).toMatchObject({ scheduled: false, resumable: true });
    env.session.destroy();
  });

  it('signing off the review starts nothing past the hold either: a script waits on no runner\'s limit', async () => {
    const env = await supervised([task('t1', 1), task('s', 2, { type: 'script', commands: [['true']] })], { execute: false, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 't1' }, USER)).ok).toBe(true);
    await paused(env, 't1');

    expect((await env.session.execute({ command: 'approve_review' }, USER)).ok).toBe(true);
    await settled();

    expect(env.scripts.spawnedIds()).toEqual([]);
    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'awaiting_user', resumeAt: RESUME_AT });
    env.session.destroy();
  });
});

describe('a failed body task whose check is still to decide', () => {
  const loop = (): Task[] => [task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }), task('fix', 2, { dependencies: ['check'] })];

  async function bodyFailedCheckRetried() {
    const env = await supervised(loop(), { settings: { supervisorLevel: 'off' } });
    await failed(env, 'check');
    await until(() => env.run.spawnedIds().includes('fix'));
    await failed(env, 'fix');
    expect((await env.session.execute({ command: 'retry_task', task: 'check', from: 'fresh' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().filter((id) => id === 'check').length === 2);
    return env;
  }

  it('is refused a continue as it is a retry: a body runs only if its check fails', async () => {
    const env = await bodyFailedCheckRetried();

    const refused = 'is in the body of the loop of';
    expect(await env.session.execute({ command: 'retry_task', task: 'fix', from: 'fresh' }, USER)).toMatchObject({ ok: false, message: expect.stringContaining(refused) });
    expect(await env.session.execute({ command: 'retry_task', task: 'fix', from: 'session', message: 'go on' }, USER)).toMatchObject({ ok: false, message: expect.stringContaining(refused) });
    expect(env.session.escalations().find((e) => e.task?.id === 'fix')?.options.map((o) => o.id)).toEqual(['skip']);
    env.session.destroy();
  });
});

describe('a carried loop a body task stopped', () => {
  it('is not refused as running on its own: the check has no `repeating` wait while its body is failed', async () => {
    const env = await supervised([task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }), task('fix', 2, { dependencies: ['check'] })], { execute: false, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
    await failed(env, 'check');
    await failed(env, 'fix');

    const started = await env.session.execute({ command: 'run_task', task: 'check' }, PLANNER);

    expect(started.ok).toBe(false);
    expect(started.message).not.toContain('runs again on its own');
    env.session.destroy();
  });
});

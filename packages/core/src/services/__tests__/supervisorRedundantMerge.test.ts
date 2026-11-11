import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorktreeIsolation } from '../../testing';
import type { ExecutionRecord } from '../../models/Execution';
import type { SessionMessage } from '../SessionMessage';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { changeSettings, ctx, heldPlanner, NOW, prose, recordingRunner, settled, supervised, task, until, waitForInput, type Env, type Options } from './supervisorTestKit';
import { makeSession, saves } from './sessionTestKit';

/**
 * With merge automatically on, the run's end
 * merges and closes the isolated run before the Act supervisor's wake-up turn,
 * which is then told nothing of it, calls merge_all, and is refused with "This
 * plan has no isolated run" — a refusal the user reads as the supervisor's
 * failed merge. The planner here is live (a harness resumed after the user's
 * own turn), as in the reported session: its wake-up gets only the turn's
 * input, never the transcript.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const records = (env: Env): ExecutionRecord[] =>
  env.session.planState!.conversationHistory!.flatMap((e) => (e.execution ? [e.execution] : []));
const actions = (env: Env) => env.messages.filter((m): m is Extract<SessionMessage, { type: 'execution_action' }> => m.type === 'execution_action');
const merges = (iso: FakeWorktreeIsolation) => iso.calls.filter((c) => c.op === 'mergeIntoCheckedOut').length;
/** The run update the supervisor's wake-up carried, as the model got it. */
const runUpdate = (message: string) => message.slice(message.indexOf('Run update:')).split('\n\n')[0];

/** An Act run over `tasks`, isolated, whose planner is live from a user turn before the run starts. */
async function liveAct(tasks = [task('t1', 1)], mergeAtGatesAutomatically = true, isolation = new FakeWorktreeIsolation(), over: Options = {}, start: 'plan' | 'each task' | 'first task' = 'plan') {
  const env = await supervised(tasks, {
    settings: { supervisorLevel: 'act', mergeAtGatesAutomatically }, isolation, config: { worktreeIsolation: true }, execute: false, ...over,
  });
  const chatted = env.session.continueConversation('looks good');
  await until(() => env.planner.calls.length === 1);
  env.planner.calls[0].finish(prose('Ready when you are.'));
  await chatted;
  expect(env.planner.state.live).toBe(true);
  if (start === 'plan') await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
  else for (const t of start === 'each task' ? tasks : tasks.slice(0, 1)) expect(await env.session.execute({ command: 'run_task', task: t.id }, { kind: 'user' })).toMatchObject({ ok: true });
  return { ...env, isolation };
}

describe('the Act supervisor after an automatic Merge all closed the run', () => {
  it('is told the run merged, and merge_all answers without a refusal for the user', async () => {
    const env = await liveAct();
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.messages.some((m) => m.type === 'execution_complete'));

    // The merge happened and closed the run before the supervisor woke.
    expect(merges(env.isolation)).toBe(1);
    expect(env.messages).toContainEqual({ type: 'isolation_merge', result: { outcome: 'merged' }, trigger: { kind: 'run_end' } });
    expect(env.messages).toContainEqual({ type: 'run_closed' });
    expect(env.session.isolationView()).toBeNull();
    expect(env.session.runMergeView()).toBeNull();
    expect(env.session.planState!.conversationHistory!.map((e) => e.content)).toContain('Ordewell setting: auto-merged at the end of the run');

    await until(() => env.planner.calls.length === 2);
    const woken = env.planner.calls[1];
    // Went to the live context: the transcript's auto-merge line is not replayed to it.
    expect(env.planner.aiService.continueConversation).toHaveBeenCalledTimes(1);
    expect(env.planner.aiService.startConversation).toHaveBeenCalledTimes(1);
    // The Act brief invites merge_all, so the run update is the only place the input could say the merge is done.
    expect(woken.message).toContain('and merge_all');

    const merge = await env.planner.tools().mergeAll!({}, ctx);
    const refusedLine = 'The supervisor asked to merge all; refused: This plan has no isolated run';

    // 1. the model input says the run's work is already merged, so it has nothing to merge;
    expect(runUpdate(woken.message)).toMatch(/merged/i);
    // 2. a merge_all that finds it merged is not a refusal the user is told of.
    expect(merge.isError).toBeFalsy();
    expect(JSON.parse(merge.text)).toEqual({ ok: true, result: expect.stringMatching(/^Nothing to merge/) });
    expect(actions(env).map((a) => a.text)).not.toContain(refusedLine);
    expect(records(env).filter((r) => r.command === 'merge_all' && r.outcome === 'refused')).toEqual([]);
    expect(merges(env.isolation)).toBe(1);
  });

  it('control, replayed planner: only a planner with no live context is handed the transcript\'s auto-merge line', async () => {
    // No user turn first: the wake-up opens the conversation from the transcript.
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act', mergeAtGatesAutomatically: true }, isolation: new FakeWorktreeIsolation(), config: { worktreeIsolation: true } });
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.aiService.continueConversation).not.toHaveBeenCalled();
    const opened = env.planner.aiService.startConversation.mock.calls[0][0];
    expect((opened.priorHistory ?? []).map((m) => m.content)).toContain('Ordewell setting: auto-merged at the end of the run');
  });

  it('race at a scheduled run: a planner turn holds the run open, so the run end cannot merge under the supervisor', async () => {
    // t1 lands with nothing gated on it; t2 waits for input, which wakes the supervisor while t1's work is unmerged.
    const env = await liveAct([task('t1', 1), task('t2', 2)]);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.session.runMergeView() !== null);
    waitForInput(env.run.of('t2'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);

    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await settled();
    // The turn's start hold keeps the run from settling (TaskOrchestrator.tick): nothing merged yet.
    expect(env.session.planTasks.map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(env.messages.some((m) => m.type === 'execution_complete')).toBe(false);
    expect(merges(env.isolation)).toBe(0);
    // So the supervisor's merge_all, called now, merges: a pending merge stays the supervisor's to make.
    expect((await env.planner.tools().mergeAll!({}, ctx)).isError).toBeFalsy();
    expect(merges(env.isolation)).toBe(1);
  });

  it('race at a run of tasks started one by one: the run end merges and closes mid-turn, before the supervisor\'s merge_all', async () => {
    const env = await liveAct([task('t1', 1), task('t2', 2)], true, new FakeWorktreeIsolation(), {}, 'each task');
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.session.runMergeView() !== null);
    waitForInput(env.run.of('t2'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);
    // The wake-up was right when it went out: landed work was pending.
    expect(env.session.runMergeView()).not.toBeNull();

    // Mid-turn, t2 finishes: a run the scheduler is not driving settles on the verdict, start hold or not.
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => env.messages.some((m) => m.type === 'execution_complete'));
    expect(merges(env.isolation)).toBe(1);
    expect(env.messages).toContainEqual({ type: 'isolation_merge', result: { outcome: 'merged' }, trigger: { kind: 'run_end' } });
    expect(env.session.isolationView()).toBeNull();

    const merge = await env.planner.tools().mergeAll!({}, ctx);
    // The digest was right when it went out, so only the seam can answer this one.
    expect(merge.isError).toBeFalsy();
    expect(JSON.parse(merge.text)).toEqual({ ok: true, result: expect.stringMatching(/^Nothing to merge/) });
    expect(records(env).filter((r) => r.command === 'merge_all')).toEqual([]);
    expect(actions(env).map((a) => a.text).filter((t) => /merge/i.test(t))).toEqual([]);
    expect(merges(env.isolation)).toBe(1);
  });
});

describe('a run that closed merged, across a daemon restart', () => {
  it('still answers merge_all as nothing to merge, and the redelivered wake-up still says the work is merged', async () => {
    const env = await liveAct();
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 2);
    const saved = structuredClone(saves(env.session).mock.calls.at(-1)![0]);
    expect(saved.isolation).toBeUndefined();
    env.session.destroy();

    const planner = heldPlanner();
    const isolation = new FakeWorktreeIsolation();
    const messages: SessionMessage[] = [];
    const restarted = makeSession({
      aiService: planner.aiService, runner: recordingRunner().runner, isolation, workspaceRoot: () => '/repo', broadcast: (m) => messages.push(m),
    });
    restarted.loadPlan(saved, 'build it', '/repo', { sessionId: env.session.sessionId });
    await settled();

    expect(await restarted.execute({ command: 'merge_all' }, { kind: 'supervisor', level: 'act' })).toMatchObject({ ok: true, message: expect.stringMatching(/^Nothing to merge/) });
    expect(merges(isolation)).toBe(0);
    expect(messages.filter((m) => m.type === 'execution_action')).toEqual([]);
    expect(restarted.planState!.conversationHistory!.filter((e) => e.execution?.command === 'merge_all')).toEqual([]);

    // The wake-up its turn never answered goes with the user's next message, still saying so.
    const sent = restarted.continueConversation('what happened?');
    await until(() => planner.calls.length === 1);
    expect(runUpdate(planner.calls[0].message)).toMatch(/everything it landed is merged into the user's branch/);
    planner.calls[0].finish(prose('The run merged.'));
    await sent;
  });
});

describe('controls a correction must keep', () => {
  it('a later run with landed work waiting: the earlier run\'s merge hides none of it, and merge_all merges it', async () => {
    const env = await liveAct([task('t1', 1), task('t2', 2)], true, new FakeWorktreeIsolation(), {}, 'first task');
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 2);
    expect(runUpdate(env.planner.calls[1].message)).toMatch(/nothing to merge/);
    env.planner.calls[1].finish(prose('Merged already.'));
    await settled();

    changeSettings(env, { mergeAtGatesAutomatically: false });
    expect(await env.session.execute({ command: 'run_task', task: 't2' }, { kind: 'user' })).toMatchObject({ ok: true });
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 3);
    expect(env.session.runMergeView()).not.toBeNull();
    expect(runUpdate(env.planner.calls[2].message)).toMatch(/its landed work is not merged yet/);
    expect(runUpdate(env.planner.calls[2].message)).not.toMatch(/nothing to merge/);

    const merge = await env.planner.tools().mergeAll!({}, ctx);
    expect(merge.isError).toBeFalsy();
    expect(JSON.parse(merge.text).result).toMatch(/^Merged the run's landed work/);
    expect(merges(env.isolation)).toBe(2);
    expect(records(env).filter((r) => r.command === 'merge_all').map((r) => [r.actor, r.outcome])).toEqual([['supervisor', 'done']]);
  });


  it('merge automatically off: the run is handed over with landed work, and the supervisor\'s merge_all merges it', async () => {
    const env = await liveAct([task('t1', 1)], false);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 2);
    expect(env.session.runMergeView()).not.toBeNull();

    const merge = await env.planner.tools().mergeAll!({}, ctx);
    expect(merge.isError).toBeFalsy();
    expect(merges(env.isolation)).toBe(1);
    expect(env.session.isolationView()).toBeNull();
  });

  it('merge automatically on, landed work still pending mid-run: the supervisor\'s merge_all merges it', async () => {
    const env = await liveAct([task('t1', 1), task('t2', 2)]);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.session.runMergeView() !== null);
    waitForInput(env.run.of('t2'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);

    const merge = await env.planner.tools().mergeAll!({}, ctx);
    expect(merge.isError).toBeFalsy();
    expect(merges(env.isolation)).toBe(1);
    expect(env.session.runMergeView()).toBeNull();
    expect(records(env).filter((r) => r.command === 'merge_all').map((r) => [r.actor, r.outcome])).toEqual([['supervisor', 'done']]);
  });

  it('a stopped automatic Merge all: the supervisor hears of it, and its merge_all still reports the real stop', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.mergeResult = { outcome: 'conflict', repo: '.', files: ['src/a.ts'] };
    const env = await liveAct([task('t1', 1)], true, isolation);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toContain('automatic Merge all at the end of the run stopped');
    expect(env.session.runMergeView()).not.toBeNull();

    const merge = await env.planner.tools().mergeAll!({}, ctx);
    expect(merge.isError).toBe(true);
    expect(JSON.parse(merge.text).reason).toMatch(/^Merge all stopped: .*conflict/i);
    expect(records(env).filter((r) => r.command === 'merge_all').map((r) => [r.actor, r.outcome])).toEqual([['supervisor', 'refused']]);
    expect(merges(isolation)).toBe(2);
  });

  it('a later run in the shared workspace root: the earlier run\'s merge no longer answers for it, and merge_all is refused as before', async () => {
    const env = await liveAct([task('t1', 1), task('t2', 2)], true, new FakeWorktreeIsolation(), {}, 'first task');
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Merged already.'));
    await settled();

    env.isolation.availability = { active: false, reason: 'not-git' };
    expect(await env.session.execute({ command: 'run_task', task: 't2' }, { kind: 'user' })).toMatchObject({ ok: true });
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 3);
    expect(runUpdate(env.planner.calls[2].message)).not.toMatch(/merge/i);

    const merge = await env.planner.tools().mergeAll!({}, ctx);
    expect(merge.isError).toBe(true);
    expect(JSON.parse(merge.text).reason).toBe('This plan has no isolated run');
    expect(merges(env.isolation)).toBe(1);
  });

  it('a run that never isolated: merge_all is still refused as having no isolated run', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'not-git' };
    const env = await liveAct([task('t1', 1)], true, isolation);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 2);
    expect(env.session.isolationView()).toBeNull();

    const merge = await env.planner.tools().mergeAll!({}, ctx);
    expect(merge.isError).toBe(true);
    expect(JSON.parse(merge.text).reason).toBe('This plan has no isolated run');
    expect(merges(isolation)).toBe(0);
  });
});

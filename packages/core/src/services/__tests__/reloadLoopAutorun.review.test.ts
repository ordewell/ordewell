import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GlobalRunSettings } from '../SettingsService';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { IConfig } from '../../interfaces/IConfig';
import type { SessionMessage, SessionNotice } from '../SessionMessage';
import type { SubmitPlanArgs } from '../mcp/tools';
import { makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { ctx, heldPlanner, NOW, prose, recordingRunner, settled, supervised, task, until } from './supervisorTestKit';
import { fakeConfig } from '../../testing';
import { PlanStore } from '../PlanStore';
import { createTask } from '../../models/Task';
import { loadSession, saveSession } from '../../utils/sessionStore';

/**
 * What the reload, loop and autorun fixes (ADR-0053, ADR-0045 L5/L7, ADR-0030)
 * must also answer, confirmed by driving the real seam: what the review found,
 * and the lines its fixes drew, which is why some of these pass either way.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => { vi.useRealTimers(); });

const USER = { kind: 'user' as const };
const ai = (id: string, dependencies: string[] = []) => ({ id, title: `Task ${id}`, description: 'd', type: 'ai', prompt: `do ${id}`, assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK', dependencies });
const push = [['git', 'push', 'origin', 'main']];
const check = (maxRounds = 3) => [task('check', 1, { loop: { body: ['fix'], maxRounds } }), task('fix', 2, { dependencies: ['check'] }), task('ship', 3, { dependencies: ['check'] })];

/** An autorun session, Full unless asked otherwise, whose planner turns a test answers by hand (as autorun.test.ts builds one). */
function fullSession({ full = true }: { full?: boolean } = {}) {
  const planner = heldPlanner();
  const runner = recordingRunner();
  const scripts = recordingRunner();
  const notices: SessionNotice[] = [];
  const messages: SessionMessage[] = [];
  const settings: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', autorun: true };
  const config: IConfig = fakeConfig({ autonomousMode: full } as Partial<IConfig>);
  const session = makeSession({
    aiService: planner.aiService, runner: runner.runner, scriptRunner: scripts.runner, config,
    onNotice: (n) => notices.push(n), broadcast: (m) => messages.push(m), settings: () => ({ run: { ...settings } }),
  });
  return { session, planner, runner, scripts, notices, messages };
}

async function replySubmitted(env: ReturnType<typeof fullSession>, tasks: unknown[]): Promise<{ planned: Promise<unknown> }> {
  const planned = env.session.startPlanning('build it', ['claude-code']);
  await until(() => env.planner.calls.length === 1);
  const submitted = await env.planner.tools().submitPlan!({ tasks } as unknown as SubmitPlanArgs, ctx);
  expect(submitted.isError).toBeFalsy();
  return { planned };
}

async function endReply(env: ReturnType<typeof fullSession>, planned: Promise<unknown>): Promise<void> {
  env.planner.calls[0].finish(prose('Planned.'));
  await planned;
  await settled();
}

describe('a check between rounds that nothing will run', () => {
  it('is listed, after a Stop leaves its fix landed and after the plan is reopened', async () => {
    const env = await supervised(check(), { execute: false });
    expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('check'));
    env.run.of('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
    await until(() => env.run.spawnedIds().includes('fix'));
    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true });
    expect((await env.session.execute({ command: 'run_task', task: 'fix' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().filter((id) => id === 'fix').length === 2);
    env.run.of('fix').reportComplete({ status: 'done', summary: 'fixed' });
    await until(() => taskOf(env.session, 'fix')?.status === 'completed');
    await settled();

    expect(taskOf(env.session, 'check')).toMatchObject({ status: 'failed' });
    expect(env.session.escalations().map((e) => e.kind)).toContain('failed');

    const saved = structuredClone(env.session.planState!);
    env.session.destroy();
    const reopened = makeSession({ aiService: heldPlanner().aiService, runner: recordingRunner().runner });
    reopened.loadPlan(saved, 'build it', testWorkspace, { persist: false });
    expect(taskOf(reopened, 'check')).toMatchObject({ status: 'failed' });
    expect(reopened.escalations().map((e) => e.kind)).toContain('failed');
    reopened.destroy();
  });
});

describe('a check between rounds, told by whether anything will run it', () => {
  async function failedRound() {
    const env = await supervised(check(), { execute: false, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('check'));
    env.run.of('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
    await until(() => env.run.spawnedIds().includes('fix'));
    return env;
  }
  const entryOf = (env: Awaited<ReturnType<typeof failedRound>>) => env.session.escalations().find((e) => e.task?.id === 'check');
  const strandedOnTheWire = (env: Awaited<ReturnType<typeof failedRound>>) => {
    const update = env.messages.filter((m) => m.type === 'status_update').at(-1);
    return update?.type === 'status_update' ? update.tasks.find((t) => t.id === 'check')?.loopStranded : undefined;
  };

  it('is left out while its carried loop runs it', async () => {
    const env = await failedRound();
    expect(entryOf(env)).toBeUndefined();
    env.session.destroy();
  });

  it('says Execute goes on from a Stop with its fix not landed, and is told to the surfaces as stranded', async () => {
    const env = await failedRound();
    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true });
    await settled();

    const entry = entryOf(env)!;
    expect(entry.kind).toBe('failed');
    expect(entry.reason).toContain('#2 has not landed. Execute the plan');
    expect(entry.options.map((o) => o.id)).not.toContain('run');
    expect(strandedOnTheWire(env)).toBe(true);
    env.session.destroy();
  });

  it('offers its next round once the fix has landed, and the answer runs it with the count kept', async () => {
    const env = await failedRound();
    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true });
    expect((await env.session.execute({ command: 'run_task', task: 'fix' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().filter((id) => id === 'fix').length === 2);
    env.run.of('fix').reportComplete({ status: 'done', summary: 'fixed' });
    await until(() => taskOf(env.session, 'fix')?.status === 'completed');
    await settled();

    const entry = entryOf(env)!;
    expect(entry.reason).toContain('Its fix has landed');
    expect(entry.options[0]).toEqual({ id: 'run', label: 'Start round 2 of 3' });
    expect(await env.session.answerEscalation(entry.id, 'run')).toMatchObject({ ok: true });
    await until(() => env.run.spawnedIds().filter((id) => id === 'check').length === 2);
    expect(taskOf(env.session, 'check')).toMatchObject({ status: 'in_progress', loopRound: 2 });
    expect(strandedOnTheWire(env)).toBeUndefined();
    env.session.destroy();
  });
});

describe('a carried loop waiting for the user', () => {
  it('lists the body task it waits to have approved, the run it keeps open being an open run', async () => {
    const tasks = [task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }), task('fix', 2, { dependencies: ['check'] })];
    const env = await supervised(tasks, { execute: false, plan: { approved: true, approvedTasks: ['check'] } });
    expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('check'));
    env.run.of('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
    await until(() => taskOf(env.session, 'check')?.status === 'failed');
    await settled();

    expect(env.session.isApproved('fix')).toBe(false);
    expect(env.session.escalations().map((e) => [e.kind, e.task?.id])).toContainEqual(['unapproved', 'fix']);
    env.session.destroy();
  });

  it('lists it in a plan nobody approved too, and its Start lets the loop go on', async () => {
    const tasks = [task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }), task('fix', 2, { dependencies: ['check'] })];
    const env = await supervised(tasks, { execute: false, plan: { approved: false }, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('check'));
    env.run.of('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
    await until(() => taskOf(env.session, 'check')?.status === 'failed');
    await settled();

    const entry = env.session.escalations().find((e) => e.kind === 'unapproved')!;
    expect(entry.task?.id).toBe('fix');
    expect(entry.reason).toBe('Its loop is carried on, and waits for you to start it.');
    expect(await env.session.answerEscalation(entry.id, 'run')).toMatchObject({ ok: true });
    await until(() => env.run.spawnedIds().includes('fix'));
    env.session.destroy();
  });

  it('is open for its own tasks alone: the rest of the plan does not start, so it waits on no one', async () => {
    const tasks = [
      task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }), task('fix', 2, { dependencies: ['check'] }),
      task('manual', 3, { type: 'user', prompt: undefined }), task('later', 4),
    ];
    const env = await supervised(tasks, { execute: false, plan: { approved: true, approvedTasks: ['check', 'manual'] }, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('check'));
    env.run.of('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
    await until(() => taskOf(env.session, 'check')?.status === 'failed');
    await settled();

    expect(env.session.escalations().map((e) => e.task?.id)).toEqual(['fix']);
    env.session.destroy();
  });
});

describe('an edit that makes a failed task manual', () => {
  it('gives it the fresh chance the edit path claims, rather than a failed manual task Retry cannot start', () => {
    // A planner edit between runs is adoptEdit's loadPlan + resetForRun({ edited: true }).
    const store = new PlanStore();
    store.load([createTask({ id: 't1', order: 1, title: 'T1', type: 'user', status: 'failed' })], ['claude-code']);
    store.resetForRun({ edited: true });
    expect(store.get('t1')!.status).toBe('pending');
  });
});

describe('a planner edit that makes a failed task manual', () => {
  const failedTask = () => task('t1', 1, { status: 'failed', verdict: { outcome: 'fail', checks: [], reason: 'No.', decidedAt: NOW.toISOString() } });

  async function editTurn(env: Awaited<ReturnType<typeof supervised>>, ops: unknown[]): Promise<void> {
    void env.session.continueConversation('change it');
    await until(() => env.planner.calls.length === 1);
    expect((await env.planner.tools().editPlan!({ ops } as never, ctx)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Changed.'));
    await settled();
  }

  it('between runs leaves it the user\'s to do, its dependents free to follow', async () => {
    const env = await supervised([failedTask(), task('t2', 2, { dependencies: ['t1'] })], { execute: false, settings: { supervisorLevel: 'off' } });
    await editTurn(env, [{ op: 'update', taskId: 't1', changes: { type: 'user', userSteps: ['do it by hand'] } }]);

    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'user', status: 'pending' });
    env.session.destroy();
  });

  it('in a run ended on the failure does the same, so the inbox offers no Retry that would refuse', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'off' } });
    await until(() => env.run.spawnedIds().includes('t1'));
    env.run.of('t1').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 't1')?.status === 'failed');
    await settled();
    await editTurn(env, [{ op: 'update', taskId: 't1', changes: { type: 'user', userSteps: ['do it by hand'] } }]);

    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'user', status: 'pending' });
    expect(env.session.escalations().find((e) => e.task?.id === 't1')?.options.map((o) => o.id)).not.toContain('retry');
    env.session.destroy();
  });
});

describe('Execute with a task started by hand at work', () => {
  const failedFirst = () => [task('t1', 1, { status: 'failed', verdict: { outcome: 'fail', checks: [], reason: 'No.', decidedAt: NOW.toISOString() } }), task('t2', 2)];

  it('gives what failed the fresh chance Execute gives, as the hand-started work becomes the plan\'s run', async () => {
    const env = await supervised(failedFirst(), { execute: false, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 't2' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('t2'));
    expect((await env.session.execute({ command: 'run_plan' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('t1'));

    expect(env.run.spawnedIds().filter((id) => id === 't2')).toHaveLength(1);
    expect(taskOf(env.session, 't2')).toMatchObject({ status: 'in_progress' });
    env.session.destroy();
  });

  it('leaves it failed for the planner\'s run_plan: the fresh chance is the user\'s to ask for', async () => {
    const env = await supervised(failedFirst(), { execute: false, plan: { approved: true }, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 't2' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('t2'));
    expect((await env.session.execute({ command: 'run_plan' }, { kind: 'planner-turn' })).ok).toBe(true);
    await settled();

    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'failed' });
    env.session.destroy();
  });

  it('leaves a scheduled run\'s failure to a retry: that run is under way, not begun', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { settings: { supervisorLevel: 'off' } });
    await until(() => env.run.spawnedIds().includes('t2'));
    env.run.of('t1').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 't1')?.status === 'failed');
    expect((await env.session.execute({ command: 'run_plan' }, USER)).ok).toBe(true);
    await settled();

    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'failed' });
    env.session.destroy();
  });

  it('readies only what failed: work at work stays, and a check between rounds leaves its body to run first', () => {
    const store = new PlanStore();
    const found = { outcome: 'fail' as const, checks: [], reason: 'Found it.', reported: 'failed' as const, decidedAt: NOW.toISOString() };
    store.load([
      task('out', 1, { status: 'failed', loopRound: 3, loop: { body: ['fix'], maxRounds: 3 }, verdict: found }),
      task('between', 2, { status: 'failed', loop: { body: ['fix'], maxRounds: 3 }, verdict: found }),
      task('live', 3, { status: 'failed' }),
      task('working', 4, { status: 'in_progress' }),
    ], ['claude-code']);
    store.readyFailed((id) => id === 'live');

    expect(store.get('out')).toMatchObject({ status: 'approved' });
    expect(store.get('out')!.loopRound).toBeUndefined();
    expect(store.get('between')).toMatchObject({ status: 'failed' });
    expect(store.get('live')).toMatchObject({ status: 'failed' });
    expect(store.get('working')).toMatchObject({ status: 'in_progress' });
  });
});

describe('autorun in Full with a Stop before the reply ends', () => {
  it('leaves the stopped run stopped: nothing starts at the reply\'s end', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a'), ai('b', ['a'])]);
    expect((await env.planner.tools().runTask!({ task: 'a' }, ctx)).isError).toBeFalsy();
    await until(() => env.runner.spawnedIds().includes('a'));
    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true });
    await endReply(env, planned);
    await settled();
    await settled();

    expect(env.runner.spawnedIds()).toEqual(['a']);
    expect(env.notices.map((n) => n.message)).toContainEqual(expect.stringContaining('Autorun did not start the plan'));
    env.session.destroy();
  });

  it('starts a plan submitted after the Stop: that is a new start, which the Stop came before', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a')]);
    expect((await env.planner.tools().runTask!({ task: 'a' }, ctx)).isError).toBeFalsy();
    await until(() => env.runner.spawnedIds().includes('a'));
    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true });
    expect((await env.planner.tools().submitPlan!({ tasks: [ai('a')] } as unknown as SubmitPlanArgs, ctx)).isError).toBeFalsy();
    await endReply(env, planned);
    await until(() => env.runner.spawnedIds().length === 2);

    expect(env.notices.map((n) => n.message)).not.toContainEqual(expect.stringContaining('Autorun did not start the plan'));
    env.session.destroy();
  });
});

describe('autorun in Full taking the fresh-run path', () => {
  it('does not run again a script that failed earlier in the submitting reply', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a')]);
    const reply = env.planner.tools().runScript!({ title: 'Push main', commands: push }, ctx);
    await until(() => env.scripts.spawnedIds().length === 1);
    const script = env.session.planTasks.find((t) => t.type === 'script')!;
    env.scripts.of(script.id).reportScriptExit({ outcome: 'failed', command: 'git push', status: { code: 1, signal: null }, errorTail: 'rejected' });
    env.scripts.of(script.id).emitExit(1);
    await reply;
    expect(taskOf(env.session, script.id)?.status).toBe('failed');
    await endReply(env, planned);
    await settled();
    await settled();

    expect(env.scripts.spawnedIds()).toHaveLength(1);
    env.session.destroy();
  });

  it('leaves an AI task that failed in the reply failed too, and starts the rest of the plan', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a'), ai('b')]);
    expect((await env.planner.tools().runTask!({ task: 'a' }, ctx)).isError).toBeFalsy();
    await until(() => env.runner.spawnedIds().includes('a'));
    env.runner.of('a').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 'a')?.status === 'failed');
    await endReply(env, planned);
    await until(() => env.runner.spawnedIds().includes('b'));

    expect(env.runner.spawnedIds().filter((id) => id === 'a')).toHaveLength(1);
    expect(taskOf(env.session, 'a')).toMatchObject({ status: 'failed' });
    env.session.destroy();
  });

  it('leaves it failed on the join path too, with another task of the reply still at work', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a'), ai('b')]);
    expect((await env.planner.tools().runTask!({ task: 'a' }, ctx)).isError).toBeFalsy();
    expect((await env.planner.tools().runTask!({ task: 'b' }, ctx)).isError).toBeFalsy();
    await until(() => env.runner.spawnedIds().includes('b'));
    env.runner.of('a').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 'a')?.status === 'failed');
    await endReply(env, planned);
    await settled();

    expect(taskOf(env.session, 'a')).toMatchObject({ status: 'failed' });
    expect(env.runner.spawnedIds().filter((id) => id === 'a')).toHaveLength(1);
    env.session.destroy();
  });

  it('still gives a failure from before the reply the fresh chance a run gives', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a')]);
    await endReply(env, planned);
    await until(() => env.runner.spawnedIds().includes('a'));
    env.runner.of('a').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 'a')?.status === 'failed');
    await settled();

    void env.session.continueConversation('try that again');
    await until(() => env.planner.calls.length === 2);
    expect((await env.planner.tools().submitPlan!({ tasks: [ai('a')] } as unknown as SubmitPlanArgs, ctx)).isError).toBeFalsy();
    env.planner.calls[1].finish(prose('Again.'));
    await until(() => env.runner.spawnedIds().length === 2);
    env.session.destroy();
  });
});

describe('an edit adopted between runs', () => {
  it('leaves a saved checkpoint waiting, as the load it rides on does', () => {
    // An edit between runs is adoptEdit's loadPlan + resetForRun({ edited: true }) (ADR-0053, task 17 F1).
    const store = new PlanStore();
    store.load([{ ...createTask({ id: 't1', order: 1, title: 'T1', prompt: 'p', assignedRunner: 'claude-code', status: 'awaiting_user' }), awaitingReason: 'checkpoint' }], ['claude-code']);
    store.resetForRun({ edited: true });
    expect(store.get('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });
  });

  it.each([
    ['checkpoint', 'checkpoint'],
    ['input', 'input'],
    ['files-changed', 'files-changed'],
    ['usage-limit', 'usage-limit'],
  ] as const)('keeps a %s wait through a real planner edit, still listed', async (awaitingReason, kind) => {
    const waiting = { ...task('t1', 1, { status: 'awaiting_user' }), awaitingReason };
    const env = await supervised([waiting, task('t2', 2)], { execute: false, settings: { supervisorLevel: 'off' } });
    expect(env.session.escalations().map((e) => e.kind)).toEqual([kind]);

    void env.session.continueConversation('change the second task');
    await until(() => env.planner.calls.length === 1);
    expect((await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 't2', changes: { prompt: 'do it better' } }] } as never, ctx)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Changed.'));
    await settled();

    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason });
    expect(env.session.escalations().map((e) => e.kind)).toEqual([kind]);
    env.session.destroy();
  });
});

describe('a Stop of a plan the reply submitted, with nothing live yet', () => {
  it.each([['Full', true], ['Guarded', false]] as const)('withdraws autorun\'s start in %s, and says what it stopped', async (_, full) => {
    const env = fullSession({ full });
    const { planned } = await replySubmitted(env, [ai('a')]);

    const stopped = await env.session.execute({ command: 'stop_run' }, USER);
    expect(stopped).toMatchObject({ ok: true });
    expect(stopped.message).not.toContain('Nothing is running');
    await endReply(env, planned);
    await settled();
    await settled();

    expect(env.runner.spawnedIds()).toHaveLength(0);
    expect(env.notices.map((n) => n.message)).toContainEqual(expect.stringContaining('Autorun did not start the plan'));
    env.session.destroy();
  });

  /** A session with autorun off, whose reply has submitted [a] with nothing live. */
  async function submittedWithAutorunOff() {
    const env = fullSession();
    env.session.applyRunSettings({ autorun: false });
    const { planned } = await replySubmitted(env, [ai('a')]);
    return { env, planned };
  }

  it('is recorded though it stopped nothing, so autorun turned on after it starts nothing', async () => {
    const { env, planned } = await submittedWithAutorunOff();

    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true, message: 'Nothing is running: there is nothing to stop.' });
    env.session.applyRunSettings({ autorun: true });
    await endReply(env, planned);
    await settled();

    expect(env.runner.spawnedIds()).toHaveLength(0);
    expect(env.notices.map((n) => n.message)).toContainEqual(expect.stringContaining('Autorun did not start the plan'));
    env.session.destroy();
  });

  it('has nothing to stop once the reply has ended and its start has gone with it', async () => {
    const { env, planned } = await submittedWithAutorunOff();
    await endReply(env, planned);
    env.session.applyRunSettings({ autorun: true });

    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true, message: 'Nothing is running: there is nothing to stop.' });
    env.session.destroy();
  });
});

describe('the user\'s Execute after a Stop of a submitted plan', () => {
  it('leaves no notice that autorun did not start a plan that is running', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a')]);
    expect((await env.planner.tools().runTask!({ task: 'a' }, ctx)).isError).toBeFalsy();
    await until(() => env.runner.spawnedIds().includes('a'));
    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true });
    expect(await env.session.execute({ command: 'run_plan' }, USER)).toMatchObject({ ok: true });

    await endReply(env, planned);
    await until(() => env.runner.spawnedIds().filter((id) => id === 'a').length === 2);

    expect(env.notices.map((n) => n.message)).not.toContainEqual(expect.stringContaining('Autorun did not start the plan'));
    env.session.destroy();
  });

  it('still says so when that Execute was stopped in turn', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a')]);
    await env.session.execute({ command: 'stop_run' }, USER);
    await env.session.execute({ command: 'run_plan' }, USER);
    await env.session.execute({ command: 'stop_run' }, USER);
    const spawned = env.runner.spawnedIds().length;

    await endReply(env, planned);

    expect(env.runner.spawnedIds()).toHaveLength(spawned);
    expect(env.notices.map((n) => n.message)).toContainEqual(expect.stringContaining('Autorun did not start the plan'));
    env.session.destroy();
  });
});

describe('Guarded with autorun and a submitted script task', () => {
  const pushTask = (dependencies: string[] = []) => ({ id: 's', title: 'Push', description: 'd', type: 'script', commands: push, autonomy: 'AFK', sliceType: 'AFK', dependencies });

  it('leaves the script unapproved and unrun, and runs the rest', async () => {
    const env = fullSession({ full: false });
    const { planned } = await replySubmitted(env, [ai('a'), pushTask()]);
    const scriptId = env.session.planTasks.find((t) => t.type === 'script')!.id;
    expect(env.session.isApproved(scriptId)).toBe(false);

    await endReply(env, planned);
    await until(() => env.runner.spawnedIds().includes('a'));
    await settled();

    expect(env.session.isApproved(scriptId)).toBe(false);
    expect(env.scripts.spawnedIds()).toHaveLength(0);
    env.session.destroy();
  });

  it('lists a plan of nothing else, and the user\'s Start runs it', async () => {
    const env = fullSession({ full: false });
    const { planned } = await replySubmitted(env, [pushTask()]);
    const scriptId = env.session.planTasks.find((t) => t.type === 'script')!.id;

    await endReply(env, planned);
    await settled();

    expect(env.scripts.spawnedIds()).toHaveLength(0);
    const entry = env.session.escalations().find((e) => e.task?.id === scriptId)!;
    expect(entry).toMatchObject({ kind: 'unapproved' });
    expect(await env.session.answerEscalation(entry.id, 'run')).toMatchObject({ ok: true });
    await until(() => env.scripts.spawnedIds().includes(scriptId));
    env.session.destroy();
  });

  it('under Full, autorun\'s start still approves it', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [pushTask()]);
    const scriptId = env.session.planTasks.find((t) => t.type === 'script')!.id;

    await endReply(env, planned);
    await until(() => env.scripts.spawnedIds().includes(scriptId));

    expect(env.session.isApproved(scriptId)).toBe(true);
    env.session.destroy();
  });
});

describe('a stranded check with something else in front of its next round', () => {
  const stranded = () => {
    const session = makeSession({ aiService: heldPlanner().aiService, runner: recordingRunner().runner, settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }) });
    session.loadPlan({
      tasks: [
        task('dep', 1, { status: 'pending' }),
        task('check', 2, { status: 'failed', loopRound: 1, loop: { body: ['fix'], maxRounds: 3 }, verdict: { outcome: 'fail', checks: [], reason: 'Found it.', reported: 'failed', decidedAt: NOW.toISOString() }, dependencies: ['dep'] }),
        task('fix', 3, { status: 'completed', dependencies: ['check'] }),
      ],
      generatedAt: NOW.toISOString(), lastUpdated: NOW.toISOString(), status: 'approved', runners: ['claude-code'],
    } as never, 'goal', process.cwd(), { persist: false });
    return session;
  };

  it('names what it waits on, and offers no start the seam would refuse', async () => {
    const session = stranded();
    const entry = session.escalations().find((e) => e.task?.id === 'check')!;

    expect(entry.reason).toContain('#1');
    expect(entry.options.map((o) => o.id)).not.toContain('run');
    expect(entry.options.map((o) => o.id)).not.toContain('retry');
    session.destroy();
  });
});

describe('an awaiting task an edit makes manual', () => {
  async function madeManual() {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    await until(() => env.run.spawnedIds().includes('t1'));
    env.run.of('t1').waitForInput();
    await until(() => taskOf(env.session, 't1')?.status === 'awaiting_user');
    await settled();
    void env.session.continueConversation('change it');
    await until(() => env.planner.calls.length === 1);
    expect((await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 't1', changes: { type: 'user', userSteps: ['do it by hand'] } }] } as never, ctx)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Changed.'));
    await settled();
    return env;
  }

  it('keeps the wait of the runner that can still be answered', async () => {
    const env = await madeManual();

    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'user', status: 'awaiting_user', awaitingReason: 'input' });
    expect(env.session.escalations().find((e) => e.task?.id === 't1')?.options.map((o) => o.id)).toContain('reply');
    env.session.destroy();
  });

  it('is the manual task it now is after a reload, with no Retry that refuses', async () => {
    const env = await madeManual();
    const saved = structuredClone(env.session.planState!);
    env.session.destroy();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-manual-'));
    saveSession(saved, 'goal', base, 'manual-await');
    const reopened = makeSession({ aiService: heldPlanner().aiService, runner: recordingRunner().runner, settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }) });
    reopened.loadPlan(loadSession('manual-await', base)!.plan, 'goal', process.cwd(), { persist: false });

    expect(taskOf(reopened, 't1')).toMatchObject({ type: 'user', status: 'pending' });
    expect(taskOf(reopened, 't1')?.awaitingReason).toBeUndefined();
    expect(reopened.escalations().flatMap((e) => e.options.map((o) => o.id))).not.toContain('retry');
    reopened.destroy();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('with no runner behind it, it is released by the edit itself', () => {
    const store = new PlanStore();
    store.load([{ ...createTask({ id: 't1', order: 1, title: 'T1', prompt: 'p', assignedRunner: 'claude-code', type: 'user', status: 'awaiting_user' }), awaitingReason: 'checkpoint' }], ['claude-code']);
    store.resetForRun({ edited: true });

    expect(store.get('t1')).toMatchObject({ status: 'pending' });
    expect(store.get('t1')?.awaitingReason).toBeUndefined();
  });
});

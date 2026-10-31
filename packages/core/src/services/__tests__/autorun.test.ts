import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationTurn } from '../AiService';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import { AUTORUN_OFF, AUTORUN_ON } from '../PlanPrompts';
import { fakeConfig, makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { changeSettings, ctx, heldPlanner, NOW, plan, prose, recordingRunner, settled, supervised, task, until, waitForInput, type Env, type Options } from './supervisorTestKit';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import type { SessionMessage } from '../SessionMessage';
import type { IConfig } from '../../interfaces/IConfig';
import type { SessionNotice } from '../SessionMessage';
import type { SubmitPlanArgs } from '../mcp';

/** Autorun starts a plan when the planner submits it, approved as if the user had pressed Execute (ADR-0030). */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function planning(run: Partial<GlobalRunSettings> = {}) {
  const planner = heldPlanner();
  const runner = recordingRunner();
  const settings: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', ...run };
  const session = makeSession({ aiService: planner.aiService, runner: runner.runner, settings: () => ({ run: { ...settings } }) });
  return { session, planner, runner, settings };
}

const submitted = (): ConversationTurn => ({ kind: 'plan', tasks: [task('t1', 1)], text: '1. Task t1 — does t1', researchLog: [] });
const notes = (env: ReturnType<typeof planning>) => (env.session.planState?.conversationHistory ?? []).map((e) => e.content);

async function submit(env: ReturnType<typeof planning>): Promise<void> {
  const planned = env.session.startPlanning('build it', ['claude-code']);
  await until(() => env.planner.calls.length === 1);
  env.planner.calls[0].finish(submitted());
  await planned;
  await settled();
}

describe('autorun', () => {
  it('starts a plan the planner submits, approved as if the user pressed Execute, and says who started it', async () => {
    const env = planning({ autorun: true });
    await submit(env);

    await until(() => env.runner.spawnedIds().includes('t1'));
    expect(env.session.planState!.approvedTasks).toContain('t1');
    expect(notes(env)).toContainEqual(expect.stringMatching(/Started the plan: by autorun/));
  });

  it('leaves a submitted plan for the user\'s review when it is off', async () => {
    const env = planning({ autorun: false });
    await submit(env);
    await vi.advanceTimersByTimeAsync(1000);

    expect(env.runner.spawnedIds()).toEqual([]);
  });

  it('never starts a plan a session loads with, even when on', async () => {
    const env = planning({ autorun: true });
    env.session.loadPlan(plan([task('t1', 1)], { status: 'draft' }), 'build it', testWorkspace, { persist: false });
    await settled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(env.runner.spawnedIds()).toEqual([]);
  });

  it('tells the planner at the start, and in the next turn after it is switched', async () => {
    const env = planning({ autorun: false });
    const planned = env.session.startPlanning('build it', ['claude-code']);
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.aiService.startConversation).toHaveBeenCalledWith(expect.objectContaining({ autorun: false }));
    env.planner.calls[0].finish(prose('Which database?'));
    await planned;

    env.session.applyRunSettings({ autorun: true });
    void env.session.continueConversation('Postgres');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Noted.'));
    await settled();
    void env.session.continueConversation('and Redis');
    await until(() => env.planner.calls.length === 3);
    env.planner.calls[2].finish(prose('Noted.'));
    await settled();
    env.session.applyRunSettings({ autorun: false });
    void env.session.continueConversation('wait');
    await until(() => env.planner.calls.length === 4);

    expect(env.planner.calls[1].message).toContain(AUTORUN_ON);
    expect(env.planner.calls[2].message).not.toContain('AUTORUN');
    expect(env.planner.calls[3].message).toContain(AUTORUN_OFF);
  });

  it('tells the planner again when the turn that first told it never got an answer', async () => {
    const env = planning({ autorun: true });
    const planned = env.session.startPlanning('build it', ['claude-code']);
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(prose('Which database?'));
    await planned;

    env.session.applyRunSettings({ autorun: false });
    const failed = env.session.continueConversation('Postgres');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].fail(new Error('backend down'));
    await expect(failed).rejects.toThrow('backend down');
    void env.session.continueConversation('Postgres, then');
    await until(() => env.planner.calls.length === 3);

    expect(env.planner.calls[1].message).toContain(AUTORUN_OFF);
    expect(env.planner.calls[2].message).toContain(AUTORUN_OFF);
  });
});

const AUTORUN_FULL: Options = { settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: true } };

/** The planner's own tool calls in a reply, as a harness planner makes them: nothing is settled until the test says. */
function fullSession(run: Partial<GlobalRunSettings> = { autorun: true }, config: Partial<IConfig> = { autonomousMode: true }) {
  const planner = heldPlanner();
  const runner = recordingRunner();
  const scripts = recordingRunner();
  const notices: SessionNotice[] = [];
  const messages: SessionMessage[] = [];
  const settings: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', ...run };
  const live = fakeConfig(config);
  const session = makeSession({
    aiService: planner.aiService, runner: runner.runner, scriptRunner: scripts.runner, config: live,
    onNotice: (n) => notices.push(n), broadcast: (m) => messages.push(m), settings: () => ({ run: { ...settings } }),
  });
  return { session, planner, runner, scripts, notices, messages, settings, config: live };
}
type FullEnv = ReturnType<typeof fullSession>;

const ai = (id: string, dependencies: string[] = []) => ({ id, title: `Task ${id}`, description: 'd', type: 'ai', prompt: `do ${id}`, assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK', dependencies });
const pushes = (id: string, dependencies: string[] = []) => ({ id, title: `Script ${id}`, description: 'd', type: 'script', commands: [['git', 'push', 'origin', 'main']], sliceType: 'AFK', dependencies });

/** The reply that plans `tasks`, open: submitted through the tool, and not ended. */
async function replySubmitted(env: FullEnv, tasks: unknown[]): Promise<{ planned: Promise<unknown> }> {
  const planned = env.session.startPlanning('build it', ['claude-code']);
  await until(() => env.planner.calls.length === 1);
  const submitted = await env.planner.tools().submitPlan!({ tasks } as unknown as SubmitPlanArgs, ctx);
  expect(submitted.isError).toBeFalsy();
  return { planned };
}

async function endReply(env: FullEnv, planned: Promise<unknown>, call = 0): Promise<void> {
  env.planner.calls[call].finish(prose('Planned.'));
  await planned;
  await settled();
}

const lines = (env: Pick<FullEnv, 'session'>) => (env.session.planState?.conversationHistory ?? []).filter((e) => e.kind === 'execution').map((e) => e.content);
const cards = (env: Pick<FullEnv, 'messages'>) => env.messages.flatMap((m) => (m.type === 'approval_request' && m.kind === 'task_start' ? [m] : []));
const reason = (reply: { text: string }) => (JSON.parse(reply.text) as { reason?: string }).reason;
const push = [['git', 'push', 'origin', 'main']];
const NOT_APPROVED = 'The user has not approved this plan yet: they approve it by executing it themselves (Execute plan). Ask them to.';

describe('in Full with autorun on, the planner needs no approval for anything', () => {
  it('submit_plan then run_task in one reply: dependents start, script tasks run and run_plan works', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a'), ai('b', ['a']), pushes('s', ['b'])]);

    const started = await env.planner.tools().runTask!({ task: 'a' }, ctx);
    expect(started.isError).toBeFalsy();
    await until(() => env.runner.spawnedIds().includes('a'));
    await endReply(env, planned);

    expect(env.session.planState!.approved).toBe(true);
    expect(env.session.isExecuting).toBe(true);
    expect(lines(env)).toContain('Started the plan: by autorun.');

    env.runner.of('a').reportComplete({ status: 'done', summary: '' });
    await until(() => env.runner.spawnedIds().includes('b'));
    env.runner.of('b').reportComplete({ status: 'done', summary: '' });
    await until(() => env.scripts.spawnedIds().includes('s'));

    void env.session.continueConversation('run the rest');
    await until(() => env.planner.calls.length === 2);
    const ran = await env.planner.tools().runPlan!({}, ctx);
    expect(ran.isError).toBeFalsy();
    expect(env.notices.filter((n) => n.level === 'error')).toEqual([]);
    expect(taskOf(env.session, 'a')!.status).toBe('completed');
  });

  it('joins a hand start in a later turn too, the turn\'s start hold released', async () => {
    const env = fullSession();
    const opening = env.session.startPlanning('build it', ['claude-code']);
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(prose('Which database?'));
    await opening;
    void env.session.continueConversation('Postgres');
    await until(() => env.planner.calls.length === 2);
    expect((await env.planner.tools().submitPlan!({ tasks: [ai('a'), ai('b', ['a'])] } as unknown as SubmitPlanArgs, ctx)).isError).toBeFalsy();
    expect((await env.planner.tools().runTask!({ task: 'a' }, ctx)).isError).toBeFalsy();

    env.planner.calls[1].finish(prose('Started.'));
    await until(() => lines(env).includes('Started the plan: by autorun.'));

    env.runner.of('a').reportComplete({ status: 'done', summary: '' });
    await until(() => env.runner.spawnedIds().includes('b'));
  });

  it('runs a first plan\'s script task on the planner\'s run_task, with no card, and the start approves the plan', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [pushes('s')]);
    expect(env.session.isApproved('s')).toBe(true);

    expect((await env.planner.tools().runTask!({ task: 's' }, ctx)).isError).toBeFalsy();

    await until(() => env.scripts.spawnedIds().includes('s'));
    expect(cards(env)).toEqual([]);
    expect(env.session.planState!.approved).toBe(true);
    env.scripts.of('s').reportScriptExit({ outcome: 'passed' });
    env.scripts.of('s').emitExit(0);
    await endReply(env, planned);
  });

  it('runs run_script on a first plan with no card, its consent recorded as autorun', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a')]);

    const reply = env.planner.tools().runScript!({ title: 'Push main', commands: push }, ctx);
    await until(() => env.scripts.spawnedIds().length === 1);
    const script = env.session.planTasks.find((t) => t.type === 'script')!;
    env.scripts.of(script.id).reportScriptExit({ outcome: 'passed' });
    env.scripts.of(script.id).emitExit(0);

    expect((await reply).isError).toBeFalsy();
    expect(cards(env)).toEqual([]);
    expect(env.session.planState!.approved).toBe(true);
    expect(lines(env).at(-1)).toBe(`The planner ran script task #2 "Push main", under autorun in Full: it passed.`);
    await endReply(env, planned);
    await until(() => env.runner.spawnedIds().includes('a'));
  });

  it('starts the plan on a run_plan in the reply that submits it, and autorun, finding the run going, does not start it again', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a'), ai('b', ['a'])]);

    const ran = await env.planner.tools().runPlan!({}, ctx);
    expect(ran.isError).toBeFalsy();
    await endReply(env, planned);

    await until(() => env.runner.spawnedIds().includes('a'));
    expect(env.session.planState!.approved).toBe(true);
    expect(lines(env)).toEqual(['The planner started the plan.']);
    expect(env.notices.filter((n) => n.level !== 'info')).toEqual([]);
  });

  it('makes tasks started one by one the plan\'s run on a run_plan, whatever waited for approval included', async () => {
    const env = fullSession({ autorun: false });
    const { planned } = await replySubmitted(env, [ai('a'), ai('b', ['a'])]);
    await endReply(env, planned);
    changeSettings(env, { autorun: true });
    void env.session.continueConversation('run a, then the rest');
    await until(() => env.planner.calls.length === 2);
    expect((await env.planner.tools().runTask!({ task: 'a' }, ctx)).isError).toBeFalsy();
    await until(() => env.runner.spawnedIds().includes('a'));
    expect(env.session.waitsForApproval('b')).toBe(true);

    const joined = await env.planner.tools().runPlan!({}, ctx);

    expect((JSON.parse(joined.text) as { result: string }).result).toBe('The plan is running: task #1 "Task a" is already running, and each approved task starts as its dependencies finish.');
    expect(env.session.waitsForApproval('b')).toBe(false);
    env.planner.calls[1].finish(prose('Running.'));
    await settled();
    env.runner.of('a').reportComplete({ status: 'done', summary: '' });
    await until(() => env.runner.spawnedIds().includes('b'));
  });

  it('starts nothing on an edit: run_plan does, when the planner calls it', async () => {
    const env = await supervised([task('t1', 1)], { ...AUTORUN_FULL, execute: false, plan: { status: 'draft' } });
    void env.session.continueConversation('add a cache');
    await until(() => env.planner.calls.length === 1);
    expect((await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, ctx)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Added a cache.'));
    await settled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(env.run.spawnedIds()).toEqual([]);

    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);
    expect((await env.planner.tools().runPlan!({}, ctx)).isError).toBeFalsy();
    env.planner.calls[1].finish(prose('Running.'));

    await until(() => env.run.spawnedIds().includes('t1'));
  });

  it('leaves a plan that waited before autorun was on until the planner starts it, and then needs nobody', async () => {
    const env = fullSession({ autorun: false });
    const { planned } = await replySubmitted(env, [ai('a'), pushes('s', ['a'])]);
    await endReply(env, planned);
    changeSettings(env, { autorun: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(env.runner.spawnedIds()).toEqual([]);

    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);
    expect((await env.planner.tools().runPlan!({}, ctx)).isError).toBeFalsy();
    env.planner.calls[1].finish(prose('Running.'));

    await until(() => env.runner.spawnedIds().includes('a'));
    env.runner.of('a').reportComplete({ status: 'done', summary: '' });
    await until(() => env.scripts.spawnedIds().includes('s'));
    expect(cards(env)).toEqual([]);
  });

  it('says why when it cannot start the plan', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [{ id: 'u', title: 'Sign the form', description: 'd', type: 'user', sliceType: 'HITL', dependencies: [] }]);

    await endReply(env, planned);

    expect(env.notices).toContainEqual(expect.objectContaining({ message: 'Autorun could not start the plan: Every task has already completed: there is nothing left to run.' }));
  });

  it('needs nobody for an edit that rewrites an approved script\'s body, which still counts as a new body', async () => {
    const env = await supervised([task('t1', 1), task('s2', 2, { type: 'script', prompt: undefined, taskMode: undefined, commands: push, dependencies: ['t1'] })], AUTORUN_FULL);
    void env.session.continueConversation('push the tags too');
    await until(() => env.planner.calls.length === 1);

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 's2', changes: { commands: [['git', 'push', '--tags']] } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Changed the push.'));
    await settled();

    expect(env.session.waitsForApproval('s2')).toBe(false);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.scripts.spawnedIds().includes('s2'));
    expect(env.scripts.runner.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ script: { commands: [['git', 'push', '--tags']], timeoutMs: 600_000 } }));
  });
});

describe('anywhere else, a first plan is the user\'s to start, as before', () => {
  it('in Guarded with autorun: a hand start asks, autorun does not join it and says why, and the plan stays unapproved', async () => {
    const env = fullSession({ autorun: true }, { autonomousMode: false });
    const { planned } = await replySubmitted(env, [ai('a'), ai('b', ['a']), pushes('s', ['b'])]);
    expect(env.session.isApproved('s')).toBe(false);

    const start = env.planner.tools().runTask!({ task: 'a' }, ctx);
    await until(() => cards(env).length === 1);
    env.session.resolveApproval(cards(env)[0].id, true);
    expect((await start).isError).toBeFalsy();
    await until(() => env.runner.spawnedIds().includes('a'));
    await endReply(env, planned);

    expect(env.session.planState!.approved).toBeFalsy();
    expect(env.notices).toContainEqual(expect.objectContaining({ message: 'Autorun could not start the plan: tasks are already running, and in Guarded autorun takes no plan into work under way. Run the plan yourself to start the rest.' }));
    env.runner.of('a').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 'a')!.status === 'completed');
    await settled();
    expect(env.runner.spawnedIds()).toEqual(['a']);
    expect(env.scripts.spawnedIds()).toEqual([]);
    void env.session.continueConversation('run the rest');
    await until(() => env.planner.calls.length === 2);
    expect(reason(await env.planner.tools().runPlan!({}, ctx))).toBe(NOT_APPROVED);
  });

  it('in Guarded with autorun: run_script on a first plan asks on the card, and autorun does not approve a script task', async () => {
    const env = fullSession({ autorun: true }, { autonomousMode: false });
    const { planned } = await replySubmitted(env, [ai('a')]);

    const reply = env.planner.tools().runScript!({ title: 'Push main', commands: push }, ctx);
    await until(() => cards(env).length === 1);
    env.session.resolveApproval(cards(env)[0].id, false);
    await reply;

    const script = env.session.planTasks.find((t) => t.type === 'script')!;
    expect(env.session.isApproved(script.id)).toBe(false);
    expect(env.scripts.spawnedIds()).toEqual([]);
    env.planner.calls[0].finish(prose('Planned.'));
    await planned;
  });

  it('in Full with autorun off: every start is refused, and run_script asks on the card', async () => {
    const env = fullSession({ autorun: false });
    const { planned } = await replySubmitted(env, [ai('a'), pushes('s', ['a'])]);

    expect(reason(await env.planner.tools().runPlan!({}, ctx))).toBe(NOT_APPROVED);
    expect(reason(await env.planner.tools().runTask!({ task: 'a' }, ctx))).toBe('The user has not approved task #1 "Task a": they approve the plan by executing it themselves (Execute plan), or a task by starting it. Ask them to.');
    const reply = env.planner.tools().runScript!({ title: 'Push main', commands: push }, ctx);
    await until(() => cards(env).length === 1);
    env.session.resolveApproval(cards(env)[0].id, false);
    await reply;
    await endReply(env, planned);

    expect(env.session.planState!.approved).toBeFalsy();
    expect(env.runner.spawnedIds()).toEqual([]);
    expect(env.scripts.spawnedIds()).toEqual([]);
  });

  it('in Guarded with an Act supervisor and autorun: its wake-up is refused a plan the user has not approved', async () => {
    const env = await handStartWokenUp({ settings: { supervisorLevel: 'act', autorun: true }, config: { autonomousMode: false } });

    expect(reason(await env.planner.tools().runPlan!({}, ctx))).toMatch(/^The user has not approved this plan yet/);
  });

  it('in Full with an Act supervisor and autorun off: its wake-up is refused a plan the user has not approved', async () => {
    const env = await handStartWokenUp({ settings: { supervisorLevel: 'act', autorun: false }, config: { autonomousMode: true } });

    expect(reason(await env.planner.tools().runPlan!({}, ctx))).toMatch(/^The user has not approved this plan yet/);
  });
});

/** A plan the user never executed, one task they started by hand waiting for input, and the supervisor's wake-up turn open. */
async function handStartWokenUp(options: Options): Promise<Env> {
  const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { ...options, execute: false, plan: { status: 'draft' } });
  await env.session.execute({ command: 'force_start', task: 't1' }, { kind: 'user' });
  await until(() => env.run.spawnedIds().includes('t1'));
  waitForInput(env.run.of('t1'));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  await until(() => env.planner.calls.length === 1);
  return env;
}

describe('a supervisor under Full with autorun', () => {
  const FULL_AUTORUN = { autorun: true };

  it('at Act: a wake-up is not refused for a plan the user has not approved, and the run it joins starts the dependents', async () => {
    const env = await handStartWokenUp({ settings: { ...FULL_AUTORUN, supervisorLevel: 'act' }, config: { autonomousMode: true } });

    const ran = await env.planner.tools().runPlan!({}, ctx);

    expect(ran.isError).toBeFalsy();
    expect(env.session.planState!.approved).toBe(true);
    env.planner.calls[0].finish(prose('Joined the run.'));
    await settled();
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes('t2'));
  });

  it('at Watch: a wake-up is still refused', async () => {
    const env = await handStartWokenUp({ settings: { ...FULL_AUTORUN, supervisorLevel: 'watch' }, config: { autonomousMode: true } });

    expect(reason(await env.planner.tools().runPlan!({}, ctx))).toMatch(/^You are the supervisor at Watch/);
    expect(env.session.planState!.approved).toBeFalsy();
  });

  it('at Act: an edit that rewrites an approved script needs nobody either', async () => {
    const script = task('s2', 2, { type: 'script', prompt: undefined, taskMode: undefined, commands: push, dependencies: ['t1'] });
    const env = await supervised([task('t1', 1), script], { settings: { ...FULL_AUTORUN, supervisorLevel: 'act' }, config: { autonomousMode: true } });
    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 's2', changes: { commands: [['git', 'push', '--tags']] } }] }, ctx);

    expect(edit.isError).toBeFalsy();
    expect(env.session.waitsForApproval('s2')).toBe(false);
  });
});

describe('switching autorun or Full off takes effect at once', () => {
  it('autorun off mid-reply: run_plan is refused, run_script asks, and nothing starts at the reply\'s end', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a')]);
    changeSettings(env, { autorun: false });

    expect(reason(await env.planner.tools().runPlan!({}, ctx))).toBe(NOT_APPROVED);
    const reply = env.planner.tools().runScript!({ title: 'Push main', commands: push }, ctx);
    await until(() => cards(env).length === 1);
    env.session.resolveApproval(cards(env)[0].id, false);
    await reply;
    await endReply(env, planned);

    expect(env.runner.spawnedIds()).toEqual([]);
    expect(env.session.planState!.approved).toBeFalsy();
  });

  it('Full off mid-reply: run_plan is refused as the first plan it is, and run_script asks', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a')]);
    env.config.autonomousMode = false;

    expect(reason(await env.planner.tools().runPlan!({}, ctx))).toBe(NOT_APPROVED);
    const reply = env.planner.tools().runScript!({ title: 'Push main', commands: push }, ctx);
    await until(() => cards(env).length === 1);
    env.session.resolveApproval(cards(env)[0].id, false);
    await reply;
    env.planner.calls[0].finish(prose('Planned.'));
    await planned;
  });

  it('a plan a start approved stays approved, but what the planner writes after autorun went off waits for the user', async () => {
    const env = fullSession();
    const { planned } = await replySubmitted(env, [ai('a')]);
    expect((await env.planner.tools().runTask!({ task: 'a' }, ctx)).isError).toBeFalsy();
    await endReply(env, planned);
    changeSettings(env, { autorun: false });
    void env.session.continueConversation('add a cache');
    await until(() => env.planner.calls.length === 2);

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache', assignedRunner: 'claude-code' } }] }, ctx);
    expect(edit.isError).toBeFalsy();

    const cache = env.session.planTasks.find((t) => t.title === 'Add a cache')!;
    expect(env.session.waitsForApproval(cache.id)).toBe(true);
    expect(reason(await env.planner.tools().runTask!({ task: cache.id }, ctx))).toBe('Task #2 "Add a cache" was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { changeSettings, ctx, NOW, prose, settled, supervised, task, until, type Env, type Options } from './supervisorTestKit';

/**
 * With autorun on and Full, the planner may start a task added after the plan
 * was approved, when it asks; both are read at the start (ADR-0030).
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const AUTORUN_FULL: Options = { settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: true } };

/** A plan the user ran, its one task finished, and the user's next turn open. */
async function finishedRun(options: Options = AUTORUN_FULL): Promise<Env> {
  const env = await supervised([task('t1', 1)], options);
  env.run.of('t1').reportComplete({ status: 'done', summary: '' });
  await until(() => taskOf(env.session, 't1')!.status === 'completed');
  await settled();
  void env.session.continueConversation('also add a cache and run it');
  await until(() => env.planner.calls.length === 1);
  return env;
}

const added = (env: Env) => env.session.planTasks.find((t) => t.title === 'Add a cache');

async function addCache(env: Env, ops = false): Promise<void> {
  const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache', ...(ops ? { ops: true } : {}) } }] }, ctx);
  expect(edit.isError).toBeFalsy();
}

async function landEdit(env: Env, call = 0): Promise<void> {
  env.planner.calls[call].finish(prose('Added a cache.'));
  await settled();
}

const executionLines = (env: Env) =>
  (env.session.planState!.conversationHistory ?? []).filter((e) => e.kind === 'execution').map((e) => e.content);

describe('a task the planner adds after approval, with autorun on and Full', () => {
  it('starts when the planner asks in a later reply, and the start approves it', async () => {
    const env = await finishedRun();
    await addCache(env);
    await landEdit(env);
    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);

    const started = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);

    expect(started.isError).toBeFalsy();
    await until(() => env.run.spawnedIds().includes(added(env)!.id));
    expect(env.session.planState!.approvedTasks).toContain(added(env)!.id);
    expect(executionLines(env).at(-1)).toBe(`The planner started task #2 "Add a cache".`);
  });

  // ADR-0022 P2: the edit is in the plan as its call answers, so the start that follows it runs it as edited, at once.
  it('starts at once when the planner adds it and asks in the same reply', async () => {
    const env = await finishedRun();
    await addCache(env);

    const started = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);

    expect(started.isError).toBeFalsy();
    // Before the reply ends: nothing waits for it.
    await until(() => env.run.spawnedIds().includes(added(env)!.id));
  });

  it('starts a task named by the handle the same reply\'s edit gave it', async () => {
    const env = await finishedRun();
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' }, handle: 'cache' }] }, ctx);
    expect(edit.isError).toBeFalsy();

    expect((await env.planner.tools().runTask!({ task: 'cache' }, ctx)).isError).toBeFalsy();

    await until(() => env.run.spawnedIds().includes(added(env)!.id));
    expect(executionLines(env).at(-1)).toBe(`The planner started task #2 "Add a cache".`);
  });

  it('refuses at once a start naming no task the plan has', async () => {
    const env = await finishedRun();
    await addCache(env);

    const start = await env.planner.tools().runTask!({ task: 'no-such-task' }, ctx);

    expect(start.isError).toBe(true);
    expect(JSON.parse(start.text).reason).toBe('No task matches "no-such-task" in the current plan. Name it by id, "#order" (a subtask "#order.sub"), exact title, or the handle an edit_plan call of this reply gave it.');
  });

  it('refuses at once a start of a task the same reply\'s edit removes', async () => {
    const env = await finishedRun();
    await addCache(env);
    const removed = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Warm the cache', prompt: 'warm it' }, handle: 'warm' }, { op: 'remove', taskId: 'warm' }] }, ctx);
    expect(removed.isError).toBeFalsy();

    const start = await env.planner.tools().runTask!({ task: 'warm' }, ctx);

    expect(start.isError).toBe(true);
    expect(JSON.parse(start.text).reason).toMatch(/^No task matches "warm" in the current plan\./);
    await landEdit(env);
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('refuses at once a start behind the edit that could not run as edited, rather than queueing it', async () => {
    const env = await supervised([task('t1', 1)], AUTORUN_FULL);
    void env.session.continueConversation('add a cache after task 1 and run it');
    await until(() => env.planner.calls.length === 1);
    await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache', dependencies: ['#1'] } }] }, ctx);

    const start = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);

    expect(start.isError).toBe(true);
    expect(JSON.parse(start.text).reason).toBe('Task #2 "Add a cache" depends on task #1 "Task t1" (running), which has not finished. It can start once it has.');
    await landEdit(env);
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('starts a task its edit added under autorun though autorun is off by the start, and queues nothing', async () => {
    const env = await finishedRun();
    await addCache(env);
    // Read at the start: the user turns autorun off between the edit and the start.
    changeSettings(env, { autorun: false });

    const start = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);

    // Approved as the edit committed, autorun still on then: the user's yes for what the planner writes in their turn.
    expect(start.isError).toBeFalsy();
    await until(() => env.run.spawnedIds().includes(added(env)!.id));
    await landEdit(env);
    expect((env.session.planState!.conversationHistory ?? []).some((e) => e.content.startsWith('The queued start'))).toBe(false);
  });

  it('starts an added ops task too', async () => {
    const env = await finishedRun();
    await addCache(env, true);
    await landEdit(env);
    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);

    expect((await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx)).isError).toBeFalsy();
  });

  it('runs the plan with its added task through run_plan', async () => {
    const env = await finishedRun();
    await addCache(env);
    await landEdit(env);
    void env.session.continueConversation('run the plan');
    await until(() => env.planner.calls.length === 2);

    const ran = await env.planner.tools().runPlan!({}, ctx);

    expect(ran.isError).toBeFalsy();
    // The scheduler holds new starts while the turn is open.
    expect(JSON.parse(ran.text).result).toBe('The plan is running: what is ready starts once this reply ends, and the rest as their dependencies finish.');
    env.planner.calls[1].finish(prose('Running it.'));
    await until(() => env.run.spawnedIds().includes(added(env)!.id));
  });
});

describe('a task the planner adds after approval waits for the user', () => {
  async function refusedStart(env: Env): Promise<string> {
    await addCache(env);
    await landEdit(env);
    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);
    const start = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);
    expect(start.isError).toBe(true);
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1']);
    return JSON.parse(start.text).reason as string;
  }

  it('with autorun off', async () => {
    const env = await finishedRun({ settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: true } });
    expect(await refusedStart(env)).toMatch(/was added after the user ran the plan/);
  });

  it('when autorun is turned off before the edit is made: the setting is read as it commits', async () => {
    const env = await finishedRun();
    changeSettings(env, { autorun: false });
    await addCache(env);
    await landEdit(env);
    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);

    const start = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);

    expect(start.isError).toBe(true);
    expect(env.session.planState!.approvedTasks).not.toContain(added(env)!.id);
  });
});

describe('with autorun on, a task the planner adds in the user\'s turn needs no approval', () => {
  async function addedDuringRun(options: Options): Promise<Env> {
    const env = await supervised([task('t1', 1)], options);
    void env.session.continueConversation('add a cache after task 1');
    await until(() => env.planner.calls.length === 1);
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache', dependencies: ['#1'] } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    await landEdit(env);
    return env;
  }

  it.each([
    ['Full', AUTORUN_FULL],
    ['Guarded', { settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: false } } satisfies Options],
  ])('in %s: it is approved as it lands, and starts once its dependencies finish', async (_mode, options) => {
    const env = await addedDuringRun(options);

    expect(env.session.planState!.approvedTasks).toContain(added(env)!.id);
    expect(env.session.waitsForApproval(added(env)!.id)).toBe(false);
    expect(env.run.spawnedIds()).toEqual(['t1']);

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes(added(env)!.id));
  });

  it('a task added while autorun was off is approved once the planner rewrites it with autorun on', async () => {
    const env = await addedDuringRun({ settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: true } });
    expect(env.session.waitsForApproval(added(env)!.id)).toBe(true);
    changeSettings(env, { autorun: true });
    void env.session.continueConversation('make the cache an LRU');
    await until(() => env.planner.calls.length === 2);

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'add an LRU cache' } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    await landEdit(env, 1);

    expect(env.session.waitsForApproval(added(env)!.id)).toBe(false);
  });

  it('with autorun off, it still waits for the user', async () => {
    const env = await addedDuringRun({ settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: true } });

    expect(env.session.waitsForApproval(added(env)!.id)).toBe(true);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { ctx, NOW, prose, settled, supervised, task, until, type Env, type Options } from './supervisorTestKit';
import { SURFACE_CONTROLS } from '../surfaceControls';

/**
 * Guarded means "ask the user first": in the user's own turn, a planner start
 * of tasks the user has not approved yet asks them on the approval card,
 * naming the tasks a yes approves, rather than being refused (ADR-0029). A
 * start after the turn's own edit asks at once: the edit is in the plan as its
 * call answers (ADR-0022 P2).
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// Autorun off: with it on, what the planner adds in the user's turn is approved as it commits, and no start asks about it.
const GUARDED: Options = { settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: false } };

/** A plan the user ran, its one task finished, and the user's next turn open. */
async function finishedRun(options: Options = GUARDED): Promise<Env> {
  const env = await supervised([task('t1', 1)], options);
  env.run.of('t1').reportComplete({ status: 'done', summary: '' });
  await until(() => taskOf(env.session, 't1')!.status === 'completed');
  await settled();
  void env.session.continueConversation('add a cache and a log, and run them');
  await until(() => env.planner.calls.length === 1);
  return env;
}

const titled = (env: Env, title: string) => env.session.planTasks.find((t) => t.title === title);
const cards = (env: Env) => env.messages.flatMap((m) => (m.type === 'approval_request' && m.kind === 'task_start' ? [m] : []));
const answer = (result: { text: string }) => JSON.parse(result.text) as { result?: string; reason?: string };

async function addTwo(env: Env): Promise<void> {
  const edit = await env.planner.tools().editPlan!({ ops: [
    { op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } },
    { op: 'add', task: { title: 'Add a log', prompt: 'add a log' } },
  ] }, ctx);
  expect(edit.isError).toBeFalsy();
}

describe('a Guarded planner start in the user\'s turn, of tasks the user has not approved', () => {
  it('run_plan after the turn\'s own edit asks at once, naming the added tasks; a yes approves them and runs the plan', async () => {
    const env = await finishedRun();
    await addTwo(env);

    const pending = env.planner.tools().runPlan!({}, ctx);
    await until(() => cards(env).length === 1);

    expect(cards(env)[0]).toMatchObject({
      subject: 'Run the plan',
      detail: 'The planner wants to start work. Allowing approves task #2 "Add a cache" and task #3 "Add a log", added since you approved the plan, and starts them with the rest. Each task runs on its runner, in the mode the plan set.',
    });
    expect(env.run.spawnedIds()).toEqual(['t1']);
    env.session.resolveApproval(cards(env)[0].id, true);
    expect((await pending).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Added both, and they run.'));

    const cache = titled(env, 'Add a cache')!.id;
    const log = titled(env, 'Add a log')!.id;
    await until(() => env.run.spawnedIds().includes(cache) && env.run.spawnedIds().includes(log));
    expect(env.session.planState!.approvedTasks).toEqual(expect.arrayContaining([cache, log]));
  });

  it('a no is declined: nothing starts, and the added tasks stay in the plan, unapproved', async () => {
    const env = await finishedRun();
    await addTwo(env);
    const pending = env.planner.tools().runPlan!({}, ctx);
    await until(() => cards(env).length === 1);

    env.session.resolveApproval(cards(env)[0].id, false);
    expect(answer(await pending).reason).toMatch(/^The user did not approve: run the plan\./);
    env.planner.calls[0].finish(prose('Added both.'));
    await settled();

    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(titled(env, 'Add a cache')).toBeDefined();
    expect(env.session.planState!.approvedTasks).not.toContain(titled(env, 'Add a cache')!.id);
    const history = env.session.planState!.conversationHistory!;
    expect(history.filter((e) => e.kind === 'execution').at(-1)!.content).toBe('The planner asked to run the plan; you declined.');
  });

  it('run_task of a task the same reply adds asks at once, and a yes approves and starts it', async () => {
    const env = await finishedRun();
    await addTwo(env);

    const pending = env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);
    await until(() => cards(env).length === 1);
    expect(cards(env)[0]).toMatchObject({
      subject: 'Start task #2 "Add a cache"',
      detail: 'The planner wants to start work. Allowing approves task #2 "Add a cache", added since you approved the plan. It runs on claude-code in auto mode, as the plan set it.',
    });
    env.session.resolveApproval(cards(env)[0].id, true);

    expect(answer(await pending).result).toBe('Started task #2 "Add a cache".');
    const cache = titled(env, 'Add a cache')!.id;
    await until(() => env.run.spawnedIds().includes(cache));
    expect(env.session.planState!.approvedTasks).toContain(cache);
    expect(env.session.planState!.approvedTasks).not.toContain(titled(env, 'Add a log')!.id);
  });

  it('retry_task naming a handle the same reply\'s edit gave asks for that task at once', async () => {
    const env = await finishedRun();
    const edit = await env.planner.tools().editPlan!({ ops: [
      { op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } },
      { op: 'add', task: { title: 'Add a log', prompt: 'add a log' }, handle: 'log' },
    ] }, ctx);
    expect(edit.isError).toBeFalsy();

    const pending = env.planner.tools().retryTask!({ task: 'log', from: 'fresh' }, ctx);
    await until(() => cards(env).length === 1);
    expect(cards(env)[0]).toMatchObject({ subject: 'Retry task #3 "Add a log"' });
    env.session.resolveApproval(cards(env)[0].id, true);
    expect((await pending).isError).toBeFalsy();

    const log = titled(env, 'Add a log')!.id;
    await until(() => env.run.spawnedIds().includes(log));
    expect(env.session.planState!.approvedTasks).toContain(log);
  });

  it('run_task of a task added in an earlier reply asks on the card at once', async () => {
    const env = await finishedRun();
    await addTwo(env);
    env.planner.calls[0].finish(prose('Added both.'));
    await settled();
    void env.session.continueConversation('run the cache one');
    await until(() => env.planner.calls.length === 2);

    const pending = env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);
    await until(() => cards(env).length === 1);
    env.session.resolveApproval(cards(env)[0].id, true);

    expect(answer(await pending).result).toBe('Started task #2 "Add a cache".');
    expect(env.session.planState!.approvedTasks).toContain(titled(env, 'Add a cache')!.id);
  });

  it('a stop while the card asks withdraws the start, and keeps the edit committed with its tasks unapproved', async () => {
    const env = await finishedRun();
    await addTwo(env);
    const pending = env.planner.tools().runPlan!({}, ctx);
    await until(() => cards(env).length === 1);

    env.session.abortPlannerTurn();
    await pending;
    await settled();

    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(env.session.planTasks.map((t) => t.title)).toEqual(['Task t1', 'Add a cache', 'Add a log']);
    expect(env.session.planState!.approvedTasks).not.toContain(titled(env, 'Add a cache')!.id);
  });

  it('still refuses what could not run whatever the user answered, before asking', async () => {
    const env = await finishedRun();
    const edit = await env.planner.tools().editPlan!({ ops: [
      { op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' }, handle: 'cache' },
      { op: 'add', task: { title: 'Add a log', prompt: 'add a log', dependencies: ['cache'] } },
    ] }, ctx);
    expect(edit.isError).toBeFalsy();

    const start = await env.planner.tools().runTask!({ task: 'Add a log' }, ctx);

    expect(start.isError).toBe(true);
    expect(answer(start).reason).toBe('Task #3 "Add a log" depends on task #2 "Add a cache" (not started), which has not finished. It can start once it has.');
    env.planner.calls[0].finish(prose('Added both.'));
    await settled();
    expect(cards(env)).toEqual([]);
  });
});

describe('a planner start of a plan the user never executed', () => {
  it('is refused at once with the Execute plan message, never queued, even behind an edit in Guarded', async () => {
    const env = await supervised([task('t1', 1)], { ...GUARDED, plan: { status: 'draft' }, execute: false });
    void env.session.continueConversation('add a cache and run it');
    await until(() => env.planner.calls.length === 1);
    await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, ctx);

    const start = await env.planner.tools().runPlan!({}, ctx);

    expect(start.isError).toBe(true);
    expect(answer(start).reason).toBe(`The user has not approved this plan yet: they approve it themselves (${SURFACE_CONTROLS.unknown.approvePlan}). Ask them to.`);
    env.planner.calls[0].finish(prose('Added it.'));
    await settled();
    expect(cards(env)).toEqual([]);
    expect(env.run.spawnedIds()).toEqual([]);
  });
});

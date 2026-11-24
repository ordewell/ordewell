import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { ctx, NOW, prose, settled, supervised, task, until, wokenUp, type Env, type Options } from './supervisorTestKit';

/**
 * Every attempt start passes one claim in the scheduler, which checks in one
 * synchronous step that the task is approved (ADR-0035), that no Stop came
 * since the start was admitted (ADR-0029), that a slot is free, and that the
 * task can still start. Driven through a real Session, its command seam and
 * its scheduler; only the runner process is faked.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// Autorun off: with it on, what the planner adds in the user's turn is approved as it commits.
const GUARDED: Options = { settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: false, maxParallelSessions: 2 } };

const FULL_AUTORUN: Options = { settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: true } };
const FULL: Options = { settings: { supervisorLevel: 'off' }, config: { autonomousMode: true } };

const USER = { kind: 'user' } as const;
const STOPPED = 'Not done: stopped before it could start. The run was stopped meanwhile; start it again if it is still wanted.';

const titled = (env: Env, title: string) => env.session.planTasks.find((t) => t.title === title);
const cards = (env: Env) => env.messages.flatMap((m) => (m.type === 'approval_request' && m.kind === 'task_start' ? [m] : []));
const answer = (result: { text: string }) => JSON.parse(result.text) as { result?: string; reason?: string };
const history = (env: Env) => env.session.planState!.conversationHistory!;
const timeline = (env: Env) => history(env).filter((e) => e.kind === 'execution').map((e) => e.content);

/** The user's turn during the run adds a task with no start tool, and ends. */
async function addedInUsersTurn(env: Env, title = 'New unapproved work'): Promise<string> {
  void env.session.continueConversation('also add some new work');
  await until(() => env.planner.calls.length === 1);
  const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title, prompt: 'do the new work' } }] }, ctx);
  expect(edit.isError).toBeFalsy();
  env.planner.calls[0].finish(prose('Added it.'));
  await settled();
  return titled(env, title)!.id;
}

describe('the scheduler starts only approved tasks', () => {
  it('leaves a task the planner added in the user\'s turn during a run waiting, without asking', async () => {
    const env = await supervised([task('t1', 1)], GUARDED);
    expect(env.run.spawnedIds()).toEqual(['t1']);

    const added = await addedInUsersTurn(env);

    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(env.session.planTasks.find((t) => t.id === added)!.status).toBe('pending');
    expect(env.session.planState!.approvedTasks).toEqual(['t1']);
    expect(cards(env)).toEqual([]);
  });

  it('starts what the user approves by running it, and only that', async () => {
    const env = await supervised([task('t1', 1)], GUARDED);
    const added = await addedInUsersTurn(env);

    expect(await env.session.execute({ command: 'run_task', task: added }, USER)).toMatchObject({ ok: true });

    expect(env.run.spawnedIds()).toEqual(['t1', added]);
    expect(env.session.planState!.approvedTasks).toEqual(['t1', added]);
  });

  it('starts everything in the plan once the user executes it', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], GUARDED);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes('t2'));
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => !env.session.isExecuting);
    const added = await addedInUsersTurn(env);
    expect(env.run.spawnedIds()).toEqual(['t1', 't2']);

    expect(await env.session.execute({ command: 'run_plan' }, USER)).toMatchObject({ ok: true });

    await until(() => env.run.spawnedIds().includes(added));
  });

  it('starts a task the supervisor adds at Act without the user', async () => {
    const env = await wokenUp({ settings: { supervisorLevel: 'act' } }, [task('t1', 1)]);

    await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, ctx);
    env.planner.calls[0].finish(prose('Added a cache.'));

    await until(() => env.run.spawnedIds().includes(titled(env, 'Add a cache')?.id ?? 'not added'));
  });

  it('with autorun on, starts a task the planner added in the user\'s turn without anyone asking', async () => {
    const env = await supervised([task('t1', 1)], FULL_AUTORUN);
    const added = await addedInUsersTurn(env);

    await until(() => env.run.spawnedIds().includes(added));
    expect(cards(env)).toEqual([]);
  });
});

describe('a Stop withdraws every start admitted before it', () => {
  /**
   * A planner turn of the user's that edits task 1 and runs the plan, whose
   * starts the turn's start hold keeps until its reply ends (ADR-0029); the
   * edit is in the plan as its call answers (ADR-0022 P2).
   */
  async function heldRunPlan(env: Env): Promise<void> {
    void env.session.continueConversation('reword task 1, then run the plan');
    await until(() => env.planner.calls.length === 1);
    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, carefully' } }] }, ctx);
    const ran = await env.planner.tools().runPlan!({}, ctx);
    expect(answer(ran).result).toBe('The plan is running: what is ready starts once this reply ends, and the rest as their dependencies finish.');
  }

  it('a run of the plan held by the turn does not start after the user started and stopped the run', async () => {
    const env = await supervised([task('t1', 1)], { ...FULL, execute: false });
    await heldRunPlan(env);

    expect(await env.session.execute({ command: 'run_plan' }, USER)).toMatchObject({ ok: true });
    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true });
    env.planner.calls[0].finish(prose('Reworded it; it runs as this reply ends.'));
    await settled();
    await settled();

    expect(env.run.spawnedIds()).toEqual([]);
    // The user's run joined the one the planner's start made and started nothing, so it records no start of its own.
    expect(timeline(env)).toEqual([
      'The planner started the plan.',
      'You stopped the run.',
    ]);
    expect(taskOf(env.session, 't1')!.prompt).toBe('do t1, carefully');
  });

  it('a Stop with nothing running yet still withdraws a run the turn holds', async () => {
    const env = await supervised([task('t1', 1)], { ...FULL, execute: false });
    await heldRunPlan(env);

    const stopped = await env.session.execute({ command: 'stop_run' }, USER);
    env.planner.calls[0].finish(prose('Reworded it.'));
    await settled();
    await settled();

    expect(stopped).toMatchObject({ ok: true });
    expect(env.run.spawnedIds()).toEqual([]);
  });

  it('a start the user allowed on the card does not run when Stop comes before it carries on', async () => {
    const env = await supervised([task('t1', 1)], GUARDED);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => !env.session.isExecuting);
    void env.session.continueConversation('add a cache and run it');
    await until(() => env.planner.calls.length === 1);
    await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, ctx);
    const pending = env.planner.tools().runPlan!({}, ctx);
    await until(() => cards(env).length === 1);

    env.session.resolveApproval(cards(env)[0].id, true);
    env.session.stopExecution();
    env.planner.calls[0].finish(prose('Added it.'));
    await settled();
    await settled();

    expect(answer(await pending).reason).toBe(STOPPED);
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('a Stop answers a start still waiting on the card as stopped, not declined, and clears the card', async () => {
    const env = await supervised([task('t1', 1)], GUARDED);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => !env.session.isExecuting);
    const added = await addedInUsersTurn(env);
    void env.session.continueConversation('run the new work');
    await until(() => env.planner.calls.length === 2);
    const pending = env.planner.tools().runTask!({ task: added }, ctx);
    await until(() => cards(env).length === 1);

    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true });

    expect(answer(await pending).reason).toBe(STOPPED);
    expect(env.session.outstandingApprovals()).toEqual([]);
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('lets a new start after the Stop run', async () => {
    const env = await supervised([task('t1', 1)], { ...FULL, execute: false });
    await heldRunPlan(env);
    await env.session.execute({ command: 'stop_run' }, USER);
    env.planner.calls[0].finish(prose('Reworded it.'));
    await settled();

    expect(await env.session.execute({ command: 'run_plan' }, USER)).toMatchObject({ ok: true });

    expect(env.run.spawnedIds()).toEqual(['t1']);
  });
});


describe('a start and a Stop asked for at once', () => {
  it('a task start racing the user\'s Stop is refused as stopped, and nothing runs', async () => {
    const env = await supervised([task('t1', 1)], { ...FULL, execute: false });

    const [started, stopped] = await Promise.all([
      env.session.execute({ command: 'run_task', task: 't1' }, USER),
      env.session.execute({ command: 'stop_run' }, USER),
    ]);

    expect(stopped).toMatchObject({ ok: true });
    expect(started).toEqual({ ok: false, outcome: 'refused', message: STOPPED });
    expect(env.run.spawnedIds()).toEqual([]);
    expect(taskOf(env.session, 't1')!.status).toBe('pending');
  });
});

describe('the slot limit holds at the claim', () => {
  const ONE_SLOT: Options = { ...FULL, config: { autonomousMode: true, maxParallelSessions: 1 } };
  const FULL_SLOT = '1 task is already running, the most this session runs at once. Wait for one to finish, or stop one first.';

  it('refuses a force start while the scheduler holds every slot, and the scheduler fills the slot once it frees', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], ONE_SLOT);
    expect(env.run.spawnedIds()).toEqual(['t1']);

    await expect(env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' })).resolves.toEqual({ ok: false, outcome: 'refused', message: FULL_SLOT });
    expect(env.run.spawnedIds()).toEqual(['t1']);

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes('t2'));
    expect(env.run.spawnedIds()).toEqual(['t1', 't2']);
  });

  it('lets one of two task starts asked for at once take the last slot, and refuses the other', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { ...ONE_SLOT, execute: false });

    const [first, second] = await Promise.all([
      env.session.execute({ command: 'run_task', task: 't1' }, USER),
      env.session.execute({ command: 'run_task', task: 't2' }, USER),
    ]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: false, outcome: 'refused', message: FULL_SLOT });
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('starts one task when Execute and a force start race for the last slot', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { ...ONE_SLOT, execute: false });

    const results = await Promise.all([env.session.execute({ command: 'run_plan' }, { kind: 'user' }), env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' })]);

    expect(env.run.spawnedIds()).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(env.run.spawnedIds()[0] === 't1' ? 1 : 0);
  });
});

describe('a task waiting for the user\'s approval, as every surface reads it', () => {
  const lastStatus = (env: Env, taskId: string) => env.messages
    .flatMap((m) => (m.type === 'status_update' ? m.tasks : []))
    .filter((t) => t.id === taskId)
    .at(-1);

  it('is marked on the status stream and in the run view while it waits, and no longer once the user starts it', async () => {
    const env = await supervised([task('t1', 1)], GUARDED);
    const added = await addedInUsersTurn(env);
    env.session.reschedule();
    await settled();

    expect(lastStatus(env, added)).toMatchObject({ status: 'pending', waitsForApproval: true });
    expect(lastStatus(env, 't1')!.waitsForApproval).toBeUndefined();
    expect(env.session.runSnapshot().tasks.find((t) => t.id === added)).toMatchObject({ waitsForApproval: true });

    await env.session.execute({ command: 'run_task', task: added }, USER);

    expect(lastStatus(env, added)!.waitsForApproval).toBeUndefined();
    expect(env.session.runSnapshot().tasks.find((t) => t.id === added)!.waitsForApproval).toBeUndefined();
  });

  it('is not marked on a plan the user never executed: nothing in it is theirs to run yet', async () => {
    const env = await supervised([task('t1', 1)], { ...GUARDED, plan: { status: 'draft' }, execute: false });

    expect(env.session.runSnapshot().tasks[0].waitsForApproval).toBeUndefined();
  });

  it('is carried with the plan a surface reads whole, as the approval record', async () => {
    const env = await supervised([task('t1', 1)], GUARDED);
    await addedInUsersTurn(env);

    expect(env.session.currentPlanState).toMatchObject({ approved: true, approvedTasks: ['t1'] });
  });
});

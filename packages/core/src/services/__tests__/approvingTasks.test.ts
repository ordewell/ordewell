import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { ctx, NOW, prose, settled, supervised, task, until, type Env, type Options } from './supervisorTestKit';

/**
 * The user approves tasks the planner added after the plan was approved: by
 * running the plan while a run is under way, or by force starting one, and
 * neither starts a task before its dependencies finish.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const AUTORUN_OFF: Options = { settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: true } };

const byTitle = (env: Env, title: string) => env.session.planTasks.find((t) => t.title === title)!;
const infoNotices = (env: Env) => env.notices.filter((n) => n.level === 'info').map((n) => n.message);

/** A run under way on t1, and tasks the planner added in the user's turn since, each waiting for approval. */
async function waitingDuringRun(adds: { title: string; dependencies?: string[] }[], tasks = [task('t1', 1)]): Promise<Env> {
  const env = await supervised(tasks, AUTORUN_OFF);
  void env.session.continueConversation('add some tasks');
  await until(() => env.planner.calls.length === 1);
  const edit = await env.planner.tools().editPlan!({
    ops: adds.map(({ title, dependencies }) => ({ op: 'add', task: { title, prompt: title.toLowerCase(), ...(dependencies ? { dependencies } : {}) } })),
  }, ctx);
  expect(edit.isError).toBeFalsy();
  env.planner.calls[0].finish(prose('Added them.'));
  await settled();
  for (const { title } of adds) expect(env.session.waitsForApproval(byTitle(env, title).id)).toBe(true);
  return env;
}

describe('running the plan while a run is under way', () => {
  it('approves every task that waits for approval, and each starts once its dependencies finish', async () => {
    const env = await waitingDuringRun([
      { title: 'Add a cache', dependencies: ['#1'] },
      { title: 'Warm the cache', dependencies: ['#1'] },
    ]);

    const outcome = await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(outcome).toMatchObject({ ok: true, message: 'Approved 2 tasks; each starts once its dependencies finish.' });
    expect(infoNotices(env)).toContain('Approved 2 tasks; each starts once its dependencies finish.');
    expect(env.session.waitsForApproval(byTitle(env, 'Add a cache').id)).toBe(false);
    expect(env.run.spawnedIds()).toEqual(['t1']);

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().length === 3);
  });

  it('starts at once an approved task with nothing left to wait on', async () => {
    const env = await waitingDuringRun([{ title: 'Add a cache' }]);

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(infoNotices(env)).toContain('Approved 1 task; it starts once its dependencies finish.');
    await until(() => env.run.spawnedIds().includes(byTitle(env, 'Add a cache').id));
    expect(taskOf(env.session, 't1')!.status).toBe('in_progress');
  });

  it('says so when nothing waits for approval, and records no second start', async () => {
    const env = await supervised([task('t1', 1)], AUTORUN_OFF);
    const starts = () => (env.session.planState!.conversationHistory ?? []).filter((e) => e.kind === 'execution' && e.content === 'You started the plan.');
    const before = starts().length;

    const outcome = await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(outcome).toMatchObject({ ok: true, message: 'The plan is already running, and no task waits for your approval.' });
    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(starts()).toHaveLength(before);
  });

  it('records the start when it approves what waits', async () => {
    const env = await waitingDuringRun([{ title: 'Add a cache', dependencies: ['#1'] }]);
    const starts = () => (env.session.planState!.conversationHistory ?? []).filter((e) => e.kind === 'execution' && e.content === 'You started the plan.');
    const before = starts().length;

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(starts()).toHaveLength(before + 1);
  });
});

describe('force starting a task whose dependencies have not finished', () => {
  it('approves it and queues it rather than starting it early, and says so; it starts once they finish', async () => {
    const env = await waitingDuringRun([{ title: 'Add a cache', dependencies: ['#1'] }]);
    const cache = byTitle(env, 'Add a cache').id;

    await env.session.execute({ command: 'force_start', task: cache }, { kind: 'user' });

    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(env.session.waitsForApproval(cache)).toBe(false);
    expect(infoNotices(env)).toContain('Task "Add a cache" is approved and starts once task "Task t1" finishes.');

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes(cache));
  });

  it('says that nothing will start it while no run is under way', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { ...AUTORUN_OFF, execute: false });

    await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' });

    expect(env.run.spawnedIds()).toEqual([]);
    expect(infoNotices(env)).toContain('Task "Task t2" is approved and starts once task "Task t1" finishes. Nothing is running now: run the plan to start them.');
  });

  it('still starts a task blocked by a failed dependency: forcing past a failure is the user\'s call (ADR-0034)', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], AUTORUN_OFF);
    env.run.of('t1').reportComplete({ status: 'failed', summary: 'broke' });
    await until(() => taskOf(env.session, 't1')!.status === 'failed');

    await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' });

    expect(env.run.spawnedIds()).toEqual(['t1', 't2']);
  });

  it('forced past a failed dependency, it still waits for one under way, and starts once that finishes', async () => {
    const env = await supervised([task('a', 1), task('b', 2), task('c', 3, { dependencies: ['a', 'b'] })], AUTORUN_OFF);
    env.run.of('a').reportComplete({ status: 'failed', summary: 'broke' });
    await until(() => taskOf(env.session, 'a')!.status === 'failed');

    await env.session.execute({ command: 'force_start', task: 'c' }, { kind: 'user' });

    expect(env.run.spawnedIds()).toEqual(['a', 'b']);
    expect(infoNotices(env)).toContain('Task "Task c" is approved and starts once task "Task b" finishes.');

    env.run.of('b').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes('c'));
  });

  // A dependency blocked behind the failure is gone past with it, not the work it waits on.
  it('forced past a dependency blocked by a failure, it still waits for what that one waits on', async () => {
    const env = await supervised([
      task('a', 1), task('d', 2), task('b', 3, { dependencies: ['a', 'd'] }), task('c', 4, { dependencies: ['b'] }),
    ], AUTORUN_OFF);
    env.run.of('a').reportComplete({ status: 'failed', summary: 'broke' });
    await until(() => taskOf(env.session, 'a')!.status === 'failed');

    await env.session.execute({ command: 'force_start', task: 'c' }, { kind: 'user' });

    expect(env.run.spawnedIds()).toEqual(['a', 'd']);
    expect(infoNotices(env)).toContain('Task "Task c" is approved and starts once task "Task d" finishes.');

    env.run.of('d').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes('c'));
    expect(env.run.spawnedIds()).not.toContain('b');
  });

  it('is withdrawn by a Stop while no run is under way, so a dependency run on its own does not start it', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { ...AUTORUN_OFF, execute: false });
    await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' });

    const stopped = await env.session.execute({ command: 'stop_run' }, { kind: 'user' });
    expect(stopped).toMatchObject({ ok: true });

    await env.session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' });
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('waits for a dependency started on its own with Run Task, and starts once it finishes', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { ...AUTORUN_OFF, execute: false });
    await env.session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' });

    await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' });

    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(infoNotices(env)).toContain('Task "Task t2" is approved and starts once task "Task t1" finishes.');

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes('t2'));
  });

  // The race the planner turn's start hold exists to prevent (ADR-0029): the turn's edit to t2 would be refused as running.
  it('waits while a planner turn holds new starts, and starts as the turn ends', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { ...AUTORUN_OFF, execute: false });
    await env.session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' });
    await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' });
    void env.session.continueConversation('how is it going?');
    await until(() => env.planner.calls.length === 1);

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1']);

    env.planner.calls[0].finish(prose('It is going well.'));
    await until(() => env.run.spawnedIds().includes('t2'));
  });

  it('starts once a manual dependency is marked complete instead, with no verdict', async () => {
    const env = await supervised([task('t1', 1, { type: 'user' }), task('t2', 2, { dependencies: ['t1'] })], { ...AUTORUN_OFF, execute: false });
    await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' });

    await env.session.execute({ command: 'mark_complete', task: 't1' }, { kind: 'user' });

    await until(() => env.run.spawnedIds().includes('t2'));
  });

  it('starts once its dependency is skipped, and nothing is left pending a start', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { ...AUTORUN_OFF, execute: false });
    await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' });
    expect(env.session.startsPending).toBe(true);

    const skipped = await env.session.execute({ command: 'skip_task', task: 't1' }, { kind: 'user' });
    expect(skipped).toMatchObject({ ok: true });

    await until(() => env.run.spawnedIds().includes('t2'));
    expect(env.run.spawnedIds()).toEqual(['t2']);
    expect(env.session.startsPending).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../models/Task';
import type { ExecutionActor } from '../../models/Execution';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { heldPlanner, NOW, prose, recordingRunner, settled, supervised, task, until, type Env } from './supervisorTestKit';

/**
 * A loop under supervision (ADR-0045): its rounds wake no one and count for
 * no guard, the supervisor hears once when it runs out of rounds, and a
 * saved session resumes it mid-round.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => { vi.useRealTimers(); });

const ACT: ExecutionActor = { kind: 'supervisor', level: 'act' };

const looped = (maxRounds: number): Task[] => [
  task('review', 1, { loop: { body: ['fix'], maxRounds } }),
  task('fix', 2, { dependencies: ['review'] }),
  task('ship', 3, { dependencies: ['review'] }),
];

const spawns = (env: Env, taskId: string) => env.run.spawnedIds().filter((id) => id === taskId).length;

async function finish(env: Env, taskId: string, n: number, status: 'done' | 'failed', summary = `${taskId}: ${status}`): Promise<void> {
  await until(() => spawns(env, taskId) === n);
  env.run.of(taskId).reportComplete({ status, summary, ...(status === 'failed' ? { reason: summary } : {}) });
  await until(() => taskOf(env.session, taskId)?.status === (status === 'done' ? 'completed' : 'failed'));
}

describe('a loop under supervision (ADR-0045)', () => {
  it('wakes an Act supervisor once, when the loop runs out of rounds, and never for a round', async () => {
    const env = await supervised(looped(3), { settings: { supervisorLevel: 'act' } });

    await finish(env, 'review', 1, 'failed', 'Round one finding.');
    await finish(env, 'fix', 1, 'done');
    await finish(env, 'review', 2, 'failed', 'Round two finding.');
    await finish(env, 'fix', 2, 'done');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 2);
    await settled();
    expect(env.planner.calls).toHaveLength(0);
    // Three runs of the check are more than the retry limit allows the supervisor; the loop's are no retries of its.
    expect(env.session.planState!.supervision?.guards).toMatchObject({ retries: {}, failedWith: {} });

    await finish(env, 'review', 3, 'failed', 'Round three finding.');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);

    const update = env.planner.calls[0].message;
    expect(update).toContain('its loop ran out of rounds: it failed all 3');
    expect(update).toContain('Round three finding.');
    expect(update).not.toContain('Round one finding.');
    env.planner.calls[0].finish(prose('The review still fails after three rounds.'));
    await settled();
    expect(env.planner.calls).toHaveLength(1);
    env.session.destroy();
  });

  it('closes a loop a direct edit leaves out of rounds, and wakes its supervisor once', async () => {
    const tasks = [
      task('review', 1, { loop: { body: ['fix', 'fix2'], maxRounds: 3 } }),
      task('fix', 2, { dependencies: ['review'] }),
      task('fix2', 3, { dependencies: ['review', 'fix'] }),
      task('ship', 4, { dependencies: ['review'] }),
    ];
    const env = await supervised(tasks, { settings: { supervisorLevel: 'act' } });
    await finish(env, 'review', 1, 'failed', 'Round one finding.');
    await until(() => spawns(env, 'fix') === 1);

    await env.session.updateTask('review', { loop: { body: ['fix', 'fix2'], maxRounds: 1 } });

    expect(taskOf(env.session, 'fix2')).toMatchObject({ status: 'skipped', skipReason: 'not run: the loop ran out of rounds' });
    await finish(env, 'fix', 1, 'done');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('its loop ran out of rounds: it failed all 1');
    env.session.destroy();
  });

  it('leaves the check between rounds to its loop: the supervisor neither retries nor skips it, and nothing is counted', async () => {
    const env = await supervised(looped(3), { settings: { supervisorLevel: 'act' } });
    await finish(env, 'review', 1, 'failed');

    const retried = await env.session.execute({ command: 'retry_task', task: 'review', from: 'fresh' }, ACT);
    const skipped = await env.session.execute({ command: 'skip_task', task: 'review', reason: 'enough' }, ACT);
    const continued = await env.session.execute({ command: 'retry_task', task: 'review', from: 'session', message: 'look again' }, ACT);

    expect(retried).toMatchObject({ ok: false });
    expect(retried.message).toContain('between rounds of its loop');
    expect(skipped).toMatchObject({ ok: false });
    expect(skipped.message).toContain('between rounds of its loop');
    expect(continued).toMatchObject({ ok: false });
    expect(continued.message).toContain('between rounds of its loop');
    expect(env.session.planState!.supervision?.guards?.retries).toEqual({});
    await finish(env, 'fix', 1, 'done');
    await finish(env, 'review', 2, 'done');
    await until(() => spawns(env, 'ship') === 1);
    env.session.destroy();
  });

  it('sends the report a check owes once a failing body task stops its loop, at any level', async () => {
    const tasks = looped(3);
    tasks[0] = { ...tasks[0], reportTo: { actor: 'planner-turn', consent: { by: 'card' } } };
    const env = await supervised(tasks, { settings: { supervisorLevel: 'off' } });

    await finish(env, 'review', 1, 'failed', 'Round one finding.');
    await finish(env, 'fix', 1, 'failed', 'Could not fix it.');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 3);

    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('Round one finding.');
    expect(taskOf(env.session, 'review')?.reportTo).toBeUndefined();
    env.session.destroy();
  });

  it('refuses the user\'s removal of a loop\'s check, and takes a removed body task out of its loop', async () => {
    const env = await supervised(looped(3), { execute: false });

    await expect(env.session.removeTask('review')).rejects.toThrow('"Task review" is a loop\'s check: remove its body tasks first');
    await env.session.removeTask('fix');

    expect(taskOf(env.session, 'review')?.loop).toBeUndefined();
    env.session.destroy();
  });

  it('takes a loop through the user\'s direct edit, refusing one of the wrong shape', async () => {
    const env = await supervised(looped(3), { execute: false });

    await expect(env.session.updateTask('review', { loop: { body: [], maxRounds: 3 } })).rejects.toThrow('This task has a "loop" with an empty "body"');
    await env.session.updateTask('review', { loop: { body: ['fix'], maxRounds: 5 } });
    expect(taskOf(env.session, 'review')?.loop).toEqual({ body: ['fix'], maxRounds: 5 });
    await env.session.updateTask('review', { loop: null } as unknown as Partial<Task>);
    expect(taskOf(env.session, 'review')?.loop).toBeUndefined();
    env.session.destroy();
  });

  it('resumes a saved session mid-round: Execute runs the body, then the check again, as the next round', async () => {
    const env = await supervised(looped(3));
    await finish(env, 'review', 1, 'failed', 'Found it.');
    await until(() => spawns(env, 'fix') === 1);
    const saved = structuredClone(env.session.planState!);
    env.session.destroy();

    const planner = heldPlanner();
    const run = recordingRunner();
    const session = makeSession({ aiService: planner.aiService, runner: run.runner });
    session.loadPlan(saved, 'build it', testWorkspace);
    expect(taskOf(session, 'review')?.status).toBe('failed');
    expect(await session.execute({ command: 'run_plan' }, { kind: 'user' })).toMatchObject({ ok: true });

    await until(() => run.spawnedIds().includes('fix'));
    expect(run.spawnedIds()).toEqual(['fix']);
    expect(run.runner.spawn.mock.calls[0][0].prompt).toContain('Found it.');
    run.of('fix').reportComplete({ status: 'done', summary: 'fixed' });
    await until(() => run.spawnedIds().includes('review'));
    expect(taskOf(session, 'review')?.loopRound).toBe(2);
    session.destroy();
  });
});

describe('a loop whose check was started by hand (ADR-0045 L5, L7)', () => {
  const USER: ExecutionActor = { kind: 'user' };
  const FIX = 'task #2 "Task fix"';
  const CHECK = 'Task #1 "Task review"';
  const RUNS_ON_ITS_OWN = `${CHECK} is between rounds of its loop: it runs again on its own, as round 2 of 3, once ${FIX} has passed and landed. Leave it to the loop.`;
  const NOTHING_RUNS_IT = `${CHECK} is between rounds of its loop, and nothing runs it on its own now: it can start as round 2 of 3 once ${FIX} has passed and landed.`;

  /** An approved plan never executed: whatever runs, runs from the user's one start. */
  const unrun = (rounds: number, supervisorLevel: 'off' | 'act', autonomousMode = false): Promise<Env> => supervised(looped(rounds), {
    execute: false,
    settings: { supervisorLevel },
    config: { autonomousMode },
  });

  const byHand = async (supervisorLevel: 'off' | 'act' = 'off', autonomousMode = false): Promise<Env> => {
    const env = await unrun(3, supervisorLevel, autonomousMode);
    expect(await env.session.execute({ command: 'run_task', task: 'review' }, USER)).toMatchObject({ ok: true });
    return env;
  };

  /** Stopped between rounds; `fixed` has its body started by hand and landed first. */
  const stranded = async (fixed: boolean, supervisorLevel: 'off' | 'act' = 'off', autonomousMode = false): Promise<Env> => {
    const env = await byHand(supervisorLevel, autonomousMode);
    await finish(env, 'review', 1, 'failed', 'Found it.');
    await until(() => spawns(env, 'fix') === 1);
    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true });
    if (fixed) {
      expect(await env.session.execute({ command: 'run_task', task: 'fix' }, USER)).toMatchObject({ ok: true });
      await finish(env, 'fix', 2, 'done');
      await settled();
    }
    return env;
  };

  it('goes on by itself to the end, waking no one for a round, and starts no dependent', async () => {
    const env = await byHand('act');

    await finish(env, 'review', 1, 'failed', 'Found it.');
    await finish(env, 'fix', 1, 'done');
    await until(() => spawns(env, 'review') === 2);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 2);
    await settled();
    expect(env.planner.calls).toHaveLength(0);
    expect(env.session.planState!.supervision?.guards).toMatchObject({ retries: {}, failedWith: {} });

    await finish(env, 'review', 2, 'done');
    await settled();
    expect(taskOf(env.session, 'review')?.loopRound).toBe(2);
    expect(spawns(env, 'ship')).toBe(0);
    env.session.destroy();
  });

  it('wakes an Act supervisor once, when a loop started by hand runs out of rounds', async () => {
    const env = await unrun(2, 'act');
    await env.session.execute({ command: 'run_task', task: 'review' }, USER);

    await finish(env, 'review', 1, 'failed');
    await finish(env, 'fix', 1, 'done');
    await finish(env, 'review', 2, 'failed', 'Round two finding.');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);

    expect(env.planner.calls[0].message).toContain('its loop ran out of rounds: it failed all 2');
    env.planner.calls[0].finish(prose('It still fails.'));
    await settled();
    env.session.destroy();
  });

  it('refuses a start of the check while the loop will run it, however the check was started, and says so', async () => {
    const env = await byHand();
    await finish(env, 'review', 1, 'failed');
    await until(() => spawns(env, 'fix') === 1);

    const started = await env.session.execute({ command: 'run_task', task: 'review' }, USER);

    expect(started).toMatchObject({ ok: false, message: RUNS_ON_ITS_OWN });
    env.session.destroy();
  });

  it('refuses a start of a check stopped before its body landed by saying what it waits for, not that it runs on its own', async () => {
    const env = await stranded(false);

    const started = await env.session.execute({ command: 'run_task', task: 'review' }, USER);
    const supervised = await env.session.execute({ command: 'retry_task', task: 'review', from: 'fresh' }, ACT);

    expect(started).toMatchObject({ ok: false, message: NOTHING_RUNS_IT });
    expect(supervised).toMatchObject({ ok: false, message: NOTHING_RUNS_IT });
    expect(spawns(env, 'review')).toBe(1);
    env.session.destroy();
  });

  it('says the same of a check whose body is at work with nothing to run it after', async () => {
    const env = await stranded(false);
    await env.session.execute({ command: 'run_task', task: 'fix' }, USER);
    await until(() => spawns(env, 'fix') === 2);

    expect(await env.session.execute({ command: 'run_task', task: 'review' }, USER)).toMatchObject({ ok: false, message: NOTHING_RUNS_IT });
    env.session.destroy();
  });

  it('runs the next round on the user\'s start once the body has landed, keeping the count', async () => {
    const env = await stranded(true);
    expect(spawns(env, 'review')).toBe(1);

    const started = await env.session.execute({ command: 'run_task', task: 'review' }, USER);

    expect(started).toMatchObject({ ok: true, message: 'Started task #1 "Task review", as round 2 of 3.' });
    await until(() => spawns(env, 'review') === 2);
    expect(taskOf(env.session, 'review')).toMatchObject({ status: 'in_progress', loopRound: 2 });
    env.session.destroy();
  });

  it.each([
    ['run_task', { command: 'run_task', task: 'review' }],
    ['retry_task', { command: 'retry_task', task: 'review', from: 'fresh' }],
  ] as const)('runs the next round on an Act supervisor\'s %s, which no guard counts as a retry', async (_, command) => {
    const env = await stranded(true, 'act');

    expect(await env.session.execute(command, ACT)).toMatchObject({ ok: true });

    await until(() => spawns(env, 'review') === 2);
    expect(taskOf(env.session, 'review')?.loopRound).toBe(2);
    expect(env.session.planState!.supervision?.guards?.retries).toEqual({});
    env.session.destroy();
  });

  it('runs the next round on a planner turn\'s start', async () => {
    const env = await stranded(true, 'off', true);

    expect(await env.session.execute({ command: 'run_task', task: 'review' }, { kind: 'planner-turn' })).toMatchObject({ ok: true });

    await until(() => spawns(env, 'review') === 2);
    expect(taskOf(env.session, 'review')?.loopRound).toBe(2);
    env.session.destroy();
  });

  it('refuses to continue a stranded check\'s session, which would start its rounds over, and points at the start that does not', async () => {
    const env = await stranded(true, 'act');

    const continued = await env.session.execute({ command: 'retry_task', task: 'review', from: 'session', message: 'look again' }, ACT);

    expect(continued).toMatchObject({ ok: false, message: `${CHECK} is between rounds of its loop, and nothing runs it on its own now, so a continue would start its rounds over: start it with run_task, which runs round 2 of 3.` });
    env.session.destroy();
  });

  it('lets the supervisor skip a check nothing will run, and refuses only while its loop goes on', async () => {
    const running = await byHand('act');
    await finish(running, 'review', 1, 'failed');
    expect((await running.session.execute({ command: 'skip_task', task: 'review', reason: 'enough' }, ACT)).message).toContain('which goes on by itself');
    running.session.destroy();

    const env = await stranded(true, 'act');
    expect(await env.session.execute({ command: 'skip_task', task: 'review', reason: 'enough' }, ACT)).toMatchObject({ ok: true });
    expect(taskOf(env.session, 'review')?.status).toBe('skipped');
    env.session.destroy();
  });

  it('starts a new set of rounds on the user\'s retry of a check, even one nothing will run (L7)', async () => {
    const env = await stranded(true);

    expect(await env.session.execute({ command: 'retry_task', task: 'review', from: 'fresh' }, USER)).toMatchObject({ ok: true });

    await until(() => spawns(env, 'review') === 2);
    expect(taskOf(env.session, 'review')?.loopRound).toBeUndefined();
    env.session.destroy();
  });

  it('keeps the run stoppable while the loop waits for approval: a Stop ends it, and nothing starts', async () => {
    // Starting the check approves that task alone.
    const env = await supervised(looped(3), { execute: false, plan: { approved: false, approvedTasks: [] } });
    expect(await env.session.execute({ command: 'run_task', task: 'review' }, USER)).toMatchObject({ ok: true });

    await finish(env, 'review', 1, 'failed');
    await settled();
    expect(spawns(env, 'fix')).toBe(0);

    expect(await env.session.execute({ command: 'stop_run' }, USER)).toMatchObject({ ok: true, message: expect.stringContaining('what was about to start will not') });
    expect(await env.session.execute({ command: 'run_task', task: 'fix' }, USER)).toMatchObject({ ok: true });
    await finish(env, 'fix', 1, 'done');
    await settled();
    expect(spawns(env, 'review')).toBe(1);
    env.session.destroy();
  });

  it('after a reload with no run, says what a check waits for, runs its body alone, then continues the count', async () => {
    const env = await byHand();
    await finish(env, 'review', 1, 'failed', 'Found it.');
    await until(() => spawns(env, 'fix') === 1);
    const saved = structuredClone(env.session.planState!);
    env.session.destroy();

    const planner = heldPlanner();
    const run = recordingRunner();
    const session = makeSession({ aiService: planner.aiService, runner: run.runner });
    session.loadPlan(saved, 'build it', testWorkspace);

    expect(await session.execute({ command: 'run_task', task: 'review' }, USER)).toMatchObject({ ok: false, message: NOTHING_RUNS_IT });
    expect(await session.execute({ command: 'run_task', task: 'fix' }, USER)).toMatchObject({ ok: true });
    await until(() => run.spawnedIds().includes('fix'));
    run.of('fix').reportComplete({ status: 'done', summary: 'fixed' });
    await until(() => taskOf(session, 'fix')?.status === 'completed');
    await settled();
    expect(run.spawnedIds()).toEqual(['fix']);

    expect(await session.execute({ command: 'run_task', task: 'review' }, USER)).toMatchObject({ ok: true });
    await until(() => run.spawnedIds().includes('review'));
    expect(taskOf(session, 'review')?.loopRound).toBe(2);
    session.destroy();
  });
});

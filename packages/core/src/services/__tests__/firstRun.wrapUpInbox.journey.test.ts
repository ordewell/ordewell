import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionCommand } from '../ExecutionCommands';
import { EMPTY_RUN, reduceRun } from '../runView';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { FakeWorktreeIsolation } from '../../testing';
import { NOW, prose, settled, supervised, task, until, type Env } from './supervisorTestKit';

/*
 * Machine B's first run (slug wrapUpInbox), supervisor at Watch, merge by hand.
 * The run finished, the planner answered its end-of-run wake-up with a wrap-up,
 * and the footer said something was waiting on the user while /inbox listed
 * only "The planner waits on you": the wrap-up asked nothing a person had to
 * answer. Decided: a reply to the end-of-run wake-up leaves no planner entry;
 * a reply to another wake-up, a failed task's, does, and the user's own run
 * action after it clears it as a typed message does.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// A change to the list goes out at once, and the next within that second when it ends.
const STATUS_WINDOW_MS = 1000;

/** The planner entries in what waits on the user: what the footer counts and /inbox lists. */
const plannerWaits = (env: Env) => env.session.escalations().filter((e) => e.kind === 'planner');
/** The same list as a surface folds it from the stream. */
const streamedPlannerWaits = (env: Env) => (env.messages.reduce((view, m) => reduceRun(view, m), EMPTY_RUN).escalations ?? []).filter((e) => e.kind === 'planner');

const isolated = () => ({ isolation: new FakeWorktreeIsolation(), config: { worktreeIsolation: true }, settings: { supervisorLevel: 'watch' as const } });

describe('machine B, wrapUpInbox: the planner\'s reply to the end-of-run wake-up', () => {
  it('leaves no planner entry in what waits on the user', async () => {
    const env = await supervised([task('t1', 1, { title: 'Add --shout to hello.py' })], isolated());
    env.run.of('t1').reportComplete({ status: 'done', summary: 'Added --shout, with a test.' });
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('the run finished');

    env.planner.calls[0].finish(prose('Task 1 added --shout and its test, and the run is ready to merge with /merge.'));
    await settled();
    await vi.advanceTimersByTimeAsync(STATUS_WINDOW_MS);

    expect(plannerWaits(env)).toEqual([]);
    expect(streamedPlannerWaits(env)).toEqual([]);
  });
});

/**
 * A run of three: #1 lands, #2 fails and #3 waits on it. The planner is woken
 * to #2's failure, which also ends the run, and its reply asks the user what next.
 */
async function failedAndAnswered(): Promise<Env> {
  const env = await supervised([
    task('t1', 1, { title: 'Add --shout to hello.py' }),
    task('t2', 2, { title: 'Test --shout' }),
    task('t3', 3, { title: 'Document --shout', dependencies: ['t2'] }),
  ], isolated());
  await until(() => env.run.spawnedIds().includes('t1') && env.run.spawnedIds().includes('t2'));
  env.run.of('t1').reportComplete({ status: 'done', summary: 'Added --shout.' });
  await settled();
  env.run.of('t2').reportComplete({ status: 'failed', summary: 'The test runner is not installed.', reason: 'pytest is missing' });
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  await until(() => env.planner.calls.length === 1);
  // The same wake-up says the run finished, #3 blocked behind #2: it is still a failure's, not a clean end's.
  expect(env.planner.calls[0].message).toMatch(/task #2 "Test --shout" failed/);

  env.planner.calls[0].finish(prose('Task 2 failed: pytest is missing. Shall I retry it with unittest instead, or skip it?'));
  await settled();
  await vi.advanceTimersByTimeAsync(STATUS_WINDOW_MS);
  return env;
}

describe('machine B, wrapUpInbox: the planner\'s reply to a failed task\'s wake-up', () => {
  it('waits on the user: a planner entry is listed', async () => {
    const env = await failedAndAnswered();

    expect(plannerWaits(env)).toHaveLength(1);
    expect(streamedPlannerWaits(env)).toHaveLength(1);
  });

  it('is cleared by a typed message', async () => {
    const env = await failedAndAnswered();
    expect(plannerWaits(env)).toHaveLength(1);

    void env.session.continueConversation('Skip it.').catch(() => {});
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Skipping task 2 is yours to do: /skip 2.'));
    await settled();
    await vi.advanceTimersByTimeAsync(STATUS_WINDOW_MS);

    expect(plannerWaits(env)).toEqual([]);
  });

  const actions: Array<[string, ExecutionCommand]> = [
    ['merge', { command: 'merge_all' }],
    ['run', { command: 'run_plan' }],
    ['retry', { command: 'retry_task', task: 't2', from: 'fresh' }],
    ['skip', { command: 'skip_task', task: 't2' }],
  ];

  it.each(actions)('is cleared by the user\'s %s after it, as a typed message clears it', async (_name, command) => {
    const env = await failedAndAnswered();
    expect(plannerWaits(env)).toHaveLength(1);

    const outcome = await env.session.execute(command, { kind: 'user' });
    expect(outcome.ok).toBe(true);
    await settled();
    await vi.advanceTimersByTimeAsync(STATUS_WINDOW_MS);

    expect(plannerWaits(env)).toEqual([]);
    expect(streamedPlannerWaits(env)).toEqual([]);
  });
});

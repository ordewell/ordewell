import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupervisorLevel } from '../../models/Execution';
import { EMPTY_RUN, reduceRun } from '../runView';
import { flattenTasks } from '../../models/Task';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { NOW, prose, settled, supervised, task, until, type Env } from './supervisorTestKit';

/**
 * Below Act a wake-up's turn can only talk to the user (ADR-0029), so once
 * nothing is left to run, its reply is where the run stops: the list of what
 * waits on a person (ADR-0053) says so, until the user answers.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// A change to the list goes out at once, and the next within that second when it ends.
const STATUS_WINDOW_MS = 1000;

const streamed = (env: Env) => env.messages.reduce((view, m) => reduceRun(view, m), EMPTY_RUN).escalations;
const plannerWaits = (env: Env) => env.session.escalations().filter((e) => e.kind === 'planner');

/** A one-task run under `level` that has finished, the planner woken for its end and not yet answered. */
async function ended(level: SupervisorLevel): Promise<Env> {
  const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: level } });
  env.run.of('t1').reportComplete({ status: 'done', summary: '' });
  await until(() => env.planner.calls.length === 1);
  expect(env.planner.calls[0].message).toContain('the run finished');
  return env;
}

/** A one-task run under `level` whose task failed, the planner woken for it and not yet answered. */
async function failed(level: SupervisorLevel): Promise<Env> {
  const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: level } });
  env.run.of('t1').reportComplete({ status: 'failed', summary: 'nope', reason: 'nope' });
  await until(() => env.planner.calls.length === 1);
  expect(env.planner.calls[0].message).toContain('failed');
  return env;
}

describe('a planner reply to a wake-up that leaves nothing to run', () => {
  it('is no wait for the reply to a clean end of the run: it is the wrap-up', async () => {
    const env = await ended('watch');
    env.planner.calls[0].finish(prose('Task 1 is done. Shall I plan the fix next?'));
    await settled();

    expect(plannerWaits(env)).toEqual([]);
  });

  it('waits on the user at Watch, and surfaces hear of it as it lands', async () => {
    const env = await failed('watch');
    expect(plannerWaits(env)).toEqual([]);

    env.planner.calls[0].finish(prose('Task 1 failed. Shall I plan the fix next?'));
    await settled();
    await vi.advanceTimersByTimeAsync(STATUS_WINDOW_MS);

    expect(plannerWaits(env)).toEqual([expect.objectContaining({ kind: 'planner', options: [] })]);
    expect(plannerWaits(env)[0].task).toBeUndefined();
    expect(streamed(env)).toEqual(env.session.escalations());
  });

  it('is answered by the user\'s message: gone while the planner works on it, and after', async () => {
    const env = await failed('watch');
    env.planner.calls[0].finish(prose('Task 1 is done. Shall I plan the fix next?'));
    await settled();
    expect(plannerWaits(env)).toHaveLength(1);

    const turn = env.session.continueConversation('Yes, plan it.');
    await until(() => env.planner.calls.length === 2);
    expect(plannerWaits(env)).toEqual([]);
    await vi.advanceTimersByTimeAsync(STATUS_WINDOW_MS);
    expect(streamed(env)).toEqual(env.session.escalations());

    env.planner.calls[1].finish(prose('Here is what I would do.'));
    await turn;
    await vi.advanceTimersByTimeAsync(STATUS_WINDOW_MS);
    expect(plannerWaits(env)).toEqual([]);
    expect(streamed(env)).toEqual(env.session.escalations());
  });

  it('is not listed at Act, where the supervisor carries the run and its tasks escalate their own waits', async () => {
    const env = await ended('act');

    env.planner.calls[0].finish(prose('Task 1 is done; the run is yours to merge.'));
    await settled();

    expect(plannerWaits(env)).toEqual([]);
  });

  it('is not listed for a reply to the user, which waits on them as any chat does', async () => {
    const env = await supervised([task('t1', 1)], { execute: false });

    const turn = env.session.continueConversation('What does task 1 do?');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(prose('It builds the thing.'));
    await turn;
    await settled();

    expect(plannerWaits(env)).toEqual([]);
  });

  // The benchmark's case: a first plan made only of research, below Act.
  it.each(['off', 'watch'] as const)('waits on the user at %s once a research-only plan has reported and its report turn only talks', async (supervisorLevel) => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel } });
    void env.session.continueConversation('Investigate the problem').catch(() => {});
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish({
      kind: 'task_ops',
      ops: [{ op: 'add', task: { order: 1, type: 'ai', sliceType: 'AFK', autonomy: 'AFK', title: 'Scout', description: 'Find the cause.', prompt: 'Investigate', readOnly: true, research: true } }],
      text: '',
      researchLog: [],
    });
    await until(() => env.run.spawnedIds().length === 1);
    const [scout] = flattenTasks(env.session.planTasks).filter((t) => t.research);

    env.run.of(scout.id).reportComplete({ status: 'done', summary: 'Evidence: the cache key omits the tenant.' });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);
    expect(plannerWaits(env)).toEqual([]);

    env.planner.calls[1].finish(prose('The cache key omits the tenant. Shall I plan the fix?'));
    await until(() => !env.session.isPlannerBusy);
    await settled();

    expect(plannerWaits(env)).toHaveLength(1);
  });
});

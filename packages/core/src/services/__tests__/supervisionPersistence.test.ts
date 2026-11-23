import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import { makeSession, saves, testWorkspace } from './sessionTestKit';
import {
  ctx, heldPlanner, NOW, prose, recordingRunner, settled, supervised, task, until, waitForInput, wokenUp,
  type Env, type Options,
} from './supervisorTestKit';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';

/**
 * What supervision remembers has to survive a daemon restart (ADR-0029): the
 * loop guards' memory and the wake-up state not yet delivered. Each test saves
 * the plan mid-run, adopts it in a fresh session, and checks the run carries on
 * as it would have.
 */

const ACT = { settings: { supervisorLevel: 'act' as const } };
const SUPERVISOR = { kind: 'supervisor', level: 'act' } as const;

/** The last plan the session saved, detached, with the session torn down. */
function savedPlan(env: Env) {
  const saved = structuredClone(saves(env.session).mock.calls.at(-1)![0]);
  env.session.destroy();
  return saved;
}

/** A session adopted from `saved`, with a planner whose turns the test answers. */
function reload(saved: ReturnType<typeof savedPlan>) {
  const planner = heldPlanner();
  const run = recordingRunner();
  const restarted = makeSession({ aiService: planner.aiService, runner: run.runner });
  restarted.loadPlan(saved, 'build it', testWorkspace, { sessionId: 'reloaded' });
  return { restarted, planner, run };
}

/** A one-task run whose task failed, with the supervisor woken to it at Act. */
async function failedOnce(over: Options['settings'] = {}): Promise<Env> {
  const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act', ...over } });
  env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
  await until(() => env.planner.calls.length === 1);
  return env;
}

const retryLimitNotes = (history: LegacyPlanState['conversationHistory']) =>
  (history ?? []).filter((e) => e.content.startsWith('Loop guard, retry limit'));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the loop guards memory across a daemon restart', () => {
  it('keeps the retry count, so the limit trips at the same point', async () => {
    const env = await failedOnce({ supervisorRetryLimit: 1 });
    await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx);
    env.planner.calls[0].finish(prose('Retried task 1.'));
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'still wrong' });
    await settled();

    const saved = savedPlan(env);
    expect(saved.supervision!.guards!.retries).toEqual({ t1: 1 });

    const { restarted } = reload(saved);
    expect(restarted.planState!.supervision!.guards!.retries).toEqual({ t1: 1 });

    const again = await restarted.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, SUPERVISOR);

    expect(again).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/^Refused by the retry limit/) });
  });

  it('keeps the oscillation memory, so a re-add after the restart is refused', async () => {
    const env = await wokenUp(ACT, [task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t1'] })]);
    await env.planner.tools().editPlan!({ ops: [
      { op: 'remove', taskId: '#3' },
      { op: 'update', taskId: '#2', changes: { prompt: 'do t2 with Postgres' } },
    ] }, ctx);
    env.planner.calls[0].finish(prose('Dropped task 3; task 2 uses Postgres.'));
    await settled();
    // One more attention event, still inside its window, so the reload has a wake-up to open a turn with.
    await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    waitForInput(env.run.of('t1'));
    await settled();

    const saved = savedPlan(env);
    expect(saved.supervision!.guards!.edits!.removed).toEqual([{ title: 'task t3', prompt: 'do t3' }]);

    const { restarted, planner, run } = reload(saved);
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(planner.calls).toHaveLength(0);
    const resumed = await restarted.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, SUPERVISOR);
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true });
    waitForInput(run.of('t1'));
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => planner.calls.length === 1);

    const readd = await planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Task t3', prompt: 'do t3' } }] }, ctx);

    expect(JSON.parse(readd.text).errors[0].message).toMatch(/^Edit refused: it re-adds "task t3", which you removed earlier this run/);
    expect(restarted.planTasks.find((t) => t.title === 'Task t3')).toBeUndefined();
  });

  it('keeps already-reported trips quiet, so a repeat is not echoed to the user', async () => {
    const env = await failedOnce({ supervisorRetryLimit: 0 });
    const refused = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);
    expect(refused.isError).toBe(true);
    env.planner.calls[0].finish(prose('Task 1 needs you.'));
    await settled();

    const saved = savedPlan(env);
    expect(saved.supervision!.guards!.told).toEqual(['retry-limit:t1']);
    const before = retryLimitNotes(saved.conversationHistory).length;
    expect(before).toBe(1);

    const { restarted } = reload(saved);
    const again = await restarted.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, SUPERVISOR);

    expect(again.ok).toBe(false);
    expect(retryLimitNotes(restarted.planState!.conversationHistory)).toHaveLength(1);
  });
});

describe('a wake-up inside its debounce window across a daemon restart', () => {
  it('stays idle after reload, including after the saved debounce expires', async () => {
    const env = await supervised([task('t1', 1)]);
    waitForInput(env.run.of('t1'));
    await settled();

    const saved = savedPlan(env);
    expect(saved.supervision!.wake!.policy.attention).toHaveLength(1);

    const { planner } = reload(saved);
    await settled();
    expect(planner.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(planner.calls).toHaveLength(0);
  });
});

describe('the wake policy a reload restored (ADR-0029)', () => {
  // Recorded: a reload showed the saved attention and sinceLast emptied, which is the decision: they go out once due, into the waiting inputs.
  it('goes out once due into the waiting inputs, the policy itself left empty and no turn opened', async () => {
    const env = await supervised([task('t1', 1)]);
    waitForInput(env.run.of('t1'));
    await settled();
    const saved = savedPlan(env);
    expect(saved.supervision!.wake!.policy.attention).toHaveLength(1);

    const { restarted, planner } = reload(saved);
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

    expect(planner.calls).toHaveLength(0);
    expect(restarted.planState!.pendingTurns).toEqual([expect.objectContaining({ source: 'supervisor', text: expect.stringContaining('is waiting for input') })]);
    expect(restarted.planState!.supervision!.wake!.policy).toEqual({ attention: [], sinceLast: [] });
  });
});

describe('a user-started run', () => {
  it('still clears the memory a restart restored', async () => {
    const env = await failedOnce({ supervisorRetryLimit: 1 });
    await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx);
    env.planner.calls[0].finish(prose('Retried task 1.'));
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'still wrong' });
    await settled();

    const saved = savedPlan(env);
    const { restarted } = reload(saved);
    expect(restarted.planState!.supervision!.guards!.retries).toEqual({ t1: 1 });

    await restarted.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(restarted.planState!.supervision!.guards!.retries).toEqual({});
  });
});

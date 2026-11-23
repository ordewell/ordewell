import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { ctx, type Env, NOW, prose, settled, supervised, task, until, waitForInput } from './supervisorTestKit';

beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

/** t3 waits for input and wakes the supervisor; t4 keeps running, so no run_held comes: only the catch-up can reach it. */
async function wokenWhileOtherWorkRuns() {
  const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3), task('t4', 4)], { settings: { supervisorLevel: 'act' } });
  await until(() => ['t1', 't3', 't4'].every((id) => env.run.spawnedIds().includes(id)));
  waitForInput(env.run.of('t3'));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  await until(() => env.planner.calls.length === 1);
  return env;
}

async function endTurn(env: Env, text: string) {
  await settled();
  await vi.advanceTimersByTimeAsync(1000);
  await settled();
  env.planner.calls[0].finish(prose(text));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
  await settled();
}

const wakesAbout = (env: Env, what: RegExp) => env.planner.calls.slice(1).filter((c) => what.test(c.message));
const COULD_NOT_START = /Task t1" is on hold \(could not start.*you were not told/s;

it('the supervisor stops a task and starts it again; a hold its failed start leaves is caught up while other work runs', async () => {
  const env = await wokenWhileOtherWorkRuns();

  expect((await env.planner.tools().stopTask!({ task: '1' }, ctx)).isError).toBeFalsy();
  env.run.runner.spawn.mockRejectedValueOnce(new Error('runner binary vanished'));
  expect((await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx)).isError).toBeFalsy();
  await endTurn(env, 'Stopped task 1 and started it again with a better prompt.');

  expect(wakesAbout(env, COULD_NOT_START)).toHaveLength(1);
});

it('the supervisor stops a task and the user starts it; a hold the failed start leaves is caught up all the same', async () => {
  const env = await wokenWhileOtherWorkRuns();

  expect((await env.planner.tools().stopTask!({ task: '1' }, ctx)).isError).toBeFalsy();
  env.run.runner.spawn.mockRejectedValueOnce(new Error('runner binary vanished'));
  expect((await env.session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' })).ok).toBe(true);
  await endTurn(env, 'The user took task 1 back.');

  expect(wakesAbout(env, COULD_NOT_START)).toHaveLength(1);
});

it('the supervisor stops a task and starts it again, and the new attempt fails: it settles, and the supervisor hears of the failure once', async () => {
  const env = await wokenWhileOtherWorkRuns();

  expect((await env.planner.tools().stopTask!({ task: '1' }, ctx)).isError).toBeFalsy();
  expect((await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx)).isError).toBeFalsy();
  await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
  env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the second try broke too' });
  await endTurn(env, 'Stopped task 1 and started it again.');

  expect(wakesAbout(env, /Task t1" failed: .*the second try broke too/s)).toHaveLength(1);
});

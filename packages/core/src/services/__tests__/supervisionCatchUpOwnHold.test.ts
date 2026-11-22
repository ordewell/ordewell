import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { ctx, NOW, prose, settled, supervised, task, until, waitForInput } from './supervisorTestKit';

beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

it('the supervisor stops a task in its turn while other work runs; it is not woken about its own stop as untold', async () => {
  const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3), task('t4', 4)], { settings: { supervisorLevel: 'act' } });
  await until(() => ['t1', 't3', 't4'].every((id) => env.run.spawnedIds().includes(id)));
  waitForInput(env.run.of('t3'));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  await until(() => env.planner.calls.length === 1);

  expect((await env.planner.tools().stopTask!({ task: '1' }, ctx)).isError).toBeFalsy();
  env.planner.calls[0].finish(prose('Stopped task 1: its approach is wrong, I will ask the user. Task 3 waits for them too.'));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
  await settled();

  expect(env.planner.calls.slice(1).filter((c) => /Task t1" is on hold.*you were not told/.test(c.message))).toEqual([]);
});

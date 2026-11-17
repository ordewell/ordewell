import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAKE_UP_RATE } from '../LoopGuards';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { PLANNER_EXECUTION_TOOLS } from '../mcp/tools';
import { ctx, NOW, prose, settled, supervised, task, until, waitForInput, type Env, type Options } from './supervisorTestKit';

/**
 * A run idle behind a held task (ADR-0057 R4): nothing runs, nothing can
 * start, and what holds the rest is a task on hold or waiting on a person. The
 * supervisor is woken to it once for each distinct set of holding tasks.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Task 1 waits for input, and tasks 2 and 3 need it: the supervisor is in its first wake-up turn on it. */
async function waitingChain(options: Options = {}): Promise<Env> {
  const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'act' }, ...options });
  waitForInput(env.run.of('t1'));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  await until(() => env.planner.calls.length === 1);
  return env;
}

/** The supervisor stops task 1 and edits the prompts after it, and ends its turn without retrying it. */
async function stopsWithoutRetry(env: Env, turn = 0): Promise<void> {
  expect((await env.planner.tools().stopTask!({ task: '1' }, ctx)).isError).toBeFalsy();
  const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2 without the cache' } }] }, ctx);
  expect(edit.isError, edit.text).toBeFalsy();
  env.planner.calls[turn].finish(prose('Stopped task 1 and rewrote the tasks after it.'));
  await settled();
}

describe('a run left idle behind a task the supervisor stopped, at Act', () => {
  it('wakes the supervisor again, naming the hold, who put it there and what it holds back', async () => {
    const env = await waitingChain();

    await stopsWithoutRetry(env);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);

    expect(env.planner.calls[1].message).toContain(
      'the run is idle: nothing is running and nothing can start. Task #1 "Task t1" is on hold (cancelled; retry or force start to run it again), put there by the supervisor, and holds back 2 tasks.',
    );
  });

  it('is not woken a third time by a turn that leaves the same hold in place', async () => {
    const env = await waitingChain();
    await stopsWithoutRetry(env);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);

    env.planner.calls[1].finish(prose('Task 1 stays stopped; it needs the user.'));
    await settled();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(env.planner.calls).toHaveLength(2);
  });

  // A second `ordewell run --unattended` joins the open run: its follower, at Act, waits for a supervisor turn to end.
  it('wakes it once more when the user executes the plan again on the same hold', async () => {
    const env = await waitingChain();
    await stopsWithoutRetry(env);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Task 1 stays stopped; it needs the user.'));
    await settled();

    const joined = await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(joined.ok, joined.message).toBe(true);
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 3);
    expect(env.planner.calls[2].message).toContain('the run is idle: nothing is running and nothing can start. Task #1 "Task t1" is on hold');

    env.planner.calls[2].finish(prose('Still stopped.'));
    await settled();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(env.planner.calls).toHaveLength(3);
  });

  it('counts the wake against the wake-up rate guard, as any other', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'act' } });
    for (let i = 0; i < WAKE_UP_RATE.max; i++) {
      waitForInput(env.run.of('t1'));
      await settled();
      await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
      await until(() => env.planner.calls.length === i + 1);
      if (i === WAKE_UP_RATE.max - 1) break;
      env.planner.calls[i].finish(prose('Answered task 1.'));
      await settled();
      await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    }
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('act');

    await stopsWithoutRetry(env, WAKE_UP_RATE.max - 1);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === WAKE_UP_RATE.max + 1);

    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('watch');
  });
});

describe('what the supervisor is told stop_task leaves behind', () => {
  const holds = 'A task you stop stays on hold, and every task that depends on it waits, until it is retried or skipped';
  const retried = 'retry it in the same reply';

  it('says so in the Act brief', async () => {
    const env = await waitingChain();

    expect(env.planner.calls[0].message).toContain(holds);
    expect(env.planner.calls[0].message).toContain(`To change a stopped task's prompt and run it again, call edit_plan and then ${retried}`);
  });

  it('says so in the stop_task tool\'s description', () => {
    const description = PLANNER_EXECUTION_TOOLS.find((t) => t.name === 'stop_task')!.description;

    expect(description).toContain('blocking every task that depends on it, until it is retried, force started or skipped');
    expect(description).toContain(`After changing its prompt with edit_plan, ${retried}`);
  });
});

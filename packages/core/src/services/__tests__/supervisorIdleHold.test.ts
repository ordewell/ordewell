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

/**
 * A wake-up turn at Act that ends with the failure it was woken for still
 * standing, and work waiting on it, while another task runs (ADR-0057 R4): the
 * run is not idle, so only this wakes the supervisor again, once.
 */
describe('a blocking failure a turn left standing, at Act', () => {
  /** Task 1 failed with tasks 2 and 3 waiting on it while task 4 runs, and the supervisor is in its first turn on it. */
  async function failedWhileOthersRun(): Promise<Env> {
    const env = await supervised(
      [task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t1'] }), task('t4', 4)],
      { settings: { supervisorLevel: 'act' } },
    );
    await until(() => env.run.spawnedIds().includes('t4'));
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);
    return env;
  }

  const STANDING = 'Task #1 "Task t1" is still failed after your turn, and 2 tasks wait on it. Release it: call retry_task from "fresh" with a message, your note on what to do differently, or edit it with edit_plan and call retry_task in the same reply; or skip_task it with your reason; or tell the user.';

  it('wakes the supervisor once more right after a turn that edited the task and did not retry it', async () => {
    const env = await failedWhileOthersRun();
    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);
    env.planner.calls[0].finish(prose('Rewrote task 1.'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);

    expect(env.planner.calls[1].message).toContain(`- ${STANDING}`);
  });

  it('wakes it only once for the same failure', async () => {
    const env = await failedWhileOthersRun();
    env.planner.calls[0].finish(prose('Task 1 failed; leaving it.'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);

    env.planner.calls[1].finish(prose('Still leaving it.'));
    await settled();
    // Task 4 running on wakes the supervisor for itself, and those turns leave task 1 failed too.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      for (const call of env.planner.calls.slice(2)) call.finish(prose('Noted.'));
      await settled();
    }

    expect(env.planner.calls.filter((c) => c.message.includes('is still failed after your turn'))).toHaveLength(1);
  });

  it.each([
    ['retried', (env: Env) => env.planner.tools().retryTask!({ task: '1', from: 'fresh', message: 'Import from ./lib.' }, ctx)],
    ['skipped', (env: Env) => env.planner.tools().skipTask!({ task: '1', reason: 'not needed' }, ctx)],
  ])('does not wake it again after a turn that %s the task', async (_what, act) => {
    const env = await failedWhileOthersRun();
    expect((await act(env)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Handled task 1.'));
    await settled();
    await vi.advanceTimersByTimeAsync(10 * WAKE_DEBOUNCE_MS);

    expect(env.planner.calls).toHaveLength(1);
  });

  it('answers an edit of the failed task\'s prompt saying it is still failed and needs retry_task', async () => {
    const env = await failedWhileOthersRun();

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);

    expect(JSON.parse(edit.text).warnings).toContain('Task #1 "Task t1" is still failed: an edit starts nothing, so call retry_task to run it as edited.');
  });
});

/**
 * A task the supervisor stopped is on hold, not failed: the wake after its turn
 * tells it to retry with a note, so a note retry of it is accepted (ADR-0029).
 */
describe('a task the supervisor stopped, left standing at Act', () => {
  /** Task 1 waits for input with tasks 2 and 3 on it while task 4 runs; the supervisor stops it and ends its turn, and is woken again. */
  async function stoppedWhileOthersRun(): Promise<Env> {
    const env = await supervised(
      [task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t1'] }), task('t4', 4)],
      { settings: { supervisorLevel: 'act' } },
    );
    await until(() => env.run.spawnedIds().includes('t4'));
    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);
    expect((await env.planner.tools().stopTask!({ task: '1' }, ctx)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Stopped task 1.'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);
    return env;
  }

  it('retries it with the note the wake told it to give, and the runner reads the note', async () => {
    const env = await stoppedWhileOthersRun();
    expect(env.planner.calls[1].message).toContain('Task #1 "Task t1" is still on hold');

    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh', message: 'Use ./lib.' }, ctx);

    expect(retry.isError, retry.text).toBeFalsy();
    env.planner.calls[1].finish(prose('Retried task 1 with a note.'));
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
    const spawns = env.run.runner.spawn.mock.calls.filter(([options]) => options.taskId === 't1');
    expect(spawns[1][0].prompt).toContain('## The supervisor\'s note for this attempt\n\nThe last attempt at this task ended without passing, and the supervisor retried it with this note for this attempt. The task below is unchanged; read the note as a correction to how you go about it:\n\nUse ./lib.');
  });
});

/**
 * `ordewell run --unattended` at Act ends on a person's wait that still stands
 * 2 seconds after a supervisor turn with none open, so the turn owed for a wait
 * the last turn left standing must open within that.
 */
describe('a wait on a person left standing by a turn at Act', () => {
  it('opens the turn owed for it at once, with no merge window', async () => {
    const env = await supervised(
      [task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t1'] }), task('t4', 4)],
      { settings: { supervisorLevel: 'act' } },
    );
    await until(() => env.run.spawnedIds().includes('t4'));
    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);

    env.planner.calls[0].finish(prose('Task 1 needs the user; telling them.'));
    await settled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(env.planner.calls).toHaveLength(2);
    expect(env.planner.calls[1].message).toContain('Task #1 "Task t1" is still waiting for input after your turn');
  });
});

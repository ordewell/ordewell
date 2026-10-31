import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, plan, settled, supervised, task, until, type Env } from './supervisorTestKit';
import { fakeConfig, FakeRunnerSession, makeSession, saves, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import type { SessionMessage } from '../SessionMessage';
import type { UsageRecord } from '../../models/Usage';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const usage: UsageRecord = { source: 'claude-code', inputTokens: 10, outputTokens: 5 };
const statuses = (messages: SessionMessage[]) => messages.filter((m) => m.type === 'status_update');
const reportUsage = (env: Env, taskId: string) => env.run.of(taskId).emitEvent({ type: 'usage', record: usage });
/** A plan wide enough that one judgement per task reads as many: every task runs at once. */
const wide = (n: number) => Array.from({ length: n }, (_, i) => task(`t${i + 1}`, i + 1));

describe('a tick', () => {
  it('says what it held back in one line, whatever the plan holds', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chain = Array.from({ length: 30 }, (_, i) => task(`t${i + 1}`, i + 1, { dependencies: i === 0 ? [] : [`t${i}`] }));

    const env = await supervised(chain);
    await until(() => env.run.spawnedIds().length === 1);

    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('excluded'));
    log.mockRestore();
    expect(lines).toEqual(['[TaskOrchestrator] excluded: 29 (dependencies 29)']);
  });
});

describe('starting a fan-out', () => {
  /** A runner whose starts hang until the test lets each through, as one attaching does. */
  function attachingRunner() {
    const started: string[] = [];
    const waiting = new Map<string, () => void>();
    const spawn = vi.fn(({ taskId }: { taskId: string }) => new Promise<FakeRunnerSession>((resolve) => {
      started.push(taskId);
      waiting.set(taskId, () => resolve(new FakeRunnerSession(`s-${taskId}`, taskId)));
    }));
    return { runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 }, started, attach: (taskId: string) => waiting.get(taskId)?.() };
  }

  it('waits for no more than eight runners to attach at once, and starts the next as one does', async () => {
    const { runner, started, attach } = attachingRunner();
    const session = makeSession({ runner, config: fakeConfig({ maxParallelSessions: 12 }) });
    session.loadPlan(plan(wide(12)), 'build it', testWorkspace);

    void session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => started.length === 8);
    await settled();
    expect(started).toHaveLength(8);

    attach(started[0]);
    await until(() => started.length === 9);
    expect(started).toEqual(wide(9).map((t) => t.id));
  });
});

describe('a status update', () => {
  describe('coalesced to about one a second', () => {
    /** A run past its opening burst, with the status window that burst opened closed. */
    async function quietRun(tasks = [task('t1', 1), task('t2', 2)]) {
      const env = await supervised(tasks, { config: { maxParallelSessions: tasks.length } });
      await until(() => env.run.spawnedIds().length === tasks.length);
      await vi.advanceTimersByTimeAsync(2000);
      env.messages.length = 0;
      return env;
    }

    it('sends a burst of usage as the first report and one more at the end of the second', async () => {
      const env = await quietRun();

      for (let i = 0; i < 50; i++) reportUsage(env, 't1');
      expect(statuses(env.messages)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(statuses(env.messages)).toHaveLength(2);
      const [, last] = statuses(env.messages);
      expect(last.type === 'status_update' && last.usage?.totals.inputTokens).toBe(500);

      await vi.advanceTimersByTimeAsync(5000);
      expect(statuses(env.messages)).toHaveLength(2);
    });

    it('sends a task that needs a person at once, inside the second', async () => {
      const env = await quietRun();
      reportUsage(env, 't1');
      env.messages.length = 0;

      env.run.of('t2').waitForInput();
      await settled();

      const [update] = statuses(env.messages);
      expect(update?.type === 'status_update' && update.tasks.find((t) => t.id === 't2')?.status).toBe('awaiting_user');
    });

    it('sends a failure at once, inside the second', async () => {
      const env = await quietRun();
      reportUsage(env, 't1');
      env.messages.length = 0;

      env.run.of('t2').reportComplete({ status: 'failed', summary: 'no' });
      await settled();

      const [update] = statuses(env.messages);
      expect(update?.type === 'status_update' && update.tasks.find((t) => t.id === 't2')?.status).toBe('failed');
    });

    it('sends a wave of tasks waiting on a person at the same pace, and every wait by the end of the second', async () => {
      const tasks = wide(20);
      const env = await quietRun(tasks);
      reportUsage(env, 't1');
      env.messages.length = 0;

      for (const { id } of tasks) env.run.of(id).waitForInput();
      await settled();
      expect(statuses(env.messages)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(statuses(env.messages)).toHaveLength(2);
      const last = statuses(env.messages).at(-1);
      expect(last?.type === 'status_update' && last.escalations).toHaveLength(20);
    });

    it('sends the fan-out of a run as a status or so a second, not one per start', async () => {
      const env = await supervised(wide(20), { execute: false, config: { maxParallelSessions: 20 } });
      await vi.advanceTimersByTimeAsync(2000);
      env.messages.length = 0;

      await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
      await until(() => env.run.spawnedIds().length === 20);

      expect(statuses(env.messages).length).toBeLessThan(6);
    });

    it('sends the landings of a run in worktrees as a status or so a second, not one per report', async () => {
      const env = await supervised(wide(20), { isolation: new FakeWorktreeIsolation(), config: { maxParallelSessions: 20 } });
      await until(() => env.run.spawnedIds().length === 20);
      await vi.advanceTimersByTimeAsync(2000);
      env.messages.length = 0;

      for (const { id } of wide(20)) env.run.of(id).reportComplete({ status: 'done', summary: 'ok' });
      await until(() => env.messages.some((m) => m.type === 'execution_complete'));

      expect(statuses(env.messages).length).toBeLessThan(6);
      const last = statuses(env.messages).at(-1);
      expect(last?.type === 'status_update' && last.tasks.map((t) => t.status)).toEqual(wide(20).map(() => 'completed'));
      expect(last?.type === 'status_update' && last.runMerge?.landed).toHaveLength(20);
    });

    it('never leaves the end of a run behind execution_complete', async () => {
      const env = await quietRun();
      reportUsage(env, 't1');
      env.run.of('t1').reportComplete({ status: 'done', summary: 'ok' });
      await settled();
      reportUsage(env, 't2');
      env.messages.length = 0;

      env.run.of('t2').reportComplete({ status: 'done', summary: 'ok' });
      await until(() => env.messages.some((m) => m.type === 'execution_complete'));

      const types = env.messages.map((m) => m.type);
      const last = env.messages[types.lastIndexOf('status_update')];
      expect(types.lastIndexOf('status_update')).toBeLessThan(types.indexOf('execution_complete'));
      expect(last.type === 'status_update' && last.tasks.map((t) => t.status)).toEqual(['completed', 'completed']);
    });

    it('sends what it held back when the session closes, and nothing after', async () => {
      const env = await quietRun();
      reportUsage(env, 't1');
      reportUsage(env, 't1');
      env.messages.length = 0;

      env.session.destroy();
      const closing = statuses(env.messages).length;
      await vi.advanceTimersByTimeAsync(5000);

      expect(statuses(env.messages)).toHaveLength(closing);
    });
  });
});

describe('saving', () => {
  const statusesSaved = (env: Env) => saves(env.session).mock.calls.map(([saved]) => saved.tasks.map((t) => t.status));

  async function running() {
    const env = await supervised([task('t1', 1), task('t2', 2)], { config: { maxParallelSessions: 2 } });
    await until(() => env.run.spawnedIds().length === 2);
    await vi.advanceTimersByTimeAsync(10_000);
    saves(env.session).mockClear();
    return env;
  }

  it('makes no save per usage event: the timer makes one for the lot', async () => {
    const env = await running();

    for (let i = 0; i < 40; i++) reportUsage(env, 't1');
    expect(saves(env.session)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(saves(env.session)).toHaveBeenCalledTimes(1);
    expect(saves(env.session).mock.calls[0][0].tasks[0].attemptUsage?.[0].totals.inputTokens).toBe(400);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(saves(env.session)).toHaveBeenCalledTimes(1);
  });

  it('saves a status change at once, with no usage to carry it', async () => {
    const env = await running();

    env.run.of('t2').waitForInput();
    await settled();

    expect(statusesSaved(env).at(-1)).toEqual(['in_progress', 'awaiting_user']);
  });

  it('saves a start at once', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await until(() => env.run.spawnedIds().length === 1);
    env.run.of('t1').reportComplete({ status: 'done', summary: 'ok' });
    await until(() => env.run.spawnedIds().length === 2);

    expect(statusesSaved(env).at(-1)).toEqual(['completed', 'in_progress']);
  });

  it('a crash between timer saves loses usage, and no decision', async () => {
    const env = await running();
    reportUsage(env, 't1');
    await vi.advanceTimersByTimeAsync(5000);
    const usageBefore = saves(env.session).mock.lastCall![0].tasks[0].attemptUsage?.[0].totals.inputTokens;

    reportUsage(env, 't1');
    reportUsage(env, 't2');
    env.run.of('t2').reportComplete({ status: 'done', summary: 'the work is in' });
    await settled();
    reportUsage(env, 't1');

    // The process dies here: what the disk has is the last save, taken apart from the live plan.
    const onDisk = structuredClone(saves(env.session).mock.lastCall![0]);
    expect(onDisk.tasks.map((t) => t.status)).toEqual(['in_progress', 'completed']);
    expect(onDisk.tasks[1].verdict?.outcome).toBe('pass');
    const live = env.session.planTasks[0].attemptUsage?.[0].totals.inputTokens;
    expect(live).toBe(30);
    expect(onDisk.tasks[0].attemptUsage?.[0].totals.inputTokens).toBeGreaterThanOrEqual(usageBefore ?? 0);
    expect(onDisk.tasks[0].attemptUsage?.[0].totals.inputTokens).toBeLessThan(live ?? 0);
  });

  it('a timer save that fails is logged and leaves the run going', async () => {
    const env = await running();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    saves(env.session).mockImplementationOnce(() => { throw new Error('disk full'); });

    reportUsage(env, 't1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    reportUsage(env, 't1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves(env.session).mock.lastCall![0].tasks[0].attemptUsage?.[0].totals.inputTokens).toBe(20);
  });

  it('saves what the timer owes when the session closes', async () => {
    const env = await running();
    reportUsage(env, 't1');

    env.session.destroy();

    expect(saves(env.session).mock.lastCall![0].tasks[0].attemptUsage?.[0].totals.inputTokens).toBe(10);
  });

  it('saves what the timer owes before the plan is left for another', async () => {
    const env = await running();
    reportUsage(env, 't1');

    env.session.reset();

    expect(saves(env.session).mock.calls.at(0)![0].tasks[0].attemptUsage?.[0].totals.inputTokens).toBe(10);
  });

  describe('on a disk that refuses every save', () => {
    /** A run owing the timer's save, with every save from here on failing. */
    async function refused() {
      const env = await running();
      reportUsage(env, 't1');
      saves(env.session).mockImplementation(() => { throw new Error('disk full'); });
      env.messages.length = 0;
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      return { env, logged };
    }

    it('still stops the run on the user\'s Stop, says so, and logs the save', async () => {
      const { env, logged } = await refused();

      env.session.stopExecution();
      await settled();

      expect(logged).toHaveBeenCalledWith('[Session] save failed:', expect.any(Error));
      logged.mockRestore();
      expect(env.session.activity.running).toBe(false);
      expect(env.messages.map((m) => m.type)).toContain('execution_stopped');
      expect(env.session.planTasks.map((t) => t.status)).not.toContain('in_progress');
    });

    it('still closes the session, its run and its observer', async () => {
      const { env, logged } = await refused();

      expect(() => env.session.destroy()).not.toThrow();
      await settled();

      expect(logged).toHaveBeenCalledWith('[Session] save failed:', expect.any(Error));
      logged.mockRestore();
      expect(env.session.activity.running).toBe(false);
      env.messages.length = 0;
      reportUsage(env, 't1');
      expect(env.messages).toEqual([]);
    });

    it('still leaves the plan on a new session', async () => {
      const { env, logged } = await refused();

      expect(() => env.session.reset()).not.toThrow();
      await settled();
      logged.mockRestore();

      expect(env.session.activity.running).toBe(false);
      expect(env.session.planState).toBeNull();
      expect(env.session.planTasks).toEqual([]);
    });

    it('still leaves the plan for another', async () => {
      const { env, logged } = await refused();
      const other = plan([task('other', 1)]);

      expect(() => env.session.loadPlan(other, 'another goal', testWorkspace, { persist: false })).not.toThrow();
      await settled();
      logged.mockRestore();

      expect(env.session.activity.running).toBe(false);
      expect(env.session.planTasks.map((t) => t.id)).toEqual(['other']);
    });
  });
});

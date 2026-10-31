import { describe, it, expect, vi, afterEach } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { TaskControlError } from '../TaskControlError';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';

/**
 * What "a flat run does not change" means for the lease and the pool (ADR-0059
 * L4, ADR-0055 D18): for each Parallel limit, what a plan starts, in what order,
 * what a full session answers, and what waits. Every answer is written out, and
 * this file passed against the scheduler as it stood before the lease went in,
 * when it read `attempts.size` and nothing else. None is worked out by the code
 * under test.
 */

const fullWords = (live: number) => `${live} ${live === 1 ? 'task is' : 'tasks are'} already running, the most this session runs at once. Wait for one to finish, or stop one first.`;

function setup(maxParallelSessions: number, isolation = new FakeWorktreeIsolation()) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${opts.taskId}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions, conflictRepairAttempts: 1 }),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const started = () => spawn.mock.calls.map(([o]) => o.taskId);
  const session = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  return { orchestrator, notifications, started, session, isolation };
}

const task = (id: string, order: number, over: Partial<Task> = {}) => createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });
const plan = (ids: readonly string[]) => ids.map((id, i) => task(id, i + 1));
const words = (mock: unknown) => vi.mocked(mock as (message: string) => void).mock.calls.flat().join('\n');

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) await flushMicrotasks();
  expect(condition()).toBe(true);
}

const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";

interface Row {
  limit: number;
  tasks: readonly string[];
  /** What is running once the run has started, in the order it started. */
  running: readonly string[];
  /** What is running once the first of them has passed. */
  afterOne: readonly string[];
  /** Started by the end, with every task passed in turn. */
  order: readonly string[];
}

const ROWS: readonly Row[] = [
  { limit: 1, tasks: ['a'], running: ['a'], afterOne: [], order: ['a'] },
  { limit: 1, tasks: ['a', 'b', 'c'], running: ['a'], afterOne: ['b'], order: ['a', 'b', 'c'] },
  { limit: 2, tasks: ['a'], running: ['a'], afterOne: [], order: ['a'] },
  { limit: 2, tasks: ['a', 'b', 'c'], running: ['a', 'b'], afterOne: ['b', 'c'], order: ['a', 'b', 'c'] },
  { limit: 2, tasks: ['a', 'b', 'c', 'd'], running: ['a', 'b'], afterOne: ['b', 'c'], order: ['a', 'b', 'c', 'd'] },
  { limit: 3, tasks: ['a', 'b', 'c'], running: ['a', 'b', 'c'], afterOne: ['b', 'c'], order: ['a', 'b', 'c'] },
  { limit: 3, tasks: ['a', 'b', 'c', 'd', 'e'], running: ['a', 'b', 'c'], afterOne: ['b', 'c', 'd'], order: ['a', 'b', 'c', 'd', 'e'] },
  { limit: 5, tasks: ['a', 'b', 'c'], running: ['a', 'b', 'c'], afterOne: ['b', 'c'], order: ['a', 'b', 'c'] },
  { limit: 8, tasks: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], running: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], afterOne: ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], order: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
];

describe('a flat run starts what its Parallel limit lets it (ADR-0030)', () => {
  for (const { limit, tasks, running, afterOne, order } of ROWS) {
    it(`Parallel ${limit}, ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`, async () => {
      const env = setup(limit);
      env.orchestrator.loadPlan(plan(tasks));
      await env.orchestrator.approveReview();

      await until(() => env.started().length >= running.length);
      expect(env.orchestrator.activeTaskIds).toEqual(running);

      env.session(tasks[0]).reportComplete({ status: 'done', summary: '' });
      await until(() => env.orchestrator.storeInstance.get(tasks[0])?.status === 'completed');
      await until(() => env.orchestrator.activeTaskIds.length === afterOne.length);
      expect(env.orchestrator.activeTaskIds).toEqual(afterOne);

      for (const id of tasks.slice(1)) {
        await until(() => env.orchestrator.activeTaskIds.includes(id));
        env.session(id).reportComplete({ status: 'done', summary: '' });
        await until(() => env.orchestrator.storeInstance.get(id)?.status === 'completed');
      }
      expect(env.started()).toEqual(order);
      await until(() => env.orchestrator.status === 'completed');
    });
  }
});

describe('a full flat session answers what it always answered', () => {
  for (const limit of [1, 2, 3, 5]) {
    it(`Parallel ${limit}: a force start is refused in so many words, and nothing changes`, async () => {
      const ids = Array.from({ length: limit + 1 }, (_, i) => `t${i + 1}`);
      const env = setup(limit);
      env.orchestrator.loadPlan(plan(ids));
      for (const id of ids.slice(0, limit)) await env.orchestrator.forceStartTask(id);

      const refused = await env.orchestrator.forceStartTask(ids[limit]).catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(TaskControlError);
      expect((refused as Error).message).toBe(fullWords(limit));
      expect(env.started()).toEqual(ids.slice(0, limit));
      expect(env.orchestrator.storeInstance.get(ids[limit])?.status).toBe('pending');
    });

    it(`Parallel ${limit}: the same refusal holds a resume asked for by hand, and the wait goes on`, async () => {
      vi.useFakeTimers({ now: new Date('2026-10-11T17:00:00Z') });
      const ids = Array.from({ length: limit }, (_, i) => `t${i + 1}`);
      const env = setup(limit);
      env.orchestrator.loadPlan([...plan(ids), { ...task('paused', limit + 1), status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2026-10-11T20:11:00.000Z', runnerSessionId: 'native-paused' }]);
      for (const id of ids) await env.orchestrator.forceStartTask(id);

      await expect(env.orchestrator.resumeNow('paused', 'user')).rejects.toThrow(fullWords(limit));

      expect(env.orchestrator.storeInstance.get('paused')).toMatchObject({ status: 'awaiting_user', resumeAt: '2026-10-11T20:11:00.000Z' });
    });
  }
  afterEach(() => { vi.useRealTimers(); });
});

describe('what waits for a slot in a flat run, by Parallel limit', () => {
  afterEach(() => { vi.useRealTimers(); });

  for (const limit of [1, 2, 3]) {
    it(`Parallel ${limit}: a resume at its reset with no slot drops to the user, as it always did`, async () => {
      vi.useFakeTimers({ now: new Date('2026-10-11T17:00:00Z') });
      const others = Array.from({ length: limit }, (_, i) => `t${i + 1}`);
      const env = setup(limit);
      env.orchestrator.loadPlan([task('limited', 1), ...others.map((id, i) => task(id, i + 2))]);
      await env.orchestrator.forceStartTask('limited');
      const session = env.session('limited');
      session.emitEvent({ type: 'error', message: LIMIT });
      session.emitOutput(`${LIMIT}\n`);
      session.emitTurnEnd('failed');
      await until(() => env.orchestrator.storeInstance.get('limited')?.resumeAt !== undefined);
      for (const id of others) await env.orchestrator.forceStartTask(id);

      await vi.advanceTimersByTimeAsync(Date.parse(env.orchestrator.storeInstance.get('limited')!.resumeAt!) - Date.now());
      await until(() => env.orchestrator.storeInstance.get('limited')?.resumeAt === undefined);

      expect(env.orchestrator.storeInstance.get('limited')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' });
      expect(words(env.notifications.warn)).toContain(`Task "Task limited" did not resume at its usage limit's reset: ${fullWords(limit)} Resume it once it can start.`);
      expect(env.started().filter((id) => id === 'limited')).toHaveLength(1);
    });
  }

  for (const limit of [1, 2]) {
    it(`Parallel ${limit}: a repair owed outside a scheduled run waits for a slot, then starts`, async () => {
      const others = Array.from({ length: limit }, (_, i) => `o${i + 1}`);
      const isolation = new FakeWorktreeIsolation();
      isolation.outcomes.set('t1', 'conflict');
      const env = setup(limit, isolation);
      env.orchestrator.loadPlan([task('t1', 1), ...others.map((id, i) => task(id, i + 2))]);
      await env.orchestrator.forceStartTask('t1');
      for (const id of others.slice(0, limit - 1)) await env.orchestrator.forceStartTask(id);
      env.session('t1').emitExit(1);
      await until(() => env.orchestrator.storeInstance.get('t1')?.status === 'failed');
      await env.orchestrator.forceStartTask(others[limit - 1]);
      expect(env.orchestrator.activeTaskIds).toHaveLength(limit);

      await env.orchestrator.markTaskComplete('t1');
      expect(words(env.notifications.info)).toContain('Task "Task t1" is repaired once a slot is free.');
      expect(env.orchestrator.activeTaskIds).toEqual(others);

      env.session(others[0]).reportComplete({ status: 'done', summary: '' });
      await until(() => env.orchestrator.activeTaskIds.includes('t1'));
    });
  }
});

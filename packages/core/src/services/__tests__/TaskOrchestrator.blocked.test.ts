import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/** Spawns {@link FakeRunnerSession}s the test settles by task id. */
function setup(tasks: Task[]) {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: false }),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const executionComplete = vi.fn();
  orchestrator.subscribe({ onExecutionComplete: executionComplete });
  orchestrator.loadPlan(tasks);
  const spawned = (): string[] => runner.spawn.mock.calls.map(([o]) => o.taskId);
  const latest = (taskId: string): FakeRunnerSession => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const status = (taskId: string): string | undefined => orchestrator.storeInstance.get(taskId)?.status;
  const pass = async (taskId: string): Promise<void> => {
    await vi.waitFor(() => expect(spawned()).toContain(taskId));
    latest(taskId).reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(status(taskId)).toBe('completed'));
  };
  const fail = async (taskId: string): Promise<void> => {
    await vi.waitFor(() => expect(spawned()).toContain(taskId));
    latest(taskId).reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(status(taskId)).toBe('failed'));
  };
  return { orchestrator, notifications, spawned, status, pass, fail, executionComplete };
}

const task = (id: string, order: number, dependencies: string[] = []): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, dependencies });

/** Two chains that share nothing: a1 → a2 → a3 and b1 → b2. */
const twoChains = (): Task[] => [task('a1', 1), task('a2', 2, ['a1']), task('a3', 3, ['a2']), task('b1', 4), task('b2', 5, ['b1'])];

describe('a failed task blocks only its dependents', () => {
  it('lets the independent chain finish while the failed task\'s dependents never start', async () => {
    const h = setup(twoChains());
    await h.orchestrator.approveReview();

    await h.fail('a1');
    await h.pass('b1');
    await h.pass('b2');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.spawned()).toEqual(['a1', 'b1', 'b2']);
    expect(h.status('a2')).not.toBe('in_progress');
    expect(h.status('a3')).not.toBe('in_progress');
  });

  it('blocks the failed task\'s dependents transitively, naming the failure each waits on', async () => {
    const h = setup(twoChains());
    await h.orchestrator.approveReview();

    await h.fail('a1');

    expect(h.orchestrator.getBlockedBy('a2')).toEqual(['a1']);
    expect(h.orchestrator.getBlockedBy('a3')).toEqual(['a1']);
    expect(h.orchestrator.getBlockedBy('b2')).toEqual([]);
  });

  it('ends the run once nothing runnable is left, counting what completed, failed and is blocked', async () => {
    const h = setup(twoChains());
    await h.orchestrator.approveReview();

    await h.fail('a1');
    await h.pass('b1');
    expect(h.executionComplete).not.toHaveBeenCalled();
    await h.pass('b2');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(1));
    expect(h.orchestrator.isRunning).toBe(false);
    expect(h.notifications.warn).toHaveBeenCalledWith(expect.stringContaining('Run finished: 2 completed, 1 failed, 2 blocked.'));
  });

  it('runs the dependents once a retry of the failed task passes, while the run goes on', async () => {
    const h = setup(twoChains());
    await h.orchestrator.approveReview();
    await h.fail('a1');

    await h.orchestrator.retryTask('a1');
    await h.pass('a1');
    await h.pass('a2');
    await h.pass('a3');
    await h.pass('b1');
    await h.pass('b2');

    await vi.waitFor(() => expect(h.orchestrator.isAllComplete()).toBe(true));
    expect(h.spawned().filter((id) => id === 'a1')).toHaveLength(2);
  });

  it('continues a run that ended on a failure when the failed task is retried, so what it blocked runs', async () => {
    const h = setup(twoChains());
    await h.orchestrator.approveReview();
    await h.fail('a1');
    await h.pass('b1');
    await h.pass('b2');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(1));

    await h.orchestrator.retryTask('a1');
    await vi.waitFor(() => expect(h.spawned().filter((id) => id === 'a1')).toHaveLength(2));
    await h.pass('a1');
    await h.pass('a2');
    await h.pass('a3');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(2));
    expect(h.orchestrator.status).toBe('completed');
  });

  it('blocks a subtask behind a failed sibling, and its dependents with it, while other work runs', async () => {
    const parent = { ...task('p1', 1), subtasks: [task('s1', 1), task('s2', 2, ['s1'])] };
    const h = setup([parent, task('t2', 2, ['s2']), task('t3', 3)]);
    await h.orchestrator.approveReview();

    await h.pass('p1');
    await h.fail('s1');
    await h.pass('t3');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(1));
    expect(h.orchestrator.getBlockedBy('s2')).toEqual(['s1']);
    expect(h.orchestrator.getBlockedBy('t2')).toEqual(['s1']);
    expect(h.spawned()).not.toContain('s2');
    expect(h.spawned()).not.toContain('t2');
  });
});

describe('a subtask, held to its parent\'s dependencies (ADR-0034)', () => {
  /** f1, and p2 depending on it, whose subtask s21 depends on nothing of its own. */
  const parentOnF1 = (): Task[] => [
    task('f1', 1),
    createTask({ id: 'p2', order: 2, title: 'Task p2', prompt: 'do p2', dependencies: ['f1'], subtasks: [task('s21', 1)] }),
  ];

  it('never starts while its parent\'s dependency failed, and runs once a retry of it passes', async () => {
    const h = setup(parentOnF1());
    await h.orchestrator.approveReview();
    await h.fail('f1');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(1));
    expect(h.spawned()).toEqual(['f1']);
    expect(h.orchestrator.getBlockedBy('p2')).toEqual(['f1']);
    expect(h.orchestrator.getBlockedBy('s21')).toEqual(['f1']);

    await h.orchestrator.retryTask('f1');
    await h.pass('f1');
    expect(h.orchestrator.getBlockedBy('s21')).toEqual([]);
    await h.pass('s21');
    await h.pass('p2');
    await vi.waitFor(() => expect(h.orchestrator.isAllComplete()).toBe(true));
  });
});

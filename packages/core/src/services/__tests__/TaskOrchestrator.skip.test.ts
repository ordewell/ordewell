import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

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
  const isolation = new FakeWorktreeIsolation();
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
  });
  const executionComplete = vi.fn();
  orchestrator.subscribe({ onExecutionComplete: executionComplete });
  orchestrator.loadPlan(tasks);
  const spawned = (): string[] => runner.spawn.mock.calls.map(([o]) => o.taskId);
  const promptOf = (taskId: string): string | undefined => runner.spawn.mock.calls.find(([o]) => o.taskId === taskId)?.[0].prompt;
  const latest = (taskId: string): FakeRunnerSession => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const status = (taskId: string): string | undefined => orchestrator.storeInstance.get(taskId)?.status;
  const settle = async (taskId: string, outcome: 'done' | 'failed', expected: string): Promise<void> => {
    await vi.waitFor(() => expect(spawned()).toContain(taskId));
    latest(taskId).reportComplete(outcome === 'done' ? { status: 'done', summary: `${taskId} report` } : { status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(status(taskId)).toBe(expected));
  };
  return {
    orchestrator, isolation, notifications, spawned, promptOf, status, executionComplete, latest,
    pass: (taskId: string) => settle(taskId, 'done', 'completed'),
    fail: (taskId: string) => settle(taskId, 'failed', 'failed'),
  };
}

const task = (id: string, order: number, dependencies: string[] = []): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, dependencies });

describe('Skip: a task ends without landing its work', () => {
  it('skips a failed task: nothing it did lands, its worktree is kept, and its dependents start', async () => {
    const h = setup([task('a', 1), task('b', 2, ['a'])]);
    await h.orchestrator.approveReview();
    await h.fail('a');

    await h.orchestrator.skipTask('a', 'the host cannot run it');

    expect(h.status('a')).toBe('skipped');
    expect(h.isolation.taskIdsFor('integrate')).toEqual([]);
    expect(h.isolation.calls).not.toContainEqual({ op: 'release', taskId: 'a', keep: false });
    await vi.waitFor(() => expect(h.spawned()).toContain('b'));
  });

  it('leaves Mark complete as the user\'s vouch: it lands a skipped task\'s kept work', async () => {
    const h = setup([task('a', 1), task('b', 2, ['a'])]);
    await h.orchestrator.approveReview();
    await h.fail('a');
    await h.orchestrator.skipTask('a');

    await h.orchestrator.markTaskComplete('a');

    expect(h.status('a')).toBe('completed');
    expect(h.isolation.taskIdsFor('integrate')).toEqual(['a']);
  });

  it('continues a run that ended on the failure, and ends it counting the skipped task apart from completed and failed', async () => {
    const h = setup([task('a', 1), task('b', 2, ['a'])]);
    await h.orchestrator.approveReview();
    await h.fail('a');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(1));
    await h.orchestrator.skipTask('a', 'not needed');

    await h.pass('b');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(2));
    expect(h.orchestrator.isRunning).toBe(false);
    expect(h.orchestrator.status).toBe('completed');
    expect(h.notifications.info).toHaveBeenCalledWith('Run finished: 1 completed, 1 skipped.');
  });

  it('tells a dependent its dependency was skipped, and why, so it does not count on that work', async () => {
    const h = setup([task('a', 1), task('b', 2, ['a'])]);
    await h.orchestrator.approveReview();
    await h.fail('a');

    await h.orchestrator.skipTask('a', 'the host cannot run it');

    await vi.waitFor(() => expect(h.spawned()).toContain('b'));
    expect(h.promptOf('b')).toContain('### Task 1: Task a\n- Skipped: the host cannot run it. None of its work landed, so it is not in your tree; do not count on it.');
  });
});

describe('Mark complete: a run that ended on the failure goes on for what the task released', () => {
  it('starts the dependents of a failed task the user vouches for, as a retry that passes would', async () => {
    const h = setup([task('a', 1), task('b', 2, ['a'])]);
    await h.orchestrator.approveReview();
    await h.fail('a');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(1));
    expect(h.spawned()).not.toContain('b');

    await h.orchestrator.markTaskComplete('a');

    await h.pass('b');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(2));
    expect(h.orchestrator.status).toBe('completed');
  });

  it('leaves a run that ended on the failure ended when the task it vouches for releases nothing', async () => {
    const h = setup([task('a', 1), task('b', 2), task('c', 3, ['b'])]);
    await h.orchestrator.approveReview();
    await h.fail('a');
    await h.fail('b');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalledTimes(1));

    await h.orchestrator.markTaskComplete('a');

    expect(h.spawned()).not.toContain('c');
    expect(h.orchestrator.isRunning).toBe(false);
  });
});

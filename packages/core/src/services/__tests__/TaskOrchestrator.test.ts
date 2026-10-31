import { describe, it, expect, vi } from 'vitest';
import { STARTS_AT_ONCE, TaskOrchestrator } from '../TaskOrchestrator';
import { composeAugmentedPrompt } from '../promptAugment';
import { createTask } from '../../models/Task';
import type { IConfig } from '../../interfaces/IConfig';
import type { INotification } from '../../interfaces/INotification';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { TaskOutputSource } from '../../interfaces/TaskOutputSource';
import type { WorkspaceEnv } from '../workspaceEnv';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';

function fakeTerminalRunner(): IRunner {
  return {
    spawn: vi.fn(async () => new FakeRunnerSession()),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
}

/** Spawns {@link FakeRunnerSession}s the test can drive, in spawn order. */
function sessionRunner() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  return { sessions, spawn, stop: vi.fn(), stopAll: vi.fn() };
}

function makeOrchestrator(overrides: {
  config?: Partial<IConfig>;
  notifications?: Partial<INotification>;
  runner?: Partial<IRunner>;
  output?: TaskOutputSource;
  registry?: RunnerRegistry;
  workspaceRoot?: () => string;
  workspaceEnv?: (cwd: string) => Promise<WorkspaceEnv>;
  previousAttemptFromLog?: (taskId: string) => string | null;
} = {}) {
  const config = fakeConfig(overrides.config);
  const notifications = { ...fakeNotification(), ...overrides.notifications };
  const runner = { ...fakeTerminalRunner(), ...overrides.runner } as IRunner;
  const output = overrides.output ?? new BufferedTaskOutputSource();
  return TaskOrchestrator.compose({
    config,
    notifications,
    runner,
    output,
    registry: overrides.registry,
    workspaceRoot: overrides.workspaceRoot ?? (() => '/repo'),
    workspaceEnv: overrides.workspaceEnv,
    previousAttemptFromLog: overrides.previousAttemptFromLog,
  });
}

describe('TaskOrchestrator', () => {
  describe('addTask', () => {
    it('adds a task to the plan, renumbers it, and makes it retrievable', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      ]);

      expect(orchestrator.storeInstance.allTasks.length).toBe(1);

      const added = orchestrator.storeInstance.add({ title: 'Second', prompt: 'do second' });

      expect(orchestrator.storeInstance.allTasks.length).toBe(2);
      expect(added.id).toBeTypeOf('string');
      expect(added.title).toBe('Second');
      expect(added.prompt).toBe('do second');
      expect(added.order).toBe(2);
      expect(added.status).toBe('pending');

      // Verify retrievable via getTask
      const found = orchestrator.storeInstance.get(added.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe('Second');
    });

    it('assigns defaults: type=ai, taskMode=build', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([]);

      const added = orchestrator.storeInstance.add({ title: 'T' });

      expect(added.type).toBe('ai');
      expect(added.taskMode).toBe('build');
      expect(added.status).toBe('pending');
    });

    it('preserves explicit overrides for type, status, dependencies', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 'dep1', order: 1, title: 'Dep', prompt: 'x' }),
      ]);

      const added = orchestrator.storeInstance.add({
        title: 'Manual Check',
        type: 'user',
        dependencies: ['dep1'],
        userSteps: [{ order: 1, instruction: 'run it', completed: false }],
      });

      expect(added.type).toBe('user');
      expect(added.dependencies).toEqual(['dep1']);
      expect(added.userSteps).toHaveLength(1);
    });
  });

  describe('removeTask', () => {
    it('removes a task by id and renumbers remaining tasks', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'a' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'b' }),
        createTask({ id: 't3', order: 3, title: 'Third', prompt: 'c' }),
      ]);

      orchestrator.storeInstance.remove('t2');

      expect(orchestrator.storeInstance.allTasks.length).toBe(2);
      expect(orchestrator.storeInstance.get('t1')).toBeDefined();
      expect(orchestrator.storeInstance.get('t2')).toBeUndefined();
      expect(orchestrator.storeInstance.get('t3')).toBeDefined();

      const remaining = orchestrator.storeInstance.get('t3');
      expect(remaining!.order).toBe(2); // renumbered from 3 → 2
    });

    it('cleans dependencies that reference the removed task', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'a' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'b', dependencies: ['t1'] }),
      ]);

      orchestrator.storeInstance.remove('t1');

      expect(orchestrator.storeInstance.allTasks.length).toBe(1);
      const remaining = orchestrator.storeInstance.get('t2');
      expect(remaining!.dependencies).toEqual([]);
    });

    it('is a no-op when task id does not exist', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'a' }),
      ]);

      orchestrator.storeInstance.remove('nonexistent');

      expect(orchestrator.storeInstance.allTasks.length).toBe(1);
    });
  });

  describe('updateTask', () => {
    it('updates properties on an existing task and returns it', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'old' }),
      ]);

      const updated = orchestrator.storeInstance.update('t1', {
        title: 'Renamed',
        prompt: 'new prompt',
      });

      expect(updated).toBeDefined();
      expect(updated!.title).toBe('Renamed');
      expect(updated!.prompt).toBe('new prompt');
      expect(updated!.id).toBe('t1');
      expect(updated!.order).toBe(1);

      const found = orchestrator.storeInstance.get('t1');
      expect(found!.title).toBe('Renamed');
    });

    it('returns undefined for a nonexistent task id', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'a' }),
      ]);

      const result = orchestrator.storeInstance.update('nope', { title: 'X' });
      expect(result).toBeUndefined();
    });

    it('does not overwrite id or order via changes', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'a' }),
      ]);

      orchestrator.storeInstance.update('t1', { id: 'fake', order: 99 });

      const found = orchestrator.storeInstance.get('t1');
      expect(found!.id).toBe('t1');
      expect(found!.order).toBe(1);
    });
  });

  describe('markTaskComplete', () => {
    it('marks a pending AI task as completed with a manual verdict and archives it', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'pending' }),
      ]);

      await orchestrator.markTaskComplete('t1');

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe('t1');
      expect(log[0].status).toBe('completed');
      expect(log[0].verdict).toBeDefined();
      expect(log[0].verdict!.outcome).toBe('pass');
      expect(log[0].verdict!.reason).toBe('Manually marked complete by user.');
      expect(log[0].verdict!.checks).toEqual([
        { name: 'manual', passed: true, skipped: false, detail: 'Task was manually marked complete by the user; no automatic verification was performed.' },
      ]);
      expect(log[0].finalized).toBe(true);
      const task = orchestrator.storeInstance.get('t1');
      expect(task).toBeDefined();
      expect(task!.status).toBe('completed');
      expect(orchestrator.storeInstance.planTasks).toHaveLength(1);
    });

    it('marks a pending user task as completed with a manual verdict and archives it', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 'u1', order: 1, title: 'User Task', type: 'user', status: 'pending' }),
      ]);

      await orchestrator.markTaskComplete('u1');

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe('u1');
      expect(log[0].status).toBe('completed');
      expect(log[0].verdict!.outcome).toBe('pass');
      expect(log[0].verdict!.checks[0].name).toBe('manual');
      const task = orchestrator.storeInstance.get('u1');
      expect(task).toBeDefined();
      expect(task!.status).toBe('completed');
    });

    it('stops only the running session for the task being marked complete', async () => {
      const { spawn, stop, stopAll } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn, stop, stopAll } });
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do' }),
        createTask({ id: 't2', order: 2, title: 'Other AI Task', prompt: 'do other' }),
      ]);
      await orchestrator.forceStartTask('t1');
      await orchestrator.forceStartTask('t2');

      await orchestrator.markTaskComplete('t1');

      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith('s1');
      expect(stopAll).not.toHaveBeenCalled();
      expect(orchestrator.activeSessionMap).toEqual(new Map([['t2', 's2']]));
    });

    it('lifts the block on dependents when marking a failed task complete', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Failing', prompt: 'do', status: 'failed' }),
        createTask({ id: 't2', order: 2, title: 'Blocked', prompt: 'do', dependencies: ['t1'] }),
      ]);
      orchestrator.storeInstance.markFailed('t1');
      expect(orchestrator.getBlockedBy('t2')).toEqual(['t1']);

      await orchestrator.markTaskComplete('t1');

      const t1 = orchestrator.storeInstance.get('t1');
      expect(t1).toBeDefined();
      expect(t1!.status).toBe('completed');
      const t2 = orchestrator.storeInstance.get('t2');
      expect(t2!.status).toBe('pending');
      expect(orchestrator.getBlockedBy('t2')).toEqual([]);
    });

    it('marks an awaiting_user task as completed', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 'u1', order: 1, title: 'Checkpoint', type: 'user', status: 'awaiting_user' }),
      ]);

      await orchestrator.markTaskComplete('u1');

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe('u1');
      expect(log[0].status).toBe('completed');
      expect(log[0].verdict!.checks[0].name).toBe('manual');
    });
  });

  describe('markTaskIncomplete', () => {
    it('returns a completed task to pending, dropping its verdict and archive entry', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'pending' }),
      ]);
      await orchestrator.markTaskComplete('t1');

      await orchestrator.markTaskIncomplete('t1');

      const task = orchestrator.storeInstance.get('t1')!;
      expect(task.status).toBe('pending');
      expect(task.verdict).toBeUndefined();
      expect(task.outputSummary).toBeUndefined();
      expect(orchestrator.storeInstance.isCompleted('t1')).toBe(false);
      expect(orchestrator.storeInstance.getExecutionLog()).toHaveLength(0);
      expect(orchestrator.getCompletedCount()).toBe(0);
    });

    it('no-ops on a task that is not completed', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'awaiting_user' }),
      ]);

      await orchestrator.markTaskIncomplete('t1');
      await orchestrator.markTaskIncomplete('nope');

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
    });

    it('holds the un-marked task so a running plan does not immediately respawn it', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'completed' }),
        // A pending user task keeps the run armed but idle.
        createTask({ id: 'u1', order: 2, title: 'Check', type: 'user' }),
      ]);
      await orchestrator.approveReview();
      expect(orchestrator.isRunning).toBe(true);

      await orchestrator.markTaskIncomplete('t1');

      expect(spawn).not.toHaveBeenCalled();
      expect(orchestrator.getReadyTasks()).toHaveLength(0);
      // Force Start releases the hold, same as after a cancel.
      await orchestrator.forceStartTask('t1');
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('takes a finished plan out of the completed state', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'pending' }),
      ]);
      await orchestrator.markTaskComplete('t1');
      await orchestrator.approveReview();
      expect(orchestrator.status).toBe('completed');

      await orchestrator.markTaskIncomplete('t1');

      expect(orchestrator.status).toBe('approved');
    });

    it('a retry takes a finished plan out of the completed state too', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'pending' }),
      ]);
      await orchestrator.markTaskComplete('t1');
      await orchestrator.approveReview();
      expect(orchestrator.status).toBe('completed');

      await orchestrator.retryTask('t1');

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');
      expect(orchestrator.status).toBe('approved');
    });
  });

  describe('forceStartTask', () => {
    it('starts an AI task with the augmented prompt (not the raw prompt)', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      const tasks = [
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
        createTask({ id: 't3', order: 3, title: 'Third', prompt: 'do third' }),
      ];
      orchestrator.loadPlan(tasks);

      await orchestrator.forceStartTask('t2');

      expect(spawn).toHaveBeenCalledTimes(1);
      const arg = spawn.mock.calls[0][0];
      const expected = composeAugmentedPrompt(tasks[1], tasks, { planMapEnabled: true });
      expect(arg.prompt).toBe(expected);
      // Regression: must carry plan-map context, not the bare prompt/title.
      expect(arg.prompt).not.toBe('do second');
      expect(arg.prompt).toContain('Plan map');
      expect(orchestrator.storeInstance.get('t2')!.status).toBe('in_progress');
    });

    it('is a no-op for unknown ids and non-AI tasks', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan([
        createTask({ id: 'u1', order: 1, title: 'Manual', type: 'user' }),
      ]);

      await orchestrator.forceStartTask('does-not-exist');
      await orchestrator.forceStartTask('u1');

      expect(spawn).not.toHaveBeenCalled();
    });

    it('completes on a task_complete call and logs the task', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('Working on it...\n');
      sessions[0].reportComplete({ status: 'done', summary: '' });
      sessions[0].emitOutput('\nDone.');
      sessions[0].emitExit(-1);

      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe('t1');
      expect(log[0].verdict!.outcome).toBe('pass');
      expect(log[0].verdict!.reason).toMatch(/task_complete/);
      expect(log[0].finalized).toBe(true);
      const completedTask = orchestrator.storeInstance.get('t1');
      expect(completedTask).toBeDefined();
      expect(completedTask!.status).toBe('completed');
    });

    it('marks task as failed when session exits without a task_complete call and non-zero exit code', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('Something went wrong.');
      sessions[0].emitExit(1);

      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe('t1');
      expect(log[0].verdict!.outcome).toBe('fail');
      const failedTask = orchestrator.storeInstance.get('t1');
      expect(failedTask).toBeDefined();
      expect(failedTask!.status).toBe('failed');
    });

    it('completes a task that called task_complete even when a usage limit then kills the runner', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      sessions[0].reportComplete({ status: 'done', summary: '' });
      sessions[0].emitOutput('\nClaude usage limit reached. Your limit will reset at 5pm.');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

      const finished = orchestrator.storeInstance.get('t1');
      expect(finished!.status).toBe('completed');
      expect(finished!.verdict!.outcome).toBe('pass');
      expect(finished!.verdict!.reason).toMatch(/task_complete/);
    });

    it('pauses a runner that stopped on a usage limit before reporting completion, instead of failing the task', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('Claude usage limit reached. Your limit will reset at 5pm.');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      const paused = orchestrator.storeInstance.get('t1');
      expect(paused!.status).toBe('awaiting_user');
      // A pause is no verdict, as when the limit fails the turn instead.
      expect(paused!.verdict).toBeUndefined();
      // A retry answers it, not a message; no reset time was given, so none is scheduled.
      expect(paused!.awaitingReason).toBe('usage-limit');
      expect(paused!.resumeAt).toBeUndefined();
    });

    it('does not promise a kept worktree when the paused task ran in the workspace root', async () => {
      const { sessions, spawn } = sessionRunner();
      const warn = vi.fn();
      const orchestrator = makeOrchestrator({ runner: { spawn }, notifications: { warn } });

      orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it' })]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('Claude usage limit reached. Your limit will reset at 5pm.');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      expect(warn).toHaveBeenCalledWith('Task "Test" stopped before it reported completion: claude-code hit its usage limit. Retry it once the limit resets.');
    });

    it('pauses the run on a usage limit and resumes it when the task is retried', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn }, config: { maxParallelSessions: 1 } });

      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
      ]);
      await orchestrator.approveReview();

      sessions[0].emitOutput('You have hit your usage limit. The limit will reset at 5pm.');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      // No second task is launched into the exhausted limit. The pause names
      // no reset, so the task waits for a manual retry and keeps only its own
      // runner's tasks from starting; the run itself is not held (ADR-0018, U1).
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(orchestrator.status).toBe('running');

      await orchestrator.retryTask('t1');
      expect(spawn).toHaveBeenCalledTimes(2);

      sessions[1].reportComplete({ status: 'done', summary: '' });
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
      expect(spawn.mock.calls[2][0].taskId).toBe('t2');
    });

    it('leaves a task without a task_complete call failed when its exit names no limit', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('compilation failed: unexpected token');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    });
  });

  describe('runTask', () => {
    it('runs only the selected task, stays busy until its task_complete call, and does not schedule following work', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Selected', prompt: 'do selected' }),
        createTask({ id: 't2', order: 2, title: 'Following', prompt: 'do following' }),
      ]);

      await orchestrator.forceStartTask('t1');

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1' }));
      expect(orchestrator.isRunning).toBe(true);
      expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');

      sessions[0].reportComplete({ status: 'done', summary: '' });
      await vi.waitFor(() => {
        expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed');
        expect(orchestrator.isRunning).toBe(false);
      });

      expect(orchestrator.storeInstance.get('t2')?.status).toBe('pending');
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe', () => {
    it('notifies onTaskChanged when a task is added, removed, or updated', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'a' }),
      ]);

      const calls: string[] = [];
      orchestrator.subscribe({
        onTaskChanged: () => calls.push('changed'),
      });

      const added = orchestrator.storeInstance.add({ title: 'New' });
      expect(calls).toEqual(['changed']);

      orchestrator.storeInstance.remove(added.id);
      expect(calls).toEqual(['changed', 'changed']);

      orchestrator.storeInstance.update('t1', { title: 'Renamed' });
      expect(calls).toEqual(['changed', 'changed', 'changed']);
    });

    it('stops notifying after unsubscribe', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'a' }),
      ]);

      const calls: string[] = [];
      const unsub = orchestrator.subscribe({
        onTaskChanged: () => calls.push('changed'),
      });

      orchestrator.storeInstance.add({ title: 'X' });
      expect(calls).toHaveLength(1);

      unsub();
      orchestrator.storeInstance.add({ title: 'Y' });
      expect(calls).toHaveLength(1);
    });

    it('supports multiple observers on the same event', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([]);

      const calls: string[] = [];
      orchestrator.subscribe({ onTaskChanged: () => calls.push('A') });
      orchestrator.subscribe({ onTaskChanged: () => calls.push('B') });

      orchestrator.storeInstance.add({ title: 'T' });

      expect(calls).toContain('A');
      expect(calls).toContain('B');
    });
  });

  describe('plan review checkpoint', () => {
    it('starts with review not approved after loadPlan', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
      ]);
      expect(orchestrator.isReviewApproved).toBe(false);
    });

    it('start() emits onReviewNeeded when review not approved', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
      ]);

      const events: string[] = [];
      orchestrator.subscribe({
        onReviewNeeded: () => events.push('review_needed'),
      });

      await orchestrator.start();
      expect(events).toContain('review_needed');
      expect(orchestrator.isRunning).toBe(false);
    });

    it('approveReview sets review as approved and starts execution', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
      ]);

      const events: string[] = [];
      orchestrator.subscribe({
        onReviewApproved: () => events.push('review_approved'),
      });

      orchestrator.approveReview();

      await vi.waitFor(() => expect(events).toContain('review_approved'));
      expect(orchestrator.isReviewApproved).toBe(true);
    });
  });

  describe('start hold in tick', () => {
    // The run is armed on a user gate; t1 is force-started past it so a
    // runner is live when the gate opens and the scheduler looks at t2.
    function gatedPlan() {
      return [
        createTask({ id: 'u1', order: 1, title: 'Gate', type: 'user' }),
        createTask({ id: 't1', order: 2, title: 'Task 1', prompt: 'do it', dependencies: ['u1'] }),
        createTask({ id: 't2', order: 3, title: 'Task 2', prompt: 'do also', dependencies: ['u1'] }),
      ];
    }

    it('starts no new task while held, leaves the running one alone, and starts it on the tick after release', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      // Task 1 needs no gate, so the run starts it; a force start would only queue it behind the gate.
      orchestrator.loadPlan(gatedPlan().map((t) => (t.id === 't1' ? { ...t, dependencies: [] } : t)));
      await orchestrator.approveReview();

      const release = orchestrator.holdStarts();
      await orchestrator.markTaskComplete('u1');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(orchestrator.activeTaskIds).toEqual(['t1']);

      release();
      await orchestrator.tick();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][0].taskId).toBe('t2');
    });

    it('holds until every hold is released, and a second release of one changes nothing', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })]);
      const one = orchestrator.holdStarts();
      const two = orchestrator.holdStarts();
      await orchestrator.approveReview();

      one();
      one();
      await orchestrator.tick();
      expect(spawn).not.toHaveBeenCalled();
      two();
      await orchestrator.tick();
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('proceeds normally when nothing holds it', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan(gatedPlan());
      await orchestrator.approveReview();
      await orchestrator.forceStartTask('t1');

      await orchestrator.markTaskComplete('u1');

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][0].taskId).toBe('t2');
    });
  });

describe('merge-on-reload', () => {
    /** A one-task plan whose run is approved and whose task has a live runner ('s1'). */
    async function runningOn(taskId: string) {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan([createTask({ id: taskId, order: 1, title: 'Task 1', prompt: 'do it' })]);
      await orchestrator.approveReview();
      return orchestrator;
    }

    it('preserves running sessions when task exists in new plan as in_progress', async () => {
      const orchestrator = await runningOn('t1');

      const newTasks = [
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it', status: 'in_progress' }),
        createTask({ id: 't2', order: 2, title: 'Task 2', prompt: 'do also' }),
      ];

      orchestrator.reconcilePlan(newTasks, ['claude-code']);

      expect(orchestrator.storeInstance.get('t1')).toBeDefined();
      expect(orchestrator.storeInstance.get('t2')).toBeDefined();
      expect(orchestrator.isRunning).toBe(true);
    });

    it('keeps running task in store when removed from new plan (for onVerdict processing)', async () => {
      const orchestrator = await runningOn('t1');

      const newTasks = [
        createTask({ id: 't2', order: 1, title: 'New Task', prompt: 'new work' }),
      ];

      orchestrator.reconcilePlan(newTasks, ['claude-code']);

      expect(orchestrator.storeInstance.get('t1')).toBeDefined();
      expect(orchestrator.storeInstance.get('t2')).toBeDefined();
      expect(orchestrator.storeInstance.allTasks.length).toBe(2);
    });

    // The edited plan is a snapshot, and a task that started after it was taken
    // reads as 'pending' in it. Adopting that status would hand the same work to
    // the scheduler a second time while the first runner is still going.
    it('keeps a live task in_progress, its session tracked and the review approved', async () => {
      const orchestrator = await runningOn('t1');

      orchestrator.reconcilePlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it', status: 'pending' }),
        createTask({ id: 't2', order: 2, title: 'Task 2', prompt: 'do also' }),
      ], ['claude-code']);

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
      expect(orchestrator.activeSessionMap.get('t1')).toBe('s1');
      expect(orchestrator.isReviewApproved).toBe(true);
    });

    it('logs a warning when running task status changed in new plan', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const orchestrator = await runningOn('t1');

      const newTasks = [
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it', status: 'pending' }),
      ];

      orchestrator.reconcilePlan(newTasks, ['claude-code']);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('status changed')
      );

      warnSpy.mockRestore();
    });
  });

describe('sequential dependency chain', () => {
    it('spawns dependent task after its dependency completes and is archived', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });

      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] }),
      ]);

      await orchestrator.approveReview();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));

      // t1 should have been spawned
      expect(spawn.mock.calls[0][0].taskId).toBe('t1');

      sessions[0].emitOutput('Done.\n');
      sessions[0].reportComplete({ status: 'done', summary: '' });
      sessions[0].emitExit(0);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

      // t2 should now be spawned
      expect(spawn.mock.calls[1][0].taskId).toBe('t2');

      // t1 should be completed and still visible in the active plan
      const t1 = orchestrator.storeInstance.get('t1');
      expect(t1).toBeDefined();
      expect(t1!.status).toBe('completed');
      expect(orchestrator.storeInstance.isCompleted('t1')).toBe(true);
      expect(orchestrator.storeInstance.planTasks).toHaveLength(2);
      expect(orchestrator.storeInstance.planTasks[1].id).toBe('t2');
    });
  });

describe('resuming after a user-action pause', () => {
    it('keeps running=true when the only remaining work needs user action, so completing it resumes the dependent AI task', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });

      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Confirm setup', type: 'user' }),
        createTask({ id: 't2', order: 2, title: 'Build it', prompt: 'do', dependencies: ['t1'] }),
      ]);

      await orchestrator.approveReview();

      // t1 is a user task (never auto-scheduled) and t2 is blocked on it, so
      // the very first tick has nothing ready and nothing active — this must
      // not kill the run, or completing t1 will never wake t2 back up.
      expect(spawn).not.toHaveBeenCalled();
      expect(orchestrator.isRunning).toBe(true);

      await orchestrator.markTaskComplete('t1');

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][0].taskId).toBe('t2');
    });

    it('stops running once every task is actually completed', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 'u1', order: 1, title: 'Only task', type: 'user' }),
      ]);

      await orchestrator.approveReview();
      expect(orchestrator.isRunning).toBe(true);

      await orchestrator.markTaskComplete('u1');

      expect(orchestrator.isRunning).toBe(false);
      expect(orchestrator.status).toBe('completed');
    });

    it('does not broadcast execution_complete while paused on a user task (the run is not finished)', async () => {
      const events: string[] = [];
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([createTask({ id: 'u1', order: 1, title: 'Confirm', type: 'user' })]);
      orchestrator.subscribe({
        onTick: () => events.push('tick'),
        onExecutionComplete: () => events.push('complete'),
      });

      await orchestrator.approveReview();

      await vi.waitFor(() => expect(events).toContain('tick'));
      // Nothing ready (u1 is a user task) and not all complete — the run is
      // paused awaiting the human. execution_complete must NOT fire: every
      // surface treats it as terminal (the TUI closes its execution stream on
      // receipt), so a premature emit would render later fan-out invisible.
      expect(events).not.toContain('complete');
      expect(orchestrator.isRunning).toBe(true);

      await orchestrator.markTaskComplete('u1');

      // Genuinely complete now — execution_complete fires and the loop stops.
      expect(events).toContain('complete');
      expect(orchestrator.isRunning).toBe(false);
      expect(orchestrator.status).toBe('completed');
    });
  });

describe('execution log tracking', () => {

    it('appends completed task to execution log while keeping it in the active plan', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it' });
      orchestrator.loadPlan([task]);

      await orchestrator.approveReview();

      sessions[0].emitOutput('Done.\n');
      sessions[0].reportComplete({ status: 'done', summary: '' });
      sessions[0].emitExit(0);

      await vi.waitFor(() => expect(orchestrator.storeInstance.getExecutionLog()).toHaveLength(1));

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log[0].id).toBe('t1');
      expect(log[0].finalized).toBe(true);
      expect(log[0].verdict?.outcome).toBe('pass');

      expect(orchestrator.storeInstance.planTasks).toHaveLength(1);
      expect(orchestrator.storeInstance.planTasks[0].status).toBe('completed');
    });

    it('logs failed task to execution log', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it' });
      orchestrator.loadPlan([task]);

      await orchestrator.approveReview();

      sessions[0].emitOutput('Error occurred');
      sessions[0].emitExit(1);

      await vi.waitFor(() => expect(orchestrator.storeInstance.getExecutionLog()).toHaveLength(1));

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log[0].id).toBe('t1');
      expect(log[0].verdict?.outcome).toBe('fail');
      expect(orchestrator.storeInstance.planTasks).toHaveLength(1);
      expect(orchestrator.storeInstance.planTasks[0].status).toBe('failed');
    });
  });

describe('checkpoints', () => {
    function hitlPlan() {
      return [createTask({ id: 't1', order: 1, title: 'HITL Task', prompt: 'do', autonomy: 'HITL' })];
    }

    it('emits onCheckpoint event when verifier detects a checkpoint', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan(hitlPlan());
      const events: { taskId: string; taskTitle: string; summary: string }[] = [];
      orchestrator.subscribe({ onCheckpoint: (data) => events.push(data) });

      await orchestrator.forceStartTask('t1');
      void sessions[0].callCheckpoint('need review');

      expect(events).toEqual([{ taskId: 't1', taskTitle: 'HITL Task', summary: 'need review' }]);
    });

    it('sets task status to awaiting_user on checkpoint', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan(hitlPlan());

      await orchestrator.forceStartTask('t1');
      void sessions[0].callCheckpoint('approve this');

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
    });

    it('approveCheckpoint resumes task status to in_progress', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan(hitlPlan());

      await orchestrator.forceStartTask('t1');
      const answer = sessions[0].callCheckpoint('approve this');
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');

      orchestrator.approveCheckpoint('t1');
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
      await expect(answer).resolves.toEqual({ kind: 'continue' });
    });

    it('rejectCheckpoint resumes task status to in_progress', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ runner: { spawn } });
      orchestrator.loadPlan(hitlPlan());

      await orchestrator.forceStartTask('t1');
      const answer = sessions[0].callCheckpoint('approve this');
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');

      orchestrator.rejectCheckpoint('t1', 'try again');
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
      await expect(answer).resolves.toEqual({ kind: 'rejected', reason: 'try again' });
    });
  });

describe('cancelTask', () => {
  it('does not let a dependent task auto-start when stop() synchronously fires onExit (tmux-style)', async () => {
    // Some runners (tmux) call the session's onExit callback synchronously
    // from within stop()/kill() — this mimics that to reproduce the race
    // where a cancelled task's dependent gets spawned before the cancelled
    // task is reverted to 'pending'.
    const { sessions, spawn } = sessionRunner();
    const stop = vi.fn(async () => sessions[0].emitExit(-1));
    const orchestrator = makeOrchestrator({ runner: { spawn, stop } });

    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] }),
    ]);

    await orchestrator.approveReview();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].taskId).toBe('t1');

    await orchestrator.cancelTask('t1');
    await flushMicrotasks();

    const t1 = orchestrator.storeInstance.get('t1');
    const t2 = orchestrator.storeInstance.get('t2');
    expect(t1!.status).toBe('pending');
    expect(t2!.status).toBe('pending');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  // The armed scheduler is an internal scheduling detail; what a surface asks —
  // "is a run executing?" — is live work. Once the last runner is cancelled
  // there is none, which is what lets a later Execute restart the plan instead
  // of being refused as "already executing".
  it('has no live work after the last running task of an armed run is cancelled', async () => {
    const { spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    await orchestrator.approveReview();
    expect(orchestrator.isRunning).toBe(true);
    expect(orchestrator.hasLiveWork).toBe(true);

    await orchestrator.cancelTask('t1');

    expect(orchestrator.hasLiveWork).toBe(false);
  });

  it('is a no-op when the verdict already landed before the cancel arrives', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it' });
    orchestrator.loadPlan([task]);
    await orchestrator.forceStartTask('t1');

    sessions[0].reportComplete({ status: 'done', summary: '' });
    sessions[0].emitExit(-1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    // A cancel for this task raced with its verdict and lost — it arrives
    // after the task already settled and landed. It must not revert a
    // completed task back to 'pending'.
    await orchestrator.cancelTask('t1');

    expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed');
    expect(orchestrator.storeInstance.get('t1')!.verdict?.outcome).toBe('pass');
  });
});
});

describe('task attempts', () => {
  it('records the runner, working directory and start time of a running attempt', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);

    await orchestrator.forceStartTask('t1');

    const attempt = orchestrator.getAttempt('t1');
    expect(attempt).toMatchObject({ taskId: 't1', attempt: 1, phase: 'running', runner: 'claude-code', cwd: '/repo', sessionId: 's1' });
    expect(Number.isNaN(Date.parse(attempt!.startedAt))).toBe(false);
    expect(orchestrator.getAttempt('t1')?.sessionId).toBe(sessions[0].id);
  });

  function expectNoAttemptState(orchestrator: TaskOrchestrator) {
    expect(orchestrator.getAttempt('t1')).toBeUndefined();
    expect(orchestrator.activeSessionMap.size).toBe(0);
    expect(orchestrator.hasLiveWork).toBe(false);
  }

  it('cancel stops the runner and leaves no attempt state', async () => {
    const { spawn, stop } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn, stop } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    await orchestrator.forceStartTask('t1');

    await orchestrator.cancelTask('t1');

    expect(stop).toHaveBeenCalledWith('s1');
    expectNoAttemptState(orchestrator);
  });

  it('stop leaves no attempt state', async () => {
    const { spawn, stopAll } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn, stopAll } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    await orchestrator.approveReview();
    expect(orchestrator.getAttempt('t1')?.phase).toBe('running');

    orchestrator.stop();

    expect(stopAll).toHaveBeenCalled();
    expectNoAttemptState(orchestrator);
    expect(orchestrator.isRunning).toBe(false);
  });

  it('loading a plan leaves no attempt state', async () => {
    const { spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    const plan = [createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })];
    orchestrator.loadPlan(plan);
    await orchestrator.forceStartTask('t1');

    orchestrator.loadPlan(plan);

    expectNoAttemptState(orchestrator);
  });

  it('loading a plan forgets a run that ended on a failure', async () => {
    const { spawn, sessions } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.awaitsResume).toBe(true));

    orchestrator.loadPlan([createTask({ id: 'o1', order: 1, title: 'Other', prompt: 'do other' })]);

    expect(orchestrator.awaitsResume).toBe(false);
  });

  /** A runner whose spawns resolve only when the test says so. */
  function heldSpawns() {
    const pending: Array<{ resolve: (session: FakeRunnerSession) => void; reject: (err: Error) => void }> = [];
    const spawn = vi.fn(() => new Promise<IRunnerSession>((resolve, reject) => { pending.push({ resolve, reject }); }));
    const settle = async (index: number, session: FakeRunnerSession) => {
      pending[index].resolve(session);
      await flushMicrotasks();
    };
    const fail = async (index: number, err: Error) => {
      pending[index].reject(err);
      await flushMicrotasks();
    };
    return { spawn, settle, fail, spawned: () => pending.length };
  }

  it('stop during an in-flight spawn kills the late session and does not resurrect the task', async () => {
    const { spawn, settle, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));
    expect(orchestrator.getAttempt('t1')?.phase).toBe('starting');
    expect(orchestrator.getAttempt('t1')?.sessionId).toBeNull();

    orchestrator.stop();
    const late = new FakeRunnerSession('late', 't1');
    await settle(0, late);

    expect(late.killed).toBe(true);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');
    expectNoAttemptState(orchestrator);
    expect(orchestrator.isRunning).toBe(false);
  });

  // The old guard checked only that *a* spawn was starting for the id, so a
  // restart claimed the flag and the stale spawn took it over.
  it('a stale spawn settling after a restart neither replaces nor resets the new attempt', async () => {
    const { spawn, settle, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));
    orchestrator.stop();
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(2));

    const stale = new FakeRunnerSession('stale', 't1');
    const fresh = new FakeRunnerSession('fresh', 't1');
    await settle(0, stale);
    await settle(1, fresh);

    expect(stale.killed).toBe(true);
    expect(fresh.killed).toBe(false);
    expect(orchestrator.getAttempt('t1')?.sessionId).toBe(fresh.id);
    expect(orchestrator.getAttempt('t1')?.attempt).toBe(2);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
  });

  it('cancel during an in-flight spawn kills the late session', async () => {
    const { spawn, settle, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));

    await orchestrator.cancelTask('t1');
    const late = new FakeRunnerSession('late', 't1');
    await settle(0, late);

    expect(late.killed).toBe(true);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');
    expectNoAttemptState(orchestrator);
  });
  describe('a start the scheduler resumes after an in-flight spawn', () => {
    /** The starts the tick waits on before it comes to t2 and t3. */
    const aheadIds = Array.from({ length: STARTS_AT_ONCE }, (_, i) => `a${i + 1}`);

    function plan() {
      return [
        ...aheadIds.map((id, i) => createTask({ id, order: i + 1, title: id, prompt: `do ${id}` })),
        createTask({ id: 't2', order: STARTS_AT_ONCE + 1, title: 'Second', prompt: 'do second' }),
        createTask({ id: 't3', order: STARTS_AT_ONCE + 2, title: 'Third', prompt: 'do third' }),
      ];
    }

    async function heldAtFirstSpawns(slotsPastThem: number) {
      const held = heldSpawns();
      const orchestrator = makeOrchestrator({ runner: { spawn: held.spawn }, config: { maxParallelSessions: STARTS_AT_ONCE + slotsPastThem } });
      orchestrator.loadPlan(plan());
      void orchestrator.approveReview();
      await vi.waitFor(() => expect(held.spawned()).toBe(STARTS_AT_ONCE));
      return { orchestrator, ...held };
    }

    const spawnedIds = (spawn: ReturnType<typeof heldSpawns>['spawn']) =>
      spawn.mock.calls.map((call: unknown[]) => (call[0] as { taskId: string }).taskId);

    it('does not start a task the user put on hold meanwhile', async () => {
      const { orchestrator, spawn, settle, spawned } = await heldAtFirstSpawns(2);

      void orchestrator.markTaskComplete('t2');
      await vi.waitFor(() => expect(spawned()).toBe(STARTS_AT_ONCE + 1));
      await orchestrator.markTaskIncomplete('t2');
      await settle(0, new FakeRunnerSession('s1', 'a1'));

      expect(orchestrator.storeInstance.get('t2')!.status).toBe('pending');
      expect(orchestrator.getAttempt('t2')).toBeUndefined();
      expect(spawnedIds(spawn)).not.toContain('t2');
    });

    it('does not reopen a task the user marked complete meanwhile, nor run more than the parallel limit', async () => {
      const { orchestrator, spawn, settle, spawned } = await heldAtFirstSpawns(1);

      void orchestrator.markTaskComplete('t2');
      await vi.waitFor(() => expect(spawned()).toBe(STARTS_AT_ONCE + 1));
      for (const [i, id] of [...aheadIds, 't3'].entries()) await settle(i, new FakeRunnerSession(`s${i}`, id));

      expect(orchestrator.storeInstance.get('t2')!.status).toBe('completed');
      expect(spawnedIds(spawn)).toEqual([...aheadIds, 't3']);
      expect(orchestrator.activeSessionMap.size).toBe(STARTS_AT_ONCE + 1);
    });

    it('does not take a slot a force start filled meanwhile', async () => {
      const { orchestrator, spawn, settle, spawned } = await heldAtFirstSpawns(1);

      void orchestrator.forceStartTask('t3');
      await vi.waitFor(() => expect(spawned()).toBe(STARTS_AT_ONCE + 1));
      for (const [i, id] of [...aheadIds, 't3'].entries()) await settle(i, new FakeRunnerSession(`s${i}`, id));

      expect(spawnedIds(spawn)).toEqual([...aheadIds, 't3']);
      expect(orchestrator.storeInstance.get('t2')!.status).toBe('pending');
    });

    it('does not start a task a reconcile gave an unmet dependency meanwhile', async () => {
      const { orchestrator, spawn, settle } = await heldAtFirstSpawns(1);

      orchestrator.reconcilePlan(plan().map((t) => (t.id === 't2' ? { ...t, dependencies: ['t3'] } : t)));
      await settle(0, new FakeRunnerSession('s1', 'a1'));

      expect(spawnedIds(spawn)).not.toContain('t2');
      expect(orchestrator.storeInstance.get('t2')!.status).toBe('pending');
    });
  });

  it('a verdict ends the attempt and a retry runs the task as a fresh one', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    await orchestrator.approveReview();
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    expectNoAttemptState(orchestrator);

    await orchestrator.retryTask('t1');
    await orchestrator.start();

    expect(orchestrator.getAttempt('t1')).toMatchObject({ attempt: 2, sessionId: 's2', phase: 'running' });
  });

  it('an observer whose onTaskChanged throws does not hold the task back or block a second ready task from starting', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    orchestrator.subscribe({ onTaskChanged: () => { throw new Error('boom'); } });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);

    await orchestrator.approveReview();
    await vi.waitFor(() => expect(sessions.length).toBe(2));

    expect(orchestrator.getAttempt('t1')?.phase).toBe('running');
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
    expect(orchestrator.getAttempt('t2')?.phase).toBe('running');
    expect(orchestrator.storeInstance.get('t2')!.status).toBe('in_progress');
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('a spawn that fails after its session was attached stops that session and holds the task, without throwing out of tick', async () => {
    const { sessions, spawn, stop } = sessionRunner();
    const throwingOutput: TaskOutputSource = {
      attach: () => { throw new Error('attach blew up'); },
      detach: () => {},
      reset: () => {},
      finalText: () => '',
      report: () => undefined,
      handoff: () => undefined,
      liveTail: () => null,
    };
    const orchestrator = makeOrchestrator({ runner: { spawn, stop }, output: throwingOutput });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);

    await orchestrator.approveReview();

    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending'));
    expect(stop).toHaveBeenCalledWith(sessions[0].id);
    expectNoAttemptState(orchestrator);
  });

  it("starts each agent with its workspace's own variables, and says once when direnv has blocked them", async () => {
    const { spawn } = sessionRunner();
    const warn = vi.fn();
    const orchestrator = makeOrchestrator({
      runner: { spawn },
      notifications: { warn },
      workspaceEnv: async () => ({
        env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' }, blockedEnvrc: '/repo/.envrc', refused: [], trackedEnvFile: null,
      }),
    });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);

    await orchestrator.approveReview();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

    expect(spawn.mock.calls.map(([o]) => o.env)).toEqual([{ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' }, { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('direnv has blocked /repo/.envrc, so tasks start without its variables. Run `direnv allow` in /repo to use them.');
  });

  it('retrying the task whose failure paused a full run resumes that run', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] }),
    ]);
    await orchestrator.approveReview();
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    await orchestrator.retryTask('t1');

    expect(orchestrator.getAttempt('t1')).toMatchObject({ attempt: 2, phase: 'running' });
    sessions[1].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
    expect(spawn.mock.calls[2][0].taskId).toBe('t2');
  });

  it('retrying a task that failed on its own does not start the rest of the plan', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    orchestrator.stop();
    await orchestrator.forceStartTask('t1');
    sessions.at(-1)!.emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    const before = spawn.mock.calls.length;

    await orchestrator.retryTask('t1');

    expect(spawn).toHaveBeenCalledTimes(before);
  });

  it('stop during an in-flight spawn that then fails returns the task to pending', async () => {
    const { spawn, fail, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));

    orchestrator.stop();
    await fail(0, new Error('runner not found'));

    expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');
    expectNoAttemptState(orchestrator);
    expect(orchestrator.isRunning).toBe(false);
  });

  /** One task more than a tick starts at once, so the last waits for an attach. */
  const pastTheStarts = () => Array.from({ length: STARTS_AT_ONCE + 1 }, (_, i) => createTask({ id: `t${i + 1}`, order: i + 1, title: `Task ${i + 1}`, prompt: 'do it' }));

  it('stop during a tick\'s spawns starts none of the tasks after them', async () => {
    const { spawn, settle, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ runner: { spawn }, config: { maxParallelSessions: STARTS_AT_ONCE + 1 } });
    orchestrator.loadPlan(pastTheStarts());
    void orchestrator.approveReview();
    await vi.waitFor(() => expect(spawned()).toBe(STARTS_AT_ONCE));

    orchestrator.stop();
    await settle(0, new FakeRunnerSession('late', 't1'));
    await flushMicrotasks();

    expect(spawned()).toBe(STARTS_AT_ONCE);
    expect(orchestrator.hasLiveWork).toBe(false);
    expect(orchestrator.storeInstance.allTasks.every((t) => t.status === 'pending')).toBe(true);
  });

  it('a plan loaded during a tick\'s spawn is not handed tasks the old plan had ready', async () => {
    const { spawn, settle, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ runner: { spawn }, config: { maxParallelSessions: STARTS_AT_ONCE + 1 } });
    orchestrator.loadPlan(pastTheStarts());
    void orchestrator.approveReview();
    await vi.waitFor(() => expect(spawned()).toBe(STARTS_AT_ONCE));

    orchestrator.loadPlan([createTask({ id: 'n1', order: 1, title: 'New', prompt: 'do new' })]);
    await settle(0, new FakeRunnerSession('late', 't1'));
    await flushMicrotasks();

    const started = spawn.mock.calls.map((call) => (call as unknown as [{ taskId: string }])[0].taskId);
    expect(started).not.toContain(`t${STARTS_AT_ONCE + 1}`);
    expect(orchestrator.storeInstance.get('t2')).toBeUndefined();
  });

  it('a verdict whose output cannot be read fails the task instead of leaving it live', async () => {
    const { sessions, spawn } = sessionRunner();
    const output = new BufferedTaskOutputSource();
    output.finalText = () => { throw new Error('output unreadable'); };
    const notifications = fakeNotification();
    const orchestrator = makeOrchestrator({ runner: { spawn }, output, notifications });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    await orchestrator.approveReview();

    sessions[0].reportComplete({ status: 'done', summary: '' });

    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    expect(orchestrator.hasLiveWork).toBe(false);
    expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('output unreadable'));
  });

  it('marking a task complete while its spawn is in flight keeps it completed when the spawn lands', async () => {
    const { spawn, settle, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));

    await orchestrator.markTaskComplete('t1');
    const late = new FakeRunnerSession('late', 't1');
    await settle(0, late);

    expect(late.killed).toBe(true);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed');
    expect(orchestrator.storeInstance.isCompleted('t1')).toBe(true);
    expectNoAttemptState(orchestrator);
  });

  // stop() kills the runners before it resets the verifier, and a tmux runner
  // fires the exit from inside stopAll() — a verdict raised there must not
  // fail a task the user merely stopped.
  it('an exit fired synchronously from stopAll does not record a verdict', async () => {
    const { sessions, spawn } = sessionRunner();
    const stopAll = vi.fn(() => sessions.forEach((s) => s.emitExit(-1)));
    const orchestrator = makeOrchestrator({ runner: { spawn, stopAll } });
    const onExecutionComplete = vi.fn();
    orchestrator.subscribe({ onExecutionComplete });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    await orchestrator.approveReview();

    orchestrator.stop();
    await flushMicrotasks();

    expect(orchestrator.storeInstance.get('t1')!.verdict).toBeUndefined();
    expect(orchestrator.storeInstance.isFailed('t1')).toBe(false);
    expect(onExecutionComplete).not.toHaveBeenCalled();
  });

  // loadPlan ends attempts without killing their runners, and a plan reload
  // keeps task ids — the old runner's exit must not decide the new attempt.
  it('a runner left over from before a plan load cannot fail the reloaded task', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    const plan = () => [createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })];
    orchestrator.loadPlan(plan());
    await orchestrator.forceStartTask('t1');

    orchestrator.loadPlan(plan());
    await orchestrator.forceStartTask('t1');
    sessions[0].emitExit(1);
    await flushMicrotasks();

    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
    expect(orchestrator.getAttempt('t1')).toMatchObject({ sessionId: 's2', phase: 'running' });
    sessions[1].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
  });

  // Retrying a task whose runner is still up used to leave the old attempt
  // registered, so the scheduler could never start the retry.
  it('retrying a live task stops its runner so the retry can start', async () => {
    const { spawn, stop } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn, stop } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    await orchestrator.forceStartTask('t1');

    await orchestrator.retryTask('t1');

    expect(stop).toHaveBeenCalledWith('s1');
    expectNoAttemptState(orchestrator);
    await orchestrator.forceStartTask('t1');
    expect(orchestrator.getAttempt('t1')).toMatchObject({ attempt: 2, sessionId: 's2' });
  });
});

describe('TaskOrchestrator task output', () => {
  const settle = () => flushMicrotasks();

  it('summarizes an exit with no task_complete call from what the turn said, escapes removed', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'T', prompt: 'do' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('\x1b[31mtests failed: 2 of 40\x1b[0m\n');
    sessions[0].emitExit(1);
    await settle();

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.verdict?.outcome).toBe('fail');
    expect(task.outputSummary?.logTail).toBe('tests failed: 2 of 40');
  });
  it('summarizes a finished task by what it reported through task_complete', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'T', prompt: 'do' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('terminal noise\n');
    sessions[0].reportComplete({ status: 'done', summary: 'Renamed the module and updated imports.' });
    await settle();

    expect(orchestrator.storeInstance.get('t1')!.handoff?.summary).toBe('Renamed the module and updated imports.');
  });
  it('exposes a running task\'s recent output, rendered clean', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'T', prompt: 'do' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('\x1b[1mcompiling\x1b[0m\nlinking\n');

    expect(orchestrator.getLiveOutput('t1', { maxLines: 1 })).toEqual({ text: 'linking', nextOffset: 26, running: true });
    expect(orchestrator.getLiveOutput('t2', { maxLines: 1 })).toBeNull();

    sessions[0].emitExit(1);
    await settle();
    expect(orchestrator.getLiveOutput('t1', { maxLines: 5 })).toMatchObject({ text: 'compiling\nlinking', running: false });
  });
});

describe('TaskOrchestrator — retrying an ops task (ADR-0020)', () => {
  const opsTask = () => createTask({ id: 'o1', order: 1, title: 'Deploy', prompt: 'deploy it', ops: true });

  async function retryAfterFailure(options: { previousAttemptFromLog?: (taskId: string) => string | null; firstAttemptOutput?: string }) {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn }, previousAttemptFromLog: options.previousAttemptFromLog });
    orchestrator.loadPlan([opsTask()]);
    await orchestrator.approveReview();
    if (options.firstAttemptOutput) sessions[0].emitOutput(options.firstAttemptOutput);
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('o1')!.status).toBe('failed'));
    await orchestrator.retryTask('o1');
    await orchestrator.start();
    return spawn.mock.calls[1][0].prompt;
  }

  it('tells the retry what the last attempt did, from its saved log', async () => {
    const prompt = await retryAfterFailure({ previousAttemptFromLog: () => '- Bash {"command":"az group create"} → ok' });

    expect(prompt).toContain('## Previous attempt');
    expect(prompt).toContain('  - Bash {"command":"az group create"} → ok');
  });

  it('says the last attempt\'s output is gone when a reload left neither a log nor a buffer', async () => {
    const { spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([{ ...opsTask(), status: 'failed' }]);

    await orchestrator.retryTask('o1');
    await orchestrator.forceStartTask('o1');

    const prompt = spawn.mock.calls[0][0].prompt;
    expect(prompt).toContain('## Previous attempt');
    expect(prompt).toContain('Its output is not available: this session was reloaded since it ran.');
  });

  it('adds nothing to the first attempt', async () => {
    const { spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([opsTask()]);

    await orchestrator.forceStartTask('o1');

    expect(spawn.mock.calls[0][0].prompt).not.toContain('## Previous attempt');
  });

  it('keeps the live output tail when a runner left no log', async () => {
    const prompt = await retryAfterFailure({ previousAttemptFromLog: () => null, firstAttemptOutput: 'created rg-dev\n' });

    expect(prompt).toContain('  created rg-dev');
    expect(prompt).not.toContain('Its output is not available');
  });

  it('tells a change task\'s retry nothing about the attempt before', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn }, previousAttemptFromLog: () => '- Bash {} → ok' });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Change', prompt: 'edit' })]);
    await orchestrator.approveReview();
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    await orchestrator.retryTask('t1');
    await orchestrator.start();

    expect(spawn.mock.calls[1][0].prompt).not.toContain('## Previous attempt');
  });
});

describe('persisted attempt accounting', () => {
  it('captures live usage, ends wall time on cancel, and keeps numbering across reloads', async () => {
    const runner = sessionRunner();
    const orchestrator = makeOrchestrator({ runner });
    orchestrator.loadPlan([createTask({ id: 't', prompt: 'Work' })]);
    const changed = vi.fn();
    orchestrator.subscribe({ onUsageChanged: changed });
    await orchestrator.forceStartTask('t');
    const session = runner.sessions[0];
    session.emitEvent({ type: 'usage', record: { source: 'codex', model: 'a', inputTokens: 10 } });
    expect(changed).toHaveBeenCalledOnce();
    expect(orchestrator.storeInstance.get('t')?.attemptUsage?.[0].totals).toEqual({ inputTokens: 10 });
    await orchestrator.cancelTask('t');
    const saved = orchestrator.storeInstance.snapshot();
    expect(saved[0].attemptUsage?.[0].endedAt).toBeDefined();
    session.emitEvent({ type: 'usage', record: { source: 'codex', model: 'a', inputTokens: 100 } });
    orchestrator.loadPlan(saved);
    await orchestrator.forceStartTask('t');
    expect(orchestrator.storeInstance.get('t')?.attemptUsage?.map((u) => u.attempt)).toEqual([1, 2]);
    expect(orchestrator.storeInstance.get('t')?.attemptUsage?.[0].totals.inputTokens).toBe(10);
    expect(orchestrator.storeInstance.get('t')?.attemptUsage?.[1].totals).toEqual({});
    orchestrator.stop();
  });
});

/**
 * An attempt that is over stops its runner, which winds its turn down
 * (ADR-0018, L1): Claude Code reports a turn's cost only on its `result` line,
 * after the `task_complete` that settled the attempt.
 */
describe('what a runner reports while it winds down', () => {
  /** {@link sessionRunner}, whose stop winds a session down until the test ends it with `emitExit`. */
  function windingRunner() {
    const runner = sessionRunner();
    const stop = vi.fn((id: string) => runner.sessions.find((s) => s.id === id)?.stop() ?? Promise.resolve());
    return { ...runner, stop };
  }

  const lastCall = { type: 'usage', record: { source: 'claude-code', model: 'opus', inputTokens: 2000, outputTokens: 30 } } as const;
  const turnCost = { type: 'usage', record: { source: 'claude-code', model: 'opus', aggregate: true, reportedCost: { amount: 0.25, currency: 'USD' } } } as const;

  it('lands the last call and the cost in the attempt task_complete settled, with the count its session ended on', async () => {
    const runner = windingRunner();
    const orchestrator = makeOrchestrator({ runner });
    orchestrator.loadPlan([createTask({ id: 't', prompt: 'Work' })]);
    const changed = vi.fn();
    orchestrator.subscribe({ onUsageChanged: changed });
    await orchestrator.forceStartTask('t');
    const session = runner.sessions[0];
    session.cost = { sessionId: 'native-1', usd: 0.5, modelUsd: { opus: 0.5 } };

    session.reportComplete({ status: 'done', summary: 'Done.' });
    session.emitTurnEnd('completed');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t')!.status).toBe('completed'));
    expect(session.stopped).toBe(true);
    session.emitEvent(lastCall);
    session.emitEvent(turnCost);
    session.cost = { sessionId: 'native-1', usd: 0.75, modelUsd: { opus: 0.75 } };
    session.emitExit(1);

    const [ledger] = orchestrator.storeInstance.get('t')!.attemptUsage!;
    expect(ledger.totals).toEqual({ inputTokens: 2000, outputTokens: 30, reportedCost: { USD: 0.25 } });
    expect(ledger.runnerSessionCost).toEqual({ sessionId: 'native-1', usd: 0.75, modelUsd: { opus: 0.75 } });
    expect(ledger.sessionId).toBe('native-1');
    expect(changed).toHaveBeenCalledTimes(3);
  });

  // Whatever a runner does after its verdict would go unverified, and a landing can take a while.
  it('stops the runner as its verdict is accepted, before the landing', async () => {
    const runner = windingRunner();
    const isolation = new FakeWorktreeIsolation();
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig(), notifications: fakeNotification(), runner: { ...fakeTerminalRunner(), ...runner } as IRunner,
      output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => '/repo',
    });
    orchestrator.loadPlan([createTask({ id: 't', prompt: 'Work' })]);
    await orchestrator.forceStartTask('t');
    const open = isolation.holdIntegration('t');

    runner.sessions[0].reportComplete({ status: 'done', summary: 'Done.' });
    expect(runner.sessions[0].stopped).toBe(true);
    runner.sessions[0].emitTurnEnd('completed');
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t']));

    expect(orchestrator.storeInstance.get('t')!.status).toBe('in_progress');
    runner.sessions[0].emitEvent(turnCost);
    open();
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t')!.status).toBe('completed'));
    expect(orchestrator.storeInstance.get('t')!.attemptUsage![0].totals.reportedCost).toEqual({ USD: 0.25 });
  });

  it.each([
    ['cancel', (o: TaskOrchestrator) => o.cancelTask('t')],
    ['retry', (o: TaskOrchestrator) => o.retryTask('t')],
    ['mark complete', (o: TaskOrchestrator) => o.markTaskComplete('t')],
    ['skip, waiting for input', (o: TaskOrchestrator, session: FakeRunnerSession) => { session.waitForInput(); return o.skipTask('t'); }],
  ])('keeps what the runner reports as it winds down after a %s', async (_end, end) => {
    const runner = windingRunner();
    const orchestrator = makeOrchestrator({ runner });
    orchestrator.loadPlan([createTask({ id: 't', prompt: 'Work' })]);
    await orchestrator.forceStartTask('t');
    const session = runner.sessions[0];
    session.cost = { sessionId: 'native-1', usd: 0.5, modelUsd: { opus: 0.5 } };

    await end(orchestrator, session);
    expect(session.stopped).toBe(true);
    session.emitEvent(lastCall);
    session.emitEvent(turnCost);
    session.cost = { sessionId: 'native-1', usd: 0.75, modelUsd: { opus: 0.75 } };
    session.emitExit(1);

    const ledger = orchestrator.storeInstance.get('t')!.attemptUsage!.find((u) => u.attempt === 1)!;
    expect(ledger.totals).toEqual({ inputTokens: 2000, outputTokens: 30, reportedCost: { USD: 0.25 } });
    expect(ledger.runnerSessionCost).toEqual({ sessionId: 'native-1', usd: 0.75, modelUsd: { opus: 0.75 } });
  });

  it('keeps what a runner that ignored the interrupt reported before it was killed', async () => {
    const runner = windingRunner();
    const orchestrator = makeOrchestrator({ runner });
    orchestrator.loadPlan([createTask({ id: 't', prompt: 'Work' })]);
    await orchestrator.forceStartTask('t');
    const session = runner.sessions[0];
    session.cost = { sessionId: 'native-1', usd: 0.5, modelUsd: { opus: 0.5 } };

    await orchestrator.cancelTask('t');
    session.emitEvent(lastCall);
    session.emitExit(-1);

    const [ledger] = orchestrator.storeInstance.get('t')!.attemptUsage!;
    expect(ledger.totals).toEqual({ inputTokens: 2000, outputTokens: 30 });
    expect(ledger.runnerSessionCost).toEqual({ sessionId: 'native-1', usd: 0.5, modelUsd: { opus: 0.5 } });
  });

  it('never lets a plan adopted under a winding-down runner take its late usage', async () => {
    const runner = windingRunner();
    const orchestrator = makeOrchestrator({ runner });
    orchestrator.loadPlan([createTask({ id: 't', prompt: 'Work' })]);
    await orchestrator.forceStartTask('t');
    const [old] = runner.sessions;
    old.cost = { sessionId: 'old-session', usd: 0, modelUsd: {} };

    // The next plan reuses the id and already holds an attempt of its own.
    const next = createTask({
      id: 't',
      prompt: 'Other',
      runnerSessionId: 'next-session',
      runnerSessionOwner: 'claude-code',
      attemptUsage: [{
        attempt: 1, runner: 'claude-code', startedAt: '2026-10-19T00:00:00Z', endedAt: '2026-10-19T00:01:00Z',
        wallTimeMs: 60_000, totals: { reportedCost: { USD: 3 } }, byModel: [],
        sessionId: 'next-session', runnerSessionCost: { sessionId: 'next-session', usd: 3, modelUsd: {} },
      }],
    });
    orchestrator.stop();
    orchestrator.loadPlan([next]);

    old.emitEvent(turnCost);
    old.cost = { sessionId: 'old-session', usd: 0.25, modelUsd: {} };
    old.emitExit(1);
    await flushMicrotasks();

    const [ledger] = orchestrator.storeInstance.get('t')!.attemptUsage!;
    expect(ledger.totals.reportedCost).toEqual({ USD: 3 });
    expect(ledger.runnerSessionCost).toEqual({ sessionId: 'next-session', usd: 3, modelUsd: {} });
    expect(ledger.sessionId).toBe('next-session');
  });

  it('keeps a retry\'s ledger apart from the attempt whose runner still winds down', async () => {
    const runner = windingRunner();
    const orchestrator = makeOrchestrator({ runner });
    orchestrator.loadPlan([createTask({ id: 't', prompt: 'Work' })]);
    await orchestrator.forceStartTask('t');
    const [first] = runner.sessions;

    await orchestrator.retryTask('t');
    await orchestrator.forceStartTask('t');
    const second = runner.sessions[1];
    expect(second).toBeDefined();
    first.emitEvent(turnCost);
    second.emitEvent(lastCall);
    first.emitEvent(lastCall);
    first.emitExit(1);
    second.emitEvent(turnCost);

    const ledgers = orchestrator.storeInstance.get('t')!.attemptUsage!;
    expect(ledgers.map((u) => [u.attempt, u.totals])).toEqual([
      [1, { inputTokens: 2000, outputTokens: 30, reportedCost: { USD: 0.25 } }],
      [2, { inputTokens: 2000, outputTokens: 30, reportedCost: { USD: 0.25 } }],
    ]);
    expect(ledgers[1].endedAt).toBeUndefined();
    orchestrator.stop();
  });

  it('continues a session only once its runner wound down, counting from what it ended on', async () => {
    const runner = windingRunner();
    const orchestrator = makeOrchestrator({ runner });
    orchestrator.loadPlan([createTask({ id: 't', prompt: 'Work' })]);
    await orchestrator.forceStartTask('t');
    const session = runner.sessions[0];
    session.cost = { sessionId: 'native-1', usd: 0.5, modelUsd: { opus: 0.5 } };
    session.reportComplete({ status: 'done', summary: 'Done.' });
    session.emitTurnEnd('completed');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t')!.status).toBe('completed'));

    const continuing = orchestrator.continueTask('t', 'Also cover the empty case');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runner.spawn).toHaveBeenCalledTimes(1);
    session.emitEvent(turnCost);
    session.cost = { sessionId: 'native-1', usd: 0.75, modelUsd: { opus: 0.75 } };
    session.emitExit(1);
    await continuing;

    expect(runner.spawn).toHaveBeenCalledTimes(2);
    expect(runner.spawn.mock.calls[1][0]).toMatchObject({ resumeSessionId: 'native-1', resumeCost: { sessionId: 'native-1', usd: 0.75, modelUsd: { opus: 0.75 } } });
    orchestrator.stop();
  });

  it('keeps what the runners report as they wind down after the user stops the run', async () => {
    const runner = windingRunner();
    const orchestrator = makeOrchestrator({ runner });
    orchestrator.loadPlan([createTask({ id: 't', prompt: 'Work' })]);
    await orchestrator.forceStartTask('t');
    const session = runner.sessions[0];

    orchestrator.stop();
    expect(session.stopped).toBe(true);
    session.emitEvent(turnCost);
    session.cost = { sessionId: 'native-1', usd: 0.25, modelUsd: { opus: 0.25 } };
    session.emitExit(1);

    const [ledger] = orchestrator.storeInstance.get('t')!.attemptUsage!;
    expect(ledger.totals).toEqual({ reportedCost: { USD: 0.25 } });
    expect(ledger.runnerSessionCost).toEqual({ sessionId: 'native-1', usd: 0.25, modelUsd: { opus: 0.25 } });
    expect(orchestrator.storeInstance.get('t')!.status).toBe('pending');
  });
});

describe('a plan load refused for a task on a runner outside the plan\'s set', () => {
  it('leaves the run, its plan and its runners as they were', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ runner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Running', prompt: 'do it' })], ['claude-code']);
    await orchestrator.approveReview();
    expect(spawn).toHaveBeenCalledTimes(1);

    expect(() => orchestrator.loadPlan([createTask({ id: 'n1', order: 1, title: 'Foreign', prompt: 'p', assignedRunner: 'codex' })], ['claude-code']))
      .toThrow('not in the plan\'s runner set');

    expect(orchestrator.storeInstance.allTasks.map((t) => [t.id, t.status])).toEqual([['t1', 'in_progress']]);
    expect(orchestrator.hasLiveWork).toBe(true);
    expect(orchestrator.isReviewApproved).toBe(true);
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
  });
});

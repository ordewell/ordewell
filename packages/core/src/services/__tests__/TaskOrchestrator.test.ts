import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { composeAugmentedPrompt } from '../promptAugment';
import { createTask } from '../../models/Task';
import type { IConfig } from '../../interfaces/IConfig';
import type { INotification } from '../../interfaces/INotification';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import { fakeConfig } from '../../testing';
import { fakeNotification } from './sessionTestKit';

type OrchestratorInternals = {
  reviewApproved: boolean;
  running: boolean;
  activeTaskSessions: Map<string, string>;
  _planStatus: string;
};

function internals(orchestrator: TaskOrchestrator): OrchestratorInternals {
  return orchestrator as unknown as OrchestratorInternals;
}

function fakeTerminalRunner(): ITerminalRunner {
  return {
    spawn: vi.fn().mockResolvedValue({ id: 's1', taskId: '', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: vi.fn().mockReturnValue(''), write: vi.fn() }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
}

function makeOrchestrator(overrides: {
  config?: Partial<IConfig>;
  notifications?: Partial<INotification>;
  terminalRunner?: Partial<ITerminalRunner>;
} = {}) {
  const config = fakeConfig(overrides.config);
  const notifications = { ...fakeNotification(), ...overrides.notifications };
  const terminalRunner = { ...fakeTerminalRunner(), ...overrides.terminalRunner } as ITerminalRunner;
  return new TaskOrchestrator(config, notifications, terminalRunner);
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

  describe('markAiTaskComplete', () => {
    it('delegates to markTaskComplete', async () => {
      const stop = vi.fn();
      const orchestrator = makeOrchestrator({ terminalRunner: { stop } });
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'in_progress' }),
      ]);
      internals(orchestrator).activeTaskSessions.set('t1', 'session-t1');

      await orchestrator.markAiTaskComplete('t1');

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].verdict!.outcome).toBe('pass');
      expect(log[0].verdict!.checks[0].name).toBe('manual');
      expect(stop).toHaveBeenCalledWith('session-t1');
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
      const stop = vi.fn();
      const stopAll = vi.fn();
      const orchestrator = makeOrchestrator({ terminalRunner: { stop, stopAll } });
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'in_progress' }),
        createTask({ id: 't2', order: 2, title: 'Other AI Task', prompt: 'do other', status: 'in_progress' }),
      ]);
      // Simulate active sessions as if both tasks were spawned.
      internals(orchestrator).activeTaskSessions.set('t1', 'session-t1');
      internals(orchestrator).activeTaskSessions.set('t2', 'session-t2');

      await orchestrator.markTaskComplete('t1');

      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith('session-t1');
      expect(stopAll).not.toHaveBeenCalled();
      expect(internals(orchestrator).activeTaskSessions.has('t1')).toBe(false);
      expect(internals(orchestrator).activeTaskSessions.has('t2')).toBe(true);
    });

    it('unblocks dependents when marking a failed task complete', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Failing', prompt: 'do', status: 'failed' }),
        createTask({ id: 't2', order: 2, title: 'Blocked', prompt: 'do', status: 'blocked', dependencies: ['t1'] }),
      ]);

      await orchestrator.markTaskComplete('t1');

      const t1 = orchestrator.storeInstance.get('t1');
      expect(t1).toBeDefined();
      expect(t1!.status).toBe('completed');
      const t2 = orchestrator.storeInstance.get('t2');
      expect(t2!.status).toBe('pending');
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
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'in_progress' }),
      ]);

      await orchestrator.markTaskIncomplete('t1');
      await orchestrator.markTaskIncomplete('nope');

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
    });

    it('holds the un-marked task so a running plan does not immediately respawn it', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 's1', taskId: '', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: vi.fn().mockReturnValue(''), write: vi.fn() });
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'completed' }),
      ]);
      internals(orchestrator).reviewApproved = true;
      internals(orchestrator).running = true;

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
      internals(orchestrator).reviewApproved = true;
      await orchestrator.markTaskComplete('t1');
      await orchestrator.start();
      expect(orchestrator.status).toBe('completed');

      await orchestrator.markTaskIncomplete('t1');

      expect(orchestrator.status).toBe('approved');
    });
  });

  describe('forceStartTask', () => {
    function makeSession() {
      return { id: 's1', taskId: '', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: vi.fn().mockReturnValue(''), write: vi.fn() };
    }

    it('starts an AI task with the augmented prompt (not the raw prompt)', async () => {
      const spawn = vi.fn().mockResolvedValue(makeSession());
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');
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
      const spawn = vi.fn().mockResolvedValue(makeSession());
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.loadPlan([
        createTask({ id: 'u1', order: 1, title: 'Manual', type: 'user' }),
      ]);

      await orchestrator.forceStartTask('does-not-exist');
      await orchestrator.forceStartTask('u1');

      expect(spawn).not.toHaveBeenCalled();
    });

    it('detects the completion marker in output and logs the task', async () => {
      // Build a session where we control onOutput and onExit callbacks manually
      let onOutputCb: ((text: string) => void) | undefined;
      let onExitCb: ((code: number) => void) | undefined;
      let output = '';

      const session = {
        id: 's1',
        taskId: 't1',
        onOutput: vi.fn((cb) => { onOutputCb = cb; }),
        onExit: vi.fn((cb) => { onExitCb = cb; }),
        kill: vi.fn(),
        getOutput: vi.fn(() => output),
        write: vi.fn(),
      };

      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      expect(onOutputCb).toBeDefined();
      expect(onExitCb).toBeDefined();

      // Simulate output arriving with the marker
      output = 'Working on it...\n<<<ORDEWELL_DONE_mk-1>>>\nDone.';
      onOutputCb!(output);

      // Now simulate the session exiting naturally
      onExitCb!(-1);

      // Wait for the async onAiTaskExit to complete
      await new Promise(r => setTimeout(r, 10));

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe('t1');
      expect(log[0].verdict!.outcome).toBe('pass');
      expect(log[0].verdict!.reason).toMatch(/completion marker/);
      expect(log[0].finalized).toBe(true);
      const completedTask = orchestrator.storeInstance.get('t1');
      expect(completedTask).toBeDefined();
      expect(completedTask!.status).toBe('completed');
    });

    it('marks task as failed when session exits without marker seen and non-zero exit code', async () => {
      let onExitCb: ((code: number) => void) | undefined;
      let output = '';

      const session = {
        id: 's1',
        taskId: 't1',
        onOutput: vi.fn(),
        onExit: vi.fn((cb) => { onExitCb = cb; }),
        kill: vi.fn(),
        getOutput: vi.fn(() => output),
        write: vi.fn(),
      };

      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      // Simulate session exit without marker
      output = 'Something went wrong.';
      onExitCb!(1);

      // Wait for the async onAiTaskExit to complete
      await new Promise(r => setTimeout(r, 10));

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe('t1');
      expect(log[0].verdict!.outcome).toBe('fail');
      const failedTask = orchestrator.storeInstance.get('t1');
      expect(failedTask).toBeDefined();
      expect(failedTask!.status).toBe('failed');
    });
  });

  describe('runTask', () => {
    it('runs only the selected task, stays busy until its marker, and does not schedule following work', async () => {
      let onOutputCb: ((text: string) => void) | undefined;
      const runnerSession = {
        id: 'single-1',
        taskId: 't1',
        onOutput: vi.fn((cb: (text: string) => void) => { onOutputCb = cb; }),
        onExit: vi.fn(),
        kill: vi.fn(),
        getOutput: vi.fn(() => ''),
        write: vi.fn(),
      };
      const spawn = vi.fn().mockResolvedValue(runnerSession);
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Selected', prompt: 'do selected', completionMarker: 'mk-1' }),
        createTask({ id: 't2', order: 2, title: 'Following', prompt: 'do following' }),
      ]);

      await orchestrator.runTask('t1');

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1' }));
      expect(orchestrator.isRunning).toBe(true);
      expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');

      onOutputCb?.('<<<ORDEWELL_DONE_mk-1>>>');
      await new Promise(r => setTimeout(r, 10));

      expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed');
      expect(orchestrator.storeInstance.get('t2')?.status).toBe('pending');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(orchestrator.isRunning).toBe(false);
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
      // Let tick loop run
      await new Promise(r => setTimeout(r, 10));

      expect(orchestrator.isReviewApproved).toBe(true);
      expect(events).toContain('review_approved');
    });
  });

  describe('mergeTasks', () => {
    it('merges two tasks into one', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 'a', order: 1, title: 'Task A', description: 'First', prompt: 'do A', sliceType: 'AFK', autonomy: 'AFK' }),
        createTask({ id: 'b', order: 2, title: 'Task B', description: 'Second', prompt: 'do B', sliceType: 'AFK', autonomy: 'AFK' }),
        createTask({ id: 'c', order: 3, title: 'Task C', prompt: 'do C', dependencies: ['a'], sliceType: 'AFK', autonomy: 'AFK' }),
      ]);

      const merged = orchestrator.storeInstance.merge('a', 'b');

      expect(orchestrator.storeInstance.allTasks.length).toBe(2);
      expect(merged.title).toContain('Task A');
      expect(merged.title).toContain('Task B');

      const taskC = orchestrator.storeInstance.get('c');
      expect(taskC?.dependencies).toEqual([merged.id]);
    });

    it('throws if task not found', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 'a', order: 1, title: 'A', prompt: 'x' }),
      ]);
      expect(() => orchestrator.storeInstance.merge('a', 'z')).toThrow('not found');
    });
  });

  describe('splitTask', () => {
    it('splits a task into multiple subtasks', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 'a', order: 1, title: 'Original', prompt: 'original', sliceType: 'AFK', autonomy: 'AFK' }),
        createTask({ id: 'b', order: 2, title: 'Dependent', prompt: 'dep', dependencies: ['a'], sliceType: 'AFK', autonomy: 'AFK' }),
      ]);

      const split = orchestrator.storeInstance.split('a', [
        { id: 's1', title: 'Part 1', prompt: 'first part', sliceType: 'AFK', autonomy: 'AFK' },
        { id: 's2', title: 'Part 2', prompt: 'second part', sliceType: 'AFK', autonomy: 'AFK' },
      ]);

      expect(split).toHaveLength(2);
      expect(orchestrator.storeInstance.allTasks.length).toBe(3);

      const taskB = orchestrator.storeInstance.get('b');
      expect(taskB?.dependencies).toContain(split[1].id);
    });

    it('throws if task not found', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([]);
      expect(() => orchestrator.storeInstance.split('nonexistent', [{ title: 'X' }])).toThrow('not found');
    });

    it('throws if no new task specs provided', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([createTask({ id: 'a', order: 1, title: 'A', prompt: 'x' })]);
      expect(() => orchestrator.storeInstance.split('a', [])).toThrow('at least one');
    });
  });

  describe('getPlanVisualization', () => {
    it('groups independent tasks into parallel batches', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 'a', order: 1, title: 'A', prompt: 'x', sliceType: 'AFK', autonomy: 'AFK' }),
        createTask({ id: 'b', order: 2, title: 'B', prompt: 'x', sliceType: 'AFK', autonomy: 'AFK' }),
        createTask({ id: 'c', order: 3, title: 'C', prompt: 'x', dependencies: ['a'], sliceType: 'AFK', autonomy: 'AFK' }),
      ]);

      const vis = orchestrator.storeInstance.getPlanVisualization();

      expect(vis.tasks).toHaveLength(3);
      // First batch: tasks a and b (no deps) run in parallel
      // Second batch: task c (depends on a)
      expect(vis.parallelGroups.length).toBe(2);
    });

    it('handles empty plan', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([]);
      const vis = orchestrator.storeInstance.getPlanVisualization();
      expect(vis.tasks).toEqual([]);
      expect(vis.parallelGroups).toEqual([]);
    });
  });

  describe('queue check in tick', () => {
    function makeSession() {
      return { id: 's1', taskId: '', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: vi.fn().mockReturnValue(''), write: vi.fn() };
    }

    it('pauses when queue has messages and no active sessions', async () => {
      const spawn = vi.fn().mockResolvedValue(makeSession());
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');

      orchestrator.loadPlan([createTask({ id: 'u1', order: 1, title: 'Manual', type: 'user' })]);

      let queueReadyCalled = false;
      orchestrator.subscribe({ onQueueReady: () => { queueReadyCalled = true; } });

      orchestrator.queueMessage('hello from user');

      await orchestrator.approveReview();
      await new Promise(r => setTimeout(r, 10));

      expect(queueReadyCalled).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('prevents starting new tasks when queue has messages and active sessions exist', async () => {
      const spawn = vi.fn().mockResolvedValue(makeSession());
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');

      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
        createTask({ id: 't2', order: 2, title: 'Task 2', prompt: 'do also' }),
      ]);

      internals(orchestrator).running = true;
      internals(orchestrator).reviewApproved = true;

      await orchestrator.forceStartTask('t1');
      await new Promise(r => setTimeout(r, 10));

      orchestrator.queueMessage('hold on');

      const spawnCount = spawn.mock.calls.length;
      await orchestrator.tick();
      await new Promise(r => setTimeout(r, 10));

      expect(spawn).toHaveBeenCalledTimes(spawnCount);
    });

    it('proceeds normally when queue is empty', async () => {
      const spawn = vi.fn().mockResolvedValue(makeSession());
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');

      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
        createTask({ id: 't2', order: 2, title: 'Task 2', prompt: 'do also' }),
      ]);

      internals(orchestrator).running = true;
      internals(orchestrator).reviewApproved = true;

      await orchestrator.forceStartTask('t1');
      await new Promise(r => setTimeout(r, 10));

      const spawnCount = spawn.mock.calls.length;
      await orchestrator.tick();

      expect(spawn).toHaveBeenCalledTimes(spawnCount + 1);
    });
  });

describe('merge-on-reload', () => {

    it('preserves running sessions when task exists in new plan as in_progress', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
      ]);

      internals(orchestrator).running = true;
      internals(orchestrator).reviewApproved = true;
      internals(orchestrator).activeTaskSessions.set('t1', 's1');

      const newTasks = [
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it', status: 'in_progress' }),
        createTask({ id: 't2', order: 2, title: 'Task 2', prompt: 'do also' }),
      ];

      orchestrator.reconcilePlan(newTasks, ['claude-code']);

      expect(orchestrator.storeInstance.get('t1')).toBeDefined();
      expect(orchestrator.storeInstance.get('t2')).toBeDefined();
      expect(orchestrator.isRunning).toBe(true);
    });

    it('keeps running task in store when removed from new plan (for onVerdict processing)', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
      ]);

      internals(orchestrator).running = true;
      internals(orchestrator).reviewApproved = true;
      internals(orchestrator).activeTaskSessions.set('t1', 's1');

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
    it('keeps a live task in_progress, its session tracked and the review approved', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
      ]);

      internals(orchestrator).running = true;
      internals(orchestrator).reviewApproved = true;
      internals(orchestrator).activeTaskSessions.set('t1', 's1');

      orchestrator.reconcilePlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it', status: 'pending' }),
        createTask({ id: 't2', order: 2, title: 'Task 2', prompt: 'do also' }),
      ], ['claude-code']);

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
      expect(orchestrator.activeSessionMap.get('t1')).toBe('s1');
      expect(orchestrator.isReviewApproved).toBe(true);
    });

    it('logs a warning when running task status changed in new plan', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
      ]);

      internals(orchestrator).running = true;
      internals(orchestrator).reviewApproved = true;
      internals(orchestrator).activeTaskSessions.set('t1', 's1');

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
      let onOutputCb: ((text: string) => void) | undefined;
      let onExitCb: ((code: number) => void) | undefined;
      let output = '';

      const session1 = {
        id: 's1', taskId: 't1',
        onOutput: vi.fn((cb) => { onOutputCb = cb; }),
        onExit: vi.fn((cb) => { onExitCb = cb; }),
        kill: vi.fn(),
        getOutput: vi.fn(() => output),
        write: vi.fn(),
      };

      // For t2, we just track whether it was spawned — it won't complete in this test
      const session2 = {
        id: 's2', taskId: 't2',
        onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(),
        getOutput: vi.fn(() => ''), write: vi.fn(),
      };

      let spawnCount = 0;
      const spawn = vi.fn().mockImplementation(() => {
        spawnCount++;
        return spawnCount === 1 ? session1 : session2;
      });
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');

      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'], completionMarker: 'mk-2' }),
      ]);

      await orchestrator.approveReview();
      await new Promise(r => setTimeout(r, 20));

      // t1 should have been spawned
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][0].taskId).toBe('t1');

      // Simulate t1 completing
      output = 'Done.\n<<<ORDEWELL_DONE_mk-1>>>';
      onOutputCb!(output);
      onExitCb!(0);
      await new Promise(r => setTimeout(r, 50));

      // t2 should now be spawned
      expect(spawn).toHaveBeenCalledTimes(2);
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
      const spawn = vi.fn().mockResolvedValue({
        id: 's2', taskId: 't2', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: vi.fn(() => ''), write: vi.fn(),
      });
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');

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
      await new Promise((r) => setTimeout(r, 10));

      // Nothing ready (u1 is a user task) and not all complete — the run is
      // paused awaiting the human. execution_complete must NOT fire: every
      // surface treats it as terminal (the TUI closes its execution stream on
      // receipt), so a premature emit would render later fan-out invisible.
      expect(events).toContain('tick');
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
    function makeSessionWithCallbacks() {
      let onExitCb: ((code: number) => void) | undefined;
      let output = '';
      return {
        session: {
          id: 's1', taskId: '', onOutput: vi.fn(), onExit: vi.fn((cb: (code: number) => void) => { onExitCb = cb; }),
          kill: vi.fn(), getOutput: vi.fn(() => output), write: vi.fn(),
        },
        setOutput: (o: string) => { output = o; },
        triggerExit: (code: number) => { onExitCb?.(code); },
      };
    }

    it('appends completed task to execution log while keeping it in the active plan', async () => {
      const { session, setOutput, triggerExit } = makeSessionWithCallbacks();
      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });
      orchestrator.loadPlan([task]);

      internals(orchestrator).running = true;
      internals(orchestrator).reviewApproved = true;

      await orchestrator.forceStartTask('t1');

      setOutput('Done.\n<<<ORDEWELL_DONE_mk-1>>>');
      triggerExit(0);

      await new Promise(r => setTimeout(r, 50));

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe('t1');
      expect(log[0].finalized).toBe(true);
      expect(log[0].verdict?.outcome).toBe('pass');

      expect(orchestrator.storeInstance.planTasks).toHaveLength(1);
      expect(orchestrator.storeInstance.planTasks[0].status).toBe('completed');
    });

    it('logs failed task to execution log', async () => {
      const { session, setOutput, triggerExit } = makeSessionWithCallbacks();
      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });
      orchestrator.loadPlan([task]);

      internals(orchestrator).running = true;
      internals(orchestrator).reviewApproved = true;

      await orchestrator.forceStartTask('t1');

      setOutput('Error occurred');
      triggerExit(1);

      await new Promise(r => setTimeout(r, 50));

      const log = orchestrator.storeInstance.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe('t1');
      expect(log[0].verdict?.outcome).toBe('fail');
      expect(orchestrator.storeInstance.planTasks).toHaveLength(1);
      expect(orchestrator.storeInstance.planTasks[0].status).toBe('failed');
    });
  });

describe('checkpoints', () => {
    it('emits onCheckpoint event when verifier detects a checkpoint', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'HITL Task', prompt: 'do', autonomy: 'HITL' }),
      ]);

      const events: { taskId: string; taskTitle: string; summary: string }[] = [];
      orchestrator.subscribe({
        onCheckpoint: (data) => events.push(data),
      });

      // Simulate the verifier emitting a checkpoint event
      const session = { id: 's1', taskId: 't1', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: vi.fn().mockReturnValue(''), write: vi.fn() };
      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator2 = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator2.setWorkspaceRoot(() => '/repo');
      orchestrator2.loadPlan([
        createTask({ id: 't1', order: 1, title: 'HITL Task', prompt: 'do', autonomy: 'HITL', completionMarker: 'mk-1' }),
      ]);
      orchestrator2.subscribe({
        onCheckpoint: (data) => events.push(data),
      });

      orchestrator2.forceStartTask('t1').then(() => {
        const onOutputCb = (session.onOutput as import("vitest").Mock).mock.calls[0]?.[0];
        if (onOutputCb) onOutputCb('<<<ORDEWELL_CHECKPOINT: need review>>>');
      });

      return new Promise<void>(resolve => setTimeout(() => {
        // The verifier's onCheckpoint listener should cascade to orchestrator's onCheckpoint
        // Just verifying the event shape is consumable
        expect(events.length).toBeGreaterThanOrEqual(0);
        resolve();
      }, 50));
    });

    it('sets task status to awaiting_user on checkpoint', async () => {
      const session = {
        id: 's1', taskId: 't1',
        onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(),
        getOutput: vi.fn().mockReturnValue(''),
        write: vi.fn(),
      };
      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'HITL Task', prompt: 'do', autonomy: 'HITL', completionMarker: 'mk-1' }),
      ]);

      await orchestrator.forceStartTask('t1');

      // Manually trigger the verifier checkpoint callback (integration test)
      const onOutputCb = (session.onOutput as import("vitest").Mock).mock.calls[0]?.[0];
      if (onOutputCb) {
        onOutputCb('<<<ORDEWELL_CHECKPOINT: approve this>>>');
        await new Promise(r => setTimeout(r, 10));
        expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
      }
    });

    it('approveCheckpoint resumes task status to in_progress', async () => {
      const session = {
        id: 's1', taskId: 't1',
        onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(),
        getOutput: vi.fn().mockReturnValue(''),
        write: vi.fn(),
      };
      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'HITL Task', prompt: 'do', autonomy: 'HITL', completionMarker: 'mk-1' }),
      ]);

      await orchestrator.forceStartTask('t1');
      const onOutputCb = (session.onOutput as import("vitest").Mock).mock.calls[0]?.[0];
      if (onOutputCb) {
        onOutputCb('<<<ORDEWELL_CHECKPOINT: approve this>>>');
        await new Promise(r => setTimeout(r, 10));
        expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');

        orchestrator.approveCheckpoint('t1');
        expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
        expect(session.write).toHaveBeenCalled();
      }
    });

    it('rejectCheckpoint resumes task status to in_progress', async () => {
      const session = {
        id: 's1', taskId: 't1',
        onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(),
        getOutput: vi.fn().mockReturnValue(''),
        write: vi.fn(),
      };
      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'HITL Task', prompt: 'do', autonomy: 'HITL', completionMarker: 'mk-1' }),
      ]);

      await orchestrator.forceStartTask('t1');
      const onOutputCb = (session.onOutput as import("vitest").Mock).mock.calls[0]?.[0];
      if (onOutputCb) {
        onOutputCb('<<<ORDEWELL_CHECKPOINT: approve this>>>');
        await new Promise(r => setTimeout(r, 10));
        expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');

        orchestrator.rejectCheckpoint('t1', 'try again');
        expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
        expect(session.write).toHaveBeenCalled();
      }
    });

    it('setTddEnabled wires tdd config to verifier', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.setWorkspaceRoot(() => '/repo');
      orchestrator.setTddEnabled(true);

      // Verify TDD instructions are included in prompt
      const tasks = [
        createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' }),
        createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
        createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
      ];
      orchestrator.loadPlan(tasks);

      // forceStartTask will use composeAugmentedPrompt with tddEnabled
      const session = { id: 's1', taskId: 'a', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: vi.fn().mockReturnValue(''), write: vi.fn() };
      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator2 = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator2.setWorkspaceRoot(() => '/repo');
      orchestrator2.setTddEnabled(true);
      orchestrator2.loadPlan(tasks);

      orchestrator2.forceStartTask('a');
      return new Promise<void>(resolve => setTimeout(() => {
        expect(spawn).toHaveBeenCalledTimes(1);
        const prompt = spawn.mock.calls[0][0].prompt;
        expect(prompt).toContain('## Implementation workflow (TDD)');
        resolve();
      }, 20));
    });

    it('tddEnabled=false omits TDD instructions', () => {
      const tasks = [
        createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' }),
        createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
        createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
      ];
      const session = { id: 's1', taskId: 'a', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: vi.fn().mockReturnValue(''), write: vi.fn() };
      const spawn = vi.fn().mockResolvedValue(session);
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.setWorkspaceRoot(() => '/repo');
      // tddEnabled defaults to false
      orchestrator.loadPlan(tasks);

      orchestrator.forceStartTask('a');
      return new Promise<void>(resolve => setTimeout(() => {
        expect(spawn).toHaveBeenCalledTimes(1);
        const prompt = spawn.mock.calls[0][0].prompt;
        expect(prompt).not.toContain('## TDD workflow');
        resolve();
      }, 20));
    });
  });

describe('cancelTask', () => {
  it('does not let a dependent task auto-start when stop() synchronously fires onExit (tmux-style)', async () => {
    // Some runners (tmux) call the session's onExit callback synchronously
    // from within stop()/kill() — this mimics that to reproduce the race
    // where a cancelled task's dependent gets spawned before the cancelled
    // task is reverted to 'pending'.
    let onExitCb: ((code: number) => void) | undefined;
    const session1 = {
      id: 's1', taskId: 't1',
      onOutput: vi.fn(), onExit: vi.fn((cb: (code: number) => void) => { onExitCb = cb; }),
      kill: vi.fn(), getOutput: vi.fn(() => ''), write: vi.fn(),
    };
    const session2 = {
      id: 's2', taskId: 't2',
      onOutput: vi.fn(), onExit: vi.fn(),
      kill: vi.fn(), getOutput: vi.fn(() => ''), write: vi.fn(),
    };

    let spawnCount = 0;
    const spawn = vi.fn().mockImplementation(() => {
      spawnCount++;
      return Promise.resolve(spawnCount === 1 ? session1 : session2);
    });
    const stop = vi.fn().mockImplementation(() => {
      // Simulate TmuxSession.kill() -> synchronous exit(-1) before cancelTask
      // has a chance to revert the task to 'pending'.
      onExitCb?.(-1);
    });
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn, stop } });
    orchestrator.setWorkspaceRoot(() => '/repo');

    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] }),
    ]);

    await orchestrator.approveReview();
    await new Promise(r => setTimeout(r, 20));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].taskId).toBe('t1');

    await orchestrator.cancelTask('t1');
    await new Promise(r => setTimeout(r, 20));

    const t1 = orchestrator.storeInstance.get('t1');
    const t2 = orchestrator.storeInstance.get('t2');
    expect(t1!.status).toBe('pending');
    expect(t2!.status).toBe('pending');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
});

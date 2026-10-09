import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { composeAugmentedPrompt } from '../promptAugment';
import { createTask } from '../../models/Task';
import type { IConfig } from '../../interfaces/IConfig';
import type { INotification } from '../../interfaces/INotification';
import type { ITerminalRunner, ITerminalSession } from '../../interfaces/ITerminalRunner';
import { fakeConfig, FakeTerminalSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { TaskOutputSource, TranscriptQuery, TranscriptReader } from '../../interfaces/TaskOutputSource';
import type { WorkspaceEnv } from '../workspaceEnv';
import { stripAnsi } from '../../utils/shell';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';

/** Never touches the real HOME: every orchestrator here reads transcripts from this. */
function fakeTranscripts(answers: Record<string, string> = {}): TranscriptReader & { queries: TranscriptQuery[] } {
  const queries: TranscriptQuery[] = [];
  return {
    queries,
    finalAssistantText: async (query) => {
      queries.push(query);
      return answers[query.marker] ?? null;
    },
  };
}

function fakeTerminalRunner(): ITerminalRunner {
  return {
    spawn: vi.fn(async () => new FakeTerminalSession()),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
}

/** Spawns {@link FakeTerminalSession}s the test can drive, in spawn order. */
function sessionRunner() {
  const sessions: FakeTerminalSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<ITerminalRunner['spawn']>[0]) => {
    const session = new FakeTerminalSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  return { sessions, spawn, stop: vi.fn(), stopAll: vi.fn() };
}

function makeOrchestrator(overrides: {
  config?: Partial<IConfig>;
  notifications?: Partial<INotification>;
  terminalRunner?: Partial<ITerminalRunner>;
  output?: TaskOutputSource;
  registry?: RunnerRegistry;
  workspaceRoot?: () => string;
  workspaceEnv?: (cwd: string) => Promise<WorkspaceEnv>;
  previousAttemptFromLog?: (taskId: string) => string | null;
} = {}) {
  const config = fakeConfig(overrides.config);
  const notifications = { ...fakeNotification(), ...overrides.notifications };
  const terminalRunner = { ...fakeTerminalRunner(), ...overrides.terminalRunner } as ITerminalRunner;
  const output = overrides.output ?? new BufferedTaskOutputSource({ transcripts: fakeTranscripts() });
  return TaskOrchestrator.compose({
    config,
    notifications,
    terminalRunner,
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
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn, stop, stopAll } });
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
        createTask({ id: 't1', order: 1, title: 'AI Task', prompt: 'do', status: 'awaiting_user' }),
      ]);

      await orchestrator.markTaskIncomplete('t1');
      await orchestrator.markTaskIncomplete('nope');

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
    });

    it('holds the un-marked task so a running plan does not immediately respawn it', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
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
  });

  describe('forceStartTask', () => {
    it('starts an AI task with the augmented prompt (not the raw prompt)', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
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
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.loadPlan([
        createTask({ id: 'u1', order: 1, title: 'Manual', type: 'user' }),
      ]);

      await orchestrator.forceStartTask('does-not-exist');
      await orchestrator.forceStartTask('u1');

      expect(spawn).not.toHaveBeenCalled();
    });

    it('detects the completion marker in output and logs the task', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('Working on it...\n<<<ORDEWELL_DONE_mk-1>>>\nDone.');
      sessions[0].emitExit(-1);

      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

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
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });

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

    it('completes a task whose marker was seen even when a usage limit then kills the runner', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>\nClaude usage limit reached. Your limit will reset at 5pm.');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

      const finished = orchestrator.storeInstance.get('t1');
      expect(finished!.status).toBe('completed');
      expect(finished!.verdict!.outcome).toBe('pass');
      expect(finished!.verdict!.reason).toMatch(/completion marker/);
    });

    it('pauses a runner that stopped on a usage limit before its marker, instead of failing the task', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('Claude usage limit reached. Your limit will reset at 5pm.');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      const paused = orchestrator.storeInstance.get('t1');
      expect(paused!.status).toBe('awaiting_user');
      expect(paused!.verdict!.outcome).toBe('fail');
      // Neither input, a checkpoint nor a conflict: a retry answers it, not a message.
      expect(paused!.awaitingReason).toBeUndefined();
    });

    it('does not promise a kept worktree when the paused task ran in the workspace root', async () => {
      const { sessions, spawn } = sessionRunner();
      const warn = vi.fn();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn }, notifications: { warn } });

      orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' })]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('Claude usage limit reached. Your limit will reset at 5pm.');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      expect(warn).toHaveBeenCalledWith('Task "Test" stopped before its completion marker: claude-code hit its usage limit. Retry it once the limit resets.');
    });

    it('pauses the run on a usage limit and resumes it when the task is retried', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn }, config: { maxParallelSessions: 1 } });

      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', completionMarker: 'mk-2' }),
      ]);
      await orchestrator.approveReview();

      sessions[0].emitOutput('You have hit your usage limit. The limit will reset at 5pm.');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      // No second task is launched into the exhausted limit.
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(orchestrator.status).toBe('approved');

      await orchestrator.retryTask('t1');
      expect(spawn).toHaveBeenCalledTimes(2);

      sessions[1].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
      expect(spawn.mock.calls[2][0].taskId).toBe('t2');
    });

    it('leaves a task without a marker failed when its exit names no limit', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });

      orchestrator.loadPlan([task]);
      await orchestrator.forceStartTask('t1');

      sessions[0].emitOutput('compilation failed: unexpected token');
      sessions[0].emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    });
  });

  describe('runTask', () => {
    it('runs only the selected task, stays busy until its marker, and does not schedule following work', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Selected', prompt: 'do selected', completionMarker: 'mk-1' }),
        createTask({ id: 't2', order: 2, title: 'Following', prompt: 'do following' }),
      ]);

      await orchestrator.runTask('t1');

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1' }));
      expect(orchestrator.isRunning).toBe(true);
      expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');

      sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
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

  describe('queue check in tick', () => {
    it('pauses when queue has messages and no active sessions', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

      orchestrator.loadPlan([createTask({ id: 'u1', order: 1, title: 'Manual', type: 'user' })]);

      let queueReadyCalled = false;
      orchestrator.subscribe({ onQueueReady: () => { queueReadyCalled = true; } });

      orchestrator.queueMessage('hello from user');

      await orchestrator.approveReview();

      await vi.waitFor(() => expect(queueReadyCalled).toBe(true));
      expect(spawn).not.toHaveBeenCalled();
    });

    // The run is armed on a user gate; t1 is force-started past it so a
    // runner is live when the gate opens and the scheduler looks at t2.
    function gatedPlan() {
      return [
        createTask({ id: 'u1', order: 1, title: 'Gate', type: 'user' }),
        createTask({ id: 't1', order: 2, title: 'Task 1', prompt: 'do it', dependencies: ['u1'] }),
        createTask({ id: 't2', order: 3, title: 'Task 2', prompt: 'do also', dependencies: ['u1'] }),
      ];
    }

    it('prevents starting new tasks when queue has messages and active sessions exist', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.loadPlan(gatedPlan());
      await orchestrator.approveReview();
      await orchestrator.forceStartTask('t1');

      orchestrator.queueMessage('hold on');
      await orchestrator.markTaskComplete('u1');

      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('proceeds normally when queue is empty', async () => {
      const { spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
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
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
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
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'], completionMarker: 'mk-2' }),
      ]);

      await orchestrator.approveReview();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));

      // t1 should have been spawned
      expect(spawn.mock.calls[0][0].taskId).toBe('t1');

      sessions[0].emitOutput('Done.\n<<<ORDEWELL_DONE_mk-1>>>');
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
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

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
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });
      orchestrator.loadPlan([task]);

      await orchestrator.approveReview();

      sessions[0].emitOutput('Done.\n<<<ORDEWELL_DONE_mk-1>>>');
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
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });

      const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });
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
      return [createTask({ id: 't1', order: 1, title: 'HITL Task', prompt: 'do', autonomy: 'HITL', completionMarker: 'mk-1' })];
    }

    it('emits onCheckpoint event when verifier detects a checkpoint', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.loadPlan(hitlPlan());
      const events: { taskId: string; taskTitle: string; summary: string }[] = [];
      orchestrator.subscribe({ onCheckpoint: (data) => events.push(data) });

      await orchestrator.forceStartTask('t1');
      sessions[0].emitOutput('<<<ORDEWELL_CHECKPOINT: need review>>>');

      expect(events).toEqual([{ taskId: 't1', taskTitle: 'HITL Task', summary: 'need review' }]);
    });

    it('sets task status to awaiting_user on checkpoint', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.loadPlan(hitlPlan());

      await orchestrator.forceStartTask('t1');
      sessions[0].emitOutput('<<<ORDEWELL_CHECKPOINT: approve this>>>');

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
    });

    it('approveCheckpoint resumes task status to in_progress', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.loadPlan(hitlPlan());

      await orchestrator.forceStartTask('t1');
      sessions[0].emitOutput('<<<ORDEWELL_CHECKPOINT: approve this>>>');
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');

      orchestrator.approveCheckpoint('t1');
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
      expect(sessions[0].written.length).toBeGreaterThan(0);
    });

    it('rejectCheckpoint resumes task status to in_progress', async () => {
      const { sessions, spawn } = sessionRunner();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
      orchestrator.loadPlan(hitlPlan());

      await orchestrator.forceStartTask('t1');
      sessions[0].emitOutput('<<<ORDEWELL_CHECKPOINT: approve this>>>');
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');

      orchestrator.rejectCheckpoint('t1', 'try again');
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
      expect(sessions[0].written.length).toBeGreaterThan(0);
    });
  });

describe('cancelTask', () => {
  it('does not let a dependent task auto-start when stop() synchronously fires onExit (tmux-style)', async () => {
    // Some runners (tmux) call the session's onExit callback synchronously
    // from within stop()/kill() — this mimics that to reproduce the race
    // where a cancelled task's dependent gets spawned before the cancelled
    // task is reverted to 'pending'.
    const { sessions, spawn } = sessionRunner();
    const stop = vi.fn(() => sessions[0].emitExit(-1));
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn, stop } });

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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    await orchestrator.approveReview();
    expect(orchestrator.isRunning).toBe(true);
    expect(orchestrator.hasLiveWork).toBe(true);

    await orchestrator.cancelTask('t1');

    expect(orchestrator.hasLiveWork).toBe(false);
  });

  it('is a no-op when the verdict already landed before the cancel arrives', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    const task = createTask({ id: 't1', order: 1, title: 'Test', prompt: 'do it', completionMarker: 'mk-1' });
    orchestrator.loadPlan([task]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn, stop } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    await orchestrator.forceStartTask('t1');

    await orchestrator.cancelTask('t1');

    expect(stop).toHaveBeenCalledWith('s1');
    expectNoAttemptState(orchestrator);
  });

  it('stop leaves no attempt state', async () => {
    const { spawn, stopAll } = sessionRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn, stopAll } });
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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    const plan = [createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })];
    orchestrator.loadPlan(plan);
    await orchestrator.forceStartTask('t1');

    orchestrator.loadPlan(plan);

    expectNoAttemptState(orchestrator);
  });

  /** A runner whose spawns resolve only when the test says so. */
  function heldSpawns() {
    const pending: Array<{ resolve: (session: FakeTerminalSession) => void; reject: (err: Error) => void }> = [];
    const spawn = vi.fn(() => new Promise<ITerminalSession>((resolve, reject) => { pending.push({ resolve, reject }); }));
    const settle = async (index: number, session: FakeTerminalSession) => {
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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));
    expect(orchestrator.getAttempt('t1')?.phase).toBe('starting');
    expect(orchestrator.getAttempt('t1')?.sessionId).toBeNull();

    orchestrator.stop();
    const late = new FakeTerminalSession('late', 't1');
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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));
    orchestrator.stop();
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(2));

    const stale = new FakeTerminalSession('stale', 't1');
    const fresh = new FakeTerminalSession('fresh', 't1');
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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));

    await orchestrator.cancelTask('t1');
    const late = new FakeTerminalSession('late', 't1');
    await settle(0, late);

    expect(late.killed).toBe(true);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');
    expectNoAttemptState(orchestrator);
  });
  describe('a start the scheduler resumes after an in-flight spawn', () => {
    function plan() {
      return [
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
        createTask({ id: 't3', order: 3, title: 'Third', prompt: 'do third' }),
      ];
    }

    async function heldAtFirstSpawn(maxParallelSessions: number) {
      const held = heldSpawns();
      const orchestrator = makeOrchestrator({ terminalRunner: { spawn: held.spawn }, config: { maxParallelSessions } });
      orchestrator.loadPlan(plan());
      void orchestrator.approveReview();
      await vi.waitFor(() => expect(held.spawned()).toBe(1));
      return { orchestrator, ...held };
    }

    const spawnedIds = (spawn: ReturnType<typeof heldSpawns>['spawn']) =>
      spawn.mock.calls.map((call: unknown[]) => (call[0] as { taskId: string }).taskId);

    it('does not start a task the user put on hold meanwhile', async () => {
      const { orchestrator, spawn, settle, spawned } = await heldAtFirstSpawn(3);

      void orchestrator.markTaskComplete('t2');
      await vi.waitFor(() => expect(spawned()).toBe(2));
      await orchestrator.markTaskIncomplete('t2');
      await settle(0, new FakeTerminalSession('s1', 't1'));

      expect(orchestrator.storeInstance.get('t2')!.status).toBe('pending');
      expect(orchestrator.getAttempt('t2')).toBeUndefined();
      expect(spawnedIds(spawn)).not.toContain('t2');
    });

    it('does not reopen a task the user marked complete meanwhile, nor run more than the parallel limit', async () => {
      const { orchestrator, spawn, settle, spawned } = await heldAtFirstSpawn(2);

      void orchestrator.markTaskComplete('t2');
      await vi.waitFor(() => expect(spawned()).toBe(2));
      await settle(0, new FakeTerminalSession('s1', 't1'));
      await settle(1, new FakeTerminalSession('s3', 't3'));

      expect(orchestrator.storeInstance.get('t2')!.status).toBe('completed');
      expect(spawnedIds(spawn)).toEqual(['t1', 't3']);
      expect(orchestrator.activeSessionMap.size).toBe(2);
    });

    it('does not take a slot a force start filled meanwhile', async () => {
      const { orchestrator, spawn, settle, spawned } = await heldAtFirstSpawn(2);

      void orchestrator.forceStartTask('t3');
      await vi.waitFor(() => expect(spawned()).toBe(2));
      await settle(0, new FakeTerminalSession('s1', 't1'));
      await settle(1, new FakeTerminalSession('s3', 't3'));

      expect(spawnedIds(spawn)).toEqual(['t1', 't3']);
      expect(orchestrator.storeInstance.get('t2')!.status).toBe('pending');
    });

    it('does not start a task a reconcile gave an unmet dependency meanwhile', async () => {
      const { orchestrator, spawn, settle } = await heldAtFirstSpawn(2);

      orchestrator.reconcilePlan(plan().map((t) => (t.id === 't2' ? { ...t, dependencies: ['t3'] } : t)));
      await settle(0, new FakeTerminalSession('s1', 't1'));

      expect(spawnedIds(spawn)).not.toContain('t2');
      expect(orchestrator.storeInstance.get('t2')!.status).toBe('pending');
    });
  });

  it('a verdict ends the attempt and a retry runs the task as a fresh one', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' })]);
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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
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
      finalText: async () => '',
      liveTail: () => null,
    };
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn, stop }, output: throwingOutput });
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
      terminalRunner: { spawn },
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

  it('tells the user when a task sits at a prompt its agent will not get past alone', async () => {
    const { sessions, spawn } = sessionRunner();
    const warn = vi.fn();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn }, notifications: { warn }, registry: new RunnerRegistry() });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', assignedRunner: 'claude-code' })]);
    await orchestrator.approveReview();

    sessions[0].emitOutput(' Quick safety check: Is this a project you created or one you trust?');

    expect(warn).toHaveBeenCalledWith(`Task "First" is waiting for you: Claude Code is asking whether to trust the task's folder. Answer it in the task's terminal.`);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
  });

  it('retrying the task whose failure paused a full run resumes that run', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', completionMarker: 'mk-2', dependencies: ['t1'] }),
    ]);
    await orchestrator.approveReview();
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    await orchestrator.retryTask('t1');

    expect(orchestrator.getAttempt('t1')).toMatchObject({ attempt: 2, phase: 'running' });
    sessions[1].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
    expect(spawn.mock.calls[2][0].taskId).toBe('t2');
  });

  it('retrying a task that failed on its own does not start the rest of the plan', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', completionMarker: 'mk-2' }),
    ]);
    await orchestrator.approveReview();
    orchestrator.stop();
    await orchestrator.runTask('t1');
    sessions.at(-1)!.emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    const before = spawn.mock.calls.length;

    await orchestrator.retryTask('t1');

    expect(spawn).toHaveBeenCalledTimes(before);
  });

  it('stop during an in-flight spawn that then fails returns the task to pending', async () => {
    const { spawn, fail, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));

    orchestrator.stop();
    await fail(0, new Error('runner not found'));

    expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');
    expectNoAttemptState(orchestrator);
    expect(orchestrator.isRunning).toBe(false);
  });

  const threeReady = () => [
    createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
    createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    createTask({ id: 't3', order: 3, title: 'Third', prompt: 'do third' }),
  ];

  it('stop during the first spawn of a tick starts none of the tasks after it', async () => {
    const { spawn, settle, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan(threeReady());
    void orchestrator.approveReview();
    await vi.waitFor(() => expect(spawned()).toBe(1));

    orchestrator.stop();
    await settle(0, new FakeTerminalSession('late', 't1'));
    await flushMicrotasks();

    expect(spawned()).toBe(1);
    expect(orchestrator.hasLiveWork).toBe(false);
    expect(orchestrator.storeInstance.allTasks.map((t) => t.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('a plan loaded during a tick\'s spawn is not handed tasks the old plan had ready', async () => {
    const { spawn, settle, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan(threeReady());
    void orchestrator.approveReview();
    await vi.waitFor(() => expect(spawned()).toBe(1));

    orchestrator.loadPlan([createTask({ id: 'n1', order: 1, title: 'New', prompt: 'do new' })]);
    await settle(0, new FakeTerminalSession('late', 't1'));
    await flushMicrotasks();

    const started = spawn.mock.calls.map((call) => (call as unknown as [{ taskId: string }])[0].taskId);
    expect(started).not.toContain('t2');
    expect(started).not.toContain('t3');
    expect(orchestrator.storeInstance.get('t2')).toBeUndefined();
  });

  it('a verdict whose output cannot be read fails the task instead of leaving it live', async () => {
    const { sessions, spawn } = sessionRunner();
    const output = new BufferedTaskOutputSource({ transcripts: fakeTranscripts() });
    output.finalText = async () => { throw new Error('transcript unreadable'); };
    const notifications = fakeNotification();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn }, output, notifications });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' })]);
    await orchestrator.approveReview();

    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');

    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    expect(orchestrator.hasLiveWork).toBe(false);
    expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('transcript unreadable'));
  });

  it('marking a task complete while its spawn is in flight keeps it completed when the spawn lands', async () => {
    const { spawn, settle, spawned } = heldSpawns();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' })]);
    void orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(spawned()).toBe(1));

    await orchestrator.markTaskComplete('t1');
    const late = new FakeTerminalSession('late', 't1');
    await settle(0, late);

    expect(late.killed).toBe(true);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed');
    expect(orchestrator.storeInstance.isCompleted('t1')).toBe(true);
    expectNoAttemptState(orchestrator);
  });

  /** A transcript reader whose reads resolve only when the test says so. */
  function heldTranscripts() {
    const pending: Array<(text: string | null) => void> = [];
    const transcripts: TranscriptReader = {
      finalAssistantText: () => new Promise((resolve) => { pending.push(resolve); }),
    };
    const answer = async (index: number, text: string | null) => {
      pending[index](text);
      await flushMicrotasks();
    };
    return { transcripts, answer, reads: () => pending.length };
  }

  // The verdict's summary is read from disk before the verdict is applied; a
  // user action in that window must not be overwritten by the stale verdict.
  it('a retry while a verdict is still reading its transcript keeps the new attempt', async () => {
    const { sessions, spawn } = sessionRunner();
    const { transcripts, answer, reads } = heldTranscripts();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn }, output: new BufferedTaskOutputSource({ transcripts }) });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' })]);
    await orchestrator.approveReview();
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(reads()).toBe(1));

    await orchestrator.retryTask('t1');
    expect(orchestrator.getAttempt('t1')).toMatchObject({ attempt: 2, sessionId: 's2' });
    await answer(0, 'stale answer');

    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
    expect(orchestrator.getAttempt('t1')).toMatchObject({ attempt: 2, sessionId: 's2', phase: 'running' });
    expect(orchestrator.storeInstance.get('t1')!.verdict).toBeUndefined();
    expect(orchestrator.isRunning).toBe(true);
  });

  // stop() kills the runners before it resets the verifier, and a tmux runner
  // fires the exit from inside stopAll() — a verdict raised there must not
  // fail a task the user merely stopped.
  it('an exit fired synchronously from stopAll does not record a verdict', async () => {
    const { sessions, spawn } = sessionRunner();
    const stopAll = vi.fn(() => sessions.forEach((s) => s.emitExit(-1)));
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn, stopAll } });
    const onExecutionComplete = vi.fn();
    orchestrator.subscribe({ onExecutionComplete });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' })]);
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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    const plan = () => [createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' })];
    orchestrator.loadPlan(plan());
    await orchestrator.forceStartTask('t1');

    orchestrator.loadPlan(plan());
    await orchestrator.forceStartTask('t1');
    sessions[0].emitExit(1);
    await flushMicrotasks();

    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
    expect(orchestrator.getAttempt('t1')).toMatchObject({ sessionId: 's2', phase: 'running' });
    sessions[1].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
  });

  // Retrying a task whose runner is still up used to leave the old attempt
  // registered, so the scheduler could never start the retry.
  it('retrying a live task stops its runner so the retry can start', async () => {
    const { spawn, stop } = sessionRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn, stop } });
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
  /** Keeps getOutput() ANSI-stripped, the way HeadlessRunner and TmuxRunner do. */
  class StrippingSession extends FakeTerminalSession {
    getOutput(): string { return stripAnsi(this.output); }
  }

  function strippingRunner() {
    const sessions: StrippingSession[] = [];
    const spawn = vi.fn(async (opts: Parameters<ITerminalRunner['spawn']>[0]) => {
      const session = new StrippingSession(`s${sessions.length + 1}`, opts.taskId);
      sessions.push(session);
      return session;
    });
    return { sessions, spawn };
  }

  const settle = () => flushMicrotasks();

  it('summarizes an exit without a marker from the raw stream, not the stripped session buffer', async () => {
    const { sessions, spawn } = strippingRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'T', prompt: 'do', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    // A status row repainted in place; the stripped buffer runs both frames together.
    sessions[0].emitOutput('\x1b[1;1Hrunning tests…\x1b[1;1H\x1b[2Ktests failed: 2 of 40');
    sessions[0].emitExit(1);
    await settle();

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.verdict?.outcome).toBe('fail');
    expect(task.outputSummary?.logTail).toBe('tests failed: 2 of 40');
  });

  it('summarizes a finished task from the transcript carrying its marker', async () => {
    const { sessions, spawn } = strippingRunner();
    const transcripts = fakeTranscripts({ 'mk-1': 'Renamed the module and updated imports.' });
    const orchestrator = makeOrchestrator({
      terminalRunner: { spawn },
      output: new BufferedTaskOutputSource({ transcripts }),
    });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'T', prompt: 'do', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('terminal noise\n<<<ORDEWELL_DONE_mk-1>>>\n');
    await settle();

    expect(transcripts.queries).toEqual([expect.objectContaining({ runner: 'claude-code', cwd: '/repo', marker: 'mk-1' })]);
    expect(orchestrator.storeInstance.get('t1')!.outputSummary?.logTail).toBe('Renamed the module and updated imports.');
  });

  it('exposes a running task\'s recent output, rendered clean', async () => {
    const { sessions, spawn } = strippingRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'T', prompt: 'do', completionMarker: 'mk-1' })]);
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
  const opsTask = () => createTask({ id: 'o1', order: 1, title: 'Deploy', prompt: 'deploy it', completionMarker: 'mk-o1', ops: true });

  async function retryAfterFailure(options: { previousAttemptFromLog?: (taskId: string) => string | null; firstAttemptOutput?: string }) {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn }, previousAttemptFromLog: options.previousAttemptFromLog });
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
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([{ ...opsTask(), status: 'failed' }]);

    await orchestrator.retryTask('o1');
    await orchestrator.forceStartTask('o1');

    const prompt = spawn.mock.calls[0][0].prompt;
    expect(prompt).toContain('## Previous attempt');
    expect(prompt).toContain('Its output is not available: this session was reloaded since it ran.');
  });

  it('adds nothing to the first attempt', async () => {
    const { spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn } });
    orchestrator.loadPlan([opsTask()]);

    await orchestrator.forceStartTask('o1');

    expect(spawn.mock.calls[0][0].prompt).not.toContain('## Previous attempt');
  });

  it('keeps the live terminal tail when a runner left no log', async () => {
    const prompt = await retryAfterFailure({ previousAttemptFromLog: () => null, firstAttemptOutput: 'created rg-dev\n' });

    expect(prompt).toContain('  created rg-dev');
    expect(prompt).not.toContain('not available');
  });

  it('tells a change task\'s retry nothing about the attempt before', async () => {
    const { sessions, spawn } = sessionRunner();
    const orchestrator = makeOrchestrator({ terminalRunner: { spawn }, previousAttemptFromLog: () => '- Bash {} → ok' });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Change', prompt: 'edit', completionMarker: 'mk-1' })]);
    await orchestrator.approveReview();
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    await orchestrator.retryTask('t1');
    await orchestrator.start();

    expect(spawn.mock.calls[1][0].prompt).not.toContain('## Previous attempt');
  });
});

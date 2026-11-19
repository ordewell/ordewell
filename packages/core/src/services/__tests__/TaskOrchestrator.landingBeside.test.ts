import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';

function setup(opts: { registry?: boolean } = {}) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions: 4 }),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation: new FakeWorktreeIsolation(),
    workspaceRoot: () => '/repo',
    ...(opts.registry ? {
      registry: new RunnerRegistry(),
      workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
      taskShell: () => ({ run: vi.fn(async () => ({ success: true, output: '', truncated: false })), end: vi.fn() }),
    } : {}),
  });
  const promptOf = (taskId: string) => spawn.mock.calls.find(([o]) => o.taskId === taskId)?.[0].prompt ?? '';
  const pass = (taskId: string) => sessions.find((s) => s.taskId === taskId)!.reportComplete({ status: 'done', summary: '' });
  return { orchestrator, spawn, promptOf, pass };
}

const task = (id: string, order: number, over: Partial<Task> = {}) => createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

describe('a change task in an isolated run is told of the work landing beside it', () => {
  it('tells each of two tasks running side by side where the other lands, and how to take it in', async () => {
    const { orchestrator, spawn, promptOf } = setup();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2)]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

    for (const id of ['t1', 't2']) {
      expect(promptOf(id)).toContain('## Work landing beside yours');
      expect(promptOf(id)).toContain(`git merge --no-edit -m 'Merge: Task ${id} (take in landed work)' ordewell/run1/integration`);
    }
  });

  it('says nothing to a task nothing can land beside: a chain runs one task at a time', async () => {
    const { orchestrator, spawn, promptOf, pass } = setup();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(promptOf('t1')).not.toContain('Work landing beside yours');

    pass('t1');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(promptOf('t2')).not.toContain('Work landing beside yours');
  });
});

describe('a parent and its subtask start together (ADR-0034), so each is told of the other', () => {
  it('tells a parent and its subtask, at every depth', async () => {
    const { orchestrator, spawn, promptOf } = setup();
    orchestrator.loadPlan([task('t1', 1, { subtasks: [task('t11', 1, { subtasks: [task('t111', 1)] })] })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
    for (const id of ['t1', 't11', 't111']) expect(promptOf(id)).toContain('## Work landing beside yours');
  });
});

describe('a sibling counts as read-only as its attempt does: by the mode it runs on (ADR-0046)', () => {
  const claude = (id: string, order: number, over: Partial<Task> = {}) =>
    task(id, order, { assignedRunner: 'claude-code', taskMode: 'bypassPermissions', ...over });

  it('tells nothing of a sibling on its runner\'s read-only mode, which lands nothing', async () => {
    const { orchestrator, spawn, promptOf } = setup({ registry: true });
    orchestrator.loadPlan([claude('t1', 1), claude('t2', 2, { taskMode: 'plan' })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(promptOf('t1')).not.toContain('Work landing beside yours');
  });

  it('tells of a sibling flagged read-only that runs as a change all the same', async () => {
    const { orchestrator, spawn, promptOf } = setup({ registry: true });
    orchestrator.loadPlan([claude('t1', 1), claude('t2', 2, { readOnly: true })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(promptOf('t1')).toContain('## Work landing beside yours');
  });
});

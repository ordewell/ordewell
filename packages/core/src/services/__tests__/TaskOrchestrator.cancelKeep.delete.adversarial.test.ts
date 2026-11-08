import { describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Adversarial, the cancel-keep review: a cancel or a Stop during the workspace
 * open keeps the worktree (ADR-0013), but a task deleted in that same window
 * must still lose it — removal from the plan removes the worktree
 * (ADR-0013:143), and the attempt's end cannot outvote the delete.
 */

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

function setup() {
  const isolation = new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
  });
  return { orchestrator, isolation, spawn, sessions };
}

/** Holds t1's first prepare before git makes anything, so its record is made only after whatever ends the attempt. */
function firstPrepareHeld(isolation: FakeWorktreeIsolation) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  const prepare = isolation.prepare.bind(isolation);
  vi.spyOn(isolation, 'prepare')
    .mockImplementationOnce(async (...args) => { entered(); await gate; return prepare(...args); })
    .mockImplementation(prepare);
  return { preparing, release };
}

/** What PlanEditor.removeTask does: release the task, then drop it from the plan. */
async function deleteTask(env: ReturnType<typeof setup>, id: string) {
  await env.orchestrator.releaseTask(id);
  env.orchestrator.storeInstance.remove(id);
}

describe('a task deleted while its workspace is still being prepared', () => {
  it('a cancel then a delete leaves no kept record', async () => {
    const env = setup();
    const held = firstPrepareHeld(env.isolation);
    env.orchestrator.loadPlan([task('t1', 1)]);
    const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await held.preparing;
    await env.orchestrator.cancelTask('t1');
    await deleteTask(env, 't1');
    held.release();
    await first;
    await flushMicrotasks(20);

    expect(env.orchestrator.runs.current?.tasks.t1).toBeUndefined();
  });

  it('a stop then a delete leaves no kept record', async () => {
    const env = setup();
    const held = firstPrepareHeld(env.isolation);
    env.orchestrator.loadPlan([task('t1', 1)]);
    const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await held.preparing;
    env.orchestrator.stop();
    await deleteTask(env, 't1');
    held.release();
    await first;
    await flushMicrotasks(20);

    expect(env.orchestrator.runs.current?.tasks.t1).toBeUndefined();
  });
});

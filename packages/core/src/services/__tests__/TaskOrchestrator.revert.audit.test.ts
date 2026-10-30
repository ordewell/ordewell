import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Audit of the revert's start hold (ADR-0054): "No new start is claimed while
 * it waits and works: one cut now would lose what it depends on." A start
 * already admitted before the revert — a force start opening a closed run —
 * must not claim a dependent after the revert has judged the plan.
 */

function setup() {
  const isolation = new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (o: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({}), notifications: fakeNotification(), runner, output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => '/repo',
  });
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const status = (taskId: string) => orchestrator.storeInstance.get(taskId)!.status;
  const pass = async (taskId: string) => {
    latest(taskId).reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(status(taskId)).toBe('completed'));
  };
  return { orchestrator, isolation, sessions, status, pass };
}

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

/** A gate whose open() resolves the promise. */
function gate(): { p: Promise<void>; open: () => void } {
  let open!: () => void;
  const p = new Promise<void>((resolve) => { open = resolve; });
  return { p, open };
}

describe('AUDIT revert: a start admitted before the revert', () => {
  it('does not claim a dependent while the revert is working', async () => {
    const { orchestrator, isolation, sessions, status, pass } = setup();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(sessions.some((s) => s.taskId === 't1')).toBe(true));
    await pass('t1');
    // Close the run so the force start's activation is a real await, as git's is.
    orchestrator.stop();
    await vi.waitFor(() => expect(orchestrator.runs.isOpen).toBe(false));

    const spawned = sessions.filter((s) => s.taskId === 't2').length;
    const activation = gate();
    const originalActive = isolation.isActive.bind(isolation);
    (isolation as unknown as { isActive: (root: string) => Promise<unknown> }).isActive = async (root: string) => {
      await activation.p;
      return originalActive(root);
    };
    const reading = gate();
    let reachedTheRead!: () => void;
    const judged = new Promise<void>((resolve) => { reachedTheRead = resolve; });
    const originalRead = isolation.readLanded.bind(isolation);
    (isolation as unknown as { readLanded: (run: never, ids: readonly string[]) => Promise<unknown> }).readLanded = async (run: never, ids: readonly string[]) => {
      // The fake's revert calls watch.refusal() before this: the plan has been judged.
      reachedTheRead();
      await reading.p;
      return originalRead(run, ids);
    };

    // The user's start is already in its act (opening the run) when the revert command arrives.
    const forcing = orchestrator.forceStartTask('t2').catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reverting = orchestrator.revertTask('t1');
    await judged;

    // The revert found t2 pending and is reading the branches. Give the already-admitted
    // start every chance to claim, then let the revert go on.
    activation.open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    reading.open();
    const [refused, reverted] = await Promise.all([forcing, reverting]);

    // The start is what gives way: the revert was asked for with nothing live in its way.
    expect(reverted).toMatchObject({ outcome: 'reverted' });
    expect(refused).toMatchObject({ message: expect.stringContaining('A revert is taking back work task "Task t2" depends on') });
    expect(status('t2')).toBe('pending');
    expect(sessions.filter((s) => s.taskId === 't2')).toHaveLength(spawned);
  });
});

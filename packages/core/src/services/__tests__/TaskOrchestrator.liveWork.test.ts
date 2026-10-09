import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IsolationHandoff } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * A runner whose stop kills its sessions the way `StructuredSession.kill`
 * does: the exit fires synchronously, so the verifier hands out a failed
 * verdict for each before the orchestrator has ended its attempts.
 */
function killingRunner() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const kill = (session: FakeRunnerSession) => {
    if (session.killed) return;
    session.killed = true;
    session.emitExit(-1);
  };
  const runner: IRunner = {
    spawn,
    stop: vi.fn((id: string) => { const s = sessions.find((x) => x.id === id); if (s) kill(s); }),
    stopAll: vi.fn(() => { for (const s of sessions) kill(s); }),
    activeCount: 0,
  };
  return { sessions, spawn, runner };
}

function setup(isolation = new FakeWorktreeIsolation()) {
  const { sessions, spawn, runner } = killingRunner();
  const notifications = fakeNotification();
  const output = new BufferedTaskOutputSource();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications,
    runner,
    output,
    isolation,
    workspaceRoot: () => '/repo',
  });
  const handoffs: IsolationHandoff[] = [];
  const notices: string[] = [];
  orchestrator.subscribe({
    onIsolationHandoff: (h) => handoffs.push(h),
    onIsolationNotice: ({ message }) => notices.push(message),
  });
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const pass = (task: Task) => latest(task.id).reportComplete({ status: 'done', summary: '' });
  const status = (taskId: string) => orchestrator.storeInstance.get(taskId)!.status;
  return { orchestrator, isolation, sessions, spawn, runner, notifications, handoffs, notices, latest, pass, status };
}

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

describe('a merge never deletes a live task\'s worktree', () => {
  /*
   * The incident of 2026-10-06, as the daemon log and the session files show
   * it: tasks 13, 14 and 15 ran in parallel; Stop killed all three (three
   * `verdict=fail` lines with no summary — the attempts ended while the
   * verdicts read their output); 13 and 15 stayed `in_progress` with nothing
   * running them; task 14, moved to another runner, was run alone and landed;
   * its verdict closed the run and raised "Run finished"; Merge all then
   * cleared the run up, worktrees of 13 and 15 included.
   */
  it('reproduces the incident: Stop, a manual run of one task, then Merge all keeps the stopped tasks\' worktrees', async () => {
    const { orchestrator, isolation, pass, status } = setup();
    const [t13, t14, t15] = [task('t13', 13), task('t14', 14), task('t15', 15)];
    orchestrator.loadPlan([t13, t14, t15]);
    await orchestrator.approveReview();
    expect(isolation.taskIdsFor('prepare')).toEqual(['t13', 't14', 't15']);

    orchestrator.stop();
    await flushMicrotasks();
    expect(status('t13')).toBe('pending');
    expect(status('t15')).toBe('pending');

    await orchestrator.runTask('t14');
    pass(t14);
    await vi.waitFor(() => expect(status('t14')).toBe('completed'));

    expect(await orchestrator.mergeRun()).toEqual({ outcome: 'merged' });

    expect(isolation.calls.map((c) => c.op)).not.toContain('discard');
    expect(orchestrator.runs.taskIsolation('t13')).toMatchObject({ state: 'kept' });
    expect(orchestrator.runs.taskIsolation('t15')).toMatchObject({ state: 'kept' });
  });

  it('settles every task a stop ends, and says which, so none is left showing as running', async () => {
    const { orchestrator, status, notices } = setup();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2)]);
    await orchestrator.approveReview();

    orchestrator.stop();
    await flushMicrotasks();

    expect(status('t1')).toBe('pending');
    expect(status('t2')).toBe('pending');
    expect(notices.join('\n')).toMatch(/Stopped "Task t1" and "Task t2"/);
    expect(notices.join('\n')).toMatch(/worktrees/);
  });

  describe('the merge prompt', () => {
    it('is not raised while a task is still live, and Merge all then clears nothing until the task is done', async () => {
      const { orchestrator, isolation, pass, handoffs } = setup();
      const t1 = task('t1', 1);
      // A checkpoint saved before a reload: waiting on the user mid-attempt.
      orchestrator.loadPlan([t1, { ...task('t2', 2, { status: 'awaiting_user' }), awaitingReason: 'checkpoint' }]);

      await orchestrator.runTask('t1');
      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
      await flushMicrotasks();

      expect(handoffs).toEqual([]);
      expect(orchestrator.runs.isOpen).toBe(true);
      expect(await orchestrator.mergeRun()).toEqual({ outcome: 'merged' });
      expect(isolation.calls.map((c) => c.op)).not.toContain('discard');

      await orchestrator.markTaskComplete('t2');

      // Everything it landed is in the user's branch already, so it closes by clearing up.
      expect(orchestrator.runs.isOpen).toBe(false);
      expect(isolation.calls.filter((c) => c.op === 'discard')).toEqual([{ op: 'discard', integration: 'delete-merged' }]);
      expect(handoffs).toEqual([]);
    });

    it('Merge all mid-run leaves a running task untouched: its runner, its worktree, and its landing after', async () => {
      const { orchestrator, isolation, pass, latest, status } = setup();
      const [t1, t2] = [task('t1', 1), task('t2', 2)];
      orchestrator.loadPlan([t1, t2]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(status('t1')).toBe('completed'));

      expect(await orchestrator.mergeRun()).toEqual({ outcome: 'merged' });

      expect(orchestrator.getAttempt('t2')?.phase).toBe('running');
      expect(latest('t2').killed).toBe(false);
      expect(orchestrator.runs.taskIsolation('t2')).toMatchObject({ state: 'active' });
      expect(isolation.calls.filter((c) => c.op === 'release' || c.op === 'discard')).toEqual([]);

      pass(t2);
      await vi.waitFor(() => expect(status('t2')).toBe('completed'));
      expect(isolation.taskIdsFor('integrate')).toEqual(['t1', 't2']);
    });
  });

  describe('a task left in progress with nothing running it', () => {
    it('is put back to not started, with a notice, when a plan is loaded', () => {
      const { orchestrator, status, notices } = setup();

      orchestrator.loadPlan([task('t1', 1, { status: 'in_progress' }), task('t2', 2, { status: 'completed' })]);

      expect(status('t1')).toBe('pending');
      expect(status('t2')).toBe('completed');
      expect(notices).toEqual(['Task "Task t1" was shown as running, but nothing was running it — back to not started. Retry or force-start it; a worktree it had is kept.']);
    });

    it('is found on the next tick, however it was left, and can be started again', async () => {
      const { orchestrator, status, notices, spawn } = setup();
      orchestrator.loadPlan([task('t1', 1)]);
      orchestrator.storeInstance.markInProgress('t1');

      await orchestrator.tick();

      expect(status('t1')).toBe('pending');
      expect(notices.join('\n')).toMatch(/"Task t1" was shown as running/);
      await orchestrator.forceStartTask('t1');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(status('t1')).toBe('in_progress');
    });

    it('is not a task Mark complete is still landing', async () => {
      const { orchestrator, isolation, status, notices } = setup();
      orchestrator.loadPlan([task('t1', 1)]);
      await orchestrator.runTask('t1');
      const open = isolation.holdIntegration('t1');

      const completing = orchestrator.markTaskComplete('t1');
      await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1']));
      await orchestrator.tick();
      expect(status('t1')).toBe('in_progress');

      open();
      await completing;
      expect(status('t1')).toBe('completed');
      expect(notices.join('\n')).not.toMatch(/shown as running/);
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator, TaskControlError } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { IsolationHandoff } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, FakeStructuredSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

function setup(isolation = new FakeWorktreeIsolation()) {
  const sessions: FakeStructuredSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<ITerminalRunner['spawn']>[0]) => {
    const session = new FakeStructuredSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const runner: ITerminalRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications,
    terminalRunner: runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
  });
  const notices: string[] = [];
  const handoffs: IsolationHandoff[] = [];
  orchestrator.subscribe({
    onIsolationNotice: ({ message }) => notices.push(message),
    onIsolationHandoff: (handoff) => handoffs.push(handoff),
  });
  const spawned = (taskId: string) => spawn.mock.calls.filter(([o]) => o.taskId === taskId).map(([o]) => o);
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const pass = (task: Task) => latest(task.id).reportComplete({ status: 'done', summary: '' });
  const status = (taskId: string) => orchestrator.storeInstance.get(taskId)!.status;
  return { orchestrator, isolation, spawn, spawned, latest, pass, status, notifications, notices, handoffs };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });
const ops = (id: string, order: number, over: Partial<Task> = {}) => change(id, order, { ops: true, ...over });

describe('TaskOrchestrator: ops tasks and merge gates (ADR-0020)', () => {
  it('runs an ops task at the workspace root, and an ops-only run never isolates', async () => {
    const env = setup();
    env.orchestrator.loadPlan([ops('o1', 1)]);

    await env.orchestrator.approveReview();

    expect(env.spawned('o1')[0].cwd).toBe('/repo');
    expect(env.isolation.calls.map((c) => c.op)).not.toContain('startRun');
    expect(env.isolation.taskIdsFor('prepare')).toEqual([]);
  });

  it('is not parked by a dirty tree until its first change task', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'dirty' };
    const env = setup(isolation);
    const blocked: string[] = [];
    env.orchestrator.subscribe({ onIsolationBlocked: ({ reason }) => blocked.push(reason) });
    const o1 = ops('o1', 1);
    env.orchestrator.loadPlan([o1, change('t2', 2, { dependencies: ['o1'] })]);

    await env.orchestrator.approveReview();
    expect(env.spawned('o1')).toHaveLength(1);
    expect(blocked).toEqual([]);

    env.pass(o1);
    await vi.waitFor(() => expect(blocked).toEqual(['dirty']));
    expect(env.spawned('t2')).toHaveLength(0);

    await env.orchestrator.continueBlockedRun('stash');
    await vi.waitFor(() => expect(env.spawned('t2')[0]?.cwd).toBe('/fake-worktrees/run1/2-t2'));
  });

  describe('the merge gate', () => {
    async function gated() {
      const env = setup();
      const t1 = change('t1', 1);
      const o2 = ops('o2', 2, { dependencies: ['t1'] });
      env.orchestrator.loadPlan([t1, o2]);
      await env.orchestrator.approveReview();
      env.pass(t1);
      await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));
      await flushMicrotasks();
      return { ...env, t1, o2 };
    }

    it('holds an ops task until the change it depends on is merged into the user\'s branch, and says so', async () => {
      const env = await gated();

      expect(env.spawned('o2')).toHaveLength(0);
      expect(env.orchestrator.getMergeGate('o2')).toEqual(['t1']);
      expect(env.notices).toContainEqual(expect.stringContaining('Waiting for Merge all: "Task o2"'));
    });

    it('starts the gated task by itself once Merge all merged, and keeps the run going', async () => {
      const env = await gated();

      expect(await env.orchestrator.mergeRun()).toEqual({ outcome: 'merged' });

      await vi.waitFor(() => expect(env.spawned('o2')[0]?.cwd).toBe('/repo'));
      expect(env.orchestrator.getMergeGate('o2')).toEqual([]);
      expect(env.orchestrator.runs.planIsolation).not.toBeNull();
      expect(env.isolation.calls.map((c) => c.op)).not.toContain('discard');
    });

    it('opens on work merged by hand, found on the next tick', async () => {
      const env = await gated();
      env.isolation.mergedByHand.add('t1');

      await env.orchestrator.tick();

      await vi.waitFor(() => expect(env.spawned('o2')).toHaveLength(1));
    });

    it('stays shut when Merge all does not go through', async () => {
      const env = await gated();
      env.isolation.mergeResult = { outcome: 'conflict', repo: '.', files: ['a.ts'] };

      await env.orchestrator.mergeRun();
      await flushMicrotasks();

      expect(env.spawned('o2')).toHaveLength(0);
      expect(env.orchestrator.getMergeGate('o2')).toEqual(['t1']);
    });

    it('holds a user task the same way', async () => {
      const env = setup();
      const t1 = change('t1', 1);
      env.orchestrator.loadPlan([t1, createTask({ id: 'u2', order: 2, title: 'Check it', type: 'user', dependencies: ['t1'] })]);
      await env.orchestrator.approveReview();
      env.pass(t1);
      await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));

      expect(env.orchestrator.getMergeGate('u2')).toEqual(['t1']);
    });

    it('opens a user task\'s gate on work merged by hand, too', async () => {
      const env = setup();
      const t1 = change('t1', 1);
      env.orchestrator.loadPlan([t1, createTask({ id: 'u2', order: 2, title: 'Check it', type: 'user', dependencies: ['t1'] })]);
      await env.orchestrator.approveReview();
      env.pass(t1);
      await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));
      await flushMicrotasks();
      expect(env.orchestrator.getMergeGate('u2')).toEqual(['t1']);

      env.isolation.mergedByHand.add('t1');
      await env.orchestrator.tick();

      expect(env.orchestrator.getMergeGate('u2')).toEqual([]);
      expect(env.orchestrator.mergeGateView()).toBeNull();
    });

    it('never holds a change task', async () => {
      const env = setup();
      const t1 = change('t1', 1);
      env.orchestrator.loadPlan([t1, change('t2', 2, { dependencies: ['t1'] })]);
      await env.orchestrator.approveReview();

      env.pass(t1);

      await vi.waitFor(() => expect(env.spawned('t2')).toHaveLength(1));
      expect(env.orchestrator.getMergeGate('t2')).toEqual([]);
    });

    it('lets a force start pass, and keeps the choice on the task', async () => {
      const env = await gated();

      await env.orchestrator.forceStartTask('o2');

      expect(env.spawned('o2')[0].cwd).toBe('/repo');
      expect(env.orchestrator.storeInstance.get('o2')!.forcedPastGate).toEqual(['"Task t1"']);
      expect(env.notices).toContainEqual(expect.stringContaining('force-started before the work of "Task t1" was merged'));
    });

    it('keeps a single-task run past the gate on the task, as a force start', async () => {
      const env = await gated();

      await env.orchestrator.runTask('o2');

      expect(env.spawned('o2')[0].cwd).toBe('/repo');
      expect(env.orchestrator.storeInstance.get('o2')!.forcedPastGate).toEqual(['"Task t1"']);
    });

    it('forgets the force start once the task is retried', async () => {
      const env = await gated();
      await env.orchestrator.forceStartTask('o2');
      env.latest('o2').emitExit(1);
      await vi.waitFor(() => expect(env.status('o2')).toBe('failed'));

      await env.orchestrator.retryTask('o2');

      expect(env.orchestrator.storeInstance.get('o2')!.forcedPastGate).toBeUndefined();
    });

    it('reports the run paused at its gates, and what Merge all would merge', async () => {
      const env = await gated();

      expect(env.orchestrator.mergeGateView()).toMatchObject({ paused: true, landed: [{ taskId: 't1' }] });
    });

    it('hands over only what was not merged at a gate, and clears a run merged whole', async () => {
      const env = await gated();
      await env.orchestrator.mergeRun();
      await vi.waitFor(() => expect(env.spawned('o2')).toHaveLength(1));

      env.pass(env.o2);
      await vi.waitFor(() => expect(env.status('o2')).toBe('completed'));
      await flushMicrotasks();

      expect(env.handoffs).toEqual([]);
      expect(env.orchestrator.runs.planIsolation).toBeNull();
      expect(env.notices).toContainEqual(expect.stringContaining('merged into your branch already'));
    });
  });

  describe('Merge all and ops tasks never overlap', () => {
    it('refuses Merge all while an ops task runs', async () => {
      const env = setup();
      const t1 = change('t1', 1);
      env.orchestrator.loadPlan([t1, ops('o2', 2)]);
      await env.orchestrator.approveReview();
      env.pass(t1);
      await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));

      await expect(env.orchestrator.mergeRun()).rejects.toThrow(TaskControlError);
      expect(env.isolation.calls.map((c) => c.op)).not.toContain('mergeIntoCheckedOut');
    });

    it('refuses to start an ops task by hand while a merge is under way', async () => {
      const env = setup();
      const t1 = change('t1', 1);
      env.orchestrator.loadPlan([t1, ops('o2', 2, { dependencies: ['t1'] })]);
      await env.orchestrator.approveReview();
      env.pass(t1);
      await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));
      let refused: unknown = null;
      env.isolation.mergeIntoCheckedOut = async () => {
        refused = await env.orchestrator.forceStartTask('o2').then(() => null, (err: unknown) => err);
        return { outcome: 'merged' };
      };

      await env.orchestrator.mergeRun();

      expect(refused).toBeInstanceOf(TaskControlError);
    });

    it('starts no ops task while a merge is under way', async () => {
      const env = setup();
      const t1 = change('t1', 1);
      env.orchestrator.loadPlan([t1, ops('o2', 2, { dependencies: ['t1'] })]);
      await env.orchestrator.approveReview();
      env.pass(t1);
      await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));
      let spawnedDuringMerge = -1;
      env.isolation.mergeIntoCheckedOut = async (run) => {
        for (const record of Object.values(run.tasks)) env.isolation.mergedByHand.add(record.taskId);
        await env.orchestrator.tick();
        spawnedDuringMerge = env.spawned('o2').length;
        return { outcome: 'merged' };
      };

      await env.orchestrator.mergeRun();

      expect(spawnedDuringMerge).toBe(0);
      await vi.waitFor(() => expect(env.spawned('o2')).toHaveLength(1));
    });
  });

  describe('the tree check', () => {
    it('makes an ops task that changed tracked files wait on the user, naming them', async () => {
      const env = setup();
      const t1 = change('t1', 1);
      const o2 = ops('o2', 2);
      env.orchestrator.loadPlan([t1, o2]);
      await env.orchestrator.approveReview();
      env.isolation.changedFiles = ['package.json'];

      env.pass(o2);

      await vi.waitFor(() => expect(env.status('o2')).toBe('awaiting_user'));
      expect(env.orchestrator.storeInstance.get('o2')!.awaitingReason).toBe('files-changed');
      expect(env.notices).toContainEqual(expect.stringContaining('changed tracked files in your checkout: package.json'));

      await env.orchestrator.markTaskComplete('o2');
      expect(env.status('o2')).toBe('completed');
    });

    it('does not run in a run that shares the workspace root', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'not-git' };
      const env = setup(isolation);
      const o1 = ops('o1', 1);
      env.orchestrator.loadPlan([o1]);
      await env.orchestrator.approveReview();
      isolation.changedFiles = ['a.ts'];

      env.pass(o1);

      await vi.waitFor(() => expect(env.status('o1')).toBe('completed'));
      expect(isolation.calls.map((c) => c.op)).not.toContain('snapshotTree');
    });
  });

  it('tells a retried ops task what its last attempt did', async () => {
    const env = setup();
    env.orchestrator.loadPlan([ops('o1', 1)]);
    await env.orchestrator.approveReview();
    env.latest('o1').emitOutput('created resource group rg-dev\n');
    env.latest('o1').emitExit(1);
    await vi.waitFor(() => expect(env.status('o1')).toBe('failed'));

    await env.orchestrator.retryTask('o1');

    await vi.waitFor(() => expect(env.spawned('o1')).toHaveLength(2));
    expect(env.spawned('o1')[0].prompt).not.toContain('Previous attempt');
    expect(env.spawned('o1')[1].prompt).toContain('## Previous attempt');
    expect(env.spawned('o1')[1].prompt).toContain('created resource group rg-dev');
  });
});

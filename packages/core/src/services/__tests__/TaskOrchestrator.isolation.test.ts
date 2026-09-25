import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import { fakeConfig, FakeTerminalSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { TranscriptQuery } from '../../interfaces/TaskOutputSource';

function sessionRunner() {
  const sessions: FakeTerminalSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<ITerminalRunner['spawn']>[0]) => {
    const session = new FakeTerminalSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const runner: ITerminalRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  return { sessions, spawn, runner };
}

function setup(opts: { isolation?: FakeWorktreeIsolation; workspace?: string } = {}) {
  const isolation = opts.isolation ?? new FakeWorktreeIsolation();
  const { sessions, spawn, runner } = sessionRunner();
  const notifications = fakeNotification();
  const output = new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } });
  const orchestrator = new TaskOrchestrator(fakeConfig(), notifications, runner, undefined, output, isolation);
  orchestrator.setWorkspaceRoot(() => opts.workspace ?? '/repo');
  const spawnedCwd = (taskId: string) => spawn.mock.calls.find(([o]) => o.taskId === taskId)?.[0].cwd;
  const sessionFor = (taskId: string) => sessions.find((s) => s.taskId === taskId);
  const pass = (task: Task) => sessionFor(task.id)!.emitOutput(`<<<ORDEWELL_DONE_${task.completionMarker}>>>`);
  return { orchestrator, isolation, spawn, sessions, notifications, spawnedCwd, sessionFor, pass };
}

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, completionMarker: `mk-${id}`, ...over });

describe('TaskOrchestrator with worktree isolation', () => {
  it('spawns each task in the worktree prepared for it', async () => {
    const { orchestrator, spawnedCwd } = setup();
    orchestrator.loadPlan([task('t1', 1)]);

    await orchestrator.approveReview();

    expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
  });

  it('completes a passed task only once its worktree has merged into the integration branch', async () => {
    const { orchestrator, isolation, pass } = setup();
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1]);
    await orchestrator.approveReview();
    const openMerge = isolation.holdIntegration('t1');

    pass(t1);
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1']));
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');

    openMerge();
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
    expect(orchestrator.getTaskIsolation('t1')).toEqual({
      state: 'integrated', branch: 'ordewell/run1/1-t1', worktree: '/fake-worktrees/run1/1-t1',
    });
  });

  it('holds a dependent back until its predecessor is integrated, then starts it from the new tip', async () => {
    const { orchestrator, isolation, pass, spawn } = setup();
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
    await orchestrator.approveReview();
    const openMerge = isolation.holdIntegration('t1');

    pass(t1);
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1']));
    await new Promise((r) => setTimeout(r, 10));
    expect(spawn).toHaveBeenCalledTimes(1);

    openMerge();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(isolation.calls.map((c) => c.op + ('taskId' in c ? `:${c.taskId}` : ''))).toEqual([
      'isActive', 'startRun', 'prepare:t1', 'integrate:t1', 'prepare:t2',
    ]);
  });

  it('stops a task whose merge conflicts at awaiting_user, keeps its worktree, and does not free its dependents', async () => {
    const { orchestrator, isolation, pass, spawn, notifications } = setup();
    isolation.outcomes.set('t1', 'conflict');
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
    await orchestrator.approveReview();

    pass(t1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.getTaskIsolation('t1')).toMatchObject({ state: 'conflict', branch: 'ordewell/run1/1-t1' });
    expect(isolation.taskIdsFor('release')).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifications.warn).mock.calls.flat().join('\n')).toMatch(/conflict/i);
  });

  it('fails a passed task whose integration git refused, keeps its worktree, and halts the run', async () => {
    const { orchestrator, isolation, pass, spawn, notifications } = setup();
    isolation.outcomes.set('t1', 'failed');
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1, task('t2', 2)]);
    await orchestrator.approveReview();
    expect(spawn).toHaveBeenCalledTimes(2);

    pass(t1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    expect(orchestrator.getTaskIsolation('t1')).toMatchObject({ state: 'kept' });
    expect(isolation.taskIdsFor('release')).toEqual([]);
    expect(vi.mocked(notifications.error).mock.calls.flat().join('\n')).toMatch(/integrat/i);
    expect(orchestrator.status).toBe('approved');
  });

  it('keeps a failed task\'s worktree for inspection', async () => {
    const { orchestrator, isolation, sessionFor } = setup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();

    sessionFor('t1')!.emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: true });
    expect(isolation.taskIdsFor('integrate')).toEqual([]);
    expect(orchestrator.getTaskIsolation('t1')).toMatchObject({ state: 'kept' });
  });

  it('retries from a fresh worktree on the current integration tip, discarding the kept one', async () => {
    const { orchestrator, isolation, pass, sessionFor, spawn, spawnedCwd } = setup();
    const t2 = task('t2', 2);
    orchestrator.loadPlan([task('t1', 1), t2]);
    await orchestrator.approveReview();
    pass(t2);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t2')!.status).toBe('completed'));
    sessionFor('t1')!.emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    await orchestrator.retryTask('t1');
    await orchestrator.start();

    expect(spawn).toHaveBeenCalledTimes(3);
    const afterFailure = isolation.calls.slice(isolation.calls.findIndex((c) => c.op === 'release' && c.keep));
    expect(afterFailure.map((c) => c.op + ('taskId' in c ? `:${c.taskId}` : ''))).toEqual([
      'release:t1', 'handoff', 'release:t1', 'isActive', 'prepare:t1',
    ]);
    expect(afterFailure[2]).toEqual({ op: 'release', taskId: 't1', keep: false });
    expect(spawn.mock.calls[2][0].cwd).toBe('/fake-worktrees/run1/1-t1');
    expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
  });

  it('removes a cancelled task\'s worktree and branch', async () => {
    const { orchestrator, isolation } = setup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();

    await orchestrator.cancelTask('t1');

    expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: false });
    expect(orchestrator.getTaskIsolation('t1')).toEqual({ state: 'none' });
  });

  it('removes the worktree of a task that leaves the plan', async () => {
    const { orchestrator, isolation } = setup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();

    await orchestrator.releaseTask('t1');

    expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: false });
  });

  it('lets a cancel during a merge wait for the merge before removing the worktree', async () => {
    const { orchestrator, isolation, pass } = setup();
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1]);
    await orchestrator.approveReview();
    const openMerge = isolation.holdIntegration('t1');
    pass(t1);
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1']));

    const cancelled = orchestrator.cancelTask('t1');
    await new Promise((r) => setTimeout(r, 10));
    expect(isolation.taskIdsFor('release')).toEqual([]);
    openMerge();
    await cancelled;

    expect(isolation.taskIdsFor('release')).toEqual(['t1']);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');
  });

  it('removes a worktree whose attempt was cancelled while it was still being made', async () => {
    const isolation = new FakeWorktreeIsolation();
    let finishPrepare!: () => void;
    const prepare = isolation.prepare.bind(isolation);
    isolation.prepare = async (t, run) => {
      await new Promise<void>((r) => { finishPrepare = r; });
      return prepare(t, run);
    };
    const { orchestrator, spawn } = setup({ isolation });
    orchestrator.loadPlan([task('t1', 1)]);
    const started = orchestrator.approveReview();
    await vi.waitFor(() => expect(finishPrepare).toBeDefined());

    await orchestrator.cancelTask('t1');
    finishPrepare();
    await started;

    expect(spawn).not.toHaveBeenCalled();
    expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: false });
    expect(orchestrator.getTaskIsolation('t1')).toEqual({ state: 'none' });
  });

  it('keeps an interrupted task\'s worktree when the run is stopped', async () => {
    const { orchestrator, isolation } = setup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();

    orchestrator.stop();

    await vi.waitFor(() => expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: true }));
  });

  it('gives Run task and Force start the same worktree guarantees', async () => {
    const { orchestrator, isolation, spawnedCwd, pass } = setup();
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1, task('t2', 2)]);

    await orchestrator.runTask('t1');
    expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
    pass(t1);
    await vi.waitFor(() => expect(isolation.calls.map((c) => c.op)).toContain('handoff'));

    await orchestrator.forceStartTask('t2');
    expect(spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2');
    expect(isolation.calls.filter((c) => c.op === 'startRun')).toHaveLength(1);
  });

  it('hands over a manual run that ends by Mark complete rather than a verdict', async () => {
    const { orchestrator } = setup();
    const handoffs: unknown[] = [];
    orchestrator.subscribe({ onIsolationHandoff: (h) => handoffs.push(h) });
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.runTask('t1');

    await orchestrator.markTaskComplete('t1');

    expect(handoffs).toEqual([{
      branch: 'ordewell/run1/integration', baseRef: 'base0000', landed: [{ taskId: 't1', order: 1, title: 'Task t1' }],
    }]);
  });

  it('decides afresh after a cancelled manual run, instead of running a discarded run in the workspace root', async () => {
    const { orchestrator, spawn } = setup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.runTask('t1');
    await orchestrator.cancelTask('t1');

    await orchestrator.discardRun();
    await orchestrator.runTask('t1');

    expect(spawn.mock.calls[1][0].cwd).toBe('/fake-worktrees/run2/1-t1');
  });

  describe('when isolation is unavailable', () => {
    it.each([
      ['not-git', /not a git repository/i],
      ['git-missing', /git was not found/i],
      ['disabled', /isolation is off/i],
      ['no-commits', /no commits/i],
    ] as const)('runs in the workspace root when the workspace is %s, and says so once', async (reason, notice) => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason };
      const { orchestrator, spawnedCwd, notifications, pass } = setup({ isolation, workspace: '/plain' });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);

      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(spawnedCwd('t2')).toBe('/plain'));

      expect(spawnedCwd('t1')).toBe('/plain');
      expect(isolation.calls.map((c) => c.op)).toEqual(['isActive']);
      expect(vi.mocked(notifications.info).mock.calls.flat().filter((m) => notice.test(String(m)))).toHaveLength(1);
      expect(orchestrator.getTaskIsolation('t1')).toBeNull();
    });
  });

  describe('when the tree is dirty', () => {
    function dirty() {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty' };
      const observed: string[] = [];
      const env = setup({ isolation });
      env.orchestrator.subscribe({ onIsolationBlocked: ({ reason }) => observed.push(reason) });
      env.orchestrator.loadPlan([task('t1', 1)]);
      return { ...env, observed };
    }

    it('does not start, and says why', async () => {
      const { orchestrator, spawn, observed } = dirty();

      await orchestrator.approveReview();

      expect(spawn).not.toHaveBeenCalled();
      expect(observed).toEqual(['dirty']);
      expect(orchestrator.awaitingIsolationChoice).toBe(true);
      expect(orchestrator.isRunning).toBe(false);
    });

    it('goes on isolated once the changes are stashed', async () => {
      const { orchestrator, isolation, spawnedCwd } = dirty();
      await orchestrator.approveReview();

      await orchestrator.continueBlockedRun('stash');

      expect(isolation.calls.map((c) => c.op)).toContain('stash');
      expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
      expect(orchestrator.awaitingIsolationChoice).toBe(false);
    });

    it('goes on in the workspace root for this run when the user opts out of isolation', async () => {
      const { orchestrator, isolation, spawnedCwd } = dirty();
      await orchestrator.approveReview();

      await orchestrator.continueBlockedRun('shared');

      expect(spawnedCwd('t1')).toBe('/repo');
      expect(isolation.calls.map((c) => c.op)).not.toContain('startRun');
    });

    it('blocks a manual task run the same way', async () => {
      const { orchestrator, spawn, observed, spawnedCwd } = dirty();

      await orchestrator.runTask('t1');
      expect(spawn).not.toHaveBeenCalled();
      expect(observed).toEqual(['dirty']);

      await orchestrator.continueBlockedRun('stash');
      expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
    });
  });

  it('hands the integration branch over when the plan settles, before reporting completion', async () => {
    const { orchestrator, pass } = setup();
    const events: string[] = [];
    let handoff: unknown;
    orchestrator.subscribe({
      onIsolationHandoff: (h) => { events.push('handoff'); handoff = h; },
      onExecutionComplete: () => events.push('complete'),
    });
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1]);
    await orchestrator.approveReview();

    pass(t1);
    await vi.waitFor(() => expect(events).toEqual(['handoff', 'complete']));

    expect(handoff).toEqual({
      branch: 'ordewell/run1/integration',
      baseRef: 'base0000',
      landed: [{ taskId: 't1', order: 1, title: 'Task t1' }],
    });
  });

  it('starts a new run from the checked-out commit when the previous one landed nothing', async () => {
    const { orchestrator, isolation, sessionFor, spawnedCwd, spawn } = setup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();
    sessionFor('t1')!.emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    await orchestrator.retryTask('t1');
    await orchestrator.start();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(isolation.calls).toContainEqual({ op: 'discard', keepIntegration: false });
    expect(spawn.mock.calls[1][0].cwd).toBe('/fake-worktrees/run2/1-t1');
    expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
  });

  describe('Mark complete', () => {
    it('integrates the work of a task the user vouches for', async () => {
      const { orchestrator, isolation } = setup();
      orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();

      await orchestrator.markTaskComplete('t1');

      expect(isolation.taskIdsFor('integrate')).toEqual(['t1']);
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed');
      expect(orchestrator.getTaskIsolation('t1')).toMatchObject({ state: 'integrated' });
    });

    it('lands a conflicted task once the user has resolved it by hand', async () => {
      const { orchestrator, isolation, pass, spawnedCwd } = setup();
      isolation.outcomes.set('t1', 'conflict');
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      isolation.outcomes.set('t1', 'merged');
      await orchestrator.markTaskComplete('t1');

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed');
      expect(spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2');
    });

    it('is not mistaken for a checkpoint: approving one does not put it back to running', async () => {
      const { orchestrator, isolation, pass } = setup();
      isolation.outcomes.set('t1', 'conflict');
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      orchestrator.approveCheckpoint('t1');
      orchestrator.rejectCheckpoint('t1');

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
    });

    it('leaves a still-conflicting task waiting on the user', async () => {
      const { orchestrator, isolation, pass, spawn } = setup();
      isolation.outcomes.set('t1', 'conflict');
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      await orchestrator.markTaskComplete('t1');

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolving a conflict as a task', () => {
    async function conflicted() {
      const env = setup();
      env.isolation.outcomes.set('t1', 'conflict');
      const t1 = task('t1', 1);
      env.orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await env.orchestrator.approveReview();
      env.pass(t1);
      await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));
      return env;
    }

    it('re-integrates the conflicted task once the resolver lands, which frees its dependents', async () => {
      const { orchestrator, isolation, pass, spawnedCwd } = await conflicted();
      const resolver = orchestrator.storeInstance.add({ title: 'Resolve', prompt: 'merge it' });
      orchestrator.linkConflictResolver(resolver.id, 't1');
      isolation.outcomes.set('t1', 'merged');

      await orchestrator.tick();
      expect(spawnedCwd(resolver.id)).toBe(`/fake-worktrees/run1/3-${resolver.id}`);
      pass(resolver);

      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
      expect(isolation.taskIdsFor('integrate')).toEqual(['t1', resolver.id, 't1']);
      await vi.waitFor(() => expect(spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2'));
      expect(orchestrator.isolationRecord?.resolvers).toEqual({});
    });

    it('does not land a conflicted task the user retried meanwhile, whose new attempt is still running', async () => {
      const { orchestrator, isolation, pass, sessionFor } = await conflicted();
      const resolver = orchestrator.storeInstance.add({ title: 'Resolve', prompt: 'merge it' });
      orchestrator.linkConflictResolver(resolver.id, 't1');
      isolation.outcomes.set('t1', 'merged');
      await orchestrator.retryTask('t1');
      await vi.waitFor(() => expect(sessionFor(resolver.id)).toBeDefined());

      pass(resolver);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get(resolver.id)!.status).toBe('completed'));
      await new Promise((r) => setTimeout(r, 10));

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
      expect(isolation.taskIdsFor('integrate')).toEqual(['t1', resolver.id]);
    });
  });

  describe('a resumed plan', () => {
    it('adopts its persisted run, prunes what a crash left behind, and continues it', async () => {
      const { orchestrator, isolation, spawnedCwd } = setup();
      const run = {
        id: 'old', workspaceRoot: '/repo', baseRef: 'abc', integrationBranch: 'ordewell/old/integration',
        tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', worktree: '/wt/1', status: 'merged' as const, linked: [] } },
      };
      orchestrator.loadPlan([task('t1', 1, { status: 'completed' }), task('t2', 2, { dependencies: ['t1'] })]);

      await orchestrator.adoptIsolation({ run, resolvers: {} });
      expect(isolation.calls).toEqual([{ op: 'pruneOrphans' }]);

      await orchestrator.approveReview();
      expect(spawnedCwd('t2')).toBe('/fake-worktrees/old/2-t2');
      expect(isolation.calls.map((c) => c.op)).not.toContain('startRun');
      expect(orchestrator.getTaskIsolation('t1')).toMatchObject({ state: 'integrated' });
    });

    it('keeps the integration branch of a run it cannot continue while that branch holds landed work', async () => {
      const { orchestrator, isolation, spawnedCwd } = setup({ workspace: '/repo' });
      const run = {
        id: 'old', workspaceRoot: '/elsewhere/repo', baseRef: 'abc', integrationBranch: 'ordewell/old/integration',
        tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', worktree: '/wt/1', status: 'merged' as const, linked: [] } },
      };
      orchestrator.loadPlan([task('t1', 1, { status: 'completed' }), task('t2', 2)]);
      await orchestrator.adoptIsolation({ run, resolvers: {} });

      await orchestrator.approveReview();

      expect(spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2');
      expect(isolation.calls).toContainEqual({ op: 'discard', keepIntegration: true });
      expect(isolation.calls).not.toContainEqual({ op: 'discard', keepIntegration: false });
    });
  });

  it('reads a worktree task\'s transcript by the worktree it ran in, and its live output by task', async () => {
    const queries: TranscriptQuery[] = [];
    const output = new BufferedTaskOutputSource({
      transcripts: { finalAssistantText: async (q) => { queries.push(q); return 'answer from the worktree'; } },
    });
    const isolation = new FakeWorktreeIsolation();
    const { sessions, runner } = sessionRunner();
    const orchestrator = new TaskOrchestrator(fakeConfig(), fakeNotification(), runner, undefined, output, isolation);
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1]);
    await orchestrator.approveReview();

    sessions[0].emitOutput('working in the worktree\n');
    expect(orchestrator.getLiveOutput('t1', { maxLines: 5 })!.text).toContain('working in the worktree');
    sessions[0].emitOutput(`<<<ORDEWELL_DONE_${t1.completionMarker}>>>`);

    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
    expect(queries[0]).toMatchObject({ cwd: '/fake-worktrees/run1/1-t1', marker: 'mk-t1' });
    expect(orchestrator.storeInstance.get('t1')!.outputSummary?.logTail).toBe('answer from the worktree');
  });
});

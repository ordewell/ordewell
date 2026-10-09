import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { IsolationAvailability, IsolationMergeResult, RepairEvidence } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, FakeTerminalSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
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

function setup(opts: { isolation?: FakeWorktreeIsolation; workspace?: string; config?: Partial<IConfig> } = {}) {
  const isolation = opts.isolation ?? new FakeWorktreeIsolation();
  const { sessions, spawn, runner } = sessionRunner();
  const notifications = fakeNotification();
  const output = new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } });
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(opts.config),
    notifications,
    terminalRunner: runner,
    output,
    isolation,
    workspaceRoot: () => opts.workspace ?? '/repo',
  });
  const spawnedCwd = (taskId: string) => spawn.mock.calls.find(([o]) => o.taskId === taskId)?.[0].cwd;
  const sessionFor = (taskId: string) => sessions.find((s) => s.taskId === taskId);
  const pass = (task: Task) => sessionFor(task.id)!.emitOutput(`<<<ORDEWELL_DONE_${task.completionMarker}>>>`);
  /** The task's newest session: a repair is a second attempt of the same task. */
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const passLatest = (task: Task) => latest(task.id).emitOutput(`<<<ORDEWELL_DONE_${task.completionMarker}>>>`);
  return { orchestrator, isolation, spawn, sessions, notifications, spawnedCwd, sessionFor, pass, latest, passLatest, runner };
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

  it('an observer whose onTaskChanged throws does not release the task\'s worktree', async () => {
    const { orchestrator, isolation } = setup();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    orchestrator.subscribe({ onTaskChanged: () => { throw new Error('boom'); } });
    orchestrator.loadPlan([task('t1', 1)]);

    await orchestrator.approveReview();

    await vi.waitFor(() => expect(orchestrator.getAttempt('t1')?.phase).toBe('running'));
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
    expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'active' });
    expect(isolation.taskIdsFor('release')).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
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
    expect(orchestrator.runs.taskIsolation('t1')).toEqual({
      state: 'integrated', branch: 'ordewell/run1/1-t1', worktree: '/fake-worktrees/run1/1-t1', repos: ['.'],
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
    await flushMicrotasks();
    expect(spawn).toHaveBeenCalledTimes(1);

    openMerge();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(isolation.calls.map((c) => c.op + ('taskId' in c ? `:${c.taskId}` : ''))).toEqual([
      'isActive', 'startRun', 'sweep', 'prepare:t1', 'integrate:t1', 'prepare:t2',
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
    await flushMicrotasks();

    expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'conflict', branch: 'ordewell/run1/1-t1' });
    expect(orchestrator.storeInstance.get('t1')!.awaitingReason).toBe('conflict');
    expect(isolation.taskIdsFor('release')).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifications.warn).mock.calls.flat().join('\n')).toMatch(/conflict/i);
  });

  it('pauses a passed task whose integration git refused instead of contradicting its marker with a red X', async () => {
    const { orchestrator, isolation, pass, spawn, notifications } = setup();
    isolation.outcomes.set('t1', 'failed');
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1, task('t2', 2)]);
    await orchestrator.approveReview();
    expect(spawn).toHaveBeenCalledTimes(2);

    pass(t1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

    expect(orchestrator.storeInstance.get('t1')!.verdict!.outcome).toBe('pass');
    expect(orchestrator.storeInstance.get('t1')!.awaitingReason).toBe('conflict');
    expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' });
    expect(isolation.taskIdsFor('release')).toEqual([]);
    expect(vi.mocked(notifications.error).mock.calls.flat().join('\n')).toMatch(/integrat/i);
    expect(orchestrator.status).toBe('running');
  });

  it('does not halt the run when a landing fails: independent work starts in the freed slot, dependents wait', async () => {
    const { orchestrator, isolation, pass, spawnedCwd } = setup({ config: { maxParallelSessions: 1 } });
    isolation.outcomes.set('t1', 'failed');
    const t1 = task('t1', 1);
    const t2 = task('t2', 2);
    orchestrator.loadPlan([t1, t2, task('t3', 3, { dependencies: ['t1'] })]);
    await orchestrator.approveReview();
    expect(spawnedCwd('t2')).toBeUndefined();

    pass(t1);
    await vi.waitFor(() => expect(spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2'));

    expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
    expect(orchestrator.status).toBe('running');
    pass(t2);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t2')!.status).toBe('completed'));
    expect(spawnedCwd('t3')).toBeUndefined();
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
  });

  it('keeps a failed task\'s worktree for inspection', async () => {
    const { orchestrator, isolation, sessionFor } = setup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();

    sessionFor('t1')!.emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: true });
    expect(isolation.taskIdsFor('integrate')).toEqual([]);
    expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' });
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
      'release:t1', 'findInHead', 'handoff', 'release:t1', 'isActive', 'sweep', 'prepare:t1',
    ]);
    expect(afterFailure[3]).toEqual({ op: 'release', taskId: 't1', keep: false });
    expect(spawn.mock.calls[2][0].cwd).toBe('/fake-worktrees/run1/1-t1');
    expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
  });

  it('keeps a cancelled task\'s worktree, so Mark complete can still land its work', async () => {
    const { orchestrator, isolation } = setup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.approveReview();

    await orchestrator.cancelTask('t1');

    expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: true });
    expect(isolation.calls).not.toContainEqual({ op: 'release', taskId: 't1', keep: false });
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');

    await orchestrator.markTaskComplete('t1');

    expect(isolation.taskIdsFor('integrate')).toEqual(['t1']);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed');
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
    await flushMicrotasks();
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
    expect(orchestrator.runs.taskIsolation('t1')).toEqual({ state: 'none' });
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
      repos: [{ path: '.', integrationBranch: 'ordewell/run1/integration', baseRef: 'base0000', landed: [{ taskId: 't1', order: 1, title: 'Task t1' }] }],
      landed: [{ taskId: 't1', order: 1, title: 'Task t1' }],
    }]);
  });

  it('decides afresh after a cancelled manual run, instead of running a discarded run in the workspace root', async () => {
    const { orchestrator, spawn } = setup();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.runTask('t1');
    await orchestrator.cancelTask('t1');

    await orchestrator.runs.discard();
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
      expect(orchestrator.runs.taskIsolation('t1')).toBeNull();
    });
  });

  describe('the notice for a folder of repositories', () => {
    async function noticesFor(availability: IsolationAvailability): Promise<string[]> {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = availability;
      const { orchestrator, notifications } = setup({ isolation, workspace: '/plain' });
      orchestrator.loadPlan([task('t1', 1)]);
      await orchestrator.runTask('t1');
      return vi.mocked(notifications.info).mock.calls.map((c) => String(c[0]));
    }

    it('names the repositories of a folder when none of them has a commit', async () => {
      expect(await noticesFor({ active: false, reason: 'no-commits', repos: ['api', 'web'] })).toContain(
        'No repository in this folder has commits yet (api, web) — tasks run in the workspace root without worktree isolation.',
      );
    });

    it('names the repositories nested in a lone repository, shared live', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.shared = ['services/billing', 'tools/cli'];
      const { orchestrator, notifications } = setup({ isolation });
      orchestrator.loadPlan([task('t1', 1)]);
      await orchestrator.approveReview();
      expect(vi.mocked(notifications.info).mock.calls.map((c) => String(c[0]))).toContain(
        'services/billing, tools/cli are repositories nested inside this one — linked live into every task, so edits there are not isolated.',
      );
    });

    it('keeps the plain wording when there is nothing to name', async () => {
      expect(await noticesFor({ active: false, reason: 'not-git' })).toContain(
        'Not a git repository — tasks run in the workspace root without worktree isolation.',
      );
    });
  });

  describe('a run over a repo group', () => {
    it('names the repositories and paths every task shares live, once per run', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.repos = ['api', 'web'];
      isolation.shared = ['NOTES.md', 'design', 'scratch'];
      isolation.sharedRepos = ['scratch'];
      const { orchestrator, notifications } = setup({ isolation, workspace: '/group' });
      orchestrator.loadPlan([task('t1', 1), task('t2', 2)]);

      await orchestrator.approveReview();

      const notices = vi.mocked(notifications.info).mock.calls.map((c) => String(c[0]));
      expect(notices.filter((n) => /shared live/i.test(n))).toEqual([
        'Could not isolate scratch (no commits, or git refused a worktree). It and NOTES.md, design are shared live with every task, so edits to them are not isolated.',
      ]);
    });

    it('names loose paths alone when every repository isolated', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.repos = ['api', 'web'];
      isolation.shared = ['NOTES.md'];
      const { orchestrator, notifications } = setup({ isolation, workspace: '/group' });
      orchestrator.loadPlan([task('t1', 1)]);

      await orchestrator.approveReview();

      expect(vi.mocked(notifications.info).mock.calls.map((c) => String(c[0]))).toContain(
        'NOTES.md is shared live with every task, so edits to it are not isolated.',
      );
    });

    it('says nothing about sharing for a group of one', async () => {
      const { orchestrator, notifications } = setup();
      orchestrator.loadPlan([task('t1', 1)]);
      await orchestrator.approveReview();
      expect(vi.mocked(notifications.info).mock.calls.flat().join('\n')).not.toMatch(/shared live/i);
    });

    it('says which paths a task got copies of, each only once per run', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.copied = ['api/.env'];
      const { orchestrator, notifications, pass, spawnedCwd } = setup({ isolation, workspace: '/group' });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);

      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(spawnedCwd('t2')).toBeDefined());

      const copies = vi.mocked(notifications.warn).mock.calls.map((c) => String(c[0])).filter((n) => /cop(y|ies)/i.test(n));
      expect(copies).toEqual([
        'api/.env could not be linked into task workspaces (a hard link is impossible there), so each task gets a copy: edits to it stay in the task.',
      ]);
    });

    it('tells the planner the layout of the run in force, or else of the next one', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: true, repos: ['api', 'web'], shared: ['NOTES.md'] };
      const { orchestrator } = setup({ isolation, workspace: '/group' });
      expect(await orchestrator.runs.plannerLayout()).toEqual({ repos: ['api', 'web'], shared: ['NOTES.md'] });

      isolation.repos = ['api', 'web', 'infra'];
      isolation.shared = ['design'];
      orchestrator.loadPlan([task('t1', 1)]);
      await orchestrator.approveReview();
      expect(await orchestrator.runs.plannerLayout()).toEqual({ repos: ['api', 'web', 'infra'], shared: ['design'] });
      expect(orchestrator.runs.skillLayout()).toEqual({ repos: ['api', 'web', 'infra'], worktrees: true });
    });

    function group(configure: (isolation: FakeWorktreeIsolation) => void = () => undefined) {
      const isolation = new FakeWorktreeIsolation();
      isolation.repos = ['api', 'web'];
      configure(isolation);
      return setup({ isolation, workspace: '/group' });
    }

    it('names the repository and files a task\'s landing conflicted in, and says none of it landed', async () => {
      const { orchestrator, notifications, pass } = group((iso) => {
        iso.outcomes.set('t1', 'conflict');
        iso.stopsIn.set('t1', 'web');
        iso.conflictFiles.set('t1', ['web.txt']);
      });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();

      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      expect(orchestrator.runs.taskIsolation('t1')).toEqual({
        state: 'conflict', branch: 'ordewell/run1/1-t1', worktree: '/fake-worktrees/run1/1-t1', repos: ['api', 'web'], conflictRepo: 'web', conflictFiles: ['web.txt'],
      });
      expect(vi.mocked(notifications.warn).mock.calls.map((c) => String(c[0]))).toContain(
        'Task "Task t1" passed, but landing it on ordewell/run1/integration conflicted in web (web.txt), so none of it landed. Its worktrees are kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.',
      );
    });

    it('caps a long list of conflicting files', async () => {
      const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
      const { orchestrator, notifications, pass } = group((iso) => {
        iso.outcomes.set('t1', 'conflict');
        iso.stopsIn.set('t1', 'web');
        iso.conflictFiles.set('t1', files);
      });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1]);
      await orchestrator.approveReview();

      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      expect(vi.mocked(notifications.warn).mock.calls.map((c) => String(c[0]))).toContain(
        'Task "Task t1" passed, but landing it on ordewell/run1/integration conflicted in web (a.ts, b.ts, c.ts, d.ts, e.ts, +1 more), so none of it landed. Its worktrees are kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.',
      );
    });

    it('names the repository git could not integrate a task in', async () => {
      const { orchestrator, notifications, pass } = group((iso) => {
        iso.outcomes.set('t1', 'failed');
        iso.stopsIn.set('t1', 'api');
      });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1]);
      await orchestrator.approveReview();

      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      expect(orchestrator.storeInstance.get('t1')!.verdict!.outcome).toBe('pass');
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept', conflictRepo: 'api' });
      expect(vi.mocked(notifications.error).mock.calls.map((c) => String(c[0]))).toContain(
        'Task "Task t1" passed, but git could not integrate its work in api, so none of it landed. Its worktrees are kept for inspection.',
      );
    });

    it('waits for the whole task to land before starting a dependent', async () => {
      const { orchestrator, isolation, pass, spawn } = group((iso) => iso.changes.set('t1', ['api', 'web']));
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();
      const openMerge = isolation.holdIntegration('t1');

      pass(t1);
      await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1']));
      await flushMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(1);

      openMerge();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    });

    describe('Merge all', () => {
      async function settled(result: IsolationMergeResult) {
        const env = group((iso) => { iso.mergeResult = result; });
        const t1 = task('t1', 1);
        env.orchestrator.loadPlan([t1]);
        await env.orchestrator.approveReview();
        env.pass(t1);
        await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
        return { ...env, merged: await env.orchestrator.mergeRun() };
      }
      const said = (fn: (message: string) => void) => vi.mocked(fn).mock.calls.map((c) => String(c[0]));

      it('says each repository that blocked it, and why, and that nothing was merged', async () => {
        const result: IsolationMergeResult = {
          outcome: 'blocked',
          blocked: [
            { repo: 'api', reason: 'uncommitted-changes', files: ['api.txt', 'b.txt'] },
            { repo: 'web', reason: 'conflict', files: ['web.txt'] },
            { repo: 'docs', reason: 'merge-in-progress', files: [] },
          ],
        };
        const { notifications, merged } = await settled(result);

        expect(merged).toEqual(result);
        expect(said(notifications.warn)).toContain(
          'Merged nothing, so every tree is as it was: api has uncommitted changes to api.txt, b.txt; web would conflict in web.txt; docs has a merge in progress.',
        );
      });

      it('says which repositories stay merged when a merge stops part-way', async () => {
        const { notifications } = await settled({ outcome: 'conflict', repo: 'web', files: ['web.txt'], landed: ['api'] });

        expect(said(notifications.warn)).toContain(
          'Merging ordewell/run1/integration conflicted in web (web.txt), so it was aborted there. api was merged already and stays merged.',
        );
      });

      it('reports a merge that could not start in a repository as an error, and that nothing landed', async () => {
        const { notifications } = await settled({ outcome: 'failed', repo: 'api' });

        expect(said(notifications.error)).toContain(
          'Could not merge ordewell/run1/integration in api — finish or abort any merge in progress there, then try again. Nothing was merged.',
        );
      });

      it('says it merged into the checked-out branch of every repository', async () => {
        const { notifications } = await settled({ outcome: 'merged' });
        expect(said(notifications.info)).toContain('Merged ordewell/run1/integration into the checked-out branch of every repository.');
      });

      it('names a task that only landed after a conflict repair, and its files (ADR-0015)', async () => {
        const isolation = new FakeWorktreeIsolation();
        isolation.repos = ['api', 'web'];
        isolation.outcomes.set('t1', 'conflict');
        isolation.stopsIn.set('t1', 'web');
        isolation.conflictFiles.set('t1', ['web.txt']);
        const { orchestrator, notifications, pass, passLatest, spawn } =
          setup({ isolation, workspace: '/group', config: { conflictRepairAttempts: 2 } });
        const t1 = task('t1', 1);
        orchestrator.loadPlan([t1]);
        await orchestrator.approveReview();
        pass(t1);
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

        isolation.outcomes.set('t1', 'merged');
        passLatest(t1);
        await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

        await orchestrator.mergeRun();
        expect(said(notifications.info)).toContain(
          'Merged ordewell/run1/integration into the checked-out branch of every repository. Task t1 (web/web.txt) landed through a conflict repair.',
        );
      });
    });

    it('runs in the workspace root when no repository of the group could be isolated after all', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.startRunError = new Error('No repository could be isolated: api, web');
      const { orchestrator, notifications, spawnedCwd } = setup({ isolation, workspace: '/group' });
      orchestrator.loadPlan([task('t1', 1)]);

      await orchestrator.approveReview();

      expect(spawnedCwd('t1')).toBe('/group');
      expect(vi.mocked(notifications.info).mock.calls.map((c) => String(c[0]))).toContain(
        'No repository could be isolated: api, web — tasks run in the workspace root without worktree isolation.',
      );
      expect(orchestrator.runs.taskIsolation('t1')).toBeNull();
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

    it('names the dirty repositories of a group', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty', repos: ['api', 'web'] };
      const { orchestrator } = setup({ isolation });
      const blocked: Array<{ reason: 'dirty'; repos: string[] }> = [];
      orchestrator.subscribe({ onIsolationBlocked: (data) => blocked.push(data) });
      orchestrator.loadPlan([task('t1', 1)]);

      await orchestrator.approveReview();

      expect(blocked).toEqual([{ reason: 'dirty', repos: ['api', 'web'] }]);
    });

    it('does not start, and says why', async () => {
      const { orchestrator, spawn, observed } = dirty();

      await orchestrator.approveReview();

      expect(spawn).not.toHaveBeenCalled();
      expect(observed).toEqual(['dirty']);
      expect(orchestrator.runs.blocked).toBe(true);
      expect(orchestrator.hasLiveWork).toBe(false);
    });

    it('goes on isolated once the changes are stashed', async () => {
      const { orchestrator, isolation, spawnedCwd } = dirty();
      await orchestrator.approveReview();

      await orchestrator.continueBlockedRun('stash');

      expect(isolation.calls.map((c) => c.op)).toContain('stash');
      expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
      expect(orchestrator.runs.blocked).toBe(false);
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

  describe('the notices a surface is handed', () => {
    function heard(orchestrator: TaskOrchestrator) {
      const notices: Array<{ level: string; message: string }> = [];
      orchestrator.subscribe({ onIsolationNotice: (n) => notices.push(n) });
      return notices;
    }

    it('hands over the fallback to the workspace root, which the notification channel may drop', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'not-git' };
      const { orchestrator } = setup({ isolation, workspace: '/plain' });
      const notices = heard(orchestrator);
      orchestrator.loadPlan([task('t1', 1)]);

      await orchestrator.approveReview();

      expect(notices).toEqual([{
        level: 'info',
        message: 'Not a git repository — tasks run in the workspace root without worktree isolation.',
      }]);
    });

    it('hands over the shared paths of a group and the copies a task got', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.repos = ['api', 'web'];
      isolation.shared = ['NOTES.md'];
      isolation.copied = ['api/.env'];
      const { orchestrator } = setup({ isolation, workspace: '/group' });
      const notices = heard(orchestrator);
      orchestrator.loadPlan([task('t1', 1)]);

      await orchestrator.approveReview();

      expect(notices.map((n) => n.level)).toEqual(['info', 'warn']);
      expect(notices[0].message).toBe('NOTES.md is shared live with every task, so edits to it are not isolated.');
      expect(notices[1].message).toMatch(/^api\/\.env could not be linked/);
    });

    it('names the repositories it stashed, and where to pop them', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty', repos: ['api', 'web'] };
      const { orchestrator } = setup({ isolation });
      const notices = heard(orchestrator);
      orchestrator.loadPlan([task('t1', 1)]);
      await orchestrator.approveReview();

      await orchestrator.continueBlockedRun('stash');

      expect(notices).toContainEqual({
        level: 'info',
        message: 'Stashed your uncommitted changes in api, web — `git stash pop` in each brings them back.',
      });
    });

    it('keeps the stash notice as it was for a group of one', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty' };
      const { orchestrator, notifications } = setup({ isolation });
      orchestrator.loadPlan([task('t1', 1)]);
      await orchestrator.approveReview();

      await orchestrator.continueBlockedRun('stash');

      expect(vi.mocked(notifications.info)).toHaveBeenCalledWith('Stashed your uncommitted changes — `git stash pop` brings them back.');
    });

    it('hands over a task that could not spawn, which the notification channel may drop', async () => {
      const { orchestrator, spawn } = setup();
      const notices = heard(orchestrator);
      spawn.mockRejectedValueOnce(new Error('opencode ENOENT'));
      orchestrator.loadPlan([task('t1', 1)]);

      await orchestrator.approveReview();

      expect(notices).toContainEqual({
        level: 'error',
        message: 'Failed to start task "Task t1": Error: opencode ENOENT',
      });
    });
  });

  it('has the run saved with its landing before anything merges', async () => {
    const { orchestrator, isolation, pass } = setup();
    const saved: unknown[] = [];
    orchestrator.subscribe({ onIsolationChanged: () => saved.push(JSON.parse(JSON.stringify(orchestrator.runs.planIsolation!.run.landing ?? null))) });
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1]);
    await orchestrator.approveReview();
    const openMerge = isolation.holdIntegration('t1');

    pass(t1);
    await vi.waitFor(() => expect(saved).toContainEqual({ taskId: 't1', tips: { '.': 'tip-.' } }));

    openMerge();
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
    expect(saved.at(-1)).toBeNull();
  });

  it('words a group of one\'s conflict and Merge all as it always has', async () => {
    const { orchestrator, isolation, notifications, pass } = setup();
    isolation.outcomes.set('t1', 'conflict');
    const t1 = task('t1', 1);
    orchestrator.loadPlan([t1]);
    await orchestrator.approveReview();
    pass(t1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));
    isolation.mergeResult = { outcome: 'conflict', repo: '.', files: ['a.txt'] };
    await orchestrator.mergeRun();
    isolation.mergeResult = { outcome: 'failed', repo: '.' };
    await orchestrator.mergeRun();

    const warned = vi.mocked(notifications.warn).mock.calls.map((c) => String(c[0]));
    expect(warned).toContain('Task "Task t1" passed, but merging it into ordewell/run1/integration conflicted. Its worktree is kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.');
    expect(warned).toContain('Merging ordewell/run1/integration conflicted, so it was aborted — your tree is as it was.');
    expect(vi.mocked(notifications.error).mock.calls.map((c) => String(c[0]))).toContain(
      'Could not merge ordewell/run1/integration — finish or abort the merge already in progress, then try again.',
    );
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
      repos: [{ path: '.', integrationBranch: 'ordewell/run1/integration', baseRef: 'base0000', landed: [{ taskId: 't1', order: 1, title: 'Task t1' }] }],
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
    expect(isolation.calls).toContainEqual({ op: 'discard', integration: 'delete' });
    expect(spawn.mock.calls[1][0].cwd).toBe('/fake-worktrees/run2/1-t1');
    expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
  });

  it('restarts into the plan\'s own run while it still holds a kept attempt, instead of discarding its work', async () => {
    const { orchestrator, isolation, sessionFor } = setup();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await orchestrator.approveReview();
    sessionFor('t1')!.emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));
    expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' });

    orchestrator.stop();
    await orchestrator.start();

    // Only the first run was ever minted; minting another would have discarded
    // the kept attempt's branch.
    expect(isolation.calls.filter((c) => c.op === 'startRun')).toHaveLength(1);
    expect(isolation.calls.map((c) => c.op)).not.toContain('discard');
    expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' });
  });

  describe('Mark complete', () => {
    it('integrates the work of a task the user vouches for', async () => {
      const { orchestrator, isolation } = setup();
      orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();

      await orchestrator.markTaskComplete('t1');

      expect(isolation.taskIdsFor('integrate')).toEqual(['t1']);
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed');
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'integrated' });
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

  describe('conflict repair', () => {
    const messages = (fn: (message: string) => void) => vi.mocked(fn).mock.calls.map((c) => String(c[0]));

    function repairing(configure: (isolation: FakeWorktreeIsolation) => void = () => undefined, config: Partial<IConfig> = {}) {
      const isolation = new FakeWorktreeIsolation();
      isolation.outcomes.set('t1', 'conflict');
      isolation.conflictFiles.set('t1', ['a.ts']);
      configure(isolation);
      return setup({ isolation, config: { conflictRepairAttempts: 2, ...config } });
    }

    it('repairs a conflicted landing in the task\'s own worktree, on its own runner, model and mode, then lands it and frees its dependents', async () => {
      const { orchestrator, isolation, pass, passLatest, spawn, spawnedCwd, notifications } = repairing();
      const t1 = task('t1', 1, { assignedModel: { modelId: 'opus', modelLabel: 'Opus', thinkingEffort: 'high' }, taskMode: 'acceptEdits' });
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();

      pass(t1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

      const [first, repair] = spawn.mock.calls.map(([o]) => o);
      expect(repair).toMatchObject({ taskId: 't1', cwd: first.cwd, runner: first.runner, modelId: 'opus', thinkingEffort: 'high', mode: 'acceptEdits' });
      expect(repair.prompt).toContain('conflicted in a.ts');
      expect(repair.prompt).toContain('git merge --no-edit ordewell/run1/integration');
      expect(repair.prompt).toContain('What the task was asked to do:\ndo t1');
      expect(repair.prompt).toContain('DONE_mk-t1>>>');
      expect(isolation.taskIdsFor('prepare')).toEqual(['t1']);
      expect(isolation.taskIdsFor('reopen')).toEqual(['t1']);
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'repairing', repair: { attempt: 1, limit: 2 } });
      expect(messages(notifications.info)).toContain('Repairing the conflict of task "Task t1" in its own worktree (repair 1 of 2).');

      isolation.outcomes.set('t1', 'merged');
      passLatest(t1);

      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
      expect(isolation.taskIdsFor('verifyRepair')).toEqual(['t1']);
      expect(isolation.taskIdsFor('integrate')).toEqual(['t1', 't1']);
      await vi.waitFor(() => expect(spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2'));
      expect(messages(notifications.info)).toContain('Task "Task t1" landed after repairing a conflict in a.ts.');
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'integrated', repair: { attempt: 1, limit: 2 }, repairedFiles: ['a.ts'] });
    });

    it('repairs again when the repaired work conflicts again, then leaves the conflict for the user once the repairs are used up', async () => {
      const { orchestrator, isolation, pass, passLatest, spawn, notifications } = repairing();
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

      isolation.conflictFiles.set('t1', ['b.ts']);
      passLatest(t1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'repairing', repair: { attempt: 2, limit: 2 }, conflictFiles: ['b.ts'] });
      expect(spawn.mock.calls[2][0].prompt).toContain('conflicted in b.ts');
      expect(messages(notifications.info)).toContain('Repairing the conflict of task "Task t1" in its own worktree (repair 2 of 2).');

      passLatest(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));
      await flushMicrotasks();

      expect(spawn).toHaveBeenCalledTimes(3);
      expect(isolation.taskIdsFor('reopen')).toEqual(['t1', 't1']);
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'conflict', conflictFiles: ['b.ts'], repair: { attempt: 2, limit: 2 }, repairedFiles: ['a.ts', 'b.ts'] });
      expect(isolation.taskIdsFor('release')).toEqual([]);
      expect(messages(notifications.warn)).toContain('Task "Task t1" passed, but merging it into ordewell/run1/integration conflicted (b.ts). Its worktree is kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.');
      expect(messages(notifications.info)).toContain('Task "Task t1" has had 2 of its 2 conflict repairs, so its conflict waits for you.');
      expect(orchestrator.storeInstance.get('t1')!.verdict?.outcome).toBe('pass');
    });

    it('with conflictRepairAttempts at 0, leaves every conflict for the user as before, and says why', async () => {
      const { orchestrator, isolation, pass, spawn, notifications } = repairing(() => undefined, { conflictRepairAttempts: 0 });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();

      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));
      await flushMicrotasks();

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(isolation.taskIdsFor('reopen')).toEqual([]);
      expect(orchestrator.runs.taskIsolation('t1')).toEqual({
        state: 'conflict', branch: 'ordewell/run1/1-t1', worktree: '/fake-worktrees/run1/1-t1', repos: ['.'], conflictRepo: '.', conflictFiles: ['a.ts'],
      });
      expect(messages(notifications.warn)).toContain('Task "Task t1" passed, but merging it into ordewell/run1/integration conflicted (a.ts). Its worktree is kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.');
      expect(messages(notifications.info)).toContain('Conflict repair is off (conflictRepairAttempts is 0), so task "Task t1" waits for you.');
    });

    it('does not halt the run when a repair fails: the task waits on the user with its conflict, and other tasks keep landing', async () => {
      const { orchestrator, isolation, pass, latest, spawn, spawnedCwd, notifications } = repairing(undefined, { maxParallelSessions: 2 });
      const t1 = task('t1', 1);
      const t2 = task('t2', 2);
      orchestrator.loadPlan([t1, t2, task('t3', 3), task('t4', 4, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
      const originalVerdict = orchestrator.storeInstance.get('t1')!.verdict;

      latest('t1').emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      expect(orchestrator.storeInstance.get('t1')!.verdict).toEqual(originalVerdict);
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'conflict', conflictFiles: ['a.ts'], repair: { attempt: 1, limit: 2 } });
      expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: true });
      expect(orchestrator.status).toBe('running');
      expect(messages(notifications.warn).some((m) => m.startsWith('The conflict repair of task "Task t1" did not finish ('))).toBe(true);
      expect(vi.mocked(notifications.error)).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(spawnedCwd('t3')).toBe('/fake-worktrees/run1/3-t3'));
      pass(t2);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t2')!.status).toBe('completed'));
      expect(spawnedCwd('t4')).toBeUndefined();
      expect(isolation.taskIdsFor('reopen')).toEqual(['t1']);
    });

    it('never runs more than maxParallelSessions: a repair takes the slot its landing freed, or waits for one', async () => {
      const { orchestrator, isolation, pass, latest, spawn, spawnedCwd, notifications } = repairing(undefined, { maxParallelSessions: 1 });
      const t1 = task('t1', 1);
      const t2 = task('t2', 2);
      orchestrator.loadPlan([t1, t2]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
      expect(spawn.mock.calls[1][0].taskId).toBe('t1');
      expect(orchestrator.activeTaskIds).toEqual(['t1']);

      latest('t1').emitExit(1);
      await vi.waitFor(() => expect(spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2'));

      // The user vouches for the conflicted work while t2 holds the only slot: it conflicts again.
      await orchestrator.markTaskComplete('t1');
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');
      expect(orchestrator.activeTaskIds).toEqual(['t2']);
      expect(messages(notifications.info)).toContain('Task "Task t1" is repaired once a slot is free.');

      isolation.outcomes.set('t1', 'merged');
      pass(t2);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4));
      expect(spawn.mock.calls[3][0]).toMatchObject({ taskId: 't1', cwd: '/fake-worktrees/run1/1-t1' });
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'repairing', repair: { attempt: 2, limit: 2 } });
      expect(orchestrator.activeTaskIds).toEqual(['t1']);
    });

    it('starts a retried task over with every repair available again, from a fresh worktree', async () => {
      const { orchestrator, isolation, pass, latest, passLatest, spawn } = repairing(undefined, { conflictRepairAttempts: 1 });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
      latest('t1').emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      await orchestrator.retryTask('t1');
      expect(isolation.taskIdsFor('prepare')).toEqual(['t1', 't1']);
      expect(orchestrator.runs.taskIsolation('t1')).not.toHaveProperty('repair');
      passLatest(t1);

      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4));
      expect(isolation.taskIdsFor('reopen')).toEqual(['t1', 't1']);
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'repairing', repair: { attempt: 1, limit: 1 } });
    });

    it.each<[string, RepairEvidence, string]>([
      ['never merged the tip in', { ok: false, reason: 'not-merged', repo: 'web' }, 'finished, but its branch in web does not contain ordewell/run1/integration'],
      ['left conflict markers', { ok: false, reason: 'conflict-markers', repo: 'web', files: ['web.txt'] }, 'finished, but left conflict markers in web/web.txt'],
    ])('takes no repair at its word: one that %s does not land, and waits on the user', async (_, evidence, why) => {
      const { orchestrator, isolation, pass, passLatest, spawn, notifications } = repairing((iso) => {
        iso.repos = ['api', 'web'];
        iso.stopsIn.set('t1', 'web');
        iso.repairEvidence.set('t1', evidence);
      });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
      expect(spawn.mock.calls[1][0].prompt).toContain('In each repository the task changed — api, web — run `git merge --no-edit ordewell/run1/integration`');
      expect(messages(notifications.info)).toContain('Repairing the conflict of task "Task t1" in its own worktrees (repair 1 of 2).');
      isolation.outcomes.set('t1', 'merged');

      passLatest(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));
      await flushMicrotasks();

      expect(isolation.taskIdsFor('integrate')).toEqual(['t1']);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'conflict', conflictRepo: 'web', conflictFiles: ['a.ts'] });
      expect(messages(notifications.warn)).toContain(`The conflict repair of task "Task t1" ${why}, so it did not land. Its worktrees are kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.`);
    });

    it('keeps every way out of a conflict open after a failed repair: mark complete, or a resolver task', async () => {
      async function failedRepair() {
        const env = repairing(undefined, { conflictRepairAttempts: 1 });
        const t1 = task('t1', 1);
        env.orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
        await env.orchestrator.approveReview();
        env.pass(t1);
        await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(2));
        env.latest('t1').emitExit(1);
        await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));
        env.isolation.outcomes.set('t1', 'merged');
        return env;
      }

      const byHand = await failedRepair();
      await byHand.orchestrator.markTaskComplete('t1');
      expect(byHand.orchestrator.storeInstance.get('t1')!.status).toBe('completed');
      expect(byHand.spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2');

      const asTask = await failedRepair();
      const resolver = asTask.orchestrator.storeInstance.add({ title: 'Resolve', prompt: 'merge it' });
      asTask.orchestrator.runs.linkResolver(resolver.id, 't1');
      await asTask.orchestrator.tick();
      asTask.pass(resolver);
      await vi.waitFor(() => expect(asTask.orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
    });

    it('leaves the conflict for the user when a repair cannot even start, without holding anything else up', async () => {
      const { orchestrator, isolation, pass, spawn, notifications } = repairing();
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2)]);
      await orchestrator.approveReview();
      spawn.mockRejectedValueOnce(new Error('runner vanished'));

      pass(t1);

      await vi.waitFor(() => expect(messages(notifications.warn)).toContain(
        'The conflict repair of task "Task t1" could not start: runner vanished, so it did not land. Its worktree is kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.',
      ));
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'conflict', repair: { attempt: 1, limit: 2 } });
      expect(isolation.taskIdsFor('release')).toEqual(['t1']);
      expect(orchestrator.status).toBe('running');
      expect(orchestrator.activeTaskIds).toEqual(['t2']);
    });

    it('leaves a stopped repair\'s task waiting on the user with its conflict and its worktree', async () => {
      const { orchestrator, isolation, pass, spawn } = repairing();
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(orchestrator.getAttempt('t1')?.phase).toBe('running'));

      orchestrator.stop();

      await vi.waitFor(() => expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'conflict', conflictFiles: ['a.ts'], repair: { attempt: 1, limit: 2 } }));
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
      expect(orchestrator.storeInstance.get('t1')!.verdict?.outcome).toBe('pass');
      expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: true });
    });

    describe('restored from disk', () => {
      /** A saved run: t0 landed, t1 conflicted after `repairs` repairs, and the plan's next Execute has put t1 back up for scheduling. */
      function restored(repairs: number) {
        const env = repairing((iso) => iso.outcomes.set('t1', 'merged'));
        const workspace = '/wt/1';
        const run = {
          id: 'old', workspaceRoot: '/repo', shared: [], sharedRepos: [],
          repos: [{ path: '.', root: '/repo', baseRef: 'abc', integrationBranch: 'ordewell/old/integration' }],
          tasks: {
            t0: { taskId: 't0', order: 0, title: 'Task t0', branch: 'ordewell/old/0-t0', workspace: '/wt/0', status: 'merged' as const, repos: { '.': { worktree: '/wt/0', linked: [], changed: true } } },
            t1: {
              taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', workspace, status: 'conflict' as const,
              repos: { '.': { worktree: workspace, linked: [], changed: true } }, conflictRepo: '.', conflictFiles: ['a.ts'], repairs,
            },
          },
        };
        env.orchestrator.loadPlan([task('t0', 0, { status: 'completed' }), task('t1', 1, { status: 'approved' })]);
        return { ...env, adopt: () => env.orchestrator.runs.adopt({ run, resolvers: {} }), workspace };
      }

      it('repairs a conflicted task with repairs left when the run next schedules, counting from what was spent', async () => {
        const { orchestrator, isolation, adopt, spawn, passLatest, workspace } = restored(1);
        await adopt();

        await orchestrator.approveReview();

        expect(isolation.taskIdsFor('prepare')).toEqual([]);
        expect(isolation.taskIdsFor('reopen')).toEqual(['t1']);
        expect(spawn.mock.calls[0][0]).toMatchObject({ taskId: 't1', cwd: workspace });
        expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'repairing', repair: { attempt: 2, limit: 2 } });
        passLatest(orchestrator.storeInstance.get('t1')!);
        await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
      });

      it('never repairs a task past what it has spent already: it runs afresh, as a conflicted task always has', async () => {
        const { orchestrator, isolation, adopt, spawn } = restored(2);
        await adopt();

        await orchestrator.approveReview();

        expect(isolation.taskIdsFor('reopen')).toEqual([]);
        expect(isolation.taskIdsFor('prepare')).toEqual(['t1']);
        expect(spawn.mock.calls[0][0].prompt).not.toContain('git merge --no-edit');
      });
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
      orchestrator.runs.linkResolver(resolver.id, 't1');
      isolation.outcomes.set('t1', 'merged');

      await orchestrator.tick();
      expect(spawnedCwd(resolver.id)).toBe(`/fake-worktrees/run1/3-${resolver.id}`);
      pass(resolver);

      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
      expect(isolation.taskIdsFor('integrate')).toEqual(['t1', resolver.id, 't1']);
      await vi.waitFor(() => expect(spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2'));
      expect(orchestrator.runs.planIsolation?.resolvers).toEqual({});
    });

    it('does not land a conflicted task the user retried meanwhile, whose new attempt is still running', async () => {
      const { orchestrator, isolation, pass, sessionFor } = await conflicted();
      const resolver = orchestrator.storeInstance.add({ title: 'Resolve', prompt: 'merge it' });
      orchestrator.runs.linkResolver(resolver.id, 't1');
      isolation.outcomes.set('t1', 'merged');
      await orchestrator.retryTask('t1');
      await vi.waitFor(() => expect(sessionFor(resolver.id)).toBeDefined());

      pass(resolver);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get(resolver.id)!.status).toBe('completed'));
      await flushMicrotasks();

      expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
      expect(isolation.taskIdsFor('integrate')).toEqual(['t1', resolver.id]);
    });
  });

  describe('the branches runs leave behind', () => {
    async function landed(configure: (isolation: FakeWorktreeIsolation) => void = () => undefined) {
      const isolation = new FakeWorktreeIsolation();
      configure(isolation);
      const env = setup({ isolation });
      const t1 = task('t1', 1);
      env.orchestrator.loadPlan([t1]);
      await env.orchestrator.approveReview();
      env.pass(t1);
      await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
      return env;
    }

    it('clears the whole run up after a Merge all that merged everything, and forgets it', async () => {
      const { orchestrator, isolation } = await landed();
      let changed = 0;
      orchestrator.subscribe({ onIsolationChanged: () => { changed++; } });

      expect(await orchestrator.mergeRun()).toEqual({ outcome: 'merged' });

      expect(isolation.calls.slice(-3)).toEqual([{ op: 'mergeIntoCheckedOut' }, { op: 'findInHead' }, { op: 'discard', integration: 'delete-merged' }]);
      expect(orchestrator.runs.planIsolation).toBeNull();
      expect(orchestrator.runs.view()).toBeNull();
      expect(orchestrator.runs.taskIsolation('t1')).toBeNull();
      expect(changed).toBe(2);
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed');
    });

    it.each<[string, IsolationMergeResult]>([
      ['was blocked', { outcome: 'blocked', blocked: [{ repo: '.', reason: 'partial-landing', files: [] }] }],
      ['conflicted', { outcome: 'conflict', repo: '.', files: ['a.txt'] }],
      ['stopped part-way', { outcome: 'failed', repo: 'web', landed: ['api'] }],
    ])('deletes nothing and keeps the run after a Merge all that %s', async (_, result) => {
      const { orchestrator, isolation } = await landed((iso) => { iso.mergeResult = result; });

      await orchestrator.mergeRun();

      expect(isolation.calls.map((c) => c.op)).not.toContain('discard');
      expect(orchestrator.runs.view()?.handoff.landed).toEqual([{ taskId: 't1', order: 1, title: 'Task t1' }]);
    });

    it('keeps the run, and says why, when clearing it up after Merge all fails', async () => {
      const { orchestrator, notifications } = await landed((iso) => { iso.discardError = new Error('disk full'); });

      expect(await orchestrator.mergeRun()).toEqual({ outcome: 'merged' });

      expect(orchestrator.runs.planIsolation).not.toBeNull();
      expect(vi.mocked(notifications.warn).mock.calls.map((c) => String(c[0]))).toContain(
        'Merged, but could not clean up the run\'s worktrees and branches: disk full',
      );
    });

    it('starts the next run afresh once the last one is merged and cleared up', async () => {
      const { orchestrator, isolation, spawn } = await landed();
      await orchestrator.mergeRun();

      await orchestrator.retryTask('t1');
      await orchestrator.start();

      expect(spawn.mock.calls[1][0].cwd).toBe('/fake-worktrees/run2/1-t1');
      expect(isolation.calls.filter((c) => c.op === 'discard')).toEqual([{ op: 'discard', integration: 'delete-merged' }]);
    });

    it('warns when the sweep fails, and runs anyway', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.sweepError = new Error('git failed clearing merged branches of earlier runs in api');
      const { orchestrator, notifications, spawnedCwd } = setup({ isolation });
      orchestrator.loadPlan([task('t1', 1)]);

      await orchestrator.approveReview();

      expect(spawnedCwd('t1')).toBe('/fake-worktrees/run1/1-t1');
      expect(vi.mocked(notifications.warn).mock.calls.map((c) => String(c[0]))).toContain(
        'Could not clear merged branches of earlier runs: git failed clearing merged branches of earlier runs in api',
      );
    });
  });

  describe('a resumed plan', () => {
    it('adopts its persisted run, prunes what a crash left behind, and continues it', async () => {
      const { orchestrator, isolation, spawnedCwd } = setup();
      const run = {
        id: 'old', workspaceRoot: '/repo', shared: [], sharedRepos: [],
        repos: [{ path: '.', root: '/repo', baseRef: 'abc', integrationBranch: 'ordewell/old/integration' }],
        tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', workspace: '/wt/1', status: 'merged' as const, repos: { '.': { worktree: '/wt/1', linked: [], changed: true } } } },
      };
      orchestrator.loadPlan([task('t1', 1, { status: 'completed' }), task('t2', 2, { dependencies: ['t1'] })]);

      await orchestrator.runs.adopt({ run, resolvers: {} });
      expect(isolation.calls).toEqual([{ op: 'pruneOrphans' }]);

      await orchestrator.approveReview();
      expect(spawnedCwd('t2')).toBe('/fake-worktrees/old/2-t2');
      expect(isolation.calls.map((c) => c.op)).not.toContain('startRun');
      expect(isolation.calls.map((c) => c.op)).toContain('sweep');
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'integrated' });
    });

    it('gives up the integration branch of a run it cannot continue only where the user has merged it', async () => {
      const { orchestrator, isolation, spawnedCwd } = setup({ workspace: '/repo' });
      const run = {
        id: 'old', workspaceRoot: '/elsewhere/repo', shared: [], sharedRepos: [],
        repos: [{ path: '.', root: '/elsewhere/repo', baseRef: 'abc', integrationBranch: 'ordewell/old/integration' }],
        tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', workspace: '/wt/1', status: 'merged' as const, repos: { '.': { worktree: '/wt/1', linked: [], changed: true } } } },
      };
      orchestrator.loadPlan([task('t1', 1, { status: 'completed' }), task('t2', 2)]);
      await orchestrator.runs.adopt({ run, resolvers: {} });

      await orchestrator.approveReview();

      expect(spawnedCwd('t2')).toBe('/fake-worktrees/run1/2-t2');
      expect(isolation.calls.filter((c) => c.op === 'discard')).toEqual([{ op: 'discard', integration: 'delete-merged' }]);
    });

    it('tells the user when pruning found unlanded work in an active worktree', async () => {
      const { orchestrator, isolation, notifications } = setup();
      isolation.keptOnPrune = [{ taskId: 't1', order: 1, title: 'Task t1' }];
      const run = {
        id: 'old', workspaceRoot: '/repo', shared: [], sharedRepos: [],
        repos: [{ path: '.', root: '/repo', baseRef: 'abc', integrationBranch: 'ordewell/old/integration' }],
        tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', workspace: '/wt/1', status: 'active' as const, repos: { '.': { worktree: '/wt/1', linked: [] } } } },
      };
      orchestrator.loadPlan([task('t1', 1)]);

      await orchestrator.runs.adopt({ run, resolvers: {} });

      const warned = vi.mocked(notifications.warn).mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(/unlanded work/i);
      expect(warned).toContain('Task t1');
    });
  });

  it('reads a worktree task\'s transcript by the worktree it ran in, and its live output by task', async () => {
    const queries: TranscriptQuery[] = [];
    const output = new BufferedTaskOutputSource({
      transcripts: { finalAssistantText: async (q) => { queries.push(q); return 'answer from the worktree'; } },
    });
    const isolation = new FakeWorktreeIsolation();
    const { sessions, runner } = sessionRunner();
    const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications: fakeNotification(), terminalRunner: runner, output, isolation });
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

  describe('the agent a finished task leaves behind', () => {
    it('stops on its verdict, so none is left in a worktree Merge all removes', async () => {
      const { orchestrator, pass, sessionFor, runner } = setup();
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1]);
      await orchestrator.approveReview();
      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

      expect(runner.stop).toHaveBeenCalledWith(sessionFor('t1')!.id);
    });

    it('stops when a repair starts a new agent in the same worktree', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.outcomes.set('t1', 'conflict');
      const { orchestrator, pass, spawn, sessions, runner } = setup({ isolation, config: { conflictRepairAttempts: 1 } });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1]);
      await orchestrator.approveReview();

      pass(t1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

      expect(runner.stop).toHaveBeenCalledWith(sessions[0].id);
      expect(runner.stop).not.toHaveBeenCalledWith(sessions[1].id);
    });
  });
});

describe('TaskOrchestrator — a verdict whose settling throws', () => {
  it('keeps the passed task completed and says why the next one could not start', async () => {
    const isolation = new FakeWorktreeIsolation();
    const { orchestrator, notifications, pass, spawn } = setup({ isolation });
    const deploy = task('o1', 1, { ops: true });
    const build = task('t2', 2, { dependencies: ['o1'] });
    orchestrator.loadPlan([deploy, build]);
    await orchestrator.approveReview();
    isolation.isActive = async () => { throw new Error('git exploded'); };

    pass(deploy);

    await vi.waitFor(() => expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('git exploded')));
    expect(orchestrator.storeInstance.get('o1')!.status).toBe('completed');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(orchestrator.hasLiveWork).toBe(false);
  });

  it('leaves no unhandled rejection when saying the failure throws too', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const isolation = new FakeWorktreeIsolation();
      const { orchestrator, notifications, pass } = setup({ isolation });
      const deploy = task('o1', 1, { ops: true });
      orchestrator.loadPlan([deploy, task('t2', 2, { dependencies: ['o1'] })]);
      await orchestrator.approveReview();
      isolation.isActive = async () => { throw new Error('git exploded'); };
      vi.mocked(notifications.error).mockImplementation(() => { throw new Error('surface gone'); });

      pass(deploy);

      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('git exploded'), expect.anything()));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      errorSpy.mockRestore();
    }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { IsolationAvailability, IsolationMergeResult } from '../../interfaces/IWorktreeIsolation';
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
      repos: [{ path: '.', integrationBranch: 'ordewell/run1/integration', baseRef: 'base0000', landed: [{ taskId: 't1', order: 1, title: 'Task t1' }] }],
      landed: [{ taskId: 't1', order: 1, title: 'Task t1' }],
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
      ['nested-repos', /nested repositories/i],
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

    it('names the nested repositories that keep a repository from isolating', async () => {
      expect(await noticesFor({ active: false, reason: 'nested-repos', repos: ['services/billing', 'tools/cli'] })).toContain(
        'This repository contains nested repositories that are not submodules (services/billing, tools/cli) — tasks run in the workspace root without worktree isolation. Ignore them in git or make them submodules to isolate this repository.',
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
      expect(await orchestrator.plannerIsolation()).toEqual({ repos: ['api', 'web'], shared: ['NOTES.md'] });

      isolation.repos = ['api', 'web', 'infra'];
      isolation.shared = ['design'];
      orchestrator.loadPlan([task('t1', 1)]);
      await orchestrator.approveReview();
      expect(await orchestrator.plannerIsolation()).toEqual({ repos: ['api', 'web', 'infra'], shared: ['design'] });
    });

    function group(configure: (isolation: FakeWorktreeIsolation) => void = () => undefined) {
      const isolation = new FakeWorktreeIsolation();
      isolation.repos = ['api', 'web'];
      configure(isolation);
      return setup({ isolation, workspace: '/group' });
    }

    it('names the repository a task\'s landing conflicted in, and says none of it landed', async () => {
      const { orchestrator, notifications, pass } = group((iso) => {
        iso.outcomes.set('t1', 'conflict');
        iso.stopsIn.set('t1', 'web');
      });
      const t1 = task('t1', 1);
      orchestrator.loadPlan([t1, task('t2', 2, { dependencies: ['t1'] })]);
      await orchestrator.approveReview();

      pass(t1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));

      expect(orchestrator.getTaskIsolation('t1')).toEqual({
        state: 'conflict', branch: 'ordewell/run1/1-t1', worktree: '/fake-worktrees/run1/1-t1', repos: ['api', 'web'], conflictRepo: 'web',
      });
      expect(vi.mocked(notifications.warn).mock.calls.map((c) => String(c[0]))).toContain(
        'Task "Task t1" passed, but landing it on ordewell/run1/integration conflicted in web, so none of it landed. Its worktrees are kept — resolve it by hand, retry it, or resolve it as a task.',
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
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

      expect(orchestrator.getTaskIsolation('t1')).toMatchObject({ state: 'kept', conflictRepo: 'api' });
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
      await new Promise((r) => setTimeout(r, 10));
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

  describe('the notices a surface is handed', () => {
    function heard(orchestrator: TaskOrchestrator) {
      const notices: Array<{ level: string; message: string }> = [];
      orchestrator.subscribe({ onIsolationNotice: (n) => notices.push(n) });
      return notices;
    }

    it('hands over the fallback to the workspace root, which the notification channel may drop', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'nested-repos', repos: ['services/billing'] };
      const { orchestrator } = setup({ isolation, workspace: '/plain' });
      const notices = heard(orchestrator);
      orchestrator.loadPlan([task('t1', 1)]);

      await orchestrator.approveReview();

      expect(notices).toEqual([{
        level: 'info',
        message: 'This repository contains nested repositories that are not submodules (services/billing) — tasks run in the workspace root without worktree isolation. Ignore them in git or make them submodules to isolate this repository.',
      }]);
    });

    it('hands over the shared paths of a group and the copies a task got', async () => {
      const isolation = new FakeWorktreeIsolation();
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
  });

  it('has the run saved with its landing before anything merges', async () => {
    const { orchestrator, isolation, pass } = setup();
    const saved: unknown[] = [];
    orchestrator.subscribe({ onIsolationChanged: () => saved.push(JSON.parse(JSON.stringify(orchestrator.isolationRecord!.run.landing ?? null))) });
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
    expect(warned).toContain('Task "Task t1" passed, but merging it into ordewell/run1/integration conflicted. Its worktree is kept — resolve it by hand, retry it, or resolve it as a task.');
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
        id: 'old', workspaceRoot: '/repo', shared: [], sharedRepos: [],
        repos: [{ path: '.', root: '/repo', baseRef: 'abc', integrationBranch: 'ordewell/old/integration' }],
        tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', workspace: '/wt/1', status: 'merged' as const, repos: { '.': { worktree: '/wt/1', linked: [], changed: true } } } },
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
        id: 'old', workspaceRoot: '/elsewhere/repo', shared: [], sharedRepos: [],
        repos: [{ path: '.', root: '/elsewhere/repo', baseRef: 'abc', integrationBranch: 'ordewell/old/integration' }],
        tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', workspace: '/wt/1', status: 'merged' as const, repos: { '.': { worktree: '/wt/1', linked: [], changed: true } } } },
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

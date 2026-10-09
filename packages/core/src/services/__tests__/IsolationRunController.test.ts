import { describe, it, expect, vi } from 'vitest';
import { IsolationRunController, type IsolationRunListener } from '../IsolationRunController';
import { createTask, type Task } from '../../models/Task';
import type { IsolationOutcome } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, FakeWorktreeIsolation } from '../../testing';
import { PlanEditError } from '../PlanEditError';
import { fakeNotification } from './sessionTestKit';

function setup(isolation = new FakeWorktreeIsolation()) {
  const listener: IsolationRunListener = {
    changed: vi.fn(),
    blocked: vi.fn(),
    handoff: vi.fn(),
    notice: vi.fn(),
    releasing: vi.fn(),
  };
  const notifications = fakeNotification();
  /** Tasks the plan has live: an attempt running, or in progress or waiting on the user. */
  const live = new Set<string>();
  const runs = new IsolationRunController({ isolation, config: fakeConfig(), notifications, workspaceRoot: () => '/repo', listener, liveTasks: () => live });
  return { runs, isolation, listener, notifications, live };
}

const task = (id: string, order: number): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, completionMarker: `mk-${id}` });

const ops = (isolation: FakeWorktreeIsolation) => isolation.calls.map((c) => c.op);

describe('IsolationRunController', () => {
  describe('open', () => {
    it('mints an isolated run once and reports it as a change', async () => {
      const { runs, isolation, listener } = setup();

      expect(await runs.decide(async () => undefined)).toBe(true);
      expect(await runs.decide(async () => undefined)).toBe(true);

      expect(runs.isOpen).toBe(true);
      expect(runs.isolating).toBe(true);
      expect(runs.current?.id).toBe('run1');
      expect(ops(isolation).filter((op) => op === 'startRun')).toHaveLength(1);
      expect(listener.changed).toHaveBeenCalled();
      expect(runs.planIsolation).toEqual({ run: runs.current, resolvers: {} });
    });

    it('decides once for starts that race each other', async () => {
      const { runs, isolation } = setup();

      await Promise.all([runs.decide(async () => undefined), runs.decide(async () => undefined)]);

      expect(ops(isolation).filter((op) => op === 'isActive')).toHaveLength(1);
    });

    it('opens a shared run with a notice where the workspace cannot isolate', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'not-git' };
      const { runs, listener, notifications } = setup(isolation);

      expect(await runs.decide(async () => undefined)).toBe(true);

      expect(runs.isOpen).toBe(true);
      expect(runs.isolating).toBe(false);
      expect(runs.current).toBeNull();
      expect(notifications.info).toHaveBeenCalledWith(expect.stringContaining('Not a git repository'));
      expect(listener.notice).toHaveBeenCalledWith('info', expect.stringContaining('Not a git repository'));
    });

    it('continues an adopted run that holds work instead of minting a new one', async () => {
      const { runs: first } = setup();
      await first.decide(async () => undefined);
      await first.attemptCwd(task('t1', 1), { repair: false });
      await first.release('t1', { keep: true });
      const saved = first.planIsolation;

      const { runs, isolation } = setup();
      await runs.adopt(saved);
      await runs.decide(async () => undefined);

      expect(runs.current?.id).toBe('run1');
      expect(ops(isolation)).toContain('pruneOrphans');
      expect(ops(isolation)).not.toContain('startRun');
    });
  });

  describe('attemptCwd', () => {
    it('gives an attempt in an isolated run the worktree prepared for it', async () => {
      const { runs } = setup();
      await runs.decide(async () => undefined);

      expect(await runs.attemptCwd(task('t1', 1), { repair: false })).toEqual({ cwd: '/fake-worktrees/run1/1-t1', worktree: true });
      expect(runs.taskIsolation('t1')).toMatchObject({ state: 'active' });
    });

    it('gives an attempt in a shared run the workspace root', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'disabled' };
      const { runs } = setup(isolation);
      await runs.decide(async () => undefined);

      expect(await runs.attemptCwd(task('t1', 1), { repair: false })).toEqual({ cwd: '/repo', worktree: false });
      expect(isolation.taskIdsFor('prepare')).toEqual([]);
    });

    it('reopens the kept worktree for a conflict repair', async () => {
      const { runs, isolation } = setup();
      await runs.decide(async () => undefined);
      const t1 = task('t1', 1);
      await runs.attemptCwd(t1, { repair: false });
      runs.current!.tasks.t1.status = 'conflict';

      expect(await runs.attemptCwd(t1, { repair: true })).toEqual({ cwd: '/fake-worktrees/run1/1-t1', worktree: true });
      expect(isolation.taskIdsFor('reopen')).toEqual(['t1']);
    });

    it('reports copied paths once per run, not once per task', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.copied = ['.env'];
      const { runs, listener } = setup(isolation);
      await runs.decide(async () => undefined);

      await runs.attemptCwd(task('t1', 1), { repair: false });
      await runs.attemptCwd(task('t2', 2), { repair: false });

      expect(vi.mocked(listener.notice).mock.calls.filter(([, m]) => m.includes('.env'))).toHaveLength(1);
    });
  });

  describe('blocked run', () => {
    it('parks the start on a dirty tree and hands it back once stashed', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty', repos: ['api'] };
      const { runs, listener } = setup(isolation);
      const resume = vi.fn(async () => undefined);

      expect(await runs.decide(resume)).toBe(false);
      expect(runs.blocked).toBe(true);
      expect(runs.decided).toBe(false);
      expect(listener.blocked).toHaveBeenCalledWith(['api']);

      expect(await runs.continueBlocked('stash')).toBe(resume);
      expect(runs.blocked).toBe(false);
      expect(ops(isolation)).toContain('stash');
      expect(listener.notice).toHaveBeenCalledWith('info', expect.stringContaining('Stashed your uncommitted changes in api'));
      expect(resume).not.toHaveBeenCalled();

      expect(await runs.decide(resume)).toBe(true);
      expect(runs.isolating).toBe(true);
    });

    it('opens a shared run when the user goes on without isolation', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty' };
      const { runs } = setup(isolation);
      const resume = vi.fn(async () => undefined);
      await runs.decide(resume);

      expect(await runs.continueBlocked('shared')).toBe(resume);

      expect(runs.isOpen).toBe(true);
      expect(runs.isolating).toBe(false);
      expect(ops(isolation)).not.toContain('stash');
    });

    it('keeps the choice open when the stash fails', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty' };
      const { runs } = setup(isolation);
      const resume = vi.fn(async () => undefined);
      await runs.decide(resume);
      isolation.stash = async () => { throw new Error('git stash failed'); };

      await expect(runs.continueBlocked('stash')).rejects.toThrow('git stash failed');

      expect(runs.blocked).toBe(true);
      expect(await runs.continueBlocked('shared')).toBe(resume);
    });

    it('has nothing to continue without a parked start', async () => {
      const { runs } = setup();
      expect(await runs.continueBlocked('stash')).toBeNull();
    });

    it('says how to get stashed changes back when an interrupt lands while the stash runs', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty', repos: ['api'] };
      const { runs, listener } = setup(isolation);
      await runs.decide(async () => undefined);
      let stashed!: () => void;
      const gate = new Promise<void>((resolve) => { stashed = resolve; });
      const stash = isolation.stash.bind(isolation);
      isolation.stash = async (root) => { await gate; return stash(root); };

      const continuing = runs.continueBlocked('stash');
      runs.interrupt();
      stashed();

      expect(await continuing).toBeNull();
      expect(listener.notice).toHaveBeenCalledWith('info', expect.stringContaining('`git stash pop` in each brings them back'));
    });

    it('drops the parked start on an interrupt', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty' };
      const { runs } = setup(isolation);
      await runs.decide(async () => undefined);

      runs.interrupt();

      expect(runs.blocked).toBe(false);
    });
  });

  describe('close', () => {
    it('hands an isolated run over and keeps its record for review', async () => {
      const { runs, listener } = setup();
      await runs.decide(async () => undefined);
      const t1 = task('t1', 1);
      await runs.attemptCwd(t1, { repair: false });
      runs.current!.tasks.t1.status = 'merged';

      await runs.close();

      expect(runs.isOpen).toBe(false);
      expect(listener.handoff).toHaveBeenCalledWith(expect.objectContaining({ landed: [expect.objectContaining({ taskId: 't1' })] }));
      expect(runs.current).not.toBeNull();
    });

    it('closes a shared run without a handoff', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'disabled' };
      const { runs, listener } = setup(isolation);
      await runs.decide(async () => undefined);

      await runs.close();

      expect(runs.isOpen).toBe(false);
      expect(listener.handoff).not.toHaveBeenCalled();
    });

    it('keeps a run the scheduler still drives open through an interrupt that asks it to', async () => {
      const { runs } = setup();
      await runs.decide(async () => undefined);

      runs.interrupt({ keepOpen: true });
      expect(runs.isOpen).toBe(true);

      runs.interrupt();
      expect(runs.isOpen).toBe(false);
    });

    it('does not reopen a run a Stop interrupted while its activation was in flight', async () => {
      const isolation = new FakeWorktreeIsolation();
      let assessed!: () => void;
      const gate = new Promise<void>((resolve) => { assessed = resolve; });
      const isActive = isolation.isActive.bind(isolation);
      isolation.isActive = async (root) => { await gate; return isActive(root); };
      const { runs } = setup(isolation);

      const deciding = runs.decide(async () => undefined);
      runs.interrupt();
      assessed();

      expect(await deciding).toBe(false);
      expect(runs.isOpen).toBe(false);
      expect(runs.decided).toBe(false);
    });

    it('lets the next run decide afresh after an interrupted activation', async () => {
      const isolation = new FakeWorktreeIsolation();
      let assessed!: () => void;
      const gate = new Promise<void>((resolve) => { assessed = resolve; });
      const isActive = isolation.isActive.bind(isolation);
      isolation.isActive = async (root) => { await gate; return isActive(root); };
      const { runs } = setup(isolation);

      const stale = runs.decide(async () => undefined);
      runs.interrupt();
      const next = runs.decide(async () => undefined);
      assessed();

      expect(await stale).toBe(false);
      expect(await next).toBe(true);
      expect(runs.isolating).toBe(true);
    });

    it('an activation interrupted while minting neither installs its run nor leaves it behind', async () => {
      const isolation = new FakeWorktreeIsolation();
      let minted!: () => void;
      const gate = new Promise<void>((resolve) => { minted = resolve; });
      const startRun = isolation.startRun.bind(isolation);
      let mints = 0;
      isolation.startRun = async (root) => {
        const run = await startRun(root);
        if (++mints === 1) await gate;
        return run;
      };
      const discarded: string[] = [];
      const discard = isolation.discard.bind(isolation);
      isolation.discard = async (run, opts) => { discarded.push(run.id); return discard(run, opts); };
      const { runs } = setup(isolation);

      const stale = runs.decide(async () => undefined);
      await vi.waitFor(() => expect(mints).toBe(1));
      runs.interrupt();
      expect(await runs.decide(async () => undefined)).toBe(true);
      expect(runs.current?.id).toBe('run2');
      minted();

      expect(await stale).toBe(false);
      expect(runs.current?.id).toBe('run2');
      expect(runs.isolating).toBe(true);
      expect(discarded).toEqual(['run1']);
    });

    it('forgets a settled run once everything merged into the checked-out branch', async () => {
      const { runs, listener } = setup();
      await runs.decide(async () => undefined);
      await runs.attemptCwd(task('t1', 1), { repair: false });
      await runs.integrate(task('t1', 1));
      await runs.close();

      expect(await runs.merge()).toEqual({ outcome: 'merged' });

      expect(listener.releasing).toHaveBeenCalledWith(['t1']);
      expect(runs.current).toBeNull();
      expect(runs.planIsolation).toBeNull();
    });
  });

  describe('clearing a run up never takes live or unlanded work', () => {
    /** A closed run: t1 landed, t2 started and was left as its attempt ended. */
    async function closedRun(t2: 'kept' | 'active') {
      const env = setup();
      await env.runs.decide(async () => undefined);
      await env.runs.attemptCwd(task('t1', 1), { repair: false });
      await env.runs.integrate(task('t1', 1));
      await env.runs.attemptCwd(task('t2', 2), { repair: false });
      if (t2 === 'kept') await env.runs.release('t2', { keep: true });
      env.runs.interrupt();
      return env;
    }

    it('keeps the run after Merge all while a task still holds work that has not landed', async () => {
      const { runs, isolation, listener, notifications } = await closedRun('kept');

      expect(await runs.merge()).toEqual({ outcome: 'merged' });

      expect(ops(isolation)).not.toContain('discard');
      expect(listener.releasing).not.toHaveBeenCalled();
      expect(runs.taskIsolation('t2')).toMatchObject({ state: 'kept' });
      expect(notifications.info).toHaveBeenCalledWith('The run is not cleared up: Task "Task t2" holds work that has not landed, so its worktree stays, and so do the run\'s branches.');
    });

    it('keeps the run after Merge all while a task is live, even one the run looks closed under', async () => {
      const { runs, isolation, live, notifications } = await closedRun('active');
      live.add('t2');

      expect(await runs.merge()).toEqual({ outcome: 'merged' });

      expect(ops(isolation)).not.toContain('discard');
      expect(runs.taskIsolation('t2')).toMatchObject({ state: 'active' });
      expect(notifications.info).toHaveBeenCalledWith(expect.stringContaining('Task "Task t2" is still running or waiting on you'));
    });

    it.each(['cleanup', 'discard'] as const)('refuses %s while a task of the run is live, removing nothing', async (action) => {
      const { runs, isolation, live, listener } = await closedRun('active');
      live.add('t2');

      await expect(runs[action]()).rejects.toThrow(PlanEditError);
      await expect(runs[action]()).rejects.toThrow('Task "Task t2" is still running or waiting on you, so its worktree stays.');

      expect(ops(isolation)).not.toContain('discard');
      expect(listener.releasing).not.toHaveBeenCalled();
      expect(runs.current).not.toBeNull();
    });

    it('says where a removal kept work that had not landed, and which worktree it left in place', async () => {
      const { runs, isolation, notifications } = await closedRun('kept');
      const t2 = { taskId: 't2', order: 2, title: 'Task t2' };
      isolation.removal = {
        preserved: [{ task: t2, repo: '.', branch: 'ordewell-preserved/run1/2-t2', commit: 'abcdef1234567890' }],
        refused: [{ task: t2, worktree: '/fake-worktrees/run1/2-t2', reason: 'it is not a git worktree any more' }],
      };

      await runs.discard();

      const warned = vi.mocked(notifications.warn).mock.calls.map((c) => String(c[0]));
      expect(warned).toContain('Task "Task t2" had work that never landed, so before its worktree was removed it was kept on branch ordewell-preserved/run1/2-t2 (abcdef1). `git log ordewell-preserved/run1/2-t2` shows it; merge or cherry-pick it to bring it back, and delete the branch once you no longer need it.');
      expect(warned).toContain('Left the worktree of task "Task t2" in place at /fake-worktrees/run1/2-t2: it holds work Ordewell could not keep (it is not a git worktree any more). Save what you need from it, then remove it with `git worktree remove --force /fake-worktrees/run1/2-t2`.');
    });

    it('leaves the last run\'s worktrees in place when a new run is minted while a task is live in it', async () => {
      const { runs, isolation, live, notifications } = setup();
      await runs.decide(async () => undefined);
      await runs.attemptCwd(task('t1', 1), { repair: false });
      live.add('t1');
      runs.interrupt();

      await runs.decide(async () => undefined);

      expect(runs.current?.id).toBe('run2');
      expect(ops(isolation)).not.toContain('discard');
      expect(notifications.warn).toHaveBeenCalledWith('The last run\'s worktrees are left in place: Task "Task t1" is still running or waiting on you there.');
    });
  });

  describe('integrate', () => {
    it('reports the record changed before the merge and again once it settles', async () => {
      const { runs, isolation, listener } = setup();
      await runs.decide(async () => undefined);
      const t1 = task('t1', 1);
      await runs.attemptCwd(t1, { repair: false });
      const release = isolation.holdIntegration('t1');
      vi.mocked(listener.changed).mockClear();

      const landing = runs.integrate(t1);
      await vi.waitFor(() => expect(listener.changed).toHaveBeenCalledTimes(1));
      expect(runs.current?.landing?.taskId).toBe('t1');
      release();

      expect(await landing).toBe('merged');
      expect(listener.changed).toHaveBeenCalledTimes(2);
    });

    it('answers failed, never a throw, when git errors or there is no run', async () => {
      const { runs, isolation } = setup();
      const t1 = task('t1', 1);
      expect(await runs.integrate(t1)).toBe('failed');

      await runs.decide(async () => undefined);
      await runs.attemptCwd(t1, { repair: false });
      vi.spyOn(isolation, 'integrate').mockRejectedValueOnce(new Error('hook failed'));
      expect(await runs.integrate(t1)).toBe('failed');
    });

    it('counts a repair git cannot check against it, in the repo that conflicted', async () => {
      const { runs, isolation } = setup();
      await runs.decide(async () => undefined);
      const t1 = task('t1', 1);
      await runs.attemptCwd(t1, { repair: false });
      runs.current!.tasks.t1.conflictRepo = 'api';
      vi.spyOn(isolation, 'verifyRepair').mockRejectedValueOnce(new Error('git died'));

      expect(await runs.verifyRepair(t1)).toEqual({ ok: false, reason: 'failed', repo: 'api' });
    });
  });

  describe('release', () => {
    it('removes a worktree the task no longer needs, after whatever runs in it', async () => {
      const { runs, isolation, listener } = setup();
      await runs.decide(async () => undefined);
      await runs.attemptCwd(task('t1', 1), { repair: false });

      await runs.release('t1', { keep: false });

      expect(listener.releasing).toHaveBeenCalledWith(['t1']);
      expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: false });
      expect(runs.taskIsolation('t1')).toEqual({ state: 'none' });
      expect(listener.changed).toHaveBeenCalled();
    });

    it('keeps a worktree for inspection without closing what runs in it', async () => {
      const { runs, listener } = setup();
      await runs.decide(async () => undefined);
      await runs.attemptCwd(task('t1', 1), { repair: false });

      await runs.release('t1', { keep: true });

      expect(listener.releasing).not.toHaveBeenCalled();
      expect(runs.taskIsolation('t1')).toMatchObject({ state: 'kept' });
    });

    it('waits for a merge in flight before touching the worktree', async () => {
      const { runs, isolation } = setup();
      await runs.decide(async () => undefined);
      await runs.attemptCwd(task('t1', 1), { repair: false });
      let settle!: (outcome: IsolationOutcome) => void;
      const integration = new Promise<IsolationOutcome>((resolve) => { settle = resolve; });

      const released = runs.release('t1', { keep: false }, integration);
      await Promise.resolve();
      expect(isolation.taskIdsFor('release')).toEqual([]);

      settle('merged');
      await released;
      expect(isolation.taskIdsFor('release')).toEqual(['t1']);
    });

    it('does nothing for a task the run has no record of', async () => {
      const { runs, isolation, listener } = setup();
      await runs.decide(async () => undefined);

      await runs.release('ghost', { keep: false });

      expect(isolation.taskIdsFor('release')).toEqual([]);
      expect(listener.releasing).not.toHaveBeenCalled();
    });
  });

  it('forgets a resolver link as it hands it back', async () => {
    const { runs } = setup();
    await runs.decide(async () => undefined);

    runs.linkResolver('r1', 't1');
    expect(runs.planIsolation?.resolvers).toEqual({ r1: 't1' });

    expect(runs.takeResolver('r1')).toBe('t1');
    expect(runs.takeResolver('r1')).toBeUndefined();
  });
});

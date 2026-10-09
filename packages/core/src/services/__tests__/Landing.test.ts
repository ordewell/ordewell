import { describe, it, expect, vi } from 'vitest';
import { completesTask, conflictResolverTask, Landing } from '../Landing';
import { IsolationRunController, type IsolationRunListener } from '../IsolationRunController';
import { PlanStore } from '../PlanStore';
import { createTask, type Task, type Verdict } from '../../models/Task';
import { fakeConfig, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';

const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, completionMarker: `mk-${id}`, ...over });

const verdict = (outcome: Verdict['outcome'], reason: string): Verdict => ({ outcome, reason, checks: [], decidedAt: '2026-09-28T00:00:00.000Z' });
const passed = verdict('pass', 'Completion marker found');

async function setup(opts: { isolation?: FakeWorktreeIsolation; conflictRepairAttempts?: number; tasks?: Task[] } = {}) {
  const isolation = opts.isolation ?? new FakeWorktreeIsolation();
  const listener: IsolationRunListener = { changed: vi.fn(), blocked: vi.fn(), handoff: vi.fn(), notice: vi.fn() };
  const config = fakeConfig({ conflictRepairAttempts: opts.conflictRepairAttempts ?? 2 });
  const runs = new IsolationRunController({ isolation, config, notifications: fakeNotification(), workspaceRoot: () => '/repo', listener, liveTasks: () => new Set() });
  const store = new PlanStore();
  store.load(opts.tasks ?? [], ['claude-code']);
  await runs.decide(async () => undefined);
  const landing = new Landing({ runs, config, tasks: store });
  const prepare = (t: Task) => runs.attemptCwd(t, { repair: false });
  const record = (taskId: string) => runs.current?.tasks[taskId];
  return { landing, runs, isolation, listener, store, prepare, record };
}

/** A task whose first landing conflicted in `a.ts`, as a repair finds it. */
async function conflicted(opts: { conflictRepairAttempts?: number } = {}) {
  const env = await setup(opts);
  const t1 = task('t1', 1);
  env.isolation.outcomes.set('t1', 'conflict');
  env.isolation.conflictFiles.set('t1', ['a.ts']);
  await env.prepare(t1);
  await env.landing.landPassed(t1, { worktree: true });
  return { ...env, t1 };
}

describe('Landing', () => {
  describe('a passed attempt', () => {
    it('lands cleanly: the work is on the integration branch, and the record is saved before the merge', async () => {
      const { landing, isolation, listener, prepare, record } = await setup();
      const t1 = task('t1', 1);
      await prepare(t1);
      vi.mocked(listener.changed).mockClear();

      const outcome = await landing.landPassed(t1, { worktree: true });

      expect(outcome).toEqual({ kind: 'landed', messages: [] });
      expect(completesTask(outcome)).toBe(true);
      expect(record('t1')?.status).toBe('merged');
      expect(isolation.taskIdsFor('integrate')).toEqual(['t1']);
      expect(listener.changed).toHaveBeenCalledTimes(2);
    });

    it('has nothing to land from an attempt that ran in the workspace root', async () => {
      const { landing, isolation } = await setup();

      const outcome = await landing.landPassed(task('t1', 1), { worktree: false });

      expect(outcome).toEqual({ kind: 'nothing-to-land', messages: [] });
      expect(completesTask(outcome)).toBe(true);
      expect(isolation.taskIdsFor('integrate')).toEqual([]);
    });

    it('owes a conflicted landing a repair, keeping its worktree for it', async () => {
      const { landing, isolation, t1, record } = await conflicted();

      expect(await landing.landPassed(t1, { worktree: true })).toEqual({
        kind: 'repair-needed',
        repair: { n: 1, limit: 2 },
        messages: [{ level: 'warn', text: 'Task "Task t1" passed, but merging it into ordewell/run1/integration conflicted (a.ts).' }],
      });
      expect(record('t1')?.status).toBe('conflict');
      expect(isolation.taskIdsFor('release')).toEqual([]);
    });

    it('leaves a conflict for the user when repair is off, and says why', async () => {
      const { landing, t1 } = await conflicted({ conflictRepairAttempts: 0 });

      const outcome = await landing.landPassed(t1, { worktree: true });

      expect(outcome).toEqual({
        kind: 'awaiting_user',
        reason: 'conflict',
        messages: [
          { level: 'warn', text: 'Task "Task t1" passed, but merging it into ordewell/run1/integration conflicted (a.ts). Its worktree is kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.' },
          { level: 'info', text: 'Conflict repair is off (conflictRepairAttempts is 0), so task "Task t1" waits for you.', repairLog: true },
        ],
      });
      expect(completesTask(outcome)).toBe(false);
    });

    it('leaves a landing git refused waiting on the user with its work kept, not failed', async () => {
      const { landing, isolation, prepare, record } = await setup();
      const t1 = task('t1', 1);
      isolation.outcomes.set('t1', 'failed');
      await prepare(t1);
      record('t1')!.landingError = 'its worktree is missing';

      expect(await landing.landPassed(t1, { worktree: true })).toEqual({
        kind: 'awaiting_user',
        reason: 'landing-failed',
        messages: [{ level: 'error', text: 'Task "Task t1" passed, but git could not integrate its work (its worktree is missing). Its worktree is kept for inspection.' }],
      });
      expect(record('t1')?.status).toBe('failed');
      expect(isolation.taskIdsFor('release')).toEqual([]);
    });

    it('names the repository git refused a group\'s landing in', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.repos = ['api', 'web'];
      isolation.outcomes.set('t1', 'failed');
      isolation.stopsIn.set('t1', 'web');
      const { landing, prepare } = await setup({ isolation });
      const t1 = task('t1', 1);
      await prepare(t1);

      const outcome = await landing.landPassed(t1, { worktree: true });

      expect(outcome.messages).toEqual([{ level: 'error', text: 'Task "Task t1" passed, but git could not integrate its work in web, so none of it landed. Its worktrees are kept for inspection.' }]);
    });

    it('cannot land a worktree attempt whose record went with a discarded run', async () => {
      const { landing, isolation } = await setup();

      const outcome = await landing.landPassed(task('t1', 1), { worktree: true });

      expect(outcome).toMatchObject({ kind: 'awaiting_user', reason: 'landing-failed' });
      expect(isolation.taskIdsFor('integrate')).toEqual([]);
    });
  });

  describe('Mark complete', () => {
    it('lands what the task holds unlanded', async () => {
      const { landing, prepare, record } = await setup();
      const t1 = task('t1', 1);
      await prepare(t1);

      expect(await landing.landVouched(t1)).toEqual({ kind: 'landed', messages: [] });
      expect(record('t1')?.status).toBe('merged');
    });

    it('has nothing to land for a task with no worktree, or one already landed', async () => {
      const { landing, isolation, prepare } = await setup();
      const t2 = task('t2', 2);
      await prepare(t2);
      await landing.landPassed(t2, { worktree: true });

      expect(await landing.landVouched(task('t1', 1))).toEqual({ kind: 'nothing-to-land', messages: [] });
      expect(await landing.landVouched(t2)).toEqual({ kind: 'nothing-to-land', messages: [] });
      expect(isolation.taskIdsFor('integrate')).toEqual(['t2']);
    });
  });

  describe('a conflict repair', () => {
    async function repairing(opts: { conflictRepairAttempts?: number } = {}) {
      const env = await conflicted(opts);
      await env.runs.attemptCwd(env.t1, { repair: true });
      return env;
    }

    it('lands once its evidence holds and the merge goes through, naming the files it repaired', async () => {
      const { landing, isolation, t1, record } = await repairing();
      isolation.outcomes.set('t1', 'merged');

      expect(await landing.settleRepair(t1, passed)).toEqual({
        kind: 'landed',
        messages: [{ level: 'info', text: 'Task "Task t1" landed after repairing a conflict in a.ts.', repairLog: true }],
      });
      expect(isolation.taskIdsFor('verifyRepair')).toEqual(['t1']);
      expect(record('t1')).toMatchObject({ status: 'merged', repairs: 1, repairedFiles: ['a.ts'] });
    });

    it('fails without its completion marker, leaving the conflict as it was', async () => {
      const { landing, isolation, t1, record } = await repairing();

      const outcome = await landing.settleRepair(t1, verdict('fail', 'exited without its completion marker'));

      expect(outcome).toEqual({
        kind: 'awaiting_user',
        reason: 'repair-failed',
        messages: [{
          level: 'warn',
          text: 'The conflict repair of task "Task t1" did not finish (exited without its completion marker), so it did not land. Its worktree is kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.',
          repairLog: true,
        }],
      });
      expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: true });
      expect(isolation.taskIdsFor('verifyRepair')).toEqual([]);
      expect(record('t1')).toMatchObject({ status: 'conflict', conflictFiles: ['a.ts'] });
    });

    it('fails on evidence before anything merges, whatever its marker claimed', async () => {
      const { landing, isolation, t1, record } = await repairing();
      isolation.repairEvidence.set('t1', { ok: false, reason: 'conflict-markers', repo: '.', files: ['a.ts'] });

      const outcome = await landing.settleRepair(t1, passed);

      expect(outcome).toMatchObject({ kind: 'awaiting_user', reason: 'repair-failed' });
      expect(outcome.messages[0].text).toContain('finished, but left conflict markers in a.ts, so it did not land');
      expect(isolation.taskIdsFor('integrate')).toEqual(['t1']);
      expect(record('t1')?.status).toBe('conflict');
    });

    it('is spent when it starts: a failed one is not handed back', async () => {
      const { landing, t1 } = await repairing();

      await landing.settleRepair(t1, verdict('fail', 'stopped'));

      expect(landing.nextRepair('t1')).toEqual({ n: 2, limit: 2 });
    });

    it('that conflicts again is a fresh conflict, owed the next repair until they run out', async () => {
      const { landing, runs, t1 } = await repairing();

      expect(await landing.settleRepair(t1, passed)).toMatchObject({ kind: 'repair-needed', repair: { n: 2, limit: 2 } });

      await runs.attemptCwd(t1, { repair: true });
      const outcome = await landing.settleRepair(t1, passed);
      expect(outcome).toMatchObject({ kind: 'awaiting_user', reason: 'conflict' });
      expect(outcome.messages.at(-1)).toEqual({ level: 'info', text: 'Task "Task t1" has had 2 of its 2 conflict repairs, so its conflict waits for you.', repairLog: true });
    });

    it('is asked to merge the integration tip into the task\'s own branch and resolve the named files', async () => {
      const { landing, t1 } = await repairing();

      const prompt = landing.repairPrompt(t1);

      expect(prompt).toContain('conflicted in a.ts');
      expect(prompt).toContain('git merge --no-edit ordewell/run1/integration');
      expect(prompt).toContain('What the task was asked to do:\ndo t1');
    });

    it('is owed only to a task whose record is in conflict', async () => {
      const { landing, prepare } = await setup();
      await prepare(task('t1', 1));

      expect(landing.nextRepair('t1')).toBeNull();
      expect(landing.nextRepair('unknown')).toBeNull();
    });
  });

  describe('a resolver task', () => {
    async function resolving() {
      const t1 = task('t1', 1);
      const env = await setup({ tasks: [t1, task('r1', 2)], conflictRepairAttempts: 0 });
      env.isolation.outcomes.set('t1', 'conflict');
      await env.prepare(t1);
      await env.landing.landPassed(t1, { worktree: true });
      env.runs.linkResolver('r1', 't1');
      env.isolation.outcomes.set('t1', 'merged');
      return { ...env, t1 };
    }

    it('lands the conflicted task it was added for once it has landed itself', async () => {
      const { landing, runs, record } = await resolving();

      const resolved = await landing.landResolved('r1');

      expect(resolved?.task.id).toBe('t1');
      expect(resolved?.outcome).toEqual({ kind: 'landed', messages: [{ level: 'info', text: 'Task "Task t1" landed through its conflict resolution.' }] });
      expect(record('t1')?.status).toBe('merged');
      expect(runs.planIsolation?.resolvers).toEqual({});
    });

    it('leaves alone a conflicted task retried meanwhile, whose new attempt is its own', async () => {
      const { landing, isolation, prepare, t1 } = await resolving();
      await prepare(t1);

      expect(await landing.landResolved('r1')).toBeNull();
      expect(isolation.taskIdsFor('integrate')).toEqual(['t1']);
    });

    it('has nothing to land for a task that resolves nothing', async () => {
      const { landing } = await resolving();

      expect(await landing.landResolved('t1')).toBeNull();
    });

    it('is built on the conflicted task\'s runner, model and mode, and merges its branch by hand', async () => {
      const { runs } = await resolving();
      const t1 = task('t1', 1, { assignedModel: { modelId: 'opus', modelLabel: 'Opus' }, thinkingEffort: 'high', taskMode: 'acceptEdits' });

      const resolver = conflictResolverTask(t1, runs.current);

      expect(resolver).toMatchObject({
        title: 'Resolve merge conflict: Task t1',
        description: 'Merge ordewell/run1/1-t1 into ordewell/run1/integration by hand.',
        type: 'ai',
        assignedRunner: 'claude-code',
        assignedModel: { modelId: 'opus', modelLabel: 'Opus' },
        thinkingEffort: 'high',
        taskMode: 'acceptEdits',
        autonomy: 'AFK',
        sliceType: 'AFK',
        dependencies: [],
      });
      expect(resolver?.prompt).toContain('git merge --no-ff ordewell/run1/1-t1');
    });

    it('is not built for a task that is not in conflict, or without a run', async () => {
      const { runs, prepare } = await resolving();
      const t2 = task('t2', 3);
      await prepare(t2);

      expect(conflictResolverTask(t2, runs.current)).toBeNull();
      expect(conflictResolverTask(task('t1', 1), null)).toBeNull();
    });
  });
});

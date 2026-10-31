import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

function setup(opts: { config?: Partial<IConfig> } = {}) {
  const isolation = new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (o: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(opts.config), notifications, runner, output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => '/repo',
  });
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const status = (taskId: string) => orchestrator.storeInstance.get(taskId)!.status;
  const pass = async (taskId: string) => {
    latest(taskId).reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(status(taskId)).toBe('completed'));
  };
  const started = (taskId: string) => spawn.mock.calls.filter(([o]) => o.taskId === taskId).length;
  return { orchestrator, isolation, spawn, sessions, notifications, latest, status, pass, started };
}

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

/** The limit as the structured transport delivers it: the turn's error event, then a failed turn. */
function hitLimit(session: FakeRunnerSession): void {
  session.emitEvent({ type: 'error', message: "You've hit your usage limit. Try again later.", usageLimit: { resetsAt: new Date(Date.now() + 3_600_000).toISOString() } });
  session.emitTurnEnd('failed');
}

/** A run over `tasks` with `landing` passed and landed, in order. */
async function landed(tasks: Task[], landing: string[], opts: Parameters<typeof setup>[0] = {}) {
  const env = setup(opts);
  env.orchestrator.loadPlan(tasks);
  await env.orchestrator.approveReview();
  for (const id of landing) {
    await vi.waitFor(() => expect(env.started(id)).toBeGreaterThan(0));
    await env.pass(id);
  }
  return env;
}

describe('TaskOrchestrator: reverting a landed task (ADR-0054)', () => {
  describe('a run with no `carried` record', () => {
    const older = 'This run started on an older version of Ordewell, so Ordewell cannot tell what its merges carried, and a revert could take work that another task still counts as landed. Nothing was reverted.';

    it('refuses in the preview and the revert, says why in those words, and offers nothing', async () => {
      const { orchestrator, isolation, status } = await landed([task('t1', 1), task('t2', 2)], ['t1']);
      delete orchestrator.runs.current!.carried;

      expect(await orchestrator.revertPreview('t1')).toEqual({ revertible: false, reason: 'no-own-merge', message: older });
      expect(await orchestrator.revertTask('t1')).toEqual({ outcome: 'refused', reason: older });
      expect(orchestrator.runs.taskIsolation('t1')).not.toHaveProperty('revertible');
      expect(status('t1')).toBe('completed');
      expect(isolation.calls.filter((call) => call.op === 'revert' || call.op === 'readLanded')).toEqual([]);
    });

    it('refuses for a task that shows no landing too: what it carried is what no record says', async () => {
      const { orchestrator } = await landed([task('t1', 1), task('t2', 2)], ['t1']);
      delete orchestrator.runs.current!.carried;

      expect(orchestrator.revertScope('t2')).toEqual({ taskIds: [], refusal: { reason: 'no-own-merge', message: older } });
    });

    it('leaves a run started on this build alone, holding the record while it is empty', async () => {
      const { orchestrator } = await landed([task('t1', 1)], ['t1']);

      expect(orchestrator.runs.current?.carried).toEqual({});
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ revertible: true });
      expect(await orchestrator.revertPreview('t1')).toMatchObject({ revertible: true });
      expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'reverted' });
    });
  });

  describe('the task afterwards', () => {
    it('is back to pending, held with a note, its verdict gone and its record no longer landed', async () => {
      const { orchestrator, status } = await landed([task('t1', 1)], ['t1']);

      const result = await orchestrator.revertTask('t1');

      expect(result).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: 't1' }] });
      expect(status('t1')).toBe('pending');
      expect(orchestrator.holdReason('t1')).toBe('reverted; retry or force start to run it again');
      expect(orchestrator.storeInstance.get('t1')).toMatchObject({ reverted: true, verdict: undefined });
      expect(orchestrator.runs.taskIsolation('t1')).toEqual({ state: 'none' });
      expect(orchestrator.runs.awaitsMerge('t1')).toBe(false);
    });

    it('keeps what its attempts left: the next one is numbered past them', async () => {
      const { orchestrator, started } = await landed([task('t1', 1)], ['t1']);

      await orchestrator.revertTask('t1');
      await orchestrator.forceStartTask('t1');

      await vi.waitFor(() => expect(started('t1')).toBe(2));
      expect(orchestrator.getAttempt('t1')).toMatchObject({ attempt: 2 });
    });

    it('is not run again by the scheduler, a tick or a new Execute', async () => {
      const { orchestrator, started } = await landed([task('t1', 1), task('t2', 2)], ['t1']);

      await orchestrator.revertTask('t1');
      await orchestrator.tick();
      expect(started('t1')).toBe(1);

      orchestrator.stop();
      await orchestrator.beginRun('user');
      expect(started('t1')).toBe(1);
      expect(orchestrator.holdReason('t1')).not.toBeNull();
    });

    it('stays held in a plan loaded again, from what is saved on the task', async () => {
      const { orchestrator } = await landed([task('t1', 1)], ['t1']);
      await orchestrator.revertTask('t1');
      const saved = structuredClone(orchestrator.storeInstance.planTasks);

      const { orchestrator: next, started } = setup();
      next.loadPlan(saved);
      await next.approveReview();

      expect(next.holdReason('t1')).toBe('reverted; retry or force start to run it again');
      expect(started('t1')).toBe(0);
    });

    it('starts again on a retry, in the same run, with its note gone', async () => {
      const { orchestrator, isolation, started, latest } = await landed([task('t1', 1), task('t2', 2)], ['t1']);
      await orchestrator.revertTask('t1');

      await orchestrator.retryTask('t1');

      await vi.waitFor(() => expect(started('t1')).toBe(2));
      expect(orchestrator.holdReason('t1')).toBeNull();
      expect(orchestrator.storeInstance.get('t1')!.reverted).toBeUndefined();
      expect(isolation.calls.filter((c) => c.op === 'startRun')).toHaveLength(1);
      expect(latest('t1')).toBeDefined();
    });

    it('carries the run on when a retry comes after it closed with no record left: it starts from the tip', async () => {
      const { orchestrator, isolation, started } = await landed([task('t1', 1)], ['t1']);
      await vi.waitFor(() => expect(orchestrator.runs.isOpen).toBe(false));
      await orchestrator.revertTask('t1');

      await orchestrator.forceStartTask('t1');

      await vi.waitFor(() => expect(started('t1')).toBe(2));
      expect(isolation.calls.filter((c) => c.op === 'startRun')).toHaveLength(1);
    });
  });

  describe('landed dependents', () => {
    const chain = () => [task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t2'] }), task('other', 4)];

    it('go with it, direct or not, newest first, and each is held', async () => {
      const { orchestrator, isolation, status } = await landed(chain(), ['t1', 't2', 't3']);

      const result = await orchestrator.revertTask('t1');

      expect(result).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: 't3' }, { taskId: 't2' }, { taskId: 't1' }] });
      expect(isolation.calls).toContainEqual({ op: 'revert', taskIds: ['t1', 't2', 't3'] });
      for (const id of ['t1', 't2', 't3']) {
        expect(status(id)).toBe('pending');
        expect(orchestrator.holdReason(id)).not.toBeNull();
      }
    });

    it('are found through a dependent that landed nothing, which stays as it is', async () => {
      const tasks = [task('t1', 1), task('nothing', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['nothing'] })];
      const env = setup();
      env.isolation.changes.set('nothing', []);
      env.orchestrator.loadPlan(tasks);
      await env.orchestrator.approveReview();
      for (const id of ['t1', 'nothing', 't3']) {
        await vi.waitFor(() => expect(env.started(id)).toBe(1));
        await env.pass(id);
      }
      const { orchestrator, status } = env;

      await orchestrator.revertTask('t1');

      expect(status('t3')).toBe('pending');
      expect(status('nothing')).toBe('completed');
    });

    describe('whose record a later attempt left in another state', () => {
      const chain = () => [task('t1', 1), task('t2', 2, { dependencies: ['t1'] })];
      /** Both landed and the run over: `t2` retried, at work again on a new record. */
      async function retried() {
        const env = await landed(chain(), ['t1', 't2']);
        await vi.waitFor(() => expect(env.orchestrator.runs.isOpen).toBe(false));
        await env.orchestrator.retryTask('t2');
        await env.orchestrator.forceStartTask('t2');
        await vi.waitFor(() => expect(env.orchestrator.getAttempt('t2')?.phase).toBe('running'));
        return env;
      }

      it('go with it when a retry has dropped the record, and stay held', async () => {
        const { orchestrator, status } = await retried();
        await orchestrator.cancelTask('t2');
        await orchestrator.runs.release('t2', { keep: false });
        expect(orchestrator.runs.current?.tasks.t2).toBeUndefined();

        expect(orchestrator.revertScope('t1').taskIds).toEqual(['t1', 't2']);
        expect(orchestrator.runs.taskIsolation('t2')).toEqual({ state: 'none', revertible: true });
        expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: 't2' }, { taskId: 't1' }] });

        expect(status('t2')).toBe('pending');
        expect(orchestrator.holdReason('t2')).toContain('reverted');
        expect(orchestrator.runs.taskIsolation('t2')).toEqual({ state: 'none' });
      });

      it('go with it from a stopped attempt, whose worktree stays', async () => {
        const { orchestrator, isolation, status } = await retried();
        await orchestrator.cancelTask('t2');
        expect(orchestrator.runs.current?.tasks.t2.status).toBe('kept');

        expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'reverted' });

        expect(status('t2')).toBe('pending');
        expect(orchestrator.runs.current?.tasks.t2.status).toBe('kept');
        expect(isolation.calls).toContainEqual({ op: 'revert', taskIds: ['t1', 't2'] });
      });

      it('keep a retry at work from being reverted under it', async () => {
        const { orchestrator, status } = await retried();

        expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('"Task t2"') });
        expect(orchestrator.runs.taskIsolation('t2')).not.toHaveProperty('revertible');
        expect(status('t1')).toBe('completed');
      });

      it('can be reverted by themselves', async () => {
        const { orchestrator, status } = await retried();
        await orchestrator.cancelTask('t2');

        expect(await orchestrator.revertPreview('t2')).toMatchObject({ revertible: true, tasks: [{ taskId: 't2', dependent: false }] });
        expect(await orchestrator.revertTask('t2')).toMatchObject({ outcome: 'reverted' });
        expect(status('t1')).toBe('completed');
      });
    });

    it('is refused while one is live, naming it, and touches nothing', async () => {
      const { orchestrator, isolation, status } = await landed(chain(), ['t1']);
      await vi.waitFor(() => expect(orchestrator.getAttempt('t2')?.phase).toBe('running'));

      const scope = orchestrator.revertScope('t1');
      const result = await orchestrator.revertTask('t1');

      expect(scope.refusal).toMatchObject({ reason: 'live-dependent', tasks: [{ taskId: 't2' }] });
      expect(result).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('"Task t2"') });
      expect(isolation.calls.some((c) => c.op === 'revert')).toBe(false);
      expect(status('t1')).toBe('completed');
      expect(status('t2')).toBe('in_progress');
    });

    it('goes ahead once the live dependent has been stopped', async () => {
      const { orchestrator, status } = await landed(chain(), ['t1']);
      await vi.waitFor(() => expect(orchestrator.getAttempt('t2')?.phase).toBe('running'));
      await orchestrator.cancelTask('t2');

      expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'reverted' });

      expect(status('t1')).toBe('pending');
    });

    it('lets tasks that do not depend on it keep running', async () => {
      const { orchestrator, status } = await landed([task('t1', 1), task('other', 2)], ['t1']);
      await vi.waitFor(() => expect(orchestrator.getAttempt('other')?.phase).toBe('running'));

      expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'reverted' });

      expect(status('other')).toBe('in_progress');
      expect(orchestrator.getAttempt('other')?.phase).toBe('running');
    });

    it('refuses a dependent paused on a usage limit: its reset would resume it on the work', async () => {
      const { orchestrator, latest } = await landed(chain(), ['t1']);
      await vi.waitFor(() => expect(orchestrator.getAttempt('t2')?.phase).toBe('running'));
      hitLimit(latest('t2'));
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t2')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' }));

      expect(orchestrator.revertScope('t1').refusal).toMatchObject({ reason: 'live-dependent' });
    });
  });

  describe('while it waits for its turn', () => {
    it('starts nothing, so no dependent is cut from a tip about to lose its work', async () => {
      const tasks = [task('t1', 1), task('busy', 2), task('later', 3, { dependencies: ['t1'] })];
      const { orchestrator, isolation, started, pass } = await landed(tasks, ['t1'], { config: { maxParallelSessions: 1 } });
      await vi.waitFor(() => expect(orchestrator.getAttempt('busy')?.phase).toBe('running'));
      const open = isolation.holdRevert();

      const reverting = orchestrator.revertTask('t1');
      // A slot frees with `t1` still landed: only the hold keeps `later` from taking it.
      await pass('busy');
      expect(started('later')).toBe(0);

      open();
      await reverting;
      expect(started('later')).toBe(0);
      expect(orchestrator.startsHeld).toBe(false);
    });

    it('refuses in its turn a dependent Mark complete began landing meanwhile', async () => {
      const { orchestrator, isolation, status } = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1']);
      await vi.waitFor(() => expect(orchestrator.getAttempt('t2')?.phase).toBe('running'));
      await orchestrator.cancelTask('t2');
      const open = isolation.holdRevert();
      const land = isolation.holdIntegration('t2');

      const reverting = orchestrator.revertTask('t1');
      const completing = orchestrator.markTaskComplete('t2');
      open();

      expect(await reverting).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('"Task t2"') });
      expect(status('t1')).toBe('completed');
      land();
      await completing;
    });

    it('refuses the start of a dependent, and goes ahead', async () => {
      const { orchestrator, isolation, status, started } = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1']);
      await vi.waitFor(() => expect(orchestrator.getAttempt('t2')?.phase).toBe('running'));
      await orchestrator.cancelTask('t2');
      const before = started('t2');
      const open = isolation.holdRevert();

      const reverting = orchestrator.revertTask('t1');
      await expect(orchestrator.forceStartTask('t2')).rejects.toThrow('A revert is taking back work task "Task t2" depends on');
      open();

      expect(await reverting).toMatchObject({ outcome: 'reverted' });
      expect(started('t2')).toBe(before);
      expect(status('t2')).toBe('pending');
    });

    it('lets the start of a task that does not depend on the work through', async () => {
      const { orchestrator, isolation, started } = await landed([task('t1', 1), task('other', 2)], ['t1']);
      await vi.waitFor(() => expect(orchestrator.getAttempt('other')?.phase).toBe('running'));
      await orchestrator.cancelTask('other');
      const before = started('other');
      const open = isolation.holdRevert();

      const reverting = orchestrator.revertTask('t1');
      await orchestrator.forceStartTask('other');
      expect(started('other')).toBe(before + 1);
      open();

      expect(await reverting).toMatchObject({ outcome: 'reverted' });
    });

    it('leaves a plan loaded meanwhile alone', async () => {
      const { orchestrator, isolation } = await landed([task('t1', 1)], ['t1']);
      const open = isolation.holdRevert();

      const reverting = orchestrator.revertTask('t1');
      const replacement = task('t1', 1, { title: 'Another plan', status: 'completed' });
      await orchestrator.runs.adopt(null);
      orchestrator.loadPlan([replacement]);
      open();

      expect(await reverting).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('Another plan was loaded') });
      expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed');
      expect(orchestrator.holdReason('t1')).toBeNull();
    });
  });

  describe('a revert that does not go through', () => {
    it('leaves the task landed and the run going', async () => {
      const { orchestrator, isolation, status } = await landed([task('t1', 1)], ['t1']);
      const stop = { outcome: 'conflict' as const, task: { taskId: 't1', order: 1, title: 'Task t1' }, repo: '.', files: ['a.txt'] };
      isolation.revertStop = stop;

      expect(await orchestrator.revertTask('t1')).toEqual(stop);

      expect(status('t1')).toBe('completed');
      expect(orchestrator.holdReason('t1')).toBeNull();
      expect(orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'integrated' });
      expect(orchestrator.startsHeld).toBe(false);
    });
  });

  describe('what cannot be reverted', () => {
    it.each([
      ['has not landed', () => task('other', 2, { dependencies: ['t1'], status: 'pending' })],
      ['is an ops task', () => task('other', 2, { ops: true, status: 'completed' })],
      ['is a script task', () => task('other', 2, { type: 'script', commands: [['true']], status: 'completed' })],
      ['is a user task', () => task('other', 2, { type: 'user', status: 'completed' })],
    ])('refuses a task that %s, which no landing record names', async (_what, other) => {
      const { orchestrator } = await landed([task('t1', 1), other()], ['t1']);

      expect(orchestrator.revertScope('other')).toMatchObject({ taskIds: [], refusal: { reason: 'no-landing' } });
      expect(await orchestrator.revertPreview('other')).toMatchObject({ revertible: false, reason: 'no-landing' });
    });

    it('says there is no such task for a ref no task answers to', async () => {
      const { orchestrator } = await landed([task('t1', 1)], ['t1']);

      expect(await orchestrator.revertPreview('99')).toMatchObject({ revertible: false, reason: 'no-landing', message: 'There is no task "99" in this plan.' });
    });

    it('refuses a read-only task, whose record lands nothing', async () => {
      const { orchestrator } = await landed([task('t1', 1), task('other', 2)], ['t1']);
      await vi.waitFor(() => expect(orchestrator.runs.current?.tasks.other).toBeDefined());
      orchestrator.runs.current!.tasks.other.readOnly = true;

      expect(orchestrator.revertScope('other').refusal).toMatchObject({ reason: 'no-landing' });
    });

    it('refuses a change task whose landing brought nothing', async () => {
      const env = setup();
      env.isolation.changes.set('t1', []);
      env.orchestrator.loadPlan([task('t1', 1)]);
      await env.orchestrator.approveReview();
      await env.pass('t1');

      expect(env.orchestrator.revertScope('t1').refusal).toMatchObject({ reason: 'no-landing', message: 'Task "Task t1" landed nothing on the integration branch, so there is nothing to revert.' });
    });

    it('refuses in a plan that never isolated', async () => {
      const { orchestrator } = setup();
      orchestrator.loadPlan([task('t1', 1)]);

      expect(orchestrator.revertScope('t1').refusal).toMatchObject({ reason: 'no-landing' });
    });
  });

  describe('a loop', () => {
    const looped = () => [
      task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }),
      task('fix', 2, { dependencies: ['check'] }),
    ];

    it('refuses a task in a loop that has not ended, and says so plainly', async () => {
      const { orchestrator, latest, status } = await landed(looped(), []);
      await vi.waitFor(() => expect(orchestrator.getAttempt('check')?.phase).toBe('running'));
      latest('check').reportComplete({ status: 'failed', summary: 'wanting' });
      await vi.waitFor(() => expect(orchestrator.getAttempt('fix')?.phase).toBe('running'));
      await latest('fix').reportComplete({ status: 'done', summary: '' });
      await vi.waitFor(() => expect(orchestrator.runs.current?.tasks.fix?.status).toBe('merged'));

      const { refusal } = orchestrator.revertScope('fix');

      expect(refusal).toMatchObject({ reason: 'in-a-loop', message: expect.stringContaining('which has not ended') });
      expect(await orchestrator.revertTask('fix')).toMatchObject({ outcome: 'refused' });
      expect(status('fix')).toBe('completed');
    });

    it('reverts a task of a loop that has ended, with the rest of what landed of it', async () => {
      const { orchestrator, status } = await landed(looped(), ['check']);
      expect(status('fix')).toBe('skipped');

      expect(await orchestrator.revertTask('check')).toMatchObject({ outcome: 'reverted' });

      expect(status('check')).toBe('pending');
    });
  });

  describe('subtasks', () => {
    // A subtask runs and lands as a task of its own, with its own record: it goes with a parent only if it depends on it.
    const family = () => [
      task('parent', 1, { subtasks: [task('free', 1), task('on-parent', 2, { dependencies: ['parent'] })] }),
    ];

    it('leaves one that does not depend on its parent landed and done', async () => {
      const { orchestrator, status } = await landed(family(), ['parent', 'free', 'on-parent']);

      expect(await orchestrator.revertTask('parent')).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: 'on-parent' }, { taskId: 'parent' }] });

      expect(status('parent')).toBe('pending');
      expect(status('on-parent')).toBe('pending');
      expect(orchestrator.holdReason('on-parent')).toContain('reverted');
      expect(status('free')).toBe('completed');
      expect(orchestrator.runs.taskIsolation('free')).toMatchObject({ state: 'integrated' });
    });

    it('reverts one by itself, its parent untouched', async () => {
      const { orchestrator, status } = await landed(family(), ['parent', 'free', 'on-parent']);

      expect(await orchestrator.revertTask('free')).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: 'free' }] });

      expect(status('free')).toBe('pending');
      expect(status('parent')).toBe('completed');
    });

    it('calls it by its full path in the preview: its order alone would name a top-level task', async () => {
      const { orchestrator } = await landed(family(), ['parent', 'free', 'on-parent']);

      expect(await orchestrator.revertPreview('free')).toMatchObject({ revertible: true, tasks: [{ taskId: 'free', ref: '#1.1' }] });
    });
  });

  describe('the merge gate', () => {
    const gatedOn = (deps: string[]) => task('ops', 9, { ops: true, dependencies: deps });

    it('opens once the landed work it waited for is gone', async () => {
      const { orchestrator } = await landed([task('t1', 1), task('t2', 2), gatedOn(['t1', 't2'])], ['t1', 't2']);
      await vi.waitFor(() => expect(orchestrator.getMergeGate('ops')).toEqual(['t1', 't2']));

      await orchestrator.revertTask('t1');

      expect(orchestrator.getMergeGate('ops')).toEqual(['t2']);
      await orchestrator.revertTask('t2');
      expect(orchestrator.getMergeGate('ops')).toEqual([]);
      expect(orchestrator.runMergeView()).toBeNull();
    });

    it('leaves the gated task waiting for the reverted work, which is its dependency', async () => {
      const { orchestrator, started } = await landed([task('t1', 1), gatedOn(['t1'])], ['t1']);

      await orchestrator.revertTask('t1');
      await orchestrator.tick();

      expect(orchestrator.getMergeGate('ops')).toEqual([]);
      expect(started('ops')).toBe(0);
      expect(orchestrator.startWaits(orchestrator.storeInstance.get('ops')!).map((w) => w.kind)).toContain('dependencies');
    });

    it('takes the task off the handoff', async () => {
      const { orchestrator } = await landed([task('t1', 1), task('t2', 2)], ['t1', 't2']);

      await orchestrator.revertTask('t1');

      expect(orchestrator.runs.view()?.handoff.landed.map((t) => t.taskId)).toEqual(['t2']);
    });
  });

  describe('the preview', () => {
    it('does not offer a revert it cannot name when a recordless landing has no landedTasks', async () => {
      const { orchestrator } = await landed([task('t1', 1)], ['t1']);
      const run = orchestrator.runs.current!;
      // A run saved by the first #86 build: it has landings but no landedTasks.
      delete run.landedTasks;
      delete run.tasks.t1;

      expect(await orchestrator.revertPreview('t1')).toMatchObject({ revertible: false });
    });

    it('refuses the whole revert rather than leave out a dependent it cannot name', async () => {
      const { orchestrator, isolation } = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);
      const run = orchestrator.runs.current!;
      delete run.landedTasks;
      delete run.tasks.t2;

      expect(await orchestrator.revertPreview('t1')).toMatchObject({ revertible: false, reason: 'no-own-merge', message: expect.stringContaining('"Task t2"') });
      expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'refused' });
      expect(isolation.calls.some((c) => c.op === 'revert')).toBe(false);
    });

    it('lists what would go, newest first, the task asked for told from its dependents', async () => {
      const { orchestrator, isolation, status } = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);

      const preview = await orchestrator.revertPreview('t1');

      expect(preview).toEqual({ revertible: true, tasks: [
        { taskId: 't2', order: 2, ref: '#2', title: 'Task t2', repos: ['.'], dependent: true },
        { taskId: 't1', order: 1, ref: '#1', title: 'Task t1', repos: ['.'], dependent: false },
      ] });
      expect(status('t1')).toBe('completed');
      expect(isolation.calls.some((c) => c.op === 'revert')).toBe(false);
    });

    it('answers work in the user\'s branch with the commands, ahead of anything else in the way', async () => {
      const { orchestrator, isolation } = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1']);
      const command = { task: { taskId: 't1', order: 1, title: 'Task t1' }, repo: '.', commit: 'abc', command: 'git revert -m 1 abc', heldBy: ['main'], merged: true };
      isolation.inBranch.set('t1', [command]);
      await vi.waitFor(() => expect(orchestrator.getAttempt('t2')?.phase).toBe('running'));

      expect(await orchestrator.revertPreview('t1')).toEqual({
        revertible: false,
        reason: 'in-branch',
        commands: [command],
        message: 'This work is already in "main", which Ordewell never writes to. To undo it there, run this: git revert -m 1 abc',
      });
    });
  });
});

describe('TaskOrchestrator: a revert and a conflict with a resolver out to it (ADR-0054)', () => {
  /** t1 landed, then another attempt of it conflicted, and a resolver was added for that. */
  async function conflictedAgain() {
    const env = await landed([task('t1', 1)], ['t1'], { config: { conflictRepairAttempts: 0 } });
    env.isolation.outcomes.set('t1', 'conflict');
    await env.orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(env.started('t1')).toBe(2));
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('awaiting_user'));
    env.isolation.outcomes.delete('t1');
    const resolver = env.orchestrator.storeInstance.add({ title: 'Resolve', prompt: 'merge it' });
    env.orchestrator.runs.linkResolver(resolver.id, 't1');
    return { ...env, resolver };
  }

  it('retires a resolver not started, so the task can be started again and waits in the inbox', async () => {
    const { orchestrator, resolver, started, status } = await conflictedAgain();

    expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'reverted' });

    expect(orchestrator.runs.resolversOf('t1')).toEqual([]);
    expect(orchestrator.storeInstance.get(resolver.id)).toMatchObject({ status: 'skipped', skipReason: 'not needed: the conflict it was added for is gone' });
    expect(status('t1')).toBe('pending');
    await orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(started('t1')).toBe(3));
    expect(started(resolver.id)).toBe(0);
  });

  it('is refused while the resolver is at work, naming it, and changes nothing', async () => {
    const { orchestrator, resolver, started, status } = await conflictedAgain();
    await orchestrator.forceStartTask(resolver.id);
    await vi.waitFor(() => expect(started(resolver.id)).toBe(1));

    expect(orchestrator.revertScope('t1').refusal).toMatchObject({ reason: 'live-dependent', tasks: [{ taskId: resolver.id }], message: expect.stringContaining('Task "Resolve"') });
    expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('Task "Resolve"') });

    expect(orchestrator.runs.resolversOf('t1')).toEqual([resolver.id]);
    expect(status('t1')).toBe('awaiting_user');
    expect(status(resolver.id)).toBe('in_progress');
  });

  it('refuses a start of the resolver while the revert is under way', async () => {
    const { orchestrator, isolation, resolver, started } = await conflictedAgain();
    const open = isolation.holdRevert();
    const reverting = orchestrator.revertTask('t1');

    await expect(orchestrator.forceStartTask(resolver.id)).rejects.toThrow('A revert is taking back work');

    open();
    expect(await reverting).toMatchObject({ outcome: 'reverted' });
    expect(started(resolver.id)).toBe(0);
  });
});

describe('TaskOrchestrator: a landed task that left the plan (ADR-0054)', () => {
  const leave = async (env: Awaited<ReturnType<typeof landed>>, id: string) => {
    await env.orchestrator.releaseTask(id);
    env.orchestrator.storeInstance.remove(id);
  };

  it('goes with what it depended on, so its merge does not stay on the branch', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);
    await leave(env, 't2');

    expect(env.orchestrator.revertScope('t1')).toEqual({ taskIds: ['t1', 't2'] });
    expect(await env.orchestrator.revertPreview('t1')).toMatchObject({ revertible: true, tasks: expect.arrayContaining([expect.objectContaining({ taskId: 't2', dependent: true })]) });
    expect(await env.orchestrator.revertTask('t1')).toMatchObject({ outcome: 'reverted' });

    expect(env.orchestrator.runs.current?.landings?.t2).toBeUndefined();
    expect(env.orchestrator.runs.current?.landedTasks?.t2).toBeUndefined();
    expect(env.status('t1')).toBe('pending');
  });

  it('still links what stood on it through its dependencies, which the plan let go of', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t2'] })], ['t1', 't2', 't3']);
    await leave(env, 't2');
    expect(env.orchestrator.storeInstance.get('t3')!.dependencies).toEqual([]);

    expect([...env.orchestrator.revertScope('t1').taskIds].sort()).toEqual(['t1', 't2', 't3']);
  });

  it('keeps the link through a task that landed nothing and left', async () => {
    const env = setup();
    env.isolation.changes.set('t2', []);
    env.orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t2'] })]);
    await env.orchestrator.approveReview();
    for (const id of ['t1', 't2', 't3']) {
      await vi.waitFor(() => expect(env.started(id)).toBeGreaterThan(0));
      await env.pass(id);
    }
    await env.orchestrator.releaseTask('t2');
    env.orchestrator.storeInstance.remove('t2');

    expect(env.orchestrator.revertScope('t1').taskIds).toEqual(['t1', 't3']);
  });

  it('holds a start of what stood on it through a task that left', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t2'] })], ['t1', 't2', 't3']);
    await leave(env, 't2');
    const open = env.isolation.holdRevert();
    const reverting = env.orchestrator.revertTask('t1');

    await expect(env.orchestrator.forceStartTask('t3')).rejects.toThrow('A revert is taking back work');

    open();
    await reverting;
  });

  it('leaves a landing that depended on none of it alone', async () => {
    const env = await landed([task('t1', 1), task('free', 2)], ['t1', 'free']);
    await leave(env, 'free');

    expect(env.orchestrator.revertScope('t1')).toEqual({ taskIds: ['t1'] });
    await env.orchestrator.revertTask('t1');

    expect(env.orchestrator.runs.current?.landings?.free).toBeDefined();
  });

  it('refuses every revert of the run when nothing says what it depended on', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);
    await leave(env, 't2');
    delete env.orchestrator.runs.current!.landedOn!.t2;

    expect(env.orchestrator.revertScope('t1').refusal).toMatchObject({ reason: 'no-own-merge', message: expect.stringContaining('Task "Task t2" landed and left the plan') });
    expect(await env.orchestrator.revertTask('t1')).toMatchObject({ outcome: 'refused' });
    expect(env.status('t1')).toBe('completed');
  });
});

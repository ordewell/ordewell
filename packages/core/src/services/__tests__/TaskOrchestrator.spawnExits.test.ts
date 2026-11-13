import { describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IsolationRun, IsolationTaskRecord } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { LeaseWorkspacePreparedError, type ExecutionBackend } from '../executionLease';

/**
 * Every way an attempt's spawn leaves, against every end that can come while
 * it is in flight: the workspace its open made is let go once, by what that
 * end decided (ADR-0013, ADR-0059 L1), and a record a newer run made is not
 * touched. t2 runs throughout, so a cancel or a delete leaves the run open.
 */

type Exit = 'prepare throws' | 'open refuses what it made' | 'open fails after making' | 'start-config check refuses' | 'live check finds it ended' | 'runner spawn finds it ended' | 'spawned';
/** A cleanup that fails or waits its turn is the cancel's own release of t1's first record. */
type End = 'none' | 'cancel' | 'stop' | 'delete' | 'load' | 'complete' | 'newer run' | 'cancel failing to clean up' | 'newer run while cancel cleans up';
/** Where t1's first spawn is held while the end comes. */
type Window = 'prepare' | 'open' | 'check' | 'runner spawn' | 'running';
/** What becomes of the record t1's first open made, or of the newer run's. */
type Outcome = 'removed' | 'kept' | 'active' | 'merged' | 'newer kept';
/** Whether the spawn lets go itself what its end could not reach, or leaves it to that end, to its own failure, or to a newer start. */
type Late = 'late' | 'not late';

const cells: ReadonlyArray<readonly [Exit, Window, End, Outcome, Late]> = [
  // Nothing was made, so there is nothing to let go, whatever ended it.
  ['prepare throws', 'prepare', 'none', 'removed', 'not late'],
  ['prepare throws', 'prepare', 'cancel', 'removed', 'not late'],
  ['prepare throws', 'prepare', 'stop', 'removed', 'not late'],
  ['prepare throws', 'prepare', 'delete', 'removed', 'not late'],
  ['prepare throws', 'prepare', 'load', 'removed', 'not late'],
  ['prepare throws', 'prepare', 'newer run', 'newer kept', 'not late'],
  // A Stop or a load during the prepare closes the decision, so the open refuses what it made and the spawn lets it go; a newer start replaces what a Stop kept.
  ['open refuses what it made', 'prepare', 'stop', 'kept', 'late'],
  ['open refuses what it made', 'prepare', 'load', 'removed', 'late'],
  ['open refuses what it made', 'prepare', 'newer run', 'newer kept', 'late'],
  // Made and then refused by a backend still at work on it: a cancel or a delete reaches it, a Stop or a load does not.
  ['open refuses what it made', 'open', 'none', 'removed', 'not late'],
  ['open refuses what it made', 'open', 'cancel', 'kept', 'not late'],
  ['open refuses what it made', 'open', 'stop', 'kept', 'late'],
  ['open refuses what it made', 'open', 'delete', 'removed', 'not late'],
  ['open refuses what it made', 'open', 'load', 'removed', 'late'],
  ['open refuses what it made', 'open', 'newer run', 'newer kept', 'not late'],
  // A backend that fails after the local workspace was made, as a box that will not start does, returns nothing: what it made is still the run's to let go.
  ['open fails after making', 'open', 'none', 'removed', 'not late'],
  ['open fails after making', 'open', 'cancel', 'kept', 'not late'],
  ['open fails after making', 'open', 'stop', 'kept', 'late'],
  ['open fails after making', 'open', 'delete', 'removed', 'not late'],
  ['open fails after making', 'open', 'load', 'removed', 'late'],
  ['open fails after making', 'open', 'newer run', 'newer kept', 'not late'],
  // Ended before the workspace was made, which only the spawn can then let go.
  ['start-config check refuses', 'prepare', 'cancel', 'kept', 'late'],
  ['start-config check refuses', 'prepare', 'delete', 'removed', 'late'],
  // Ended once it was opened: every end but a load reaches it, and the spawn does not let it go again.
  ['start-config check refuses', 'check', 'none', 'active', 'not late'],
  ['start-config check refuses', 'check', 'cancel', 'kept', 'not late'],
  ['start-config check refuses', 'check', 'stop', 'kept', 'not late'],
  ['start-config check refuses', 'check', 'delete', 'removed', 'not late'],
  ['start-config check refuses', 'check', 'load', 'removed', 'late'],
  ['start-config check refuses', 'check', 'newer run', 'newer kept', 'not late'],
  // What a Mark complete lands is the landing's; a cleanup that failed is the spawn's to let go once more.
  ['start-config check refuses', 'check', 'complete', 'merged', 'not late'],
  ['start-config check refuses', 'check', 'cancel failing to clean up', 'kept', 'late'],
  ['live check finds it ended', 'prepare', 'cancel', 'kept', 'late'],
  ['live check finds it ended', 'prepare', 'delete', 'removed', 'late'],
  ['live check finds it ended', 'check', 'cancel', 'kept', 'not late'],
  ['live check finds it ended', 'check', 'stop', 'kept', 'not late'],
  ['live check finds it ended', 'check', 'delete', 'removed', 'not late'],
  ['live check finds it ended', 'check', 'load', 'removed', 'late'],
  ['live check finds it ended', 'check', 'newer run', 'newer kept', 'not late'],
  ['live check finds it ended', 'check', 'complete', 'merged', 'not late'],
  ['live check finds it ended', 'check', 'cancel failing to clean up', 'kept', 'late'],
  ['live check finds it ended', 'check', 'newer run while cancel cleans up', 'newer kept', 'not late'],
  // Ended while the runner starts: the session is killed, and what no end reached is let go as for any other exit.
  ['runner spawn finds it ended', 'runner spawn', 'cancel', 'kept', 'not late'],
  ['runner spawn finds it ended', 'runner spawn', 'stop', 'kept', 'not late'],
  ['runner spawn finds it ended', 'runner spawn', 'delete', 'removed', 'not late'],
  ['runner spawn finds it ended', 'runner spawn', 'load', 'removed', 'late'],
  ['runner spawn finds it ended', 'runner spawn', 'complete', 'merged', 'not late'],
  ['runner spawn finds it ended', 'runner spawn', 'newer run', 'newer kept', 'not late'],
  ['runner spawn finds it ended', 'runner spawn', 'cancel failing to clean up', 'kept', 'late'],
  // Its ender owns it from here; a load leaves a running attempt's worktree where it is.
  ['spawned', 'running', 'none', 'active', 'not late'],
  ['spawned', 'running', 'cancel', 'kept', 'not late'],
  ['spawned', 'running', 'stop', 'kept', 'not late'],
  ['spawned', 'running', 'delete', 'removed', 'not late'],
  ['spawned', 'running', 'load', 'active', 'not late'],
  ['spawned', 'running', 'newer run', 'newer kept', 'not late'],
  ['spawned', 'running', 'newer run while cancel cleans up', 'newer kept', 'not late'],
];

const REFUSED = ['.claude/settings.local.json'];
const plan = () => [createTask({ id: 't1', order: 1, title: 'Task t1', prompt: 'do t1' }), createTask({ id: 't2', order: 2, title: 'Task t2', prompt: 'do t2' })];

interface Facts {
  exit?: Exit;
  /** The record t1's first open made, and the run it made it in. */
  made?: { record: IsolationTaskRecord; run: IsolationRun };
  lateLetGos: number;
}

/** Which of t1's releases, counted from one in the order asked, throws as git does when it cannot remove a worktree, or waits until let through. */
interface Releases { failing?: number; held?: number }

function setup(exit: Exit, window: Window, how: End, releases: Releases = {}) {
  const failing = releases.failing ?? (how === 'cancel failing to clean up' ? 1 : 0);
  const holding = releases.held ?? (how === 'newer run while cancel cleans up' ? 1 : 0);
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let cleanUp!: () => void;
  let cleaning!: () => void;
  const cleanUpGate = new Promise<void>((resolve) => { cleanUp = resolve; });
  const cleaningUp = new Promise<void>((resolve) => { cleaning = resolve; });
  const facts: Facts = { lateLetGos: 0 };
  const isolation = new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  let t1Spawns = 0;
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${sessions.length + 1}`);
    sessions.push(session);
    if (opts.taskId === 't1' && t1Spawns++ === 0 && window === 'runner spawn') {
      enter();
      await gate;
      // Only an ended spawn kills the session it started: nothing else holds it yet.
      const kill = session.kill.bind(session);
      session.kill = () => {
        facts.exit = 'runner spawn finds it ended';
        kill();
      };
    }
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };

  let t1Opens = 0;
  const execution = (local: ExecutionBackend): ExecutionBackend => {
    const reserve = local.reserve.bind(local);
    local.reserve = (request) => {
      const reserved = reserve(request);
      if ('refused' in reserved) return reserved;
      const { lease } = reserved;
      const open = lease.open.bind(lease);
      return { lease: { ...lease, open: async (spec, signal) => {
        const first = spec.task?.id === 't1' && t1Opens++ === 0;
        try {
          const made = await open(spec, signal);
          if (first && window === 'open') {
            // As a backend that starts a box in the workspace, then finds its run closed, or fails to start it.
            enter();
            await gate;
            if (exit !== 'open fails after making') throw new LeaseWorkspacePreparedError('the run closed while its workspace was made', false);
            facts.exit = exit;
            throw new Error('the container could not start');
          }
          return made;
        } catch (err) {
          if (first && err instanceof LeaseWorkspacePreparedError) facts.exit = 'open refuses what it made';
          throw err;
        }
      } } };
    };
    const letGo = local.letGo.bind(local);
    local.letGo = (taskId, how) => {
      if (taskId === 't1' && how.reason === 'ended while opening') facts.lateLetGos += 1;
      return letGo(taskId, how);
    };
    return local;
  };

  const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications: fakeNotification(), runner, output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => '/repo', execution });

  let t1Prepares = 0;
  let held: { run: IsolationRun; settled: Promise<unknown> } | undefined;
  const prepare = isolation.prepare.bind(isolation);
  vi.spyOn(isolation, 'prepare').mockImplementation(async (t, run, intent, opts) => {
    if (t.id !== 't1') return prepare(t, run, intent, opts);
    if (t1Prepares++ > 0) {
      // As git does under the run's admin lock: a later start's prepare waits for the one in flight.
      if (held?.run === run) await held.settled.catch(() => undefined);
      return prepare(t, run, intent, opts);
    }
    const first = (async () => {
      if (window === 'prepare') {
        enter();
        await gate;
      }
      if (exit === 'prepare throws') {
        facts.exit = exit;
        throw new Error('git could not add the worktree');
      }
      const prepared = await prepare(t, run, intent, opts);
      facts.made = { record: run.tasks[t.id]!, run };
      return prepared;
    })();
    held = { run, settled: first };
    return first;
  });

  // Each record let go, by identity: a release that goes through twice is a double let go.
  const released = new Map<IsolationTaskRecord, number>();
  const releaseRecord = isolation.release.bind(isolation);
  let t1Releases = 0;
  vi.spyOn(isolation, 'release').mockImplementation(async (run, taskId, opts) => {
    // Read as the release is asked, the record it was decided for: a newer one made while it waits is not that.
    const record = run.tasks[taskId];
    if (taskId === 't1') {
      const nth = ++t1Releases;
      if (nth === failing) throw new Error('git could not remove the worktree');
      if (nth === holding) {
        // As git's waits for the run's admin lock, which a newer start's prepare took first.
        cleaning();
        await cleanUpGate;
      }
    }
    const removal = await releaseRecord(run, taskId, opts);
    if (taskId === 't1' && record) released.set(record, (released.get(record) ?? 0) + 1);
    return removal;
  });

  const attempts = (orchestrator as unknown as { attempts: { unspawned: ReadonlyMap<string, unknown>; phaseOf(taskId: string): string | undefined; startConfig: { check: (run: unknown, taskId: string, opts: unknown) => Promise<string[]> } } }).attempts;
  let t1Checks = 0;
  vi.spyOn(attempts.startConfig, 'check').mockImplementation(async (_run, taskId) => {
    // Only the first attempt's: a newer start's own comes once its prepare has.
    if (taskId !== 't1' || t1Prepares > 1 || t1Checks++ > 0) return [];
    if (window === 'check') {
      enter();
      await gate;
    }
    const refuses = exit === 'start-config check refuses';
    facts.exit = refuses ? exit : 'live check finds it ended';
    return refuses ? REFUSED : [];
  });

  const spawnsOfT1 = () => spawn.mock.calls.filter(([opts]) => opts.taskId === 't1').length;
  return { orchestrator, attempts, isolation, facts, released, releasesOfT1: () => t1Releases, spawnsOfT1, entered, release, window, cleaningUp, cleanUp };
}

type Env = ReturnType<typeof setup>;

/** Ends t1's attempt as the user would; a newer run's is the record t1's next start made, stopped, so kept. */
async function end(env: Env, how: End): Promise<IsolationTaskRecord | undefined> {
  const { orchestrator } = env;
  switch (how) {
    case 'none':
      return undefined;
    case 'cancel':
    case 'cancel failing to clean up':
      await orchestrator.cancelTask('t1');
      return undefined;
    case 'stop':
      orchestrator.stop();
      return undefined;
    case 'delete':
      await orchestrator.releaseTask('t1');
      orchestrator.storeInstance.remove('t1');
      return undefined;
    case 'load':
      orchestrator.loadPlan(plan());
      return undefined;
    case 'complete':
      await orchestrator.markTaskComplete('t1');
      return undefined;
    case 'newer run while cancel cleans up': {
      const cancelled = orchestrator.cancelTask('t1');
      await env.cleaningUp;
      const spawned = env.spawnsOfT1();
      void orchestrator.forceStartTask('t1');
      await vi.waitFor(() => expect(env.spawnsOfT1()).toBe(spawned + 1));
      const newer = orchestrator.runs.planIsolation?.run.tasks.t1;
      expect(newer).not.toBe(env.facts.made?.record);
      env.cleanUp();
      await cancelled;
      await flushMicrotasks(30);
      // The cancel's release was decided for the record it ended, not the one running now.
      expect(orchestrator.runs.planIsolation?.run.tasks.t1).toBe(newer);
      expect(newer?.status).toBe('active');
      orchestrator.stop();
      await vi.waitFor(() => expect(newer?.status).toBe('kept'));
      return newer;
    }
    case 'newer run': {
      orchestrator.stop();
      const spawned = env.spawnsOfT1();
      void orchestrator.forceStartTask('t1');
      // Its prepare waits for the held one, as git's would.
      if (env.window === 'prepare') env.release();
      await vi.waitFor(() => expect(env.spawnsOfT1()).toBe(spawned + 1));
      const newer = orchestrator.runs.planIsolation?.run.tasks.t1;
      expect(newer?.status).toBe('active');
      orchestrator.stop();
      await vi.waitFor(() => expect(newer?.status).toBe('kept'));
      return newer;
    }
  }
}

describe('every exit of an attempt\'s spawn, against every end in its window', () => {
  it.each(cells)('%s, held at its %s, ended by %s: the record ends %s, let go %s', async (exit, window, how, outcome, late) => {
    const env = setup(exit, window, how);
    const { orchestrator } = env;
    orchestrator.loadPlan(plan());
    await orchestrator.forceStartTask('t2');
    const first = orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => String(err));
    if (window === 'running') {
      await vi.waitFor(() => expect(env.attempts.phaseOf('t1')).toBe('running'));
      env.facts.exit = 'spawned';
    } else {
      await env.entered;
    }
    const newer = await end(env, how);
    // A Stop lets go unawaited: what it reaches, it reaches before the spawn goes on.
    await flushMicrotasks(30);
    env.release();
    await first;
    await flushMicrotasks(30);

    expect(env.facts.exit).toBe(exit);
    const firstSpawned = window === 'runner spawn' || window === 'running' ? 1 : 0;
    expect(env.spawnsOfT1()).toBe(firstSpawned + (outcome === 'newer kept' ? 1 : 0));
    expect(env.attempts.unspawned.size).toBe(0);
    expect(env.facts.lateLetGos).toBe(late === 'late' ? 1 : 0);
    for (const times of env.released.values()) expect(times).toBe(1);

    const { made } = env.facts;
    if (outcome === 'newer kept') {
      expect(orchestrator.runs.planIsolation?.run.tasks.t1).toBe(newer);
      expect(newer?.status).toBe('kept');
      return;
    }
    if (!made) {
      expect(exit).toBe('prepare throws');
      return;
    }
    if (outcome === 'removed') {
      expect(made.run.tasks.t1).toBeUndefined();
      expect(env.released.get(made.record)).toBe(1);
    } else {
      expect(made.run.tasks.t1).toBe(made.record);
      expect(made.record.status).toBe(outcome);
      expect(env.released.get(made.record) ?? 0).toBe(outcome === 'kept' ? 1 : 0);
    }
  });
});

/** Which of t1's releases git fails: the first end's, or the second end's, which the spawn's late let-go retries. */
type Fails = 'none' | 'first' | 'second';
/** The two ends that come, in order, while t1's first spawn is held; then how many releases of t1 are asked in all. */
type TwoEnds = readonly [Exit, Window, End, End, Fails, Outcome, Late, number];

const twoEnds: ReadonlyArray<TwoEnds> = [
  // A delete after a cancel or a Stop says the kept worktree goes; when its own release fails, the spawn's late let-go is that release's retry.
  ['live check finds it ended', 'check', 'cancel', 'delete', 'none', 'removed', 'not late', 2],
  ['live check finds it ended', 'check', 'cancel', 'delete', 'second', 'removed', 'late', 3],
  ['start-config check refuses', 'check', 'cancel', 'delete', 'second', 'removed', 'late', 3],
  ['open fails after making', 'open', 'cancel', 'delete', 'second', 'removed', 'late', 3],
  ['runner spawn finds it ended', 'runner spawn', 'cancel', 'delete', 'second', 'removed', 'late', 3],
  ['live check finds it ended', 'check', 'stop', 'delete', 'none', 'removed', 'not late', 2],
  ['live check finds it ended', 'check', 'stop', 'delete', 'second', 'removed', 'late', 3],
  // A load ends only what is live, so it decides nothing for an attempt a cancel ended already: what the cancel kept stays kept, as it would once settled.
  ['live check finds it ended', 'check', 'cancel', 'load', 'none', 'kept', 'not late', 1],
  ['live check finds it ended', 'check', 'cancel', 'load', 'first', 'kept', 'late', 2],
  // A task the delete took out of progress has nothing left for a cancel to end, and nothing a cancel says brings back what the delete removed.
  ['live check finds it ended', 'check', 'delete', 'cancel', 'none', 'removed', 'not late', 1],
  ['live check finds it ended', 'check', 'delete', 'cancel', 'first', 'removed', 'late', 2],
  // A landing decides the record before any later release: a delete's that goes through drops the record of work that stays landed, and one that fails is not retried.
  ['live check finds it ended', 'check', 'complete', 'delete', 'none', 'removed', 'not late', 1],
  ['live check finds it ended', 'check', 'complete', 'delete', 'first', 'merged', 'not late', 1],
];

describe('two ends in one spawn\'s window: the later one\'s decision is what the record shows', () => {
  it.each(twoEnds)('%s, held at its %s, ended by %s then %s, failing %s: the record ends %s, let go %s', async (exit, window, first, second, fails, outcome, late, asked) => {
    // The second end's release is the first end's when the first makes none.
    const failing = fails === 'none' ? 0 : fails === 'first' ? 1 : 2;
    const env = setup(exit, window, first, { failing });
    const { orchestrator } = env;
    orchestrator.loadPlan(plan());
    await orchestrator.forceStartTask('t2');
    const spawned = orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => String(err));
    await env.entered;
    await end(env, first);
    // A Stop lets go unawaited: the second end comes once the first's release has.
    await flushMicrotasks(30);
    await end(env, second);
    await flushMicrotasks(30);
    env.release();
    await spawned;
    await flushMicrotasks(30);

    expect(env.facts.exit).toBe(exit);
    expect(env.attempts.unspawned.size).toBe(0);
    expect(env.facts.lateLetGos).toBe(late === 'late' ? 1 : 0);
    expect(env.releasesOfT1()).toBe(asked);
    const { made } = env.facts;
    if (!made) throw new Error('the open made no record');
    expect(env.released.get(made.record) ?? 0).toBe(asked - (fails === 'none' ? 0 : 1));
    if (first === 'complete') {
      // Nothing undoes the landing: it ran once, and its record still says so.
      expect(env.isolation.calls.filter((c) => c.op === 'integrate' && c.taskId === 't1')).toHaveLength(1);
      expect(env.isolation.calls.some((c) => c.op === 'revert')).toBe(false);
      expect(made.record.status).toBe('merged');
    }
    if (outcome === 'removed') expect(made.run.tasks.t1).toBeUndefined();
    else {
      expect(made.run.tasks.t1).toBe(made.record);
      expect(made.record.status).toBe(outcome);
    }
  });

  it('a delete that comes while the ended spawn waits out the cancel\'s release, and fails its own, is retried', async () => {
    const env = setup('live check finds it ended', 'check', 'cancel', { held: 1, failing: 2 });
    const { orchestrator } = env;
    orchestrator.loadPlan(plan());
    await orchestrator.forceStartTask('t2');
    const spawned = orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => String(err));
    await env.entered;
    const cancelled = orchestrator.cancelTask('t1');
    await env.cleaningUp;
    // Let the spawn on before the delete, so the delete comes while it waits out the cancel's release.
    env.release();
    await flushMicrotasks(30);
    await end(env, 'delete');
    env.cleanUp();
    await cancelled;
    await spawned;
    await flushMicrotasks(30);

    const { made } = env.facts;
    if (!made) throw new Error('the open made no record');
    expect(env.facts.lateLetGos).toBe(1);
    expect(env.releasesOfT1()).toBe(3);
    expect(env.released.get(made.record)).toBe(2);
    expect(made.run.tasks.t1).toBeUndefined();
    expect(env.attempts.unspawned.size).toBe(0);
  });
});

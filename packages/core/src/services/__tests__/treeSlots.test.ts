import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState, Task } from '../../models/Task';
import type { ChildPlacement, Session, SessionDeps } from '../createSession';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { SlotPool, type PoolNode } from '../SlotPool';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, fakeNotification, makeSession, memoryTaskLogs, taskOf } from './sessionTestKit';
import { heldPlanner, hitLimit, NOW, plan, prose, RESUME_AT, recordingRunner, settled, task, until } from './supervisorTestKit';

/**
 * One pool of slots across a tree (ADR-0055 D18), with real Sessions beside
 * each other as `Session.hostChild` seats them; only the runners, the planner
 * and git are faked. Nothing yet delegates, so the root's task gives its slot
 * back as a delegated task never takes one, and keeps the worktree it seats a
 * child in.
 */

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

interface Node {
  session: Session;
  planner: ReturnType<typeof heldPlanner>;
  run: ReturnType<typeof recordingRunner>;
  notices: string[];
}

async function tree(maxParallelSessions: number, settingsOf: Partial<GlobalRunSettings> = {}) {
  const config = fakeConfig({ maxParallelSessions, worktreeIsolation: true, conflictRepairAttempts: 1 });
  const isolation = new FakeWorktreeIsolation();
  const settings = () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' as const, ...settingsOf } });
  const rootRun = recordingRunner();
  const rootPlanner = heldPlanner();
  const root = makeSession({ config, isolation, runner: rootRun.runner, aiService: rootPlanner.aiService, settings, workspaceRoot: () => '/repo', sessionId: 'root' });
  root.loadPlan(plan([task('delegated', 1)]), 'the root goal', '/repo');
  await root.execute({ command: 'run_plan' }, { kind: 'user' });
  await until(() => rootRun.spawnedIds().includes('delegated'));
  await root.execute({ command: 'stop_task', task: 'delegated' }, { kind: 'user' });
  await settled();
  const seat: ChildPlacement = root.hostChild('delegated');
  const seats: Node[] = [];

  const child = (name: string, tasks: Task[], deps: Partial<SessionDeps> = {}): Node => {
    const planner = heldPlanner();
    const run = recordingRunner();
    const notices: string[] = [];
    const tell = (message: string) => { notices.push(message); };
    const codeRoot = `/repo/.ordewell/worktrees/run1/${name}`;
    const session = makeSession({
      config, runner: run.runner, aiService: planner.aiService, settings,
      workspaceRoot: () => codeRoot,
      placement: { ...seat, sessionId: name },
      saveSession: vi.fn(),
      openTaskLog: memoryTaskLogs(),
      notifications: { info: tell, warn: tell, error: tell, confirm: vi.fn().mockResolvedValue(undefined) },
      ...deps,
    });
    session.loadPlan(plan(tasks) as LegacyPlanState, `the goal of ${name}`, codeRoot);
    const node = { session, planner, run, notices };
    seats.push(node);
    return node;
  };
  return { root, rootRun, rootPlanner, child, seat, isolation, seats };
}

const run = (node: Node) => node.session.execute({ command: 'run_plan' }, { kind: 'user' });
const started = (node: Node) => node.run.spawnedIds();
const pass = async (node: Node, taskId: string) => {
  node.run.of(taskId).reportComplete({ status: 'done', summary: 'Done.' });
  await settled();
};

describe('two children on one Parallel limit (ADR-0055 D18)', () => {
  it('Parallel 1: the task the pool refused starts when the other child\'s ends, and no child waits on a user', async () => {
    const { child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', [task('b1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));

    await run(b);
    await settled();

    expect(started(b)).toEqual([]);
    expect(taskOf(b.session, 'b1')!.status).not.toBe('in_progress');
    // Ready, and its run not settled: nothing told anyone it waits on them.
    expect(b.notices.join('\n')).not.toMatch(/require user action|Run finished|All tasks completed/);

    await pass(a, 'a1');

    await until(() => started(b).includes('b1'));
  });

  it('holds the whole tree to the limit however many children are ready', async () => {
    const { child } = await tree(2);
    const a = child('a', [task('a1', 1), task('a2', 2)]);
    const b = child('b', [task('b1', 1), task('b2', 2)]);
    await run(a);
    await until(() => started(a).length === 2);
    await run(b);
    await settled();
    expect(started(b)).toEqual([]);

    await pass(a, 'a1');
    await until(() => started(b).length === 1);
    await settled();
    expect(started(a).length + started(b).length).toBe(3);
  });

  it('gives a freed slot to the Session refused first', async () => {
    const { child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', [task('b1', 1)]);
    const c = child('c', [task('c1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    await run(b);
    await settled();
    await run(c);
    await settled();

    await pass(a, 'a1');

    await until(() => started(b).includes('b1'));
    expect(started(c)).toEqual([]);
    await pass(b, 'b1');
    await until(() => started(c).includes('c1'));
  });

  it('stops counting a child that has closed', async () => {
    const { child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', [task('b1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    await run(b);
    await settled();
    a.session.destroy();
    await until(() => started(b).includes('b1'));
  });
});

describe('a subplanner\'s turn (ADR-0055 D18)', () => {
  /** Every slot taken by attempts of `node` waiting on a checkpoint. */
  const atCheckpoints = async (node: Node, tasks: readonly string[]) => {
    await run(node);
    await until(() => started(node).length === tasks.length);
    for (const id of tasks) void node.run.of(id).callCheckpoint('Which way?').catch(() => undefined);
    await settled();
  };

  it('still runs when every slot is an attempt waiting on it: a limit that stopped the answer would stop the tree', async () => {
    const { child } = await tree(2);
    const a = child('a', [task('a1', 1), task('a2', 2)]);
    await atCheckpoints(a, ['a1', 'a2']);

    void a.session.continueConversation('Answer them').catch(() => undefined);

    await until(() => a.planner.calls.length === 1);
  });

  it('is the most let past the limit: one, and the next waits for it to end', async () => {
    const { child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', [task('b1', 1)]);
    await atCheckpoints(a, ['a1']);
    void a.session.continueConversation('Answer it').catch(() => undefined);
    await until(() => a.planner.calls.length === 1);

    void b.session.continueConversation('Go on').catch(() => undefined);
    await settled();

    expect(b.planner.calls).toHaveLength(0);
  });

  it('waits for a slot with nothing waiting on it, then opens ahead of an attempt kept for one', async () => {
    const { child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', [task('b1', 1)]);
    const c = child('c', [task('c1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    await run(c);
    await settled();

    void b.session.continueConversation('Go on').catch(() => undefined);
    await settled();
    expect(b.planner.calls).toHaveLength(0);

    await pass(a, 'a1');

    await until(() => b.planner.calls.length === 1);
    expect(started(c)).toEqual([]);

    b.planner.calls[0].finish(prose('Done.'));
    await until(() => started(c).includes('c1'));
  });

  it('holds its slot for its turn, and a task of the tree starts once it ends', async () => {
    const { child } = await tree(1);
    const a = child('a', []);
    const b = child('b', [task('b1', 1)]);
    void a.session.continueConversation('Think').catch(() => undefined);
    await until(() => a.planner.calls.length === 1);

    await run(b);
    await settled();
    expect(started(b)).toEqual([]);

    a.planner.calls[0].finish(prose('Thought.'));
    await until(() => started(b).includes('b1'));
  });

  it('is parked between turns: its process goes as the turn ends, and only then its slot', async () => {
    const { child } = await tree(1);
    const a = child('a', []);
    void a.session.continueConversation('Think').catch(() => undefined);
    await until(() => a.planner.calls.length === 1);
    expect(a.planner.aiService.restart).not.toHaveBeenCalled();

    a.planner.calls[0].finish(prose('Thought.'));
    await until(() => !a.session.isPlannerBusy);

    expect(a.planner.aiService.restart).toHaveBeenCalledTimes(1);
  });

  it('asks again from where it stopped: the next turn is the same conversation', async () => {
    const { child } = await tree(1);
    const a = child('a', []);
    void a.session.continueConversation('Think').catch(() => undefined);
    await until(() => a.planner.calls.length === 1);
    a.planner.calls[0].finish(prose('Thought.'));
    await until(() => !a.session.isPlannerBusy);

    void a.session.continueConversation('Think again').catch(() => undefined);

    await until(() => a.planner.calls.length === 2);
    expect(a.planner.aiService.startConversation).toHaveBeenCalledTimes(1);
    expect(a.planner.aiService.continueConversation).toHaveBeenCalledTimes(1);
  });

  it('an opening waits for a slot as a later turn does', async () => {
    const { child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', []);
    await run(a);
    await until(() => started(a).includes('a1'));

    const opening = b.session.startPlanning('Plan a subtree').catch(() => undefined);
    await settled();
    expect(b.planner.calls).toHaveLength(0);

    await pass(a, 'a1');

    await until(() => b.planner.calls.length === 1);
    b.planner.calls[0].finish(prose('A plan.'));
    await opening;
  });

  it('an opening stopped while it waits never opens, and leaves no slot taken', async () => {
    const { child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', []);
    await run(a);
    await until(() => started(a).includes('a1'));
    const stop = new AbortController();

    const opening = b.session.startPlanning('Plan a subtree', undefined, { signal: stop.signal });
    await settled();
    stop.abort();

    await expect(opening).rejects.toThrow();
    await pass(a, 'a1');
    expect(b.planner.calls).toHaveLength(0);
  });

  it('a Stop reaches a turn waiting for a slot, as it reaches one at the gate: what was stopped does not open when one frees', async () => {
    const { child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', []);
    await run(a);
    await until(() => started(a).includes('a1'));
    const message = b.session.continueConversation('Go on');
    await settled();

    expect(b.session.abortPlannerTurn()).toBe(true);

    await expect(message).rejects.toThrow();
    await pass(a, 'a1');
    expect(b.planner.calls).toHaveLength(0);
  });

  it('the root\'s turn is counted once the tree has a child, and is never held', async () => {
    const { root, rootPlanner, child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));

    void root.continueConversation('And the next thing?').catch(() => undefined);

    await until(() => rootPlanner.calls.length === 1);
  });
});

describe('a resume at a limit\'s reset the pool refuses (ADR-0055 D18)', () => {
  it('starts when a slot frees, in a run still held', async () => {
    const { child } = await tree(1);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', []);
    await run(a);
    await until(() => started(a).includes('a1'));
    hitLimit(a.run.of('a1'));
    await until(() => taskOf(a.session, 'a1')!.resumeAt === RESUME_AT);

    // No attempt can hold the slot, the runner being on its limit: a subplanner's turn does.
    void b.session.continueConversation('Think').catch(() => undefined);
    await until(() => b.planner.calls.length === 1);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await settled();

    // Kept past its time, where a flat run drops it to the user.
    expect(taskOf(a.session, 'a1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
    expect(a.notices.join('\n')).not.toContain('did not resume');
    expect(a.run.runner.spawn).toHaveBeenCalledTimes(1);

    b.planner.calls[0].finish(prose('Thought.'));

    await until(() => a.run.runner.spawn.mock.calls.length === 2);
    expect(a.run.runner.spawn.mock.calls[1][0].taskId).toBe('a1');
  });
});

describe('a usage limit found by one node (ADR-0055 D18)', () => {
  it('holds a sibling\'s work on that runner until the reset, and nothing waits on a user meanwhile', async () => {
    const { child } = await tree(3);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', [task('b1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    hitLimit(a.run.of('a1'));
    await until(() => taskOf(a.session, 'a1')!.resumeAt === RESUME_AT);

    await run(b);
    await settled();

    expect(started(b)).toEqual([]);
    expect(b.notices.join('\n')).not.toMatch(/require user action/);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => started(b).includes('b1'));
    await until(() => a.run.runner.spawn.mock.calls.length === 2);
  });

  it('moves a sibling\'s resume to the later reset: a runner is usable once every limit it hit has reset', async () => {
    const { child } = await tree(3);
    const a = child('a', [task('a1', 1)]);
    const b = child('b', [task('b1', 1)]);
    await run(a);
    await run(b);
    await until(() => started(a).includes('a1') && started(b).includes('b1'));
    hitLimit(a.run.of('a1'));
    await until(() => taskOf(a.session, 'a1')!.resumeAt === RESUME_AT);

    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    const later = "You've hit your session limit · resets 9:10pm (UTC)";
    const session: FakeRunnerSession = b.run.of('b1');
    session.emitEvent({ type: 'error', message: later });
    session.emitOutput(`${later}\n`);
    session.emitTurnEnd('failed');

    const laterResume = '2026-10-11T21:11:00.000Z';
    await until(() => taskOf(b.session, 'b1')!.resumeAt === laterResume);
    await until(() => taskOf(a.session, 'a1')!.resumeAt === laterResume);
  });
});

describe('what waits for a slot another Session holds is a wait, not a failure (ADR-0055 D18)', () => {
  const words = (mock: unknown) => vi.mocked(mock as (message: string) => void).mock.calls.flat().join('\n');

  /** One Session on a pool it shares with a sibling, whose slots the test takes and frees by hand. */
  function shared(limit: { value: number }, isolation = new FakeWorktreeIsolation()) {
    const pool = new SlotPool(() => limit.value);
    const sibling: PoolNode = { tick: async () => undefined, openTurn: () => undefined, waitsOnPlanner: () => false, limitFound: () => undefined };
    pool.join(sibling);
    const run = recordingRunner();
    const notifications = fakeNotification();
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig({ maxParallelSessions: 8, conflictRepairAttempts: 1 }),
      notifications,
      runner: run.runner,
      output: new BufferedTaskOutputSource(),
      registry: new RunnerRegistry(),
      isolation,
      workspaceRoot: () => '/repo',
      workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
      pool,
    });
    const held = () => {
      const slot = pool.take(sibling, { role: 'task', taskId: 'theirs' });
      if ('refused' in slot) throw new Error(slot.refused);
      return slot;
    };
    return { pool, orchestrator, run, notifications, held, isolation };
  }

  it('a queued start holds its run open: nothing here will tick for it, and what frees the slot does', async () => {
    const limit = { value: 2 };
    const env = shared(limit);
    const slot = env.held();
    const completed = vi.fn();
    env.orchestrator.subscribe({ onExecutionComplete: completed });
    env.orchestrator.loadPlan([task('a', 1), task('b', 2)]);
    await env.orchestrator.forceStartTask('a');
    env.orchestrator.startWhenAllowed('b');
    // The tree narrows under the run, so the slot `a` frees is not there for `b`.
    limit.value = 1;

    env.run.of('a').reportComplete({ status: 'done', summary: '' });
    await settled();

    expect(env.run.spawnedIds()).toEqual(['a']);
    expect(completed).not.toHaveBeenCalled();

    limit.value = 2;
    slot.free();
    await until(() => env.run.spawnedIds().includes('b'));
  });

  it('a repair owed stays owed, and starts when the sibling\'s slot frees', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.outcomes.set('a', 'conflict');
    const env = shared({ value: 2 }, isolation);
    env.orchestrator.loadPlan([task('a', 1), task('b', 2)]);
    await env.orchestrator.forceStartTask('a');
    await env.orchestrator.forceStartTask('b');
    env.run.of('a').emitExit(1);
    await until(() => env.orchestrator.storeInstance.get('a')?.status === 'failed');
    const slot = env.held();

    await env.orchestrator.markTaskComplete('a');

    expect(words(env.notifications.info)).toContain('Task "Task a" is repaired once a slot is free.');
    expect(env.orchestrator.activeTaskIds).toEqual(['b']);
    expect(env.orchestrator.storeInstance.get('a')?.status).toBe('pending');

    slot.free();
    await until(() => env.orchestrator.activeTaskIds.includes('a'));
  });

  it('an explicit start answers its caller with the refusal: only what nobody asked for waits', async () => {
    const env = shared({ value: 1 });
    env.held();
    env.orchestrator.loadPlan([task('a', 1)]);
    await expect(env.orchestrator.forceStartTask('a')).rejects.toThrow('the most this tree runs at once');
  });

  it('counts its own attempts for readiness: a task the pool refused is still ready', async () => {
    const env = shared({ value: 1 });
    env.held();
    env.orchestrator.loadPlan([task('a', 1), task('b', 2)]);
    await env.orchestrator.approveReview();
    await settled();
    expect(env.orchestrator.getReadyTasks().map((t) => t.id)).toEqual(['a', 'b']);
    expect(words(env.notifications.info)).not.toContain('require user action');
  });

  it('kept resumes do not outlive what they wait for: a resume cancelled meanwhile does not start', async () => {
    const env = shared({ value: 1 });
    env.orchestrator.loadPlan([{ ...task('a', 1), status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT, runnerSessionId: 'native-a' }]);
    const slot = env.held();
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await settled();
    expect(env.orchestrator.storeInstance.get('a')?.resumeAt).toBe(RESUME_AT);

    await env.orchestrator.cancelScheduledResume('a');
    slot.free();
    await settled();

    expect(env.run.spawnedIds()).toEqual([]);
  });
});

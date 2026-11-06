/*
 * What ends a child and what brings it back, on real repositories (ADR-0055
 * D15, D16, D17, ADR-0056 M5, M10): a Stop is a tombstone first and reaches the
 * whole subtree, a restart starts nothing, a Continue reopens the child, and a
 * fresh attempt or a removal discards it.
 */

// Part of childRunLifecycle.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: childRunLifecycleKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { LeaseHost } from '../sessionLease';
import { Subtree } from '../Subtree';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { Session } from '../createSession';
import { fakeConfig, removeDir } from '../../testing';
import { loadChildSession, saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { closeSessions, fakeFs, makeSession, type PlannerTurn as Turn } from './sessionTestKit';
import { roots, repo, fakeRunner, isolation, watchedIsolation, planOf, delegated, check, SIGNAL, SUBMIT, childTask, DONE, BLOCKED, stoppablePlanner, tree, statusOf, taskOf, branches, childIdOf, worktreesOf, childRunId, wait, type TreeOptions } from './childRunLifecycleKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

describe('a close with git at work', () => {
  /*
   * CI lost a test this way: `d` completed, the scheduler was opening `c`'s
   * worktree, and the test destroyed its Session and removed the repository.
   * `git worktree add` recreated `.ordewell` behind the removal, so the root
   * stayed non-empty, and `rmSync`'s retries only call rmdir again.
   */
  it('waits out the worktree opening for the next task, so nothing writes behind the repository going', async () => {
    let letGitGo = () => undefined as void;
    const git = new Promise<void>((resolve) => { letGitGo = resolve; });
    let opening: Promise<unknown> | undefined;
    const isolated = watchedIsolation(
      (change, ended) => { if (change === 'prepare' && !opening && statusOf(parent, 'd') === 'completed') opening = ended; },
      (change) => (change === 'prepare' && statusOf(parent, 'd') === 'completed' ? git : undefined),
    );
    const { parent, root } = tree([SUBMIT([childTask('a', 1)]), DONE], { isolated });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(opening).toBeDefined(), { timeout: 20_000 });

    let closed = false;
    const closing = closeSessions().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);

    letGitGo();
    await closing;
    // No retries: nothing may be left that could write here.
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  });
});
describe('a Stop (ADR-0055 D16)', () => {
  it('reaches a live planner turn, and resolves only once the subtree has gone', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'], heldStops: ['a'] });
    let turnStopped = false;
    // A turn that hangs with its run going, until it is stopped.
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1)])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));

    parent.stopExecution();
    const gone = parent.stopSubtree().then(() => { turnStopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The runner has not gone, so neither has the subtree: there is no timeout of its own.
    expect(turnStopped).toBe(false);
    expect(runner.stopped).toContain('a');
    runner.letStop('a');
    await gone;
    expect(statusOf(parent, 'd')).toBe('pending');
    parent.destroy();
  });
});
describe('a Stop, read below it', () => {
  it('refuses what a turn still winding down asks to start, at the claim', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['a'] });
    let reply: { text: string; isError?: boolean } | undefined;
    let go = () => undefined as void;
    const past = new Promise<void>((resolve) => { go = resolve; });
    const WINDING: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1), childTask('b', 2)])(tools, '');
      await tools.runTask!({ task: 'a' }, { signal: SIGNAL });
      await past;
      reply = await tools.runTask!({ task: 'b' }, { signal: SIGNAL });
    };
    const { parent } = tree([WINDING], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    parent.stopExecution();
    go();
    await parent.stopSubtree();
    await vi.waitFor(() => expect(reply).toBeDefined());
    expect(runner.spawned).not.toContain('b');
    expect(reply?.isError).toBeTruthy();
    parent.destroy();
  });

  it('reaches every level: a grandchild\'s runner stops with its root, and its budget comes back', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'] });
    const nested = [
      { id: 'n', order: 1, title: 'Nested', description: 'n', type: 'delegated', goal: 'Write a', budget: { tokens: 800_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', assignedRunner: 'claude-code', dependencies: [] },
      { id: 'nc', order: 2, title: 'Check nested', description: 'nc', type: 'ai', prompt: 'read it', readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: ['n'] },
    ];
    const { parent } = tree([SUBMIT(nested), SUBMIT([childTask('a', 1)])], { runner, tasks: [delegated({ grants: ['delegate'] }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });

    parent.stopExecution();
    await parent.stopSubtree();
    expect(runner.stopped).toContain('a');
    const ledger = await parent.ledger();
    expect(ledger.numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('closes a child that was opening as the Stop came, so its budget comes back', async () => {
    const root = repo();
    const planner = stoppablePlanner([]);
    let built = false;
    const parent: Session = makeSession({
      runner: fakeRunner({}), isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
      config: fakeConfig({ maxParallelSessions: 3 }),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000 } }),
      delegationOffered: true,
      childDeps: () => {
        // As it is built: the carve has taken, and nothing has started.
        parent.stopExecution();
        built = true;
        return { aiService: planner.service(), fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } };
      },
    });
    parent.loadPlan(planOf([delegated(), check()]), 'the root goal', root, { sessionId: 'session-root' });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(built).toBe(true));
    await parent.stopSubtree();
    await wait(50);
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    expect(planner.asked).toEqual([]);
    parent.destroy();
  });
});
describe('a budget stop (ADR-0056 M5)', () => {
  it('does what a Stop does, a live turn included, and ends the task blocked with a derived report', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { usage: 3_000_000 });
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner, tasks: [delegated({ budget: { tokens: 400_000 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('out of budget') });
    expect(taskOf(parent, 'd').handoff?.summary).toContain('"Write a"');
    expect(runner.spawned).not.toContain('b');
    parent.destroy();
  });
});
describe('a refused carve (ADR-0056 M5)', () => {
  it('leaves no name of a child that never existed', async () => {
    const { parent } = tree([], { tasks: [delegated({ budget: { tokens: 9_000_000 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(childIdOf(parent, 'd')).toBeUndefined();
    expect(taskOf(parent, 'd').runnerSessionId).toBeUndefined();
    parent.destroy();
  });
});
describe('a fresh attempt (ADR-0055 D15)', () => {
  /** A child that ends blocked with its task's worktree in place: there is a run of its own to discard. */
  async function blockedChild(over: TreeOptions = {}) {
    const runner = over.runner ?? fakeRunner({ a: ['a.txt'] });
    const built = tree([SUBMIT([childTask('a', 1)]), BLOCKED, SUBMIT([childTask('a', 1)]), DONE], { runner, ...over });
    await built.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(built.parent, 'd')).toBe('failed'), { timeout: 20_000 });
    const child = childIdOf(built.parent, 'd')!;
    return { ...built, child, run: childRunId(built.root, child)! };
  }

  /** A child stopped with a task at work: its own run stands, worktree and integration branch, as one that finished and merged does not. */
  async function stoppedChild(over: TreeOptions = {}) {
    const runner = fakeRunner({ a: ['a.txt'] }, { heldOnce: ['a'] });
    const built = tree([SUBMIT([childTask('a', 1)]), SUBMIT([childTask('a', 1)]), DONE], { runner, ...over });
    await built.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });
    built.parent.stopExecution();
    await built.parent.stopSubtree();
    const child = childIdOf(built.parent, 'd')!;
    const run = childRunId(built.root, child)!;
    expect(worktreesOf(built.root, run)).not.toEqual([]);
    expect(integrationOf(built.root, run)).not.toEqual([]);
    return { ...built, child, run };
  }

  const integrationOf = (root: string, run: string) => branches(root).filter((name) => name.includes(run) && name.endsWith('integration'));

  const expectStartedOver = (root: string, parent: Session, child: string, run: string) => {
    expect(childIdOf(parent, 'd')).not.toBe(child);
    expect(worktreesOf(root, run)).toEqual([]);
    expect(integrationOf(root, run)).toEqual([]);
    // Its state stays, under the root.
    expect(loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: child })).not.toBeNull();
  };

  it('discards the old child on a fresh retry, and starts a new one on what is left of the budget', async () => {
    const { root, parent, child, run } = await blockedChild({ runner: fakeRunner({ a: ['a.txt'] }, { usage: 300_000 }) });
    const spent = (await parent.ledger()).spentOn('root', 'd');
    expect(spent).toBeGreaterThan(0);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expectStartedOver(root, parent, child, run);
    const ledger = await parent.ledger();
    expect(ledger.numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('discards it on Execute', async () => {
    const { root, parent, child, run } = await stoppedChild();
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expectStartedOver(root, parent, child, run);
    parent.destroy();
  });

  it('discards it on a force start', async () => {
    const { root, parent, child, run } = await stoppedChild();
    expect(await parent.execute({ command: 'force_start', task: 'd' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expectStartedOver(root, parent, child, run);
    parent.destroy();
  });

  it('never mints budget: a task that spent it all has nothing to start a child on', async () => {
    const { parent, planner } = await blockedChild({ runner: fakeRunner({ a: ['a.txt'] }, { usage: 2_100_000 }) });
    const asked = planner.asked.length;
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('has spent its budget') }), { timeout: 20_000 });
    expect(planner.asked).toHaveLength(asked);
    parent.destroy();
  });

  it('discards it as the task is removed, and its budget is back', async () => {
    const { root, parent, child, run } = await stoppedChild({ tasks: [delegated(), check({ dependencies: [] })] });
    await parent.removeTask('d');
    await vi.waitFor(() => expect(worktreesOf(root, run)).toEqual([]));
    await vi.waitFor(() => expect(integrationOf(root, run)).toEqual([]));
    expect(loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: child })).not.toBeNull();
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('discards it as a planner\'s edit takes the task out between runs', async () => {
    const REMOVE: Turn = async (tools) => {
      const reply = await tools.editPlan!({ ops: [{ op: 'remove', taskId: 'd' }] }, { signal: SIGNAL });
      if (reply.isError) throw new Error(reply.text);
    };
    const { root, parent, run } = await stoppedChild({ tasks: [delegated(), check({ dependencies: [] })], rootTurns: [REMOVE] });
    await parent.continueConversation('drop that task');
    expect(statusOf(parent, 'd')).toBeUndefined();
    await vi.waitFor(() => expect(worktreesOf(root, run)).toEqual([]));
    await vi.waitFor(() => expect(integrationOf(root, run)).toEqual([]));
    parent.destroy();
  });

  it('goes with the run\'s own discard, which nothing else names it to', async () => {
    const { root, parent, run } = await stoppedChild();
    await parent.discardRun();
    expect(worktreesOf(root, run)).toEqual([]);
    expect(integrationOf(root, run)).toEqual([]);
    expect(taskOf(parent, 'd').runnerSessionId).toBeUndefined();
    parent.destroy();
  });

  it('waits for a child still stopping: it cannot be discarded under what is winding down', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { heldOnce: ['a'], heldStops: ['a'] });
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), SUBMIT([childTask('a', 1)]), DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });
    const child = childIdOf(parent, 'd')!;
    const run = childRunId(root, child)!;
    parent.stopExecution();
    const fresh = parent.execute({ command: 'force_start', task: 'd' }, { kind: 'user' });
    await wait(100);
    expect(worktreesOf(root, run)).not.toEqual([]);
    runner.letStop('a');
    await fresh;
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expectStartedOver(root, parent, child, run);
    parent.destroy();
  });
});
describe('a reopened child, read from above (ADR-0057 R1)', () => {
  const reopened = new Subtree({
    here: 'root',
    tasks: () => [{ ...delegated(), runnerSessionId: 'child' }],
    nodes: () => [{ path: 'root/1', sessionId: 'child', taskId: 'd' }, { path: 'root/2', sessionId: 'child', taskId: 'd' }],
    plan: () => [delegated()],
    logs: () => ({ attempts: () => [], events: () => [] }),
  });

  it('counts its one plan once, though a Continue opened it a second node', () => {
    expect(reopened.plans().map((plan) => plan.node)).toEqual(['root/2']);
  });

  it('still reads what a reference pinned against its first node', () => {
    expect(reopened.planAt('root/1')?.node).toBe('root/1');
  });
});
describe('a delegated task started alone, on a Continue (ADR-0055 D8)', () => {
  it('starts its check by itself once the child reports', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { tasks: [delegated(), check({ taskMode: 'plan' })] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'finish' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('asks for what the user has not approved, and says so rather than read as finished', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), check({ taskMode: 'plan' })] });
    Object.assign(parent.planState!, { approved: false, approvedTasks: [] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    await vi.waitFor(() => expect(parent.escalations().find((e) => e.task?.id === 'c')).toMatchObject({ kind: 'unapproved', reason: expect.stringContaining('Its delegated task has ended') }), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).toBe('pending');
    expect(parent.startsPending).toBe(true);
    parent.stopExecution();
    expect(parent.startsPending).toBe(false);
    parent.destroy();
  });
});

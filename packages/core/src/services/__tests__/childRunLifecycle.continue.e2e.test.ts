/*
 * What ends a child and what brings it back, on real repositories (ADR-0055
 * D15, D16, D17, ADR-0056 M5, M10): a Stop is a tombstone first and reaches the
 * whole subtree, a restart starts nothing, a Continue reopens the child, and a
 * fresh attempt or a removal discards it.
 */

// Part of childRunLifecycle.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: childRunLifecycleKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LeaseHost } from '../sessionLease';
import { PendingApprovals } from '../PendingApprovals';
import type { SlotPool } from '../SlotPool';
import { taskRowView } from '../../taskRow';
import type { IRunner } from '../../interfaces/IRunner';
import { createTask } from '../../models/Task';
import { FakeRunnerSession, removeDir } from '../../testing';
import { listChildSessions, listSessions, loadChildSession, loadSession, saveChildSession } from '../../utils/sessionStore';
import { closeSessions, type PlannerTurn as Turn } from './sessionTestKit';
import { git, roots, fakeRunner, delegated, check, SIGNAL, SUBMIT, childTask, DONE, NOTHING, BLOCKED, tree, statusOf, taskOf, branches, childIdOf, worktreesOf, childRunId, wait, rowOf } from './childRunLifecycleKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

describe('a Continue (ADR-0055 D17)', () => {
  it('reopens the child a Stop left, with what it had landed, and acts as Execute there', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { root, parent, planner } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), NOTHING, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });
    const child = childIdOf(parent, 'd')!;
    const run = childRunId(root, child)!;

    parent.stopExecution();
    await parent.stopSubtree();
    expect(statusOf(parent, 'd')).toBe('pending');
    expect(taskOf(parent, 'd').runnerSessionId).toBe(child);
    // The Stop left the child's worktrees, which only a discard takes.
    expect(branches(root).filter((name) => name.includes(run))).not.toEqual([]);

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runner.spawned.filter((id) => id === 'b')).toHaveLength(2), { timeout: 20_000 });
    expect(childIdOf(parent, 'd')).toBe(child);
    expect(runner.spawned.filter((id) => id === 'a')).toHaveLength(1);
    runner.release('b');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.asked.join('\n')).toContain('go on');
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    parent.destroy();
  });

  it('says on a Stop that a Continue keeps a child\'s work and running the plan starts it over', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });

    const stopped = await parent.execute({ command: 'stop_run' }, { kind: 'user' });

    expect(stopped.message).toContain('Continue');
    expect(stopped.message).toContain('starts its child over');
    expect(stopped.message).not.toContain('Run the plan or a task to start again');
    await parent.stopSubtree();
    parent.destroy();
  });

  it('says the same in what it tells a surface as it stops the task: Mark complete and Retry are not what keeps a child', async () => {
    const told: string[] = [];
    const say = (message: string) => { told.push(message); };
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner, notifications: { info: say, warn: say, error: say, confirm: vi.fn().mockResolvedValue(undefined) } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });

    await parent.execute({ command: 'stop_run' }, { kind: 'user' });

    const said = told.find((line) => line.startsWith('Stopped'));
    expect(said).toContain('Continue keeps what its child landed');
    expect(said).not.toContain('Mark complete');
    await parent.stopSubtree();
    parent.destroy();
  });

  it('gives the subplanner its turn where nothing is left to run, so a child that only owes its report can file it', async () => {
    const runner = fakeRunner({ a: ['a.txt'] });
    const { root, parent, planner } = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'file your report' }, { kind: 'user' })).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.asked.join('\n')).toContain('file your report');
    expect(runner.spawned.filter((id) => id === 'a')).toHaveLength(1);
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toContain('a.txt');
    parent.destroy();
  });

  it('reopens in the same run while a Stop has yet to take the record off active, or the child\'s landed work is left behind', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { root, parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), NOTHING, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });
    const before = parent.planState?.isolation?.run.id;
    parent.stopExecution();
    await parent.stopSubtree();
    // As a Continue finds it when the Stop's keep has not run yet.
    const record = parent.planState?.isolation?.run.tasks.d;
    await vi.waitFor(() => expect(record?.status).toBe('kept'));
    record!.status = 'active';

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runner.spawned.filter((id) => id === 'b')).toHaveLength(2), { timeout: 20_000 });
    expect(parent.planState?.isolation?.run.id).toBe(before);
    runner.release('b');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    parent.destroy();
  });

  it('keeps the child through a Continue whose worktree could not open, so the next one reopens it', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { root, parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), NOTHING, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });
    const child = childIdOf(parent, 'd')!;
    parent.stopExecution();
    await parent.stopSubtree();
    await vi.waitFor(() => expect(parent.planState?.isolation?.run.tasks.d.status).toBe('kept'));
    // What a Continue opens on is gone for now, as a person's or a tool's branch surgery leaves it.
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    git(root, 'branch', '-m', integration, 'parked');

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(childIdOf(parent, 'd')).toBe(child);
    git(root, 'branch', '-m', 'parked', integration);

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runner.spawned.filter((id) => id === 'b')).toHaveLength(2), { timeout: 20_000 });
    expect(runner.spawned.filter((id) => id === 'a')).toHaveLength(1);
    expect(childIdOf(parent, 'd')).toBe(child);
    runner.release('b');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    parent.destroy();
  });

  it('tells the subplanner when what the task left could not be restored, and where it is kept', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { root, parent, planner } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), NOTHING, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });
    parent.stopExecution();
    await parent.stopSubtree();
    await vi.waitFor(() => expect(parent.planState?.isolation?.run.tasks.d.status).toBe('kept'));
    const record = parent.planState?.isolation?.run.tasks.d;
    writeFileSync(join(Object.values(record!.repos)[0].worktree, 'shared.txt'), 'the task left this\n');
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    const elsewhere = join(root, '..', `elsewhere-${Date.now()}`);
    git(root, 'worktree', 'add', elsewhere, integration);
    writeFileSync(join(elsewhere, 'shared.txt'), 'the tip has this\n');
    git(elsewhere, 'add', '-A');
    git(elsewhere, 'commit', '-m', 'moved');
    git(root, 'worktree', 'remove', '--force', elsewhere);

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runner.spawned.filter((id) => id === 'b')).toHaveLength(2), { timeout: 20_000 });
    const told = planner.asked.at(-1);
    expect(told).toContain('go on');
    expect(told).toContain('conflicted with the integration tip');
    const kept = /kept on branch `([^`]+)`/.exec(told ?? '')?.[1] ?? '';
    expect(git(root, 'show', `${kept}:shared.txt`)).toBe('the task left this');
    runner.release('b');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('refuses a child whose worktree has moved, rather than lose what it landed', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'] });
    const errors = vi.fn();
    const { root, parent, planner } = tree([SUBMIT([childTask('a', 1)])], { runner, notifications: { info: vi.fn(), warn: vi.fn(), error: errors, confirm: vi.fn().mockResolvedValue(undefined) } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });
    parent.stopExecution();
    await parent.stopSubtree();
    const place = { baseDir: root, rootSessionId: 'session-root', sessionId: childIdOf(parent, 'd')! };
    const saved = loadChildSession(place)!;
    saved.plan.isolation!.run.workspaceRoot = join(root, 'somewhere-else');
    saveChildSession(saved.plan, saved.meta.goal, place);
    const asked = planner.asked.length;

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('has moved') }), { timeout: 20_000 });
    expect(planner.asked).toHaveLength(asked);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining('has moved')), { timeout: 20_000 });
    parent.destroy();
  });

  it('leaves the tree\'s pool and its approval feed when the child it built could not load its plan', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'] });
    const errors = vi.fn();
    const unlistens: { off: () => void; called: boolean }[] = [];
    const listen = PendingApprovals.prototype.listen;
    const spy = vi.spyOn(PendingApprovals.prototype, 'listen').mockImplementation(function (this: PendingApprovals, listener) {
      const off = listen.call(this, listener);
      const record = { called: false, off: () => { record.called = true; off(); } };
      unlistens.push(record);
      return record.off;
    });
    const { root, parent } = tree([SUBMIT([childTask('a', 1)])], { runner, notifications: { info: vi.fn(), warn: vi.fn(), error: errors, confirm: vi.fn().mockResolvedValue(undefined) } });
    const pool = (parent as unknown as { orchestrator: { slotPool: SlotPool } }).orchestrator.slotPool;
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });
    parent.stopExecution();
    await parent.stopSubtree();
    expect(pool.shared).toBe(false);
    // The disk holds a plan that passes the move check but that its child refuses to load.
    const place = { baseDir: root, rootSessionId: 'session-root', sessionId: childIdOf(parent, 'd')! };
    const saved = loadChildSession(place)!;
    saved.plan.tasks[0].assignedRunner = 'not-in-the-plan' as never;
    saveChildSession(saved.plan, saved.meta.goal, place);
    const listeners = unlistens.length;

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining('not in the plan\'s runner set')), { timeout: 20_000 });
    spy.mockRestore();

    expect(unlistens).toHaveLength(listeners + 1);
    expect(unlistens.at(-1)!.called).toBe(true);
    expect(pool.shared).toBe(false);
    parent.destroy();
  });

  it('is refused once its work has landed', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: false, message: expect.stringContaining('has landed') });
    parent.destroy();
  });

  it('spends what is left of its stated budget when nothing raised it', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { usage: 1_500_000, held: [] });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    const carves = vi.spyOn(await parent.ledger(), 'carve');
    await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'finish' }, { kind: 'user' });
    await vi.waitFor(() => expect(carves).toHaveBeenCalled(), { timeout: 20_000 });
    expect(carves.mock.calls[0][2].tokens).toBe(500_000);
    parent.destroy();
  });

  /** A child stopped at its only task, then raised by `raise`, whose usage comes as that task ends. */
  async function raisedThenBlocked(raise: number, usage: number) {
    const runner = fakeRunner({ a: ['a.txt'] }, { usage, held: ['a'] });
    const built = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { runner });
    await built.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });
    expect(await built.parent.raiseChild('d', raise)).toBeNull();
    runner.release('a');
    await vi.waitFor(() => expect(statusOf(built.parent, 'd')).toBe('failed'), { timeout: 20_000 });
    return built;
  }

  it('re-carves its stated budget and every raise, less what it spent: a raise is the task\'s, and outlives its child', async () => {
    const { parent } = await raisedThenBlocked(1_000_000, 2_500_000);
    const carves = vi.spyOn(await parent.ledger(), 'carve');
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'finish' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(carves).toHaveBeenCalled(), { timeout: 20_000 });
    expect(carves.mock.calls[0][2].tokens).toBe(500_000);
    parent.destroy();
  });

  it('names what the tree granted when that is spent too', async () => {
    const { parent } = await raisedThenBlocked(500_000, 2_600_000);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('its budget of 2500000 tokens') }), { timeout: 20_000 });
    parent.destroy();
  });

  it('runs on the time left: a Continue gets no fresh clock', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: 3_600_000 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    const spent = taskOf(parent, 'd').attemptUsage?.at(-1)?.wallTimeMs ?? 0;
    expect(spent).toBeGreaterThan(0);
    const carves = vi.spyOn(await parent.ledger(), 'carve');
    await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'finish' }, { kind: 'user' });
    await vi.waitFor(() => expect(carves).toHaveBeenCalled(), { timeout: 20_000 });
    expect(carves.mock.calls[0][2].wallClockMs).toBe(3_600_000 - spent);
    parent.destroy();
  });
});
describe('a crash in the middle of a child run (ADR-0055 D17)', () => {
  /** The disk at this instant, as a process that died here left it. */
  function crashImage(root: string): string {
    const image = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-crash-image-')));
    roots.push(image);
    cpSync(join(root, '.ordewell', 'sessions'), image, { recursive: true });
    return image;
  }

  /** Put the disk back, and open a new process's Session on it. */
  function restart(root: string, image: string, turns: Turn[], runner: IRunner) {
    rmSync(join(root, '.ordewell', 'sessions'), { recursive: true, force: true });
    // Held by a process that is gone: this test's is not, so the file goes as a dead host's would be taken over.
    cpSync(image, join(root, '.ordewell', 'sessions'), { recursive: true, filter: (from) => !from.endsWith('lease.json') });
    const plan = loadSession('session-root', root)!.plan;
    return tree(turns, { root, plan, runner, leaseHost: new LeaseHost() });
  }

  async function midRun() {
    const first = fakeRunner({ a: ['a.txt'] }, { held: ['b'] });
    const dead = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner: first });
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(first.spawned).toContain('b'), { timeout: 20_000 });
    await wait(50);
    const image = crashImage(dead.root);
    const child = childIdOf(dead.parent, 'd')!;
    dead.parent.destroy();
    await dead.parent.gone;
    return { root: dead.root, image, child };
  }

  it('starts nothing on load, and lists the task, failed, naming its child', async () => {
    const { root, image, child } = await midRun();
    const runner = fakeRunner({ b: ['b.txt'] });
    const { parent, planner } = restart(root, image, [], runner);
    await wait(100);
    expect(runner.spawned).toEqual([]);
    expect(planner.asked).toEqual([]);
    expect(taskOf(parent, 'd')).toMatchObject({ status: 'failed', runnerSessionId: child });
    expect(parent.escalations().map((e) => e.task?.id)).toContain('d');
    // Its worktree is the child's code root, so the adoption's prune left it.
    await vi.waitFor(() => expect(parent.planState?.isolation?.run.tasks.d.status).toBe('kept'));
    parent.destroy();
  });

  it('says it lost a parked question, in the row and the inbox, and a Continue keeps the child', async () => {
    const ASK: Turn = async (tools) => { await tools.checkpoint!({ question: 'Which schema?' }, { signal: SIGNAL }); };
    const dead = tree([SUBMIT([childTask('a', 1)]), ASK], { runner: fakeRunner({ a: ['a.txt'] }) });
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(taskOf(dead.parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint', parkedQuestion: 'Which schema?' }), { timeout: 20_000 });
    await wait(50);
    const image = crashImage(dead.root);
    const child = childIdOf(dead.parent, 'd')!;
    dead.parent.destroy();
    await dead.parent.gone;

    const { parent, planner } = restart(dead.root, image, [DONE], fakeRunner({}));
    expect(taskOf(parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'question-lost', runnerSessionId: child });
    expect(taskRowView(taskOf(parent, 'd')).awaiting).toBe('Question lost in a restart');
    const listed = parent.escalations().find((e) => e.task?.id === 'd')!;
    expect(listed.reason).toContain('Which schema?');
    expect(listed.reason).toContain('Ordewell stopped before anyone answered it');
    expect(listed.options.map((o) => o.id)).toContain('continue');
    expect(planner.asked).toEqual([]);

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'Use the first.' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(taskOf(parent, 'd').parkedQuestion).toBeUndefined();
    expect(childIdOf(parent, 'd')).toBe(child);
    parent.destroy();
  });

  it('comes back on a Continue: the child\'s interrupted task runs again, and its work lands', async () => {
    const { root, image, child } = await midRun();
    const runner = fakeRunner({ b: ['b.txt'] });
    const { parent, planner } = restart(root, image, [NOTHING, DONE], runner);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'pick it up' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(runner.spawned).toEqual(['b']);
    expect(childIdOf(parent, 'd') ?? child).toBe(child);
    expect(planner.asked.join('\n')).toContain('pick it up');
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('starts over on a fresh retry instead: the child it left goes, and the budget it held comes back', async () => {
    const { root, image, child } = await midRun();
    const run = childRunId(root, child)!;
    const runner = fakeRunner({ a: ['a.txt'] });
    const { parent } = restart(root, image, [SUBMIT([childTask('a', 1)]), DONE], runner);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(worktreesOf(root, run)).toEqual([]);
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    parent.destroy();
  });
});
describe('a revocation (ADR-0056 M10)', () => {
  it('lets what is in flight finish, starts nothing, no turn included, and ends the child blocked', async () => {
    let tokens = 5_000_000;
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'] });
    const { parent, planner } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner, tokens: () => tokens });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    tokens = 0;
    parent.applyRunSettings({ delegationTokens: 0 });
    const asked = planner.asked.length;
    // What would open a turn is refused, and the check that follows cuts nothing short.
    await parent.execute({ command: 'message_task', task: 'd', text: 'one more thing' }, { kind: 'user' });
    await wait(50);
    expect(planner.asked).toHaveLength(asked);
    expect(runner.stopped).toEqual([]);
    runner.release('a');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('withdrawn') });
    expect(runner.spawned).not.toContain('b');
    expect(planner.asked).toHaveLength(asked);
    expect(taskOf(parent, 'd').handoff?.summary).toContain('"Write a"');
    parent.destroy();
  });
});
describe('a parent going (ADR-0055 D13)', () => {
  it('keeps the tree\'s lease until its child has stopped', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'], heldStops: ['a'] });
    const { root, parent } = tree([SUBMIT([childTask('a', 1)])], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    const held = () => existsSync(join(root, '.ordewell', 'sessions', 'session-root', 'lease.json'));
    expect(held()).toBe(true);
    parent.destroy();
    await wait(50);
    expect(held()).toBe(true);
    runner.letStop('a');
    await parent.gone;
    expect(held()).toBe(false);
    // The log is closed behind the child's own close, so a restart reads its budget back.
    await vi.waitFor(() => expect(readFileSync(join(root, '.ordewell', 'sessions', 'session-root', 'tree-events.jsonl'), 'utf8')).toContain('node_closed'));
  });
});
describe('a subplanner that fails its restart (ADR-0056 M8)', () => {
  it('ends the child failed, its tasks stopped first', async () => {
    const inner = fakeRunner({});
    const failing: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => session.reportComplete({ status: 'failed', summary: 'It failed.', reason: 'It failed.' }), 5);
        return session;
      }),
    };
    const BOOM: Turn = async () => { throw new Error('the planner is gone'); };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BOOM, BOOM], { runner: failing });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'failed', reason: expect.stringContaining('could not restart') });
    parent.destroy();
  });

  it('is picked up by a Continue, Act again', async () => {
    const inner = fakeRunner({ a: ['a.txt'] });
    let spawns = 0;
    const failingOnce: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        spawns += 1;
        if (spawns > 1) return inner.spawn(opts);
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => session.reportComplete({ status: 'failed', summary: 'It failed.', reason: 'It failed.' }), 5);
        return session;
      }),
    };
    const BOOM: Turn = async () => { throw new Error('the planner is gone'); };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BOOM, BOOM, NOTHING, DONE], { runner: failingOnce });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'try again' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });
});
describe('a delegated task\'s row (ADR-0055 D16, D20)', () => {
  it('says where its child\'s tasks stand and what is left of its budget, while the child runs', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['a', 'b'], usage: 100_000 });
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    await vi.waitFor(() => expect(rowOf(parent, 'd')?.tasks).toEqual({ completed: 0, running: 1, waiting: 0, pending: 1, failed: 0, skipped: 0 }));
    expect(rowOf(parent, 'd')?.tokens).toEqual({ budget: 2_000_000, left: 2_000_000 });
    expect(rowOf(parent, 'd')?.stopping).toBeUndefined();
    runner.release('a');
    await vi.waitFor(() => expect(rowOf(parent, 'd')?.tasks).toMatchObject({ completed: 1, running: 1 }));
    // What the first task spent is no longer left.
    expect(rowOf(parent, 'd')?.tokens?.left).toBe(1_900_000);
    await parent.stopSubtree();
    parent.destroy();
  });

  it('says no budget for a task that ran until the ledger is open: a restart has not read what it spent', async () => {
    const { parent } = tree([], { tasks: [{ ...delegated(), attempted: true }, check()] });
    expect(rowOf(parent, 'd')?.tokens).toBeUndefined();
    parent.destroy();
    const fresh = tree([]).parent;
    expect(rowOf(fresh, 'd')?.tokens).toEqual({ budget: 2_000_000, left: 2_000_000 });
    fresh.destroy();
  });

  it('counts a raise in what it says the task was given, or a raised child reads as over a budget it is well within', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'], usage: 100_000 });
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1)])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));

    expect(await parent.raiseChild('d', 500_000)).toBeNull();

    expect(rowOf(parent, 'd')?.tokens).toEqual({ budget: 2_500_000, left: 2_500_000 });
    await parent.stopSubtree();
    parent.destroy();
  });

  it('is stopping from a Stop until the subtree has gone, and not after', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'], heldStops: ['a'] });
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1)])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    expect(rowOf(parent, 'd')?.stopping).toBeUndefined();

    parent.stopExecution();
    const gone = parent.stopSubtree();
    await wait(50);
    // The task already reads as not started, though its child is still winding down.
    expect(statusOf(parent, 'd')).toBe('pending');
    expect(rowOf(parent, 'd')?.stopping).toBe(true);

    runner.letStop('a');
    await gone;
    await vi.waitFor(() => expect(rowOf(parent, 'd')?.stopping).toBeUndefined());
    parent.destroy();
  });

  it('offers no child session to open, while the child runs and after it has ended (ADR-0055 D11)', async () => {
    const { parent, root } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    const child = childIdOf(parent, 'd');
    expect(child).toBeDefined();
    // The child's file exists, under its root, and is nobody's session to open.
    expect(loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: child! })).not.toBeNull();
    expect(listSessions(root).map((meta) => meta.id)).not.toContain(child);
    expect(listChildSessions('session-root', root)).toContain(child);
    parent.destroy();
  });

  it('says nothing of delegation on a flat plan\'s tasks', async () => {
    const { parent } = tree([], { tasks: [createTask({ id: 'f', order: 1, title: 'Flat', prompt: 'x' })] });
    expect(rowOf(parent, 'f')).toBeUndefined();
    parent.destroy();
  });
});

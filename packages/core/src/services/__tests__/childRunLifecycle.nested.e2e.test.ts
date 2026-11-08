/*
 * What ends a child and what brings it back, on real repositories (ADR-0055
 * D15, D16, D17, ADR-0056 M5, M10): a Stop is a tombstone first and reaches the
 * whole subtree, a restart starts nothing, a Continue reopens the child, and a
 * fresh attempt or a removal discards it.
 */

// Part of childRunLifecycle.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: childRunLifecycleKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LeaseHost } from '../sessionLease';
import type { Session } from '../createSession';
import type { IRunner } from '../../interfaces/IRunner';
import { removeDir } from '../../testing';
import { loadChildSession, loadSession, saveChildSession } from '../../utils/sessionStore';
import { closeSessions, type PlannerTurn as Turn } from './sessionTestKit';
import { git, roots, fakeRunner, delegated, check, SIGNAL, SUBMIT, childTask, BLOCKED, tree, statusOf, taskOf, childIdOf, wait, type Runner, type TreeOptions } from './childRunLifecycleKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

describe('a Continue below a Continue (ADR-0055 D15, D17)', () => {
  const NESTED = [
    { id: 'n', order: 1, title: 'Nested', description: 'n', type: 'delegated', goal: 'Write a and b', budget: { tokens: 800_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', assignedRunner: 'claude-code', dependencies: [] },
    { id: 'nc', order: 2, title: 'Check nested', description: 'nc', type: 'ai', prompt: 'read it', readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: ['n'] },
  ];
  /** Whichever subplanner it reaches ends, once it may: levels wake in no fixed order, and a report too soon is refused. */
  const REPORT: Turn = async (tools) => { await tools.taskComplete!({ status: 'done', summary: 'It is written.', commit: { subject: 'Write it' } }, { signal: SIGNAL }); };
  const reports = (count: number): Turn[] => Array.from({ length: count }, () => REPORT);
  const childPlan = (root: string, sessionId: string) => loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId })?.plan;

  function imageOf(root: string): string {
    const image = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-crash-image-')));
    roots.push(image);
    cpSync(join(root, '.ordewell', 'sessions'), image, { recursive: true });
    return image;
  }

  function restarted(root: string, image: string, turns: Turn[], runner: IRunner, { parallel, sessionless }: Pick<TreeOptions, 'parallel' | 'sessionless'> = {}) {
    rmSync(join(root, '.ordewell', 'sessions'), { recursive: true, force: true });
    cpSync(image, join(root, '.ordewell', 'sessions'), { recursive: true, filter: (from) => !from.endsWith('lease.json') });
    return tree(turns, { root, plan: loadSession('session-root', root)!.plan, runner, leaseHost: new LeaseHost(), parallel, sessionless });
  }

  const nestedTree = (turns: Turn[], runner: IRunner, over: Pick<TreeOptions, 'sessionless'> = {}) => tree([SUBMIT(NESTED), ...turns], { runner, tasks: [delegated({ grants: ['delegate'] }), check()], ...over });
  const grandchildOf = (root: string, child: string) => childPlan(root, child)!.tasks.find((t) => t.id === 'n')!;

  /** The process dies here, as `tree.parent` runs. */
  async function crashed({ root, parent }: ReturnType<typeof tree>) {
    await wait(50);
    const image = imageOf(root);
    const child = childIdOf(parent, 'd')!;
    parent.destroy();
    await parent.gone;
    return { root, image, child, grandchild: grandchildOf(root, child).runnerSessionId! };
  }

  async function midGrandchild(usage = 0, tasks = [childTask('a', 1), childTask('b', 2, ['a'])], over: Pick<TreeOptions, 'sessionless'> & { before?: (parent: Session) => Promise<unknown> } = {}) {
    const held = tasks.slice(1).map((t) => t.id);
    const first = fakeRunner({ a: ['a.txt'] }, { held, usage });
    const dead = nestedTree([SUBMIT(tasks)], first, over);
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(first.spawned).toEqual(expect.arrayContaining(held)), { timeout: 20_000 });
    await over.before?.(dead.parent);
    return crashed(dead);
  }

  const goOn = (parent: Session) => parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'pick it up' }, { kind: 'user' });
  const workers = (runner: Runner) => runner.spawned.filter((id) => id !== 'c' && id !== 'nc');

  it('takes each subplanner\'s native session up again, and leaves the transcript whole for a harness that refuses', async () => {
    const first = fakeRunner({ a: ['a.txt'] }, { held: ['a'] });
    const dead = nestedTree([SUBMIT([childTask('a', 1)])], first);
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(first.spawned).toContain('a'), { timeout: 20_000 });
    const before = [...dead.planner.natives];
    const { root, image } = await crashed(dead);

    const { parent, planner } = restarted(root, image, reports(8), fakeRunner({ a: ['a.txt'] }));
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.requests.map((request) => request.resume?.session.sessionId).sort()).toEqual([...before].sort());
    for (const request of planner.requests) expect(request.priorHistory?.length).toBeGreaterThan(0);
    parent.destroy();
  });

  it('keeps a grandchild\'s work: what it finished does not run again, and its run lands', async () => {
    const { root, image, child, grandchild } = await midGrandchild();
    const runner = fakeRunner({ b: ['b.txt'] });
    const { parent } = restarted(root, image, reports(8), runner);
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(workers(runner)).toEqual(['b']);
    expect(grandchildOf(root, child).runnerSessionId).toBe(grandchild);
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('never mints budget at any depth: a grandchild reopens on what its task has left, and each token counts once', async () => {
    const { root, image } = await midGrandchild(300_000);
    const { parent } = restarted(root, image, reports(8), fakeRunner({ b: ['b.txt'] }));
    const ledger = await parent.ledger();
    const carves = vi.spyOn(ledger, 'carve');
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(carves.mock.calls.map(([, , request]) => request.tokens)).toEqual([2_000_000 - 300_000, 800_000 - 300_000]);
    expect(ledger.spentOn('root', 'd')).toBe(300_000);
    parent.destroy();
  });

  it('goes on after a Stop in the same process: the grandchild the Stop reached reopens', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { heldOnce: ['b'] });
    const { root, parent } = nestedTree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), ...reports(8)], runner);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });
    parent.stopExecution();
    await parent.stopSubtree();
    const child = childIdOf(parent, 'd')!;
    const grandchild = grandchildOf(root, child).runnerSessionId;
    expect(grandchild).toBeTruthy();

    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(workers(runner)).toEqual(['a', 'b', 'b']);
    expect(grandchildOf(root, child).runnerSessionId).toBe(grandchild);
    parent.destroy();
  });

  it('keeps a question a restart lost: its subplanner hears it again, and what it finished stands', async () => {
    const ASK: Turn = async (tools) => { await tools.checkpoint!({ question: 'Which schema?' }, { signal: SIGNAL }); };
    const first = fakeRunner({ a: ['a.txt'] });
    const dead = nestedTree([SUBMIT([childTask('a', 1)]), ASK], first);
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(grandchildOf(dead.root, childIdOf(dead.parent, 'd')!)).toMatchObject({ status: 'awaiting_user', parkedQuestion: 'Which schema?' }), { timeout: 20_000 });
    const { root, image, child, grandchild } = await crashed(dead);

    const runner = fakeRunner({});
    const { parent, planner } = restarted(root, image, reports(8), runner);
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(planner.asked.join('\n')).toContain('Which schema?'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(workers(runner)).toEqual([]);
    expect(grandchildOf(root, child).runnerSessionId).toBe(grandchild);
    parent.destroy();
  });

  it('starts a grandchild over only when asked: a fresh retry takes the subtree, and what it spent stays spent', async () => {
    const { root, image, child, grandchild } = await midGrandchild(300_000);
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] });
    const { parent, planner } = restarted(root, image, [SUBMIT(NESTED), SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), ...reports(8)], runner);
    const ledger = await parent.ledger();
    const carves = vi.spyOn(ledger, 'carve');
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(workers(runner)).toEqual(['a', 'b']);
    // A new child is a new session: nothing of the old one rides along (ADR-0008).
    for (const request of planner.requests) expect(request.resume).toBeUndefined();
    expect(taskOf(parent, 'd').runnerSessionId).not.toBe(child);
    expect(grandchildOf(root, taskOf(parent, 'd').runnerSessionId!).runnerSessionId).not.toBe(grandchild);
    expect(carves.mock.calls.map(([, , request]) => request.tokens)).toEqual([2_000_000 - 300_000, 800_000]);
    expect(ledger.spentOn('root', 'd')).toBe(300_000);
    parent.destroy();
  });

  it('holds the tree\'s one Parallel limit as it goes on: no reopened level brings slots of its own', async () => {
    const { root, image } = await midGrandchild(0, [childTask('a', 1), childTask('b', 2, ['a']), childTask('e', 3, ['a'])]);
    const runner = fakeRunner({ b: ['b.txt'], e: ['e.txt'] }, { heldOnce: ['b', 'e'] });
    const { parent } = restarted(root, image, reports(8), runner, { parallel: 1 });
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(workers(runner).length).toBeGreaterThan(0), { timeout: 20_000 });
    await wait(150);
    expect(workers(runner)).toHaveLength(1);
    runner.release(workers(runner)[0]);
    await vi.waitFor(() => expect(workers(runner)).toHaveLength(2), { timeout: 20_000 });
    runner.release(workers(runner)[1]);
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('rebuilds a subplanner whose harness keeps no session from its transcript, its plan, the board and its references', async () => {
    const pin = (parent: Session) => parent.reading.post({ type: 'pin', title: 'Keep the v1 routes' });
    const { root, image } = await midGrandchild(0, undefined, { sessionless: true, before: pin });
    const read: string[] = [];
    const READING: Turn = async (tools, text) => {
      for (const task of ['board', 'a']) read.push((await tools.readTask!({ task }, { signal: SIGNAL })).text);
      await REPORT(tools, text);
    };
    const { parent, planner } = restarted(root, image, Array.from({ length: 8 }, () => READING), fakeRunner({ b: ['b.txt'] }), { sessionless: true });

    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.requests).toHaveLength(2);
    for (const request of planner.requests) {
      expect(request.resume).toBeUndefined();
      expect(request.priorHistory?.length).toBeGreaterThan(0);
      expect(request.initialMessage).toContain('pick it up');
      expect(request.initialMessage).toContain('Keep the v1 routes');
    }
    expect(planner.requests.map((request) => request.initialMessage).join('\n')).toContain('Write a');
    expect(read.join('\n')).toContain('Keep the v1 routes');
    expect(read.join('\n')).toContain('Done.');
    parent.destroy();
  });

  it('tells a grandchild\'s subplanner a pin once, though its message passes through every level', async () => {
    const { root, image } = await midGrandchild(0, undefined, { before: (parent) => parent.reading.post({ type: 'pin', title: 'Keep the v1 routes' }) });
    const { parent, planner } = restarted(root, image, reports(8), fakeRunner({ b: ['b.txt'] }));

    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    for (const request of planner.requests) expect(request.initialMessage?.split('Keep the v1 routes')).toHaveLength(2);
    parent.destroy();
  });

  it('leaves a grandchild it cannot reopen as it stands, and tells its subplanner why', async () => {
    const { root, image, child, grandchild } = await midGrandchild();
    const runner = fakeRunner({ b: ['b.txt'] });
    const { parent, planner } = restarted(root, image, [BLOCKED, ...reports(8)], runner);
    const saved = loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: child })!;
    Object.assign(saved.plan.tasks.find((t) => t.id === 'n')!, { assignedRunner: 'codex', runnerSessionOwner: 'claude-code' });
    saved.plan.runners = ['claude-code', 'codex'];
    saveChildSession(saved.plan, saved.meta.goal, { baseDir: root, rootSessionId: 'session-root', sessionId: child });

    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(planner.asked.join('\n')).toContain('its saved session belongs to claude-code'), { timeout: 20_000 });
    await vi.waitFor(() => expect(parent.isExecuting).toBe(false), { timeout: 20_000 });
    expect(workers(runner)).toEqual([]);
    expect(grandchildOf(root, child).runnerSessionId).toBe(grandchild);
    parent.destroy();
  });
});

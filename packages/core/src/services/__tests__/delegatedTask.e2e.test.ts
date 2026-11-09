/*
 * A delegated task end to end, on real repositories (ADR-0055): a root plan
 * hands a goal to a child plan, its landed work comes back through the delegated
 * task's branch, and only the root touches the user's branch.
 */

// Part of delegatedTask.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: delegatedTaskKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { Landing } from '../Landing';
import type { Session } from '../createSession';
import type { IRunner } from '../../interfaces/IRunner';
import type { PlannerToolHandler } from '../mcp';
import { createTask, type Task } from '../../models/Task';
import { FakeRunnerSession, patient, removeDir } from '../../testing';
import { closeSessions, type PlannerTurn as Turn } from './sessionTestKit';
import { git, roots, writingRunner, heldTasks, delegated, check, SUBMIT, childTask, NOTHING_THEN_BLOCKED, failingCheck, heldChecks, DONE, CALL_BLOCKED, tree, statusOf } from './delegatedTaskKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

describe('a delegated task', () => {
  it('plans and runs a child plan, and lands its work like any task', async () => {
    const { root, parent, planner } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), DONE]);
    const main = git(root, 'rev-parse', 'main');

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });

    // The subplanner got the goal, on its token's tools.
    expect(planner.requests[0].plannerTools).toMatchObject({ subplanner: true });
    expect(planner.asked[0]).toContain('Write a and b');
    // Its asker is a planner, which presses no control (ADR-0030).
    expect(planner.asked[0]).not.toContain('SURFACE AND SETTINGS:');
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(['README.md', 'a.txt', 'b.txt', 'tests/guard.txt']);
    expect(git(root, 'log', '-1', '--format=%s', integration)).toBe('Merge: Write a and b');
    // Only the root touches the user's branch.
    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ outcome: 'pass', reported: 'done' });
    parent.destroy();
  });

  it('runs while its sibling runs, its check after it, and only the root\'s Merge all reaches the user\'s branch', async () => {
    const held = heldTasks({ a: ['a.txt'], b: ['b.txt'], s: ['s.txt'] }, ['s']);
    const { root, parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), DONE], {
      runner: held.runner,
      tasks: [delegated(), createTask({ id: 's', order: 2, title: 'Sibling', prompt: 'sibling' }), check({ order: 3 })],
    });
    const main = git(root, 'rev-parse', 'main');

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toEqual(expect.arrayContaining(['s', 'a', 'b'])), { timeout: 20_000 });
    // The child finished beside a sibling that is still at work.
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(statusOf(parent, 's')).toBe('in_progress');
    held.release('s');
    await vi.waitFor(() => expect(parent.planTasks.map((t) => t.status)).toEqual(['completed', 'completed', 'completed']), { timeout: 20_000 });
    expect(held.runner.spawned.indexOf('c')).toBeGreaterThan(held.runner.spawned.indexOf('b'));

    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(await parent.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: true, payload: { kind: 'merge', result: { outcome: 'merged' } } });
    for (const file of ['a.txt', 'b.txt', 's.txt']) expect(existsSync(join(root, file))).toBe(true);
    parent.destroy();
  });

  it('holds no slot: a parent at its limit leaves room for the child it waits on (D18)', async () => {
    const held = heldTasks({ a: ['a.txt'], s: ['s.txt'] }, ['s']);
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], {
      runner: held.runner,
      parallel: 1,
      tasks: [delegated(), check(), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })],
    });

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('in_progress'));
    // The child's worktrees come first, which real git on a loaded Windows runner takes seconds over.
    await vi.waitFor(() => expect(held.runner.spawned).toContain('s'), { timeout: 30_000 });
    // A sibling holds the one slot, the delegated task runs beside it and holds none, and its subplanner's turn waits in the queue.
    held.release('s');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  }, patient(90_000));

  it('starts while its parent\'s only slot is held by nothing else, its child\'s tasks taking it one at a time', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), DONE], { parallel: 1 });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    // Two child tasks and a check, one after another, each on its own real worktree: a loaded Windows runner takes past twenty seconds.
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 60_000 });
    parent.destroy();
  }, patient(90_000));
});
describe('the verdict (ADR-0055 D6)', () => {
  const REPLIES: { text: string; isError?: boolean }[] = [];
  afterEach(() => { REPLIES.length = 0; });

  const CALL = (report: Parameters<NonNullable<PlannerToolHandler['taskComplete']>>[0]): Turn => async (tools) => {
    REPLIES.push(await tools.taskComplete!(report, { signal: new AbortController().signal }));
  };
  const SAYS_DONE = CALL({ status: 'done', summary: 'It is done.' });
  const NOTHING: Turn = async () => undefined;

  it('refuses a done while its plan still runs, naming what is unfinished, and leaves the attempt open', async () => {
    const held = heldTasks({ a: ['a.txt'] }, ['a']);
    const signal = new AbortController().signal;
    const EARLY: Turn = async (tools) => {
      await tools.submitPlan!({ tasks: [childTask('a', 1)] as never }, { signal });
      await tools.runPlan!({}, { signal });
      REPLIES.push(await tools.taskComplete!({ status: 'done', summary: 'It is done.' }, { signal }));
      held.release('a');
    };
    const { parent } = tree([EARLY, DONE], { runner: held.runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(REPLIES[0]).toMatchObject({ isError: true, text: expect.stringContaining('Not done yet: its run has not settled') });
    expect(REPLIES[0].text).toContain('"Write a" is in_progress');
    parent.destroy();
  });

  it('refuses a done with no plan, and takes the second turn\'s report', async () => {
    const { parent } = tree([SAYS_DONE, CALL({ status: 'blocked', summary: 'Nothing to do.', reason: 'The work is already there.' })]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(REPLIES[0]).toMatchObject({ isError: true, text: expect.stringContaining('the child plan holds no tasks') });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ outcome: 'fail', reported: 'blocked', reason: expect.stringContaining('The work is already there') });
    parent.destroy();
  });

  it('refuses a done from a child that changed nothing on the branch', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE, CALL({ status: 'blocked', summary: 'No change was needed.' })], { runner: writingRunner({}) });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(REPLIES[0]).toMatchObject({ isError: true, text: expect.stringContaining('has not changed since its base') });
    parent.destroy();
  });

  it('refuses a done from a child that skipped everything: skipped work can end a child, but never all of it', async () => {
    const signal = new AbortController().signal;
    const SKIP: Turn = async (tools) => { await tools.skipTask!({ task: 'a', reason: 'It cannot be done.' }, { signal }); };
    const inner = writingRunner({});
    const failing: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => session.reportComplete({ status: 'failed', summary: 'It failed.', reason: 'It failed.' }), 5);
        return session;
      }),
    };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), SKIP, SAYS_DONE, CALL({ status: 'blocked', summary: 'Nothing could be done.' })], { runner: failing });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(REPLIES[0]).toMatchObject({ isError: true, text: expect.stringContaining('no task of the child plan completed') });
    parent.destroy();
  });

  it('fails the verdict when the branch touched a protected path, naming it, and lands nothing', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE], { runner: writingRunner({ a: ['a.txt', 'tests/guard.txt'] }) });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(REPLIES[0].isError).toBeFalsy();
    const { verdict } = parent.planTasks.find((t) => t.id === 'd')!;
    expect(verdict).toMatchObject({ outcome: 'fail', reported: 'failed', reason: expect.stringContaining('tests/guard.txt') });
    expect(verdict?.reason).not.toContain('a.txt,');
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? 'main';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).not.toContain('a.txt');
    expect(statusOf(parent, 'c')).not.toBe('completed');
    parent.destroy();
  });

  it('reminds a subplanner once when a turn ends with nothing running, and fails it on the second, with a derived report', async () => {
    const { parent, planner } = tree([NOTHING, NOTHING]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(planner.asked).toHaveLength(2);
    expect(planner.asked[1]).toContain('A second turn that ends like this fails the delegated task');
    const task = parent.planTasks.find((t) => t.id === 'd')!;
    expect(task.verdict).toMatchObject({ outcome: 'fail', reported: 'failed', reason: expect.stringContaining('ended a second turn') });
    expect(task.handoff?.summary).toContain('ended a second turn');
    parent.destroy();
  });

  it('ends blocked, naming the level, for a budget that cannot be carved', async () => {
    const { parent } = tree([], { tasks: [delegated({ budget: { tokens: 9_000_000 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('Level 0 refused limits.tokens') });
    parent.destroy();
  });

  it('ends blocked where the build does not offer delegation, whatever the plan holds', async () => {
    const { parent } = tree([], { offered: false });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('delegation is off here') });
    parent.destroy();
  });

  it('never starts on a runner that drives no harness: an API planner cannot be delegated to (D5)', async () => {
    const runner = writingRunner({});
    const { parent, planner } = tree([], { runner, tasks: [delegated({ assignedRunner: 'cursor' }), check()], runners: ['claude-code', 'cursor'] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('pending'));
    expect(planner.asked).toEqual([]);
    expect(parent.escalations().map((e) => e.reason).join()).toContain('no structured connector');
    parent.destroy();
  });

  it('takes a read-only delegated task\'s report with no change, and lands nothing', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE], { runner: writingRunner({}), tasks: [delegated({ readOnly: true, protectedPaths: undefined }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? 'main';
    expect(git(root, 'rev-parse', integration)).toBe(git(root, 'rev-parse', 'main'));
    parent.destroy();
  });

  it('refuses an ops task in the child\'s plan as it is written, and the subplanner goes on', async () => {
    const refused: string[] = [];
    const OPS: Turn = async (tools) => {
      const reply = await tools.submitPlan!({ tasks: [{ ...childTask('o', 1), ops: true }] as never }, { signal: new AbortController().signal });
      if (reply.isError) refused.push(reply.text);
    };
    const { parent } = tree([OPS, CALL({ status: 'failed', summary: 'It needs an ops task.' })]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(refused[0]).toContain('none runs below the root');
    parent.destroy();
  });

});
describe('a question (ADR-0056 M8)', () => {
  const quiet = () => ({ signal: new AbortController().signal });
  const asks = (question: string, replies: { text: string; isError?: boolean }[] = []): Turn => async (tools) => { replies.push(await tools.checkpoint!({ question }, quiet())); };
  const awaiting = (session: Session, id: string) => session.planTasks.find((t) => t.id === id);

  it('answers at once and parks the subplanner, and the answer opens its next turn', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const heard: string[] = [];
    const HEAR = (turn: Turn): Turn => async (tools, text) => { heard.push(text); await turn(tools, text); };
    const { parent, planner } = tree([asks('Which one?', replies), HEAR(SUBMIT([childTask('a', 1)])), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(awaiting(parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' }), { timeout: 20_000 });
    expect(replies).toEqual([{ text: expect.stringContaining('End your turn') }]);

    const asked = parent.escalations().find((e) => e.kind === 'checkpoint');
    expect(asked?.reason).toContain('#1');
    expect(asked?.reason).toContain('Which one?');
    expect(await parent.answerEscalation(asked!.id, 'reject', 'Use the first.')).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(heard[0]).toContain('Use the first.');
    expect(planner.requests).toHaveLength(1);
    parent.destroy();
  });

  it('carries the words of an approval to the subplanner, where a question wants an answer and not a yes', async () => {
    const heard: string[] = [];
    const HEAR = (turn: Turn): Turn => async (tools, text) => { heard.push(text); await turn(tools, text); };
    const { parent } = tree([asks('Which rounding?'), HEAR(SUBMIT([childTask('a', 1)])), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(awaiting(parent, 'd')?.awaitingReason).toBe('checkpoint'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', reason: 'Round half away from zero.', raiseTokens: 100_000 }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(heard[0]).toContain('Round half away from zero.');
    expect(heard[0]).toContain('100000');
    expect(heard[0]).not.toContain('rejected');
    parent.destroy();
  });

  it('tells a subplanner its run merged into the delegated task\'s branch, never the user\'s', async () => {
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.asked[1]).toContain('merged into the delegated task\'s branch');
    parent.destroy();
  });

  it('takes one question at a time', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const { parent } = tree([async (tools) => {
      replies.push(await tools.checkpoint!({ question: 'First?' }, quiet()));
      replies.push(await tools.checkpoint!({ question: 'Second?' }, quiet()));
    }]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 20_000 });
    expect(replies[1]).toMatchObject({ isError: true });
    expect(parent.escalations().find((e) => e.kind === 'checkpoint')?.reason).toContain('First?');
    parent.destroy();
  });

  it('never reminds a subplanner that waits on its answer, and ends with its time when nobody answers', async () => {
    const { parent, planner } = tree([asks('Which one?')], { tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: 2500 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(awaiting(parent, 'd')?.awaitingReason).toBe('checkpoint'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(awaiting(parent, 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('ran out') });
    expect(planner.asked).toHaveLength(1);
    parent.destroy();
  });

  it('wakes an Act supervisor at the root, which answers it as any checkpoint', async () => {
    const { parent, planner } = tree([asks('Which one?'), SUBMIT([childTask('a', 1)]), DONE], { tokens: () => 5_000_000 });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(awaiting(parent, 'd')?.awaitingReason).toBe('checkpoint'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve' }, { kind: 'supervisor', level: 'act' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.asked[1]).toContain('approved');
    parent.destroy();
  });
});
describe('the merge hold (ADR-0055 D9)', () => {
  const readOnlyCheck = () => check({ taskMode: 'plan' });
  const changed = (root: string) => git(root, 'ls-tree', '-r', '--name-only', 'main').split('\n');

  /** A runner whose check waits until told how it ends. */
  function verdictOnCall() {
    const inner = writingRunner({ a: ['a.txt'], s: ['s.txt'] });
    const ends: Array<(pass: boolean) => void> = [];
    const runner: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        if (opts.taskId !== 'c') return inner.spawn(opts);
        const session = new FakeRunnerSession(`s-c-${ends.length}`, opts.taskId);
        ends.push((pass) => session.reportComplete(pass ? { status: 'done', summary: 'It holds.' } : { status: 'failed', summary: 'It does not.', reason: 'It does not.' }));
        return session;
      }),
    };
    return { runner, ends };
  }

  it('merges at the run\'s end once its check has passed, and not before', async () => {
    const { runner, ends } = verdictOnCall();
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: [delegated(), readOnlyCheck()], merges: true });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 20_000 });
    expect(changed(root)).not.toContain('a.txt');
    ends[0](true);
    await vi.waitFor(() => expect(changed(root)).toContain('a.txt'), { timeout: 20_000 });
    parent.destroy();
  });

  it('holds past a failed check, and the user\'s Skip lets the next tick merge', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()], merges: true });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    // By now the run has closed with its merge held: the Skip finds no run to end.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(changed(root)).not.toContain('a.txt');
    expect(await parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(changed(root)).toContain('a.txt'), { timeout: 20_000 });
    parent.destroy();
  });

  it('refuses a supervisor\'s Merge all naming the check, and leaves the user\'s, whose confirmation names it', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    const refused = await parent.execute({ command: 'merge_all' }, { kind: 'supervisor', level: 'act' });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('Check the subtree') });

    const mergeOffered = () => parent.escalations().flatMap((e) => e.options.filter((o) => o.id === 'merge-all').map((o) => ({ id: e.id, confirm: o.confirm })))[0];
    await vi.waitFor(() => expect(mergeOffered()).toBeDefined(), { timeout: 20_000 });
    const offered = mergeOffered();
    expect(offered.confirm).toContain('Check the subtree');
    expect(await parent.answerEscalation(offered.id, 'merge-all')).toMatchObject({ ok: false, message: expect.stringContaining('explicit yes') });
    expect(changed(root)).not.toContain('a.txt');
    expect(await parent.answerEscalation(offered.id, 'merge-all', undefined, true)).toMatchObject({ ok: true });
    expect(changed(root)).toContain('a.txt');
    parent.destroy();
  });

  it('asks the user\'s own Merge all to confirm first, naming the check, and merges once told to', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });

    const asked = await parent.execute({ command: 'merge_all' }, { kind: 'user' });
    expect(asked).toMatchObject({
      ok: false, outcome: 'refused',
      message: expect.stringContaining('This merges work no check has passed: #2 "Check the subtree" has not'),
      payload: { kind: 'merge_hold', checks: ['#2 "Check the subtree"'] },
    });
    expect(changed(root)).not.toContain('a.txt');

    expect(await parent.execute({ command: 'merge_all', pastChecks: true }, { kind: 'user' })).toMatchObject({ ok: true, payload: { kind: 'merge' } });
    expect(changed(root)).toContain('a.txt');
    parent.destroy();
  });

  it('never lets a supervisor or a planner past a check, whatever it carries', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'merge_all', pastChecks: true }, { kind: 'supervisor', level: 'act' })).toMatchObject({ ok: false, message: expect.stringContaining('Check the subtree') });
    expect(changed(root)).not.toContain('a.txt');
    parent.destroy();
  });

  it('is not held by a delegated task that has not landed: a sibling\'s work merges', async () => {
    const { root, parent } = tree([NOTHING_THEN_BLOCKED], {
      tasks: [delegated(), readOnlyCheck(), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })],
      runner: writingRunner({ s: ['s.txt'] }),
      merges: true,
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(changed(root)).toContain('s.txt'), { timeout: 20_000 });
    expect(statusOf(parent, 'd')).toBe('failed');
    parent.destroy();
  });

  it('is not held by a read-only delegated task, which lands nothing', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], {
      tasks: [delegated({ readOnly: true, protectedPaths: undefined }), check({ taskMode: 'plan', dependencies: ['d'] }), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })],
      runner: writingRunner({ s: ['s.txt'], c: [] }),
      merges: true,
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(changed(root)).toContain('s.txt'), { timeout: 20_000 });
    parent.destroy();
  });
});
describe('a delegated task started alone (ADR-0055 D8, D9)', () => {
  const readOnlyCheck = (over: Partial<Task> = {}) => check({ taskMode: 'plan', ...over });

  it('starts its check by itself, and closes its run only after it', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    expect(await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('does the same after a fresh retry', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), CALL_BLOCKED, SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).toBe('pending');
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('leaves a check that waits on more than its delegated task, and the run closes: nothing is moving towards it', async () => {
    const sibling = createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck({ dependencies: ['d', 's'] }), sibling] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    await vi.waitFor(() => expect(parent.isExecuting || parent.startsPending).toBe(false), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).toBe('pending');
    parent.destroy();
  });

  it('starts nothing after a Stop that comes as its work lands', async () => {
    const land = Landing.prototype.landPassed;
    const landing = vi.spyOn(Landing.prototype, 'landPassed').mockImplementation(async function (this: Landing, ...args) {
      const landed = await land.apply(this, args);
      if (args[0].id === 'd') parent.stopExecution();
      return landed;
    });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(landing.mock.calls.some(([task]) => task.id === 'd')).toBe(true), { timeout: 20_000 });
    await vi.waitFor(() => expect(parent.isExecuting || parent.startsPending).toBe(false), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).toBe('pending');
    landing.mockRestore();
    parent.destroy();
  });
});
describe('a new result is checked again (ADR-0055 D8)', () => {
  const readOnlyCheck = () => check({ taskMode: 'plan' });
  const task = (session: Session, id: string) => session.planTasks.find((t) => t.id === id);

  it('takes a passed check back with Mark not done, and its next run reads the new result', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE, SUBMIT([childTask('b', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    const first = task(parent, 'c')?.verdict;
    expect(await parent.execute({ command: 'mark_not_done', task: 'd', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(statusOf(parent, 'c')).toBe('pending');
    expect(task(parent, 'c')?.verdict).toBeUndefined();
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    // Its check is the one thing a retry outside a run starts beside what it names.
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    expect(task(parent, 'c')?.verdict?.decidedAt).not.toBe(first?.decidedAt);
    parent.destroy();
  });

  it('takes a check the user skipped back too: a Skip let one result past, not the next', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    await parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('skipped'));
    expect(await parent.execute({ command: 'mark_not_done', task: 'd', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(statusOf(parent, 'c')).toBe('pending');
    expect(task(parent, 'c')?.skipReason).toBeUndefined();
    parent.destroy();
  });

  it('takes a failed check back with a revert, and refuses a revert under a live one', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'revert_task', task: 'd', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(statusOf(parent, 'd')).toBe('pending');
    expect(statusOf(parent, 'c')).toBe('pending');
    parent.destroy();
  });

  it('refuses to take a live check back, naming it', async () => {
    const { runner, release } = heldChecks();
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('in_progress'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'mark_not_done', task: 'd', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: false });
    expect(statusOf(parent, 'c')).toBe('in_progress');
    await release();
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  /** The user forced the check past its failed task: a start of that task now is the one that can meet a live check. */
  async function failedWithItsCheckLive(turns: Turn[]) {
    const { runner, release } = heldChecks();
    const made = tree(turns, { runner, tasks: [delegated(), readOnlyCheck()] });
    await made.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(made.parent, 'd')).toBe('failed'), { timeout: 20_000 });
    await made.parent.execute({ command: 'force_start', task: 'c' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(made.parent, 'c')).toBe('in_progress'), { timeout: 20_000 });
    return { ...made, release };
  }

  it('refuses a retry under a live check, naming it', async () => {
    const { parent, release } = await failedWithItsCheckLive([NOTHING_THEN_BLOCKED]);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: false, message: expect.stringContaining('Check the subtree') });
    await release();
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('takes a check back at a force start\'s claim, which waits for a live one to end', async () => {
    const { parent, planner, release } = await failedWithItsCheckLive([NOTHING_THEN_BLOCKED, SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'force_start', task: 'd' }, { kind: 'user' });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(planner.requests).toHaveLength(1);
    await release();
    await vi.waitFor(() => expect(planner.requests).toHaveLength(2), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).not.toBe('completed');
    parent.destroy();
  });

  it('takes a check back at Execute\'s fresh chance, which never calls retry', async () => {
    const { parent, planner } = tree([NOTHING_THEN_BLOCKED, SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    await parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('skipped'));
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    expect(planner.requests).toHaveLength(2);
    parent.destroy();
  });
});

/*
 * A delegated task end to end, on real repositories (ADR-0055): a root plan
 * hands a goal to a child plan, its landed work comes back through the delegated
 * task's branch, and only the root touches the user's branch.
 */

// Part of delegatedTask.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: delegatedTaskKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import type { Session } from '../createSession';
import type { IFileSystem, OwnSealedRuns, ToolOutcome } from '../../interfaces/IFileSystem';
import { removeDir } from '../../testing';
import { closeSessions, fakeFs, type PlannerTurn as Turn } from './sessionTestKit';
import { roots, writingRunner, heldTasks, delegated, check, SUBMIT, childTask, NOTHING_THEN_BLOCKED, failingCheck, DONE, tree, statusOf } from './delegatedTaskKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

describe('a raise (ADR-0056 M5)', () => {
  const quiet = () => ({ signal: new AbortController().signal });
  const ASK: Turn = async (tools) => { await tools.checkpoint!({ question: 'I need 500000 more tokens.' }, quiet()); };
  const AWAIT: Turn = async () => undefined;
  const limitOf = async (session: Session, id: string) => {
    const tree = await session.ledger();
    return tree.numbers(tree.nodeOf(session.planState?.isolation?.run.tasks[id].childSession ?? '')!.path).limit;
  };
  const asking = (session: Session) => vi.waitFor(() => expect(session.planTasks.find((t) => t.id === 'd')?.awaitingReason).toBe('checkpoint'), { timeout: 20_000 });

  it('comes with an approval, from what the parent has left, and tells the subplanner', async () => {
    const { parent, planner } = tree([ASK, SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await asking(parent);
    expect(await limitOf(parent, 'd')).toBe(2_000_000);
    const answered = await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', raiseTokens: 500_000 }, { kind: 'user' });
    expect(answered).toMatchObject({ ok: true, message: expect.stringContaining('500000') });
    expect(await limitOf(parent, 'd')).toBe(2_500_000);
    await vi.waitFor(() => expect(planner.asked[1]).toContain('500000'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('is the same on the inbox\'s Approve', async () => {
    const { parent } = tree([ASK]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await asking(parent);
    const asked = parent.escalations().find((e) => e.kind === 'checkpoint')!;
    expect(await parent.answerEscalation(asked.id, 'approve', undefined, false, 300_000)).toMatchObject({ ok: true });
    expect(await limitOf(parent, 'd')).toBe(2_300_000);
    parent.destroy();
  });

  it('is refused past what the parent has left, and the question still waits', async () => {
    const { parent } = tree([ASK], { tokens: () => 2_100_000 });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await asking(parent);
    const answered = await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', raiseTokens: 500_000 }, { kind: 'user' });
    expect(answered).toMatchObject({ ok: false, message: expect.stringContaining('refused this raise') });
    expect(await limitOf(parent, 'd')).toBe(2_000_000);
    expect(parent.awaitsCheckpoint('d')).toBe(true);
    parent.destroy();
  });

  it('goes only with an approval, and only to a delegated task', async () => {
    const { parent } = tree([ASK]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await asking(parent);
    expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'reject', reason: 'no', raiseTokens: 500_000 }, { kind: 'user' })).toMatchObject({ ok: false, message: expect.stringContaining('approval') });
    expect(parent.awaitsCheckpoint('d')).toBe(true);
    parent.destroy();
  });

  describe('a child its budget stops while its question waits', () => {
    const stopped = async (session: Session) => {
      const tree = await session.ledger();
      tree.nodeOf(session.planState?.isolation?.run.tasks.d.childSession ?? '')!.stop('Level 1 refused this turn: a turn here needs 200000 tokens to start, and 14810 are left.');
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };

    it('keeps waiting, since the answer is what can give it room, and a raise carries it on', async () => {
      const { parent } = tree([ASK, SUBMIT([childTask('a', 1)]), DONE]);
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      await stopped(parent);
      expect(parent.awaitsCheckpoint('d')).toBe(true);
      expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', raiseTokens: 500_000 }, { kind: 'user' })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
      parent.destroy();
    });

    it('tells the plan above that a child with everything finished owes only its report, and a Continue is what keeps its work', async () => {
      const { parent } = tree([SUBMIT([childTask('a', 1)]), ASK, AWAIT]);
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      await stopped(parent);
      await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve' }, { kind: 'user' });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
      const reason = parent.planTasks.find((t) => t.id === 'd')?.verdict?.reason ?? '';
      expect(reason).toContain('only its report is missing');
      expect(reason).toContain('Continue');
      expect(reason).not.toContain('..');
      parent.destroy();
    });

    it('ends blocked once an answer brings no room', async () => {
      const { parent } = tree([ASK, AWAIT]);
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      await stopped(parent);
      await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve' }, { kind: 'user' });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
      expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('refused this turn') });
      parent.destroy();
    });
  });

  describe('a start its budget refuses', () => {
    /** One tenth of a session past the reserve its subplanner keeps: a turn can start, and a task cannot. */
    const small = () => [delegated({ budget: { tokens: 220_000 } }), check()];

    it('wakes the subplanner, and a raise starts its run again', async () => {
      const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), ASK, AWAIT, DONE], { tasks: small(), runner: writingRunner({ a: ['a.txt'] }) });
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      expect(planner.asked[1]).toContain('could not start');
      expect(planner.asked[1]).not.toContain('are left..');
      expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', raiseTokens: 500_000 }, { kind: 'user' })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
      parent.destroy();
    });

    it('ends blocked when the subplanner\'s turn ends with no question, without a reminder', async () => {
      const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), AWAIT], { tasks: small() });
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
      expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('needs 200000 tokens') });
      expect(planner.asked).toHaveLength(2);
      parent.destroy();
    });

    it('ends blocked when the answer brings no room', async () => {
      const { parent } = tree([SUBMIT([childTask('a', 1)]), ASK, AWAIT], { tasks: small() });
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'reject', reason: 'None left.' }, { kind: 'user' });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
      expect(parent.planTasks.find((t) => t.id === 'd')?.verdict?.reported).toBe('blocked');
      parent.destroy();
    });
  });
});
describe('outward effects (ADR-0056 M9)', () => {
  function sealedFs() {
    const ran: { script: string; cwd: string }[] = [];
    const run = async (script: string, cwd: string): Promise<ToolOutcome> => {
      ran.push({ script, cwd });
      const result = spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8' });
      return { success: result.status === 0, output: `${result.stdout}${result.stderr}`, truncated: false };
    };
    const fsAdapter: IFileSystem = {
      ...fakeFs(),
      canSeal: async () => true,
      taskShell: ({ cwd, writable, worktrees }) => ({
        run: () => Promise.reject(new Error('a script runs through hold')),
        hold: <T>(work: (runs: OwnSealedRuns) => Promise<T>) => work({ worktrees: worktrees?.length ? worktrees : [writable ?? cwd], touched: false, scratch: '', run }),
        end: () => undefined,
      }),
    };
    return { fsAdapter, ran };
  }
  const script = (commands: string[][]) => ({ id: 't', order: 2, title: 'Test it', description: 'test', type: 'script', sliceType: 'AFK', commands, dependencies: ['a'] });
  const effectGranted = () => [delegated({ grants: ['effect'] }), check()];

  it('runs a body the rules cover at every level in the child\'s checkout, with `effect`', async () => {
    const { fsAdapter, ran } = sealedFs();
    const { parent } = tree([SUBMIT([childTask('a', 1), script([['cat', 'a.txt']])]), DONE], { fsAdapter, tasks: effectGranted(), config: { effectAllowlist: ['cat a.txt'] } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(ran).toHaveLength(0);
    parent.destroy();
  });

  it('seals a body the rules do not cover, `effect` or no', async () => {
    const { fsAdapter, ran } = sealedFs();
    const { parent } = tree([SUBMIT([childTask('a', 1), script([['ls']])]), DONE], { fsAdapter, tasks: effectGranted(), config: { effectAllowlist: ['cat a.txt'] } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(ran).toHaveLength(1);
    parent.destroy();
  });

  it('refuses an edit that moves a covered body past the rules', async () => {
    const { fsAdapter } = sealedFs();
    const replies: { text: string; isError?: boolean }[] = [];
    const quiet = { signal: new AbortController().signal };
    const SUBMIT_THEN_EDIT: Turn = async (tools, text) => {
      await SUBMIT([childTask('a', 1), script([['cat', 'a.txt']])])(tools, text);
      replies.push(await tools.editPlan!({ ops: [{ op: 'update', taskId: 't', changes: { commands: [['ls']] } }] } as never, quiet));
      await tools.taskComplete!({ status: 'blocked', summary: 'Stopping here.', reason: 'Stopping here.' }, quiet);
    };
    const { parent } = tree([SUBMIT_THEN_EDIT], { fsAdapter, tasks: effectGranted(), config: { effectAllowlist: ['cat a.txt'] } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(replies).toHaveLength(1), { timeout: 20_000 });
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringContaining('effect rules') });
    parent.destroy();
  });

  it('seals a script a subplanner adds with run_script, with no `effect`', async () => {
    const { fsAdapter, ran } = sealedFs();
    const RUN: Turn = async (tools) => {
      await tools.runScript!({ title: 'Look', commands: [['ls']] } as never, { signal: new AbortController().signal });
    };
    const { parent } = tree([RUN, NOTHING_THEN_BLOCKED], { fsAdapter });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 20_000 });
    parent.destroy();
  });

  it('refuses a child\'s script where nothing can seal it', async () => {
    const refused: string[] = [];
    const TRY: Turn = async (tools) => {
      const reply = await tools.submitPlan!({ tasks: [childTask('a', 1), script([['ls']])] as never }, { signal: new AbortController().signal });
      refused.push(reply.text);
    };
    const { parent } = tree([TRY, NOTHING_THEN_BLOCKED]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(refused).toHaveLength(1), { timeout: 20_000 });
    expect(refused[0]).toContain('no sandbox to seal');
    parent.destroy();
  });
});
describe('what a model may not do to a check (ADR-0055 D8)', () => {
  it('refuses a supervisor\'s skip of a failed check, and leaves the user\'s', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), check({ taskMode: 'plan' })] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    const refused = await parent.execute({ command: 'skip_task', task: 'c', reason: 'it is fine' }, { kind: 'supervisor', level: 'act' });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('a model does not skip it') });
    expect(await parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' })).toMatchObject({ ok: true });
    parent.destroy();
  });
});
describe('a Stop', () => {
  it('ends a child\'s run with its parent\'s, and leaves nothing running', async () => {
    const held = heldTasks({ a: ['a.txt'] }, ['a']);
    const { parent } = tree([SUBMIT([childTask('a', 1)])], { runner: held.runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toContain('a'));
    parent.stopExecution();
    await vi.waitFor(() => expect(held.stopped).toContain('a'));
    expect(parent.isExecuting).toBe(false);
    parent.destroy();
  });
});
describe('a budget', () => {
  it('ends a child blocked when it runs out, with a report nobody wrote', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)])], {
      runner: writingRunner({ a: ['a.txt'] }, { usage: 3_000_000 }),
      tasks: [delegated({ budget: { tokens: 400_000 } }), check()],
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked' });
    parent.destroy();
  });
});

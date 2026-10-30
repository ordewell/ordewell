import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushMicrotasks } from '../../testing';
import { taskOf, testWorkspace } from './sessionTestKit';
import { ctx, NOW, plan, prose, settled, supervised, task, until, type Env, type Options } from './supervisorTestKit';

/**
 * Approval is of a task the user saw (ADR-0029): it lasts while the task stays
 * in the plan, and goes with it when it leaves. A planner that removes a task
 * and later writes a new one under the same id gets a task nobody approved.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const FULL: Options = { settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: true }, plan: { status: 'draft' } };
const GUARDED: Options = { ...FULL, config: { autonomousMode: false } };

const answer = (result: { text: string }) => JSON.parse(result.text) as { result?: string; reason?: string };
const cards = (env: Env) => env.messages.flatMap((m) => (m.type === 'approval_request' && m.kind === 'task_start' ? [m] : []));

/** One user turn: `act` runs inside it with the planner's tools, then the planner replies. */
async function turn(env: Env, message: string, act: () => Promise<void>): Promise<void> {
  const before = env.planner.calls.length;
  void env.session.continueConversation(message);
  await until(() => env.planner.calls.length === before + 1);
  await act();
  env.planner.calls[before].finish(prose('Done.'));
  await settled();
}

/** The user executed t1 and t2, stopped the run, and the planner then removed t1. */
async function removedAfterApproval(options: Options): Promise<Env> {
  const env = await supervised([task('t1', 1), task('t2', 2)], options);
  await until(() => env.run.spawnedIds().includes('t1'));
  env.session.stopExecution();
  await settled();
  await turn(env, 'drop the limiter', async () => {
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'remove', taskId: 't1' }] }, ctx);
    expect(edit.isError).toBeFalsy();
  });
  expect(taskOf(env.session, 't1')).toBeUndefined();
  return env;
}

/** A whole plan that brings back the id t1 as a different task: an ops task with a prompt the user never saw. */
async function readdedAsOps(env: Env): Promise<void> {
  await turn(env, 'plan it again', async () => {
    const submitted = await env.planner.tools().submitPlan!({ tasks: [
      { id: 't1', title: 'Deploy', description: 'deploy', prompt: 'deploy to production', ops: true, assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK' },
      { id: 't2', title: 'Task t2', description: 'd', prompt: 'do t2', assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK' },
    ] }, ctx);
    expect(submitted.isError).toBeFalsy();
  });
  expect(taskOf(env.session, 't1')!.prompt).toBe('deploy to production');
}

describe('a task removed after the user approved it', () => {
  it('takes its approval with it: a new task under the same id is refused as unapproved in Full', async () => {
    const env = await removedAfterApproval(FULL);
    expect(env.session.isApproved('t2')).toBe(true);
    await readdedAsOps(env);

    let start: { text: string; isError?: boolean } | undefined;
    await turn(env, 'run t1', async () => { start = await env.planner.tools().runTask!({ task: 't1' }, ctx); });

    expect(start!.isError).toBe(true);
    expect(answer(start!).reason).toBe('Task #1 "Deploy" was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.');
    expect(env.session.isApproved('t1')).toBe(false);
    expect(env.session.isApproved('t2')).toBe(true);
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(1);
  });

  it('in Guarded, a start of the new task asks on the card, naming it, instead of starting', async () => {
    const env = await removedAfterApproval(GUARDED);
    await readdedAsOps(env);

    void env.session.continueConversation('run t1');
    await until(() => env.planner.calls.length === 3);
    const start = env.planner.tools().runTask!({ task: 't1' }, ctx);
    await until(() => cards(env).length === 1);

    expect(cards(env)[0]).toMatchObject({
      subject: 'Start task #1 "Deploy"',
      detail: expect.stringContaining('Allowing approves task #1 "Deploy", added since you approved the plan.'),
    });
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(1);
    env.session.resolveApproval(cards(env)[0].id, false);
    expect(answer(await start).result).toBeUndefined();
    expect(env.session.isApproved('t1')).toBe(false);
  });
});

describe('approval through a rewrite', () => {
  it('stays on a task a whole-plan rewrite keeps, and the rewrite\'s new task waits for the user', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], FULL);
    await until(() => env.run.spawnedIds().includes('t1'));
    env.session.stopExecution();
    await settled();

    await turn(env, 'add a cache', async () => {
      const submitted = await env.planner.tools().submitPlan!({ tasks: [
        { id: 't1', title: 'Task t1', description: 'd', prompt: 'do t1', assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK' },
        { id: 't2', title: 'Task t2', description: 'd', prompt: 'do t2', assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK' },
        { id: 't3', title: 'Add a cache', description: 'd', prompt: 'add a cache', assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK' },
      ] }, ctx);
      expect(submitted.isError).toBeFalsy();
    });

    expect(env.session.isApproved('t1')).toBe(true);
    expect(env.session.isApproved('t2')).toBe(true);
    expect(env.session.isApproved('t3')).toBe(false);
  });

  it('a merge revokes the merged tasks, and the merged task waits for the user', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2), task('t3', 3)], FULL);
    await until(() => env.run.spawnedIds().includes('t1'));
    env.session.stopExecution();
    await settled();

    await turn(env, 'merge the first two', async () => {
      const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'merge', taskIds: ['t1', 't2'], merged: { title: 'Both at once', prompt: 'do t1 and t2' } }] }, ctx);
      expect(edit.isError).toBeFalsy();
    });

    const merged = env.session.planTasks.find((t) => t.title === 'Both at once')!;
    expect(env.session.planState!.approvedTasks).toEqual(['t3']);
    expect(env.session.isApproved(merged.id)).toBe(false);
  });

  it('a split revokes the split task, and its parts wait for the user', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], FULL);
    await until(() => env.run.spawnedIds().includes('t1'));
    env.session.stopExecution();
    await settled();

    await turn(env, 'split the first', async () => {
      const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'split', taskId: 't1', parts: [{ title: 'First half', prompt: 'half one' }, { title: 'Second half', prompt: 'half two' }] }] }, ctx);
      expect(edit.isError).toBeFalsy();
    });

    const parts = env.session.planTasks.filter((t) => t.title.endsWith('half'));
    expect(parts).toHaveLength(2);
    expect(env.session.planState!.approvedTasks).toEqual(['t2']);
    for (const part of parts) expect(env.session.isApproved(part.id)).toBe(false);
  });
});

describe('the Guarded card', () => {
  it('approves exactly the tasks it names: a manual task the same edit adds stays unapproved', async () => {
    const env = await supervised([task('t1', 1)], GUARDED);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();

    void env.session.continueConversation('add a cache and a check, and run them');
    await until(() => env.planner.calls.length === 1);
    const edit = await env.planner.tools().editPlan!({ ops: [
      { op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } },
      { op: 'add', task: { title: 'Check by hand', type: 'user', sliceType: 'HITL', userSteps: [{ order: 1, instruction: 'look at it' }] } },
    ] }, ctx);
    expect(edit.isError).toBeFalsy();
    // The edit is in the plan as its call answers (ADR-0022 P2), so the start asks at once.
    const pending = env.planner.tools().runPlan!({}, ctx);
    await until(() => cards(env).length === 1);
    expect(cards(env)[0].detail).toContain('Allowing approves task #2 "Add a cache", added since you approved the plan, and starts it with the rest.');

    env.session.resolveApproval(cards(env)[0].id, true);
    expect((await pending).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Added both.'));
    const cache = env.session.planTasks.find((t) => t.title === 'Add a cache')!.id;
    await until(() => env.run.spawnedIds().includes(cache));

    expect(env.session.planState!.approvedTasks).toEqual(['t1', cache]);
  });
});

describe('a session saved by an older version', () => {
  it('loads with its approvals: a plan executed before the approval record existed, and one with the record', async () => {
    const legacy = await supervised([task('t1', 1), task('t2', 2)], { ...FULL, plan: { status: 'approved' }, execute: false });
    expect(legacy.session.isApproved('t1')).toBe(true);
    expect(legacy.session.isApproved('t2')).toBe(true);

    const recorded = await supervised([task('t1', 1), task('t2', 2)], { ...FULL, plan: { status: 'draft', approved: true, approvedTasks: ['t1', 'gone'] }, execute: false });
    expect(recorded.session.isApproved('t1')).toBe(true);
    expect(recorded.session.isApproved('t2')).toBe(false);
    // An id whose task left before the save is not carried, so no later task can take it up.
    expect(recorded.session.planState!.approvedTasks).toEqual(['t1']);
  });
});

describe('a withdrawal reaches the surfaces', () => {
  const lastStatus = (env: Env, id: string) => {
    const status = env.messages.filter((m): m is Extract<typeof m, { type: 'status_update' }> => m.type === 'status_update').at(-1);
    return status?.tasks.find((t) => t.id === id);
  };

  it('as a plan update and a status that shows the task waiting, when an edit lifts research', async () => {
    const scout = task('r', 2, { research: true, taskMode: 'plan' });
    const env = await supervised([task('t1', 1), scout], {
      execute: false,
      plan: { approved: true, approvedTasks: ['t1', 'r'], researchApprovals: ['r'] },
    });
    expect(env.session.isApproved('r')).toBe(true);
    env.messages.length = 0;

    await env.session.updateTask('r', { research: false });

    expect(env.session.isApproved('r')).toBe(false);
    expect(env.session.isApproved('t1')).toBe(true);
    // What it waits on now is another wait, with its own escalation id (ADR-0053).
    expect(taskOf(env.session, 'r')?.waitsEnded).toBe(1);
    expect(taskOf(env.session, 't1')?.waitsEnded).toBeUndefined();
    expect(env.messages.some((m) => m.type === 'plan_generated')).toBe(true);
    expect(lastStatus(env, 'r')?.waitsForApproval).toBe(true);
    expect(lastStatus(env, 't1')?.waitsForApproval).toBeUndefined();
  });

  it('on its own, when the tree changed on a route that announces nothing of the plan', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { execute: false, plan: { approved: true, approvedTasks: ['t1', 't2'] } });
    env.messages.length = 0;

    // A plan reloaded without t2: nothing announces the plan here.
    env.session.loadPlan(plan([task('t1', 1)], { approved: true, approvedTasks: ['t1', 't2'] }), 'build it', testWorkspace);
    await flushMicrotasks();

    expect(env.messages.filter((m) => m.type === 'plan_generated')).toHaveLength(1);
    expect(env.session.isApproved('t2')).toBe(false);
  });

  it('is not saved by a save: persisting alone changes no approval', async () => {
    const env = await supervised([task('t1', 1)], { execute: false, plan: { approved: true, approvedTasks: ['t1'] } });
    await env.session.updateTask('t1', { title: 'renamed' });
    expect(env.session.isApproved('t1')).toBe(true);
  });
});

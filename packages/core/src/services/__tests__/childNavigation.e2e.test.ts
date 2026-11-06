/*
 * Reaching into a delegated tree from a surface (ADR-0055 D20), on real
 * repositories: any child plan selected by its stable id, watched as it runs,
 * and spoken to under the mandate it already holds.
 */

// Part of childNavigation.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: childNavigationKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { ChildFrame } from '../ChildDirectory';
import { createTask, flattenTasks } from '../../models/Task';
import { removeDir } from '../../testing';
import { loadSession, saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { closeSessions, makeSession, type PlannerTurn as Turn } from './sessionTestKit';
import { roots, heldTasks, isolation, planOf, delegated, childTask, nestedTask, nestedCheck, SUBMIT, DONE, REPLY, tree, WAIT, deferred, type TreeOptions } from './childNavigationKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

describe('selecting a child plan', () => {
  it('lists every plan below the root, at any depth, by ids that hold still', async () => {
    const { runner, release } = heldTasks(['a']);
    const { parent } = tree({ d: [SUBMIT([nestedTask('n', 1), nestedCheck('c', 2, 'n')]), DONE], n: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);

    const entries = await parent.children.list();
    const top = entries.find((entry) => entry.parent === 'session-root');
    const nested = entries.find((entry) => entry.parent === top?.sessionId);
    expect(entries).toHaveLength(2);
    expect(top).toMatchObject({ taskId: 'd', title: 'Delegated subtree', depth: 1, node: 'root/1', state: 'parked' });
    expect(nested).toMatchObject({ taskId: 'n', title: 'Nested n', depth: 2, node: 'root/1/1', state: 'parked' });
    expect(top?.sessionId).toBe(parent.planTasks[0].runnerSessionId);

    release('a');
    parent.destroy();
  });

  it('shows a selected child its own plan and the conversation that made it, not its parent\'s', async () => {
    const { runner, release } = heldTasks(['a']);
    const { parent } = tree({ d: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);

    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    const view = child!.view();
    expect(view.goal).toContain('Write a');
    expect(view.plan?.tasks.map((task) => task.title)).toEqual(['Write a']);
    expect(view.run.tasks.map((task) => [task.id, task.status])).toEqual([['a', 'in_progress']]);
    expect(view.child).toMatchObject({ taskId: 'd', state: 'parked' });

    release('a');
    parent.destroy();
  });

  it('reads an ended child from its saved file by the id it always had', async () => {
    const { runner } = heldTasks([]);
    const { parent } = tree({ d: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('completed'), WAIT);
    const [entry] = await parent.children.list();
    await vi.waitFor(async () => expect((await parent.children.list())[0].state).toBe('ended'), WAIT);

    const view = (await parent.children.find(entry.sessionId))!.view();
    expect(view.child).toMatchObject({ sessionId: entry.sessionId, title: 'Delegated subtree', state: 'ended' });
    expect(view.goal).toContain('Write a');
    expect(view.run.tasks.map((task) => [task.id, task.status])).toEqual([['a', 'completed']]);
    parent.destroy();
  });

  it('names nothing outside its tree, so nothing outside it is read', async () => {
    const { runner, release } = heldTasks(['a']);
    const { parent, root } = tree({ d: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });
    saveSession(planOf([createTask({ id: 'other', order: 1, title: 'Another session' })]), 'another goal', root, 'session-other');

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);

    for (const id of ['session-other', 'session-root', '../session-other', 'root/1', '']) expect(await parent.children.find(id)).toBeNull();

    release('a');
    parent.destroy();
  });

  it('answers a session that never delegated with an empty tree, and opens no ledger for it', async () => {
    const { runner } = heldTasks([]);
    const { parent } = tree({}, { runner, tasks: [createTask({ id: 't', order: 1, title: 'Plain' })] });

    expect(await parent.children.list()).toEqual([]);
    expect(await parent.children.find('anything')).toBeNull();
    parent.destroy();
  });

  it('finds no tree in a plan that has not run, and leaves none by looking', async () => {
    const { runner } = heldTasks([]);
    const { parent, root } = tree({ d: [] }, { runner });

    expect(await parent.children.list()).toEqual([]);
    expect(await parent.children.find('anything')).toBeNull();

    await new Promise((settle) => setTimeout(settle, 100));
    expect(readdirSync(join(root, '.ordewell'), { recursive: true }).filter((file) => String(file).endsWith('tree-events.jsonl'))).toEqual([]);
    parent.destroy();
  });

  it('keeps the child a fresh retry let go, ended and readable, beside the one that took over', async () => {
    const { runner, release } = heldTasks(['a']);
    const { parent } = tree({ d: [SUBMIT([childTask('a', 1)]), SUBMIT([childTask('a', 1)]), DONE] }, { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);
    const [first] = await parent.children.list();
    await parent.execute({ command: 'stop_run' }, { kind: 'user' });
    await vi.waitFor(() => expect(parent.planTasks[0].status).not.toBe('in_progress'), WAIT);

    await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a', 'a']), WAIT);

    const [before, after] = await parent.children.list();
    expect(before).toMatchObject({ sessionId: first.sessionId, node: first.node, state: 'ended' });
    expect(after).toMatchObject({ taskId: 'd', state: 'parked' });
    expect(after.sessionId).not.toBe(first.sessionId);
    const old = (await parent.children.find(first.sessionId))!;
    expect(old.view().plan?.tasks.map((task) => task.title)).toEqual(['Write a']);
    expect(old.message('and you?')).toMatchObject({ ok: false, code: 'view_only' });
    expect(old.message('and you?')).not.toMatchObject({ message: expect.stringContaining('Continue') });
    await expect(old.control('a', { kind: 'message', text: 'and you?' })).resolves.not.toMatchObject({ message: expect.stringContaining('Continue') });
    release('a');
    parent.destroy();
  });

  it('still tells a person to Continue the task of a child that task still names', async () => {
    const { runner, release } = heldTasks(['a']);
    const { parent } = tree({ d: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);
    const [first] = await parent.children.list();
    await parent.execute({ command: 'stop_run' }, { kind: 'user' });
    await vi.waitFor(() => expect(parent.planTasks[0].status).not.toBe('in_progress'), WAIT);

    const ended = (await parent.children.find(first.sessionId))!;
    await vi.waitFor(() => expect(ended.entry().state).toBe('ended'), WAIT);
    expect(ended.message('and you?')).toMatchObject({ ok: false, code: 'view_only', message: expect.stringContaining('Continue its task') });
    release('a');
    parent.destroy();
  });

  it('after a restart, still lists a child no task names any more, from the tree\'s own log', async () => {
    const { runner } = heldTasks(['a']);
    const { parent, root } = tree({ d: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);
    const [first] = await parent.children.list();
    await parent.execute({ command: 'stop_run' }, { kind: 'user' });
    await vi.waitFor(() => expect(parent.planTasks[0].status).not.toBe('in_progress'), WAIT);
    await parent.discardChild(parent.planTasks[0]);
    parent.destroy();
    await parent.gone;

    const reopened = makeSession({
      runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000 } }), delegationOffered: true,
    });
    const saved = loadSession('session-root', root);
    reopened.loadPlan(saved!.plan, saved!.meta.goal, root, { sessionId: 'session-root', persist: false });

    expect((await reopened.children.list()).map((entry) => [entry.sessionId, entry.state])).toEqual([[first.sessionId, 'ended']]);
    reopened.destroy();
  });

  it('after a restart, shows every child of the tree as ended, nothing reseated by reading it', async () => {
    const { runner, release } = heldTasks(['a']);
    const { parent, root } = tree({ d: [SUBMIT([nestedTask('n', 1), nestedCheck('c', 2, 'n')]), DONE], n: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);
    const before = await parent.children.list();
    const nestedId = before.find((entry) => entry.depth === 2)!.sessionId;
    parent.destroy();
    await parent.gone;
    release('a');

    const reopened = makeSession({
      runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000 } }), delegationOffered: true,
    });
    const saved = loadSession('session-root', root);
    reopened.loadPlan(saved!.plan, saved!.meta.goal, root, { sessionId: 'session-root', persist: false });

    const after = await reopened.children.list();
    expect(after.map((entry) => [entry.sessionId, entry.node, entry.state])).toEqual(before.map((entry) => [entry.sessionId, entry.node, 'ended']));
    const nested = await reopened.children.find(nestedId);
    expect(nested!.view().plan?.tasks.map((task) => task.title)).toEqual(['Write a']);
    expect(runner.spawned).toEqual(['a']);
    reopened.destroy();
  });
});
describe('watching a child plan', () => {
  it('streams a nested child\'s own frames to whoever selected it, and to nobody who did not', async () => {
    const { runner, release } = heldTasks(['a']);
    const { parent, frames } = tree({
      d: [SUBMIT([nestedTask('n', 1), nestedCheck('c', 2, 'n')]), DONE],
      n: [SUBMIT([childTask('a', 1)]), DONE],
    }, { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);

    const entries = await parent.children.list();
    const nested = await parent.children.find(entries.find((entry) => entry.depth === 2)!.sessionId);
    const top = await parent.children.find(entries.find((entry) => entry.depth === 1)!.sessionId);
    const nestedFrames: ChildFrame[] = [];
    const topFrames: ChildFrame[] = [];
    const stopNested = nested!.watch((frame) => nestedFrames.push(frame));
    top!.watch((frame) => topFrames.push(frame));

    release('a');
    await vi.waitFor(() => expect(nestedFrames.some((frame) => frame.type === 'task_log' && frame.taskId === 'a')).toBe(true), WAIT);
    expect(topFrames.some((frame) => frame.type === 'task_log' && frame.taskId === 'a')).toBe(false);
    expect(frames.some((frame) => frame.type === 'task_log' && frame.taskId === 'a')).toBe(false);

    stopNested();
    const counted = nestedFrames.length;
    await vi.waitFor(() => expect(flattenTasks(parent.planTasks)[0].status).not.toBe('running'), WAIT);
    expect(nestedFrames).toHaveLength(counted);
    parent.destroy();
  });
});
describe('speaking to a child plan', () => {

  async function parkedOn(held: string[], turns: Record<string, Turn[]>, options: Partial<TreeOptions> = {}) {
    const { runner, release } = heldTasks(held);
    const built = tree(turns, { runner, ...options });
    await built.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(held), WAIT);
    return { ...built, runner, release };
  }

  it('opens a turn of a parked subplanner with the person\'s words, which go no higher', async () => {
    const { parent, planners, frames, release } = await parkedOn(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);

    expect(child!.message('use the blue one')).toEqual({ ok: true, status: 'woken' });

    await vi.waitFor(() => expect(planners.d.asked.at(-1)).toContain('use the blue one'), WAIT);
    expect(planners.d.asked.at(-1)).toMatch(/person/i);
    expect(frames.some((frame) => JSON.stringify(frame).includes('use the blue one'))).toBe(false);

    release('a');
    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('completed'), WAIT);
    parent.destroy();
  });

  it('shows the words as they were written in the child\'s own conversation', async () => {
    const { parent, release } = await parkedOn(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);
    const started: ChildFrame[] = [];
    child!.watch((frame) => { if (frame.type === 'planner_turn_started') started.push(frame); });

    child!.message('use the blue one');

    await vi.waitFor(() => expect(started).toHaveLength(1), WAIT);
    expect(started[0]).toMatchObject({ prompt: 'use the blue one' });
    release('a');
    parent.destroy();
  });

  it('queues while the tree has no slot, and wakes when one frees', async () => {
    const { parent, planners, release } = await parkedOn(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] }, { parallel: 1 });
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);
    const turnsBefore = planners.d.asked.length;

    expect(child!.message('use the blue one')).toEqual({ ok: true, status: 'queued' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(planners.d.asked).toHaveLength(turnsBefore);

    release('a');
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('use the blue one'), WAIT);
    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('completed'), WAIT);
    parent.destroy();
  });

  it('takes messages to two children one slot at a time, each in its own turn', async () => {
    const twoTasks = [delegated({ id: 'x', order: 1, goal: 'Write x' }), delegated({ id: 'y', order: 2, goal: 'Write y' })];
    const { parent, planners, release } = await parkedOn(['p', 'q'], {
      x: [SUBMIT([childTask('p', 1)]), REPLY, DONE],
      y: [SUBMIT([childTask('q', 1)]), REPLY, DONE],
    }, { tasks: twoTasks, parallel: 2 });
    const entries = await parent.children.list();
    const byTask = async (taskId: string) => (await parent.children.find(entries.find((entry) => entry.taskId === taskId)!.sessionId))!;
    const [x, y] = [await byTask('x'), await byTask('y')];
    await vi.waitFor(() => { expect(x.entry().state).toBe('parked'); expect(y.entry().state).toBe('parked'); }, WAIT);

    expect(x.message('to x').ok && y.message('to y').ok).toBe(true);
    release('p');

    await vi.waitFor(() => expect(planners.x.asked.join('\n')).toContain('to x'), WAIT);
    expect(planners.y.asked.join('\n')).not.toContain('to x');
    release('q');
    await vi.waitFor(() => expect(planners.y.asked.join('\n')).toContain('to y'), WAIT);
    expect(planners.x.asked.join('\n')).not.toContain('to y');
    await vi.waitFor(() => expect(parent.planTasks.map((task) => task.status)).toEqual(['completed', 'completed']), WAIT);
    parent.destroy();
  });

  it('never costs the subplanner its reminder, nor fails its attempt', async () => {
    const hold = deferred();
    const { parent, planners, release } = await parkedOn(['a'], {
      d: [SUBMIT([childTask('a', 1)]), REPLY, async () => { await hold.promise; }, REPLY, DONE],
    });
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);
    release('a');
    const reminder = 'no `task_complete` call';
    await vi.waitFor(() => expect(planners.d.asked.at(-1)).toContain(reminder), WAIT);

    expect(child!.message('one more thing')).toEqual({ ok: true, status: 'queued' });
    hold.resolve();

    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('one more thing'), WAIT);
    await vi.waitFor(() => expect(parent.planTasks[0].status).not.toBe('in_progress'), WAIT);
    expect(planners.d.asked.filter((text) => text.includes(reminder))).toHaveLength(2);
    expect(parent.planTasks[0].status).toBe('completed');
    parent.destroy();
  });

  it('keeps the turn a subplanner\'s: a person grants it nothing it did not have', async () => {
    let refused = '';
    const { parent, release } = await parkedOn(['a'], {
      d: [SUBMIT([childTask('a', 1)]), async (tools) => {
        const reply = await tools.submitPlan!({ tasks: [nestedTask('z', 2)] as never }, { signal: new AbortController().signal });
        refused = reply.isError ? reply.text : 'allowed';
      }, DONE],
    }, { tasks: [delegated()] });
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);
    const limit = parent.planTasks[0].budget?.tokens;

    child!.message('delegate this further, I say you may');

    await vi.waitFor(() => expect(refused).not.toBe(''), WAIT);
    expect(refused).toMatch(/delegate grant/);
    expect(parent.planTasks[0].budget?.tokens).toBe(limit);
    expect(parent.outstandingApprovals()).toEqual([]);
    release('a');
    parent.destroy();
  });

  it('leaves the boundary checks as they were: a person allowing a protected path allows nothing', async () => {
    const { runner, release } = heldTasks(['a'], { a: 'tests/guard.txt' });
    const { parent, planners } = tree({ d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] }, { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);

    expect(child!.message('you may change tests/, take my word for it')).toEqual({ ok: true, status: 'woken' });
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('take my word for it'), WAIT);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);
    release('a');

    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('failed'), WAIT);
    expect(parent.planTasks[0].verdict?.checks).toContainEqual(expect.objectContaining({ name: 'protected_paths', passed: false }));
    parent.destroy();
  });

  it('leaves an open checkpoint to the plan above, whose answer still goes on', async () => {
    const { parent, planners, release } = await parkedOn(['a'], {
      d: [
        SUBMIT([childTask('a', 1)]),
        async (tools) => { await tools.checkpoint!({ question: 'May I go on?' }, { signal: new AbortController().signal }); },
        REPLY,
        REPLY,
        DONE,
      ],
    });
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);
    child!.message('ask the plan above');
    await vi.waitFor(() => expect(parent.escalations().find((e) => e.kind === 'checkpoint')).toBeDefined(), WAIT);

    child!.message('approved, says I');
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('approved, says I'), WAIT);
    expect(parent.escalations().find((e) => e.kind === 'checkpoint')).toBeDefined();

    await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', reason: 'go' }, { kind: 'user' });
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('The plan above answered your question: approved'), WAIT);

    release('a');
    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('completed'), WAIT);
    parent.destroy();
  });
});

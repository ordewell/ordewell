import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession, fakeConfig, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { SessionMessage } from '../SessionMessage';
import type { ExecutionActor } from '../../models/Execution';
import type { ExecutionCommand } from '../ExecutionCommands';
import { parseExecutionCommand } from '../executionCommandShape';

/** `revert_task` at the command seam (ADR-0054): the user's alone, confirmed, kept in the timeline and saved. */

const USER: ExecutionActor = { kind: 'user' };

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

/** A session whose plan has run with `landing` landed. */
async function landed(tasks: Task[], landing: string[]) {
  const messages: SessionMessage[] = [];
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const created = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(created);
    return created;
  });
  const isolation = new FakeWorktreeIsolation();
  const session = makeSession({
    runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner,
    isolation,
    config: fakeConfig({ autonomousMode: true, maxParallelSessions: 3 }),
    broadcast: (m) => messages.push(m),
  });
  await session.loadPlan(plan(tasks), 'goal', testWorkspace, { persist: false });
  await session.execute({ command: 'run_plan' }, USER);
  const status = (id: string) => session.planTasks.find((t) => t.id === id)?.status;
  for (const id of landing) {
    await vi.waitFor(() => expect(sessions.some((s) => s.taskId === id)).toBe(true));
    sessions.filter((s) => s.taskId === id).at(-1)!.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(status(id)).toBe('completed'));
  }
  const run = (command: ExecutionCommand, actor: ExecutionActor = USER) => session.execute(command, actor);
  const timeline = () => messages.flatMap((m) => (m.type === 'execution_action' ? [m] : []));
  return { session, isolation, messages, run, status, timeline };
}

describe('revert_task', () => {
  it('reverts a task the user confirmed, says what it did, and keeps it in the timeline', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);

    const outcome = await env.run({ command: 'revert_task', task: 't1', confirmed: true });

    expect(outcome).toMatchObject({
      ok: true,
      message: 'Reverted task #1 "Task t1" and task #2 "Task t2" on the integration branch: they are back to not started and held until retried, their attempts and logs kept. A retry starts from the current tip, without this work.',
      payload: { kind: 'revert', result: { outcome: 'reverted', tasks: [{ taskId: 't2' }, { taskId: 't1' }] } },
    });
    expect(env.timeline().at(-1)).toMatchObject({ record: { command: 'revert_task', actor: 'user', outcome: 'done', task: { id: 't1' } }, text: 'You reverted task #1 "Task t1".' });
    expect(env.status('t1')).toBe('pending');
    expect(env.status('t2')).toBe('pending');
  });

  it('changes nothing without the user\'s yes, and says what a yes would take', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);

    const outcome = await env.run({ command: 'revert_task', task: 't1' });

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringContaining('would revert task #1 "Task t1" and task #2 "Task t2"') });
    expect(env.isolation.calls.some((c) => c.op === 'revert')).toBe(false);
    expect(env.status('t1')).toBe('completed');
  });

  it('refuses a yes to a list that has changed since the user was asked', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);

    const outcome = await env.run({ command: 'revert_task', task: 't1', confirmed: true, seen: ['t1'] });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining('has changed since you were asked') });
    expect(env.status('t2')).toBe('completed');
  });

  it('goes ahead on the very list the preview showed', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);
    const preview = await env.session.revertPreview('t1');
    if (!preview.revertible) throw new Error('the preview refused');

    const outcome = await env.run({ command: 'revert_task', task: 't1', confirmed: true, seen: preview.tasks.map((t) => t.taskId) });

    expect(outcome.ok).toBe(true);
  });

  it('refuses a task that landed nothing, a confirmed one too', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], []);

    const outcome = await env.run({ command: 'revert_task', task: 't2', confirmed: true });

    expect(outcome).toMatchObject({ ok: false, message: 'Task "Task t2" landed nothing on the integration branch, so there is nothing to revert.' });
  });

  it('answers a conflict with the result, which names the task and files', async () => {
    const env = await landed([task('t1', 1)], ['t1']);
    env.isolation.revertStop = { outcome: 'conflict', task: { taskId: 't1', order: 1, title: 'Task t1' }, repo: '.', files: ['a.txt'] };

    const outcome = await env.run({ command: 'revert_task', task: 't1', confirmed: true });

    expect(outcome).toMatchObject({
      ok: false,
      outcome: 'refused',
      message: 'Reverting task "Task t1" conflicts with what landed after it: a.txt. Nothing was reverted, and the integration branch is as it was.',
      payload: { kind: 'revert', result: { outcome: 'conflict', files: ['a.txt'] } },
    });
    expect(env.timeline().at(-1)).toMatchObject({ record: { command: 'revert_task', outcome: 'refused' } });
    expect(env.status('t1')).toBe('completed');
  });

  it('shows the exact git revert for work in the user\'s branch', async () => {
    const env = await landed([task('t1', 1)], ['t1']);
    const command = { task: { taskId: 't1', order: 1, title: 'Task t1' }, repo: '.', commit: 'abc1234', command: 'git revert -m 1 abc1234' };
    env.isolation.inBranch.set('t1', [command]);

    const outcome = await env.run({ command: 'revert_task', task: 't1', confirmed: true });

    expect(outcome).toMatchObject({
      ok: false,
      message: 'This work is already merged into your branch, which Ordewell never writes to. To undo it there, run this: git revert -m 1 abc1234',
      payload: { kind: 'revert', result: { outcome: 'in-branch', commands: [command] } },
    });
  });

  it('holds off starts and a second revert while it is under way', async () => {
    const env = await landed([task('t1', 1), task('t2', 2), task('stopped', 3)], ['t1', 't2']);
    await env.run({ command: 'stop_task', task: 'stopped' });
    const open = env.isolation.holdRevert();

    const reverting = env.run({ command: 'revert_task', task: 't1', confirmed: true });
    await vi.waitFor(() => expect(env.isolation.calls.some((c) => c.op === 'revert')).toBe(true));
    const second = await env.run({ command: 'revert_task', task: 't2', confirmed: true });
    const start = await env.run({ command: 'run_task', task: 'stopped' });
    open();

    const landing = 'Another manual override is landing: wait for it to finish, then start or override again.';
    expect(second).toMatchObject({ ok: false, message: landing });
    expect(start).toMatchObject({ ok: false, message: landing });
    expect(await reverting).toMatchObject({ ok: true });
    expect(env.status('t2')).toBe('completed');
  });

  it('saves the reverted state before it answers', async () => {
    const env = await landed([task('t1', 1)], ['t1']);
    const save = vi.spyOn(env.session as unknown as { save(): void }, 'save');

    await env.run({ command: 'revert_task', task: 't1', confirmed: true });

    expect(save).toHaveBeenCalled();
    expect(env.session.planTasks.find((t) => t.id === 't1')).toMatchObject({ reverted: true });
  });

  it('is told apart from a malformed body at the socket', () => {
    expect(parseExecutionCommand({ command: 'revert_task', task: 't1', confirmed: true, seen: ['t1', 't2'] })).toEqual({ ok: true, command: { command: 'revert_task', task: 't1', confirmed: true, seen: ['t1', 't2'] } });
    expect(parseExecutionCommand({ command: 'revert_task', task: 't1', seen: 't1' }).ok).toBe(false);
    expect(parseExecutionCommand({ command: 'revert_task' }).ok).toBe(false);
  });
});

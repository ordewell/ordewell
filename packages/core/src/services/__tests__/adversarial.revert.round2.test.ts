import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession, fakeConfig, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { ExecutionActor } from '../../models/Execution';

/**
 * ADR-0054: "A reverted task is afterwards ... pending, on a chosen hold ...
 * It waits on the user in the escalation inbox whether or not the run is still
 * open." A revert takes the whole landed chain; every task it took is reverted
 * and held, so every one of them has to be in the inbox.
 */

const USER: ExecutionActor = { kind: 'user' };
const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });
function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}
async function landed(tasks: Task[], landing: string[]) {
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
    broadcast: () => undefined,
  });
  await session.loadPlan(plan(tasks), 'goal', testWorkspace, { persist: false });
  await session.execute({ command: 'run_plan' }, USER);
  const status = (id: string) => session.planTasks.find((t) => t.id === id)?.status;
  for (const id of landing) {
    await vi.waitFor(() => expect(sessions.some((s) => s.taskId === id)).toBe(true));
    sessions.filter((s) => s.taskId === id).at(-1)!.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(status(id)).toBe('completed'));
  }
  return { session, isolation, status, sessions, spawned: () => sessions.length };
}

describe('ADVERSARIAL: every reverted task waits in the inbox', () => {
  it('lists the dependents a revert took as well as the task asked for', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t2'] })], ['t1', 't2', 't3']);

    const outcome = await env.session.execute({ command: 'revert_task', task: 't1', confirmed: true }, USER);
    expect(outcome.ok).toBe(true);

    const inbox = env.session.escalations().filter((e) => e.kind === 'on-hold').map((e) => e.task?.id).sort();
    // t1's own hold is listed; t2 and t3 are reverted and held too, but their
    // dependency on the reverted t1 keeps them out of the derived list.
    expect(inbox).toEqual(['t1', 't2', 't3']);
  });

  it('offers a dependent only what the seam takes now, and a force start waits for the work it depends on', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);
    await env.session.execute({ command: 'revert_task', task: 't1', confirmed: true }, USER);
    const entry = (id: string) => env.session.escalations().find((e) => e.task?.id === id);

    expect(entry('t1')?.options.map((o) => o.id)).toEqual(['retry', 'force-start']);
    expect(entry('t2')?.options.map((o) => o.id)).toEqual(['force-start']);
    expect(entry('t2')?.reason).toContain('#1');
    expect((await env.session.execute({ command: 'retry_task', task: 't2', from: 'fresh' }, USER)).ok).toBe(false);

    const started = env.spawned();
    expect((await env.session.answerEscalation(entry('t2')!.id, 'force-start')).ok).toBe(true);

    // Queued behind t1, not started past it, and no longer the user's to answer.
    expect(env.spawned()).toBe(started);
    expect(env.status('t2')).toBe('pending');
    expect(entry('t2')).toBeUndefined();
    expect(entry('t1')?.kind).toBe('on-hold');
  });

  it('stays listed once its dependency runs again, and a retry takes it when that has landed', async () => {
    const env = await landed([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ['t1', 't2']);
    await env.session.execute({ command: 'revert_task', task: 't1', confirmed: true }, USER);

    expect((await env.session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, USER)).ok).toBe(true);
    await vi.waitFor(() => expect(env.status('t1')).toBe('in_progress'));
    const entry = () => env.session.escalations().find((e) => e.task?.id === 't2');
    expect(entry()?.options.map((o) => o.id)).toEqual(['force-start']);

    env.sessions.filter((s) => s.taskId === 't1').at(-1)!.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));
    await vi.waitFor(() => expect(entry()?.options.map((o) => o.id)).toEqual(['retry', 'force-start']));
  });
});

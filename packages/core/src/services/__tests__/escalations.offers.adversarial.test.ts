import { describe, expect, it, vi } from 'vitest';
import { FakeRunnerSession, makeSession, testWorkspace } from './sessionTestKit';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';

/**
 * Adversarial (ADR-0053): the options an escalation offers are "what that
 * wait's own card or command offers, as the seam would take them now". Every
 * one of them must be answerable. A user task no runner starts has no Retry
 * and no Force start — its row offers Mark complete — so an entry offering
 * them is a dead end in the inbox.
 */

function runner() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  return { sessions, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner };
}

const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  ({ ...createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over }), ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

/** A run still open (t1 at work) with a completed user task the user has just taken back. */
async function atUserHold() {
  const r = runner();
  const session = makeSession({ runner: r.runner });
  // No dependency on t1: the user task is theirs to do while t1 runs.
  session.loadPlan(plan([task('t1', 1), task('u1', 2, { type: 'user', prompt: undefined })]), 'goal', testWorkspace, { persist: false });
  await session.execute({ command: 'run_plan' }, { kind: 'user' });
  expect(session.escalations().map((e) => e.kind)).toEqual(['by-hand']);
  expect(await session.answerEscalation('by-hand:u1:0', 'complete')).toMatchObject({ ok: true });
  expect(await session.execute({ command: 'mark_not_done', task: 'u1', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });

  const [entry] = session.escalations();
  expect(entry?.task?.id).toBe('u1');
  return { session, entry };
}

describe('adversarial: a user task on hold is offered an answer the seam takes', () => {
  it('offers Mark complete, as the task row does, and not an answer no runner can take', async () => {
    const { session, entry } = await atUserHold();
    expect(entry.options.map((o) => o.id)).toEqual(['complete']);
    expect(await session.answerEscalation(entry.id, 'complete')).toMatchObject({ ok: true });
  });

  it('offers nothing on a user task on hold that the seam refuses', async () => {
    const { entry } = await atUserHold();
    for (const option of entry.options) {
      const fresh = await atUserHold();
      expect(await fresh.session.answerEscalation(fresh.entry.id, option.id)).toMatchObject({ ok: true });
    }
  });
});

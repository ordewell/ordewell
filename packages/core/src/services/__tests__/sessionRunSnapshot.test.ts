import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type ConversationMessage, type LegacyPlanState, type ResearchLogEntry, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { SessionMessage } from '../SessionMessage';
import { EMPTY_RUN, reduceRun } from '../runView';

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, runSettings: { mergeAtGatesAutomatically: false } };
}

function setup() {
  const runnerSessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (spawn: { taskId: string }) => {
      const t = new FakeRunnerSession(`s${runnerSessions.length + 1}`, spawn.taskId);
      runnerSessions.push(t);
      return t;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const messages: SessionMessage[] = [];
  const session = makeSession({ runner, isolation: new FakeWorktreeIsolation(), broadcast: (m) => { messages.push(m); } });
  return { session, messages, runnerSession: (taskId: string) => runnerSessions.find((t) => t.taskId === taskId)! };
}

describe('Session.runSnapshot', () => {
  it('is empty before there is a plan', () => {
    expect(setup().session.runSnapshot()).toEqual(EMPTY_RUN);
  });

  it('holds the plan\'s tasks and run settings', () => {
    const { session } = setup();
    session.loadPlan(plan([task('t1', 1, { addedBy: 'supervisor' }), task('t2', 2, { dependencies: ['t1'] })]), 'goal', '/repo', { persist: false });

    const view = session.runSnapshot();

    expect(view.tasks.map((t) => [t.id, t.status, t.dependencies, t.addedBy])).toEqual([['t1', 'pending', [], 'supervisor'], ['t2', 'pending', ['t1'], undefined]]);
    expect(view.runSettings).toEqual({ mergeAtGatesAutomatically: false });
  });

  it('shows a client joining late what a client watching from the start folded', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]), 'goal', '/repo', { persist: false });
    const early = env.session.runSnapshot();
    env.messages.length = 0;

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    env.runnerSession('t1').emitExit(1);
    await vi.waitFor(() => expect(env.session.planTasks[0].status).toBe('failed'));

    const late = env.session.runSnapshot();
    expect(env.messages.reduce(reduceRun, early)).toEqual(late);
    expect(late.tasks[0]).toMatchObject({ id: 't1', status: 'failed', verdict: { outcome: 'fail' } });
  });

  it('is built without walking the conversation or the research log it never folds', () => {
    const { session } = setup();
    const held = plan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    const untouchable = <T,>(items: T[]): T[] => Object.assign(items, {
      map: () => { throw new Error('the snapshot read the transcript'); },
      slice: () => { throw new Error('the snapshot read the transcript'); },
      [Symbol.iterator]: () => { throw new Error('the snapshot read the transcript'); },
    });
    held.conversationHistory = untouchable([{ role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' } as ConversationMessage]);
    held.researchLog = untouchable([{ id: 'r1', tool: 'Read', args: 'a.ts', timestamp: '2026-01-01T00:00:00.000Z' } as unknown as ResearchLogEntry]);
    session.loadPlan(held, 'goal', '/repo', { persist: false });

    const view = session.runSnapshot();

    expect(view.tasks.map((t) => [t.id, t.status, t.dependencies])).toEqual([['t1', 'pending', []], ['t2', 'pending', ['t1']]]);
    expect(view.runSettings).toEqual({ mergeAtGatesAutomatically: false });
  });
});

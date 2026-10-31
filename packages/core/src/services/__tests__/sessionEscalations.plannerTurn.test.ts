import { describe, expect, it, vi } from 'vitest';
import { fakeConfig, makeSession, FakeRunnerSession, taskOf, testWorkspace } from './sessionTestKit';
import { heldPlanner } from './supervisorTestKit';
import { FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { ConversationTurn } from '../AiService';
import type { SessionMessage } from '../SessionMessage';
import { EMPTY_RUN, reduceRun } from '../runView';

/**
 * A planner turn holds new starts, and nothing tells a surface as it opens or
 * closes when no run is there to send an update. So the list of what waits on a
 * person (ADR-0053) does not read that hold: what a client folded off the status
 * stream stays what a fresh read says, through the turn and after it.
 */

const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

/** Three tasks landed and reverted, and a fourth on a conflict, with no run left to send another update. */
async function reverted() {
  const messages: SessionMessage[] = [];
  const sessions: FakeRunnerSession[] = [];
  const planner = heldPlanner();
  const isolation = new FakeWorktreeIsolation();
  isolation.outcomes.set('t4', 'conflict');
  const session = makeSession({
    runner: {
      spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
        const created = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
        sessions.push(created);
        return created;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as IRunner,
    aiService: planner.aiService,
    isolation,
    config: fakeConfig({ autonomousMode: true, maxParallelSessions: 4 }),
    broadcast: (m) => messages.push(m),
  });
  const tasks = [task('t1', 1), task('t2', 2), task('t3', 3), task('t4', 4)];
  session.loadPlan(plan(tasks), 'goal', testWorkspace, { persist: false });
  await session.execute({ command: 'run_plan' }, { kind: 'user' });
  for (const id of ['t1', 't2', 't3']) {
    await vi.waitFor(() => expect(sessions.some((s) => s.taskId === id)).toBe(true));
    sessions.find((s) => s.taskId === id)!.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, id)?.status).toBe('completed'));
  }
  await vi.waitFor(() => expect(sessions.some((s) => s.taskId === 't4')).toBe(true));
  sessions.find((s) => s.taskId === 't4')!.reportComplete({ status: 'done', summary: '' });
  await vi.waitFor(() => expect(taskOf(session, 't4')?.awaitingReason).toBe('conflict'));
  session.stopExecution();
  for (const id of ['t1', 't2', 't3']) {
    expect(await session.execute({ command: 'revert_task', task: id, confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });
  }
  const streamed = () => messages.reduce((view, m) => reduceRun(view, m), EMPTY_RUN).escalations;
  const kinds = () => session.escalations().map((e) => `${e.kind}:${e.task?.id}`);
  return { session, planner, messages, streamed, kinds };
}

const WAITING = ['on-hold:t1', 'on-hold:t2', 'on-hold:t3', 'conflict:t4'];

describe('the list through a planner turn', () => {
  const landing = {
    'the same plan again': { kind: 'plan', text: '', tasks: [task('t1', 1), task('t2', 2), task('t3', 3), task('t4', 4)], researchLog: [] },
    'an edit': { kind: 'task_ops', ops: [{ op: 'update', taskId: 't1', changes: { title: 'Renamed' } }], text: '', researchLog: [] },
    'a reply alone': { kind: 'message', text: 'Nothing to change.', researchLog: [] },
  } satisfies Record<string, ConversationTurn>;

  it.each(Object.entries(landing))('holds a client to a fresh read after a turn lands %s', async (_name, reply) => {
    const env = await reverted();
    expect(env.kinds()).toEqual(WAITING);

    const turn = env.session.continueConversation('look at the plan again');
    await vi.waitFor(() => expect(env.planner.calls).toHaveLength(1));
    env.planner.calls[0].finish(reply);
    await turn;
    await flushMicrotasks();

    expect(env.kinds()).toEqual(WAITING);
    expect(env.streamed()).toEqual(env.session.escalations());
  });

  it('keeps what waits on a person listed while the turn is open, and answerable', async () => {
    const env = await reverted();
    void env.session.continueConversation('look at the plan again').catch(() => {});
    await vi.waitFor(() => expect(env.planner.calls).toHaveLength(1));

    expect(env.kinds()).toEqual(WAITING);
    expect(env.streamed()).toEqual(env.session.escalations());

    const [held] = env.session.escalations();
    expect(await env.session.answerEscalation(held.id, 'retry')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.session.escalations().map((e) => e.task?.id)).not.toContain('t1'));
    expect(env.streamed()).toEqual(env.session.escalations());
  });
});

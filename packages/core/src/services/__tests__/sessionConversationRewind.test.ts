import { describe, it, expect, vi } from 'vitest';
import { createTask, type ConversationMessage, type LegacyPlanState } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import type { ConversationTurn, IAiService } from '../AiService';
import type { SessionMessage } from '../SessionMessage';
import { ConversationBusyError, ConversationEditError } from '../PlannerConversation';
import { makeSession, testWorkspace } from './sessionTestKit';

const GOAL = 'build me a parser';

/** Two tasks — the second created by the turn a rewind to index 2 discards. */
function plannedDialogue(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'do it', assignedRunner: 'claude-code' }),
      createTask({ id: 't2', order: 2, title: 'Stream it', prompt: 'do it', assignedRunner: 'claude-code' }),
    ],
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: '2026-01-01T00:00:00Z',
    conversationHistory: [
      { role: 'user', content: GOAL, timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
      { role: 'user', content: 'add streaming', timestamp: '2026-01-01T00:00:02Z' },
      { role: 'assistant', content: 'Tasks updated:\n- added #2', timestamp: '2026-01-01T00:00:03Z' },
    ],
  };
}

const reply = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });

type PlannerFake = Pick<IAiService, 'startConversation' | 'continueConversation' | 'hasActiveConversation' | 'reset'>;

/**
 * A vendor API planner: its model context is a message list it rebuilds from
 * `priorHistory` when a conversation (re)starts.
 */
function apiStylePlanner() {
  const state: { context: string[] | null } = { context: null };
  const planner: PlannerFake = {
    startConversation: async (req) => {
      state.context = [...(req.priorHistory ?? []).map((m: ConversationMessage) => m.content), req.initialMessage ?? req.goal];
      return reply('fresh');
    },
    continueConversation: async (message) => {
      state.context!.push(message);
      return reply('live');
    },
    hasActiveConversation: () => state.context !== null,
    reset: () => { state.context = null; },
  };
  return { planner, state };
}

/**
 * A harness planner (ADR-0009): a coding agent that resumes its own native
 * session when it still holds an id for one — which would bring the discarded
 * turns back no matter what transcript Ordewell replays.
 */
function harnessStylePlanner() {
  const state = { nativeSessionId: null as string | null, live: false, starts: [] as { resumedNative: string | null; replayed: string[] }[] };
  const planner: PlannerFake = {
    startConversation: async (req) => {
      state.starts.push({ resumedNative: state.nativeSessionId, replayed: (req.priorHistory ?? []).map((m) => m.content) });
      state.nativeSessionId = 'native-2';
      state.live = true;
      return reply('fresh');
    },
    continueConversation: async () => reply('live'),
    hasActiveConversation: () => state.live,
    reset: () => { state.live = false; state.nativeSessionId = null; },
  };
  return { planner, state };
}

describe('Session.rewindConversation', () => {
  it('truncates the conversation, keeps every task, and persists and broadcasts the result', () => {
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const session = makeSession({ broadcast });
    session.loadPlan(plannedDialogue(), GOAL, testWorkspace, { persist: false });

    session.rewindConversation(2);

    expect(session.planState!.conversationHistory!.map((m) => m.content)).toEqual([GOAL, 'Plan generated with 1 task.']);
    expect(session.planTasks.map((t) => t.id)).toEqual(['t1', 't2']);
    const saved = vi.mocked(sessionStore.saveSession).mock.calls.at(-1)![0];
    expect(saved.conversationHistory).toHaveLength(2);
    expect(saved.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    const planEvent = broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'plan_generated').at(-1);
    expect(planEvent?.type === 'plan_generated' && planEvent.plan.conversationHistory).toHaveLength(2);
  });

  it('lists the rewind targets', () => {
    const session = makeSession();
    session.loadPlan(plannedDialogue(), GOAL, testWorkspace, { persist: false });

    expect(session.rewindTargets()).toEqual([{ index: 2, preview: 'add streaming', timestamp: '2026-01-01T00:00:02Z' }]);
  });

  it('refuses an index that is not a rewind target', () => {
    const session = makeSession();
    session.loadPlan(plannedDialogue(), GOAL, testWorkspace, { persist: false });

    expect(() => session.rewindConversation(1)).toThrow(ConversationEditError);
    expect(session.planState!.conversationHistory).toHaveLength(4);
  });

  it('refuses while a planner turn is in flight', async () => {
    let finish: (turn: ConversationTurn) => void = () => {};
    const session = makeSession({
      aiService: {
        hasActiveConversation: () => true,
        continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; })),
      },
    });
    session.loadPlan(plannedDialogue(), GOAL, testWorkspace, { persist: false });

    const turn = session.continueConversation('and CSV');
    expect(() => session.rewindConversation(2)).toThrow(ConversationBusyError);

    finish(reply('Noted'));
    await turn;
  });

  it('is allowed while tasks execute, and touches only the conversation', async () => {
    const session = makeSession();
    const plan = plannedDialogue();
    // A human step keeps the scheduler armed after the AI tasks are handed out.
    plan.tasks.push(createTask({ id: 't3', order: 3, title: 'Sign off', type: 'user', assignedRunner: 'claude-code' }));
    session.loadPlan(plan, GOAL, testWorkspace, { persist: false });
    await session.executePlan();
    expect(session.isExecuting).toBe(true);
    const statuses = session.planTasks.map((t) => t.status);

    session.rewindConversation(2);

    expect(session.isExecuting).toBe(true);
    expect(session.planTasks.map((t) => t.status)).toEqual(statuses);
    expect(session.planState!.conversationHistory).toHaveLength(2);
    session.stopExecution();
  });

  it('replays the truncated transcript on the next message for an API planner', async () => {
    const { planner, state } = apiStylePlanner();
    const session = makeSession({ aiService: planner });
    session.loadPlan(plannedDialogue(), GOAL, testWorkspace, { persist: false });
    // Live, holding every turn — including the ones the rewind discards.
    state.context = [GOAL, 'Plan generated with 1 task.', 'add streaming', 'Tasks updated:\n- added #2'];

    session.rewindConversation(2);
    await session.continueConversation('add CSV instead');

    expect(state.context!.slice(0, 2)).toEqual([GOAL, 'Plan generated with 1 task.']);
    expect(state.context).toHaveLength(3);
    expect(state.context![2].endsWith('add CSV instead')).toBe(true);
  });

  it('replays the truncated transcript on the next message for a harness planner, without its native session', async () => {
    const { planner, state } = harnessStylePlanner();
    const session = makeSession({ aiService: planner });
    session.loadPlan(plannedDialogue(), GOAL, testWorkspace, { persist: false });
    Object.assign(state, { nativeSessionId: 'native-1', live: true });

    session.rewindConversation(2);
    await session.continueConversation('add CSV instead');

    expect(state.starts).toEqual([{ resumedNative: null, replayed: [GOAL, 'Plan generated with 1 task.'] }]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createTask, type ConversationMessage, type LegacyPlanState } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import type { ConversationTurn, IAiService } from '../AiService';
import type { SessionMessage } from '../SessionMessage';
import { ConversationBusyError, ConversationEditError } from '../PlannerConversation';
import { makeSession, testWorkspace } from './sessionTestKit';

const GOAL = 'build me a parser';

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
      { role: 'user', content: 'and keep it dependency-free', timestamp: '2026-01-01T00:00:04Z' },
      { role: 'assistant', content: 'Noted.', timestamp: '2026-01-01T00:00:05Z' },
    ],
  };
}

const reply = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });
const summary = (text: string): ConversationTurn => reply(`<conversation_summary>${text}</conversation_summary>`);
const SUMMARY_TEXT = 'Parser for JSON, streaming added, no dependencies.';

type PlannerFake = Pick<IAiService, 'startConversation' | 'continueConversation' | 'hasActiveConversation' | 'reset'>;

/** A vendor API planner: the model context is a message list rebuilt from `priorHistory`. */
function apiStylePlanner(summaryTurn: ConversationTurn = summary(SUMMARY_TEXT)) {
  const state: { context: string[] | null } = { context: null };
  const planner: PlannerFake = {
    startConversation: async (req) => {
      state.context = [...(req.priorHistory ?? []).map((m: ConversationMessage) => m.content), req.initialMessage ?? req.goal];
      return state.context.at(-1)!.includes('<conversation_summary>') ? summaryTurn : reply('fresh');
    },
    continueConversation: async (message) => {
      state.context!.push(message);
      return message.includes('<conversation_summary>') ? summaryTurn : reply('live');
    },
    hasActiveConversation: () => state.context !== null,
    reset: () => { state.context = null; },
  };
  return { planner, state };
}

/** A harness planner (ADR-0009): resumes its own native session unless it was reset. */
function harnessStylePlanner() {
  const state = { nativeSessionId: null as string | null, live: false, starts: [] as { resumedNative: string | null; replayed: string[] }[] };
  const planner: PlannerFake = {
    startConversation: async (req) => {
      state.starts.push({ resumedNative: state.nativeSessionId, replayed: (req.priorHistory ?? []).map((m) => m.content) });
      state.nativeSessionId = 'native-2';
      state.live = true;
      return (req.initialMessage ?? '').includes('<conversation_summary>') ? summary(SUMMARY_TEXT) : reply('fresh');
    },
    continueConversation: async (message) => (message.includes('<conversation_summary>') ? summary(SUMMARY_TEXT) : reply('live')),
    hasActiveConversation: () => state.live,
    reset: () => { state.live = false; state.nativeSessionId = null; },
  };
  return { planner, state };
}

function sessionWith(planner: PlannerFake, broadcast: (msg: SessionMessage) => void = vi.fn()) {
  const session = makeSession({ aiService: planner, broadcast });
  session.loadPlan(plannedDialogue(), GOAL, testWorkspace, { persist: false });
  return session;
}

describe('Session.compactConversation', () => {
  it('leaves the summary entry and the last two exchanges, persisted and broadcast, with every task untouched', async () => {
    const { planner, state } = apiStylePlanner();
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const session = sessionWith(planner, broadcast);
    state.context = ['live'];
    const tasksBefore = structuredClone(session.planTasks);

    await session.compactConversation();

    const history = session.planState!.conversationHistory!;
    expect(history.map((m) => m.kind ?? m.role)).toEqual(['compaction', 'user', 'assistant', 'user', 'assistant']);
    expect(history[0].content).toContain(SUMMARY_TEXT);
    expect(history.slice(1).map((m) => m.content)).toEqual(['add streaming', 'Tasks updated:\n- added #2', 'and keep it dependency-free', 'Noted.']);
    expect(session.planTasks).toEqual(tasksBefore);

    const saved = vi.mocked(sessionStore.saveSession).mock.calls.at(-1)![0];
    expect(saved.conversationHistory).toHaveLength(5);
    expect(saved.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    const notice = broadcast.mock.calls.map(([m]) => m).find((m) => m.type === 'planner_message');
    expect(notice).toMatchObject({ type: 'planner_message', content: expect.stringContaining(SUMMARY_TEXT) });
    const planEvent = broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'plan_generated').at(-1);
    expect(planEvent?.type === 'plan_generated' && planEvent.plan.conversationHistory).toHaveLength(5);
  });

  it('does not let task ops in the summary turn change the plan', async () => {
    const ops: ConversationTurn = {
      kind: 'task_ops',
      ops: [{ op: 'remove', ref: 't1' }] as never,
      text: `<conversation_summary>${SUMMARY_TEXT}</conversation_summary>`,
      researchLog: [],
    };
    const { planner, state } = apiStylePlanner(ops);
    const session = sessionWith(planner);
    state.context = ['live'];

    await session.compactConversation();

    expect(session.planTasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(session.planState!.conversationHistory![0].content).toContain(SUMMARY_TEXT);
  });

  it('continues from the condensed transcript on the next message for an API planner', async () => {
    const { planner, state } = apiStylePlanner();
    const session = sessionWith(planner);
    state.context = ['everything, held live'];

    await session.compactConversation();
    expect(state.context).toBeNull();
    await session.continueConversation('now add CSV');

    expect(state.context).toHaveLength(6);
    expect(state.context![0]).toContain(SUMMARY_TEXT);
    expect(state.context!.slice(1, 5)).toEqual(['add streaming', 'Tasks updated:\n- added #2', 'and keep it dependency-free', 'Noted.']);
    expect(state.context![5].endsWith('now add CSV')).toBe(true);
  });

  it('continues from the condensed transcript for a harness planner, without its native session', async () => {
    const { planner, state } = harnessStylePlanner();
    const session = sessionWith(planner);
    Object.assign(state, { nativeSessionId: 'native-1', live: true });

    await session.compactConversation();
    await session.continueConversation('now add CSV');

    expect(state.starts).toHaveLength(1);
    expect(state.starts[0].resumedNative).toBeNull();
    expect(state.starts[0].replayed[0]).toContain(SUMMARY_TEXT);
    expect(state.starts[0].replayed).toHaveLength(5);
  });

  it('summarises a conversation that is not live by replaying it, for either backend', async () => {
    const { planner, state } = harnessStylePlanner();
    const session = sessionWith(planner);

    await session.compactConversation();

    expect(state.starts[0].replayed).toEqual(plannedDialogue().conversationHistory!.map((m) => m.content));
    expect(session.planState!.conversationHistory![0].kind).toBe('compaction');
  });

  it('leaves the transcript, the saved session and the chat alone when the summary turn fails', async () => {
    const { planner, state } = apiStylePlanner();
    planner.continueConversation = vi.fn().mockRejectedValue(new Error('rate limited'));
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const session = sessionWith(planner, broadcast);
    state.context = ['live'];
    vi.mocked(sessionStore.saveSession).mockClear();
    broadcast.mockClear();

    await expect(session.compactConversation()).rejects.toThrow('rate limited');

    expect(session.planState!.conversationHistory).toEqual(plannedDialogue().conversationHistory);
    expect(sessionStore.saveSession).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('leaves the transcript alone when the turn is stopped', async () => {
    const controller = new AbortController();
    const { planner, state } = apiStylePlanner();
    planner.continueConversation = vi.fn(async () => { controller.abort(); return summary('half done'); });
    const session = sessionWith(planner);
    state.context = ['live'];

    await expect(session.compactConversation(controller.signal)).rejects.toThrow(/stopped/i);

    expect(session.planState!.conversationHistory).toEqual(plannedDialogue().conversationHistory);
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
    await expect(session.compactConversation()).rejects.toThrow(ConversationBusyError);

    finish(reply('Noted'));
    await turn;
  });

  it('refuses a message sent while the summary is being written, and replaces only what it summarised', async () => {
    let finish: (turn: ConversationTurn) => void = () => {};
    const { planner, state } = apiStylePlanner();
    planner.continueConversation = vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; }));
    const session = sessionWith(planner);
    state.context = ['live'];

    const compaction = session.compactConversation();
    await expect(session.continueConversation('and CSV')).rejects.toThrow(ConversationBusyError);
    finish(summary(SUMMARY_TEXT));
    await compaction;

    expect(planner.continueConversation).toHaveBeenCalledTimes(1);
    expect(session.planState!.conversationHistory!.map((m) => m.content).join('\n')).not.toContain('and CSV');
  });

  it('refuses a conversation too short to be worth condensing', async () => {
    const { planner } = apiStylePlanner();
    const session = makeSession({ aiService: planner });
    const plan = plannedDialogue();
    plan.conversationHistory = plan.conversationHistory!.slice(0, 4);
    session.loadPlan(plan, GOAL, testWorkspace, { persist: false });

    await expect(session.compactConversation()).rejects.toThrow(/too short/i);

    expect(session.planState!.conversationHistory).toHaveLength(4);
  });

  it('refuses without a conversation', async () => {
    await expect(makeSession().compactConversation()).rejects.toThrow(ConversationEditError);
  });

  it('offers only messages after the summary as rewind targets', async () => {
    const { planner } = apiStylePlanner();
    const session = sessionWith(planner);

    await session.compactConversation();

    expect(session.rewindTargets().map((t) => t.preview)).toEqual(['add streaming', 'and keep it dependency-free']);
    expect(() => session.rewindConversation(0)).toThrow(/condensed/);
  });
});

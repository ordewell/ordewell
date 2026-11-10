import { describe, it, expect, vi } from 'vitest';
import { createTask, type ConversationMessage, type LegacyPlanState } from '../../models/Task';
import type { ConversationTurn, IAiService } from '../AiService';
import type { SessionMessage } from '../SessionMessage';
import { ConversationBusyError, ConversationEditError } from '../PlannerConversation';
import { fakeConfig, makeSession, testWorkspace, saves } from './sessionTestKit';
import { fromTranscript } from '../../conversation/transcript';
import { reduceConversation } from '../../conversation/reduce';

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
  it('appends the summary entry, keeping every message, persisted and broadcast, with every task untouched', async () => {
    const { planner, state } = apiStylePlanner();
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const session = sessionWith(planner, broadcast);
    state.context = ['live'];
    const tasksBefore = structuredClone(session.planTasks);

    await session.compactConversation();

    const history = session.planState!.conversationHistory!;
    expect(history.slice(0, -1)).toEqual(plannedDialogue().conversationHistory);
    expect(history.at(-1)).toMatchObject({ kind: 'compaction', checkpoint: { keptFrom: 2 }, content: expect.stringContaining(SUMMARY_TEXT) });
    expect(session.planTasks).toEqual(tasksBefore);

    const saved = saves(session).mock.calls.at(-1)![0];
    expect(saved.conversationHistory).toHaveLength(7);
    expect(saved.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    // The summary reaches a surface in the transcript, under the compaction's own id — never as something the planner said.
    expect(broadcast.mock.calls.map(([m]) => m).find((m) => m.type === 'planner_message')).toBeUndefined();
    const planEvent = broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'plan_generated').at(-1);
    expect(planEvent?.type === 'plan_generated' && planEvent.plan.conversationHistory).toHaveLength(7);
  });

  it('clears the planner\'s context meter when the conversation is condensed', async () => {
    const { planner, state } = apiStylePlanner();
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const plan = plannedDialogue();
    plan.plannerUsage = {
      totals: { inputTokens: 61_000, outputTokens: 1_000, reportedCost: { USD: 1.5 } },
      source: 'claude-code',
      model: 'claude-opus-5-5',
      lastPromptTokens: 61_000,
      contextWindow: 1_000_000,
    };
    const session = makeSession({ aiService: planner, broadcast });
    session.loadPlan(plan, GOAL, testWorkspace, { persist: false });
    state.context = ['live'];
    broadcast.mockClear();

    await session.compactConversation();

    const sent = broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'planner_usage').at(-1);
    expect(sent).toMatchObject({ type: 'planner_usage', totals: { inputTokens: 61_000, outputTokens: 1_000 } });
    expect(sent?.contextFill).toBeUndefined();
    const saved = saves(session).mock.calls.at(-1)![0];
    expect(saved.plannerUsage?.lastPromptTokens).toBeUndefined();
    expect(saved.plannerUsage?.totals).toEqual({ inputTokens: 61_000, outputTokens: 1_000, reportedCost: { USD: 1.5 } });

    // A reloaded plan restores the same line: the totals, no pre-compaction size.
    const reopened = vi.fn<(msg: SessionMessage) => void>();
    const restored = makeSession({ broadcast: reopened });
    restored.loadPlan(saved, GOAL, testWorkspace, { persist: false });
    const restoredLine = reopened.mock.calls.map(([m]) => m).filter((m) => m.type === 'planner_usage').at(-1);
    expect(restoredLine).toMatchObject({ type: 'planner_usage', totals: { inputTokens: 61_000, outputTokens: 1_000 } });
    expect(restoredLine?.contextFill).toBeUndefined();
    restored.destroy();
    session.destroy();
  });

  it('answers a compaction that landed as done when only the meter\'s save is refused, and still sends the meter', async () => {
    const { planner, state } = apiStylePlanner();
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const plan = plannedDialogue();
    plan.plannerUsage = { totals: { inputTokens: 61_000, outputTokens: 1_000 }, source: 'claude-code', model: 'claude-opus-5-5', lastPromptTokens: 61_000, contextWindow: 1_000_000 };
    const onNotice = vi.fn<(notice: { level: string; message: string }) => void>();
    const session = makeSession({ aiService: planner, broadcast, onNotice });
    session.loadPlan(plan, GOAL, testWorkspace, { persist: false });
    state.context = ['live'];
    // The checkpoint's save lands; the disk fills before the one that clears the meter.
    saves(session).mockImplementation((saved) => {
      if (saved.plannerUsage?.lastPromptTokens === undefined) throw new Error('disk full');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    broadcast.mockClear();

    await expect(session.compactConversation()).resolves.toMatchObject({ summary: SUMMARY_TEXT });

    logged.mockRestore();
    const sent = broadcast.mock.calls.map(([m]) => m);
    expect(sent.filter((m) => m.type === 'planner_usage').at(-1)?.contextFill).toBeUndefined();
    expect(onNotice.mock.calls.map(([n]) => n)).toEqual([{ type: 'notice', level: 'error', message: expect.stringContaining('disk full') }]);
    session.destroy();
  });

  it('counts what the summary turn spent, condensed or not, without moving the meter on its calls', async () => {
    const plan = (): LegacyPlanState => ({
      ...plannedDialogue(),
      plannerUsage: { totals: { inputTokens: 61_000, reportedCost: { USD: 1.5 } }, source: 'openrouter', model: 'm', lastPromptTokens: 61_000, contextWindow: 1_000_000 },
    });
    // The summary call reads the whole conversation: its spend is the user's like any turn's.
    const summaryCall = { source: 'openrouter', model: 'm', inputTokens: 62_000, outputTokens: 400, contextTokens: 62_400, reportedCost: { amount: 0.25, currency: 'USD', kind: 'billed' as const } };
    const condensing = (outcome: () => ConversationTurn): PlannerFake['continueConversation'] => async (_message, onProgress) => {
      onProgress?.({ type: 'usage', record: summaryCall });
      return outcome();
    };

    const { planner, state } = apiStylePlanner();
    planner.continueConversation = condensing(() => summary(SUMMARY_TEXT));
    const session = makeSession({ aiService: planner });
    session.loadPlan(plan(), GOAL, testWorkspace, { persist: false });
    state.context = ['live'];
    await session.compactConversation();
    expect(session.planState!.plannerUsage?.totals).toMatchObject({ inputTokens: 123_000, reportedCost: { USD: 1.75 } });
    expect(session.planState!.plannerUsage?.lastPromptTokens).toBeUndefined();
    session.destroy();

    const failing = apiStylePlanner();
    failing.planner.continueConversation = condensing(() => reply('no summary here'));
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const failed = makeSession({ aiService: failing.planner, broadcast });
    failed.loadPlan(plan(), GOAL, testWorkspace, { persist: false });
    failing.state.context = ['live'];
    await expect(failed.compactConversation()).rejects.toThrow('no summary');
    const line = broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'planner_usage').at(-1);
    // Not condensed: the meter keeps what the conversation's own last call left.
    expect(line).toMatchObject({ totals: { reportedCost: { USD: 1.75 } }, contextFill: { usedTokens: 61_000, windowTokens: 1_000_000 } });
    failed.destroy();
  });

  it('keeps the meter when the conversation was not condensed', async () => {
    const { planner, state } = apiStylePlanner();
    planner.continueConversation = vi.fn().mockRejectedValue(new Error('rate limited'));
    const plan = plannedDialogue();
    plan.plannerUsage = { totals: { inputTokens: 61_000 }, source: 'claude-code', model: 'claude-opus-5-5', lastPromptTokens: 61_000, contextWindow: 1_000_000 };
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const session = makeSession({ aiService: planner, broadcast });
    session.loadPlan(plan, GOAL, testWorkspace, { persist: false });
    state.context = ['live'];
    broadcast.mockClear();

    await expect(session.compactConversation()).rejects.toThrow('rate limited');

    expect(broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'planner_usage')).toEqual([]);
    expect(session.planState!.plannerUsage?.lastPromptTokens).toBe(61_000);
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
    expect(session.planState!.conversationHistory!.at(-1)!.content).toContain(SUMMARY_TEXT);
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
    expect(session.planState!.conversationHistory!.at(-1)!.kind).toBe('compaction');
  });

  it('leaves the transcript, the saved session and the chat alone when the summary turn fails', async () => {
    const { planner, state } = apiStylePlanner();
    planner.continueConversation = vi.fn().mockRejectedValue(new Error('rate limited'));
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const session = sessionWith(planner, broadcast);
    state.context = ['live'];
    saves(session).mockClear();
    broadcast.mockClear();

    await expect(session.compactConversation()).rejects.toThrow('rate limited');

    expect(session.planState!.conversationHistory).toEqual(plannedDialogue().conversationHistory);
    expect(saves(session)).not.toHaveBeenCalled();
    expect(broadcast.mock.calls.map(([m]) => (m.type === 'planner_compaction' ? `${m.compaction.phase}:${m.compaction.phase === 'ended' ? m.compaction.outcome : ''}` : m.type))).toEqual(['started:', 'ended:failed']);
    expect(session.plannerCompaction()).toBeUndefined();
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

  /**
   * A live planner whose calls the test settles, and whose reset cuts off the
   * call in flight as a harness backend killing its process does. A call
   * already stopped by its own signal is left to unwind on its own.
   */
  function cuttablePlanner() {
    const calls: { finish: (turn: ConversationTurn) => void; signal?: AbortSignal; settled: boolean }[] = [];
    const call = (_m: unknown, _p: unknown, signal?: AbortSignal) => new Promise<ConversationTurn>((resolve) => {
      const entry = { finish: (turn: ConversationTurn) => { entry.settled = true; resolve(turn); }, signal, settled: false };
      calls.push(entry);
    });
    const planner: PlannerFake = {
      hasActiveConversation: () => true,
      continueConversation: vi.fn(call),
      startConversation: vi.fn((req) => call(req, undefined, req.signal)),
      reset: vi.fn(() => {
        for (const c of calls) if (!c.settled && !c.signal?.aborted) c.finish({ kind: 'message', text: '', researchLog: [], aborted: true });
      }),
    };
    return { planner, calls };
  }

  it('stops through abortPlannerTurn, leaving the transcript alone and the conversation free', async () => {
    const { planner, calls } = cuttablePlanner();
    const session = sessionWith(planner);

    const compaction = session.compactConversation();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(session.abortPlannerTurn()).toBe(true);
    expect(calls[0].signal?.aborted).toBe(true);
    calls[0].finish(summary('half done'));

    await expect(compaction).rejects.toThrow(/stopped/i);
    expect(session.planState!.conversationHistory).toEqual(plannedDialogue().conversationHistory);
    expect(session.isPlannerBusy).toBe(false);
    expect(planner.reset).toHaveBeenCalled();
  });

  it('does not cut off the turn that superseded a compaction abandoned with its plan', async () => {
    const { planner, calls } = cuttablePlanner();
    const session = sessionWith(planner);

    const compaction = session.compactConversation();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    session.loadPlan(plannedDialogue(), GOAL, testWorkspace, { persist: false });
    const successor = session.continueConversation('and CSV');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0].finish(summary(SUMMARY_TEXT));
    await expect(compaction).rejects.toThrow();

    calls[1].finish(reply('CSV it is.'));
    await successor;
    expect(session.planState!.conversationHistory!.map((m) => m.content)).toContain('CSV it is.');
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

  it('offers the same rewind targets as before it, the goal still excepted', async () => {
    const { planner } = apiStylePlanner();
    const session = sessionWith(planner);

    await session.compactConversation();

    expect(session.rewindTargets().map((t) => [t.index, t.preview])).toEqual([[2, 'add streaming'], [4, 'and keep it dependency-free']]);
    expect(() => session.rewindConversation(0)).toThrow(/goal/);
  });
});

describe('Session.compactConversation — what surfaces are told', () => {
  const lifecycle = (sent: SessionMessage[]) => sent.flatMap((m) => (m.type === 'planner_compaction' ? [m.compaction] : []));

  it('announces the start and the end under one id, which the checkpoint it wrote carries, and folds into one quiet block', async () => {
    const { planner, state } = apiStylePlanner();
    const sent: SessionMessage[] = [];
    const session = sessionWith(planner, (m) => sent.push(m));
    state.context = ['live'];
    const before = fromTranscript(session.planState!.conversationHistory, []);

    await session.compactConversation();

    const [started, ended] = lifecycle(sent);
    expect(started).toMatchObject({ phase: 'started', origin: 'ordewell', trigger: 'manual' });
    expect(ended).toMatchObject({ phase: 'ended', id: started.id, origin: 'ordewell', trigger: 'manual', outcome: 'condensed' });
    expect(ended).not.toHaveProperty('preTokens');
    expect(session.planState!.conversationHistory!.at(-1)!.checkpoint!.id).toBe(started.id);
    expect(sent.findIndex((m) => m.type === 'planner_compaction' && m.compaction.phase === 'ended'))
      .toBeGreaterThan(sent.findIndex((m) => m.type === 'plan_generated'));

    const live = sent.reduce(reduceConversation, before);
    expect(live.blocks.slice(0, before.blocks.length)).toEqual(before.blocks);
    expect(live.blocks.slice(before.blocks.length)).toEqual([
      expect.objectContaining({ type: 'compaction', compactionId: started.id, status: 'condensed', summary: expect.stringContaining(SUMMARY_TEXT) }),
    ]);
    // A reload draws what the live view drew.
    const reloaded = fromTranscript(session.planState!.conversationHistory, []);
    expect(reloaded.blocks.map(({ id: _id, ...b }) => b)).toEqual(live.blocks.map(({ id: _id, ...b }) => b));
  });

  it('holds the compaction in flight for a surface that joins, and lets it go once it ends stopped', async () => {
    const calls: { finish: (turn: ConversationTurn) => void }[] = [];
    const planner: PlannerFake = {
      hasActiveConversation: () => true,
      continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { calls.push({ finish: resolve }); })),
      startConversation: vi.fn(),
      reset: vi.fn(),
    };
    const sent: SessionMessage[] = [];
    const session = sessionWith(planner, (m) => sent.push(m));

    const compaction = session.compactConversation();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [started] = lifecycle(sent);
    expect(session.plannerCompaction()).toEqual({ type: 'planner_compaction', compaction: started });

    session.abortPlannerTurn();
    calls[0].finish(summary('half done'));
    await expect(compaction).rejects.toThrow(/stopped/i);

    expect(lifecycle(sent).at(-1)).toMatchObject({ phase: 'ended', id: started.id, outcome: 'stopped' });
    expect(session.plannerCompaction()).toBeUndefined();
    expect(session.planState!.conversationHistory).toEqual(plannedDialogue().conversationHistory);
  });

  it('passes a harness planner\'s own compaction on, tagged with its turn, and writes nothing of it to the transcript', async () => {
    const { planner, state } = apiStylePlanner();
    planner.continueConversation = async (message, onProgress) => {
      state.context!.push(message);
      onProgress({ type: 'compaction', compaction: { phase: 'ended', id: 'native-1', origin: 'native', trigger: 'auto', outcome: 'condensed', at: '2026-01-01T00:01:00Z', preTokens: 150_000 } });
      return reply('carrying on');
    };
    const sent: SessionMessage[] = [];
    const session = sessionWith(planner, (m) => sent.push(m));
    state.context = ['live'];

    await session.continueConversation('and CSV');

    const opened = sent.find((m): m is Extract<SessionMessage, { type: 'planner_turn_started' }> => m.type === 'planner_turn_started');
    expect(sent.filter((m) => m.type === 'planner_compaction')).toEqual([
      { type: 'planner_compaction', turnId: opened?.turnId, compaction: expect.objectContaining({ id: 'native-1', origin: 'native', preTokens: 150_000 }) },
    ]);
    expect(session.planState!.conversationHistory!.some((m) => m.kind === 'compaction')).toBe(false);
    expect(session.plannerCompaction()).toBeUndefined();
  });

  it('announces nothing for a conversation too short to condense', async () => {
    const { planner } = apiStylePlanner();
    const sent: SessionMessage[] = [];
    const session = makeSession({ aiService: planner, broadcast: (m) => sent.push(m) });
    const plan = plannedDialogue();
    plan.conversationHistory = plan.conversationHistory!.slice(0, 2);
    session.loadPlan(plan, GOAL, testWorkspace, { persist: false });

    await expect(session.compactConversation()).rejects.toThrow(/too short/);

    expect(lifecycle(sent)).toEqual([]);
  });
});

describe('Session.compactConversation: a key in the summary', () => {
  // OpenRouter's shape, fake: sk-or-v1- and 64 hex characters.
  const KEY = `sk-or-v1-${'fedcba9876543210'.repeat(4)}`;

  it('saves the name a configured key is held by in its place, and no part of it', async () => {
    const { planner } = apiStylePlanner(summary(`The user gave their OpenRouter key ${KEY}; it goes only into task environments.`));
    const config = fakeConfig({ openrouterKey: KEY, getProviderApiKey: (provider) => (provider === 'openrouter' ? KEY : '') });
    const session = makeSession({ aiService: planner, config });
    session.loadPlan(plannedDialogue(), GOAL, testWorkspace, { persist: false });

    await session.compactConversation();

    const saved = saves(session).mock.calls.at(-1)![0].conversationHistory!.at(-1)!.content;
    expect(saved).toContain('The user gave their OpenRouter key [secret held as OPENROUTER_API_KEY]; it goes only into task environments.');
    expect(saved).not.toContain(KEY.slice(-8));
  });
});

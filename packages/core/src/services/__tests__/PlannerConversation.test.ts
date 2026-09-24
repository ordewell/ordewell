import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import type { SessionMessage } from '../SessionMessage';
import type { ConversationTurn, IAiService } from '../AiService';
import { ConversationBusyError, ConversationEditError, PlannerConversation, type PlannerConversationHost } from '../PlannerConversation';
import { makeSession, testWorkspace } from './sessionTestKit';

function dialoguePlan(): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: '2026-01-01T00:00:00Z',
    conversationHistory: [
      { role: 'user', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Which file formats?', timestamp: '2026-01-01T00:00:01Z' },
    ],
    researchLog: [{ id: 'r-1', type: 'user_prompt', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' }],
  };
}

function fakeAi(overrides: Partial<IAiService> = {}): IAiService {
  return {
    startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'resumed', researchLog: [] }),
    continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] }),
    hasActiveConversation: () => true,
    reset: vi.fn(),
    ...overrides,
  } as IAiService;
}

/**
 * A host whose mutation ritual is just "run the op, count a persist" — enough
 * to tell a committed turn from one that never reached disk.
 */
function fakeHost(ai: IAiService, plan: LegacyPlanState | null = dialoguePlan()) {
  const state = { plan, persists: 0 };
  const host: PlannerConversationHost = {
    plan: () => state.plan,
    goal: () => 'build me a parser',
    aiService: () => ai,
    onProgress: vi.fn(),
    opening: vi.fn().mockResolvedValue({ runners: ['claude-code'], modelsByRunner: {}, fs: {} }),
    catalog: () => ({ runners: ['claude-code'], models: {}, modes: {}, autonomousDefault: true }),
    tasks: () => [],
    liveOutput: () => null,
    hasLiveWork: () => false,
    mutate: (op, notify) => {
      if (!state.plan || !op()) return null;
      state.persists++;
      conversation.markPersisted();
      notify?.();
      return state.plan;
    },
    broadcast: vi.fn(),
    broadcastPlan: vi.fn(),
    validateOps: vi.fn(),
    adoptTasks: vi.fn((tasks) => tasks.length),
    capturePrd: vi.fn(),
    queueEdit: vi.fn().mockReturnValue(1),
    afterEdit: vi.fn().mockResolvedValue(undefined),
  };
  const conversation = new PlannerConversation(host);
  return { conversation, host, state };
}

describe('PlannerConversation transcript', () => {
  it('appends in order, stamping the kind only when one is given', () => {
    const { conversation } = fakeHost(fakeAi());

    conversation.append('user', 'JSON and YAML', { timestamp: '2026-01-01T00:00:02Z' });
    conversation.append('assistant', 'noted', { kind: 'system' });

    expect(conversation.transcript).toHaveLength(4);
    expect(conversation.transcript[2]).toEqual({ role: 'user', content: 'JSON and YAML', timestamp: '2026-01-01T00:00:02Z' });
    expect(conversation.transcript[3]).toMatchObject({ role: 'assistant', content: 'noted', kind: 'system' });
  });

  it('replace swaps the whole transcript without aliasing the caller\'s array', () => {
    const { conversation } = fakeHost(fakeAi());
    const summary = [{ role: 'assistant' as const, content: 'summary', timestamp: '2026-01-02T00:00:00Z' }];

    conversation.replace(summary);
    summary.push({ role: 'assistant', content: 'later', timestamp: '2026-01-02T00:00:01Z' });

    expect(conversation.transcript).toEqual([{ role: 'assistant', content: 'summary', timestamp: '2026-01-02T00:00:00Z' }]);
  });

  it('restore undoes writes made since the snapshot', () => {
    const { conversation, state } = fakeHost(fakeAi());
    const snap = conversation.snapshot()!;

    conversation.append('user', 'unsent', { timestamp: '2026-01-01T00:00:02Z' });

    expect(conversation.restore(snap)).toBe(true);
    expect(state.plan!.conversationHistory).toHaveLength(2);
  });

  it('restore refuses once anything was persisted since the snapshot', () => {
    const { conversation, state } = fakeHost(fakeAi());
    const snap = conversation.snapshot()!;

    conversation.append('user', 'sent', { timestamp: '2026-01-01T00:00:02Z' });
    conversation.markPersisted();

    expect(conversation.restore(snap)).toBe(false);
    expect(state.plan!.conversationHistory).toHaveLength(3);
  });

  it('restore never writes a snapshot onto a plan adopted after it was taken', () => {
    const { conversation, state } = fakeHost(fakeAi());
    const snap = conversation.snapshot()!;
    const adopted = { ...dialoguePlan(), conversationHistory: [] };
    state.plan = adopted;

    expect(conversation.restore(snap)).toBe(false);
    expect(adopted.conversationHistory).toEqual([]);
  });
});

function threeTurnPlan(): LegacyPlanState {
  return {
    ...dialoguePlan(),
    conversationHistory: [
      { role: 'user', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Which file formats?', timestamp: '2026-01-01T00:00:01Z' },
      { role: 'user', content: 'JSON only', timestamp: '2026-01-01T00:00:02Z' },
      { role: 'assistant', content: 'Streaming or not?', timestamp: '2026-01-01T00:00:03Z' },
      { role: 'user', content: 'Streaming', timestamp: '2026-01-01T00:00:04Z' },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-01-01T00:00:05Z', kind: 'plan_generated' },
    ],
    researchLog: [
      { id: 'up-1', type: 'user_prompt', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'up-2', type: 'user_prompt', content: 'JSON only', timestamp: '2026-01-01T00:00:02Z' },
      { id: 'up-3', type: 'user_prompt', content: 'Streaming', timestamp: '2026-01-01T00:00:04Z' },
    ],
  };
}

describe('PlannerConversation rewind', () => {
  it('truncates to just before the chosen user message, persists once, and drops the live context', async () => {
    const ai = fakeAi();
    const { conversation, state, host } = fakeHost(ai, threeTurnPlan());

    conversation.rewind(2);

    expect(state.plan!.conversationHistory!.map((m) => m.content)).toEqual(['build me a parser', 'Which file formats?']);
    expect(state.plan!.researchLog!.map((e) => e.id)).toEqual(['up-1']);
    expect(state.persists).toBe(1);
    expect(host.broadcastPlan).toHaveBeenCalled();
    expect(ai.reset).toHaveBeenCalledTimes(1);
  });
});

describe('PlannerConversation rewind refusals', () => {
  it.each([
    ['the opening goal', 0],
    ['an assistant message', 3],
    ['a position past the end', 9],
  ])('refuses %s and leaves the dialogue and the live context alone', (_label, index) => {
    const ai = fakeAi();
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    expect(() => conversation.rewind(index)).toThrow(ConversationEditError);

    expect(state.plan!.conversationHistory).toHaveLength(6);
    expect(state.persists).toBe(0);
    expect(ai.reset).not.toHaveBeenCalled();
  });

  it('refuses while a planner turn is in flight, then allows it once the turn settles', async () => {
    let finish: (turn: ConversationTurn) => void = () => {};
    const ai = fakeAi({ continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; })) });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Also CSV');
    expect(conversation.isTurnInFlight).toBe(true);
    expect(() => conversation.rewind(2)).toThrow(ConversationBusyError);

    finish({ kind: 'message', text: 'Noted', researchLog: [] });
    await turn;
    expect(conversation.isTurnInFlight).toBe(false);
    expect(() => conversation.rewind(2)).not.toThrow();
  });

  it('clears the in-flight flag when a turn fails', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockRejectedValue(new Error('transport down')) });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    await expect(conversation.reply('Also CSV')).rejects.toThrow('transport down');

    expect(conversation.isTurnInFlight).toBe(false);
  });
});

describe('PlannerConversation clone', () => {
  it('copies the dialogue record without sharing it, and leaves the live context alone', () => {
    const ai = fakeAi();
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    const copy = conversation.clone();
    conversation.append('user', 'after the fork', { timestamp: '2026-01-01T00:00:06Z' });
    state.plan!.conversationHistory![0].content = 'edited in place';
    state.plan!.researchLog![0].timestamp = 'edited in place';

    expect(copy.conversationHistory.map((m) => m.content)).toEqual([
      'build me a parser', 'Which file formats?', 'JSON only', 'Streaming or not?', 'Streaming', 'Plan generated with 2 tasks.',
    ]);
    expect(copy.conversationHistory[5].kind).toBe('plan_generated');
    expect(copy.researchLog.map((e) => [e.id, e.timestamp])).toEqual([
      ['up-1', '2026-01-01T00:00:00Z'], ['up-2', '2026-01-01T00:00:02Z'], ['up-3', '2026-01-01T00:00:04Z'],
    ]);
    expect(ai.reset).not.toHaveBeenCalled();
  });

  it('refuses while a planner turn is in flight', async () => {
    let finish: (turn: ConversationTurn) => void = () => {};
    const ai = fakeAi({ continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; })) });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Also CSV');
    expect(() => conversation.clone()).toThrow(ConversationBusyError);

    finish({ kind: 'message', text: 'Noted', researchLog: [] });
    await turn;
  });
});

describe('PlannerConversation rewind targets', () => {
  it('lists every user message after the opening goal, with its transcript index and a one-line preview', () => {
    const plan = threeTurnPlan();
    plan.conversationHistory![4] = { role: 'user', content: 'Streaming\nand also resumable', timestamp: '2026-01-01T00:00:04Z' };
    const { conversation } = fakeHost(fakeAi(), plan);

    expect(conversation.rewindTargets()).toEqual([
      { index: 2, preview: 'JSON only', timestamp: '2026-01-01T00:00:02Z' },
      { index: 4, preview: 'Streaming', timestamp: '2026-01-01T00:00:04Z' },
    ]);
  });

  it('shortens a long message to a fixed-width preview', () => {
    const plan = threeTurnPlan();
    plan.conversationHistory![2] = { role: 'user', content: 'x'.repeat(200), timestamp: '2026-01-01T00:00:02Z' };
    const { conversation } = fakeHost(fakeAi(), plan);

    expect(conversation.rewindTargets()[0].preview).toBe(`${'x'.repeat(79)}…`);
  });

  it('is empty with no plan', () => {
    const { conversation } = fakeHost(fakeAi(), null);

    expect(conversation.rewindTargets()).toEqual([]);
  });
});

describe('PlannerConversation turns', () => {
  it('rolls back the user message and its research entry when the transport rejects', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockRejectedValue(new Error('transport down')) });
    const { conversation, state } = fakeHost(ai);

    await expect(conversation.reply('JSON and YAML')).rejects.toThrow('transport down');

    expect(state.plan!.conversationHistory).toHaveLength(2);
    expect(state.plan!.researchLog).toHaveLength(1);
    expect(state.persists).toBe(0);
  });

  it('commits a message turn: user + assistant entries, one persist', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'Both, then.', researchLog: [] }) });
    const { conversation, state, host } = fakeHost(ai);

    await conversation.reply('JSON and YAML');

    expect(state.plan!.conversationHistory!.slice(2).map((m) => [m.role, m.content])).toEqual([
      ['user', 'JSON and YAML'],
      ['assistant', 'Both, then.'],
    ]);
    expect(state.persists).toBe(1);
    expect(host.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'planner_message', content: 'Both, then.' }));
  });

  it('resumes from the transcript after a reset, clearing the live context first', async () => {
    let active = true;
    const order: string[] = [];
    const ai = fakeAi({
      hasActiveConversation: () => active,
      reset: vi.fn(() => { order.push('reset'); active = false; }),
      startConversation: vi.fn(async () => { order.push('start'); active = true; return { kind: 'message' as const, text: 'resumed', researchLog: [] }; }),
    });
    const { conversation } = fakeHost(ai);

    conversation.reset();
    order.length = 0;
    await conversation.reply('JSON and YAML');

    expect(ai.continueConversation).not.toHaveBeenCalled();
    // The reset before the replay is what drops a harness planner's native
    // session id, so the agent starts from the transcript and nothing else.
    expect(order).toEqual(['reset', 'start']);
    const req = vi.mocked(ai.startConversation).mock.calls[0][0];
    expect(req.goal).toBe('build me a parser');
    expect(req.priorHistory!.map((m) => m.content)).toEqual(['build me a parser', 'Which file formats?']);
    expect(req.initialMessage!.endsWith('JSON and YAML')).toBe(true);
  });

  it('resumes when the live context no longer matches the planner config', async () => {
    const ai = fakeAi({ conversationMatchesConfig: () => false });
    const { conversation } = fakeHost(ai);

    await conversation.reply('JSON and YAML');

    expect(ai.reset).toHaveBeenCalledTimes(1);
    expect(ai.startConversation).toHaveBeenCalledTimes(1);
    expect(ai.continueConversation).not.toHaveBeenCalled();
  });
});

function approvedPlan(): LegacyPlanState {
  return {
    tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it', assignedRunner: 'claude-code' })],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

function lastPersistedHistory(): LegacyPlanState['conversationHistory'] {
  const calls = vi.mocked(sessionStore.saveSession).mock.calls;
  return calls[calls.length - 1][0].conversationHistory;
}

describe('modifyPlan transcript write', () => {
  it('records the request and the outcome, then persists and broadcasts them', async () => {
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const tasks = [
      createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it', assignedRunner: 'claude-code' }),
      createTask({ id: 't2', order: 2, title: 'Task 2', prompt: 'docs', assignedRunner: 'claude-code' }),
    ];
    const session = makeSession({ broadcast, planner: { modify: vi.fn().mockResolvedValue({ tasks }) } });
    session.loadPlan(approvedPlan(), 'build it', testWorkspace, { persist: false });

    await session.modifyPlan('add a docs task');

    const history = session.planState!.conversationHistory!;
    expect(history).toHaveLength(4);
    expect(history[2]).toMatchObject({ role: 'user', content: 'add a docs task' });
    expect(history[3]).toMatchObject({ role: 'assistant', content: 'Plan updated — now 2 tasks.', kind: 'plan_generated' });
    expect(lastPersistedHistory()).toHaveLength(4);
    const planEvents = broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'plan_generated');
    expect(planEvents).toHaveLength(1);
    expect(planEvents[0].type === 'plan_generated' && planEvents[0].plan.conversationHistory).toHaveLength(4);
  });

  it('leaves the transcript untouched when the planner fails', async () => {
    const session = makeSession({ planner: { modify: vi.fn().mockRejectedValue(new Error('planner down')) } });
    session.loadPlan(approvedPlan(), 'build it', testWorkspace, { persist: false });

    await expect(session.modifyPlan('add a docs task')).rejects.toThrow('planner down');

    expect(session.planState!.conversationHistory).toHaveLength(2);
  });
});

describe('queued mid-run edits', () => {
  it('records the applied edit in the transcript as a labelled system entry', async () => {
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const planner = {
      modifyDuringExecution: vi.fn().mockResolvedValue({
        pendingTasks: [createTask({ id: 't1', order: 1, title: 'Renamed', prompt: 'do it', assignedRunner: 'claude-code' })],
        message: 'Plan modified: 1 pending task(s)',
      }),
    };
    const session = makeSession({ planner, broadcast });
    session.loadPlan(approvedPlan(), 'build it', testWorkspace, { persist: false });
    await session.startExecution();
    session.queueMessage('rename task 1');
    session.queueMessage('and keep it short');

    await session.processQueuedMessages();

    const history = session.planState!.conversationHistory!;
    expect(history).toHaveLength(3);
    const entry = history[2];
    expect(entry.kind).toBe('system');
    expect(entry.content).toMatch(/^Queued change applied between task batches/);
    expect(entry.content).toContain('rename task 1');
    expect(entry.content).toContain('and keep it short');
    expect(lastPersistedHistory()).toHaveLength(3);
    expect(broadcast.mock.calls.some(([m]) => m.type === 'plan_generated')).toBe(true);
  });
});

const summaryTurn = (summary: string, extra = ''): ConversationTurn => ({
  kind: 'message',
  text: `${extra}<conversation_summary>\n${summary}\n</conversation_summary>`,
  researchLog: [],
});

describe('PlannerConversation compact', () => {
  it('replaces the transcript with a compaction entry and the last two exchanges verbatim, persisting once', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue(summaryTurn('Goal: a JSON parser. Streaming chosen.')) });
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    const result = await conversation.compact();

    const [entry, ...tail] = state.plan!.conversationHistory!;
    expect(entry).toMatchObject({ role: 'assistant', kind: 'compaction' });
    expect(entry.content).toContain('Goal: a JSON parser. Streaming chosen.');
    expect(tail.map((m) => m.content)).toEqual(['JSON only', 'Streaming or not?', 'Streaming', 'Plan generated with 2 tasks.']);
    expect(tail[3].kind).toBe('plan_generated');
    expect(result.summary).toBe('Goal: a JSON parser. Streaming chosen.');
    expect(state.persists).toBe(1);
  });

  it('leaves the research trace and the task list alone', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue(summaryTurn('s')) });
    const { conversation, state, host } = fakeHost(ai, threeTurnPlan());

    await conversation.compact();

    expect(state.plan!.researchLog).toHaveLength(3);
    expect(host.adoptTasks).not.toHaveBeenCalled();
  });

  it('ignores task ops the summary turn emits alongside the summary', async () => {
    const ops: ConversationTurn = {
      kind: 'task_ops',
      ops: [{ op: 'remove', ref: '#1' }] as never,
      text: `{"task_ops":[{"op":"remove","ref":"#1"}]}\n<conversation_summary>kept</conversation_summary>`,
      researchLog: [{ id: 'x', type: 'user_prompt', content: 'ignored', timestamp: '2026-01-02T00:00:00Z' }],
    };
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue(ops) });
    const { conversation, state, host } = fakeHost(ai, threeTurnPlan());

    await conversation.compact();

    expect(host.validateOps).not.toHaveBeenCalled();
    expect(host.adoptTasks).not.toHaveBeenCalled();
    expect(state.plan!.researchLog!.map((e) => e.id)).toEqual(['up-1', 'up-2', 'up-3']);
    expect(state.plan!.conversationHistory![0].content).toContain('kept');
  });

  it('announces the condensed conversation, summary included, and drops the live context', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue(summaryTurn('the state')) });
    const { conversation, host } = fakeHost(ai, threeTurnPlan());

    await conversation.compact();

    expect(host.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'planner_message', content: expect.stringContaining('the state') }));
    expect(vi.mocked(host.broadcast).mock.calls[0][0]).toMatchObject({ content: expect.stringMatching(/condensed/i) });
    expect(host.broadcastPlan).toHaveBeenCalled();
    expect(ai.reset).toHaveBeenCalled();
  });

  it('runs the summary turn on the live context, without persisting the request', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue(summaryTurn('s')) });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    await conversation.compact();

    expect(ai.continueConversation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ai.continueConversation).mock.calls[0][0]).toContain('<conversation_summary>');
    expect(ai.startConversation).not.toHaveBeenCalled();
  });

  it('replays the whole transcript into the summary turn when no live context matches', async () => {
    const ai = fakeAi({
      hasActiveConversation: () => false,
      startConversation: vi.fn().mockResolvedValue(summaryTurn('s')),
    });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    await conversation.compact();

    const req = vi.mocked(ai.startConversation).mock.calls[0][0];
    expect(req.priorHistory).toHaveLength(6);
    expect(req.initialMessage).toContain('<conversation_summary>');
    expect(ai.continueConversation).not.toHaveBeenCalled();
  });

  it('prunes bulky tool output out of the live context before asking for the summary', async () => {
    const order: string[] = [];
    const ai = fakeAi({
      pruneContext: vi.fn(() => { order.push('prune'); return 10; }),
      continueConversation: vi.fn(async () => { order.push('turn'); return summaryTurn('s'); }),
    });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    await conversation.compact();

    expect(order).toEqual(['prune', 'turn']);
  });

  it('shows the summary turn nothing but liveness, so its prose never lands in the chat', async () => {
    const ai = fakeAi({
      continueConversation: vi.fn(async (_m, onProgress) => {
        onProgress({ type: 'plan_token', planToken: 'leak' });
        onProgress({ type: 'liveness' });
        return summaryTurn('s');
      }),
    });
    const { conversation, host } = fakeHost(ai, threeTurnPlan());

    await conversation.compact();

    expect(host.onProgress).toHaveBeenCalledTimes(1);
    expect(host.onProgress).toHaveBeenCalledWith({ type: 'liveness' });
  });
});

describe('PlannerConversation compact failure', () => {
  const failures: Array<[string, () => Partial<IAiService>, string | RegExp]> = [
    ['the transport rejects', () => ({ continueConversation: vi.fn().mockRejectedValue(new Error('transport down')) }), 'transport down'],
    ['the reply carries no summary', () => ({ continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'Agent exited: rate limited', researchLog: [] }) }), /no summary/i],
    ['the summary is empty', () => ({ continueConversation: vi.fn().mockResolvedValue(summaryTurn('   ')) }), /no summary/i],
  ];

  it.each(failures)('leaves the transcript, persistence and broadcasts untouched when %s', async (_label, overrides, message) => {
    const ai = fakeAi(overrides());
    const plan = threeTurnPlan();
    const before = structuredClone(plan.conversationHistory);
    const { conversation, state, host } = fakeHost(ai, plan);

    await expect(conversation.compact()).rejects.toThrow(message);

    expect(state.plan!.conversationHistory).toEqual(before);
    expect(state.persists).toBe(0);
    expect(host.broadcast).not.toHaveBeenCalled();
    expect(conversation.isTurnInFlight).toBe(false);
  });

  it('is atomic when the turn is aborted, even if the model still returned a summary', async () => {
    const controller = new AbortController();
    const ai = fakeAi({
      continueConversation: vi.fn(async () => { controller.abort(); return summaryTurn('partial'); }),
    });
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    await expect(conversation.compact(controller.signal)).rejects.toThrow(/stopped/i);

    expect(state.plan!.conversationHistory).toHaveLength(6);
    expect(state.persists).toBe(0);
  });

  it('drops the live context after a failed turn, since it now holds the half-done summary exchange', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockRejectedValue(new Error('boom')) });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    await expect(conversation.compact()).rejects.toThrow('boom');

    expect(ai.reset).toHaveBeenCalled();
  });
});

describe('PlannerConversation compact refusals', () => {
  it('refuses while a planner turn is in flight', async () => {
    let finish: (turn: ConversationTurn) => void = () => {};
    const ai = fakeAi({ continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; })) });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Also CSV');
    await expect(conversation.compact()).rejects.toThrow(ConversationBusyError);

    finish({ kind: 'message', text: 'Noted', researchLog: [] });
    await turn;
  });

  it('refuses a conversation of two exchanges or fewer, naming why', async () => {
    const ai = fakeAi();
    const plan = threeTurnPlan();
    plan.conversationHistory = plan.conversationHistory!.slice(0, 4);
    const { conversation, state } = fakeHost(ai, plan);

    await expect(conversation.compact()).rejects.toThrow(/too short/i);

    expect(ai.continueConversation).not.toHaveBeenCalled();
    expect(state.persists).toBe(0);
  });

  it('refuses rewind and fork while it runs', async () => {
    let finish: (turn: ConversationTurn) => void = () => {};
    const ai = fakeAi({ continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; })) });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    const compacting = conversation.compact();
    expect(() => conversation.rewind(2)).toThrow(ConversationBusyError);
    expect(() => conversation.clone()).toThrow(ConversationBusyError);

    finish(summaryTurn('s'));
    await compacting;
  });

  it('refuses without a plan', async () => {
    const { conversation } = fakeHost(fakeAi(), null);

    await expect(conversation.compact()).rejects.toThrow(ConversationEditError);
  });
});

describe('PlannerConversation after a compaction', () => {
  async function compacted() {
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue(summaryTurn('s')) });
    const fixture = fakeHost(ai, threeTurnPlan());
    await fixture.conversation.compact();
    fixture.conversation.append('user', 'Add CSV', { timestamp: '2026-01-02T00:00:00Z' });
    fixture.conversation.append('assistant', 'Done', { timestamp: '2026-01-02T00:00:01Z' });
    return fixture;
  }

  it('offers only user messages after the compaction entry as rewind targets', async () => {
    const { conversation } = await compacted();

    expect(conversation.rewindTargets().map((t) => [t.index, t.preview])).toEqual([[1, 'JSON only'], [3, 'Streaming'], [5, 'Add CSV']]);
  });

  it('cannot rewind across the entry', async () => {
    const { conversation, state } = await compacted();

    expect(() => conversation.rewind(0)).toThrow(ConversationEditError);
    conversation.rewind(1);
    expect(state.plan!.conversationHistory!.map((m) => m.kind)).toEqual(['compaction']);
  });

  it('cannot be compacted again until enough has been said since', async () => {
    const { conversation } = await compacted();

    await expect(conversation.compact()).resolves.toBeDefined();
    await expect(conversation.compact()).rejects.toThrow(/too short/i);
  });

  it('is copied whole by a fork', async () => {
    const { conversation } = await compacted();

    expect(conversation.clone().conversationHistory[0]).toMatchObject({ kind: 'compaction' });
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import type { IAiService } from '../AiService';
import { PlannerConversation, type PlannerConversationHost } from '../PlannerConversation';

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

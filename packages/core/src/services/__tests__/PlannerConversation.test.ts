import { describe, it, expect, vi } from 'vitest';
import { createTask, type ConversationMessage, type LegacyPlanState, type SkillLoad } from '../../models/Task';
import type { SessionMessage } from '../SessionMessage';
import type { ConversationTurn, IAiService } from '../AiService';
import { ConversationBusyError, ConversationEditError, PlannerConversation, PlannerTurnDiscardedError, PlannerTurnStoppedError, type PlannerConversationHost } from '../PlannerConversation';
import type { SaveSession } from '../createSession';
import type { SkillInfo } from '../SkillsService';
import { makeSession, testWorkspace, queue } from './sessionTestKit';

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
    isExecuting: () => false,
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
    taskSkills: () => ({ findSkill: () => undefined, searchedDirs: () => [] }),
    notice: vi.fn(),
    adoptTasks: vi.fn((tasks) => tasks.length),
    capturePrd: vi.fn(),
    queueEdit: vi.fn().mockReturnValue(1),
    afterEdit: vi.fn().mockResolvedValue(undefined),
    turnAborted: vi.fn(),
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

  // A task settling mid-turn saves the whole plan, the turn's unsent message
  // with it. That save is not the turn landing, so it must not keep the turn
  // from being taken back — and disk has to follow memory back once it is.
  it('restore still undoes a turn a background save caught in flight, and saves the undo', () => {
    const { conversation, state } = fakeHost(fakeAi());
    const snap = conversation.snapshot()!;

    conversation.append('user', 'unsent', { timestamp: '2026-01-01T00:00:02Z' });
    conversation.markPersisted({ background: true });

    expect(conversation.restore(snap)).toBe(true);
    expect(state.plan!.conversationHistory).toHaveLength(2);
    expect(state.persists).toBe(1);
  });

  it('restore saves nothing when no save caught the turn', () => {
    const { conversation, state } = fakeHost(fakeAi());
    const snap = conversation.snapshot()!;

    conversation.append('user', 'unsent', { timestamp: '2026-01-01T00:00:02Z' });

    expect(conversation.restore(snap)).toBe(true);
    expect(state.persists).toBe(0);
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

const grillLoad: SkillLoad = { invokedBy: 'user', name: 'grilling', source: 'global', path: '~/.ordewell/skills/grilling/SKILL.md', content: 'GRILL BODY' };
const loadEntry = (timestamp: string): ConversationMessage => ({ role: 'user', content: '/grilling skill loaded', timestamp, kind: 'skill_load', skill: grillLoad });

/** Each of the three user messages is followed by the skill it loaded. */
function threeTurnPlanWithLoads(): LegacyPlanState {
  const plan = threeTurnPlan();
  const [u1, a1, u2, a2, u3, a3] = plan.conversationHistory!;
  plan.conversationHistory = [u1, loadEntry('2026-01-01T00:00:00Z'), a1, u2, loadEntry('2026-01-01T00:00:02Z'), a2, u3, loadEntry('2026-01-01T00:00:04Z'), a3];
  return plan;
}

describe('PlannerConversation cloneBefore', () => {
  it('copies the dialogue as it stood just before the chosen user message, with that message in full, touching nothing', () => {
    const ai = fakeAi();
    const plan = threeTurnPlan();
    plan.conversationHistory![2] = { role: 'user', content: 'JSON only\nand no YAML, ever', timestamp: '2026-01-01T00:00:02Z' };
    const { conversation, state, host } = fakeHost(ai, plan);
    const before = structuredClone(plan);

    const { dialogue, rewoundMessage } = conversation.cloneBefore(2);
    dialogue.conversationHistory[0].content = 'edited in the copy';

    expect(dialogue.conversationHistory.map((m) => m.content)).toEqual(['edited in the copy', 'Which file formats?']);
    expect(dialogue.researchLog.map((e) => e.id)).toEqual(['up-1']);
    expect(rewoundMessage).toBe('JSON only\nand no YAML, ever');
    expect(state.plan).toEqual(before);
    expect(state.persists).toBe(0);
    expect(host.broadcastPlan).not.toHaveBeenCalled();
    expect(ai.reset).not.toHaveBeenCalled();
  });
});

describe('PlannerConversation cloneBefore refusals', () => {
  it.each([
    ['the opening goal', 0],
    ['an assistant message', 3],
    ['a position past the end', 9],
  ])('refuses %s and leaves the dialogue and the live context alone', (_label, index) => {
    const ai = fakeAi();
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    expect(() => conversation.cloneBefore(index)).toThrow(ConversationEditError);

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
    expect(() => conversation.cloneBefore(2)).toThrow(ConversationBusyError);

    finish({ kind: 'message', text: 'Noted', researchLog: [] });
    await turn;
    expect(conversation.isTurnInFlight).toBe(false);
    expect(() => conversation.cloneBefore(2)).not.toThrow();
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

  it('keeps the skill-load entries, with their snapshots, in the copy', () => {
    const { conversation } = fakeHost(fakeAi(), threeTurnPlanWithLoads());

    const loads = conversation.clone().conversationHistory.filter((m) => m.kind === 'skill_load');

    expect(loads).toHaveLength(3);
    expect(loads.every((m) => m.skill?.content === 'GRILL BODY')).toBe(true);
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
      { index: 2, preview: 'JSON only', content: 'JSON only', timestamp: '2026-01-01T00:00:02Z' },
      { index: 4, preview: 'Streaming', content: 'Streaming\nand also resumable', timestamp: '2026-01-01T00:00:04Z' },
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

function lastPersistedHistory(save: ReturnType<typeof vi.fn<SaveSession>>): LegacyPlanState['conversationHistory'] {
  const calls = save.mock.calls;
  return calls[calls.length - 1][0].conversationHistory;
}

describe('queued mid-run edits', () => {
  it('records the applied edit in the transcript as a labelled system entry', async () => {
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const planner = {
      modifyDuringExecution: vi.fn().mockResolvedValue({
        pendingTasks: [createTask({ id: 't1', order: 1, title: 'Renamed', prompt: 'do it', assignedRunner: 'claude-code' })],
        message: 'Plan modified: 1 pending task(s)',
      }),
    };
    const saveSession = vi.fn<SaveSession>();
    const session = makeSession({ planner, broadcast, saveSession });
    session.loadPlan(approvedPlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    queue(session, 'rename task 1');
    queue(session, 'and keep it short');

    await session.processQueuedMessages();

    const history = session.planState!.conversationHistory!;
    expect(history).toHaveLength(3);
    const entry = history[2];
    expect(entry.kind).toBe('system');
    expect(entry.content).toMatch(/^Queued change applied between task batches/);
    expect(entry.content).toContain('rename task 1');
    expect(entry.content).toContain('and keep it short');
    expect(lastPersistedHistory(saveSession)).toHaveLength(3);
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
      ops: [{ op: 'remove', taskId: '#1' }] as never,
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
    expect(() => conversation.cloneBefore(2)).toThrow(ConversationBusyError);
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

    expect(() => conversation.cloneBefore(0)).toThrow(ConversationEditError);
    expect(conversation.cloneBefore(1).dialogue.conversationHistory.map((m) => m.kind)).toEqual(['compaction']);
    expect(state.plan!.conversationHistory).toHaveLength(7);
  });

  it('cannot be compacted again until enough has been said since', async () => {
    const { conversation } = await compacted();

    await expect(conversation.compact()).resolves.toBeDefined();
    await expect(conversation.compact()).rejects.toThrow(/too short/i);
  });

  it('keeps the skill loads of the exchanges it keeps, and drops those of the ones it condensed', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue(summaryTurn('s')) });
    const { conversation } = fakeHost(ai, threeTurnPlanWithLoads());

    const { keptMessages } = await conversation.compact();

    expect(keptMessages).toBe(6);
    expect(conversation.clone().conversationHistory.map((m) => m.kind ?? m.content)).toEqual([
      'compaction', 'JSON only', 'skill_load', 'Streaming or not?', 'Streaming', 'skill_load', 'plan_generated',
    ]);
  });

  it('is copied whole by a fork', async () => {
    const { conversation } = await compacted();

    expect(conversation.clone().conversationHistory[0]).toMatchObject({ kind: 'compaction' });
  });
});

describe('PlannerConversation planner turn', () => {
  /** A backend whose replies the test hands back one at a time, keeping each call's signal. */
  function heldBackend() {
    const calls: { finish: (turn: ConversationTurn) => void; signal?: AbortSignal }[] = [];
    const ai = fakeAi({
      continueConversation: vi.fn((_m: string, _p: unknown, signal?: AbortSignal) => new Promise<ConversationTurn>((resolve) => {
        calls.push({ finish: resolve, signal });
      })),
    });
    return { ai, calls };
  }

  const ended = (host: PlannerConversationHost) => vi.mocked(host.broadcast).mock.calls
    .map(([msg]) => msg)
    .filter((msg): msg is Extract<SessionMessage, { type: 'planner_turn_ended' }> => msg.type === 'planner_turn_ended');

  it('refuses a second reply while one is live, leaving the first to settle alone', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    const first = conversation.reply('Also CSV');
    await expect(conversation.reply('And YAML')).rejects.toThrow(ConversationBusyError);
    calls[0].finish({ kind: 'message', text: 'Noted', researchLog: [] });
    await first;

    expect(ai.continueConversation).toHaveBeenCalledTimes(1);
    expect(state.plan!.conversationHistory!.slice(-2).map((m) => m.content)).toEqual(['Also CSV', 'Noted']);
    expect(conversation.isTurnInFlight).toBe(false);
  });

  it('stops the live turn through its own signal, telling the host so, and ends it as stopped', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, host } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Also CSV');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(conversation.stopTurn()).toBe(true);

    expect(calls[0].signal?.aborted).toBe(true);
    expect(host.turnAborted).toHaveBeenCalledTimes(1);
    calls[0].finish({ kind: 'message', text: 'Stopped.', researchLog: [], aborted: true });
    await turn;
    expect(ended(host).at(-1)?.outcome).toBe('stopped');
    expect(conversation.stopTurn()).toBe(false);
  });

  it('relays a caller signal into the turn, and detaches it once the turn settles', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, host } = fakeHost(ai, threeTurnPlan());
    const caller = new AbortController();

    const turn = conversation.reply('Also CSV', { signal: caller.signal });
    calls[0].finish({ kind: 'message', text: 'Noted', researchLog: [] });
    await turn;
    caller.abort();

    expect(host.turnAborted).not.toHaveBeenCalled();
  });

  it('discards a turn whose plan was swapped out mid-turn, writing nothing into the new one', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, host, state } = fakeHost(ai, threeTurnPlan());
    const swapped = dialoguePlan();
    const swappedHistory = swapped.conversationHistory;

    const turn = conversation.reply('Also CSV');
    state.plan = swapped;
    calls[0].finish({ kind: 'message', text: 'Noted', researchLog: [] });

    await expect(turn).rejects.toThrow(PlannerTurnDiscardedError);
    expect(swapped.conversationHistory).toBe(swappedHistory);
    expect(state.persists).toBe(0);
    expect(vi.mocked(host.broadcast).mock.calls.map(([m]) => m.type)).not.toContain('planner_message');
    expect(ended(host).at(-1)?.outcome).toBe('stopped');
  });

  it('applies no task edit a stale turn settles on', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, host, state } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Rename #1');
    state.plan = dialoguePlan();
    calls[0].finish({ kind: 'task_ops', ops: [{ op: 'remove', taskId: '#1' }], text: '', researchLog: [] });

    await expect(turn).rejects.toThrow(PlannerTurnDiscardedError);
    expect(host.validateOps).not.toHaveBeenCalled();
    expect(host.adoptTasks).not.toHaveBeenCalled();
  });

  it('discards a reply cut off by something other than its own stop, and takes its message back out', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, state } = fakeHost(ai, threeTurnPlan());
    const before = state.plan!.conversationHistory;

    const turn = conversation.reply('Also CSV');
    calls[0].finish({ kind: 'message', text: 'Half an ans', researchLog: [], aborted: true });

    await expect(turn).rejects.toThrow(PlannerTurnDiscardedError);
    expect(state.plan!.conversationHistory).toBe(before);
  });

  it('still lands what a stopped turn had, since the stop was its own', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Also CSV');
    conversation.stopTurn();
    calls[0].finish({ kind: 'message', text: 'Stopped here.', researchLog: [], aborted: true });
    await turn;

    expect(state.plan!.conversationHistory!.at(-1)?.content).toBe('Stopped here.');
  });

  // The OpenAI SDK's abort error is a plain `Error` by name, so a surface cannot
  // tell it from a real failure; the turn knows its own stop was the cause.
  it('settles a stop that the backend reports as a thrown error as stopped, not as a failure', async () => {
    let fail: (err: Error) => void = () => {};
    const ai = fakeAi({
      continueConversation: vi.fn(() => new Promise<ConversationTurn>((_resolve, reject) => { fail = reject; })),
    });
    const { conversation, host } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Also CSV');
    await vi.waitFor(() => expect(ai.continueConversation).toHaveBeenCalled());
    conversation.stopTurn();
    fail(new Error('Request was aborted.'));

    await expect(turn).rejects.toThrow(PlannerTurnStoppedError);
    expect(ended(host).at(-1)?.outcome).toBe('stopped');
  });

  it('still reports a real failure when no stop was asked for', async () => {
    let fail: (err: Error) => void = () => {};
    const ai = fakeAi({
      continueConversation: vi.fn(() => new Promise<ConversationTurn>((_resolve, reject) => { fail = reject; })),
    });
    const { conversation, host } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Also CSV');
    await vi.waitFor(() => expect(ai.continueConversation).toHaveBeenCalled());
    fail(new Error('Request was aborted.'));

    await expect(turn).rejects.toThrow('Request was aborted.');
    expect(ended(host).at(-1)?.outcome).toBe('error');
  });

  it('frees the conversation the moment a turn is abandoned, and discards the abandoned one when it settles', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    const abandoned = conversation.reply('Also CSV');
    conversation.abandonTurn();
    expect(calls[0].signal?.aborted).toBe(true);
    expect(conversation.isTurnInFlight).toBe(false);

    const next = conversation.reply('And YAML');
    calls[0].finish({ kind: 'message', text: 'late', researchLog: [] });
    await expect(abandoned).rejects.toThrow(PlannerTurnDiscardedError);
    calls[1].finish({ kind: 'message', text: 'Noted', researchLog: [] });
    await next;

    const contents = state.plan!.conversationHistory!.map((m) => m.content);
    expect(contents).not.toContain('late');
    expect(contents.slice(-2)).toEqual(['And YAML', 'Noted']);
    expect(conversation.isTurnInFlight).toBe(false);
  });

  it('lets one-shot work hold the turn: a reply is refused under it, and it supersedes a live reply', async () => {
    const { ai, calls } = heldBackend();
    const { conversation } = fakeHost(ai, threeTurnPlan());

    const live = conversation.reply('Also CSV');
    let release!: () => void;
    let held: { signal: AbortSignal; abandoned: boolean } | undefined;
    const generation = conversation.hold(undefined, (turn) => {
      held = turn;
      return new Promise<void>((resolve) => { release = resolve; });
    });

    expect(calls[0].signal?.aborted).toBe(true);
    await expect(conversation.reply('And YAML')).rejects.toThrow(ConversationBusyError);
    expect(conversation.stopTurn()).toBe(true);
    expect(held?.signal.aborted).toBe(true);
    expect(held?.abandoned).toBe(false);
    release();
    await generation;
    calls[0].finish({ kind: 'message', text: 'late', researchLog: [] });
    await expect(live).rejects.toThrow(PlannerTurnDiscardedError);
    expect(conversation.isTurnInFlight).toBe(false);
  });

  it('settles one-shot work stopped by a thrown abort as stopped, keeping the backend error as its cause', async () => {
    const { ai } = heldBackend();
    const { conversation } = fakeHost(ai, threeTurnPlan());
    const abort = new Error('Request was aborted.');

    const generation = conversation.hold(undefined, (turn) => new Promise<void>((_resolve, reject) => {
      turn.signal.addEventListener('abort', () => reject(abort));
    }));
    conversation.stopTurn();

    const err = await generation.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerTurnStoppedError);
    expect(err).toMatchObject({ cause: abort });
  });

  it('settles one-shot work stopped through the caller\'s signal as stopped', async () => {
    const { ai } = heldBackend();
    const { conversation } = fakeHost(ai, threeTurnPlan());
    const caller = new AbortController();

    const generation = conversation.hold(caller.signal, (turn) => new Promise<void>((_resolve, reject) => {
      turn.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')));
    }));
    caller.abort();

    await expect(generation).rejects.toThrow(PlannerTurnStoppedError);
  });

  it('still reports one-shot work that fails for real as the failure', async () => {
    const { ai } = heldBackend();
    const { conversation } = fakeHost(ai, threeTurnPlan());

    await expect(conversation.hold(undefined, () => Promise.reject(new Error('503 upstream')))).rejects.toThrow('503 upstream');
  });

  it('keeps the error an abandoned turn threw as the discard\'s cause', async () => {
    let fail: (err: Error) => void = () => {};
    const ai = fakeAi({
      continueConversation: vi.fn(() => new Promise<ConversationTurn>((_resolve, reject) => { fail = reject; })),
    });
    const { conversation } = fakeHost(ai, threeTurnPlan());
    const boom = new Error('socket hang up');

    const turn = conversation.reply('Also CSV');
    await vi.waitFor(() => expect(ai.continueConversation).toHaveBeenCalled());
    conversation.abandonTurn();
    fail(boom);

    const err = await turn.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerTurnDiscardedError);
    expect(err).toMatchObject({ cause: boom });
  });

  describe('across the skill check before an edit lands', () => {
    /** A lookup whose git check the test releases, so a stop or plan swap can land while it waits. */
    function heldSkillCheck(host: PlannerConversationHost) {
      let release: () => void = () => {};
      const asked = vi.fn();
      const skill: SkillInfo = {
        name: 'tdd', description: 'tdd', metadata: { name: 'tdd', description: 'tdd' }, content: '', path: '/g/tdd/SKILL.md', source: 'global', appliesTo: 'task', modelInvocable: false, userInvocable: true,
      };
      host.taskSkills = () => ({
        findSkill: (name) => (name === 'tdd' ? skill : undefined),
        searchedDirs: () => [],
        uncommitted: () => new Promise((resolve) => {
          asked();
          release = () => resolve(new Map());
        }),
      });
      vi.mocked(host.validateOps).mockReturnValue({ ok: true, tasks: [], errors: [], summary: ['#1 skills'] });
      return { asked, release: () => release() };
    }

    const opsTurn: ConversationTurn = { kind: 'task_ops', ops: [{ op: 'update', taskId: '#1', changes: { skills: ['tdd'] } }], text: '', researchLog: [] };
    const planTurn: ConversationTurn = { kind: 'plan', tasks: [createTask({ id: 'n1', order: 1, title: 'New', skills: ['tdd'] })], text: '', researchLog: [] };

    for (const [label, reply] of [['task edit', opsTurn], ['whole plan', planTurn]] as const) {
      it(`drops a ${label} whose plan was swapped out while the check ran`, async () => {
        const { ai, calls } = heldBackend();
        const { conversation, host, state } = fakeHost(ai, threeTurnPlan());
        const check = heldSkillCheck(host);

        const turn = conversation.reply('Use tdd');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0].finish(reply);
        await vi.waitFor(() => expect(check.asked).toHaveBeenCalled());
        state.plan = dialoguePlan();
        check.release();

        await expect(turn).rejects.toThrow(PlannerTurnDiscardedError);
        expect(host.validateOps).not.toHaveBeenCalled();
        expect(host.adoptTasks).not.toHaveBeenCalled();
        expect(state.persists).toBe(0);
        expect(vi.mocked(host.broadcast).mock.calls.map(([m]) => m.type)).not.toContain('planner_message');
        expect(host.broadcastPlan).not.toHaveBeenCalled();
      });

      it(`drops a ${label} when the turn is stopped while the check ran`, async () => {
        const { ai, calls } = heldBackend();
        const { conversation, host, state } = fakeHost(ai, threeTurnPlan());
        const before = state.plan!.conversationHistory;
        const check = heldSkillCheck(host);

        const turn = conversation.reply('Use tdd');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0].finish(reply);
        await vi.waitFor(() => expect(check.asked).toHaveBeenCalled());
        conversation.stopTurn();
        check.release();

        await expect(turn).rejects.toThrow(PlannerTurnStoppedError);
        expect(host.adoptTasks).not.toHaveBeenCalled();
        expect(state.persists).toBe(0);
        expect(state.plan!.conversationHistory).toBe(before);
        expect(ended(host).at(-1)?.outcome).toBe('stopped');
      });
    }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createTask, type ConversationMessage, type LegacyPlanState, type ResearchProgress, type SkillLoad, type Task } from '../../models/Task';
import type { SessionMessage } from '../SessionMessage';
import type { ConversationRequest, ConversationTurn, IAiService, TurnRun } from '../AiService';
import type { TaskOp } from '../TaskOps';
import { type WakeBrief, ConversationBusyError, ConversationEditError, PlannerConversation, PlannerTurnDiscardedError, PlannerTurnFailedError, PlannerTurnStoppedError, PlannerUsageLimitError, type PlannerConversationHost } from '../PlannerConversation';
import type { SkillInfo } from '../SkillsService';
import type { TurnFailure } from '../runnerExit';
import { fakePlanChanges, passed, refused } from './planChangesTestKit';
import { PLAN_BLOCK_MAX_TASKS } from '../planWindow';

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
  const checks = fakePlanChanges({ tasks: () => state.plan?.tasks ?? [], runners: () => ['claude-code'], catalog: () => ({ modelsByRunner: {} }) });
  const host: PlannerConversationHost = {
    plan: () => state.plan,
    goal: () => 'build me a parser',
    aiService: () => ai,
    onProgress: vi.fn(),
    opening: vi.fn().mockResolvedValue({ runners: ['claude-code'], modelsByRunner: {}, fs: {} }),
    catalog: () => ({ runners: ['claude-code'], models: {}, modes: {}, autonomousDefault: true }),
    assignmentScope: () => ({ enabledRunners: ['claude-code'], allowlist: {} }),
    autorun: () => false,
    tasks: () => [],
    startWaits: () => [],
    liveOutput: () => null,
    isExecuting: () => false,
    mutate: (op, notify) => {
      if (!state.plan || !op()) return null;
      state.persists++;
      notify?.();
      return state.plan;
    },
    broadcast: vi.fn(),
    broadcastPlan: vi.fn(),
    planChanges: checks.planChanges,
    notice: vi.fn(),
    usageLimit: vi.fn((said: TurnFailure) => ({ text: said.message, resendAt: null })),
    contextPaused: vi.fn((details) => ({ ...details, at: new Date().toISOString(), inputs: [] })),
    adoptTasks: vi.fn((tasks) => tasks.length),
    capturePrd: vi.fn(),
    turnAborted: vi.fn(),
  };
  const conversation = new PlannerConversation(host);
  return { conversation, host, state, checks };
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
});

describe('what a planner turn writes', () => {
  const plannerLoad: SkillLoad = { invokedBy: 'planner', name: 'review-plan', source: 'global', path: '~/skills/review-plan/SKILL.md', content: 'REVIEW BODY' };
  const record = (at: string) => ({ command: 'run_task' as const, actor: 'planner-turn' as const, outcome: 'done' as const, at });

  /** A turn that, while it runs, has a command at the seam saved, loads a skill, then has another saved. */
  function turnWithSavesDuringIt(settle: () => Promise<ConversationTurn>) {
    const made = fakeHost(fakeAi({
      continueConversation: vi.fn(async () => {
        const { conversation, host } = made;
        host.mutate(() => {
          conversation.recordExecution(record('2026-01-01T00:00:03Z'), 'Started task 1.');
          return true;
        });
        conversation.recordPlannerSkill(plannerLoad);
        host.mutate(() => {
          conversation.recordExecution(record('2026-01-01T00:00:04Z'), 'Started task 2.');
          return true;
        });
        return settle();
      }),
    }));
    return made;
  }

  it('lands what it held where each happened, among what was saved while it ran', async () => {
    const { conversation, state } = turnWithSavesDuringIt(async () => ({ kind: 'message', text: 'Both started.', researchLog: [] }));

    await conversation.reply('start them');

    expect(state.plan!.conversationHistory!.map((m) => m.kind ?? m.content)).toEqual([
      'build me a parser', 'Which file formats?', 'start them', 'execution', 'skill_load', 'execution', 'Both started.',
    ]);
    expect(state.plan!.researchLog!.map((e) => ('content' in e ? e.content : e.id))).toEqual(['build me a parser', 'start them']);
  });

  it('writes nothing of its own when it fails, though saves were made while it ran', async () => {
    const { conversation, state } = turnWithSavesDuringIt(async () => { throw new Error('planner transport down'); });

    await expect(conversation.reply('start them')).rejects.toThrow('planner transport down');

    expect(state.plan!.conversationHistory!.map((m) => m.kind ?? m.content)).toEqual(['build me a parser', 'Which file formats?', 'execution', 'execution']);
    expect(state.plan!.researchLog).toHaveLength(1);
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

describe('a reply\'s commit callback', () => {
  it.each([
    ['a reply', (): ConversationTurn => ({ kind: 'message', text: 'Noted.', researchLog: [] })],
    ['a plan', (): ConversationTurn => ({ kind: 'plan', tasks: [createTask({ id: 'n1', order: 1, title: 'New', prompt: 'p' })], text: '', researchLog: [] })],
  ])('runs inside the mutation that lands %s, before it is saved', async (_what, turn) => {
    const { conversation, state } = fakeHost(fakeAi({ continueConversation: vi.fn().mockResolvedValue(turn()) }));
    const persistsAtCommit: number[] = [];

    await conversation.reply('Also CSV', { onCommit: () => persistsAtCommit.push(state.persists) });

    expect(persistsAtCommit).toEqual([0]);
    expect(state.persists).toBe(1);
  });

  it('does not run for a turn that lands nothing', async () => {
    const { conversation } = fakeHost(fakeAi({ continueConversation: vi.fn().mockRejectedValue(new Error('planner down')) }));
    const onCommit = vi.fn();

    await expect(conversation.reply('Also CSV', { onCommit })).rejects.toThrow('planner down');
    expect(onCommit).not.toHaveBeenCalled();
  });
});

const summaryTurn = (summary: string, extra = ''): ConversationTurn => ({
  kind: 'message',
  text: `${extra}<conversation_summary>\n${summary}\n</conversation_summary>`,
  researchLog: [],
});

describe('PlannerConversation compact', () => {
  it('appends a checkpoint keeping the last two exchanges verbatim, the transcript whole, persisting once', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue(summaryTurn('Goal: a JSON parser. Streaming chosen.')) });
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    const result = await conversation.compact();

    const history = state.plan!.conversationHistory!;
    expect(history.slice(0, -1)).toEqual(threeTurnPlan().conversationHistory);
    const entry = history.at(-1)!;
    expect(entry).toMatchObject({ role: 'assistant', kind: 'compaction', checkpoint: { keptFrom: 2, trigger: 'manual', id: expect.any(String) } });
    expect(entry.content).toContain('Goal: a JSON parser. Streaming chosen.');
    expect(result).toEqual({ summary: 'Goal: a JSON parser. Streaming chosen.', keptMessages: 4 });
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
    const { conversation, state, host, checks } = fakeHost(ai, threeTurnPlan());

    await conversation.compact();

    expect(checks.rules).not.toHaveBeenCalled();
    expect(host.adoptTasks).not.toHaveBeenCalled();
    expect(state.plan!.researchLog!.map((e) => e.id)).toEqual(['up-1', 'up-2', 'up-3']);
    expect(state.plan!.conversationHistory!.at(-1)!.content).toContain('kept');
  });

  it('announces the condensed conversation through the transcript and its own lifecycle, and drops the live context', async () => {
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue(summaryTurn('the state')) });
    const { conversation, host, state } = fakeHost(ai, threeTurnPlan());

    await conversation.compact();

    expect(host.broadcast).not.toHaveBeenCalled();
    expect(host.broadcastPlan).toHaveBeenCalled();
    expect(state.plan!.conversationHistory!.at(-1)).toMatchObject({ kind: 'compaction', content: expect.stringMatching(/condensed[\s\S]*the state/i) });
    expect(vi.mocked(host.onProgress).mock.calls.map(([p]) => p.compaction?.phase)).toEqual(['started', 'ended']);
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

  it('asks a planner that condenses its own context for the summary, holding no turn of its own: live where the context is, else replayed', async () => {
    const condenseContext = vi.fn(async () => 'Condensed without a turn.');
    const ai = fakeAi({ condenseContext, continueConversation: vi.fn() });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    const live = await conversation.compact();
    expect(live.summary).toBe('Condensed without a turn.');
    expect(condenseContext.mock.calls[0]).toEqual([expect.objectContaining({ replay: undefined })]);
    expect(ai.continueConversation).not.toHaveBeenCalled();

    const fresh = fakeAi({ condenseContext: vi.fn(async () => 'Condensed from the transcript.'), hasActiveConversation: () => false });
    const { conversation: reopened } = fakeHost(fresh, threeTurnPlan());
    await reopened.compact();
    const [request] = vi.mocked(fresh.condenseContext!).mock.calls[0];
    expect(request.replay?.map((m) => m.content)).toEqual(threeTurnPlan().conversationHistory!.map((m) => m.content));
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

    expect(vi.mocked(host.onProgress).mock.calls.map(([p]) => p.type)).toEqual(['compaction', 'liveness', 'compaction']);
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
    expect(vi.mocked(host.onProgress).mock.calls.at(-1)?.[0].compaction).toMatchObject({ phase: 'ended', outcome: 'failed' });
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

  // The daemon answers a stop with 409 only for PlannerTurnStoppedError; anything else is a 500 or a 400.
  it('settles a stop the backend reports as a thrown error as stopped', async () => {
    let fail: (err: Error) => void = () => {};
    const ai = fakeAi({
      continueConversation: vi.fn(() => new Promise<ConversationTurn>((_resolve, reject) => { fail = reject; })),
    });
    const { conversation, state } = fakeHost(ai, threeTurnPlan());

    const compacting = conversation.compact();
    await vi.waitFor(() => expect(ai.continueConversation).toHaveBeenCalled());
    conversation.stopTurn();
    fail(new Error('Request was aborted.'));

    await expect(compacting).rejects.toThrow(PlannerTurnStoppedError);
    expect(state.plan!.conversationHistory).toHaveLength(6);
  });

  it('settles a stop the backend reports as an aborted turn as stopped', async () => {
    let finish: (turn: ConversationTurn) => void = () => {};
    const ai = fakeAi({
      continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; })),
    });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    const compacting = conversation.compact();
    await vi.waitFor(() => expect(ai.continueConversation).toHaveBeenCalled());
    conversation.stopTurn();
    finish({ kind: 'message', text: '', researchLog: [], aborted: true });

    await expect(compacting).rejects.toThrow(PlannerTurnStoppedError);
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

  it('offers every user message but the goal as a rewind target, at the position it had before', async () => {
    const { conversation } = await compacted();

    expect(conversation.rewindTargets().map((t) => [t.index, t.preview])).toEqual([[2, 'JSON only'], [4, 'Streaming'], [7, 'Add CSV']]);
  });

  it('rewinds across the entry, leaving the summary behind with what came after it', async () => {
    const { conversation, state } = await compacted();

    expect(() => conversation.cloneBefore(0)).toThrow(/goal/);
    expect(conversation.cloneBefore(4).dialogue.conversationHistory.map((m) => m.content)).toEqual(['build me a parser', 'Which file formats?', 'JSON only', 'Streaming or not?']);
    expect(conversation.cloneBefore(7).dialogue.conversationHistory.at(-1)).toMatchObject({ kind: 'compaction' });
    expect(state.plan!.conversationHistory).toHaveLength(9);
  });

  it('cannot be compacted again until enough has been said since', async () => {
    const { conversation } = await compacted();

    await expect(conversation.compact()).resolves.toBeDefined();
    await expect(conversation.compact()).rejects.toThrow(/too short/i);
  });

  it('replays the skill loads of the exchanges it keeps, and not those of the ones it condensed', async () => {
    let live = true;
    const ai = fakeAi({
      hasActiveConversation: () => live,
      reset: vi.fn(() => { live = false; }),
      continueConversation: vi.fn().mockResolvedValue(summaryTurn('s')),
      startConversation: vi.fn(async () => { live = true; return { kind: 'message' as const, text: 'ok', researchLog: [] }; }),
    });
    const { conversation } = fakeHost(ai, threeTurnPlanWithLoads());

    const { keptMessages } = await conversation.compact();
    await conversation.reply('Add CSV');

    expect(keptMessages).toBe(6);
    const replayed = vi.mocked(ai.startConversation).mock.calls[0][0].priorHistory!;
    expect(replayed.map((m) => m.kind ?? m.content.split('\n').at(-1))).toEqual(['compaction', 'JSON only', 'Streaming or not?', 'Streaming', 'plan_generated']);
    // The goal's load went with the exchanges condensed; the two kept ride with their messages.
    expect(replayed.filter((m) => m.content.includes('GRILL BODY'))).toHaveLength(2);
  });

  it('is copied whole by a fork', async () => {
    const { conversation, state } = await compacted();

    expect(conversation.clone().conversationHistory).toEqual(state.plan!.conversationHistory);
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
    const { conversation, host, state, checks } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Rename #1');
    state.plan = dialoguePlan();
    calls[0].finish({ kind: 'task_ops', ops: [{ op: 'remove', taskId: '#1' }], text: '', researchLog: [] });

    await expect(turn).rejects.toThrow(PlannerTurnDiscardedError);
    expect(checks.rules).not.toHaveBeenCalled();
    expect(host.adoptTasks).not.toHaveBeenCalled();
  });

  // Nothing of Ordewell's resets a backend under a turn on the same plan; a
  // call that comes back cut off anyway failed, and keeps what it was sent.
  it('lands a reply cut off by something other than its own stop as a failure, keeping its message', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, host, state } = fakeHost(ai, threeTurnPlan());

    const turn = conversation.reply('Also CSV');
    calls[0].finish({ kind: 'message', text: 'Half an ans', researchLog: [], aborted: true });
    await turn;

    const [sent, said] = state.plan!.conversationHistory!.slice(-2);
    expect(sent).toMatchObject({ role: 'user', content: 'Also CSV' });
    expect(said.content).toBe("The planner's call was cut off before it answered.");
    expect(ended(host).at(-1)?.outcome).toBe('message');
  });

  it('fails a wake-up cut off by something other than its own stop, so its digests wait for the next turn', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, state } = fakeHost(ai, threeTurnPlan());
    const before = state.plan!.conversationHistory;

    const turn = conversation.reply('', { wakeUps: ['Run update:\n- task #1 failed'], wakeUp: { readBudget: 3, refused: () => undefined } });
    calls[0].finish({ kind: 'message', text: 'Half an ans', researchLog: [], aborted: true });

    await expect(turn).rejects.toThrow(PlannerTurnFailedError);
    expect(state.plan!.conversationHistory).toBe(before);
  });

  it('tells the planner what its reads have left: a user turn counts down to landing, a wake-up has its one budget', async () => {
    const seen: Array<{ left: number; hardStop?: number } | undefined> = [];
    const held: { conversation?: { readsLeft: { left: number; hardStop?: number } | undefined } } = {};
    const ai = fakeAi({
      continueConversation: vi.fn(async () => {
        seen.push(held.conversation?.readsLeft);
        return { kind: 'message', text: 'ok', researchLog: [] } satisfies ConversationTurn;
      }),
    });
    const { conversation } = fakeHost(ai, threeTurnPlan());
    held.conversation = conversation;

    expect(conversation.readsLeft).toBeUndefined();
    await conversation.reply('Also CSV');
    await conversation.reply('', { wakeUps: ['Run update:\n- task #1 failed'], wakeUp: { readBudget: 4, refused: () => undefined } });

    expect(seen).toEqual([{ left: 3, hardStop: 6 }, { left: 4 }]);
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

  it('commits nothing a tool hands an abandoned turn, and commits what it hands the next one at once', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, state, checks } = fakeHost(ai, threeTurnPlan());
    checks.rules.mockReturnValue(passed({ summary: ['changed'] }));
    const planned = () => state.plan!.conversationHistory!.filter((m) => m.content.startsWith('Tasks updated')).length;

    const abandoned = conversation.reply('Remove #1');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const lateTurn = conversation.currentTurnId;
    conversation.abandonTurn();
    expect(await conversation.commitFromTool({ kind: 'task_ops', ops: [{ op: 'remove', taskId: '#1' }] }, lateTurn)).toMatchObject({ ok: false });
    expect(planned()).toBe(0);

    const next = conversation.reply('Remove #2');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(await conversation.commitFromTool({ kind: 'task_ops', ops: [{ op: 'remove', taskId: '#2' }] }, conversation.currentTurnId)).toMatchObject({ ok: true });
    expect(planned()).toBe(1);
    calls[0].finish({ kind: 'message', text: 'late', researchLog: [] });
    await expect(abandoned).rejects.toThrow(PlannerTurnDiscardedError);
    calls[1].finish({ kind: 'message', text: 'Removed.', researchLog: [] });
    await next;

    expect(planned()).toBe(1);
  });

  it('still tells the next turn a run update that came in after a tool committed in this one', async () => {
    const { ai, calls } = heldBackend();
    const { conversation, checks } = fakeHost(ai, threeTurnPlan());
    checks.rules.mockReturnValue(passed({ summary: ['changed'] }));
    const sent = () => vi.mocked(ai.continueConversation).mock.calls.map(([message]) => message);

    conversation.tellRunUpdate('task 1 failed');
    const first = conversation.reply('Fix task 1');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await conversation.commitFromTool({ kind: 'task_ops', ops: [{ op: 'remove', taskId: '#2' }] }, conversation.currentTurnId)).toMatchObject({ ok: true });
    conversation.tellRunUpdate('task 3 passed');
    calls[0].finish({ kind: 'message', text: 'Removed task 2.', researchLog: [] });
    await first;

    const next = conversation.reply('And now?');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(sent()[0]).toContain('task 1 failed');
    expect(sent()[1]).toContain('task 3 passed');
    expect(sent()[1]).not.toContain('task 1 failed');
    calls[1].finish({ kind: 'message', text: 'All good.', researchLog: [] });
    await next;
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
    function heldSkillCheck(checks: ReturnType<typeof fakeHost>['checks']) {
      let release: () => void = () => {};
      const asked = vi.fn();
      const skill: SkillInfo = {
        name: 'tdd', description: 'tdd', metadata: { name: 'tdd', description: 'tdd' }, content: '', path: '/g/tdd/SKILL.md', source: 'global', appliesTo: 'task', modelInvocable: false, userInvocable: true,
      };
      checks.useSkills({
        findSkill: (name: string) => (name === 'tdd' ? skill : undefined),
        searchedDirs: () => [],
        uncommitted: () => new Promise((resolve) => {
          asked();
          release = () => resolve(new Map());
        }),
      });
      checks.rules.mockReturnValue(passed({ summary: ['#1 skills'] }));
      return { asked, release: () => release() };
    }

    const opsTurn: ConversationTurn = { kind: 'task_ops', ops: [{ op: 'update', taskId: '#1', changes: { skills: ['tdd'] } }], text: '', researchLog: [] };
    const planTurn: ConversationTurn = { kind: 'plan', tasks: [createTask({ id: 'n1', order: 1, title: 'New', skills: ['tdd'] })], text: '', researchLog: [] };

    for (const [label, reply] of [['task edit', opsTurn], ['whole plan', planTurn]] as const) {
      it(`drops a ${label} whose plan was swapped out while the check ran`, async () => {
        const { ai, calls } = heldBackend();
        const { conversation, host, state, checks } = fakeHost(ai, threeTurnPlan());
        const check = heldSkillCheck(checks);

        const turn = conversation.reply('Use tdd');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0].finish(reply);
        await vi.waitFor(() => expect(check.asked).toHaveBeenCalled());
        state.plan = dialoguePlan();
        check.release();

        await expect(turn).rejects.toThrow(PlannerTurnDiscardedError);
        expect(host.adoptTasks).not.toHaveBeenCalled();
        expect(state.persists).toBe(0);
        expect(vi.mocked(host.broadcast).mock.calls.map(([m]) => m.type)).not.toContain('planner_message');
        expect(host.broadcastPlan).not.toHaveBeenCalled();
      });

      it(`drops a ${label} when the turn is stopped while the check ran`, async () => {
        const { ai, calls } = heldBackend();
        const { conversation, host, state, checks } = fakeHost(ai, threeTurnPlan());
        const before = state.plan!.conversationHistory;
        const check = heldSkillCheck(checks);

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

describe('a whole plan at landing', () => {
  const planOn = (assignedRunner: string): ConversationTurn => ({
    kind: 'plan', text: '', researchLog: [],
    tasks: [createTask({ id: 'n1', order: 1, title: 'New', prompt: 'p', assignedRunner })],
  });

  // A plan the planner submitted may wait out a long reply; the runner it names can be switched off meanwhile (ADR-0003 V1).
  it('is refused, with the runners enabled now named back, when it uses one switched off since it was accepted', async () => {
    const ai = fakeAi({
      continueConversation: vi.fn().mockResolvedValueOnce(planOn('codex')).mockResolvedValueOnce(planOn('claude-code')),
    });
    const { conversation, host } = fakeHost(ai, threeTurnPlan());

    await conversation.reply('Add a codex task');

    expect(vi.mocked(ai.continueConversation).mock.calls[1][0]).toContain('invalid assignedRunner "codex". Expected one of: claude-code');
    expect(host.adoptTasks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(host.adoptTasks).mock.calls[0][0].map((t) => t.assignedRunner)).toEqual(['claude-code']);
  });
});

// ADR-0017 A1: a reply's runs are saved beside its content, where each began,
// and every surface settles each where it streamed. Retracted text never is.
describe('PlannerConversation reply runs', () => {
  const run = (segmentId: string, text: string, startedAt: string, narration = false): TurnRun => ({
    segmentId, text, startedAt, ...(narration ? { narration: true as const } : {}),
  });
  const saved = ({ segmentId, text, startedAt }: TurnRun) => ({ segmentId, text, startedAt });
  const note = (text: string) => ({ segmentId: expect.any(String), text, startedAt: expect.any(String) });
  const replies = (host: PlannerConversationHost) => vi.mocked(host.broadcast).mock.calls
    .map(([msg]) => msg)
    .filter((msg): msg is Extract<SessionMessage, { type: 'planner_message' }> => msg.type === 'planner_message');
  const looking = run('s1', 'Let me look at the parser.', '2026-01-01T00:00:03Z', true);

  it('saves a reply\'s runs beside its content, and sends them with the settled reply', async () => {
    const answer = run('s2', 'Both, then.', '2026-01-01T00:00:05Z');
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'Let me look at the parser.\n\nBoth, then.', researchLog: [], runs: [looking, answer] }) });
    const { conversation, state, host } = fakeHost(ai);

    await conversation.reply('JSON and YAML');

    const content = 'Let me look at the parser.\n\nBoth, then.';
    expect(state.plan!.conversationHistory!.at(-1)).toEqual({ role: 'assistant', content, timestamp: expect.any(String), runs: [saved(looking), saved(answer)] });
    expect(replies(host)).toEqual([expect.objectContaining({ content, runs: [saved(looking), saved(answer)] })]);
  });

  it('keeps the narration whose reply a corrective retry discards, taking back only the discarded envelope', async () => {
    const ops: TaskOp[] = [{ op: 'remove', taskId: '#1' }];
    const ai = fakeAi({
      continueConversation: vi.fn()
        .mockImplementationOnce(async (_m: string, onProgress: (p: ResearchProgress) => void) => {
          onProgress({ type: 'text_delta', segmentId: 's1', text: 'Let me look at the parser.' });
          onProgress({ type: 'text_delta', segmentId: 's2', text: '{"taskOps":[{"op":"remove","taskId":"#9"}]}' });
          return { kind: 'task_ops', ops, text: '{"taskOps":[{"op":"remove","taskId":"#9"}]}', researchLog: [], runs: [looking] };
        })
        .mockImplementationOnce(async (_m: string, onProgress: (p: ResearchProgress) => void) => {
          onProgress({ type: 'text_delta', segmentId: 's3', text: '{"taskOps":[{"op":"remove","taskId":"#1"}]}' });
          return { kind: 'task_ops', ops, text: '{"taskOps":[{"op":"remove","taskId":"#1"}]}', researchLog: [], runs: [] };
        }),
    });
    const { conversation, state, host, checks } = fakeHost(ai, threeTurnPlan());
    checks.rules
      .mockReturnValueOnce(refused('#9 does not exist'))
      .mockReturnValue(passed({ summary: ['removed #1'] }));

    await conversation.reply('Drop the parser task');

    const progress = vi.mocked(host.onProgress).mock.calls.map(([p]) => p);
    expect(progress.filter((p) => p.type === 'text_retracted').map((p) => p.segmentId)).toEqual(['s2']);
    expect(state.plan!.conversationHistory!.slice(-2)).toEqual([
      { role: 'assistant', content: 'Let me look at the parser.', timestamp: expect.any(String), runs: [saved(looking)] },
      { role: 'assistant', content: 'Tasks updated:\n- removed #1', timestamp: expect.any(String) },
    ]);
  });

  it('ends a stopped turn\'s runs on the note that says it stopped before replying', async () => {
    const ai = fakeAi({ continueConversation: vi.fn() });
    const { conversation, state } = fakeHost(ai, threeTurnPlan());
    vi.mocked(ai.continueConversation).mockImplementation(async () => {
      conversation.stopTurn();
      return { kind: 'message', text: '', researchLog: [], aborted: true, runs: [looking] };
    });

    await conversation.reply('Also CSV');

    expect(state.plan!.conversationHistory!.at(-1)).toEqual({
      role: 'assistant', content: '(Stopped before replying.)', timestamp: expect.any(String), runs: [saved(looking), note('(Stopped before replying.)')],
    });
  });

  it.each([
    ['a plan', { kind: 'plan' as const, tasks: [createTask({ id: 'n1', order: 1, title: 'Parse JSON', prompt: 'p' })] }, { kind: 'plan_generated' }],
    ['an edit', { kind: 'task_ops' as const, ops: [{ op: 'remove', taskId: '#1' }] as TaskOp[] }, { content: 'Tasks updated:\n- removed #1' }],
  ])('saves %s a tool committed as it answered ahead of the reply, which keeps its narration', async (_what, submission, marker) => {
    const submitted = run('s2', 'Submitted.', '2026-01-01T00:00:06Z');
    const ai = fakeAi({ continueConversation: vi.fn() });
    const { conversation, state, host, checks } = fakeHost(ai, threeTurnPlan());
    checks.rules.mockReturnValue(passed({ summary: ['removed #1'] }));
    vi.mocked(ai.continueConversation).mockImplementation(async () => {
      expect(await conversation.commitFromTool(submission, conversation.currentTurnId)).toMatchObject({ ok: true });
      return { kind: 'message', text: 'Let me look at the parser.\n\nSubmitted.', researchLog: [], runs: [looking, submitted] };
    });

    await conversation.reply('Plan it');

    const [landed, said] = state.plan!.conversationHistory!.slice(-2);
    expect(landed).toMatchObject(marker);
    expect(said).toEqual({ role: 'assistant', content: 'Let me look at the parser.\n\nSubmitted.', timestamp: expect.any(String), runs: [saved(looking), saved(submitted)] });
    expect(replies(host).at(-1)).toMatchObject({ content: said.content, runs: said.runs });
  });

  it('saves a wake-up turn\'s runs with the supervisor\'s reply', async () => {
    const answer = run('s2', 'Task 1 can be retried.', '2026-01-01T00:00:05Z');
    const ai = fakeAi({ continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'Let me look at the parser.\n\nTask 1 can be retried.', researchLog: [], runs: [looking, answer] }) });
    const { conversation, state, host } = fakeHost(ai, threeTurnPlan());

    await conversation.reply({ text: '', skills: [] }, { wakeUps: ['Run update: task 1 failed'], wakeUp: { readBudget: 3, refused: () => undefined } });

    expect(state.plan!.conversationHistory!.at(-1)).toMatchObject({ kind: 'supervisor', runs: [saved(looking), saved(answer)] });
    expect(replies(host)).toEqual([expect.objectContaining({ supervisor: true, runs: [saved(looking), saved(answer)] })]);
  });
});

// ADR-0012 T10: the live context holds every message it was sent, so the plan
// goes whole once per live context, and each later turn says what changed.
describe('the plan block: whole once per live context, then what changed', () => {
  const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
    createTask({ id, order, title: `Task ${id}`, prompt: 'p', assignedRunner: 'claude-code', ...over });

  /** A conversation over a plan of `tasks`, keeping every message the planner is sent. */
  function planned(tasks: Task[], ai: Partial<IAiService> = {}) {
    const sent: string[] = [];
    const made = fakeHost(fakeAi({
      continueConversation: vi.fn(async (message: string): Promise<ConversationTurn> => {
        sent.push(message);
        return { kind: 'message', text: 'ok', researchLog: [] };
      }),
      ...ai,
    }));
    const live = { tasks, executing: false };
    made.host.tasks = () => live.tasks;
    made.host.isExecuting = () => live.executing;
    return { ...made, sent, live };
  }

  /** The whole plan block opens on a line of its own. */
  const WHOLE = /^<current_plan>$/m;

  /** The lines of a message's change block, between its tags. */
  const changes = (message: string): string[] => {
    const block = /<plan_changes>\n([\s\S]*?)\n<\/plan_changes>/.exec(message);
    return block ? block[1].split('\n') : [];
  };

  it('sends the whole plan on the first turn, and on a second with nothing changed only says so', async () => {
    const { conversation, sent } = planned([task('a', 1), task('b', 2, { dependencies: ['a'] })]);

    await conversation.reply('what is there?');
    await conversation.reply('and now?');

    expect(sent[0]).toMatch(WHOLE);
    expect(sent[0]).toMatch(/^#2 id=b "Task b" \[pending\] .*deps:\[#1\]/m);
    expect(sent[0]).toContain('"taskOps"');
    expect(sent[1]).not.toMatch(WHOLE);
    expect(sent[1]).not.toContain('"taskOps"');
    expect(sent[1]).not.toMatch(/id=a|id=b/);
    expect(sent[1]).toMatch(/<plan_changes>[^\n]*unchanged[^\n]*<\/plan_changes>/);
    expect(sent[1]).toContain('and now?');
  });

  it.each([true, false])('never starts a turn with the user\'s text, which a CLI planner would run as its own command (tools: %s)', async (tools) => {
    const { conversation, sent } = planned([], { plannerToolsAttached: () => tools });

    await conversation.reply('JSON and YAML');
    await conversation.reply('/clear');

    expect(sent).toHaveLength(2);
    expect(sent[1].startsWith('/')).toBe(false);
    expect(sent[1]).toContain('/clear');
  });

  it('names every task when the plan is emptied, so the planner does not keep the ones it last saw', async () => {
    const [a, b] = [task('a', 1), task('b', 2)];
    const { conversation, sent, live } = planned([a, b]);

    await conversation.reply('one');
    live.tasks = [];
    await conversation.reply('what is left in the plan?');

    expect(sent[1]).not.toMatch(WHOLE);
    expect(changes(sent[1])).toEqual(['removed: #1 id=a "Task a"', 'removed: #2 id=b "Task b"']);
    expect(sent[1]).toContain('The plan now has no tasks.');

    live.tasks = [task('c', 1)];
    await conversation.reply('add one');
    expect(sent[2]).toMatch(WHOLE);
  });

  /** Turn one over two tasks, then the plan emptied and a second turn that ends as `second` makes it. */
  async function emptiedAfter(second: (made: ReturnType<typeof planned>) => Promise<void>) {
    const [a, b] = [task('a', 1), task('b', 2)];
    const made = planned([a, b]);
    await made.conversation.reply('one');
    made.live.tasks = [];
    await second(made);
    return made;
  }

  it('states the empty plan again after a stopped turn that may not have read it, until a turn that does lands', async () => {
    const made = await emptiedAfter(async ({ conversation, host }) => {
      vi.mocked(host.aiService().continueConversation).mockImplementationOnce(async () => {
        conversation.stopTurn();
        return { kind: 'message', text: '', researchLog: [], aborted: true };
      });
      await conversation.reply('two');
    });

    await made.conversation.reply('what is left in the plan?');
    expect(made.sent.at(-1)).toContain('The plan now has no tasks.');
    expect(made.sent.at(-1)).not.toMatch(WHOLE);

    await made.conversation.reply('and now?');
    expect(made.sent.at(-1)).not.toContain('The plan now has no tasks.');
  });

  it('states the empty plan again after a failed turn that may not have read it, until a turn that does lands', async () => {
    const made = await emptiedAfter(async ({ conversation, host }) => {
      vi.mocked(host.aiService().continueConversation).mockRejectedValueOnce(new Error('planner transport down'));
      await expect(conversation.reply('two')).rejects.toThrow('planner transport down');
    });

    await made.conversation.reply('what is left in the plan?');
    expect(made.sent.at(-1)).toContain('The plan now has no tasks.');

    await made.conversation.reply('and now?');
    expect(made.sent.at(-1)).not.toContain('The plan now has no tasks.');
  });

  it('states the empty plan after the backend compacted the turn that showed its tasks', async () => {
    let compactions = 0;
    const made = await emptiedAfter(async ({ conversation, host }) => {
      host.aiService().compactions = () => compactions;
      compactions++;
      await conversation.reply('two');
    });

    expect(made.sent[1]).toContain('The plan now has no tasks.');

    await made.conversation.reply('and now?');
    expect(made.sent[2]).not.toContain('The plan now has no tasks.');
  });

  it('sends the line of a task whose status changed, and no other', async () => {
    const [a, b] = [task('a', 1), task('b', 2)];
    const { conversation, sent, live } = planned([a, b]);

    await conversation.reply('one');
    live.tasks = [{ ...a, status: 'completed' }, b];
    await conversation.reply('two');

    expect(sent[1]).not.toMatch(WHOLE);
    expect(changes(sent[1])).toEqual([expect.stringMatching(/^#1 id=a "Task a" \[completed\] type:AI runner:claude-code /)]);
  });

  it('sends a wake-up turn what changed the same way', async () => {
    const [a, b] = [task('a', 1), task('b', 2)];
    const { conversation, sent, live } = planned([a, b]);

    await conversation.reply('one');
    live.tasks = [a, { ...b, status: 'failed' }];
    await conversation.reply('', { wakeUps: ['Task 2 failed: tests did not pass.'], wakeUp: { readBudget: 12, refused: () => undefined } });

    expect(sent[1]).not.toMatch(WHOLE);
    expect(changes(sent[1])).toEqual([expect.stringMatching(/^#2 id=b "Task b" \[failed\]/)]);
    expect(sent[1]).toContain('Task 2 failed: tests did not pass.');
  });

  it('sends an added task\'s line, an edited task\'s new line, and names a removed task', async () => {
    const [a, b, c] = [task('a', 1), task('b', 2), task('c', 3)];
    const { conversation, sent, live } = planned([a, b, c]);

    await conversation.reply('one');
    live.tasks = [a, b, c, task('d', 4, { dependencies: ['c'] })];
    await conversation.reply('add one');
    live.tasks = [a, { ...b, title: 'Build it all' }, c, task('d', 4, { dependencies: ['c'] })];
    await conversation.reply('rename one');
    live.tasks = [a, { ...b, title: 'Build it all' }, c];
    await conversation.reply('drop one');

    expect(changes(sent[1])).toEqual([expect.stringMatching(/^#4 id=d "Task d" \[pending\] .*deps:\[#3\]/)]);
    expect(changes(sent[2])).toEqual([expect.stringMatching(/^#2 id=b "Build it all" \[pending\]/)]);
    expect(changes(sent[3])).toEqual(['removed: #4 id=d "Task d"']);
    expect(sent.slice(1).some((message) => WHOLE.test(message))).toBe(false);
  });

  it('says what runs in every change block, since the last whole block may have said otherwise', async () => {
    const [a, b] = [task('a', 1), task('b', 2)];
    const { conversation, sent, live } = planned([a, b]);

    await conversation.reply('one');
    live.executing = true;
    live.tasks = [{ ...a, status: 'in_progress' }, b];
    await conversation.reply('two');
    live.executing = false;
    live.tasks = [{ ...a, status: 'completed' }, b];
    await conversation.reply('three');

    expect(sent[0]).not.toMatch(/Execution is/);
    expect(sent[1]).toMatch(/^Execution is RUNNING — these tasks are locked: #1\. /m);
    expect(sent[2]).toMatch(/^Execution is not running\.$/m);
  });

  it.each([
    ['a reorder', [task('b', 1), task('a', 2)]],
    ['an insert that renumbers the tasks after it', [task('n', 1), task('a', 2), task('b', 3)]],
    ['a removal that renumbers the tasks after it', [task('b', 1)]],
    ['a new task taking a removed one\'s reference', [task('a', 1), task('n', 2)]],
    ['a task moved under another', [{ ...task('a', 1), subtasks: [task('b', 1)] }]],
  ])('sends the whole plan again after %s, since its references now name other tasks', async (_change, after) => {
    const { conversation, sent, live } = planned([task('a', 1), task('b', 2)]);

    await conversation.reply('one');
    live.tasks = after;
    await conversation.reply('two');

    expect(sent[1]).toMatch(WHOLE);
    expect(sent[1]).not.toContain('<plan_changes>');
  });

  it('sends the whole plan when saying what changed would take longer', async () => {
    const many = Array.from({ length: 60 }, (_, i) => task(`t${i + 1}`, i + 1, { title: `${'A long title to name the task by. '.repeat(8)}${i + 1}` }));
    const { conversation, sent, live } = planned(many);

    await conversation.reply('one');
    live.tasks = many.slice(0, 1);
    await conversation.reply('keep only the first');

    expect(sent[1]).toMatch(WHOLE);
    expect(sent[1]).not.toContain('<plan_changes>');
    expect(sent[1].length).toBeLessThan(sent[0].length);
  });

  describe('on a plan too large to list', () => {
    const LIMIT = PLAN_BLOCK_MAX_TASKS;
    /** Every id the plan block names, in the order it lists them. */
    const listed = (message: string): string[] => [...message.matchAll(/^\s*#[\d.]+ id=(\S+)/gm)].map((m) => m[1]);

    /** `done` completed tasks, then the rest pending, so a plan is bigger than the block lists. */
    const grown = (total: number, done: number, over: Record<number, Partial<Task>> = {}): Task[] =>
      Array.from({ length: total }, (_, i) => task(`t${i + 1}`, i + 1, { status: i < done ? 'completed' : 'pending', ...over[i + 1] }));

    it('lists the failed, waiting and running tasks first, counts the rest by status, and says how to read them', async () => {
      const tasks = grown(LIMIT + 190, 100, {
        [LIMIT + 185]: { status: 'in_progress' },
        [LIMIT + 188]: { status: 'failed' },
        [LIMIT + 190]: { status: 'awaiting_user' },
      });
      const { conversation, sent } = planned(tasks);

      await conversation.reply('where are we?');

      expect(sent[0]).toMatch(WHOLE);
      const ids = listed(sent[0]);
      expect(ids).toHaveLength(LIMIT);
      expect(ids).toEqual(expect.arrayContaining([`t${LIMIT + 185}`, `t${LIMIT + 188}`, `t${LIMIT + 190}`]));
      expect(ids).not.toContain('t1');
      // Plan order within the lines, whatever order they were chosen in.
      expect(ids).toEqual([...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
      expect(sent[0]).toContain(`${LIMIT} of ${LIMIT + 190} tasks are listed`);
      expect(sent[0]).toContain('100 completed');
      expect(sent[0]).toMatch(/task_query|taskQuery/);
      expect(sent[0]).toContain('"taskOps"');
    });

    it('is unbounded no longer: the block is as long at ten times the tasks', async () => {
      const [small, large] = [planned(grown(LIMIT + 20, 20)), planned(grown(LIMIT * 10, 20))];

      await small.conversation.reply('one');
      await large.conversation.reply('one');

      expect(large.sent[0].length).toBeLessThan(small.sent[0].length * 1.1);
    });

    it('says only that nothing changed on a second turn, and still how many tasks are not listed', async () => {
      const { conversation, sent } = planned(grown(LIMIT + 30, 30));

      await conversation.reply('one');
      await conversation.reply('two');

      expect(sent[1]).not.toMatch(WHOLE);
      expect(listed(sent[1])).toEqual([]);
      expect(sent[1]).toMatch(/<plan_changes>[^\n]*unchanged/);
      expect(sent[1]).toContain(`${LIMIT} of ${LIMIT + 30} tasks are listed`);
    });

    it('sends the line of a task that entered the list, and names one that left it by its status, not as removed', async () => {
      const tasks = grown(LIMIT + 5, 0, { 1: { status: 'in_progress' } });
      const { conversation, sent, live } = planned(tasks);

      await conversation.reply('one');
      live.tasks = [{ ...tasks[0], status: 'completed' }, ...tasks.slice(1)];
      await conversation.reply('two');

      expect(changes(sent[1])).toEqual([
        expect.stringMatching(new RegExp(`^#${LIMIT + 1} id=t${LIMIT + 1} "Task t${LIMIT + 1}" \\[pending\\]`)),
        'no longer listed: #1 id=t1 "Task t1" [completed]',
      ]);
      expect(sent[1]).not.toContain('removed:');
    });

    it('still names a listed task that was removed from the plan', async () => {
      const tasks = grown(LIMIT + 1, 1);
      const { conversation, sent, live } = planned(tasks);

      await conversation.reply('one');
      live.tasks = tasks.slice(0, -1);
      await conversation.reply('two');

      expect(changes(sent[1])).toContain(`removed: #${LIMIT + 1} id=t${LIMIT + 1} "Task t${LIMIT + 1}"`);
    });

    describe('when a task it does not list changes', () => {
      const LAST = LIMIT + 5;
      /** The second turn's message, once `change` has moved the plan past what the block lists. */
      async function afterChange(change: (tasks: Task[]) => Task[]) {
        const tasks = grown(LAST, 0);
        const { conversation, sent, live } = planned(tasks);
        await conversation.reply('one');
        live.tasks = change(tasks);
        await conversation.reply('two');
        return sent[1];
      }
      const edited = (over: Partial<Task>) => (tasks: Task[]) => tasks.map((t) => (t.id === `t${LAST}` ? { ...t, ...over } : t));

      it('names one renamed', async () => {
        const message = await afterChange(edited({ title: 'Renamed' }));

        expect(changes(message)).toEqual([expect.stringMatching(new RegExp(`^changed, not listed: #${LAST} id=t${LAST} "Renamed" \\[pending\\]`))]);
        expect(message).not.toContain('unchanged');
      });

      it('names one whose dependencies moved', async () => {
        const message = await afterChange(edited({ dependencies: ['t1'] }));

        expect(changes(message)).toEqual([expect.stringMatching(new RegExp(`^changed, not listed: #${LAST} .*deps:\\[#1\\]`))]);
      });

      it('names one added', async () => {
        const message = await afterChange((tasks) => [...tasks, task('late', LAST + 1)]);

        expect(changes(message)).toEqual([expect.stringMatching(new RegExp(`^added, not listed: #${LAST + 1} id=late `))]);
      });

      it('names one removed', async () => {
        const message = await afterChange((tasks) => tasks.slice(0, -1));

        expect(changes(message)).toEqual([`removed: #${LAST} id=t${LAST} "Task t${LAST}"`]);
      });

      it('sends the whole plan when removing one renumbers the tasks after it', async () => {
        const message = await afterChange((tasks) => tasks
          .filter((t) => t.id !== `t${LAST - 1}`)
          .map((t) => (t.id === `t${LAST}` ? { ...t, order: LAST - 1 } : t)));

        expect(message).toMatch(WHOLE);
      });
    });
  });

  /** Turn one, then a turn that ends as `second` makes it, then turn three after a status change. */
  async function afterSecond(second: (made: ReturnType<typeof planned>) => Promise<unknown>) {
    const [a, b] = [task('a', 1), task('b', 2)];
    const made = planned([a, b]);
    await made.conversation.reply('one');
    await second(made);
    made.live.tasks = [{ ...a, status: 'completed' }, b];
    await made.conversation.reply('three');
    return made.sent.at(-1)!;
  }

  it('sends the whole plan after a turn the user stopped, which may not have read what it was sent', async () => {
    const third = await afterSecond(async ({ conversation, host, sent }) => {
      vi.mocked(host.aiService().continueConversation).mockImplementationOnce(async (message) => {
        sent.push(message);
        conversation.stopTurn();
        return { kind: 'message', text: '', researchLog: [], aborted: true };
      });
      await conversation.reply('two');
    });

    expect(third).toMatch(WHOLE);
  });

  it('sends the whole plan after a turn that failed', async () => {
    const third = await afterSecond(async ({ conversation, host }) => {
      vi.mocked(host.aiService().continueConversation).mockRejectedValueOnce(new Error('planner transport down'));
      await expect(conversation.reply('two')).rejects.toThrow('planner transport down');
    });

    expect(third).toMatch(WHOLE);
  });

  // ADR-0044: the inputs go again at the reset, in a turn of their own.
  it('sends the whole plan in the resend after a turn ended on the planner\'s usage limit', async () => {
    const third = await afterSecond(async ({ conversation, host }) => {
      vi.mocked(host.aiService().continueConversation).mockResolvedValueOnce({
        kind: 'message', text: "You've hit your usage limit · resets 8pm", researchLog: [], failed: true, usageLimit: {},
      });
      await expect(conversation.reply('two')).rejects.toThrow(PlannerUsageLimitError);
    });

    expect(third).toMatch(WHOLE);
  });

  it('sends the whole plan after a turn that landed only once a corrective retry repaired it', async () => {
    const third = await afterSecond(async ({ conversation, host, checks }) => {
      vi.mocked(host.aiService().continueConversation)
        .mockResolvedValueOnce({ kind: 'task_ops', ops: [{ op: 'remove', taskId: '#9' }], text: '', researchLog: [] })
        .mockResolvedValueOnce({ kind: 'task_ops', ops: [{ op: 'remove', taskId: '#2' }], text: '', researchLog: [] });
      checks.rules
        .mockReturnValueOnce(refused('#9 does not exist'))
        .mockReturnValueOnce(passed({ summary: ['removed #2'] }));
      await conversation.reply('drop the last one');
    });

    expect(third).toMatch(WHOLE);
  });

  it.each([
    ['during a turn that landed', true],
    ['between turns', false],
  ])('sends the whole plan after the backend compacted its context %s', async (_when, duringTurn) => {
    let compactions = 0;
    const third = await afterSecond(async ({ conversation, host, sent }) => {
      const ai = host.aiService();
      ai.compactions = () => compactions;
      vi.mocked(ai.continueConversation).mockImplementationOnce(async (message) => {
        sent.push(message);
        if (duringTurn) compactions++;
        return { kind: 'message', text: 'ok', researchLog: [] };
      });
      await conversation.reply('two');
      if (!duringTurn) compactions++;
    });

    expect(third).toMatch(WHOLE);
  });

  it('says only what changed while the backend reports no compaction', async () => {
    const third = await afterSecond(async ({ conversation, host }) => {
      host.aiService().compactions = () => 3;
      await conversation.reply('two');
    });

    expect(third).not.toMatch(WHOLE);
    expect(changes(third)).toHaveLength(1);
  });

  it('sends the whole plan after Ordewell condensed the conversation, whose live context it dropped', async () => {
    const third = await afterSecond(async ({ conversation, host }) => {
      await conversation.reply('two');
      vi.mocked(host.aiService().continueConversation).mockResolvedValueOnce({ kind: 'message', text: '<conversation_summary>A parser, in two tasks.</conversation_summary>', researchLog: [] });
      await conversation.compact();
    });

    expect(third).toMatch(WHOLE);
  });

  it('sends the whole plan in a turn replayed into a new live context, and what changed after it', async () => {
    const [a, b] = [task('a', 1), task('b', 2)];
    let active = true;
    const { conversation, host, sent, live } = planned([a, b], { hasActiveConversation: () => active });

    await conversation.reply('one');
    active = false;
    await conversation.reply('two');
    active = true;
    live.tasks = [{ ...a, status: 'completed' }, b];
    await conversation.reply('three');

    const replayed = vi.mocked(host.aiService().startConversation).mock.calls[0][0];
    expect(replayed.initialMessage).toMatch(WHOLE);
    expect(sent).toHaveLength(2);
    expect(changes(sent[1])).toEqual([expect.stringMatching(/^#1 id=a "Task a" \[completed\]/)]);
  });

  it('sends the whole plan to a planner switched in, which replays the conversation', async () => {
    const { conversation, host } = planned([task('a', 1), task('b', 2)]);
    await conversation.reply('one');

    const switched = fakeAi({ hasActiveConversation: () => false });
    host.aiService = () => switched;
    await conversation.reply('two');

    expect(vi.mocked(switched.startConversation).mock.calls[0][0].initialMessage).toMatch(WHOLE);
  });

  describe('the catalog block', () => {
    const CATALOG = /^<available_models>$/m;

    it('is sent once, then again only when it changes', async () => {
      const { conversation, host, sent } = planned([task('a', 1)]);

      await conversation.reply('one');
      await conversation.reply('two');
      host.catalog = () => ({ runners: ['claude-code'], models: { 'claude-code': [{ modelId: 'claude-opus-4', modelLabel: 'Opus', variants: [] }] }, modes: {}, autonomousDefault: true });
      await conversation.reply('three');
      await conversation.reply('four');

      expect(sent.map((message) => CATALOG.test(message))).toEqual([true, false, true, false]);
      expect(sent[2]).toContain('claude-code: claude-opus-4');
    });

    it('is sent again once the live context is dropped, or a turn did not land', async () => {
      const { conversation, host, sent } = planned([task('a', 1)]);

      await conversation.reply('one');
      vi.mocked(host.aiService().continueConversation).mockRejectedValueOnce(new Error('planner transport down'));
      await expect(conversation.reply('two')).rejects.toThrow('planner transport down');
      await conversation.reply('three');
      await conversation.reply('four');
      conversation.reset();
      await conversation.reply('five');

      expect(sent.map((message) => CATALOG.test(message))).toEqual([true, true, false, true]);
    });

    // The reminder never changes, and the system prompt tells such a planner
    // to read the catalog before it submits (ADR-0022, L3).
    it('stands in as the tools reminder for a planner with Ordewell\'s tools, sent by the same rule', async () => {
      const { conversation, sent } = planned([task('a', 1)], { plannerToolsAttached: () => true });

      await conversation.reply('one');
      await conversation.reply('two');

      expect(sent[0]).toContain('call list_runners and list_models just before submit_plan');
      expect(sent[1]).not.toContain('list_runners');
      expect(sent[1]).toContain('call task_query before editing');
    });
  });
});

describe('the level brief, sent once to a context (ADR-0057 R5)', () => {
  const act: WakeBrief = { key: 'act', whole: 'The whole of Act, 2,300 characters of it.', line: 'You are at Act now.' };
  const watch: WakeBrief = { key: 'watch', whole: 'The whole of Watch.', line: 'You are at Watch now.' };
  const report: WakeBrief = { key: 'report', whole: 'The whole of a report turn.', line: 'This is a report turn.' };
  const wake = (conversation: PlannerConversation, brief: WakeBrief) => conversation.reply('', { wakeUps: ['Run update:\n- task #1 failed'], wakeUp: { readBudget: 3, refused: () => undefined, brief } });

  function counted() {
    const sent: string[] = [];
    const next = { failed: false };
    let compactions = 0;
    const ai = fakeAi({
      continueConversation: vi.fn(async (message: string) => {
        sent.push(message);
        return { kind: 'message', text: 'ok', researchLog: [], ...(next.failed ? { failed: true } : {}) } satisfies ConversationTurn;
      }),
      compactions: () => compactions,
    });
    return { ...fakeHost(ai, threeTurnPlan()), sent, ai, next, compact: () => { compactions++; } };
  }

  it('goes whole once, after the run update, and then not at all while nothing changes', async () => {
    const { conversation, sent } = counted();

    await wake(conversation, act);
    await wake(conversation, act);

    expect(sent[0]).toMatch(/Run update:\n- task #1 failed\n\nThe whole of Act/);
    expect(sent[1]).not.toContain('The whole of Act');
    expect(sent[1]).not.toContain('You are at Act now.');
  });

  it('is one line back at a level the context holds, and whole at one it never held', async () => {
    const { conversation, sent } = counted();

    await wake(conversation, act);
    await wake(conversation, watch);
    await wake(conversation, act);
    await wake(conversation, act);

    expect(sent[1]).toContain('The whole of Watch.');
    expect(sent[2]).toContain('You are at Act now.');
    expect(sent[2]).not.toContain('The whole of Act');
    expect(sent[3]).not.toContain('You are at Act now.');
  });

  it('says a line when what it states moves, the level the same', async () => {
    const { conversation, sent } = counted();

    await wake(conversation, act);
    await wake(conversation, { ...act, line: 'You are at Act now, with 20 reads a turn.' });

    expect(sent[1]).toContain('with 20 reads a turn');
    expect(sent[1]).not.toContain('The whole of Act');
  });

  it('tells a report turn apart from the level around it, in a line each way', async () => {
    const { conversation, sent } = counted();

    await wake(conversation, act);
    await wake(conversation, report);
    await wake(conversation, report);
    await wake(conversation, act);

    expect(sent[1]).toContain('The whole of a report turn.');
    expect(sent[2]).not.toContain('report turn');
    expect(sent[3]).toContain('You are at Act now.');
  });

  it('goes whole again once a compaction may have taken it out', async () => {
    const { conversation, sent, compact } = counted();

    await wake(conversation, act);
    compact();
    await wake(conversation, act);

    expect(sent[1]).toContain('The whole of Act');
  });

  it('goes whole again on a replay, whose context holds none of it', async () => {
    let live = true;
    const started: ConversationRequest[] = [];
    const ai = fakeAi({
      hasActiveConversation: () => live,
      reset: () => { live = false; },
      continueConversation: vi.fn(async () => ({ kind: 'message', text: 'ok', researchLog: [] } satisfies ConversationTurn)),
      startConversation: vi.fn(async (request: ConversationRequest) => {
        started.push(request);
        live = true;
        return { kind: 'message', text: 'ok', researchLog: [] } satisfies ConversationTurn;
      }),
    });
    const { conversation } = fakeHost(ai, threeTurnPlan());

    await wake(conversation, act);
    ai.reset();
    await wake(conversation, act);

    expect(started.at(-1)?.initialMessage).toContain('The whole of Act');
  });

  it('goes again after a turn that failed, which may not have read it', async () => {
    const { conversation, sent, next } = counted();

    next.failed = true;
    await expect(wake(conversation, act)).rejects.toThrow(PlannerTurnFailedError);
    next.failed = false;
    await wake(conversation, act);

    expect(sent[1]).toContain('The whole of Act');
  });

  it('keeps a turn on many waiting updates inside the wake cap', async () => {
    const { conversation, sent } = counted();

    const older = `Run update:\n- task #1 "Build" failed: boom\n  ${'a'.repeat(14_000)}`;
    await conversation.reply('', { wakeUps: [older, 'b'.repeat(14_000)], wakeUp: { readBudget: 3, refused: () => undefined } });

    expect(sent[0]).toContain('b'.repeat(14_000));
    expect(sent[0]).not.toContain('a'.repeat(14_000));
    expect(sent[0]).toContain('+1 earlier run update left out; task_query reads these tasks:\n- task #1 "Build" failed: boom');
  });

  it('counts the prompt cache from the turn that opened, and from nothing once its context is gone', async () => {
    const { conversation, ai } = counted();
    expect(conversation.lastRequestAt).toBeNull();

    const before = Date.now();
    await wake(conversation, act);
    expect(conversation.lastRequestAt).toBeGreaterThanOrEqual(before);

    conversation.reset();
    expect(conversation.lastRequestAt).toBeNull();
    expect(ai.reset).toHaveBeenCalled();
  });
});

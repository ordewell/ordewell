import { describe, expect, it, vi } from 'vitest';
import type { ConversationTurn, IAiService } from '../AiService';
import type { DecisionRecordEntry, LegacyPlanState } from '../../models/Task';
import { PlannerConversation, type PlannerConversationHost, type PlannerConversationOptions } from '../PlannerConversation';
import { fakePlanChanges } from './planChangesTestKit';
import type { TurnFailure } from '../runnerExit';

/** A plan three exchanges long, so a compaction has something to condense. */
function longPlan(record?: DecisionRecordEntry[]): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: '2026-01-01T00:00:00Z',
    conversationHistory: [
      { role: 'user', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Which file formats?', timestamp: '2026-01-01T00:00:01Z' },
      { role: 'user', content: 'JSON only. Never add a runtime dependency.', timestamp: '2026-01-01T00:00:02Z' },
      { role: 'assistant', content: 'Streaming or not?', timestamp: '2026-01-01T00:00:03Z' },
      { role: 'user', content: 'Streaming', timestamp: '2026-01-01T00:00:04Z' },
      { role: 'assistant', content: 'Noted.', timestamp: '2026-01-01T00:00:05Z' },
    ],
    researchLog: [],
    ...(record ? { decisionRecord: record } : {}),
  };
}

const entry = (id: string, kind: DecisionRecordEntry['kind'], text: string, at: number, why?: string): DecisionRecordEntry => ({ id, kind, text, at, timestamp: '2026-01-01T00:00:06Z', ...(why ? { why } : {}) });

/** A planner whose every message is kept, and whose turns can call the record tool while they run. */
function planner(plan: LegacyPlanState, options?: PlannerConversationOptions) {
  const sent: string[] = [];
  const during: Array<(() => Promise<void>) | undefined> = [];
  let compactions = 0;
  const ai = {
    startConversation: vi.fn(),
    continueConversation: vi.fn(async (message: string): Promise<ConversationTurn> => {
      sent.push(message);
      await during.shift()?.();
      return /asked to condense this planning conversation/.test(message)
        ? { kind: 'message', text: '<conversation_summary>\nThe parser plan is half drafted; the planner waits on the user\'s pick of a streaming API.\n</conversation_summary>', researchLog: [] }
        : { kind: 'message', text: 'ok', researchLog: [] };
    }),
    hasActiveConversation: () => true,
    reset: vi.fn(),
    compactions: () => compactions,
  } as unknown as IAiService;
  const state = { plan };
  const checks = fakePlanChanges({ tasks: () => state.plan.tasks, runners: () => ['claude-code'], catalog: () => ({ modelsByRunner: {} }) });
  const host: PlannerConversationHost = {
    plan: () => state.plan,
    goal: () => 'build me a parser',
    aiService: () => ai,
    onProgress: vi.fn(),
    opening: vi.fn().mockResolvedValue({ runners: ['claude-code'], modelsByRunner: {}, fs: {} }),
    catalog: () => ({ runners: ['claude-code'], models: {}, modes: {}, autonomousDefault: true }),
    assignmentScope: () => ({ enabledRunners: ['claude-code'], allowlist: {} }),
    autorun: () => false,
    tasks: () => state.plan.tasks,
    startWaits: () => [],
    liveOutput: () => null,
    isExecuting: () => false,
    mutate: (op, notify) => {
      if (!op()) return null;
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
  const conversation = new PlannerConversation(host, options);
  /** The next turn records `inputs` while it runs, keeping what the call answered. */
  const recordsDuring = (inputs: Parameters<PlannerConversation['recordFromTool']>[0]) => {
    const answer: { value?: Awaited<ReturnType<PlannerConversation['recordFromTool']>> } = {};
    during.push(async () => { answer.value = conversation.recordFromTool(inputs, conversation.currentTurnId); });
    return answer;
  };
  return { conversation, host, state, sent, recordsDuring, compact: () => { compactions++; } };
}

describe('the planner records as it goes', () => {
  it('keeps each entry on the plan, where the turn that made it was asked, and shows the plan again', async () => {
    const { conversation, state, host, recordsDuring } = planner(longPlan());
    const answer = recordsDuring([
      { kind: 'decision', text: 'Use a SAX-style streaming parser', why: 'the user wants streaming' },
      { kind: 'constraint', text: 'Never add a runtime dependency.' },
    ]);

    await conversation.reply('Go with streaming then.');

    expect(answer.value).toMatchObject({ ok: true, added: [{ id: 'D1' }, { id: 'C1' }] });
    expect(state.plan.decisionRecord).toEqual([
      expect.objectContaining({ id: 'D1', kind: 'decision', at: 6, why: 'the user wants streaming' }),
      expect.objectContaining({ id: 'C1', kind: 'constraint', at: 6, text: 'Never add a runtime dependency.' }),
    ]);
    expect(state.plan.conversationHistory![6].content).toBe('Go with streaming then.');
    expect(host.broadcastPlan).toHaveBeenCalled();
  });

  it('takes a constraint the open turn\'s own message states, before that message lands', async () => {
    const { conversation, state, recordsDuring } = planner(longPlan());
    const answer = recordsDuring([{ kind: 'constraint', text: 'Keep it under 500 lines.' }]);

    await conversation.reply('Keep it under 500 lines.');

    expect(answer.value).toMatchObject({ ok: true });
    expect(state.plan.decisionRecord?.[0].text).toBe('Keep it under 500 lines.');
  });

  it('records nothing for a turn that is not open', () => {
    const { conversation, state } = planner(longPlan());

    expect(conversation.recordFromTool([{ kind: 'question', text: 'Which API?' }], 'turn-gone')).toEqual({ ok: false, errors: [expect.stringMatching(/turn/i)] });
    expect(state.plan.decisionRecord).toBeUndefined();
  });

  it('refuses a batch whole, saving none of it', async () => {
    const { conversation, state, recordsDuring } = planner(longPlan());
    const answer = recordsDuring([{ kind: 'question', text: 'Which API?' }, { kind: 'decision', text: 'SAX' }]);

    await conversation.reply('carry on');

    expect(answer.value).toEqual({ ok: false, errors: ['Entry 2: a decision needs its why.'] });
    expect(state.plan.decisionRecord).toBeUndefined();
  });

  it('keeps no secret\'s value in the record (ADR-0061 P1)', async () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const { conversation, state, recordsDuring } = planner(longPlan(), { heldSecrets: () => [{ name: 'OPENROUTER_API_KEY', value: key }] });
    recordsDuring([{ kind: 'decision', text: `Read ${key} from the environment`, why: 'never inline it' }]);

    await conversation.reply('carry on');

    expect(state.plan.decisionRecord?.[0].text).toBe('Read [secret held as OPENROUTER_API_KEY] from the environment');
  });
});

describe('the record as the planner is told it', () => {
  const saved = [
    entry('D1', 'decision', 'Use a SAX-style streaming parser', 4, 'the user wants streaming'),
    entry('C1', 'constraint', 'Never add a runtime dependency.', 2),
  ];

  it('goes whole into a fresh context once, then only as what changed', async () => {
    const { conversation, sent, recordsDuring } = planner(longPlan(saved));

    await conversation.reply('first');
    recordsDuring([{ kind: 'rejected', text: 'A DOM parser', why: 'it holds the whole file' }]);
    await conversation.reply('second');
    await conversation.reply('third');

    expect(sent[0]).toContain([
      '<decision_record>',
      'Decisions:',
      '- D1: Use a SAX-style streaming parser. Why: the user wants streaming',
      'Constraints, in the user\'s words:',
      '- C1: "Never add a runtime dependency."',
      '</decision_record>',
    ].join('\n'));
    // What the planner recorded itself it was answered with; nothing is told back.
    for (const later of sent.slice(1)) expect(later).not.toMatch(/<decision_record/);
  });

  it('goes whole again once the backend compacted the context it was told in', async () => {
    const { conversation, sent, compact } = planner(longPlan(saved));

    await conversation.reply('first');
    compact();
    await conversation.reply('second');

    expect(sent[1]).toContain('<decision_record>');
  });
});

describe('a checkpoint seeds the next context with the record', () => {
  const saved = [
    entry('Q1', 'question', 'Which streaming API?', 2),
    entry('C1', 'constraint', 'Never add a runtime dependency.', 2),
    entry('D1', 'decision', 'Stream with a pull parser', 4, 'the user asked for streaming'),
    entry('R1', 'rejected', 'A DOM parser', 4, 'it holds the whole file'),
  ];

  it('restates the record, the constraints verbatim, then where things stand', async () => {
    const { conversation, state, sent } = planner(longPlan(saved));

    await conversation.compact();

    const checkpoint = state.plan.conversationHistory!.at(-1)!;
    expect(checkpoint.checkpoint).toMatchObject({ trigger: 'manual', record: 4 });
    expect(checkpoint.content).toContain([
      '<decision_record>',
      'Decisions:',
      '- D1: Stream with a pull parser. Why: the user asked for streaming',
      'Constraints, in the user\'s words:',
      '- C1: "Never add a runtime dependency."',
      'Rejected:',
      '- R1: A DOM parser. Why: it holds the whole file',
      'Open questions:',
      '- Q1: Which streaming API?',
      '</decision_record>',
      '',
      'Where we are:',
      'The parser plan is half drafted; the planner waits on the user\'s pick of a streaming API.',
    ].join('\n'));
    // The summary is asked for beside the record, so it need not restate it.
    expect(sent[0]).toContain('- C1: "Never add a runtime dependency."');
    expect(sent[0]).toMatch(/restated whole beside your summary/);
  });

  it('is what the next context holds of the record: only what came after is told', async () => {
    const { conversation, state, sent, recordsDuring } = planner(longPlan(saved));

    await conversation.compact();
    await conversation.reply('next');
    recordsDuring([{ kind: 'decision', text: 'Use the pull parser from the standard library', why: 'no new dependency', supersedes: 'Q1' }]);
    await conversation.reply('and then');
    await conversation.reply('one more');
    await conversation.compact();
    await conversation.reply('after the second');

    expect(sent[1]).not.toMatch(/<decision_record/);
    const second = state.plan.conversationHistory!.at(-3)!;
    expect(second.checkpoint).toMatchObject({ record: 5 });
    expect(second.content).toContain('- D2: Use the pull parser from the standard library. Why: no new dependency');
    expect(second.content).not.toContain('Which streaming API?');
    expect(sent.at(-1)).not.toMatch(/<decision_record/);
  });

  it('keeps today\'s notice when the record is empty', async () => {
    const { conversation, state } = planner(longPlan());

    await conversation.compact();

    const checkpoint = state.plan.conversationHistory!.at(-1)!;
    expect(checkpoint.content).not.toContain('Where we are:');
    expect(checkpoint.checkpoint).not.toHaveProperty('record');
  });
});

describe('the record through a fork or a rewind', () => {
  it('carries all of it into a fork, and only what came before the rewound message', () => {
    const record = [entry('Q1', 'question', 'Which streaming API?', 2), entry('D1', 'decision', 'Pull parser', 4, 'streaming')];
    const { conversation } = planner(longPlan(record));

    expect(conversation.clone().decisionRecord).toEqual(record);
    expect(conversation.cloneBefore(4).dialogue.decisionRecord).toEqual([record[0]]);
  });
});

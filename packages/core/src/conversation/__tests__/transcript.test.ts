import { describe, it, expect } from 'vitest';
import type { ConversationMessage, ResearchLogEntry } from '../../models/Task';
import { fromTranscript } from '../transcript';
import { reduceConversation } from '../reduce';
import { planSnapshot } from './fixtures/turns';
import { unkeyed } from './helpers';

const step = (id: string, timestamp: string, fields: { tool: 'read_file' | 'spawn_research_agent'; args: string; result: string; toolCallId?: string; subagentId?: string }): ResearchLogEntry => ({
  id, timestamp, success: true, outcome: 'success', ...fields,
});

describe('fromTranscript', () => {
  const shape = (b: ReturnType<typeof unkeyed>[number]) => (b.type === 'message' ? `${b.role}: ${b.text}` : b.type === 'tool' ? `tool: ${b.headline.keyArg}` : b.type);

  it('puts each run of a reply at the time it began, among the calls between them', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'what does README.md start with?', timestamp: '2026-09-27T10:00:00.000Z' },
      {
        role: 'assistant', content: 'I\'ll read README.md now.\n\nThe first line of README.md is "hello".', timestamp: '2026-09-27T10:00:09.000Z',
        runs: [
          { segmentId: 's1', text: 'I\'ll read README.md now.', startedAt: '2026-09-27T10:00:01.000Z' },
          { segmentId: 's2', text: 'The first line of README.md is "hello".', startedAt: '2026-09-27T10:00:05.000Z' },
        ],
      },
    ];
    const log: ResearchLogEntry[] = [
      { id: 'up-1', type: 'user_prompt', content: 'what does README.md start with?', timestamp: '2026-09-27T10:00:00.000Z' },
      step('rs-1', '2026-09-27T10:00:03.000Z', { tool: 'read_file', args: '{"path":"README.md"}', result: 'hello', toolCallId: 'toolu_1' }),
    ];

    expect(unkeyed(fromTranscript(history, log).blocks).map(shape)).toEqual([
      'user: what does README.md start with?',
      'planner: I\'ll read README.md now.',
      'tool: README.md',
      'planner: The first line of README.md is "hello".',
    ]);
  });

  it('draws a reply saved before runs were kept as one message, after the research it settled', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'what does README.md start with?', timestamp: '2026-09-27T10:00:00.000Z' },
      { role: 'assistant', content: 'I\'ll read README.md now.\n\nThe first line of README.md is "hello".', timestamp: '2026-09-27T10:00:09.000Z' },
    ];
    const log: ResearchLogEntry[] = [
      step('rs-1', '2026-09-27T10:00:03.000Z', { tool: 'read_file', args: '{"path":"README.md"}', result: 'hello', toolCallId: 'toolu_1' }),
    ];

    expect(unkeyed(fromTranscript(history, log).blocks)).toEqual([
      { type: 'message', role: 'user', text: 'what does README.md start with?', streaming: false },
      expect.objectContaining({ type: 'tool', status: 'ok' }),
      { type: 'message', role: 'planner', text: 'I\'ll read README.md now.\n\nThe first line of README.md is "hello".', streaming: false },
    ]);
  });

  it('draws a planner turn that ended on its usage limit as a failure, live and on reload', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'build it', timestamp: '2026-10-11T10:00:00Z' },
      { role: 'assistant', content: 'claude-code usage limit, resets 3pm. Resending at 3:01pm; anything you send meanwhile goes with it.', timestamp: '2026-10-11T10:00:05Z', kind: 'error' },
    ];
    const failure = { type: 'message', role: 'error', text: 'claude-code usage limit, resets 3pm. Resending at 3:01pm; anything you send meanwhile goes with it.', streaming: false };

    expect(unkeyed(fromTranscript(history, []).blocks).at(-1)).toEqual(failure);
    const live = reduceConversation(fromTranscript(history.slice(0, 1), []), planSnapshot(history));
    expect(unkeyed(live.blocks).at(-1)).toEqual(failure);
  });

  it('shows pending inputs after the landed transcript, with skill notices and run updates in arrival order', () => {
    const view = fromTranscript([
      { role: 'assistant', content: 'Ready.', timestamp: '2026-10-11T10:00:00Z' },
    ], [], { totals: { inputTokens: 10 } }, [
      { id: 'p1', source: 'user', text: '/tdd add tests', timestamp: '2026-10-11T10:01:00Z', skills: [
        { invokedBy: 'user', name: 'tdd', source: 'global', path: '~/.ordewell/skills/tdd/SKILL.md' },
      ] },
      { id: 'p2', source: 'supervisor', text: 'Run update: task 1 failed', timestamp: '2026-10-11T10:01:01Z' },
      { id: 'p3', source: 'user', text: 'check task 2 too', timestamp: '2026-10-11T10:01:02Z' },
    ]);

    expect(unkeyed(view.blocks)).toEqual([
      { type: 'message', role: 'planner', text: 'Ready.', streaming: false },
      { type: 'message', role: 'user', text: '/tdd add tests', streaming: false, skills: ['tdd'] },
      { type: 'skill_load', invokedBy: 'user', name: 'tdd', source: 'global', path: '~/.ordewell/skills/tdd/SKILL.md' },
      { type: 'message', role: 'wake_up', text: 'Run update: task 1 failed', streaming: false },
      { type: 'message', role: 'user', text: 'check task 2 too', streaming: false },
      { type: 'usage', totals: { inputTokens: 10 } },
    ]);
  });

  it('opens a condensed conversation on its summary, without the research of the turns it replaced', () => {
    const history: ConversationMessage[] = [
      { role: 'assistant', content: 'Conversation condensed.\n\nGoal: ship it.', timestamp: '2026-09-27T12:00:00.000Z', kind: 'compaction' },
      { role: 'user', content: 'and tests?', timestamp: '2026-09-27T11:00:00.000Z' },
      { role: 'assistant', content: 'Vitest, colocated.', timestamp: '2026-09-27T11:00:09.000Z' },
    ];
    const log: ResearchLogEntry[] = [
      step('rs-old', '2026-09-27T10:00:03.000Z', { tool: 'read_file', args: '{"path":"old.ts"}', result: 'old' }),
      { id: 'up-1', type: 'user_prompt', content: 'and tests?', timestamp: '2026-09-27T11:00:00.000Z' },
      step('rs-new', '2026-09-27T11:00:04.000Z', { tool: 'read_file', args: '{"path":"vitest.config.ts"}', result: 'export default {}' }),
    ];

    expect(unkeyed(fromTranscript(history, log).blocks).map((b) => (b.type === 'message' ? `${b.role}: ${b.text}` : b.type === 'tool' ? `tool: ${b.headline.keyArg}` : b.type === 'compaction' ? `compaction: ${b.summary}` : b.type))).toEqual([
      'compaction: Conversation condensed.\n\nGoal: ship it.',
      'user: and tests?',
      'tool: vitest.config.ts',
      'planner: Vitest, colocated.',
    ]);
  });

  it('keeps every message and research step of a checkpointed compaction, which stands where it was made as the block the live view drew', () => {
    const summary = 'Conversation condensed.\n\nGoal: ship it.';
    const history: ConversationMessage[] = [
      { role: 'user', content: 'ship it', timestamp: '2026-09-27T10:00:00.000Z' },
      { role: 'assistant', content: 'On it.', timestamp: '2026-09-27T10:00:09.000Z' },
      { role: 'user', content: 'and tests?', timestamp: '2026-09-27T11:00:00.000Z' },
      { role: 'assistant', content: 'Vitest, colocated.', timestamp: '2026-09-27T11:00:09.000Z' },
      { role: 'assistant', content: summary, timestamp: '2026-09-27T12:00:00.000Z', kind: 'compaction', checkpoint: { id: 'c1', keptFrom: 2, trigger: 'manual' } },
    ];
    const log: ResearchLogEntry[] = [step('rs-old', '2026-09-27T10:00:03.000Z', { tool: 'read_file', args: '{"path":"old.ts"}', result: 'old' })];

    const reloaded = fromTranscript(history, log);

    expect(unkeyed(reloaded.blocks).map((b) => (b.type === 'message' ? `${b.role}: ${b.text}` : b.type === 'tool' ? `tool: ${b.headline.keyArg}` : b.type))).toEqual([
      'user: ship it', 'tool: old.ts', 'planner: On it.', 'user: and tests?', 'planner: Vitest, colocated.', 'compaction',
    ]);
    expect(unkeyed(reloaded.blocks).at(-1)).toEqual({ type: 'compaction', compactionId: 'c1', origin: 'ordewell', trigger: 'manual', status: 'condensed', summary });
    // The live end of the same compaction folds into the reloaded block, not beside it.
    const lateEnd = reduceConversation(reloaded, { type: 'planner_compaction', compaction: { phase: 'ended', id: 'c1', origin: 'ordewell', trigger: 'manual', outcome: 'condensed', at: '2026-09-27T12:00:01.000Z' } });
    expect(lateEnd).toBe(reloaded);
  });

  it('adopts replayed pending inputs once when their batched turn starts and lands', () => {
    const skill = { invokedBy: 'user' as const, name: 'tdd', source: 'global' as const, path: '~/tdd/SKILL.md' };
    const pending = [
      { id: 'p1', source: 'user' as const, text: '/tdd add tests', timestamp: '2026-10-11T10:01:00Z', skills: [skill] },
      { id: 'p2', source: 'supervisor' as const, text: 'Run update: task 1 failed', timestamp: '2026-10-11T10:01:01Z' },
      { id: 'p3', source: 'user' as const, text: 'check task 2 too', timestamp: '2026-10-11T10:01:02Z' },
    ];
    const history: ConversationMessage[] = [
      { role: 'user', content: 'Run update: task 1 failed', timestamp: '2026-10-11T10:02:00Z', kind: 'wake_up' },
      { role: 'user', content: '/tdd add tests\n\ncheck task 2 too', timestamp: '2026-10-11T10:02:00Z' },
      { role: 'user', content: '/tdd skill loaded', timestamp: '2026-10-11T10:02:00Z', kind: 'skill_load', skill: { ...skill, content: 'HIDDEN' } },
      { role: 'assistant', content: 'Done.', timestamp: '2026-10-11T10:02:05Z' },
    ];
    let live = fromTranscript([], [], undefined, pending);
    live = reduceConversation(live, { type: 'planner_turn_started', turnId: 't1', prompt: '/tdd add tests\n\ncheck task 2 too', skills: [skill], wakeUps: ['Run update: task 1 failed'] });
    live = reduceConversation(live, { type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Done.' });
    live = reduceConversation(live, { type: 'planner_message', turnId: 't1', content: 'Done.', timestamp: '2026-10-11T10:02:05Z' });
    live = reduceConversation(live, planSnapshot(history));
    live = reduceConversation(live, { type: 'status_update', tasks: [] });
    live = reduceConversation(live, { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' });

    expect(live.blocks.map((b) => b.type === 'message' ? `${b.role}: ${b.text}` : b.type)).toEqual([
      'user: /tdd add tests', 'skill_load', 'wake_up: Run update: task 1 failed', 'user: check task 2 too', 'planner: Done.',
    ]);
    expect(fromTranscript(history, [], undefined, []).blocks.map((b) => b.type === 'message' ? `${b.role}: ${b.text}` : b.type)).toEqual([
      'wake_up: Run update: task 1 failed', 'user: /tdd add tests\n\ncheck task 2 too', 'skill_load', 'planner: Done.',
    ]);
  });

  it('draws the goal of an unanswered opening sent again once, as the line its pending input and its turn take over', () => {
    const skill = { invokedBy: 'user' as const, name: 'tdd', source: 'global' as const, path: '~/tdd/SKILL.md' };
    const opening: ConversationMessage[] = [
      { role: 'user', content: '/tdd add a login page', timestamp: '2026-10-11T10:00:00Z' },
      { role: 'user', content: '/tdd skill loaded', timestamp: '2026-10-11T10:00:00Z', kind: 'skill_load', skill: { ...skill, content: 'HIDDEN' } },
      { role: 'assistant', content: 'The planner failed.', timestamp: '2026-10-11T10:00:05Z', kind: 'error' },
    ];
    const pending = [{ id: 'p1', source: 'user' as const, text: '/tdd add a login page', timestamp: '2026-10-11T10:01:00Z', skills: [skill] }];
    const lines = (view: ReturnType<typeof fromTranscript>) => view.blocks.map((b) => b.type === 'message' ? `${b.role}: ${b.text}` : b.type);

    let live = fromTranscript(opening, [], undefined, pending);
    expect(lines(live)).toEqual(['user: /tdd add a login page', 'skill_load', 'error: The planner failed.']);

    const landed: ConversationMessage[] = [...opening, { role: 'assistant', content: 'Planned.', timestamp: '2026-10-11T10:01:05Z' }];
    live = reduceConversation(live, { type: 'planner_turn_started', turnId: 't2', prompt: '/tdd add a login page', skills: [skill] });
    live = reduceConversation(live, { type: 'planner_message', turnId: 't2', content: 'Planned.', timestamp: '2026-10-11T10:01:05Z' });
    live = reduceConversation(live, planSnapshot(landed));
    live = reduceConversation(live, { type: 'planner_turn_ended', turnId: 't2', outcome: 'message' });
    expect(lines(live)).toEqual(['user: /tdd add a login page', 'skill_load', 'error: The planner failed.', 'planner: Planned.']);
    expect(live.pendingInputs ?? []).toEqual([]);

    // A goal the planner answered is a new message when sent again.
    expect(lines(fromTranscript(landed, [], undefined, pending))).toEqual([
      'user: /tdd add a login page', 'skill_load', 'error: The planner failed.', 'planner: Planned.', 'user: /tdd add a login page', 'skill_load',
    ]);
  });

  it('keeps a spawn call no subagent record claims as an ordinary row, as sessions saved before subagents were logged have it', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'survey', timestamp: '2026-09-27T10:00:00.000Z' },
      { role: 'assistant', content: 'Surveyed.', timestamp: '2026-09-27T10:00:30.000Z' },
    ];
    const log: ResearchLogEntry[] = [
      step('rs-1', '2026-09-27T10:00:20.000Z', { tool: 'spawn_research_agent', args: '{"prompt":"Survey auth"}', result: 'Auth: src/auth', toolCallId: 'c1' }),
    ];

    expect(unkeyed(fromTranscript(history, log).blocks)).toEqual([
      { type: 'message', role: 'user', text: 'survey', streaming: false },
      {
        type: 'tool', toolCallId: 'c1', tool: 'spawn_research_agent', headline: { name: 'Agent', keyArg: 'Survey auth' }, args: '{"prompt":"Survey auth"}',
        status: 'ok', outcome: 'success', output: 'Auth: src/auth', outputLineCount: 1,
      },
      { type: 'message', role: 'planner', text: 'Surveyed.', streaming: false },
    ]);
  });

  it('reopens a wake-up turn as it was drawn live: the run update, then the supervisor in its own role', () => {
    const view = fromTranscript([
      { role: 'user', content: 'build it', timestamp: '2026-10-11T10:00:00Z' },
      { role: 'user', content: 'Run update:\n- task #1 failed', timestamp: '2026-10-11T10:05:00Z', kind: 'wake_up' },
      { role: 'assistant', content: 'Task 1 failed; retry it?', timestamp: '2026-10-11T10:05:00Z', kind: 'supervisor' },
    ], []);

    expect(view.blocks.map((b) => (b.type === 'message' ? b.role : b.type))).toEqual(['user', 'wake_up', 'supervisor']);
  });

  it('accounts for inputs landed without seeing the turn start, while leaving later pending arrivals for their turn', () => {
    let view = fromTranscript([], [], undefined, [
      { id: 'p1', source: 'user', text: 'check tests', timestamp: '2026-10-11T10:00:00Z' },
      { id: 'p2', source: 'user', text: 'check lint', timestamp: '2026-10-11T10:00:01Z' },
    ]);
    view = reduceConversation(view, { type: 'planner_message', content: 'Tests passed.', timestamp: '2026-10-11T10:00:02Z', turnId: 't1' });
    view = reduceConversation(view, planSnapshot([
      { role: 'user', content: 'check tests', timestamp: '2026-10-11T10:00:00Z' },
      { role: 'assistant', content: 'Tests passed.', timestamp: '2026-10-11T10:00:02Z' },
    ]));
    view = reduceConversation(view, { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' });
    view = reduceConversation(view, { type: 'planner_turn_started', turnId: 't2', prompt: 'check lint' });
    view = reduceConversation(view, { type: 'planner_turn_ended', turnId: 't2', outcome: 'message' });
    view = reduceConversation(view, { type: 'planner_turn_started', turnId: 't3', prompt: 'check tests' });

    expect(view.blocks.flatMap((b) => b.type === 'message' && b.role === 'user' ? [b.text] : [])).toEqual(['check tests', 'check lint', 'check tests']);
  });

  it('reads an empty or missing record as an empty conversation, and shows no token line with nothing measured', () => {
    expect(fromTranscript(undefined, undefined).blocks).toEqual([]);
    expect(fromTranscript([], [], { totals: {} }).blocks).toEqual([]);
  });

  it('adopts a pending wake-up replay without inventing an empty user message', () => {
    const view = fromTranscript([], [], undefined, [
      { id: 'p1', source: 'supervisor', text: 'Run update: task 1 failed', timestamp: '2026-10-11T10:00:00Z' },
    ]);
    const replayed = reduceConversation(view, { type: 'planner_turn_started', turnId: 't1', prompt: '', wakeUps: ['Run update: task 1 failed'], supervisor: true });

    expect(unkeyed(replayed.blocks)).toEqual([
      { type: 'message', role: 'wake_up', text: 'Run update: task 1 failed', streaming: false, turnId: 't1' },
    ]);
  });

  it('carries on live from where the reload left off, taking only what the transcript adds after it', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'plan it', timestamp: '2026-09-27T10:00:00.000Z' },
      { role: 'assistant', content: 'Plan generated with 3 tasks.', timestamp: '2026-09-27T10:00:30.000Z', kind: 'plan_generated' },
    ];
    const reloaded = fromTranscript(history, [], { totals: { inputTokens: 10 } });

    expect(reduceConversation(reloaded, planSnapshot(history, 3))).toBe(reloaded);

    const updated = reduceConversation(reloaded, planSnapshot([
      ...history,
      { role: 'user', content: 'merge 1 and 2', timestamp: '2026-09-27T10:01:00.000Z' },
      { role: 'assistant', content: 'Plan updated — now 2 tasks.', timestamp: '2026-09-27T10:01:05.000Z', kind: 'plan_generated' },
    ], 2));
    expect(unkeyed(updated.blocks)).toEqual([
      { type: 'message', role: 'user', text: 'plan it', streaming: false },
      { type: 'plan', status: 'generated', text: '', taskCount: 3 },
      { type: 'plan', status: 'updated', text: '', taskCount: 2 },
      { type: 'usage', totals: { inputTokens: 10 } },
    ]);
    expect(new Set(updated.blocks.map((b) => b.id)).size).toBe(4);
  });
  it('shows a legacy message whose skill was spliced in as it was saved', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: '# Grilling\n\nThe whole SKILL.md', timestamp: '2026-09-27T10:00:00.000Z' },
      { role: 'assistant', content: 'Question?', timestamp: '2026-09-27T10:00:05.000Z' },
    ];
    expect(unkeyed(fromTranscript(history, []).blocks)).toEqual([
      { type: 'message', role: 'user', text: '# Grilling\n\nThe whole SKILL.md', streaming: false },
      { type: 'message', role: 'planner', text: 'Question?', streaming: false },
    ]);
  });

  it('shows the notice under a kept message of a condensed conversation, with no chip on the summary', () => {
    const skill = { invokedBy: 'user' as const, name: 'grilling', source: 'global' as const, path: '~/.ordewell/skills/grilling/SKILL.md', content: 'HIDDEN BODY' };
    const history: ConversationMessage[] = [
      { role: 'assistant', content: 'Conversation condensed.', timestamp: '2026-09-27T12:00:00.000Z', kind: 'compaction' },
      { role: 'user', content: '/grilling and tests?', timestamp: '2026-09-27T11:00:00.000Z' },
      { role: 'user', content: '/grilling skill loaded', timestamp: '2026-09-27T11:00:00.000Z', kind: 'skill_load', skill },
      { role: 'assistant', content: 'Vitest.', timestamp: '2026-09-27T11:00:09.000Z' },
    ];

    const blocks = unkeyed(fromTranscript(history, []).blocks);

    expect(blocks).toEqual([
      { type: 'compaction', origin: 'ordewell', trigger: 'manual', status: 'condensed', summary: 'Conversation condensed.' },
      { type: 'message', role: 'user', text: '/grilling and tests?', streaming: false, skills: ['grilling'] },
      { type: 'skill_load', invokedBy: 'user', name: 'grilling', source: 'global', path: '~/.ordewell/skills/grilling/SKILL.md' },
      { type: 'message', role: 'planner', text: 'Vitest.', streaming: false },
    ]);
    expect(JSON.stringify(blocks)).not.toContain('HIDDEN BODY');
  });
});

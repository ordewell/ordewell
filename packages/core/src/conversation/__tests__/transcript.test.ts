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

    expect(unkeyed(fromTranscript(history, log).blocks).map((b) => (b.type === 'message' ? `${b.role}: ${b.text}` : b.type === 'tool' ? `tool: ${b.headline.keyArg}` : b.type))).toEqual([
      'system: Conversation condensed.\n\nGoal: ship it.',
      'user: and tests?',
      'tool: vitest.config.ts',
      'planner: Vitest, colocated.',
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

  it('reads an empty or missing record as an empty conversation, and shows no token line with nothing measured', () => {
    expect(fromTranscript(undefined, undefined).blocks).toEqual([]);
    expect(fromTranscript([], [], { totals: {} }).blocks).toEqual([]);
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
});

import { describe, it, expect, vi } from 'vitest';
import { ReplySplitter } from '../replyStream';
import { classifyPlannerReply } from '../PlanRepair';
import { createTask, type ResearchProgress } from '../../models/Task';
import type { ConversationRequest } from '../AiService';
import type { SessionMessage } from '../SessionMessage';
import { reduceConversation, EMPTY_CONVERSATION } from '../../conversation/reduce';
import { makeSession } from './sessionTestKit';

function route(splitter: ReplySplitter, segmentId: string, deltas: string[]) {
  return deltas.map((d) => splitter.push(segmentId, d));
}

describe('ReplySplitter', () => {
  it('holds leading whitespace back, then streams a prose segment as text', () => {
    const splitter = new ReplySplitter();

    expect(route(splitter, 's1', ['\n ', 'Which ', 'store?'])).toEqual([
      null,
      { route: 'text', text: '\n Which ' },
      { route: 'text', text: 'store?' },
    ]);
  });

  it('routes a segment that opens with an object to the plan display, all of it', () => {
    const splitter = new ReplySplitter();

    expect(route(splitter, 's1', [' ', '{"tasks":', '[]}\n', 'Done.'])).toEqual([
      null,
      { route: 'plan', text: ' {"tasks":' },
      { route: 'plan', text: '[]}\n' },
      { route: 'plan', text: 'Done.' },
    ]);
  });

  // Streamed one character at a time: the worst split a provider can deliver,
  // and the one that lands a delta boundary inside every fence and tag.
  it.each([
    ['a json-fenced taskOps envelope', '```json\n{"taskOps":[{"op":"remove","taskId":"#2"}]}\n```', 'plan', 'task_ops'],
    ['a bare-fenced taskQuery envelope', '```\n{"taskQuery":{"tasks":["#1"]}}\n```', 'plan', 'task_query'],
    ['a plan cut off inside an upper-case fence', '```JSON {"tasks": [{"id": "t1", "title": "Ad', 'plan', 'broken_plan'],
    ['an envelope after an inline think block', '<think>they want task 1</think>\n{"taskQuery":{"tasks":["#1"]}}', 'plan', 'task_query'],
    ['a code block that opens a prose answer', '```ts\nconst store = new Map();\n```\nThat is the whole cache.', 'text', 'prose'],
    ['a fence whose language only starts like json', '```jsonc\n// no\n```', 'text', 'prose'],
    ['prose that mentions a brace', 'Sure — `{` opens the object.', 'text', 'prose'],
  ])('agrees with the reply classifier on %s', (_label, reply, expectedRoute, expectedKind) => {
    const splitter = new ReplySplitter();
    const routed = [...reply].map((ch) => splitter.push('s1', ch)).filter((d) => d !== null);

    expect(classifyPlannerReply(reply, { runners: ['claude-code'] }).kind).toBe(expectedKind);
    expect(new Set(routed.map((d) => d.route))).toEqual(new Set([expectedRoute]));
    expect(routed.map((d) => d.text).join('')).toBe(reply);
  });

  it('keeps segments apart', () => {
    const splitter = new ReplySplitter();

    expect(splitter.push('s1', 'Let me look.')).toEqual({ route: 'text', text: 'Let me look.' });
    expect(splitter.push('s2', '{"taskOps":[]}')).toEqual({ route: 'plan', text: '{"taskOps":[]}' });
    expect(splitter.push('s1', ' More.')).toEqual({ route: 'text', text: ' More.' });
  });
});

describe('TurnStream', () => {
  // The session, its turn stream and the view, with the backend faked at the
  // `IAiService` seam: the progress below is what a backend settling through
  // `settleReply` sends for a botched plan and its corrected re-emit.
  it('leaves only the corrected plan in the building display once the botched attempt is taken back', async () => {
    const broken = '{"tasks": [{"title": "Add the SQLite store"';
    const corrected = '{"tasks": [{"title": "Add the store"}, {"title": "Migrate"}]}';
    const sent: SessionMessage[] = [];
    const session = makeSession({
      broadcast: (msg) => sent.push(msg),
      aiService: {
        startConversation: vi.fn(async (req: ConversationRequest) => {
          const progress: ResearchProgress[] = [
            { type: 'text_delta', segmentId: 's1', text: broken },
            { type: 'text_retracted' },
            { type: 'text_delta', segmentId: 's2', text: corrected },
          ];
          for (const p of progress) req.onProgress(p);
          return {
            kind: 'plan' as const,
            tasks: [createTask({ id: 't1', order: 1, title: 'Add the store', prompt: 'p', assignedRunner: 'claude-code' })],
            text: corrected,
            researchLog: [],
          };
        }),
        hasActiveConversation: () => true,
      },
    });

    await session.startPlanning('add persistence', ['claude-code']);

    const streamed = sent.slice(0, sent.findIndex((m) => m.type === 'plan_generated'));
    const building = streamed.reduce(reduceConversation, EMPTY_CONVERSATION).blocks.filter((b) => b.type === 'plan');
    expect(building).toEqual([expect.objectContaining({ status: 'building', text: corrected })]);
  });
});

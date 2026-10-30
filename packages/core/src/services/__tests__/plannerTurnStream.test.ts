import { describe, it, expect, vi } from 'vitest';
import type { ConversationRequest, ConversationTurn } from '../AiService';
import type { SessionMessage } from '../SessionMessage';
import type { ResearchProgress } from '../../models/Task';
import { makeSession } from './sessionTestKit';

/**
 * A planner turn as the surfaces see it (#48): the Session's broadcasts, with
 * the backend faked at the `IAiService` seam so the stream a turn produces is
 * scripted exactly.
 */

type Streamed = Exclude<SessionMessage, { type: 'plan_generated' | 'status_update' }>;

function turnSession(stream: ResearchProgress[], turn: ConversationTurn) {
  const sent: SessionMessage[] = [];
  const session = makeSession({
    broadcast: (msg) => sent.push(msg),
    aiService: {
      startConversation: vi.fn(async (req: ConversationRequest) => {
        for (const p of stream) req.onProgress(p);
        return turn;
      }),
      hasActiveConversation: () => true,
    },
  });
  const streamed = () => sent.filter((m): m is Streamed => m.type !== 'plan_generated' && m.type !== 'status_update');
  return { session, streamed };
}

function timestampless(messages: Streamed[]): unknown[] {
  return messages.map((m) => (m.type === 'planner_message' ? { ...m, timestamp: '<now>' } : m));
}

describe('planner turn stream', () => {
  it('streams prose as text deltas between the turn\'s start and end, the settled reply under the same turn', async () => {
    const { session, streamed } = turnSession(
      [
        { type: 'text_delta', segmentId: 's1', text: 'Which ' },
        { type: 'text_delta', segmentId: 's1', text: 'store?' },
      ],
      { kind: 'message', text: 'Which store?', researchLog: [] },
    );

    await session.startPlanning('add persistence', ['claude-code']);

    const [started] = streamed();
    expect(started.type).toBe('planner_turn_started');
    const turnId = (started as Extract<Streamed, { type: 'planner_turn_started' }>).turnId;
    expect(timestampless(streamed())).toEqual([
      { type: 'planner_turn_started', turnId, prompt: 'add persistence', startedAt: expect.any(String) },
      { type: 'planner_text_delta', turnId, segmentId: 's1', text: 'Which ' },
      { type: 'planner_text_delta', turnId, segmentId: 's1', text: 'store?' },
      { type: 'planner_message', content: 'Which store?', timestamp: '<now>', turnId },
      { type: 'planner_turn_ended', turnId, outcome: 'message' },
    ]);
  });

  it('never lets a JSON-opening reply stream as prose, fence or not (J1)', async () => {
    const { session, streamed } = turnSession(
      [
        { type: 'text_delta', segmentId: 's1', text: '```json\n' },
        { type: 'text_delta', segmentId: 's1', text: '{"taskOps":[]}' },
        { type: 'text_delta', segmentId: 's2', text: '{"tas' },
        { type: 'text_delta', segmentId: 's2', text: 'kOps":[]}' },
      ],
      { kind: 'message', text: 'the settled reply, unrelated to what streamed', researchLog: [] },
    );

    await session.startPlanning('add persistence', ['claude-code']);

    const types = streamed().map((m) => m.type);
    expect(types).not.toContain('planner_text_delta');
    expect(types).toContain('plan_token');
  });
});

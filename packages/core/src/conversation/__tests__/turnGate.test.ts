import { describe, it, expect } from 'vitest';
import { EMPTY_CONVERSATION, type ConversationInput } from '../reduce';
import { NO_TURN, followTurn, stopTurn, type TurnGate } from '../turnGate';
import type { ConversationView } from '../reduce';

const TURN = 't-1';
const started: ConversationInput = { type: 'planner_turn_started', turnId: TURN, prompt: 'add a parser' };
const delta = (text: string): ConversationInput => ({ type: 'planner_text_delta', turnId: TURN, segmentId: 's1', text });

function follow(inputs: readonly ConversationInput[], from: { view: ConversationView; gate: TurnGate } = { view: EMPTY_CONVERSATION, gate: NO_TURN }) {
  return inputs.reduce((live, input) => followTurn(live.view, live.gate, input), from);
}

const texts = (view: ConversationView) => view.blocks.map((b) => (b.type === 'message' ? b.text : b.type));

describe('the stop rule', () => {
  it('closes the open turn at once, keeping what it had streamed', () => {
    const live = follow([started, delta('Half a thou')]);

    const stopped = stopTurn(live.view, live.gate);

    expect(stopped.view.blocks[1]).toMatchObject({ text: 'Half a thou', streaming: false });
    expect(stopped.gate.open).toBeNull();
  });

  it('drops what the stopped turn still streams while the backend notices the abort', () => {
    const live = follow([started, delta('Half a thou')]);
    const stopped = stopTurn(live.view, live.gate);

    const after = follow([
      delta('ght, arriving late'),
      { type: 'research_step', tool: 'read_file', args: '{"path":"a.ts"}', turnId: TURN },
      { type: 'planner_skill_loaded', turnId: TURN, skill: { invokedBy: 'planner', name: 'grilling', source: 'global', path: '/skills/grilling/SKILL.md' } },
      { type: 'planner_message', content: 'Half a thought, arriving late', timestamp: '', turnId: TURN },
      { type: 'planner_turn_ended', turnId: TURN, outcome: 'stopped' },
    ], stopped);

    expect(texts(after.view)).toEqual(['add a parser', 'Half a thou']);
  });

  it('still counts the stopped turn\'s tokens', () => {
    const live = follow([started]);
    const after = follow([
      { type: 'planner_usage', turnId: TURN, totals: { inputTokens: 120, outputTokens: 30 } },
    ], stopTurn(live.view, live.gate));

    expect(after.view.blocks.at(-1)).toMatchObject({ type: 'usage', totals: { inputTokens: 120, outputTokens: 30 } });
  });

  it('lets the next turn stream', () => {
    const live = follow([started]);
    const after = follow([
      { type: 'planner_turn_started', turnId: 't-2', prompt: 'try again' },
      { type: 'plan_token', token: '{"tasks":', turnId: 't-2' },
    ], stopTurn(live.view, live.gate));

    expect(after.view.blocks.at(-1)).toMatchObject({ type: 'plan', status: 'building', text: '{"tasks":' });
    expect(after.gate.open).toBe('t-2');
  });

  it('changes nothing when no turn is open', () => {
    const live = follow([started, { type: 'planner_turn_ended', turnId: TURN, outcome: 'message' }]);

    const stopped = stopTurn(live.view, live.gate);

    expect(stopped.view).toBe(live.view);
    expect(stopped.gate).toBe(live.gate);
  });

  it('hands back the same view for an input that changes nothing, so a surface can skip redrawing', () => {
    const live = follow([started]);

    expect(followTurn(live.view, live.gate, { type: 'planner_liveness' }).view).toBe(live.view);
  });
});

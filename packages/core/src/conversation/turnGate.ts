import type { SessionMessage } from '../services/SessionMessage';
import { reduceConversation, type ConversationInput, type ConversationView } from './reduce';

/**
 * The planner turn a surface has open, and the one its user stopped. Kept
 * beside the view rather than in it: the view is what a turn drew, this is
 * whether the surface still wants to hear from it.
 */
export interface TurnGate {
  readonly open: string | null;
  readonly stopped: string | null;
}

export const NO_TURN: TurnGate = { open: null, stopped: null };

export interface GatedConversation {
  view: ConversationView;
  gate: TurnGate;
}

/** What a turn streams — everything a stop cuts off. Usage, approvals and transcript markers are facts and still land. */
const TURN_STREAM = new Set<SessionMessage['type']>([
  'planner_text_delta', 'planner_thinking_delta', 'planner_text_retracted', 'planner_message', 'plan_token',
  'research_step', 'research_step_done', 'subagent_started', 'subagent_finished', 'planner_turn_ended',
  'planner_skill_loaded',
]);

// A message with no turn id while a stop stands can only be the stopped
// turn's: a new turn announces itself first, and that lifts the stop.
function cutOff(gate: TurnGate, input: ConversationInput): boolean {
  if (gate.stopped === null || !TURN_STREAM.has(input.type as SessionMessage['type'])) return false;
  const turnId = 'turnId' in input ? input.turnId : undefined;
  return turnId === undefined || turnId === gate.stopped;
}

function withGate(live: GatedConversation, gate: TurnGate): GatedConversation {
  return gate.open === live.gate.open && gate.stopped === live.gate.stopped ? live : { ...live, gate };
}

/**
 * One input into the view, the stop rule applied: a turn the user stopped is
 * over on screen, and whatever it streams until the backend notices is
 * dropped. An input that changes nothing hands back the same view and gate.
 */
export function followTurn(view: ConversationView, gate: TurnGate, input: ConversationInput): GatedConversation {
  const live = { view, gate };
  if (input.type === 'planner_turn_started') {
    return withGate({ view: reduceConversation(view, input), gate }, { open: input.turnId, stopped: null });
  }
  if (cutOff(gate, input)) {
    return input.type === 'planner_turn_ended' ? withGate(live, { ...gate, stopped: null }) : live;
  }
  const next = { view: reduceConversation(view, input), gate };
  return input.type === 'planner_turn_ended' && input.turnId === gate.open ? withGate(next, { ...gate, open: null }) : next;
}

/**
 * The user stopped the planner. The turn ends on screen now rather than when
 * the backend notices the abort, so the surface is free at once and the
 * turn's late output never lands. Nothing changes when no turn is open.
 */
export function stopTurn(view: ConversationView, gate: TurnGate): GatedConversation {
  if (gate.open === null) return { view, gate };
  return {
    view: reduceConversation(view, { type: 'planner_turn_ended', turnId: gate.open, outcome: 'stopped' }),
    gate: { open: null, stopped: gate.open },
  };
}

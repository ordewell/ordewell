import { elapsedSince, type ConversationView, type SessionMessage, type ToolBlock } from '@ordewell/core';

/**
 * When this surface last heard from the planner's turn, and since when the
 * call it shows in flight has run: what the status row says of a turn that
 * runs long, so a call stuck on a tool, or a planner that has gone silent,
 * reads as that rather than as "Planning…" for minutes. The times are arrival
 * times on this surface, since the session's messages carry none of their own.
 */
export interface PlannerPulse {
  /** When the last message of the turn arrived (ISO). */
  heardAt: string;
  /** The tool call in flight, by its block, and when this surface first saw it; absent when it was open before this surface saw the turn. */
  call?: { block: string; since?: string };
}

/** How long a turn may go without a single message before the row says so. */
export const PLANNER_SILENCE_MS = 60_000;

/** The runner prefixes on Ordewell's own tools (`mcp__ordewell__`, `ordewell_`), which the row has no room for. */
const ORDEWELL_PREFIX = /^(?:mcp__ordewell__|ordewell_)/;

/** What a planner turn streams: anything else (a run's status, a task's log) is not the planner being heard. */
const isPlannerMessage = (message: SessionMessage): boolean =>
  /^(planner_|research_|subagent_|plan_token$|approval_)/.test(message.type);

/** The latest call the conversation still shows open, top-level only: a subagent's is its own row's business. */
function openCall(view: ConversationView): ToolBlock | undefined {
  for (let i = view.blocks.length - 1; i >= 0; i--) {
    const block = view.blocks[i];
    if (block.type === 'tool' && block.status === 'pending') return block;
  }
  return undefined;
}

/** The pulse once `message` has been folded into `view`, which it arrived at `at`; unchanged for a message that is not the planner's. */
export function pulseAfter(pulse: PlannerPulse | null, view: ConversationView, message: SessionMessage, at: string | undefined): PlannerPulse | null {
  if (!isPlannerMessage(message)) return pulse;
  if (message.type === 'planner_turn_ended') return null;
  if (at === undefined) return pulse;
  const call = openCall(view);
  const kept = call && pulse?.call?.block === call.id ? pulse.call : call && { block: call.id, ...(message.type === 'research_step' ? { since: at } : {}) };
  return { heardAt: at, ...(kept ? { call: kept } : {}) };
}

/**
 * The status row's line for a planner turn that has a call in flight or has
 * gone silent, or null for the plain one. `since` is what the row's own time
 * counts from, so the turn's time goes into the label beside it.
 */
export function pulseActivity(pulse: PlannerPulse | null, view: ConversationView, openedAt: string | undefined, now: number): { label: string; since?: string } | null {
  if (!pulse || now <= 0) return null;
  const turnTime = elapsedSince(openedAt, now);
  const head = turnTime ? `Planning… ${turnTime}` : 'Planning…';
  const call = openCall(view);
  if (call && pulse.call?.block === call.id) {
    const name = call.headline.name.replace(ORDEWELL_PREFIX, '');
    return { label: `${head} · ${name} running`, ...(pulse.call.since ? { since: pulse.call.since } : {}) };
  }
  if (now - Date.parse(pulse.heardAt) >= PLANNER_SILENCE_MS) return { label: `${head} · nothing received for`, since: pulse.heardAt };
  return null;
}

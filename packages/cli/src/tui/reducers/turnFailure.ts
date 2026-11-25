import type { ConversationView, DisplayBlock } from '@ordewell/core';
import type { TuiState } from '../state';
import { reportError } from './shared';

/*
 * One failed planner turn, two deliveries. A turn the daemon admitted and kept
 * (an opening, saved as it was admitted) records its failure in the session's
 * transcript and broadcasts it (`plan_generated`), and the call that asked for
 * the turn answers with the same failure. Either may reach this view first, or
 * the broadcast not at all, so neither alone can be the one that draws: the
 * failure is drawn by whichever comes first, and the other is folded into it.
 *
 * What ties the two together is the turn, not the wording: both belong to the
 * user line the turn answered, so an identical failure after a later line is
 * that later turn's own, and is drawn again.
 */

function lastUserLine(view: ConversationView): number {
  for (let i = view.blocks.length - 1; i >= 0; i--) {
    const block = view.blocks[i];
    if (block.type === 'message' && block.role === 'user') return i;
  }
  return -1;
}

const isError = (block: DisplayBlock | undefined, text: string): boolean =>
  block?.type === 'message' && block.role === 'error' && block.text === text;

/**
 * The call's answer to a turn that failed. Drawn unless the turn's saved
 * failure already is; when drawn first, the saved copy still to come is
 * expected, so `foldSavedFailure` can take it as this one.
 */
export function reportTurnFailure(state: TuiState, message: string): TuiState {
  const { conversation } = state;
  const user = lastUserLine(conversation);
  if (!state.taskView && conversation.blocks.slice(user + 1).some((block) => isError(block, message))) {
    return { ...state, failureAhead: null };
  }
  const reported = reportError(state, message);
  if (state.taskView) return reported;
  return { ...reported, failureAhead: { text: message, afterUser: conversation.blocks[user]?.id ?? null } };
}

/**
 * `after` is `before` with a broadcast folded in. A saved failure it drew for
 * the turn whose failure is already on screen is that one, so it goes. Any
 * other line, or one after a newer user line, stays.
 */
export function foldSavedFailure(before: TuiState, after: TuiState): TuiState {
  const ahead = before.failureAhead;
  if (!ahead) return after;
  const { conversation } = after;
  const user = lastUserLine(conversation);
  if ((conversation.blocks[user]?.id ?? null) !== ahead.afterUser) return { ...after, failureAhead: null };
  const known = new Set(before.conversation.blocks.map((block) => block.id));
  const saved = conversation.blocks.findIndex((block, i) => i > user && !known.has(block.id) && isError(block, ahead.text));
  if (saved < 0) return after;
  return {
    ...after,
    conversation: { ...conversation, blocks: conversation.blocks.filter((_, i) => i !== saved) },
    failureAhead: null,
  };
}

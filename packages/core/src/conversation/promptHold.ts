/**
 * Prompts the user sent while a planner turn was in flight, waiting to be the
 * next turn's input. The hold is a plain immutable list, oldest first, so a
 * pure reducer can keep it in state and a host can keep it in a field — and
 * either can draw it as is. Every surface follows one rule (ADR-0017 Q1-Q3):
 * the turn's end and Send now send everything held as one message, glued in the
 * order typed (Send now with the composer's text last), and Esc takes back only
 * the newest.
 */
import type { DaemonErrorCode } from '../daemonContract';

export type PromptHold = readonly string[];

export const EMPTY_HOLD: PromptHold = [];

/** One prompt taken out of the hold, and what is left behind. */
export interface TakenPrompt {
  text: string;
  rest: PromptHold;
}

export function holdPrompt(hold: PromptHold, text: string): PromptHold {
  return [...hold, text];
}

/**
 * Takes back the newest prompt — the one the user most likely just regretted —
 * while the older ones stay queued behind the turn. Esc is the only way to take
 * back less than the whole hold.
 */
export function unsendLatest(hold: PromptHold): TakenPrompt | undefined {
  if (hold.length === 0) return undefined;
  return { text: hold[hold.length - 1], rest: hold.slice(0, -1) };
}

/**
 * The whole hold as one message, glued in the order typed. A settled turn sends
 * it, Send now sends it ahead of the composer's text, and a stopped turn hands
 * it back as one draft to edit and resend: the prompts were written against a
 * turn that no longer exists, so they never fire off after the stop.
 */
export function unsendAll(hold: PromptHold): TakenPrompt | undefined {
  if (hold.length === 0) return undefined;
  return { text: glued(hold), rest: EMPTY_HOLD };
}

/**
 * Held messages sent together read as one message, oldest first, a line each:
 * the one join every queue uses, a planner chat's or a task's (ADR-0023, F1, F5).
 */
export function glued(texts: readonly string[]): string {
  return texts.join('\n');
}

/** Where an unsent prompt lands in the drafting input: above what is being typed, never replacing it. */
export function aheadOfDraft(text: string, draft: string): string {
  return draft ? `${text}\n${draft}` : text;
}

/**
 * Whether a Send now whose turn ended without answering gives what it took
 * back to the composer (ADR-0017 Q2), read off why the turn ended as the
 * daemon codes it. A refusal or a failure gives back: the message was never
 * answered and is not lost with a turn that did not run. A stop does not: it
 * ended the turn as asked, and the turn a Send now stops reports one too. Nor
 * does a discarded turn: its session was left, and the composer now drafts
 * for another. One rule for every surface, so none drifts from the others.
 */
export function sendNowGivesBack(code: DaemonErrorCode | undefined): boolean {
  return code !== 'planner_turn_stopped' && code !== 'planner_turn_discarded';
}

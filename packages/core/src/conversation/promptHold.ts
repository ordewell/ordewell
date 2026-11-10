/**
 * Prompts the user sent while a planner turn was in flight, waiting to be the
 * next turn's input. The hold is a plain immutable list, oldest first, so a
 * pure reducer can keep it in state and a host can keep it in a field — and
 * either can draw it as is.
 */
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

/** The prompt a settled turn sends next: the oldest, so they go in the order typed. */
export function drainNext(hold: PromptHold): TakenPrompt | undefined {
  const [text, ...rest] = hold;
  return text === undefined ? undefined : { text, rest };
}

/**
 * Takes back the newest prompt — the one the user most likely just regretted —
 * while the older ones stay queued behind the turn.
 */
export function unsendLatest(hold: PromptHold): TakenPrompt | undefined {
  if (hold.length === 0) return undefined;
  return { text: hold[hold.length - 1], rest: hold.slice(0, -1) };
}

/**
 * Takes one prompt out by position — a "Send now" on that held row — leaving
 * every other prompt in the order it was typed.
 */
export function takeAt(hold: PromptHold, index: number): TakenPrompt | undefined {
  if (index < 0 || index >= hold.length) return undefined;
  return { text: hold[index], rest: [...hold.slice(0, index), ...hold.slice(index + 1)] };
}

/**
 * A stopped turn takes its queue with it: the prompts were written against a
 * turn that no longer exists, so they come back as one draft to edit and
 * resend rather than firing off after the stop.
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

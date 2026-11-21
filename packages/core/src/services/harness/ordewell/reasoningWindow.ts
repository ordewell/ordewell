import type { ModelMessage, ReasoningHint } from '../../model';
import { RunSettingsError, SettingsService } from '../../SettingsService';

/**
 * How much earlier reasoning a built-in runner task sends back
 * (`taskReasoningKept`, or `ORDEWELL_TASK_REASONING_KEPT`), ADR-0070. `all`, the
 * default, sends every turn's, as every request always has; a number N lets
 * the request leave out the reasoning of turns older than about the last N,
 * wherever its dialect knows the provider takes that ({@link ReasoningHint}).
 *
 * The boundary moves in steps of {@link reasoningStepOf} turns, never on every
 * call: what follows it changes when it moves, so each move sends the rest of
 * the prompt as fresh input, and a boundary that slid on every call paid that
 * on every call, more than the reasoning it left out saved.
 */
export type TaskReasoningKept = 'all' | number;

export const TASK_REASONING_KEPT_ENV = 'ORDEWELL_TASK_REASONING_KEPT';

/**
 * The setting: the variable when it is non-blank, else the settings file, else
 * `all`. A value that is neither refuses the start, naming what is accepted,
 * as `taskCompactAt` does.
 */
export function taskReasoningKeptOf(
  file: unknown = new SettingsService().getAll().taskReasoningKept,
  env: string | undefined = process.env[TASK_REASONING_KEPT_ENV],
): TaskReasoningKept {
  const fromEnv = env?.trim() ? env : undefined;
  const [value, source] = fromEnv !== undefined ? [fromEnv, TASK_REASONING_KEPT_ENV] : [file ?? 'all', 'taskReasoningKept in the settings file'];
  const setting = settingOf(value);
  if (setting === undefined) {
    throw new RunSettingsError(`The reasoning kept for a task (${source}) must be all or a whole number of calls greater than zero, not ${JSON.stringify(value)}.`);
  }
  return setting;
}

function settingOf(value: unknown): TaskReasoningKept | undefined {
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (word === 'all') return word;
    return /^\d+$/.test(word) ? settingOf(Number(word)) : undefined;
  }
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

/**
 * Turns the boundary advances by: twice the number kept. A move costs about
 * everything after the old boundary sent again as fresh input, so the step has
 * to be long beside the window for the reasoning left out to pay for it; and
 * the kept span then runs from N to 3N - 1 turns, so the model always has its
 * latest N. Keeping 5 and advancing every 10 is the pair a simulation at real
 * prices found saving; one number keeps the setting one choice.
 */
export function reasoningStepOf(kept: number): number {
  return kept * 2;
}

/**
 * The hint for a request on `messages`: none under `all`, or while no turn
 * would be left out. Counted from the conversation alone, so a retry, a resumed
 * session and the next call between two moves all get the same boundary, and a
 * compaction, which replaces the conversation, starts the count over. The
 * latest turn always keeps its reasoning: its results are what the call
 * answers, and a provider that takes older turns without theirs still checks
 * that one's.
 */
export function reasoningHintOf(messages: readonly ModelMessage[], kept: TaskReasoningKept): ReasoningHint | undefined {
  if (kept === 'all') return undefined;
  const turns: number[] = [];
  messages.forEach((message, i) => {
    if (message.role === 'assistant') turns.push(i);
  });
  const step = reasoningStepOf(kept);
  const left = turns.length <= kept ? 0 : Math.floor((turns.length - kept) / step) * step;
  return left > 0 ? { keepFrom: turns[left] } : undefined;
}

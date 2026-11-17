import { RunSettingsError, SettingsService } from './SettingsService';

/**
 * Where a Claude Code task's own context compacts (`taskCompactWindow`, or
 * `ORDEWELL_TASK_COMPACT_WINDOW`), handed to the CLI as
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (ADR-0018 W1). A planner is never given
 * one: its conversation is the user's.
 */

/** `auto` (the default), `off`, or a number of tokens within {@link TASK_COMPACT_WINDOW_BOUNDS}. */
export type TaskCompactWindowSetting = 'auto' | 'off' | number;

/** What the CLI reads for the variable: below or above, it substitutes its own bound. */
export const TASK_COMPACT_WINDOW_BOUNDS = { min: 100_000, max: 1_000_000 } as const;

/**
 * How far below the window in force the CLI starts compacting. Inferred from
 * recorded sessions, not documented: under a 150k window, compactions on Opus
 * and Sonnet alike started from 114k to 151k tokens, about 118k at the median,
 * so the trigger is the window less a fixed buffer, not a share of the model's
 * window. A later CLI may change it.
 */
export const COMPACT_BUFFER_TOKENS = 32_000;

/** Where the CLI starts compacting a context under `window`, by {@link COMPACT_BUFFER_TOKENS}. */
export function compactionStartOf(window: number): number {
  return window - COMPACT_BUFFER_TOKENS;
}

/**
 * Where `auto` has a Haiku task start compacting. Haiku charges several times
 * its base prices for any request whose prompt is over 100,000 tokens, so its
 * context compacts just under that step, leaving room for a tool result that
 * lands after the last call.
 */
const HAIKU_COMPACTS_FROM = 93_000;

/**
 * `auto`'s window: Haiku's, set so it compacts at {@link HAIKU_COMPACTS_FROM};
 * none for any other model, whose CLI then compacts near the model's own
 * window. A summary loses detail and the prompt cache, so compaction is a
 * guard on capacity, not a tool for quality: a task outgrowing its brief is
 * the supervisor's to notice.
 */
function autoWindow(model: string | undefined): number | undefined {
  return model !== undefined && /haiku/i.test(model) ? HAIKU_COMPACTS_FROM + COMPACT_BUFFER_TOKENS : undefined;
}

/** The variable that sets it over the settings file, as `ORDEWELL_PLANNER_READ_LIMIT` does its own. */
export const TASK_COMPACT_WINDOW_ENV = 'ORDEWELL_TASK_COMPACT_WINDOW';

/**
 * The window to set for a task on `model`, or undefined to set none (`off`, or
 * `auto` on a model other than Haiku):
 * the variable when it is set, else the settings file, else `auto`. A value
 * neither `auto`, `off` nor a whole number within the bounds refuses the
 * start, naming them, rather than run on a window nobody chose. A model whose
 * own window is smaller than the one chosen is no reason to set less: the CLI
 * compacts at the smaller of the two (checked on 2.1.325).
 */
export function taskCompactWindowOf(
  model: string | undefined,
  file: unknown = new SettingsService().getAll().taskCompactWindow,
  env: string | undefined = process.env[TASK_COMPACT_WINDOW_ENV],
): number | undefined {
  const fromEnv = env?.trim() ? env : undefined;
  const [value, source] = fromEnv !== undefined ? [fromEnv, TASK_COMPACT_WINDOW_ENV] : [file ?? 'auto', 'taskCompactWindow in the settings file'];
  const setting = settingOf(value);
  if (setting === undefined) {
    const { min, max } = TASK_COMPACT_WINDOW_BOUNDS;
    throw new RunSettingsError(`The task compaction window (${source}) must be auto, off or a whole number of tokens from ${min} to ${max}, not ${JSON.stringify(value)}.`);
  }
  if (setting === 'off') return undefined;
  return setting === 'auto' ? autoWindow(model) : setting;
}

/** A number written as a string reads as that number, so the file and the variable take the same words. */
function settingOf(value: unknown): TaskCompactWindowSetting | undefined {
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (word === 'auto' || word === 'off') return word;
    return /^\d+$/.test(word) ? settingOf(Number(word)) : undefined;
  }
  const { min, max } = TASK_COMPACT_WINDOW_BOUNDS;
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : undefined;
}

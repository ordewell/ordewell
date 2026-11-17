import { RunSettingsError, SettingsService } from './SettingsService';

/**
 * Where a task's own context compacts: one setting for every harness
 * (`taskCompactAt`, or `ORDEWELL_TASK_COMPACT_AT`), read by {@link taskCompactAtOf}
 * and mapped by each harness's adapter onto what its CLI or loop offers. A
 * number is the context size, in tokens, at which compaction starts. A planner
 * is never given one: its conversation is the user's.
 *
 * Claude Code takes a window instead, and starts compacting a buffer below it
 * ({@link claudeCompactWindowOf}, ADR-0018 W1).
 */

/** What the setting says, once read: `auto` and `off` are the harness's to act on, a number is a start size in tokens. */
export type TaskCompactAt = 'auto' | 'off' | number;

/** Each harness's own limits on a start size, applied by its adapter through {@link clampTaskCompactAt}. */
export interface CompactAtBounds { min: number; max: number }

/** The variable that sets it over the settings file, as `ORDEWELL_PLANNER_READ_LIMIT` does its own. */
export const TASK_COMPACT_AT_ENV = 'ORDEWELL_TASK_COMPACT_AT';

/**
 * The setting for a task on any harness: the variable when it is non-blank,
 * else the settings file, else `auto`. Only a value that means nothing on any
 * harness (not `auto`, `off` or a whole number of tokens above zero) refuses
 * the start, naming what is accepted, rather than run on a point nobody
 * chose; what a harness cannot honour it clamps.
 */
export function taskCompactAtOf(
  file: unknown = new SettingsService().getAll().taskCompactAt,
  env: string | undefined = process.env[TASK_COMPACT_AT_ENV],
): TaskCompactAt {
  const fromEnv = env?.trim() ? env : undefined;
  const [value, source] = fromEnv !== undefined ? [fromEnv, TASK_COMPACT_AT_ENV] : [file ?? 'auto', 'taskCompactAt in the settings file'];
  const setting = settingOf(value);
  if (setting === undefined) {
    throw new RunSettingsError(`The task compaction point (${source}) must be auto, off or a whole number of tokens greater than zero, not ${JSON.stringify(value)}.`);
  }
  return setting;
}

/** A number written as a string reads as that number, so the file and the variable take the same words. */
function settingOf(value: unknown): TaskCompactAt | undefined {
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (word === 'auto' || word === 'off') return word;
    return /^\d+$/.test(word) ? settingOf(Number(word)) : undefined;
  }
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

/**
 * `at` held within a harness's own bounds, with one line to `log` when it had
 * to move, so a user who set a number the harness cannot honour is told what
 * it got instead.
 */
export function clampTaskCompactAt(
  at: number,
  bounds: CompactAtBounds,
  harness: string,
  log: (line: string) => void = (line) => console.warn(line),
): number {
  const clamped = Math.min(Math.max(at, bounds.min), bounds.max);
  if (clamped !== at) {
    log(`${harness}: taskCompactAt ${at} is outside the ${bounds.min} to ${bounds.max} tokens it can compact at; using ${clamped}.`);
  }
  return clamped;
}

/** What the Claude CLI reads for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: below or above, it substitutes its own bound. */
export const CLAUDE_WINDOW_BOUNDS: CompactAtBounds = { min: 100_000, max: 1_000_000 };

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
 * `auto`'s Claude window: Haiku's, set so it compacts at {@link HAIKU_COMPACTS_FROM};
 * none for any other model, whose CLI then compacts near the model's own
 * window. A summary loses detail and the prompt cache, so compaction is a
 * guard on capacity, not a tool for quality: a task outgrowing its brief is
 * the supervisor's to notice.
 */
function autoClaudeWindow(model: string | undefined): number | undefined {
  return model !== undefined && /haiku/i.test(model) ? HAIKU_COMPACTS_FROM + COMPACT_BUFFER_TOKENS : undefined;
}

/**
 * The Claude CLI window for a task on `model`, or undefined to set none (`off`,
 * or `auto` on a model other than Haiku). A number N is where compaction
 * starts, so the window is N plus {@link COMPACT_BUFFER_TOKENS}, held within
 * the CLI's bounds with a line to `log` when it moves. A model whose own window
 * is smaller than the one chosen is no reason to set less: the CLI compacts at
 * the smaller of the two (checked on 2.1.325).
 */
export function claudeCompactWindowOf(
  model: string | undefined,
  at: TaskCompactAt = taskCompactAtOf(),
  log?: (line: string) => void,
): number | undefined {
  if (at === 'off') return undefined;
  if (at === 'auto') return autoClaudeWindow(model);
  const starts = { min: compactionStartOf(CLAUDE_WINDOW_BOUNDS.min), max: compactionStartOf(CLAUDE_WINDOW_BOUNDS.max) };
  return clampTaskCompactAt(at, starts, 'Claude Code', log) + COMPACT_BUFFER_TOKENS;
}

/**
 * The window a session's compaction point reads as, the same for every
 * harness: where compaction starts plus {@link COMPACT_BUFFER_TOKENS}, which on
 * Claude Code is the window it is handed. Codex, OpenCode and the built-in
 * runner report the start as their window, so read raw, one setting would put
 * running long's routine line and threshold 32k apart from one harness to the
 * next (ADR-0018 C4).
 */
export function compactWindowInForce(session: { readonly compactWindowTokens?: number; readonly compactStartTokens?: number }): number | undefined {
  const start = session.compactStartTokens;
  return start !== undefined ? start + COMPACT_BUFFER_TOKENS : session.compactWindowTokens;
}

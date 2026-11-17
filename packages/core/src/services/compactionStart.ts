/**
 * Where a context compacts against the window in force, the same arithmetic
 * for every harness. It lives apart from the setting's reader
 * (`taskCompactWindow.ts`), which reads the settings file, because
 * `VerdictEngine` reaches it, and `models/Task.ts` reaches `VerdictEngine`
 * from the browser-safe `plan-utils` entry the webviews bundle.
 */

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

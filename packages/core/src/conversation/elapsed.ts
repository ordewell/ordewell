/**
 * How long something has run, for an activity line: whole seconds (`42s`),
 * then minutes and zero-padded seconds (`3m 05s`), then from an hour hours and
 * zero-padded minutes (`1h 05m`), since seconds mean nothing by then. A
 * fraction of a unit is dropped, not rounded up, so a time never reads ahead
 * of the clock. Returns '' for a negative or non-finite input: a start time
 * ahead of the reader's clock (skew between hosts) is not a duration to show.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * The time from `startedAt` (ISO) to `now` (epoch ms), formatted. The clock is
 * the caller's, so a surface counts on a tick it already draws and a test
 * fixes it. '' when there is nothing to show: no start (a log saved before
 * turns were dated) or one that cannot be read.
 */
export function elapsedSince(startedAt: string | undefined, now: number): string {
  return startedAt === undefined ? '' : formatElapsed(now - Date.parse(startedAt));
}

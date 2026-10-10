/** How many AI tasks may run at once: `ORDEWELL_MAX_PARALLEL`, `/parallel`, `ordewell.maxParallelSessions`. */
export const DEFAULT_MAX_PARALLEL = 5;

/**
 * A usable limit from what a user typed or a setting holds: any whole number
 * of at least 1 — there is no ceiling, the machine and the runners' own rate
 * limits are the user's to judge. Anything else is null, so each surface can
 * refuse it in its own words.
 */
export function parseMaxParallel(value: unknown): number | null {
  const text = String(value ?? '').trim();
  const n = typeof value === 'number' ? value : Number(text);
  if (text === '' || !Number.isInteger(n) || n < 1) return null;
  return n;
}

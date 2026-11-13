/**
 * Who ended a task as skipped (ADR-0045 L7). Stored beside the reason, never
 * read off its words: a person's or a supervisor's reason may say anything,
 * the loop's own texts may be reworded, and neither may change who skipped.
 *
 * - `loop`: a loop closed and the body that had not run was not waited for.
 *   A new set of rounds undoes these.
 * - `user`, `supervisor`: a person, or a supervisor at Act, skipped it. A loop
 *   whose body holds one has stopped, and stays so.
 * - `resolver`: its conflict ended some other way (ADR-0015).
 */
export type SkipOrigin = 'loop' | 'user' | 'supervisor' | 'resolver';

/** Why a loop's body that did not run ends skipped once its loop is over (ADR-0045 L6). */
export const LOOP_PASSED = 'not needed: its check passed';
export const LOOP_OUT_OF_ROUNDS = 'not run: the loop ran out of rounds';
export const LOOP_CHECK_MARKED_COMPLETE = 'not needed: its check was marked complete';
export const LOOP_CHECK_SKIPPED = 'not needed: its check was skipped';

/**
 * The texts a build before skip origins saved for a loop's own skips. Read
 * only to give such a plan the origin it lacks as it loads; they stay as they
 * were written even if the loop's wording changes, so no later build can read
 * a plan saved by this one wrongly.
 */
const LEGACY_LOOP_SKIP_REASONS: ReadonlySet<string> = new Set([
  'not needed: its check passed',
  'not run: the loop ran out of rounds',
  'not needed: its check was marked complete',
  'not needed: its check was skipped',
]);

/** The origin a task saved before skip origins was skipped by, which only a loop's own text gives away; undefined for any other. */
export function legacySkipOrigin(task: { status: string; skipReason?: string; skipOrigin?: SkipOrigin }): SkipOrigin | undefined {
  if (task.skipOrigin) return task.skipOrigin;
  return task.status === 'skipped' && LEGACY_LOOP_SKIP_REASONS.has(task.skipReason ?? '') ? 'loop' : undefined;
}

/** Whether a skipped body task has stopped its loop: anyone's skip but the loop's own does (ADR-0045 L7). */
export function stopsLoop(body: { status: string; skipOrigin?: SkipOrigin }): boolean {
  return body.status === 'skipped' && body.skipOrigin !== 'loop';
}

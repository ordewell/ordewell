import type { Task, VerificationCheck } from '@ordewell/core';

/**
 * What a card calls one verification check. Exhaustive over the check names,
 * so a new kind of evidence cannot fall through to a label claiming something
 * else decided the verdict.
 */
const CHECK_LABELS: Record<VerificationCheck['name'], string> = {
  completion_marker: 'Completion Marker',
  task_complete: 'Completion Call',
  exit_code: 'Exit Code',
  manual: 'Marked by you',
  script_exit: 'Script Exit',
  protected_paths: 'Protected Paths',
};

export function checkLabel(name: VerificationCheck['name']): string {
  return CHECK_LABELS[name];
}

/**
 * The verdict's line on a card. Some of VerdictEngine's passes already open
 * with "Verified: …" and some do not, so that is said once. A failure's
 * reason says what failed itself, in the user's words, so it stands alone (F7).
 */
export function verdictSummary(verdict: Pick<NonNullable<Task['verdict']>, 'outcome' | 'reason'>): string {
  if (verdict.outcome !== 'pass') return verdict.reason;
  return verdict.reason.startsWith('Verified:') ? verdict.reason : `Verified: ${verdict.reason}`;
}

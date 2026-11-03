import type { VerificationCheck } from '@ordewell/core';

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

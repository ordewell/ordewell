import { revertEffect, revertListLine, type TaskRevertPreview } from '@ordewell/core';
import { sanitize } from '../ansi';
import type { TuiState } from '../state';
import { fail, step, type Step } from './shared';

/*
 * /revert (ADR-0054). The terminal decides nothing: core's preview says what
 * goes and why it may not, and the yes goes back with the ids it listed, so
 * a plan that changed under the popup is refused rather than reverted.
 */

/** The preview, answered: the question the user is asked, or why there is nothing to ask. */
export function revertPreviewed(state: TuiState, taskId: string, preview: TaskRevertPreview): Step {
  if (!preview.revertible) return fail(state, sanitize(preview.message));
  const asked = preview.tasks.find((t) => t.taskId === taskId) ?? preview.tasks.at(-1);
  // Titles are a planner's or a runner's words; the repos are paths from the record.
  const lines = preview.tasks.map((t) => `  ${sanitize(revertListLine(t))}`);
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: `Revert ${asked ? `#${asked.order} ${sanitize(asked.title)}` : 'this task'}?`,
      message: revertEffect,
      note: ['Reverting:', ...lines].join('\n'),
      action: { kind: 'revert-task', taskId, seen: preview.tasks.map((t) => t.taskId) },
    },
  });
}

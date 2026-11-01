import { formatTokenCount } from '../models/Usage';
import type { ChildTaskCounts, DelegatedRow } from '../models/Delegation';
import type { HandoffDigest } from '../models/Handoff';

/**
 * What a delegated task's row says (ADR-0055 D16, D20), in sentence case, each
 * part null where there is nothing to say. Surfaces pick the glyphs and the
 * layout, and derive none of the facts.
 */
export interface TaskRowDelegated {
  goal: string | null;
  /** "1.3M of 2M tokens left". */
  tokens: string | null;
  /** "2 of 4 done, 1 running". */
  counts: string | null;
  /** That a Stop is still winding the subtree down. */
  stopping: string | null;
}

export const STOPPING_LABEL = 'Stopping: its child plan is still winding down.';

function countsText({ completed, running, waiting, pending, failed, skipped }: ChildTaskCounts): string {
  const total = completed + running + waiting + pending + failed + skipped;
  const said = [[running, 'running'], [waiting, 'waiting'], [failed, 'failed'], [skipped, 'skipped']] as const;
  return [`${completed} of ${total} done`, ...said.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`)].join(', ');
}

/** A child that has ended is read from the report it left, which counts what ran. */
function reported(handoff: HandoffDigest | undefined): ChildTaskCounts | undefined {
  const counts = handoff?.subtree?.counts;
  return counts && { completed: counts.done, running: 0, waiting: 0, pending: counts.blocked, failed: counts.failed, skipped: counts.skipped };
}

export function delegatedRowView(task: { type: string; goal?: string; delegation?: DelegatedRow; handoff?: HandoffDigest }): TaskRowDelegated | null {
  if (task.type !== 'delegated') return null;
  const { delegation } = task;
  const counts = delegation?.tasks ?? reported(task.handoff);
  return {
    goal: task.goal?.trim() || null,
    tokens: delegation?.tokens ? `${formatTokenCount(delegation.tokens.left)} of ${formatTokenCount(delegation.tokens.budget)} tokens left` : null,
    counts: counts ? countsText(counts) : null,
    stopping: delegation?.stopping ? STOPPING_LABEL : null,
  };
}

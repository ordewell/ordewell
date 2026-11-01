import { formatTokenCount } from '../models/Usage';
import type { ChildTaskCounts, DelegatedRow } from '../models/Delegation';
import { handoffReferenceText, severityLabel, type FindingSeverity, type HandoffDigest, type ReportItem, type SubtreeReport } from '../models/Handoff';

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

/** One finding of a delegated task's report, as a surface draws it. */
export interface SubtreeItemView {
  /** The task and finding that name it, as a reader says them; null for a subplanner's own, which names no task. */
  reference: string | null;
  /** "F1 · Major · title". */
  heading: string;
  detail?: string;
}

/** What a delegated task's report adds to a handoff (ADR-0057 R2), worded once for every surface. */
export interface SubtreeView {
  /** "3 done, 1 failed · 3 commits · 1.2M tokens · 1 major, 2 minor findings below". */
  summary: string;
  /** Changed outside its declared scope, or null (ADR-0056 M7). */
  outsideScope: string | null;
  /** What the parent must decide. */
  open: SubtreeItemView[];
  /** What the subplanner passed up. */
  promoted: SubtreeItemView[];
}

const SEVERITIES: readonly FindingSeverity[] = ['blocker', 'major', 'minor', 'info'];

function itemView({ ref, finding }: ReportItem): SubtreeItemView {
  return {
    reference: ref ? handoffReferenceText(ref) : null,
    heading: `${finding.id} · ${severityLabel(finding.severity)} · ${finding.title}`,
    ...(finding.detail ? { detail: finding.detail } : {}),
  };
}

export function subtreeView(subtree: SubtreeReport): SubtreeView {
  const { counts, findings, outsideScope } = subtree;
  const ran = ([['done', counts.done], ['failed', counts.failed], ['blocked', counts.blocked], ['skipped', counts.skipped]] as const)
    .filter(([, n]) => n > 0).map(([word, n]) => `${n} ${word}`).join(', ');
  const found = SEVERITIES.filter((severity) => findings[severity] > 0).map((severity) => `${findings[severity]} ${severity}`).join(', ');
  const summary = [
    ran || 'nothing ran',
    ...(counts.commits > 0 ? [`${counts.commits} commit${counts.commits === 1 ? '' : 's'}`] : []),
    `${formatTokenCount(counts.tokens)} tokens`,
    found ? `${found} finding${SEVERITIES.reduce((n, s) => n + findings[s], 0) === 1 ? '' : 's'} below` : 'no findings below',
  ].join(' · ');
  return {
    summary,
    outsideScope: outsideScope && outsideScope.count > 0
      ? `Changed outside its declared scope: ${outsideScope.paths.join(', ')}${outsideScope.count > outsideScope.paths.length ? ` (+${outsideScope.count - outsideScope.paths.length} more)` : ''}`
      : null,
    open: subtree.open.map(itemView),
    promoted: subtree.promoted.map(itemView),
  };
}

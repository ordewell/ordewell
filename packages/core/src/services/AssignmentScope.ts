import type { AwaitingReason, DiscoveredModel, RunnerId } from '../models/Task';
import { effectiveAllowlist } from './ModelAllowlistResolver';

/**
 * What the user allows the plan to be built from right now: the enabled
 * runners and each runner's model allowlist. Structural, so a surface that
 * only holds the two lists can ask without a session.
 */
export interface AssignmentScope {
  enabledRunners: readonly string[];
  allowlist: Readonly<Record<string, readonly string[] | undefined>>;
  /**
   * The models discovery has found per runner, where the holder has them. An
   * allowlist is read against them exactly as the planner's catalog reads it
   * (ids only another runner lists limit nothing), so a flag never says a
   * model is off a list the planner sees as no limit.
   */
  models?: Readonly<Partial<Record<RunnerId, readonly DiscoveredModel[]>>>;
}

/** The part of a task an assignment is read from. */
export interface AssignedTask {
  type: string;
  status: string;
  assignedRunner: string;
  assignedModel?: { modelId: string; modelLabel?: string };
}

/**
 * The runner a task is assigned, which only an AI task has: a script task runs
 * with no model (ADR-0035) and a manual one is done by the user. The plan may
 * still store one for them (a default taken at intake), so every surface reads
 * the runner through this rather than off the task.
 */
export function assignedRunnerOf(task: { type: string; assignedRunner?: string }): string | undefined {
  return task.type === 'ai' || task.type === 'delegated' ? task.assignedRunner || undefined : undefined;
}

export type AssignmentIssue =
  | { kind: 'runner-off'; runner: string }
  | { kind: 'model-off-list'; runner: string; modelId: string; modelLabel: string };

/** A finished task has nothing left to run, so where it ran is history, not a choice to revisit. */
const OVER = new Set(['completed', 'skipped']);

/**
 * Whether a task sits outside the scope it is read against. This only names
 * the mismatch: such a task still runs (ADR-0003, P1) — the allowlist and the
 * enabled runners shape what is planned, not what is started — and the user or
 * the planner may move it. A runner that is off settles the matter before its
 * model is looked at.
 */
export function assignmentIssue(task: AssignedTask, scope: AssignmentScope): AssignmentIssue | null {
  if ((task.type !== 'ai' && task.type !== 'delegated') || OVER.has(task.status)) return null;
  if (!scope.enabledRunners.includes(task.assignedRunner)) return { kind: 'runner-off', runner: task.assignedRunner };
  const model = task.assignedModel;
  const allowed = effectiveAllowlist(scope.allowlist[task.assignedRunner] as string[] | undefined, task.assignedRunner, scope.models as Partial<Record<RunnerId, DiscoveredModel[]>> | undefined);
  if (model && allowed && !allowed.includes(model.modelId)) {
    return { kind: 'model-off-list', runner: task.assignedRunner, modelId: model.modelId, modelLabel: model.modelLabel || model.modelId };
  }
  return null;
}

export function assignmentIssueText(issue: AssignmentIssue): string {
  return issue.kind === 'runner-off' ? `${issue.runner} is switched off` : `${issue.modelLabel} is not in the allowlist`;
}

/** Where a flagged task stands, which decides what its assignment means. */
export interface AssignmentStanding {
  status?: string;
  awaitingReason?: AwaitingReason;
  resumeAt?: string | null;
}

/**
 * What happens to a flagged task as assigned, which depends on where it stands:
 * a failed one only runs again if retried, and a pause whose attempt ended (a
 * usage limit, work that did not land) has nothing running, whatever its
 * status says. The planner's note and every surface's flag read this one text.
 */
export function assignmentConsequence({ status, awaitingReason, resumeAt }: AssignmentStanding): string {
  if (status === 'failed') return 'failed; a retry would run it there unless moved';
  if (status === 'awaiting_user' && awaitingReason === 'usage-limit') {
    return resumeAt ? 'paused on a usage limit; resumes there at the reset unless moved' : 'paused on a usage limit; a retry would run it there unless moved';
  }
  if (status === 'awaiting_user' && (awaitingReason === 'conflict' || awaitingReason === 'files-changed')) return 'waiting for the user; what runs next runs there unless moved';
  if (status === 'in_progress' || status === 'awaiting_user') return 'already running as assigned';
  return 'runs as assigned unless moved';
}

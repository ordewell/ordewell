import type { TaskStatus } from '../models/Task';

/**
 * Tasks the plan block lists. The block is re-sent whole after a renumbering
 * or a compaction, and every line grows with the task, so a plan of thousands
 * would otherwise fill the planner's context with lines it cannot act on. A
 * plan this size or smaller is listed whole.
 */
export const PLAN_BLOCK_MAX_TASKS = 60;

/** A task the plan block may list: enough to count it, name it and order it. */
export interface PlannedTask {
  id: string;
  status: TaskStatus;
}

/**
 * What a planner acts on first: what needs a decision, then work in motion,
 * then what is next. Running tasks come after the decisions because they are
 * locked, and because a run can be wider than the block: the line that locks
 * them names them anyway, and nothing else names a failed task.
 */
const LISTING_RANK: Record<TaskStatus, number> = {
  failed: 0,
  awaiting_user: 0,
  in_progress: 1,
  approved: 2,
  pending: 3,
  completed: 4,
  skipped: 4,
};

/**
 * The ids to list from a plan: all of them within the limit, else the
 * limit's worth that matter most — failed and waiting tasks, then running
 * ones, then approved and pending ones, then finished ones — each kind in
 * plan order.
 */
export function listedIds(tasks: readonly PlannedTask[], limit = PLAN_BLOCK_MAX_TASKS): Set<string> {
  if (tasks.length <= limit) return new Set(tasks.map(({ id }) => id));
  const chosen = tasks
    .map((task, place) => ({ task, place }))
    .sort((a, b) => LISTING_RANK[a.task.status] - LISTING_RANK[b.task.status] || a.place - b.place)
    .slice(0, limit);
  return new Set(chosen.map(({ task }) => task.id));
}

/**
 * The references a line naming running tasks gives, in the rows' limit: a run
 * can be wider than the block, and the refusal of an edit to a running task is
 * what guards it, so past the limit a count says as much.
 */
export function namedRefs(refs: readonly string[], limit = PLAN_BLOCK_MAX_TASKS): string {
  const more = refs.length - limit;
  return more > 0 ? `${refs.slice(0, limit).join(', ')} and ${more} more` : refs.join(', ');
}

const STATUS_ORDER: readonly TaskStatus[] = ['in_progress', 'failed', 'awaiting_user', 'approved', 'pending', 'completed', 'skipped'];

/**
 * The line that stands in for the tasks the block does not list: how many, by
 * status, and where to read them. A read takes a reference, so one that needs
 * a decision is named here or could not be found. Empty when every task is
 * listed.
 */
export function unlistedSummary(shown: number, unlisted: readonly (Pick<PlannedTask, 'status'> & { ref: string })[], reread: string): string {
  if (unlisted.length === 0) return '';
  const counts = new Map<TaskStatus, number>();
  for (const { status } of unlisted) counts.set(status, (counts.get(status) ?? 0) + 1);
  const byStatus = STATUS_ORDER.filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s.replace('_', ' ')}`).join(', ');
  const undecided = unlisted.filter(({ status }) => LISTING_RANK[status] === 0).map(({ ref }) => ref);
  const named = undecided.length > 0 ? ` Failed or waiting among them: ${namedRefs(undecided)}.` : '';
  return `${shown} of ${shown + unlisted.length} tasks are listed (failed and waiting ones first, then running). Not listed: ${byStatus}.${named} A task not listed still exists, and ${reread} reads it by its reference (#order, or #order.subtask), as an edit names it.`;
}

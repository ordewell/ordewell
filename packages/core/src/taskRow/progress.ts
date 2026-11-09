import { walkPlan, type TreeTask } from '../services/PlanTree';
import { taskStatusKind, type TaskStatusKind } from './status';

/**
 * Behind the plan, as its progress counts: passed (merged or waiting for a
 * merge) or skipped. A failed, blocked or waiting-on-you task is still ahead.
 */
export function countsAsDone(kind: TaskStatusKind): boolean {
  return kind === 'done' || kind === 'skipped';
}

type ProgressTask<T> = TreeTask<T> & { status: string; idleSince?: string | null };

/** A plan's "n of m": every task and subtask once, so the open session's header and another session's list row agree. */
export function planProgressCount<T extends ProgressTask<T>>(tasks: readonly T[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const { task } of walkPlan(tasks)) {
    total += 1;
    if (countsAsDone(taskStatusKind(task))) done += 1;
  }
  return { done, total };
}

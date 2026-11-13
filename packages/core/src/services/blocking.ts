import { betweenRounds, type LoopSubject } from '../models/Loop';
import { stopsLoop } from '../models/SkipOrigin';

/**
 * What the blocked rule reads of a task; structural, so a surface's own task
 * shape answers it too. The loop fields are read only on a loop's check
 * (ADR-0045); a shape without them reads every failed task as a failure.
 */
export interface BlockingSubject extends Omit<LoopSubject, 'id' | 'status'> {
  id: string;
  status: string;
  dependencies: readonly string[];
  subtasks?: readonly BlockingSubject[];
}

/** Statuses of a task that has not started, the only ones a block holds back. */
const UNSTARTED: ReadonlySet<string> = new Set(['pending', 'approved']);

/** One reading of the blocked rule over a plan: what each blocked task waits on, and which loops go on. */
export interface PlanBlocks {
  /** Each blocked task's failed tasks, in dependency order and named once; an unblocked task is absent. */
  blocked: Map<string, string[]>;
  /** The loops' checks between rounds whose loop can still go on (ADR-0045 L3). */
  repeating: Set<string>;
}

/**
 * The blocked rule (ADR-0034): a task not started yet is blocked while a
 * dependency failed or is itself blocked. One already at work — force-started,
 * or waiting on the user — is not, and does not pass a block on. Each
 * blocked task maps to the failed tasks it waits on, in dependency order and
 * named once; an unblocked task is absent. Nothing is stored, so a retry that
 * passes is all it takes to lift a block.
 *
 * Takes the plan tree or a flat list; a subtask follows the same rule.
 */
export function blockingFailures(tasks: readonly BlockingSubject[]): Map<string, string[]> {
  return planBlocks(tasks).blocked;
}

/** The checks between rounds whose loop goes on; see {@link planBlocks}. */
export function repeatingChecks(tasks: readonly BlockingSubject[]): Set<string> {
  return planBlocks(tasks).repeating;
}

/**
 * The blocked rule with loops in it (ADR-0045 L3, L7). A check between rounds
 * is stored as failed, but it is no failure while its loop goes on: its own
 * body takes it as its input, and its other dependents wait for it as for a
 * task under way. The loop goes on until a body task fails, is skipped by a person or a
 * supervisor (not by the loop itself, whose skips a new round undoes), or is
 * blocked; then the check is the failure it is stored as, and blocks its
 * dependents until what stopped the loop is retried.
 */
export function planBlocks(tasks: readonly BlockingSubject[]): PlanBlocks {
  const byId = new Map<string, BlockingSubject>();
  const index = (list: readonly BlockingSubject[]): void => {
    for (const t of list) {
      byId.set(t.id, t);
      index(t.subtasks ?? []);
    }
  };
  index(tasks);

  const memo = new Map<string, string[]>();
  const stopped = new Map<string, boolean>();
  const repeats = (check: BlockingSubject): boolean => {
    if (!betweenRounds(check)) return false;
    const known = stopped.get(check.id);
    if (known !== undefined) return !known;
    // Provisional while its body is judged, so a malformed plan cannot recurse through it.
    stopped.set(check.id, false);
    const halted = (check.loop?.body ?? []).some((id) => {
      const body = byId.get(id);
      return !!body && (body.status === 'failed' || stopsLoop(body) || failuresOf(id, new Set()).length > 0);
    });
    stopped.set(check.id, halted);
    return !halted;
  };
  const failuresOf = (id: string, visiting: Set<string>): string[] => {
    const known = memo.get(id);
    if (known) return known;
    const task = byId.get(id);
    // A dependency cycle the planner left has no failure at its root.
    if (!task || !UNSTARTED.has(task.status) || visiting.has(id)) return [];
    visiting.add(id);
    const failed = new Set<string>();
    for (const depId of task.dependencies) {
      const dep = byId.get(depId);
      // A skipped dependency releases its dependents: nobody waits for it.
      if (!dep || dep.status === 'completed' || dep.status === 'skipped') continue;
      if (dep.status === 'failed') {
        if (betweenRounds(dep) && (dep.loop?.body.includes(id) || repeats(dep))) continue;
        failed.add(depId);
      } else for (const root of failuresOf(depId, visiting)) failed.add(root);
    }
    visiting.delete(id);
    const result = [...failed];
    memo.set(id, result);
    return result;
  };

  const blocked = new Map<string, string[]>();
  const repeating = new Set<string>();
  for (const [id, task] of byId) {
    const failures = failuresOf(id, new Set());
    if (failures.length > 0) blocked.set(id, failures);
    if (repeats(task)) repeating.add(id);
  }
  return { blocked, repeating };
}

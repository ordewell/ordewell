import { resolveOrderLabel } from '@ordewell/core';

/** Every task in a plan, finished ones first, regardless of plan shape. */
export function allTasksOf(plan: Record<string, unknown>): Array<import("@ordewell/core").Task> {
  const tasks = (plan?.pendingTasks || plan?.tasks || []) as Array<import("@ordewell/core").Task>;
  const executionLog = (plan?.executionLog || []) as Array<import("@ordewell/core").Task>;
  return [...executionLog, ...tasks];
}

/** Resolve a user-supplied identifier — order number, full task ID, or unique ID prefix. */
export function resolveTaskId(plan: Record<string, unknown>, identifier: string): string | undefined {
  const allTasks = allTasksOf(plan);

  if (identifier.includes('.')) {
    const subtask = resolveOrderLabel(allTasks, identifier);
    return subtask?.id;
  }

  const order = parseInt(identifier, 10);
  if (!isNaN(order)) {
    const task = allTasks.find((t: import("@ordewell/core").Task) => t.order === order);
    if (task) return task.id;
  }

  const exact = allTasks.find((t: import("@ordewell/core").Task) => t.id === identifier);
  if (exact) return exact.id;

  const prefixMatches = allTasks.filter((t: import("@ordewell/core").Task) => typeof t.id === 'string' && t.id.startsWith(identifier));
  if (prefixMatches.length === 1) return prefixMatches[0].id;

  return undefined;
}

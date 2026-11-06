import { createTask, type RunTask } from '@ordewell/core';

/** A task as the run holds it: the plan's fields with the run's own on top. */
export function runTask(fields: Partial<RunTask> & { id: string; order: number }): RunTask {
  const { id, order } = fields;
  return { ...createTask({ id, order, title: `Task ${order}` }), subtasks: [], ...fields } as RunTask;
}

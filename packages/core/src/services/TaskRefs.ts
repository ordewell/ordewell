import { taskPlacement, walkPlan, type TreeTask } from './PlanTree';

/**
 * Task references: the one grammar for naming a task in a plan, both ways.
 * A label is rendered from a task's order under its parent ("2", "2.1"), and
 * a reference written by anyone — the planner, a tool call, a command — is
 * resolved back against the plan tree. Pure so a
 * browser-bundled surface can use it through `@ordewell/core/plan-utils`.
 */

/** The shape a reference resolves over: the plan's task tree, or a surface's projection of it. */
export type RefTask<T> = TreeTask<T>;

/**
 * The parent a label extends. A label is the full path ("3.2.1"), so a parent
 * below the top level carries the label it was itself reached by; without one
 * the parent's order stands for it, which is right for a top-level parent.
 */
export interface RefParent {
  order: number;
  label?: string;
}

/** Dotted path label for a task, e.g. "2.1" for the first subtask of task 2, "2.1.3" one level down. */
export function taskOrderLabel(task: { order: number }, parent?: RefParent): string {
  return parent ? `${parent.label ?? parent.order}.${task.order}` : String(task.order);
}

/** How a surface refers to a task in prose: "#2", or "#2.1" for a subtask. */
export function taskRef(task: { order: number }, parent?: RefParent): string {
  return `#${taskOrderLabel(task, parent)}`;
}

/** A task named in full, as a confirmation or a picker title does: "#2 Deploy". */
export function titledTaskRef(task: { order: number; title: string }, parent?: RefParent): string {
  return `${taskRef(task, parent)} ${task.title}`;
}

/** A task found in a plan tree, with its parent and the full path label its reference extends. */
export interface RefTaskMatch<T> {
  task: T;
  parent?: T;
  label: string;
}

/** The task a plan tree holds, by id, with its parent; undefined when the tree holds none. */
export function findTaskRef<T extends RefTask<T>>(tasks: readonly T[], id: string): RefTaskMatch<T> | undefined {
  return taskPlacement(tasks, id);
}

/**
 * The reference {@link taskRef} renders for the task a plan tree holds, by id
 * — its full path, dotted, for a subtask. Undefined when the tree holds no such task.
 */
export function taskRefOf<T extends RefTask<T>>(tasks: readonly T[], id: string): string | undefined {
  const found = findTaskRef(tasks, id);
  return found && `#${found.label}`;
}

/** {@link taskRefOf} for a whole plan tree at once: each task's reference, by id. */
export function taskRefsOf<T extends RefTask<T>>(tasks: readonly T[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const { task, label } of walkPlan(tasks)) if (!refs.has(task.id)) refs.set(task.id, `#${label}`);
  return refs;
}

/**
 * The reference and title {@link titledTaskRef} renders for the task a plan
 * tree holds, by id — its full path, dotted, for a subtask. Undefined when the
 * tree holds no such task.
 */
export function titledTaskRefOf<T extends RefTask<T>>(tasks: readonly T[], id: string): string | undefined {
  const found = findTaskRef(tasks, id);
  return found && `#${found.label} ${found.task.title}`;
}

/**
 * Resolve a written reference to a task at any depth: an id, then an order
 * label with or without "#" ("#2", "2", "#2.1"), then an exact title.
 *
 * An order label is read against the tree, never a flattened list: subtask
 * orders restart at 1 under each parent, so "#2" always means top-level task 2
 * and a subtask is reachable only by its dotted path ("#2.1", "#2.1.3").
 */
export function resolveTaskRef<T extends RefTask<T>>(tasks: readonly T[], ref: string | number): T | undefined {
  const s = String(ref).trim();
  if (!s) return undefined;
  for (const { task } of walkPlan(tasks)) if (task.id === s) return task;
  const label = s.startsWith('#') ? s.slice(1) : s;
  if (/^\d+(\.\d+)*$/.test(label)) {
    let level: readonly T[] | undefined = tasks;
    let found: T | undefined;
    for (const order of label.split('.').map(Number)) {
      found = level?.find((t) => t.order === order);
      level = found?.subtasks;
    }
    return found;
  }
  for (const { task } of walkPlan(tasks)) if (task.title === s) return task;
  return undefined;
}

/**
 * A reference as the user types one: {@link resolveTaskRef}, then a unique
 * prefix of a task's id at any depth. Only the user's: a model's reference
 * that names no task is refused, never matched to the one task a fragment of
 * it happens to fit.
 */
export function resolveUserTaskRef<T extends RefTask<T>>(tasks: readonly T[], ref: string | number): T | undefined {
  const found = resolveTaskRef(tasks, ref);
  if (found) return found;
  const prefix = String(ref).trim();
  const matches = prefix ? [...walkPlan(tasks)].filter(({ task }) => task.id.startsWith(prefix)) : [];
  return matches.length === 1 ? matches[0].task : undefined;
}

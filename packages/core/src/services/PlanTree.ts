import { AFTER_ALL, afterAllRefusal } from './AfterAll';

/** Plan placement and dependency rules, shared with browser-bundled surfaces. */
export interface TreeTask<T> {
  id: string;
  order: number;
  title: string;
  subtasks?: readonly T[];
}

export interface DependencyTask<T> extends TreeTask<T> {
  dependencies: readonly string[];
}

export interface TaskPlacement<T> {
  task: T;
  parent?: T;
  ancestors: readonly T[];
  siblings: readonly T[];
  label: string;
}

export function* walkPlan<T extends TreeTask<T>>(tasks: readonly T[]): Generator<TaskPlacement<T>> {
  function* walk(level: readonly T[], ancestors: readonly T[], parentLabel?: string): Generator<TaskPlacement<T>> {
    for (const task of level) {
      const label = parentLabel ? `${parentLabel}.${task.order}` : String(task.order);
      yield { task, parent: ancestors.at(-1), ancestors, siblings: level, label };
      yield* walk(task.subtasks ?? [], [...ancestors, task], label);
    }
  }
  yield* walk(tasks, []);
}

export function taskPlacement<T extends TreeTask<T>>(tasks: readonly T[], id: string): TaskPlacement<T> | undefined {
  for (const row of walkPlan(tasks)) if (row.task.id === id) return row;
  return undefined;
}

/** Includes the root: deletion has to detach every edge into the removed tree. */
export function subtreeIds<T extends TreeTask<T>>(tasks: readonly T[], id: string): Set<string> {
  const found = taskPlacement(tasks, id);
  return new Set(found ? [...walkPlan([found.task])].map(({ task }) => task.id) : []);
}

/** Pickers offer earlier siblings; API validity is independent of display order. */
export function dependencyCandidates<T extends TreeTask<T>>(tasks: readonly T[], taskId?: string): T[] {
  if (!taskId) return [...tasks];
  const found = taskPlacement(tasks, taskId);
  return found ? found.siblings.filter((t) => t.order < found.task.order) : [];
}

/** The surviving tasks whose dependency lists a subtree removal will change. */
export function dependentsOf<T extends DependencyTask<T>>(tasks: readonly T[], taskId: string): T[] {
  const removed = subtreeIds(tasks, taskId);
  return [...walkPlan(tasks)].map(({ task }) => task)
    .filter((t) => !removed.has(t.id) && t.dependencies.some((id) => removed.has(id)));
}

export interface DependencyCheck { ok: boolean; error?: string }

/** Target restrictions, separate from cycles so a planner batch can check its final graph. */
export function dependencyTargetErrors<T extends TreeTask<T>>(
  tasks: readonly T[], taskId: string, dependencies: readonly string[],
): string[] {
  const found = taskPlacement(tasks, taskId);
  if (!found) return ['Task not found'];
  const descendants = subtreeIds(tasks, taskId);
  const errors: string[] = [];
  for (const dep of dependencies) {
    if (dep === AFTER_ALL) {
      const refusal = afterAllRefusal(found.task, found.parent);
      if (refusal) errors.push(refusal);
      continue;
    }
    if (dep === taskId) { errors.push(`"${found.task.title}" cannot depend on itself`); continue; }
    const target = taskPlacement(tasks, dep)?.task;
    if (!target) { errors.push(`Unknown dependency "${dep}"`); continue; }
    if (found.ancestors.some((t) => t.id === dep) || descendants.has(dep)) {
      errors.push(`"${found.task.title}" cannot depend on "${target.title}", its ancestor or descendant`);
    }
  }
  return errors;
}

/**
 * The tasks on one dependency cycle, in dependency order, or null. "*" names
 * no task here: it never closes a cycle of its own (ADR-0077), so only the
 * edges a plan states can make one.
 */
export function findDependencyCycle<T extends DependencyTask<T>>(tasks: readonly T[]): T[] | null {
  const byId = new Map([...walkPlan(tasks)].map(({ task }) => [task.id, task]));
  const path: string[] = [];
  const done = new Set<string>();
  const visit = (id: string): string[] | null => {
    if (done.has(id)) return null;
    const at = path.indexOf(id);
    if (at >= 0) return path.slice(at);
    path.push(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      const hit = visit(dep);
      if (hit) return hit;
    }
    path.pop();
    done.add(id);
    return null;
  };
  for (const id of byId.keys()) {
    const hit = visit(id);
    if (hit) return hit.map((key) => byId.get(key)!);
  }
  return null;
}

export function canSetDependencies<T extends DependencyTask<T>>(
  tasks: readonly T[], taskId: string, dependencies: readonly string[],
): DependencyCheck {
  const [error] = dependencyTargetErrors(tasks, taskId, dependencies);
  if (error) return { ok: false, error };
  const replace = (level: readonly T[]): T[] => level.map((t) => ({
    ...t,
    dependencies: t.id === taskId ? dependencies : t.dependencies,
    subtasks: replace(t.subtasks ?? []),
  }));
  const cycle = findDependencyCycle(replace(tasks));
  return cycle
    ? { ok: false, error: `Dependency cycle detected: ${[...cycle, cycle[0]].map((t) => `"${t.title}"`).join(' → ')}` }
    : { ok: true };
}

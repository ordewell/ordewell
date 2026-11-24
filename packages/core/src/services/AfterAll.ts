/**
 * "*" among a top-level task's dependencies (ADR-0077): the task runs after
 * every other top-level task that does not itself come after it. It is read
 * here from the plan as it stands, never written out into the stored list, so
 * a task added, removed, split or merged later is covered without the planner
 * remembering the check. Pure, so a browser-bundled surface reads it through
 * `@ordewell/core/plan-utils` as core does.
 *
 * Left out, besides the task itself and what comes after it:
 * - research tasks, which report to the planner and land nothing;
 * - a loop's body, which runs only for its check and is waited for through it
 *   (ADR-0045 L3), and which no task outside the loop may name (L4);
 * - every other "*" task and whatever comes after one. Two closing checks do
 *   not wait for each other, nor for each other's followers, unless one names
 *   the other. That is also what keeps "*" from ever closing a cycle: a task
 *   it reaches reaches no "*" task, so only a cycle the plan already wrote
 *   can run through one.
 *
 * "Comes after" is read on the stated edges alone, a whole top-level task at
 * a time: a task one of whose subtasks waits on this task, or on one of its
 * subtasks, comes after it, as does anything waiting on that.
 */

/** The dependency that stands for every other task. */
export const AFTER_ALL = '*';

/** How a surface names "*" where it names a dependency. */
export const AFTER_ALL_TEXT = 'after all other tasks';

/** What the rule reads of a task; structural, so a surface's projection of a plan answers it too. */
export interface AfterAllSubject {
  id: string;
  dependencies?: readonly string[];
  research?: boolean;
  loop?: { body: readonly string[] };
  subtasks?: readonly AfterAllSubject[];
}

/** Whether a task's own list holds "*". */
export function waitsOnAll(task: { dependencies?: readonly string[] }): boolean {
  return task.dependencies?.includes(AFTER_ALL) ?? false;
}

/** A task's dependencies to resolve: its id finds where it stands, its list is read as given. */
export type AfterAllQuery = { id?: string; dependencies?: readonly string[] };

/**
 * Reads each task's dependencies against `tasks` (the plan tree, or a flat
 * list whose tasks keep their subtasks): a list without "*" comes back as it
 * is; one with it comes back with the ids it stands for, after the ids it
 * names, each once. A task `tasks` does not hold is read as a top-level task
 * would be, so an edit can be judged before it lands. A subtask may not use
 * "*" ({@link afterAllRefusal}); one that holds it anyway waits on nothing for it.
 */
export function afterAllReader(tasks: readonly AfterAllSubject[]): (task: AfterAllQuery) => readonly string[] {
  let plan: ReadPlan | undefined;
  const memo = new Map<string, readonly string[]>();
  return (task) => {
    const deps = task.dependencies ?? [];
    if (!deps.includes(AFTER_ALL)) return deps;
    plan ??= readPlan(tasks);
    const key = task.id === undefined ? undefined : `${task.id}\n${deps.join('\n')}`;
    const known = key === undefined ? undefined : memo.get(key);
    if (known) return known;
    const named = deps.filter((d) => d !== AFTER_ALL);
    const isSubtask = task.id !== undefined && plan.rootOf.has(task.id) && plan.rootOf.get(task.id) !== task.id;
    const rest = isSubtask ? [] : plan.candidates.filter((id) => id !== task.id && !(task.id !== undefined && plan!.followersOf(task.id).has(id)));
    const resolved = [...new Set([...named, ...rest])];
    if (key !== undefined) memo.set(key, resolved);
    return resolved;
  };
}

/**
 * The tasks with "*" read into their lists, as {@link afterAllReader} reads
 * them; every other task is the same object, and a plan with no "*" is the
 * same array. For a walk that reads `dependencies` straight off the tasks.
 */
export function resolveAfterAll<T extends AfterAllSubject & { dependencies: readonly string[] }>(tasks: readonly T[]): readonly T[] {
  if (!tasks.some(waitsOnAll)) return tasks;
  const read = afterAllReader(tasks);
  return tasks.map((t) => (waitsOnAll(t) ? { ...t, dependencies: read(t) } : t));
}

/** Why a task may not hold "*" where it stands, or null when it may. */
export function afterAllRefusal(task: { title: string }, parent: { title: string } | undefined): string | null {
  return parent
    ? `"${task.title}" is a subtask of "${parent.title}", so it cannot depend on "${AFTER_ALL}": only a top-level task can; a subtask already waits for what its parent waits for`
    : null;
}

interface ReadPlan {
  rootOf: ReadonlyMap<string, string>;
  /** The top-level tasks a "*" may stand for, in plan order, before the asking task's followers are taken out. */
  candidates: readonly string[];
  followersOf(id: string): ReadonlySet<string>;
}

function readPlan(tasks: readonly AfterAllSubject[]): ReadPlan {
  const nested = new Set<string>();
  const markNested = (list: readonly AfterAllSubject[]): void => list.forEach((t) => { nested.add(t.id); markNested(t.subtasks ?? []); });
  for (const t of tasks) markNested(t.subtasks ?? []);
  const tops = tasks.filter((t) => !nested.has(t.id));
  const rootOf = new Map<string, string>();
  const subtreeOf = new Map<string, AfterAllSubject[]>();
  for (const top of tops) {
    const subtree: AfterAllSubject[] = [];
    const walk = (t: AfterAllSubject): void => { rootOf.set(t.id, top.id); subtree.push(t); (t.subtasks ?? []).forEach(walk); };
    walk(top);
    subtreeOf.set(top.id, subtree);
  }
  // Top-level task → the top-level tasks that wait on it directly, by a stated edge.
  const waiters = new Map<string, Set<string>>();
  for (const top of tops) {
    for (const t of subtreeOf.get(top.id)!) {
      for (const dep of t.dependencies ?? []) {
        const root = rootOf.get(dep);
        if (root === undefined || root === top.id) continue;
        const known = waiters.get(root) ?? new Set<string>();
        known.add(top.id);
        waiters.set(root, known);
      }
    }
  }
  const followers = new Map<string, Set<string>>();
  const followersOf = (id: string): ReadonlySet<string> => {
    const known = followers.get(id);
    if (known) return known;
    const found = new Set<string>();
    for (const queue = [...waiters.get(id) ?? []]; queue.length > 0;) {
      const next = queue.pop()!;
      if (found.has(next)) continue;
      found.add(next);
      queue.push(...waiters.get(next) ?? []);
    }
    followers.set(id, found);
    return found;
  };
  const outside = new Set<string>();
  for (const top of tops) {
    if (top.research) outside.add(top.id);
    for (const id of top.loop?.body ?? []) outside.add(id);
    if (!waitsOnAll(top)) continue;
    outside.add(top.id);
    for (const id of followersOf(top.id)) outside.add(id);
  }
  return { rootOf, candidates: tops.map((t) => t.id).filter((id) => !outside.has(id)), followersOf };
}

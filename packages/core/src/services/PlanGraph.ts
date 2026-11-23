import { renumberTasks, waitsMidAttempt, type Task } from '../models/Task';
import { subtreeIds } from './PlanTree';

/**
 * What the plan's edges become when tasks leave it or are swapped for others,
 * and the order that keeps them. `PlanTree`'s rules say which edges may
 * exist; this is the one place that rewrites them, so removal, merge and split
 * cannot disagree about a subtask that depended on the task going away. Every
 * rewrite reaches a dependency list at any depth, and a list comes out with
 * each id once.
 */

/**
 * A removed task leaves every dependency on it, and every loop's body it was
 * in (ADR-0045 L8): a loop it leaves with no body is no loop. Whether its
 * removal may go ahead at all — a loop's check may not be removed — is the
 * caller's to say.
 */
export function remove(tasks: readonly Task[], taskId: string): Task[] {
  const removed = subtreeIds(tasks, taskId);
  const prune = (level: readonly Task[]): Task[] => level
    .filter((t) => !removed.has(t.id))
    .map((t) => {
      const pruned: Task = {
        ...t,
        dependencies: t.dependencies.filter((depId) => !removed.has(depId)),
        subtasks: prune(t.subtasks),
      };
      if (!t.loop?.body.some((id) => removed.has(id))) return pruned;
      const body = t.loop.body.filter((id) => !removed.has(id));
      if (body.length > 0) return { ...pruned, loop: { ...t.loop, body } };
      delete pruned.loop;
      delete pruned.loopRound;
      return pruned;
    });
  return renumberTasks(prune(tasks));
}

/**
 * Swap `ids` for `newTasks`, which take the slot of the first of them, and
 * point everything that depended on any of `ids` at `tailId` — the new task
 * that stands for what they did — wherever it sits in the tree, so a task that
 * depended on both of two merged tasks depends on the merged one once. The new
 * tasks state their own dependencies and are not rewired. An edge into a
 * subtask the swap drops is left as it is: it dangles, and the plan's
 * invariants refuse it, as they do any unknown id. A loop's check and body are
 * not touched, because a task in either cannot be swapped (`loopReshapeRefusal`).
 */
export function replace(tasks: readonly Task[], ids: Iterable<string>, newTasks: readonly Task[], tailId: string): Task[] {
  const gone = new Set(ids);
  let placed = false;
  const rewire = (level: readonly Task[]): Task[] => {
    const out: Task[] = [];
    for (const t of level) {
      if (gone.has(t.id)) {
        if (!placed) { out.push(...newTasks); placed = true; }
        continue;
      }
      out.push({
        ...t,
        dependencies: [...new Set(t.dependencies.map((d) => (gone.has(d) ? tailId : d)))],
        subtasks: rewire(t.subtasks),
      });
    }
    return out;
  };
  const result = rewire(tasks);
  if (!placed) result.push(...newTasks);
  return renumberTasks(result);
}

/** A task the repair may not reposition: execution has already reached it. */
function isPinned(t: Task): boolean {
  return t.status === 'in_progress' || waitsMidAttempt(t) || t.status === 'completed';
}

/**
 * Reorder one list of siblings so every dependency comes before its
 * dependents, moving as little as possible: pinned tasks keep their order
 * among themselves and, where they can, the exact slot they are in, and each
 * free slot goes to the earliest-listed movable task whose dependencies are
 * already placed — so tasks the graph does not constrain keep their relative
 * order. A free slot no movable task can take yet, because each one left waits
 * on a pinned task further down, closes up: the pinned tasks below move up one,
 * and what waits on them follows them. That is how a task that parked on a
 * sibling listed after it (ADR-0074 P3) comes to sit after it. A pinned task
 * that depends on one listed after it is refused, since moving it down would
 * move it past work that has already started. A dependency outside the list (a
 * task of another level) constrains nothing here. Assumes an acyclic graph (the
 * caller checks first). `moves` says what moved, as `"B" #2→#1, "A" #1→#3`, or
 * is null when nothing did.
 */
export function repairOrder(tasks: Task[]): { tasks: Task[]; moves: string | null } | { error: string } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const placed = new Set<string>();
  const movable = tasks.filter((t) => !isPinned(t));
  const result: Task[] = [];
  const blockerOf = (t: Task): Task | undefined => {
    const id = t.dependencies.find((d) => byId.has(d) && !placed.has(d));
    return id ? byId.get(id) : undefined;
  };
  const place = (t: Task) => { result.push(t); placed.add(t.id); };
  const placeNextMovable = (): boolean => {
    const next = movable.findIndex((t) => !blockerOf(t));
    if (next < 0) return false;
    place(movable.splice(next, 1)[0]);
    return true;
  };

  for (const occupant of tasks) {
    if (isPinned(occupant)) {
      const blocker = blockerOf(occupant);
      if (blocker) return { error: pinnedRefusal(blocker, occupant) };
      place(occupant);
      continue;
    }
    placeNextMovable();
  }
  // Every pinned task is placed, and the graph is acyclic, so what is left can all go.
  while (placeNextMovable());
  // Only a cycle the caller let through leaves any: refused, never dropped from the plan.
  if (movable.length > 0) return { error: `"${movable[0].title}" waits on a task that waits on it` };
  return { tasks: result, moves: describeMoves(tasks, result) };
}

function describeMoves(before: Task[], after: Task[]): string | null {
  const wasAt = new Map(before.map((t, i) => [t.id, i + 1]));
  const moved = after
    .map((t, i) => ({ t, from: wasAt.get(t.id)!, to: i + 1 }))
    .filter((m) => m.from !== m.to);
  return moved.length ? moved.map((m) => `"${m.t.title}" #${m.from}→#${m.to}`).join(', ') : null;
}

function pinnedRefusal(other: Task, pin: Task): string {
  const word = pin.status === 'completed' ? 'completed' : 'running';
  return `"${other.title}" would have to run before "${pin.title}", which is ${word} and cannot be moved`;
}

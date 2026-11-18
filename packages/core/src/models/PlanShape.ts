import type { Task } from './Task';

/**
 * How far a plan lets its work run at once, over its top-level tasks, since a
 * subtask runs inside its parent: its longest dependency chain, which bounds
 * the run's wall time whatever the slots, and its widest level.
 */
export interface PlanShape {
  tasks: number;
  longestChain: number;
  widestLevel: number;
  /** The longest chain's tasks, first to last. */
  chain: readonly Task[];
}

/** Undefined for no tasks, or for dependencies that hold a cycle, which the plan's own rules refuse. */
export function planShape(tasks: readonly Task[]): PlanShape | undefined {
  if (tasks.length === 0) return undefined;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map<string, { depth: number; via?: string }>();
  const visit = (t: Task, stack: Set<string>): number | undefined => {
    const known = level.get(t.id);
    if (known) return known.depth;
    if (stack.has(t.id)) return undefined;
    stack.add(t.id);
    let deepest = 0;
    let via: string | undefined;
    for (const id of t.dependencies) {
      const dep = byId.get(id);
      if (!dep) continue;
      const d = visit(dep, stack);
      if (d === undefined) return undefined;
      if (d > deepest) { deepest = d; via = id; }
    }
    stack.delete(t.id);
    level.set(t.id, { depth: deepest + 1, ...(via ? { via } : {}) });
    return deepest + 1;
  };
  for (const t of tasks) if (visit(t, new Set()) === undefined) return undefined;
  const widths = new Map<number, number>();
  let last = tasks[0];
  for (const t of tasks) {
    const { depth } = level.get(t.id)!;
    widths.set(depth, (widths.get(depth) ?? 0) + 1);
    if (depth > level.get(last.id)!.depth) last = t;
  }
  const chain: Task[] = [];
  for (let at: Task | undefined = last; at; at = level.get(at.id)?.via ? byId.get(level.get(at.id)!.via!) : undefined) chain.unshift(at);
  return { tasks: tasks.length, longestChain: chain.length, widestLevel: Math.max(...widths.values()), chain };
}

/** A chain this long is worth a second look at its edges; below it a plan is a contract and its fan-out. */
export const LONG_CHAIN = 4;

/**
 * How many of a long chain's tasks the note names, its first and its last: a
 * serial plan of hundreds would otherwise come back whole on every edit that
 * lengthens it.
 */
const NAMED_HEAD = 3;
const NAMED_TAIL = 2;

/**
 * Advice on a plan whose longest chain is long, for the planner tool's answer:
 * it refuses nothing and rewrites nothing, since only the planner can tell an
 * edge that consumes something from one that only orders work (the plan is
 * the source of truth). `before` is the plan an edit started from: an edit is
 * told only of a chain it lengthened.
 */
export function longChainNote(tasks: readonly Task[], before?: readonly Task[]): string | undefined {
  const shape = planShape(tasks);
  if (!shape || shape.longestChain < LONG_CHAIN) return undefined;
  if (before) {
    const was = planShape(before);
    if (was && was.longestChain >= shape.longestChain) return undefined;
  }
  const titles = shape.chain.map((t) => `"${t.title}"`);
  const unnamed = titles.length - NAMED_HEAD - NAMED_TAIL;
  const path = (unnamed > 1 ? [...titles.slice(0, NAMED_HEAD), `${unnamed} more`, ...titles.slice(-NAMED_TAIL)] : titles).join(' → ');
  // The exemption is the dependency rule's own, so the note never asks to drop an edge another rule requires.
  return `The plan's longest chain is ${shape.longestChain} of its ${shape.tasks} top-level tasks, and its widest level ${shape.widestLevel}: ${path}. Each of those dependencies should consume something its dependency creates that does not exist yet, or be one that another rule orders; where one does neither, removing it lets the tasks run at once.`;
}

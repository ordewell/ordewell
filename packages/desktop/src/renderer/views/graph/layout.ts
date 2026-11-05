import type { StatusId } from '@ordewell/ui/design';

/**
 * The graph's stages (design W5): stage(t) = 1 + the largest stage among t's
 * dependencies, so every edge points right. Pure, and a function of the
 * plan's shape alone, so a status change never moves a card.
 */

/** Each task's stage, from 1. `order` is a topological order; a dependency outside it is ignored. */
export function stagesOf(order: readonly string[], dependsOn: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const stage = new Map<string, number>();
  for (const id of order) {
    let at = 1;
    for (const dep of dependsOn.get(id) ?? []) {
      const before = stage.get(dep);
      if (before !== undefined && before + 1 > at) at = before + 1;
    }
    stage.set(id, at);
  }
  return stage;
}

export interface StageLayout {
  /** Columns left to right; each holds its tasks' ids in plan order. */
  columns: string[][];
  /** Where a task sits: its column's index, from 0, and its row in that column. */
  at: Map<string, { column: number; row: number }>;
}

/** Groups the nodes by stage. The nodes come in plan order, and a column keeps it. */
export function stageLayout(nodes: readonly { id: string; stage: number }[]): StageLayout {
  const columns: string[][] = [];
  for (const node of nodes) (columns[node.stage - 1] ??= []).push(node.id);
  // A stage is never empty by construction; this keeps a hand-made input from leaving holes.
  const dense = columns.filter((c) => c && c.length > 0);
  const at = new Map<string, { column: number; row: number }>();
  dense.forEach((ids, column) => ids.forEach((id, row) => at.set(id, { column, row })));
  return { columns: dense, at };
}

/** Recomputes only when the shape key changes, so a status tick reuses the last layout. */
export function memoStageLayout(): (key: string, nodes: readonly { id: string; stage: number }[]) => StageLayout {
  let lastKey: string | null = null;
  let last: StageLayout = { columns: [], at: new Map() };
  return (key, nodes) => {
    if (key !== lastKey) {
      lastKey = key;
      last = stageLayout(nodes);
    }
    return last;
  };
}

/** The order a stage chip picks its one status in: the first that any task has wins (design W5). */
const STAGE_PRECEDENCE: readonly StatusId[] = ['needs-you', 'failed', 'running', 'blocked', 'waiting-for-merge', 'not-started'];

export interface StageSummary {
  status: StatusId;
  done: number;
  total: number;
}

/**
 * A stage chip's aggregate. Stalled is still running, so it ranks there.
 * Waiting for merge counts as done: the work ended, only the merge waits.
 */
export function stageSummary(statuses: readonly StatusId[]): StageSummary {
  const has = new Set<StatusId>(statuses.map((s) => (s === 'stalled' ? 'running' : s)));
  const status = STAGE_PRECEDENCE.find((s) => has.has(s)) ?? 'passed';
  const done = statuses.filter((s) => s === 'passed' || s === 'skipped' || s === 'waiting-for-merge').length;
  return { status, done, total: statuses.length };
}

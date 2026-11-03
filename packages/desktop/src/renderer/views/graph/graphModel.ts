import type { RunTask, RunView, SurfacePlan, TaskRowAction, TaskRowSubject, TaskRowView, TaskType } from '@ordewell/core';
import {
  blockedByLabel, EMPTY_RUN, elapsedSince, holdLabel, loopRowParts, loopRoundOf, reduceRun, skippedLabel, taskRowView,
  type TaskStatusKind,
} from '@ordewell/core/plan-utils';
import { statusOf, type StatusLook } from '@ordewell/ui/design';
import { RUNNER_NAMES } from '../../runners';

/**
 * The Plan graph's drawing input, decided once and purely (design W5): which
 * nodes there are, what each says, which edges join them and which chain is
 * critical. Layout (positions) is a separate step that reads only the shape,
 * so a status change restyles a node without moving anything.
 */

export const NODE_WIDTH = 264;
/** A collapsed node: header line, assignment line and status line. */
export const NODE_HEIGHT = 78;
/** One folded subtask row, when its parent is expanded. */
export const SUBTASK_ROW_HEIGHT = 20;
const EXPANDED_PADDING = 10;

export type EdgeState = 'satisfied' | 'active' | 'failed' | 'blocked' | 'merge' | 'pending';

export type BadgeKind = 'research' | 'ops' | 'script' | 'manual' | 'delegated';
export type FlagKind = 'approval' | 'waits-for-approval' | 'conflict' | 'repair' | 'merge-gate' | 'usage-limit' | 'hold' | 'checkpoint';

export interface NodeBadge { kind: BadgeKind; label: string; title: string }
export interface NodeFlag { kind: FlagKind; label: string; title: string }

export interface LoopBadgeView {
  role: 'check' | 'body';
  /** "⟲ 2/3" on a check; "⟲ #1" on a body task, for the check it runs for. */
  label: string;
  title: string;
  /** The words a screen reader gets in place of the glyph. */
  spoken: string;
}

export interface SubtaskView {
  id: string;
  orderLabel: string;
  title: string;
  status: StatusLook;
}

/** What a folded node says of what it holds: subtasks, and a delegated task's child plan. */
export interface FoldView {
  subtasks: SubtaskView[];
  /** A delegated task's child plan: its goal and counts, as the row words them. */
  childPlan: { goal: string | null; counts: string | null } | null;
  /** "3 subtasks", "Child plan · 2 of 4 done"; the node's fold toggle reads it. */
  summary: string;
}

export interface GraphNode {
  id: string;
  task: RunTask;
  row: TaskRowView;
  status: StatusLook;
  orderLabel: string;
  title: string;
  /** "Codex · gpt-5 · medium", for an AI task; null for any other. */
  assignment: string | null;
  badges: NodeBadge[];
  flags: NodeFlag[];
  loop: LoopBadgeView | null;
  /** The status line: the status word, then what qualifies it. */
  statusLine: string;
  fold: FoldView | null;
  actions: readonly TaskRowAction[];
  /** Ids of the nodes this one depends on, and of those that depend on it. */
  dependsOn: string[];
  dependents: string[];
  critical: boolean;
  width: number;
  height: number;
  /** The accessible name and the description of its edges. */
  label: string;
  description: string;
  /** Changes exactly when what the node draws changes, so a memoized node re-renders no more often. */
  viewKey: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  state: EdgeState;
  critical: boolean;
}

export type GraphModel =
  | { ok: true; nodes: GraphNode[]; edges: GraphEdge[]; layoutKey: string }
  | { ok: false; reason: string };

export interface GraphContext {
  /** Ids of the nodes opened to show their subtasks. */
  expanded: ReadonlySet<string>;
  /** The scheduler is driving the plan: the critical path is drawn only then. */
  executing: boolean;
  /** Mode lists by runner, for the row view's autonomy reading. */
  modesByRunner?: Record<string, readonly { id: string; autonomous?: boolean }[]>;
  /** A handoff waits for Merge all, so a landed task is not yet merged into the user's branch. */
  handoffPending: boolean;
  now?: Date;
}

const isSettled = (kind: TaskStatusKind): boolean => kind === 'done' || kind === 'skipped';

function assignmentOf(task: RunTask): string | null {
  if (task.type !== 'ai') return null;
  const runner = task.assignedRunner ? RUNNER_NAMES[task.assignedRunner] ?? task.assignedRunner : null;
  const model = task.assignedModel?.modelLabel || task.assignedModel?.modelId || 'default model';
  return [runner, model, task.assignedModel?.thinkingEffort].filter(Boolean).join(' · ');
}

function badgesOf(task: RunTask, row: TaskRowView): NodeBadge[] {
  const badges: NodeBadge[] = [];
  if (task.type === 'user') badges.push({ kind: 'manual', label: 'Manual', title: 'A manual task: you do it and mark it done' });
  if (row.kind === 'script') badges.push({ kind: 'script', label: 'Script', title: 'A script task: it runs the script the plan holds, with no model' });
  if (row.kind === 'delegated') badges.push({ kind: 'delegated', label: 'Delegated', title: 'A delegated task: a sub-planner plans and runs it as a child plan' });
  if (row.research) badges.push({ kind: 'research', label: 'Research', title: 'A research task: read-only, its report goes to the planner' });
  if (row.kind === 'ops') badges.push({ kind: 'ops', label: 'Ops', title: 'An ops task: it changes no repository files' });
  return badges;
}

function flagsOf(task: RunTask, row: TaskRowView): NodeFlag[] {
  const flags: NodeFlag[] = [];
  if (row.approvals) flags.push({ kind: 'approval', label: 'Approval', title: row.approvals });
  if (row.waitsForApproval) flags.push({ kind: 'waits-for-approval', label: 'Needs approval', title: row.waitsForApproval });
  if (task.awaitingReason === 'checkpoint') flags.push({ kind: 'checkpoint', label: 'Checkpoint', title: row.awaiting ?? 'Checkpoint' });
  if (row.conflict) flags.push({ kind: 'conflict', label: 'Conflict', title: ['Merge conflict', row.conflict.files].filter(Boolean).join(': ') });
  if (row.repairing) flags.push({ kind: 'repair', label: 'Repairing', title: 'A conflict repair is running' });
  if (row.mergeGate) flags.push({ kind: 'merge-gate', label: 'Merge gate', title: `Not merged into your branch yet: ${row.mergeGate.join(', ')}` });
  if (task.awaitingReason === 'usage-limit') flags.push({ kind: 'usage-limit', label: 'Usage limit', title: row.resumes ?? row.awaiting ?? 'Paused on a usage limit' });
  if (row.holdReason) flags.push({ kind: 'hold', label: 'On hold', title: holdLabel(row.holdReason) });
  return flags;
}

function loopOf(task: RunTask, row: TaskRowView): LoopBadgeView | null {
  if (!row.loop) return null;
  const title = loopRowParts(row.loop).join('. ');
  if (row.loop.role === 'check') {
    if (!task.loop) return null;
    const round = Math.min(loopRoundOf(task), task.loop.maxRounds);
    return { role: 'check', label: `⟲ ${round}/${task.loop.maxRounds}`, title, spoken: `loop round ${round} of ${task.loop.maxRounds}` };
  }
  return { role: 'body', label: `⟲ ${row.loop.check}`, title, spoken: title };
}

/** The qualifier the status word carries, in the order a row's badge picks one. */
function qualifierOf(row: TaskRowView): string | null {
  if (row.status === 'skipped') return row.skipReason ? skippedLabel(row.skipReason) : null;
  return row.awaiting ?? row.approvals ?? row.receipt ?? row.attaching
    ?? (row.holdReason ? holdLabel(row.holdReason) : null)
    ?? (row.blockedBy ? blockedByLabel(row.blockedBy) : null);
}

function statusLineOf(row: TaskRowView, look: StatusLook, idleSince: string | null | undefined, now: Date): string {
  const qualifier = qualifierOf(row);
  const quiet = row.status === 'quiet' ? elapsedSince(idleSince ?? undefined, now.getTime()) : '';
  const line = qualifier ? (qualifier.startsWith(look.label) ? qualifier : `${look.label} · ${qualifier}`) : look.label;
  return quiet ? `${line} · quiet for ${quiet}` : line;
}

/** The run folds a task's type as a string; the plan it was folded from only ever holds a TaskType. */
function subjectOf(task: RunTask): TaskRowSubject {
  return { ...task, type: task.type as TaskType, assignedModel: task.assignedModel ?? undefined };
}

function foldOf(task: RunTask, row: TaskRowView, parentLabel: string): FoldView | null {
  const subtasks: SubtaskView[] = [...task.subtasks].sort((a, b) => a.order - b.order).map((sub) => ({
    id: sub.id,
    orderLabel: `${parentLabel}.${sub.order}`,
    title: sub.title,
    status: statusOf(taskRowView(subjectOf(sub), { parent: task, tasks: [task] }).status),
  }));
  const childPlan = row.delegated ? { goal: row.delegated.goal, counts: row.delegated.counts } : null;
  if (subtasks.length === 0 && !childPlan) return null;
  const parts = [
    subtasks.length > 0 ? `${subtasks.length} ${subtasks.length === 1 ? 'subtask' : 'subtasks'}` : null,
    childPlan ? ['Child plan', childPlan.counts].filter(Boolean).join(' · ') : null,
  ].filter(Boolean);
  return { subtasks, childPlan, summary: parts.join(' · ') };
}

function heightOf(fold: FoldView | null, expanded: boolean): number {
  if (!fold || !expanded) return NODE_HEIGHT;
  const rows = fold.subtasks.length + (fold.childPlan?.goal ? 1 : 0);
  return NODE_HEIGHT + (rows > 0 ? EXPANDED_PADDING + rows * SUBTASK_ROW_HEIGHT : 0);
}

/** Core's reading of a task's edge to one of its dependencies. */
export function edgeState(source: GraphNode, target: GraphNode): EdgeState {
  const from = source.row.status;
  if (from === 'failed') return 'failed';
  if (from === 'done' || from === 'skipped') {
    if (target.row.mergeGate?.includes(`#${source.orderLabel}`) || source.status.id === 'waiting-for-merge') return 'merge';
    return target.row.running ? 'active' : 'satisfied';
  }
  if (from === 'blocked' || from === 'awaiting') return 'blocked';
  return 'pending';
}

/** The longest chain, by tasks, of work not yet settled: where a delay would move the end. */
function criticalPath(nodes: readonly GraphNode[], order: readonly string[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const best = new Map<string, string[]>();
  for (const id of order) {
    const node = byId.get(id)!;
    if (isSettled(node.row.status)) continue;
    let chain: string[] = [];
    for (const dep of node.dependsOn) {
      const candidate = best.get(dep);
      if (candidate && candidate.length > chain.length) chain = candidate;
    }
    best.set(id, [...chain, id]);
  }
  let longest: string[] = [];
  for (const id of order) {
    const chain = best.get(id);
    if (chain && chain.length > longest.length) longest = chain;
  }
  // A lone unfinished task is not a path; it is just a task.
  return longest.length > 1 ? longest : [];
}

/** Kahn's algorithm; the ids that remain are in, or behind, a cycle. */
function topologicalOrder(ids: readonly string[], deps: ReadonlyMap<string, readonly string[]>): { order: string[]; stuck: string[] } {
  const remaining = new Map(ids.map((id) => [id, deps.get(id)!.length]));
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) for (const dep of deps.get(id)!) dependents.get(dep)!.push(id);
  const queue = ids.filter((id) => remaining.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id)!) {
      const left = remaining.get(next)! - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return { order, stuck: ids.filter((id) => !order.includes(id)) };
}

/**
 * The tasks to draw: the run's entry where it has one (the status stream is the
 * newer word), else the plan's own. A plan that has not started has no run
 * entries yet, and the List draws it from the plan alone, so the graph must too.
 */
export function graphTasks(plan: SurfacePlan | null, run: RunView): RunTask[] {
  if (!plan) return run.tasks;
  const held = new Map(run.tasks.map((t) => [t.id, t]));
  return reduceRun(EMPTY_RUN, { type: 'plan_snapshot', plan }).tasks.map((t) => held.get(t.id) ?? t);
}

export function buildGraph(tasks: readonly RunTask[], ctx: GraphContext): GraphModel {
  const now = ctx.now ?? new Date();
  const top = [...tasks].sort((a, b) => a.order - b.order);
  const topIds = new Set(top.map((t) => t.id));
  // A dependency on a subtask is drawn on the top-level task that holds it: subtasks fold into their parent.
  const owner = new Map<string, string>();
  for (const task of top) {
    owner.set(task.id, task.id);
    const visit = (subs: readonly RunTask[]): void => subs.forEach((s) => { owner.set(s.id, task.id); visit(s.subtasks); });
    visit(task.subtasks);
  }
  const depsOf = new Map<string, string[]>();
  for (const task of top) {
    const deps = new Set<string>();
    for (const dep of task.dependencies) {
      const holder = owner.get(dep);
      if (holder && holder !== task.id && topIds.has(holder)) deps.add(holder);
    }
    depsOf.set(task.id, [...deps]);
  }
  const { order, stuck } = topologicalOrder(top.map((t) => t.id), depsOf);
  if (stuck.length > 0) {
    const refs = stuck.map((id) => `#${top.find((t) => t.id === id)!.order}`);
    return { ok: false, reason: `Tasks ${refs.join(', ')} depend on each other in a loop, so the graph cannot lay them out.` };
  }

  const dependentsOf = new Map<string, string[]>(top.map((t) => [t.id, []]));
  for (const [id, deps] of depsOf) for (const dep of deps) dependentsOf.get(dep)!.push(id);

  const modes = (runner: string | undefined): readonly { id: string; autonomous?: boolean }[] =>
    (runner && ctx.modesByRunner?.[runner]) || [];

  const nodes: GraphNode[] = top.map((task) => {
    const row = taskRowView(subjectOf(task), { tasks: top, modes: modes(task.assignedRunner) });
    const unmerged = row.status === 'done' && ctx.handoffPending && task.isolation?.state === 'integrated';
    const status = statusOf(row.status, { unmerged });
    const orderLabel = row.orderLabel;
    const fold = foldOf(task, row, orderLabel);
    const expanded = ctx.expanded.has(task.id) && fold !== null;
    const node: GraphNode = {
      id: task.id,
      task,
      row,
      status,
      orderLabel,
      title: task.title,
      assignment: assignmentOf(task),
      badges: badgesOf(task, row),
      flags: flagsOf(task, row),
      loop: loopOf(task, row),
      statusLine: statusLineOf(row, status, task.idleSince, now),
      fold,
      actions: row.actions,
      dependsOn: depsOf.get(task.id)!,
      dependents: dependentsOf.get(task.id)!,
      critical: false,
      width: NODE_WIDTH,
      height: heightOf(fold, expanded),
      label: '',
      description: '',
      viewKey: '',
    };
    return node;
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path = ctx.executing ? criticalPath(nodes, order) : [];
  const onPath = new Set(path);
  const refOf = (id: string): string => `#${byId.get(id)!.orderLabel}`;
  for (const node of nodes) {
    node.critical = onPath.has(node.id);
    node.label = `#${node.orderLabel} ${node.title}, ${node.statusLine.charAt(0).toLowerCase()}${node.statusLine.slice(1)}`;
    node.description = describeEdges(node.dependsOn.map(refOf), node.dependents.map(refOf));
    node.viewKey = JSON.stringify([
      node.status.id, node.statusLine, node.orderLabel, node.title, node.assignment, node.description, node.badges.map((b) => b.label),
      node.flags.map((f) => [f.label, f.title]), node.loop?.label, node.critical, node.height,
      node.fold && [node.fold.summary, node.fold.subtasks.map((s) => [s.title, s.status.id]), node.fold.childPlan?.goal],
      node.actions,
    ]);
  }

  const pathEdges = new Set(path.slice(1).map((id, i) => `${path[i]}->${id}`));
  const edges: GraphEdge[] = nodes.flatMap((target) => target.dependsOn.map((source) => {
    const id = `${source}->${target.id}`;
    return { id, source, target: target.id, state: edgeState(byId.get(source)!, target), critical: pathEdges.has(id) };
  }));

  // Position depends on shape alone: who depends on whom, and how tall each node is.
  const layoutKey = JSON.stringify([nodes.map((n) => [n.id, n.height]), edges.map((e) => e.id)]);
  return { ok: true, nodes, edges, layoutKey };
}

/** "depends on #1; #3 and #4 depend on it", or "no dependencies". */
export function describeEdges(dependsOn: readonly string[], dependents: readonly string[]): string {
  const list = (refs: readonly string[]): string =>
    refs.length <= 2 ? refs.join(' and ') : `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
  const parts = [
    dependsOn.length > 0 ? `depends on ${dependsOn.join(', ')}` : null,
    dependents.length > 0 ? `${list(dependents)} ${dependents.length === 1 ? 'depends' : 'depend'} on it` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : 'no dependencies';
}

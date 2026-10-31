import type { TaskStatus } from '../models/Task';

/** A task the plan block does not list, which it can still name by its reference. */
export interface UnlistedRow {
  id: string;
  /** `#order`, or a subtask's dotted label. */
  ref: string;
  title: string;
  status: TaskStatus;
  /** Its line short of what it waits for, which takes a start-rule walk: a change to any of it is a change to the task. */
  fields: string;
}

/** A task as the plan block shows it: its line, under the reference the line names it by. */
export interface PlanRow extends UnlistedRow {
  line: string;
}

/** The plan as the planner is shown it now. */
export interface PlanView {
  /** The tasks the block lists, in plan order: all of them unless the plan is too large (`planWindow`). */
  rows: readonly PlanRow[];
  /** The rest, in plan order: counted in the block, not listed. */
  unlisted: readonly UnlistedRow[];
  /** What the block says of the unlisted tasks; empty when there are none. */
  overflow: string;
  /** The whole block: every listed line, then the read and edit protocol. */
  full: string;
  /** What runs and which tasks it locks; empty while nothing runs. */
  running: string;
  /** Whether the planner reads through Ordewell's tools, which a change block points it to. */
  tools: boolean;
}

/** What the blocks are built from, as it stands now. */
export interface PromptBlocksSource {
  /** The catalog block, or the tools reminder in its place; null without a plan. */
  catalog(): string | null;
  /** Null without a plan; a plan with no tasks is a view with no rows. */
  plan(): PlanView | null;
  /** The compactions the backend has counted (`IAiService.compactions`). */
  compactions(): number;
}

/** One turn's blocks, and what makes them held. */
export interface TurnBlocks {
  readonly blocks: readonly string[];
  /** The turn landed normally: the live context holds what it was sent. */
  heard(): void;
}

/** The planner's view of each task, by id: a line for those listed, a count for the rest. */
interface HeldPlan {
  rows: ReadonlyMap<string, PlanRow>;
  unlisted: ReadonlyMap<string, UnlistedRow>;
}

/** What the live context holds of the blocks. */
interface Held {
  catalog: string | null;
  /** Null when it holds no whole plan block. */
  plan: HeldPlan | null;
  /** The backend's count as the turn was built: a compaction since may have taken the blocks out. */
  compactions: number;
}

const NOT_RUNNING = 'Execution is not running.';

/**
 * The per-turn prompt blocks — the catalog block and the plan block — and what
 * the planner's live context already holds of them (ADR-0012 T10).
 *
 * A vendor planner keeps its message list and a harness planner its session,
 * so every block a turn sends stays in the model's context. The plan goes
 * whole once per live context; each later turn sends only the lines that
 * changed since the turn before, and the catalog only when it changed.
 * Whenever the live context may not hold an intact copy, the next turn sends
 * the whole block again: a stale plan in the planner's head costs more than a
 * long turn. An emptied plan has no whole block to send, so it is stated
 * plainly, and again until a turn that carried that lands.
 */
export class PromptBlocks {
  private held: Held | null = null;
  /**
   * Whether the planner may still hold rows of this plan. A failed, stopped or
   * compacted turn drops `held` while the model's context keeps what it was
   * sent, so an empty plan can only be stated, never diffed.
   */
  private mayHoldTasks = false;

  constructor(private readonly source: PromptBlocksSource) {}

  /** The next turn's blocks. */
  next(): TurnBlocks {
    const compactions = this.source.compactions();
    const held = this.held?.compactions === compactions ? this.held : null;
    // Taken, not read: only a turn that lands normally puts it back. One that
    // fails, is stopped or is sent again may have been cut off before the
    // model read what it was sent, while its message stays in the context, so
    // the turn after it cannot say what changed against either view.
    this.held = null;
    const catalog = this.source.catalog();
    const plan = this.source.plan();
    const rows = plan?.rows ?? [];
    const unlisted = plan?.unlisted ?? [];
    const blocks = [
      catalog !== null && catalog !== held?.catalog ? catalog : null,
      plan ? planBlock(plan, held?.plan ?? null, this.mayHoldTasks) : null,
    ].filter((block): block is string => block !== null);
    if (rows.length > 0) this.mayHoldTasks = true;
    // A plan with no tasks has no line to hold; re-adding one sends the whole
    // block, since the planner never held this plan's protocol.
    const sent: Held = { catalog, plan: rows.length > 0 ? { rows: byId(rows), unlisted: byId(unlisted) } : null, compactions };
    return {
      blocks,
      heard: () => {
        this.held = sent;
        // Only a heard no-tasks turn proves the planner now holds the empty
        // plan: any other turn may have been cut off before it read one.
        if (rows.length === 0) this.mayHoldTasks = false;
      },
    };
  }

  /** The live context is gone or replaced: it holds none of the blocks. What it was told of a plan with tasks is kept: a replay may still carry that. */
  forget(): void {
    this.held = null;
  }

  /** A fresh plan takes this conversation's place: the model holds none of the blocks and never saw the old plan. */
  restart(): void {
    this.held = null;
    this.mayHoldTasks = false;
  }
}

/** The whole block where the planner holds none, else what changed since its last view; nothing when the plan has no tasks and the planner was never sent any. */
function planBlock(plan: PlanView, held: HeldPlan | null, mayHoldTasks: boolean): string | null {
  if (plan.rows.length === 0) {
    if (held && held.rows.size > 0) return changesBlock(plan, { changed: [], removed: [...held.rows.values()], left: [], unlisted: [] });
    return mayHoldTasks ? noTasksBlock(plan) : null;
  }
  const everyRow = [...plan.rows, ...plan.unlisted];
  if (!held || renumbered(everyRow, held)) return plan.full;
  const listed = new Set(plan.rows.map((row) => row.id));
  const exists = new Set(everyRow.map((row) => row.id));
  const changed = plan.rows.filter((row) => held.rows.get(row.id)?.line !== row.line);
  const removed = [...held.rows.values(), ...held.unlisted.values()].filter((row) => !exists.has(row.id));
  // Still in the plan, but out of the list the planner holds a line of.
  const left = plan.unlisted.filter((row) => held.rows.has(row.id) && !listed.has(row.id));
  const unlisted = plan.unlisted.flatMap((row) => {
    const was = heldUnlisted(row, held);
    return was === 'same' ? [] : [`${was}, not listed: ${row.fields.trim()}`];
  });
  const changes = changesBlock(plan, { changed, removed, left, unlisted });
  return changes.length < plan.full.length ? changes : plan.full;
}

const byId = <T extends UnlistedRow>(rows: readonly T[]): ReadonlyMap<string, T> => new Map(rows.map((row) => [row.id, row]));

/** How a task not listed differs from the planner's view of it; one that held a line says so as it leaves the list. */
function heldUnlisted(row: UnlistedRow, held: HeldPlan): 'same' | 'added' | 'changed' {
  if (held.rows.has(row.id)) return 'same';
  const was = held.unlisted.get(row.id);
  if (!was) return 'added';
  return was.fields === row.fields ? 'same' : 'changed';
}

/**
 * Whether a task goes by another reference than the planner holds, or a new
 * task by one it holds for another: every line it was shown names its
 * dependencies by reference, so a change block would be read against the
 * wrong tasks.
 */
function renumbered(rows: readonly UnlistedRow[], held: HeldPlan): boolean {
  const heldRows = new Map<string, UnlistedRow>([...held.rows, ...held.unlisted]);
  const heldRefs = new Set([...heldRows.values()].map(({ ref }) => ref));
  return rows.some((row) => {
    const was = heldRows.get(row.id);
    return was ? was.ref !== row.ref : heldRefs.has(row.ref);
  });
}

/** What a change block names; `unlisted` is the finished line of each task that moved outside the list. */
interface PlanChanges {
  changed: readonly PlanRow[];
  removed: readonly UnlistedRow[];
  left: readonly UnlistedRow[];
  unlisted: readonly string[];
}

function changesBlock(plan: PlanView, { changed, removed, left, unlisted }: PlanChanges): string {
  const listed = changed.length === 0 && removed.length === 0 && left.length === 0 && unlisted.length === 0
    ? ['<plan_changes>The plan is unchanged since it was last shown above.</plan_changes>']
    : [
      '<plan_changes>',
      ...changed.map((row) => row.line),
      ...left.map((row) => `no longer listed: ${row.ref} id=${row.id} "${row.title}" [${row.status}]`),
      ...unlisted,
      ...removed.map((row) => `removed: ${row.ref} id=${row.id} "${row.title}"`),
      '</plan_changes>',
    ];
  const reread = plan.tools ? 'call task_query' : 'read the tasks with a taskQuery';
  return [
    ...listed,
    ...(plan.rows.length === 0 ? ['The plan now has no tasks.'] : []),
    ...(plan.overflow ? [plan.overflow] : []),
    plan.running || NOT_RUNNING,
    `Any other task not listed is as last shown, and the protocol sent with the last <current_plan> still applies. If you no longer have that block, ${reread} before editing.`,
  ].join('\n');
}

/** The empty plan stated where its last rows are not in hand to name, so the ones in the planner's context are not read as current. */
function noTasksBlock(plan: PlanView): string {
  return [
    'The plan now has no tasks. The task list you were last shown is no longer current.',
    plan.running || NOT_RUNNING,
  ].join('\n');
}

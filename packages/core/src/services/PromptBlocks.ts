import type { TaskStatus } from '../models/Task';

/** A task the plan block does not list, which it can still name by its reference. */
export interface UnlistedRow {
  id: string;
  /** `#order`, or a subtask's dotted label. */
  ref: string;
  title: string;
  status: TaskStatus;
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

/** What the live context holds of the blocks. */
interface Held {
  catalog: string | null;
  /** The planner's view of each task, by id; null when it holds no whole plan block. */
  plan: ReadonlyMap<string, PlanRow> | null;
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
    const blocks = [
      catalog !== null && catalog !== held?.catalog ? catalog : null,
      plan ? planBlock(plan, held?.plan ?? null, this.mayHoldTasks) : null,
    ].filter((block): block is string => block !== null);
    if (rows.length > 0) this.mayHoldTasks = true;
    // A plan with no tasks has no line to hold; re-adding one sends the whole
    // block, since the planner never held this plan's protocol.
    const sent: Held = { catalog, plan: rows.length > 0 ? new Map(rows.map((row) => [row.id, row])) : null, compactions };
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
function planBlock(plan: PlanView, held: ReadonlyMap<string, PlanRow> | null, mayHoldTasks: boolean): string | null {
  if (plan.rows.length === 0) {
    if (held && held.size > 0) return changesBlock(plan, [], [...held.values()], []);
    return mayHoldTasks ? noTasksBlock(plan) : null;
  }
  const everyRow = [...plan.rows, ...plan.unlisted];
  if (!held || renumbered(everyRow, held)) return plan.full;
  const listed = new Set(plan.rows.map((row) => row.id));
  const exists = new Set(everyRow.map((row) => row.id));
  const changed = plan.rows.filter((row) => held.get(row.id)?.line !== row.line);
  const removed = [...held.values()].filter((row) => !exists.has(row.id));
  // Still in the plan, but out of the list the planner holds a line of.
  const left = plan.unlisted.filter((row) => held.has(row.id) && !listed.has(row.id));
  const changes = changesBlock(plan, changed, removed, left);
  return changes.length < plan.full.length ? changes : plan.full;
}

/**
 * Whether a task goes by another reference than the planner holds, or a new
 * task by one it holds for another: every line it was shown names its
 * dependencies by reference, so a change block would be read against the
 * wrong tasks.
 */
function renumbered(rows: readonly UnlistedRow[], held: ReadonlyMap<string, PlanRow>): boolean {
  const heldRefs = new Set([...held.values()].map(({ ref }) => ref));
  return rows.some((row) => {
    const was = held.get(row.id);
    return was ? was.ref !== row.ref : heldRefs.has(row.ref);
  });
}

function changesBlock(plan: PlanView, changed: readonly PlanRow[], removed: readonly PlanRow[], left: readonly UnlistedRow[]): string {
  const listed = changed.length === 0 && removed.length === 0 && left.length === 0
    ? ['<plan_changes>The plan is unchanged since it was last shown above.</plan_changes>']
    : [
      '<plan_changes>',
      ...changed.map((row) => row.line),
      ...left.map((row) => `no longer listed: ${row.ref} id=${row.id} "${row.title}" [${row.status}]`),
      ...removed.map((row) => `removed: ${row.ref} id=${row.id} "${row.title}"`),
      '</plan_changes>',
    ];
  const reread = plan.tools ? 'call task_query' : 'read the tasks with a taskQuery';
  return [
    ...listed,
    ...(plan.rows.length === 0 ? ['The plan now has no tasks.'] : []),
    ...(plan.overflow ? [plan.overflow] : []),
    plan.running || NOT_RUNNING,
    `Tasks not listed are as last shown, and the protocol sent with the last <current_plan> still applies. If you no longer have that block, ${reread} before editing.`,
  ].join('\n');
}

/** The empty plan stated where its last rows are not in hand to name, so the ones in the planner's context are not read as current. */
function noTasksBlock(plan: PlanView): string {
  return [
    'The plan now has no tasks. The task list you were last shown is no longer current.',
    plan.running || NOT_RUNNING,
  ].join('\n');
}

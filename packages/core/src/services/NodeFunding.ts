import type { DelegatedRow } from '../models/Delegation';
import type { Task } from '../models/Task';
import { ROOT_NODE, type NodePath } from '../models/TreeEvent';
import type { EventStore } from './eventStore';
import { mintSessionId } from '../utils/sessionId';
import type { IsolationRunController } from './IsolationRunController';
import { delegatedRequest, narrow, type Mandate, type MandateRequest } from './Mandate';
import type { NodeFunds } from './PlanChangeCheck';
import { TreeLedger, type Carved, type NodeBudget } from './TreeLedger';

/**
 * A node's side of the tree's budget ledger (ADR-0056 M5), as its Session asks
 * for it: what it has left, the carve and raise of its children, and its own
 * budget's turns and stops. One kind of node at every depth (ADR-0055 D4), so a
 * Session holds one of these and never asks which depth it is at: a
 * {@link RootFunding} opens the tree's log and is charged nothing, a
 * {@link ChildFunding} holds what its parent carved.
 */
export interface NodeFunding {
  /** This node's place in the ledger. */
  readonly path: NodePath;
  /** The tree as this process holds it, without waiting: null at a root nothing has opened one for yet, which a flat run never does (ADR-0058 S3). */
  readonly tree: TreeLedger | null;
  /** The tree, opened from the log at a root if nothing has yet. */
  ledger(): Promise<TreeLedger>;
  /** The session's tree is let go: a root's goes with its session, a child's stays its root's. */
  letGo(): void;
  /** What the ledger says of this node's budget in this tick, for a check that has no wait to open one with. */
  held(): NodeFunds | undefined;
  /** A child's mandate and budget, carved from what this node has left (ADR-0056 M4, M5). */
  carve(taskId: string, request: Omit<MandateRequest, 'level'>, reopening?: string): Promise<Carved>;
  /** The carve a delegated task's child starts with: what its task has left, after closing what a crash or an edit left open (M10). Throws once nothing is. */
  carveFor(task: Task, reopening?: string): Promise<Carved>;
  /** A raise for the child in `taskId`. Null when it took; otherwise why not. */
  raise(taskId: string, tokens: number): Promise<string | null>;
  /** The child `sessionId` is gone: what it did not spend comes back here. */
  closeChild(sessionId: string): Promise<void>;
  /** A delegated task's tokens as its row shows them, read afresh (ADR-0055 D20). */
  rowTokens(task: Readonly<Task>): DelegatedRow['tokens'];
  /** Why this node's next planner turn may not start, or null. */
  turnRefusal(): string | null;
  /** Nothing here can go on, for this reason. */
  stop(why: string): void;
  /** Why this node stopped for its budget, or null. */
  stoppedFor(): string | null;
  /** The child `sessionId` asked this node's planner: it pays first for the answer. */
  woken(sessionId: string): void;
  /** This node's planner turn ended. */
  parked(): void;
  /** This node itself closed: what it did not spend goes back to its parent. */
  closeOwn(): void;
}

/** What a node's funding reads of its Session, afresh each time it asks. */
export interface FundingHost {
  /** This node's mandate as it stands, which a carve narrows. */
  mandate(): Mandate;
  /** This node's level, which a refusal of its carve names. */
  readonly level: number;
  /** Its run's worktree seats, which a child is carved into (ADR-0055 D12, D17). */
  seats(): Pick<IsolationRunController, 'requireChildSeat' | 'childSession' | 'hostChild'>;
  /** Whether the plan still holds the task. */
  planHas(taskId: string): boolean;
}

export interface RootFundingHost extends FundingHost {
  /** The session the tree is the root of; a new one reads its own log. */
  sessionId(): string;
  /** The tree's log for that session. */
  openLog(sessionId: string): EventStore;
  /** The tree's limit, where the user keeps it, read at each carve and raise. */
  limit(): number;
  warn(message: string): void;
  /** Every child plan stopped: a tree let go writes what they still spend first. */
  childrenStopped(): Promise<unknown>;
}

export interface ChildFundingHost extends FundingHost {
  /** What its parent's carve gave it; a child seated before any carve has none. */
  budget: NodeBudget | undefined;
  /** Its budget stopped it, as a Stop does: nothing can recall what is in flight, so this is what bounds it. */
  stopped(why: string): void;
  /** A raise took: it only moves numbers, so what starts again is the Session's to start. */
  raised(): void;
}

abstract class Funding implements NodeFunding {
  abstract readonly path: NodePath;
  abstract readonly tree: TreeLedger | null;

  constructor(private readonly host: FundingHost) {}

  abstract ledger(): Promise<TreeLedger>;
  abstract letGo(): void;
  abstract turnRefusal(): string | null;
  abstract stop(why: string): void;
  abstract stoppedFor(): string | null;
  abstract woken(sessionId: string): void;
  abstract parked(): void;
  abstract closeOwn(): void;
  /** The tree as it stands as a carve or a raise is asked for, so a raised setting reaches them. */
  protected abstract currentTree(): Promise<TreeLedger>;
  /** The tree to read in this tick, its limits as they stand. */
  protected abstract readTree(): TreeLedger | null;
  /** What can never pass, refused before the ledger is asked for. */
  protected abstract refusedFirst(asked: MandateRequest): Carved | null;

  held(): NodeFunds | undefined {
    const tree = this.readTree();
    if (!tree) return undefined;
    const { path } = this;
    return {
      limit: tree.numbers(path).limit,
      left: tree.left(path),
      stillAsks: (task) => tree.stillAsks(path, task.id, task.budget?.tokens ?? 0),
    };
  }

  /**
   * A child's limit is the ledger's, which a raise has moved past its saved
   * mandate. The task's record names the child only once the carve took, so a
   * refused one leaves no name of a child that never existed.
   */
  async carve(taskId: string, request: Omit<MandateRequest, 'level'>, reopening?: string): Promise<Carved> {
    const asked = { ...request, level: this.host.level };
    const never = this.refusedFirst(asked);
    if (never) return never;
    this.host.seats().requireChildSeat(taskId);
    const tree = await this.currentTree();
    // Again in the step that carves: the worktree may have gone meanwhile, and a carve with nowhere to seat its child holds budget for nothing.
    const seats = this.host.seats();
    seats.requireChildSeat(taskId);
    const carved = tree.carve(this.path, this.host.mandate(), asked, { sessionId: seats.childSession(taskId) ?? reopening ?? mintSessionId(), taskId });
    if (carved.ok) seats.hostChild(taskId, () => carved.budget.sessionId);
    return carved;
  }

  async carveFor(task: Task, reopening?: string): Promise<Carved> {
    const tree = await this.currentTree();
    tree.closeChildren(this.path, (taskId) => taskId === task.id || !taskId || !this.host.planHas(taskId));
    return this.carve(task.id, { ...delegatedRequest(task, this.host.level), ...this.budgetLeft(task, tree) }, reopening);
  }

  /** What is left of what the tree granted a delegated task, its budget and every raise, across every child it has had (ADR-0055 D15, ADR-0056 M5, M10). */
  private budgetLeft(task: Task, tree: TreeLedger): Pick<MandateRequest, 'tokens' | 'wallClockMs'> {
    const granted = (task.budget?.tokens ?? 0) + tree.raisedOn(this.path, task.id);
    const tokens = granted - tree.spentOn(this.path, task.id);
    if (tokens <= 0) throw new Error(`Task "${task.title}" has spent its budget of ${granted} tokens, so no child can start on it.`);
    const clock = task.budget?.wallClockMs;
    if (clock === undefined) return { tokens };
    const wallClockMs = clock - (task.attemptUsage ?? []).reduce((total, attempt) => total + attempt.wallTimeMs, 0);
    if (wallClockMs <= 0) throw new Error(`Task "${task.title}" has spent its time of ${clock} ms, so no child can start on it.`);
    return { tokens, wallClockMs };
  }

  async raise(taskId: string, tokens: number): Promise<string | null> {
    const node = (await this.currentTree()).nodeOf(this.host.seats().childSession(taskId) ?? '');
    return node ? node.tree.raise(node.path, tokens) : 'That task has no child to raise.';
  }

  async closeChild(sessionId: string): Promise<void> {
    const node = (await this.ledger()).nodeOf(sessionId);
    if (node) node.tree.close(node.path);
  }

  rowTokens(task: Readonly<Task>): DelegatedRow['tokens'] {
    const { tree, path } = this;
    const stated = task.budget?.tokens;
    if (stated === undefined) return undefined;
    // Spending is the log's, read when something first asks: before that a task that ran would read as untouched.
    if (tree === null) return task.attempted ? undefined : { budget: stated, left: stated };
    const budget = stated + tree.raisedOn(path, task.id);
    const open = tree.nodeOf(this.host.seats().childSession(task.id) ?? '');
    const spent = open ? tree.taskSpent(open.path) : tree.spentOn(path, task.id);
    return { budget, left: Math.max(0, budget - spent) };
  }
}

/** The root's funding: it opens the tree's log at the first ask, and is charged nothing (ADR-0056 M5). */
export class RootFunding extends Funding {
  readonly path = ROOT_NODE;
  private opened: TreeLedger | null = null;
  /** The opening behind {@link opened}, and the session it opened for. */
  private opening: { sessionId: string; ledger: Promise<TreeLedger> } | null = null;
  /** The ledger let go, which the next opening reads after. */
  private closing: Promise<void> = Promise.resolve();

  constructor(private readonly root: RootFundingHost) {
    super(root);
  }

  get tree(): TreeLedger | null {
    return this.opened;
  }

  /** A Continue asks before a child's seat is handed out, whose placement names its node only once this has answered. */
  ledger(): Promise<TreeLedger> {
    const sessionId = this.root.sessionId();
    if (this.opening?.sessionId === sessionId) return this.opening.ledger;
    this.letGo();
    const ledger = this.closing.then(() => TreeLedger.open(this.root.openLog(sessionId), { sessionId, limit: this.root.limit() }, {
      failed: (err) => this.root.warn(`The tree's event log could not be written, so a restart would not know of its latest spending: ${err instanceof Error ? err.message : String(err)}`),
    }));
    const opening = {
      sessionId,
      ledger: ledger.then((tree) => {
        if (this.opening === opening) this.opened = tree;
        return tree;
      }, (err: unknown) => {
        if (this.opening === opening) this.opening = null;
        throw err;
      }),
    };
    this.opening = opening;
    return opening.ledger;
  }

  letGo(): void {
    const opening = this.opening;
    this.opening = null;
    this.opened = null;
    // What a child winding down still spends, and its close, are written first (ADR-0056 M5).
    if (opening) this.closing = Promise.all([opening.ledger, this.root.childrenStopped()]).then(([tree]) => tree.shutdown()).catch(() => undefined);
  }

  protected async currentTree(): Promise<TreeLedger> {
    const tree = await this.ledger();
    tree.setRootLimit(this.root.limit());
    return tree;
  }

  /** A root with no ledger open has carved nothing yet in this process. */
  protected readTree(): TreeLedger | null {
    this.opened?.setRootLimit(this.root.limit());
    return this.opened;
  }

  /** The first carve is what makes a run a tree, so what can never pass opens no log. */
  protected refusedFirst(asked: MandateRequest): Carved | null {
    const never = narrow(this.root.mandate(), asked);
    return never.ok ? null : never;
  }

  turnRefusal(): string | null { return null; }
  stop(): void {}
  stoppedFor(): string | null { return null; }
  woken(): void {}
  parked(): void {}
  closeOwn(): void {}
}

/** A child's funding: what its parent carved, on its root's tree, which it never opens or lets go of. */
export class ChildFunding extends Funding {
  private readonly budget: NodeBudget | undefined;

  constructor(host: ChildFundingHost) {
    super(host);
    this.budget = host.budget;
    this.budget?.onStop((why) => host.stopped(why));
    this.budget?.onRaised(() => host.raised());
  }

  get path(): NodePath {
    return this.budget?.path ?? ROOT_NODE;
  }

  get tree(): TreeLedger | null {
    return this.budget?.tree ?? null;
  }

  ledger(): Promise<TreeLedger> {
    return this.budget ? Promise.resolve(this.budget.tree) : Promise.reject(new Error('This child holds no budget, so it has no tree to read.'));
  }

  letGo(): void {}

  protected currentTree(): Promise<TreeLedger> {
    return this.ledger();
  }

  protected readTree(): TreeLedger | null {
    return this.tree;
  }

  /** Its parent's carve already narrowed what it holds, and its tree is open. */
  protected refusedFirst(): Carved | null {
    return null;
  }

  turnRefusal(): string | null {
    return this.budget?.turnRefusal() ?? null;
  }

  stop(why: string): void {
    this.budget?.stop(why);
  }

  stoppedFor(): string | null {
    return this.budget?.stoppedFor() ?? null;
  }

  woken(sessionId: string): void {
    const asking = this.budget?.tree.nodeOf(sessionId);
    if (asking) this.budget?.woken(asking.path);
  }

  parked(): void {
    this.budget?.parked();
  }

  closeOwn(): void {
    this.budget?.tree.close(this.budget.path);
  }
}

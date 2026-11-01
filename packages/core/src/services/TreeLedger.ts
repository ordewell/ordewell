import { childPath, isWithin, parentPath, ROOT_NODE, type NodePath, type TreeFact } from '../models/TreeEvent';
import { spentTokens, type UsageRecord } from '../models/Usage';
import type { EventStore } from './eventStore';
import { narrow, type Mandate, type MandateRefusal, type MandateRequest } from './Mandate';

/**
 * A live session's allowance for what it has in flight (ADR-0056 M5), which is
 * one model call: a long context's prompt, its cache reads included, and a reply.
 * An estimate: a runner's own subagents add requests nobody sees until their
 * usage arrives.
 */
export const SESSION_RESERVE_TOKENS = 200_000;

/** One node as the log leaves it. */
export interface TreeNode {
  path: NodePath;
  sessionId: string;
  taskId?: string;
  limit: number;
  /** What its open children hold. */
  committed: number;
  /** Its own, and what its closed children spent. */
  spent: number;
  /** The subplanner's share of `reserve`, held for its next turn. */
  kept: number;
  open: boolean;
  /** Children it has ever opened: the next one's id. */
  opened: number;
}

export type TreeState = Map<NodePath, TreeNode>;

function parentOf(tree: TreeState, node: NodePath): TreeNode | undefined {
  const parent = parentPath(node);
  return parent === null ? undefined : tree.get(parent);
}

/** One fact on `tree`. It only does arithmetic: what to take from whom was decided as the fact was written. */
function applyFact(tree: TreeState, fact: TreeFact): void {
  const node = tree.get(fact.node);
  const parent = parentOf(tree, fact.node);
  switch (fact.kind) {
    case 'node_opened':
      tree.set(fact.node, { path: fact.node, sessionId: fact.sessionId, ...(fact.taskId !== undefined ? { taskId: fact.taskId } : {}), limit: fact.limit, committed: 0, spent: 0, kept: fact.kept, open: true, opened: 0 });
      if (parent) {
        parent.committed += fact.limit;
        parent.opened += 1;
      }
      return;
    case 'node_closed':
      if (!node) return;
      node.open = false;
      if (parent) {
        parent.committed -= node.limit;
        parent.spent += node.spent;
      }
      return;
    case 'tokens_spent':
      if (!node) return;
      node.spent += fact.tokens;
      if (fact.turn) node.kept = Math.max(0, node.kept - fact.tokens);
      return;
    case 'budget_raised':
      if (node) node.limit += fact.tokens;
      if (parent) parent.committed += fact.tokens;
      return;
    case 'budget_taken':
      if (node) node.limit -= fact.tokens;
      if (parent) parent.committed -= fact.tokens;
      return;
    case 'reserve_kept':
      if (node) node.kept += fact.tokens;
      return;
    case 'limit_set':
      if (node) node.limit = fact.limit;
  }
}

/** The tree a log holds (ADR-0058 S3). The live ledger is this same fold, so a restart cannot read otherwise. */
export function foldTree(facts: readonly TreeFact[]): TreeState {
  const tree: TreeState = new Map();
  for (const fact of facts) applyFact(tree, fact);
  return tree;
}

/** A node's four numbers (ADR-0056 M5). `spent + committed + reserve ≤ limit`, unless `spent` overshot, as nothing can recall a request. */
export interface BudgetNumbers {
  limit: number;
  committed: number;
  spent: number;
  reserve: number;
}

/** What a claim holds until its attempt ends. */
export interface BudgetHold {
  /** Idempotent. */
  release(): void;
}

export type Carved = { ok: true; mandate: Mandate; budget: NodeBudget } | { ok: false; refusal: MandateRefusal };

/** One node's side of the ledger, as a Session spends it. */
export interface NodeBudget {
  readonly path: NodePath;
  readonly sessionId: string;
  readonly tree: TreeLedger;
  /** Why a new session may not start here, or null. Changes nothing: a claim's refusal is also asked with no claim to follow. */
  refusal(): string | null;
  /** In the claim's synchronous step, so concurrent claims each see the last one's. */
  hold(): BudgetHold;
  spent(record: UsageRecord, on: { taskId: string; attempt: number }): void;
  /** Why a subplanner's turn may not start, or null: that share, room and its children's room must come to one session. */
  turnRefusal(): string | null;
  turnSpent(record: UsageRecord): void;
  /** `child` asked this turn: it pays first for what the turn cannot (M5). */
  woken(child: NodePath): void;
  /** The turn ended: keep one session again, from room, then from the children's. */
  parked(): void;
  /** Nothing here can go on, for this reason. Said once, until a raise. */
  stop(why: string): void;
  /** Why it stopped, or null: what a parent reads to end it `blocked`. */
  stoppedFor(): string | null;
  /** Tell `listener` why, each time this node stops. Returns how to stop being told. */
  onStop(listener: (why: string) => void): () => void;
  /** Tell `listener` each time a raise takes: it only moves numbers, so what the node's Session starts again is its own. */
  onRaised(listener: () => void): void;
}

export interface TreeLedgerOptions {
  /** {@link SESSION_RESERVE_TOKENS} unless a test works with smaller numbers. */
  sessionReserve?: number;
  /** The log refused a write. What it refused waits and goes with the next. */
  failed?: (err: unknown) => void;
}

/** A node's level, as a refusal names it (ADR-0056 M4). */
const levelOf = (node: NodePath): number => node.split('/').length - 1;

/**
 * The budget ledger (ADR-0056 M5), the root's and shared down its tree. Every
 * read and decision is synchronous, as a claim is (ADR-0029); what is decided
 * goes to the log behind it, whole, in the order it was decided. Only budgets
 * are here: a child's mandate and what to spend it on are its Session's.
 *
 * What is live is held here and never logged: nothing is live after a restart.
 */
export class TreeLedger {
  private readonly reserve: number;
  private readonly failed: (err: unknown) => void;
  /** Sessions holding an allowance, by node. */
  private readonly live = new Map<NodePath, number>();
  /** Who pays first for the turn under way, by node. */
  private readonly wakers = new Map<NodePath, NodePath>();
  private readonly listeners = new Map<NodePath, Set<(why: string) => void>>();
  private readonly raiseListeners = new Map<NodePath, () => void>();
  /** Why each stopped node did, which a raise clears (M5). */
  private readonly stopped = new Map<NodePath, string>();
  private pending: TreeFact[] = [];
  private writing: Promise<void> | null = null;
  private failureSaid = false;

  private constructor(private readonly store: EventStore, private readonly tree: TreeState, options: TreeLedgerOptions) {
    this.reserve = options.sessionReserve ?? SESSION_RESERVE_TOKENS;
    this.failed = options.failed ?? (() => undefined);
  }

  /** Rebuild from the log, and from nothing else (ADR-0058 S3). A log with no root gets one: this is the first carve of a tree. */
  static async open(store: EventStore, root: { sessionId: string; limit: number }, options: TreeLedgerOptions = {}): Promise<TreeLedger> {
    const tree: TreeState = new Map();
    for await (const event of store.read(0)) applyFact(tree, event);
    const ledger = new TreeLedger(store, tree, options);
    if (!tree.has(ROOT_NODE)) ledger.write({ kind: 'node_opened', node: ROOT_NODE, sessionId: root.sessionId, limit: root.limit, kept: 0 });
    return ledger;
  }

  private write(fact: DistributiveOmit<TreeFact, 'at'>): void {
    const stamped = { ...fact, at: new Date().toISOString() } as TreeFact;
    applyFact(this.tree, stamped);
    this.pending.push(stamped);
    this.flush();
  }

  /** What one step decides lands as one batch: the first await lets the step finish. */
  private flush(): void {
    this.writing ??= (async () => {
      await Promise.resolve();
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        try {
          await this.store.append(batch);
          this.failureSaid = false;
        } catch (err) {
          this.pending = [...batch, ...this.pending];
          if (!this.failureSaid) this.failed(err);
          this.failureSaid = true;
          break;
        }
      }
      this.writing = null;
    })();
  }

  /** Everything decided so far has been offered to the log. */
  async flushed(): Promise<void> {
    while (this.writing) await this.writing;
  }

  /** The Session holding the tree is closing. */
  async shutdown(): Promise<void> {
    await this.flushed();
    this.flush();
    await this.flushed();
    await this.store.close();
  }

  private at(node: NodePath): TreeNode {
    const found = this.tree.get(node);
    if (!found) throw new Error(`The tree has no node ${node}.`);
    return found;
  }

  private liveReserve(node: NodePath): number {
    return (this.live.get(node) ?? 0) * this.reserve;
  }

  /** What `limit` leaves once its node's spending and children are paid: its reserve and room. */
  private free({ limit, spent, committed }: TreeNode): number {
    return limit - spent - committed;
  }

  private room(node: TreeNode): number {
    return node.open ? Math.max(0, this.free(node) - node.kept - this.liveReserve(node.path)) : 0;
  }

  numbers(path: NodePath): BudgetNumbers {
    const node = this.at(path);
    const { limit, committed, spent, kept } = node;
    return { limit, committed, spent, reserve: Math.min(kept + this.liveReserve(path), Math.max(0, this.free(node))) };
  }

  /** What a node can still carve or claim: `limit` less the other three. What `narrow` is handed as the parent's tokens (M4). */
  left(path: NodePath): number {
    return this.room(this.at(path));
  }

  node(path: NodePath): NodeBudget {
    const { sessionId } = this.at(path);
    return {
      path,
      sessionId,
      tree: this,
      refusal: () => {
        const left = this.left(path);
        return left >= this.reserve ? null : `Level ${levelOf(path)} refused this start: a session here needs ${this.reserve} tokens to start, and ${left} of its ${this.at(path).limit} are left.`;
      },
      hold: () => this.hold(path),
      spent: (record, { taskId, attempt }) => this.spend(path, spentTokens(record), { taskId, attempt }),
      turnRefusal: () => {
        const left = this.turnCover(path);
        return left >= this.reserve ? null : `Level ${levelOf(path)} refused this turn: a turn here needs ${this.reserve} tokens to start, and ${left} are left across this node and its children.`;
      },
      turnSpent: (record) => this.spend(path, spentTokens(record), { turn: true }),
      woken: (child) => { this.wakers.set(path, child); },
      parked: () => this.park(path),
      stop: (why) => this.stopNode(path, why),
      stoppedFor: () => this.stopped.get(path) ?? null,
      onStop: (listener) => {
        const listeners = this.listeners.get(path) ?? new Set();
        this.listeners.set(path, listeners);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      onRaised: (listener) => { this.raiseListeners.set(path, listener); },
    };
  }

  /** Every node ever opened under `path`, closed ones too, nearest first: a reference outlives the child it names (ADR-0057 R1). */
  below(path: NodePath): TreeNode[] {
    return [...this.tree.values()].filter((node) => node.path !== path && isWithin(node.path, path));
  }

  /** What `path` and everything under it spent: a closed child is in its parent's `spent`, an open one still its own (M5). */
  subtreeSpent(path: NodePath): number {
    return this.at(path).spent + this.openChildren(path).reduce((sum, child) => sum + this.subtreeSpent(child.path), 0);
  }

  /** The open node `sessionId` is, if any: what a reopen finds. */
  nodeOf(sessionId: string): NodeBudget | undefined {
    const found = [...this.tree.values()].find((node) => node.open && node.sessionId === sessionId);
    return found && this.node(found.path);
  }

  /** What every child `parent` opened for `taskId` has spent, closed ones included: a retry's budget is what they left (ADR-0056 M10). */
  spentOn(parent: NodePath, taskId: string): number {
    return [...this.tree.values()].filter((node) => node.taskId === taskId && parentPath(node.path) === parent).reduce((total, node) => total + node.spent, 0);
  }

  /** Close the children of `parent` that `gone` picks by their task: no session is live in them, so what they hold would stay committed for good. */
  closeChildren(parent: NodePath, gone: (taskId: string | undefined) => boolean): void {
    for (const child of this.openChildren(parent)) if (gone(child.taskId)) this.close(child.path);
  }

  private hold(path: NodePath): BudgetHold {
    this.live.set(path, (this.live.get(path) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const live = this.live.get(path) ?? 0;
        if (live > 0) this.live.set(path, live - 1);
      },
    };
  }

  private openChildren(path: NodePath): TreeNode[] {
    return [...this.tree.values()].filter((node) => node.open && parentPath(node.path) === path);
  }

  /** What a turn can reach: what its node has beside its live sessions, and its children's room. */
  private turnCover(path: NodePath): number {
    const node = this.at(path);
    const own = Math.max(0, this.free(node) - this.liveReserve(path));
    return this.openChildren(path).reduce((total, child) => total + this.room(child), own);
  }

  /**
   * A child's mandate, carved from what `parent` has left (ADR-0056 M4, M5). One
   * synchronous step, so no second carve can read the same room.
   */
  carve(parent: NodePath, mandate: Mandate, request: MandateRequest, child: { sessionId: string; taskId: string }): Carved {
    const left = this.left(parent);
    const narrowed = narrow({ ...mandate, limits: { ...mandate.limits, tokens: left } }, request);
    if (!narrowed.ok) return narrowed;
    if (this.nodeOf(child.sessionId)) {
      return { ok: false, refusal: { level: request.level, field: 'limits.tokens', asked: String(request.tokens), there: 'a budget this child already holds' } };
    }
    const limit = narrowed.mandate.limits.tokens;
    const path = childPath(parent, String(this.at(parent).opened + 1));
    this.write({ kind: 'node_opened', node: path, sessionId: child.sessionId, taskId: child.taskId, limit, kept: Math.min(limit, this.reserve) });
    return { ok: true, mandate: narrowed.mandate, budget: this.node(path) };
  }

  /**
   * A raise, for the parent's answer to a checkpoint to apply (M5): from what
   * the parent has left, the child's limit and the parent's `committed` rising
   * together. Null when it took; otherwise why not.
   */
  raise(path: NodePath, tokens: number): string | null {
    const parent = parentPath(path);
    if (parent === null) return 'Only the user raises the tree\'s budget.';
    if (!Number.isSafeInteger(tokens) || tokens < 1) return 'A raise is a whole number of tokens, 1 or more.';
    if (!this.at(path).open) return 'That child has closed, so nothing can raise its budget.';
    const left = this.left(parent);
    if (tokens > left) return `Level ${levelOf(parent)} refused this raise: it asks ${tokens} tokens, and ${left} are left.`;
    this.write({ kind: 'budget_raised', node: path, tokens });
    this.stopped.delete(path);
    this.raiseListeners.get(path)?.();
    return null;
  }

  /** Where the user keeps the tree's budget (ADR-0056 M5), read as a carve or a raise is asked for. */
  setRootLimit(limit: number): void {
    if (this.at(ROOT_NODE).limit !== limit) this.write({ kind: 'limit_set', node: ROOT_NODE, limit });
  }

  /**
   * A child ended, on confirmed close: what it did not spend returns to its
   * parent and goes no further (M5), so a sibling gets it only by the parent's
   * next carve. What is still open under it closes first, in the same step.
   */
  close(path: NodePath): void {
    if (!this.at(path).open) return;
    this.closeUnder(path);
    const parent = parentPath(path);
    if (parent !== null) this.settle(parent);
  }

  private closeUnder(path: NodePath): void {
    for (const child of this.openChildren(path)) this.closeUnder(child.path);
    this.write({ kind: 'node_closed', node: path });
    this.live.delete(path);
    this.wakers.delete(path);
    this.listeners.delete(path);
    this.raiseListeners.delete(path);
  }

  private nearestOpen(path: NodePath): NodePath {
    for (let node: NodePath | null = path; node !== null; node = parentPath(node)) {
      if (this.at(node).open) return node;
    }
    return ROOT_NODE;
  }

  private spend(path: NodePath, tokens: number, tag: { taskId?: string; attempt?: number; turn?: true }): void {
    if (tokens <= 0) return;
    // A runner winds down after its attempt: what it reports still has to be paid for, and not from a turn's share.
    const node = this.nearestOpen(path);
    const { turn, ...on } = tag;
    this.write({ kind: 'tokens_spent', node, tokens, ...on, ...(turn && node === path ? { turn } : {}) });
    this.settle(node);
  }

  /** Past what it can pay, a node's spending takes its children's room; with none left it is out. */
  private settle(path: NodePath): void {
    const node = this.at(path);
    const short = -this.free(node);
    if (short > 0) this.takeFromChildren(path, short);
    if (this.free(node) <= 0) this.spentOut(path);
  }

  /** Take up to `short` of the children's room, the child that woke the turn first and then the oldest. Returns what it took. */
  private takeFromChildren(path: NodePath, short: number): number {
    const waker = this.wakers.get(path);
    const children = this.openChildren(path).sort((a, b) => Number(b.path === waker) - Number(a.path === waker));
    let taken = 0;
    for (const child of children) {
      const tokens = Math.min(short - taken, this.room(child));
      if (tokens <= 0) continue;
      this.write({ kind: 'budget_taken', node: child.path, tokens });
      taken += tokens;
      if (this.free(child) <= 0) this.spentOut(child.path);
    }
    return taken;
  }

  private park(path: NodePath): void {
    const node = this.at(path);
    if (node.open) {
      const want = this.reserve - node.kept;
      if (want > 0) {
        const fromRoom = Math.min(want, this.room(node));
        const tokens = fromRoom + this.takeFromChildren(path, want - fromRoom);
        if (tokens > 0) this.write({ kind: 'reserve_kept', node: path, tokens });
      }
    }
    this.wakers.delete(path);
  }

  private spentOut(path: NodePath): void {
    const { spent, limit } = this.at(path);
    this.stopNode(path, `Level ${levelOf(path)} is out of budget: it has spent ${spent} of its ${limit} tokens, and nothing it holds is left to spend.`);
  }

  private stopNode(path: NodePath, why: string): void {
    if (this.stopped.has(path)) return;
    this.stopped.set(path, why);
    // Not inside the usage event that brought it: stopping ends the session reporting it.
    for (const listener of this.listeners.get(path) ?? []) queueMicrotask(() => listener(why));
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

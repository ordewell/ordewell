import { ResetWaits } from './LimitPauses';

/** What a Session hears from the pool of its tree. */
export interface PoolNode {
  /** A slot freed in another Session: tick, as a Session's own events do. */
  tick(): Promise<void>;
  /** A slot is free for the planner turn this Session was refused: ask again now, synchronously. */
  openTurn(): void;
  /** Whether this Session's attempt on `taskId` waits on its planner: a question it asked, or a turn that ended without a report. */
  waitsOnPlanner(taskId: string): boolean;
  /** Another node found `runner`'s usage limit, which resets at `at`. */
  limitFound(runner: string, at: Date): void;
}

/** What a node asks of the pool: only a role tells it what a claim takes. */
export interface SlotRequest {
  role: 'planner' | 'task' | 'script' | 'child-plan' | 'merge';
  taskId?: string;
}

/** What {@link SlotPool.take} granted. */
export interface HeldSlot {
  /** False for a role that reserves no slot. */
  readonly holdsSlot: boolean;
  /** Idempotent: a slot is freed once, and offered on at once. */
  free(): void;
}

interface Holder {
  node: PoolNode;
  taskId?: string;
  /** The root's planner turn: counted only once the tree has a child, and never held. */
  rootTurn: boolean;
}

/** What holds a node in the tree and no slot of it (ADR-0059 L1). */
const SLOTLESS: ReadonlySet<SlotRequest['role']> = new Set<SlotRequest['role']>(['child-plan', 'merge']);

/**
 * One pool of slots across a tree (ADR-0055 D18, ADR-0058 S4), the root's and
 * shared by every Session under it. A flat run has a pool of its own, with one
 * node: there it is the Parallel limit over attempts alone, and it ticks nobody.
 *
 * A claim is synchronous and so is everything here that grants one (ADR-0029);
 * a Session waiting on a slot in another Session is ticked from here, because a
 * scheduler ticks only on its own Session's events.
 */
export class SlotPool {
  private readonly nodes = new Set<PoolNode>();
  private root: PoolNode | null = null;
  private readonly holders = new Set<Holder>();
  /** Nodes whose subplanner turn was refused, oldest first. */
  private readonly keptTurns: PoolNode[] = [];
  /** Sessions a start was refused, oldest first. */
  private readonly keptStarts: PoolNode[] = [];
  /** The one turn past the limit: see {@link turnPasses}. */
  private passing: Holder | null = null;
  /** The turn being offered: out of {@link keptTurns}, so it would otherwise queue behind the turns it was chosen ahead of. */
  private offered: PoolNode | null = null;
  private offering = false;
  /** Wakes the offer in flight once a slot goes: a tick's own spawn can take far longer than its claim. */
  private taken: (() => void) | null = null;
  private readonly limits = new ResetWaits(() => {
    for (const node of this.nodes) void node.tick();
  });

  constructor(private readonly limit: () => number) {}

  /** Add a Session to the tree; the first is its root. Returns how it leaves. */
  join(node: PoolNode): () => void {
    this.root ??= node;
    this.nodes.add(node);
    return () => {
      this.nodes.delete(node);
      drop(this.keptTurns, node);
      drop(this.keptStarts, node);
      this.offer();
    };
  }

  /** The tree has a child: there is more than one Session to count across. */
  get shared(): boolean {
    return this.nodes.size > 1;
  }

  private get counted(): Holder[] {
    return [...this.holders].filter((h) => !h.rootTurn || this.shared);
  }

  private get full(): boolean {
    return this.counted.length >= this.limit();
  }

  /** Why `node` may not take this now, or null. Changes nothing: a claim's refusal is also asked with no claim to follow. */
  refusal(node: PoolNode, request: SlotRequest): string | null {
    if (SLOTLESS.has(request.role) || (request.role === 'planner' && node === this.root) || !this.full) return null;
    if (request.role === 'planner' && this.turnPasses(node)) return null;
    const live = this.counted.length;
    return this.shared
      ? `${live} ${live === 1 ? 'session is' : 'sessions are'} already running, the most this tree runs at once. Wait for one to finish, or stop one first.`
      : `${live} ${live === 1 ? 'task is' : 'tasks are'} already running, the most this session runs at once. Wait for one to finish, or stop one first.`;
  }

  /**
   * Take a slot, or be refused and kept (ADR-0059 L1): what a refusal changes
   * is that the node is told when one frees. {@link refusal} keeps nobody, so
   * a wait for a slot asks here even when it knows the answer.
   */
  take(node: PoolNode, request: SlotRequest): HeldSlot | { refused: string } {
    const refused = this.refusal(node, request);
    if (refused) {
      keep(request.role === 'planner' ? this.keptTurns : this.keptStarts, node);
      return { refused };
    }
    if (SLOTLESS.has(request.role)) return { holdsSlot: false, free: () => undefined };
    const turn = request.role === 'planner';
    if (turn) drop(this.keptTurns, node);
    const holder: Holder = { node, ...(request.taskId !== undefined ? { taskId: request.taskId } : {}), rootTurn: turn && node === this.root };
    if (this.full && !holder.rootTurn) this.passing = holder;
    this.holders.add(holder);
    this.taken?.();
    return {
      holdsSlot: true,
      free: () => {
        if (!this.holders.delete(holder)) return;
        if (this.passing === holder) this.passing = null;
        this.offer();
      },
    };
  }

  /** An attempt's wait on its planner began or ended: the test {@link turnPasses} reads has changed. */
  waitsChanged(): void {
    this.offer();
  }

  /**
   * `node` found `runner`'s limit (D18). Returns when it resets, the later of
   * this and any limit a sibling found: a runner is usable only once every
   * limit it hit has reset, and the account is the tree's. A flat run's waits
   * stay its own.
   */
  limitFound(node: PoolNode, runner: string, at: Date): Date {
    if (!this.shared) return at;
    const resets = this.limits.arm(runner, at);
    for (const other of this.nodes) if (other !== node) other.limitFound(runner, resets);
    return resets;
  }

  /** The runners a usage limit holds across the tree. */
  limited(): ReadonlySet<string> {
    return new Set(this.limits.armed());
  }

  /**
   * Everything that holds a slot waits on a planner, and `node`'s turn is the
   * oldest one of them waits on: a limit that stopped the answer would stop
   * the tree. One at a time: a turn waits on nothing (ADR-0056 M8), so when it
   * ends this is read again, and nothing holds a slot for ever on a turn that
   * waits for that slot.
   */
  private turnPasses(node: PoolNode): boolean {
    return this.passing === null && (this.offered === node || this.waitedTurn([...this.keptTurns, node]) === node);
  }

  private waitedTurn(turns: readonly PoolNode[]): PoolNode | undefined {
    const holding = this.counted;
    if (holding.length === 0 || !holding.every((h) => h.taskId !== undefined && h.node.waitsOnPlanner(h.taskId))) return undefined;
    return turns.find((turn) => holding.some((h) => h.node === turn));
  }

  private nextTurn(): PoolNode | undefined {
    if (!this.full) return this.keptTurns[0];
    return this.passing ? undefined : this.waitedTurn(this.keptTurns);
  }

  private offer(): void {
    // A flat run's own events already do this (D18).
    if (!this.shared) return;
    // First and synchronously, so a turn queues ahead of every attempt: nothing can claim the slot it is offered.
    for (let left = this.keptTurns.length; left > 0; left--) {
      const turn = this.nextTurn();
      if (!turn) break;
      drop(this.keptTurns, turn);
      this.offered = turn;
      turn.openTurn();
      this.offered = null;
    }
    void this.offerStarts();
  }

  private async offerStarts(): Promise<void> {
    if (this.offering) return;
    this.offering = true;
    try {
      while (this.keptStarts.length > 0 && !this.full) {
        const node = this.keptStarts.shift()!;
        // One at a time, or every Session kept would be ticked for one slot and all but one kept again.
        await new Promise<void>((resolve) => {
          this.taken = resolve;
          void node.tick().catch(() => undefined).finally(resolve);
        });
        this.taken = null;
      }
    } finally {
      this.offering = false;
    }
  }
}

function keep(kept: PoolNode[], node: PoolNode): void {
  if (!kept.includes(node)) kept.push(node);
}

function drop(kept: PoolNode[], node: PoolNode): void {
  const at = kept.indexOf(node);
  if (at !== -1) kept.splice(at, 1);
}

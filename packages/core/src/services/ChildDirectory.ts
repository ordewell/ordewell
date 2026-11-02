import { ROOT_NODE, parentPath, type NodePath } from '../models/TreeEvent';
import { flattenTasks, type LegacyPlanState, type Task } from '../models/Task';
import type { TaskLogLocation } from '../utils/taskLogStore';
import type { TreeLedger, TreeNode } from './TreeLedger';
import { surfacePlan, type ChildControlOutcome, type ChildMessageOutcome, type ChildPlanEntry, type ChildPlanView, type ChildTaskControl, type SessionMessage, type SessionNotice } from './SessionMessage';
import { EMPTY_RUN, reduceRun } from './runView';

export const CHILD_ENDED = { ok: false, code: 'view_only', message: 'This child plan has ended, so it only reads. Continue its task to speak to it.' } as const;

/** A fresh retry let this one go or its task left the plan, so a Continue would not reach it. */
const CHILD_LET_GO = { ok: false, code: 'view_only', message: 'This child plan has ended and its task no longer leads to it, so it only reads.' } as const;

export type ChildFrame = SessionMessage | SessionNotice;
type ChildListener = (frame: ChildFrame) => void;

/** A child with a live Session, as it seats itself on opening. */
export interface SeatedChild {
  sessionId: string;
  taskId: string;
  title: string;
  /** Its subplanner is in a turn, or one holds the conversation. */
  working(): boolean;
  /** Why a person's message would be refused now. */
  refusal(): Extract<ChildMessageOutcome, { ok: false }> | null;
  view(): Omit<ChildPlanView, 'child'>;
  hear(text: string): ChildMessageOutcome;
  /** Its tasks waiting at a checkpoint now, each one {@link ChildPlanHandle.control} can answer. */
  checkpoints(): string[];
  control(taskId: string, control: ChildTaskControl): Promise<ChildControlOutcome>;
}

/** The root, as the directory reads it. */
export interface ChildDirectoryHost {
  rootSessionId(): string;
  /** The tree's ledger, or null for a session that has never delegated: a flat run opens none. */
  ledger(): Promise<TreeLedger | null>;
  rootTask(taskId: string): Task | undefined;
  /** A child's saved file: called only with an id the ledger names. */
  saved(sessionId: string): { meta: { goal: string }; plan: LegacyPlanState } | null;
  logLocation(sessionId: string): TaskLogLocation;
}

/** One child plan, once the directory has found it in this tree. */
export interface ChildPlanHandle {
  entry(): ChildPlanEntry;
  view(): ChildPlanView;
  /** Every frame of its stream from now on, across a Continue that reseats the same id. */
  watch(listener: ChildListener): () => void;
  message(text: string): ChildMessageOutcome;
  /** On this plan's own task, as its subplanner: never its parent's, whatever the id names there. */
  control(taskId: string, control: ChildTaskControl): Promise<ChildControlOutcome>;
  logLocation(): TaskLogLocation;
}

// Nobody can answer these from a child's stream: its subplanner's approvals go by its allowlist (ADR-0056 M8).
const ROOT_ONLY: ReadonlySet<ChildFrame['type']> = new Set(['approval_request', 'approval_settled', 'approval_decided']);

/**
 * Every plan below one root, for a surface (ADR-0055 D20): the one place a
 * client's id is checked, against the tree's ledger, before anything is read
 * under it. Seating decides what a child is now; the ledger, what the tree
 * holds; a child's own file, what one with no Session left says.
 */
export class ChildDirectory {
  private readonly seats = new Map<string, SeatedChild>();
  private readonly watchers = new Map<string, Set<ChildListener>>();
  private readonly listeners = new Set<() => void>();
  // A file is only read for what no longer has a Session, and an ended child's title stays.
  private readonly titles = new Map<string, string>();
  private told = '';
  private telling = false;

  constructor(private readonly host: ChildDirectoryHost) {}

  /** The child is there until the returned call: a later opening of its id has seated its own by then. */
  seat(child: SeatedChild): () => void {
    this.seats.set(child.sessionId, child);
    this.titles.set(child.sessionId, child.title);
    this.changed();
    return () => {
      if (this.seats.get(child.sessionId) !== child) return;
      this.seats.delete(child.sessionId);
      this.changed();
    };
  }

  publish(sessionId: string, frame: ChildFrame): void {
    if (ROOT_ONLY.has(frame.type)) return;
    for (const listener of this.watchers.get(sessionId) ?? []) listener(frame);
    this.changed();
  }

  /** A frame can come per token, so what changed is read once a tick, and only said when it did. */
  private changed(): void {
    if (this.telling || this.listeners.size === 0) return;
    this.telling = true;
    setImmediate(() => {
      this.telling = false;
      const now = JSON.stringify([...this.seats.values()].map((child) => [child.sessionId, child.working(), child.refusal(), child.checkpoints()]));
      if (now === this.told) return;
      this.told = now;
      for (const listener of [...this.listeners]) listener();
    });
  }

  /** Called as what {@link list} would answer may have moved. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async list(): Promise<ChildPlanEntry[]> {
    const tree = await this.host.ledger();
    return tree ? this.entries(tree) : [];
  }

  /** Null for anything the tree does not name, which is how an id from elsewhere, or a path, is refused. */
  async find(sessionId: string): Promise<ChildPlanHandle | null> {
    const tree = await this.host.ledger();
    if (!tree || !this.latest(tree).has(sessionId)) return null;
    const entry = () => this.entries(tree).find((child) => child.sessionId === sessionId)!;
    return {
      entry,
      view: () => this.view(sessionId, entry()),
      watch: (listener) => this.watch(sessionId, listener),
      message: (text) => this.seats.get(sessionId)?.hear(text) ?? this.ended(entry()),
      control: async (taskId, control) => (await this.seats.get(sessionId)?.control(taskId, control)) ?? this.ended(entry()),
      logLocation: () => this.host.logLocation(sessionId),
    };
  }

  private ended(child: ChildPlanEntry): typeof CHILD_ENDED | typeof CHILD_LET_GO {
    const task = child.taskId ? this.taskAbove(child.taskId, child.parent) : undefined;
    return task?.runnerSessionId === child.sessionId ? CHILD_ENDED : CHILD_LET_GO;
  }

  private view(sessionId: string, child: ChildPlanEntry): ChildPlanView {
    const seat = this.seats.get(sessionId);
    if (seat) return { child, ...seat.view() };
    const saved = this.host.saved(sessionId);
    if (!saved) return { child, plan: null, run: EMPTY_RUN };
    const plan = surfacePlan(saved.plan);
    return { child, goal: saved.meta.goal, plan, run: reduceRun(EMPTY_RUN, { type: 'plan_snapshot', plan }) };
  }

  private watch(sessionId: string, listener: ChildListener): () => void {
    const watching = this.watchers.get(sessionId) ?? new Set();
    this.watchers.set(sessionId, watching);
    watching.add(listener);
    return () => {
      watching.delete(listener);
      if (watching.size === 0 && this.watchers.get(sessionId) === watching) this.watchers.delete(sessionId);
    };
  }

  /** A Continue opens a new node for the same child: its latest opening stands for it. */
  private latest(tree: TreeLedger): Map<string, TreeNode> {
    return new Map(tree.below(ROOT_NODE).map((node) => [node.sessionId, node]));
  }

  private entries(tree: TreeLedger): ChildPlanEntry[] {
    const nodes = this.latest(tree);
    const owners = new Map<NodePath, string>(tree.below(ROOT_NODE).map((node) => [node.path, node.sessionId]));
    return [...nodes.values()].map((node) => {
      const above = parentPath(node.path);
      const parent = (above && owners.get(above)) ?? this.host.rootSessionId();
      const seat = this.seats.get(node.sessionId);
      const refusal = seat?.refusal();
      // Its Session lets go a moment after its attempt ends, and nothing it says then counts.
      const over = refusal?.code === 'view_only';
      const refused = refusal && !over ? refusal.message : undefined;
      const checkpoints = over ? [] : seat?.checkpoints() ?? [];
      return {
        sessionId: node.sessionId,
        node: node.path,
        parent,
        ...(node.taskId ? { taskId: node.taskId } : {}),
        title: this.title(node, parent),
        depth: node.path.split('/').length - 1,
        state: !seat || over ? 'ended' : seat.working() ? 'working' : 'parked',
        ...(refused ? { refused } : {}),
        ...(checkpoints.length > 0 ? { checkpoints } : {}),
      };
    });
  }

  private title(node: TreeNode, parent: string): string {
    const known = this.titles.get(node.sessionId);
    if (known) return known;
    const found = node.taskId ? this.taskAbove(node.taskId, parent)?.title : undefined;
    const title = found ?? node.taskId ?? node.sessionId;
    if (found) this.titles.set(node.sessionId, found);
    return title;
  }

  private taskAbove(taskId: string, parent: string): Task | undefined {
    if (parent === this.host.rootSessionId()) return this.host.rootTask(taskId);
    return flattenTasks(this.host.saved(parent)?.plan.tasks ?? []).find((task) => task.id === taskId);
  }
}


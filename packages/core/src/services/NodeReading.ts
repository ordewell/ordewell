import { isBoardRef } from '../models/Board';
import { checkWords } from '../models/Delegation';
import type { HandoffCheck } from '../models/Handoff';
import { flattenTasks, type Task } from '../models/Task';
import { loadChildSession } from '../utils/sessionStore';
import { listTaskLogAttempts, readTaskLog, type TaskLogLocation } from '../utils/taskLogStore';
import { blobsIn, NodeBoard, type BoardGit } from './Board';
import type { TakenReport } from './ChildPlanRunner';
import type { McpToolReply, PostArgs, ReadTaskArgs, TaskCompleteArgs } from './mcp';
import type { NodeFunding } from './NodeFunding';
import { readTask, type TaskLogReader } from './readTask';
import { Subtree, takeReport } from './Subtree';
import type { TreeLedger } from './TreeLedger';

/**
 * What a node reads of its own plan and of the plans below it, and its board
 * (ADR-0057 R1, R8, R11), as its Session asks for them. One kind of node at
 * every depth (ADR-0055 D4), so a Session holds one of these and never asks
 * which depth it is at: a {@link RootReading} reads its tree through the log
 * its first delegated task opens, a {@link ChildReading} reads its root's tree,
 * held since its carve. Each read is made afresh: nothing of a plan below is
 * kept here (ADR-0055 D17).
 */
export interface NodeReading {
  /** This node's board, read through what its tree's log holds; null where it has none. */
  board(): Promise<NodeBoard | null>;
  /** A planner's `post`, in its own workspace. */
  post(args: PostArgs): Promise<McpToolReply>;
  /** What `task`'s landing owes the plan it landed in; undefined with no board, so a flat landing waits on nothing. */
  landed(task: Readonly<Task>): Promise<void> | undefined;
  /** What is below this plan; null with nothing delegated, so a flat run opens no ledger. */
  subtree(): Promise<Subtree | null>;
  /** A planner's `read`: its whole plan, and what is below it (ADR-0057 R11). */
  read(args: ReadTaskArgs): Promise<McpToolReply>;
  /** A subplanner's report, read against its own plan and what is below it (ADR-0057 R1, R2). */
  report(report: TaskCompleteArgs): HandoffCheck<TakenReport>;
}

/** What a node's reading reads of its Session, afresh each time it asks. */
export interface ReadingHost {
  /** This node's side of the tree's ledger, whose log the board and the subtree are folds of. */
  readonly funds: NodeFunding;
  /** Whether delegation is offered here at all: with it off, no plan holds a board. */
  readonly delegationOffered: boolean;
  /** This node's plan as it stands. */
  tasks(): readonly Task[];
  /** The saved logs of this node's own attempts. */
  readonly logs: TaskLogReader;
  /** The root's workspace, under which every node's state sits (ADR-0055 D11). */
  stateRoot(): string;
  /** Where this node's planner works, whose files a post pins. */
  workspaceRoot(): string;
  /** Where the board's file evidence is compared (ADR-0057 R9). */
  readonly git: BoardGit;
  /** The child session seated in `taskId`'s worktree, if one is. */
  childSession(taskId: string): string | undefined;
  /** The lines a landing owes this plan's running tasks (ADR-0057 R6). */
  addressed(task: Readonly<Task>): Promise<void>;
}

export interface RootReadingHost extends ReadingHost {
  /** The session the tree is the root of: a new one has a tree of its own. */
  sessionId(): string;
}

export interface ChildReadingHost extends ReadingHost {
  /** Its root's session, under which its own state and every sibling's sits. */
  readonly rootSessionId: string;
}

abstract class Reading implements NodeReading {
  constructor(private readonly host: ReadingHost) {}

  /** The session the tree's plans are saved under. */
  protected abstract rootSessionId(): string;
  /** The tree to read what is below through; null where it cannot be had. */
  protected abstract tree(): Promise<TreeLedger | null>;

  /** Whether anything is, or was, below this node: an open tree, or a delegated task that will open one. */
  private delegates(): boolean {
    return this.host.funds.tree !== null || flattenTasks(this.host.tasks()).some((task) => task.type === 'delegated');
  }

  /** Whether this node has a board (ADR-0057 R8): a child always, and a root from its first delegated task. A flat plan never does, and never opens a ledger for one. */
  private get holdsBoard(): boolean {
    return this.host.delegationOffered && this.delegates();
  }

  private boardOn(log: TreeLedger): NodeBoard {
    return new NodeBoard({
      log,
      node: this.host.funds.path,
      git: this.host.git,
      checks: () => checkWords(this.host.tasks()),
    });
  }

  async board(): Promise<NodeBoard | null> {
    if (!this.holdsBoard) return null;
    const log = await this.tree();
    return log && this.boardOn(log);
  }

  async post(args: PostArgs): Promise<McpToolReply> {
    const board = await this.board();
    if (!board) return { text: 'This plan has no board: it gains one with its first delegated task. Nothing was posted.', isError: true };
    return board.post(args, {}, blobsIn(this.host.workspaceRoot()));
  }

  /**
   * ADR-0057 R6: a delegated task's contracts rise to this board, then each
   * running task that declared what it touched gets its line. A failure here
   * costs a line, and never the landing.
   */
  landed(task: Readonly<Task>): Promise<void> | undefined {
    if (!this.holdsBoard) return undefined;
    return this.raiseAndAddress(task).catch((err: unknown) => console.warn(`[scope] Task "${task.title}" landed, and what it owed the tasks beside it failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async raiseAndAddress(task: Readonly<Task>): Promise<void> {
    const provides = task.scope?.provides ?? [];
    const child = this.host.childSession(task.id) ?? task.runnerSessionId;
    if (provides.length > 0 && child) {
      const log = await this.tree();
      if (log) await this.boardOn(log).raise(log.boardOf(child), provides);
    }
    await this.host.addressed(task);
  }

  async subtree(): Promise<Subtree | null> {
    if (!this.delegates()) return null;
    const tree = await this.tree();
    return tree && this.subtreeOn(tree);
  }

  /** A child's ledger is its root's, so nothing here waits. */
  report(report: TaskCompleteArgs): HandoffCheck<TakenReport> {
    const { tree, path: node } = this.host.funds;
    return takeReport(report, {
      plan: { node, tasks: this.host.tasks(), logs: this.host.logs },
      subtree: tree && this.subtreeOn(tree),
      tokens: tree?.taskSpent(node) ?? 0,
    });
  }

  async read(args: ReadTaskArgs): Promise<McpToolReply> {
    const board = isBoardRef(String(args.task)) ? await this.board() : null;
    if (board) return board.read(String(args.task));
    return readTask(args, undefined, this.host.tasks(), this.host.logs, await this.subtree());
  }

  /** The plans below this one on `tree`, each read when asked for (ADR-0055 D17, ADR-0057 R1). */
  private subtreeOn(tree: TreeLedger): Subtree {
    const baseDir = this.host.stateRoot();
    const rootSessionId = this.rootSessionId();
    const here = this.host.funds.path;
    return new Subtree({
      here,
      tasks: () => this.host.tasks(),
      nodes: () => tree.below(here),
      plan: ({ sessionId }) => loadChildSession({ baseDir, rootSessionId, sessionId })?.plan.tasks,
      logs: ({ sessionId }) => {
        const location: TaskLogLocation = { baseDir, sessionId, rootSessionId };
        return { attempts: (taskId) => listTaskLogAttempts(location, taskId), events: (taskId, attempt) => readTaskLog(location, taskId, attempt) };
      },
    });
  }
}

/** The root's reading: its tree is its own session's, whose log the first read of what is below opens (ADR-0058 S3). */
export class RootReading extends Reading {
  constructor(private readonly root: RootReadingHost) {
    super(root);
  }

  protected rootSessionId(): string {
    return this.root.sessionId();
  }

  protected tree(): Promise<TreeLedger | null> {
    return this.root.funds.ledger().catch(() => null);
  }
}

/** A child's reading: its root's tree, which its carve gave it open, so it never opens one. */
export class ChildReading extends Reading {
  constructor(private readonly child: ChildReadingHost) {
    super(child);
  }

  protected rootSessionId(): string {
    return this.child.rootSessionId;
  }

  /** Null for a child no carve gave a budget, which holds no tree to read. */
  protected tree(): Promise<TreeLedger | null> {
    return Promise.resolve(this.child.funds.tree);
  }
}

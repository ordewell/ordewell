import type { Task } from '../models/Task';

/**
 * Why isolated execution is unavailable for a workspace. The orchestrator needs
 * the reason, not just a boolean: `dirty` is offered a stash or an explicit
 * "run without isolation", while the other three fall back to the shared
 * workspace root with a one-line notice.
 */
export type IsolationInactiveReason = 'disabled' | 'git-missing' | 'not-git' | 'no-commits' | 'dirty';

export type IsolationAvailability = { active: true } | { active: false; reason: IsolationInactiveReason };

export type IsolationOutcome = 'merged' | 'conflict' | 'failed';

/**
 * `active` — worktree exists, a runner may be writing to it.
 * `kept` — released with its worktree and branch preserved for inspection.
 * `conflict` — integration stopped on a merge conflict; worktree and refs kept.
 * `failed` — integration hit a git error other than a conflict; refs kept.
 * `merged` — landed on the integration branch; worktree and task branch removed.
 */
export type IsolationTaskStatus = 'active' | 'kept' | 'conflict' | 'failed' | 'merged';

export interface IsolationTaskRecord {
  taskId: string;
  order: number;
  title: string;
  branch: string;
  /** Absolute path of the worktree checkout (the Runner's cwd is inside it when the workspace is a repo subdirectory). */
  worktree: string;
  status: IsolationTaskStatus;
  /**
   * Paths bootstrapped from the main worktree (symlinks, junctions, copies).
   * Recorded so the commit step can leave them out — a symlink is not matched
   * by a `node_modules/` ignore rule and would otherwise be committed.
   */
  linked: string[];
}

/**
 * One Execute-Plan click or one manual task run. Plain JSON on purpose: the
 * orchestrator persists it with the plan state so a resumed session can find
 * its integration branch again. The module mutates `tasks` in place.
 */
export interface IsolationRun {
  id: string;
  workspaceRoot: string;
  /** The commit checked out at run start. Switching branches mid-run does not retarget it. */
  baseRef: string;
  /** Branch name checked out at run start; absent on a detached HEAD. */
  baseBranch?: string;
  integrationBranch: string;
  /** Keyed by task id — ids are unique within one plan and a run belongs to one plan. */
  tasks: Record<string, IsolationTaskRecord>;
}

/**
 * What a plan persists of isolated execution (`LegacyPlanState.isolation`): its
 * run, and which added tasks resolve which conflicts. Belongs to that plan and
 * its branches alone, so a copy of the plan (a fork) must not carry it.
 */
export interface PlanIsolation {
  run: IsolationRun;
  /** Resolver task id → the conflicted task whose branch it merges. */
  resolvers: Record<string, string>;
}

/**
 * A task's isolation as a surface shows it. `kept` covers every record whose
 * worktree stays for inspection — a failed verdict, an interrupted attempt, an
 * integration git refused — because to the user they are one thing: work that
 * did not land and can be looked at. `none` is a task with no worktree in a plan
 * that has an isolation run.
 */
export type TaskIsolationState = 'none' | 'active' | 'integrated' | 'conflict' | 'kept';

export type TaskIsolation =
  | { state: 'none' }
  | { state: Exclude<TaskIsolationState, 'none'>; branch: string; worktree: string };

export interface IsolationHandoff {
  branch: string;
  baseRef: string;
  /** Tasks that landed on the integration branch, in plan order. */
  landed: Array<{ taskId: string; order: number; title: string }>;
}

/** A plan's isolation as a surface shows it: a mark for each task the run touched, and its handoff. */
export interface IsolationView {
  tasks: Record<string, TaskIsolation>;
  handoff: IsolationHandoff;
}

export interface IWorktreeIsolation {
  /** Git repo + clean tracked tree + config enabled; otherwise the reason it is not. */
  isActive(workspaceRoot: string): Promise<IsolationAvailability>;

  /**
   * Put the workspace's tracked changes on the git stash, the user's way out of
   * a `dirty` refusal. Untracked files stay: they never block isolation.
   */
  stash(workspaceRoot: string): Promise<void>;

  /** Mint a run: resolve the base ref to a commit now. Only meaningful after `isActive` said yes. */
  startRun(workspaceRoot: string): Promise<IsolationRun>;

  /**
   * Create the task's worktree from the current integration tip and return the
   * cwd to spawn the Runner into. A second `prepare` for the same task is a
   * retry: the old attempt is discarded and the worktree recreated from the
   * tip, so the task sees everything its predecessors have integrated.
   */
  prepare(task: Task, run: IsolationRun): Promise<{ cwd: string; branch: string }>;

  /**
   * Commit the worktree's contents, then `git merge --no-ff` the task branch
   * into the integration branch. Serialized inside the module; among tasks
   * waiting at once the lowest plan order goes first. A conflict is aborted and
   * reported — the worktree and refs stay, and nothing is ever auto-resolved.
   */
  integrate(task: Task, run: IsolationRun): Promise<IsolationOutcome>;

  /**
   * `keep: false` removes the task's worktree, branch and record (cancel, task
   * removal). `keep: true` leaves the worktree and branch exactly as they are
   * for inspection — a failed verdict — and only moves the task off `active`,
   * so a crash-recovery prune does not sweep it away. Takes the run rather than
   * a bare task id: ids are only unique within one plan, and one daemon serves
   * many (ADR-0007).
   */
  release(run: IsolationRun, taskId: string, opts: { keep: boolean }): Promise<void>;

  /** End of run: park the integration branch for review and report what landed. */
  handoff(run: IsolationRun): Promise<IsolationHandoff>;

  /** Drop what a crash left behind: stale active worktrees and directories no record owns. */
  pruneOrphans(run: IsolationRun): Promise<void>;

  /** Unified diff of the integration branch against the base ref. */
  reviewDiff(run: IsolationRun): Promise<string>;

  /**
   * Merge the integration branch into whatever the user has checked out. The
   * one irreversible step, so it only ever happens when a caller asks for it.
   * A conflict is aborted, leaving the user's tree as it was; a merge the user
   * already had in progress is left alone and reported `failed`.
   */
  mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationOutcome>;

  /**
   * Remove every worktree and task branch of the run, and the integration
   * branch too unless `keepIntegration` — the branch outlives a discarded run
   * until the user explicitly gives it up.
   */
  discard(run: IsolationRun, opts: { keepIntegration: boolean }): Promise<void>;
}

import type { Task } from '../models/Task';

/**
 * Why isolated execution is unavailable for a workspace. The orchestrator needs
 * the reason, not just a boolean: `dirty` is offered a stash or an explicit
 * "run without isolation", while the others fall back to the shared
 * workspace root with a one-line notice.
 */
export type IsolationInactiveReason = 'disabled' | 'git-missing' | 'not-git' | 'no-commits' | 'dirty' | 'nested-repos';

/**
 * `repos` names, relative to the workspace, the repositories behind the reason:
 * the nested ones `nested-repos` refuses, the dirty ones of a `dirty` group, or
 * the commitless ones of a `no-commits` group. A group of one names none.
 */
export type IsolationAvailability = { active: true } | { active: false; reason: IsolationInactiveReason; repos?: string[] };

export type IsolationOutcome = 'merged' | 'conflict' | 'failed';

/**
 * `active` — worktree exists, a runner may be writing to it.
 * `kept` — released with its worktree and branch preserved for inspection.
 * `conflict` — integration stopped on a merge conflict; worktree and refs kept.
 * `failed` — integration hit a git error other than a conflict; refs kept.
 * `merged` — landed on the integration branch; worktree and task branch removed.
 */
export type IsolationTaskStatus = 'active' | 'kept' | 'conflict' | 'failed' | 'merged';

/** One repo's share of a task: its worktree inside the task workspace. */
export interface IsolationTaskRepo {
  /** Absolute path of this repo's worktree: the task workspace joined with the repo's path. */
  worktree: string;
  /**
   * Paths bootstrapped from the real repo (symlinks, junctions, copies).
   * Recorded so the commit step can leave them out — a symlink is not matched
   * by a `node_modules/` ignore rule and would otherwise be committed.
   */
  linked: string[];
  /** Whether the task brought commits to this repo; unknown until it first integrates. */
  changed?: boolean;
}

export interface IsolationTaskRecord {
  taskId: string;
  order: number;
  title: string;
  /** One branch name, the same in every repo, so a task is one name to look up across the group. */
  branch: string;
  /**
   * Absolute path of the task workspace, holding one worktree per repo at the
   * repo's path. The Runner's cwd is inside it when the workspace is a repo
   * subdirectory; for a group of one it is the worktree.
   */
  workspace: string;
  /** For the task as a whole: landing is atomic across the repos it changed. */
  status: IsolationTaskStatus;
  /** Keyed by repo path. */
  repos: Record<string, IsolationTaskRepo>;
  /** The repo whose merge conflicted, while `status` is `conflict`. */
  conflictRepo?: string;
}

/**
 * One repository of the group (ADR-0014). Every git operation on it runs in
 * `root`, never in the workspace root.
 */
export interface IsolationRepo {
  /** Relative to the workspace root; `.` when the workspace is itself the repository. */
  path: string;
  /**
   * Absolute: the workspace root joined with `path`. For a group of one that is
   * the workspace root, which may be a subdirectory of the repository.
   */
  root: string;
  /** The commit checked out at run start. Switching branches mid-run does not retarget it. */
  baseRef: string;
  /** Branch name checked out at run start; absent on a detached HEAD. */
  baseBranch?: string;
  integrationBranch: string;
}

/**
 * One Execute-Plan click or one manual task run over the workspace's repo
 * group. Plain JSON on purpose: the orchestrator persists it with the plan
 * state so a resumed session can find its integration branches again. The
 * module mutates `tasks` in place.
 */
export interface IsolationRun {
  id: string;
  workspaceRoot: string;
  repos: IsolationRepo[];
  /**
   * Workspace paths outside every isolated repo, linked live into each task
   * workspace: loose entries of the workspace root, the entries beside a deeper
   * repo, and `sharedRepos`. Empty for a group of one.
   */
  shared: string[];
  /** Repos of the group that could not be isolated — no commits, or git refused a worktree — and are among `shared`. */
  sharedRepos: string[];
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
  | {
    state: Exclude<TaskIsolationState, 'none'>;
    branch: string;
    /** The task workspace; for a group of one, the task's worktree. */
    worktree: string;
    /** Paths of the repos the task changed. */
    repos: string[];
    conflictRepo?: string;
  };

export interface IsolationLandedTask {
  taskId: string;
  order: number;
  title: string;
}

export interface IsolationHandoffRepo {
  path: string;
  integrationBranch: string;
  baseRef: string;
  /** Tasks whose work landed in this repo, in plan order. */
  landed: IsolationLandedTask[];
}

export interface IsolationHandoff {
  repos: IsolationHandoffRepo[];
  /** Tasks that landed on the integration branches, in plan order. */
  landed: IsolationLandedTask[];
}

/** A plan's isolation as a surface shows it: a mark for each task the run touched, and its handoff. */
export interface IsolationView {
  tasks: Record<string, TaskIsolation>;
  handoff: IsolationHandoff;
}

/** How merging a run into the user's checkout went; on anything but `merged`, the repo that stopped it and, for a conflict, its files. */
export interface IsolationMergeResult {
  outcome: IsolationOutcome;
  repo?: string;
  files?: string[];
}

export interface PreparedTask {
  cwd: string;
  branch: string;
  /**
   * Paths, relative to the task workspace, that are copies rather than links
   * because a hard link was impossible (Windows, another volume). Edits to them
   * stay in the task, so the user is told.
   */
  copied: string[];
}

export interface IWorktreeIsolation {
  /**
   * A repo group with at least one repo to isolate, a clean tracked tree in
   * each, and the config enabled; otherwise the reason it is not.
   */
  isActive(workspaceRoot: string): Promise<IsolationAvailability>;

  /**
   * Put the tracked changes of every dirty repo of the group on its git stash,
   * the user's way out of a `dirty` refusal. Untracked files stay: they never
   * block isolation.
   */
  stash(workspaceRoot: string): Promise<void>;

  /**
   * Mint a run: resolve each repo's base ref to a commit now, and share the
   * repos that cannot be isolated. Only meaningful after `isActive` said yes;
   * throws when no repo of the group can be isolated after all.
   */
  startRun(workspaceRoot: string): Promise<IsolationRun>;

  /**
   * Create the task workspace — one worktree per isolated repo from its
   * integration tip, the shared paths linked in — and return the cwd to spawn
   * the Runner into. A second `prepare` for the same task is a retry: the old
   * attempt is discarded and the workspace recreated from the tips, so the
   * task sees everything its predecessors have integrated.
   */
  prepare(task: Task, run: IsolationRun): Promise<PreparedTask>;

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

  /** Unified diff of each repo's integration branch against its base ref. */
  reviewDiff(run: IsolationRun): Promise<string>;

  /**
   * Merge the integration branch into whatever the user has checked out. The
   * one irreversible step, so it only ever happens when a caller asks for it.
   * A conflict is aborted, leaving the user's tree as it was; a merge the user
   * already had in progress is left alone and reported `failed`.
   */
  mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult>;

  /**
   * Remove every worktree and task branch of the run, and the integration
   * branch too unless `keepIntegration` — the branch outlives a discarded run
   * until the user explicitly gives it up.
   */
  discard(run: IsolationRun, opts: { keepIntegration: boolean }): Promise<void>;
}

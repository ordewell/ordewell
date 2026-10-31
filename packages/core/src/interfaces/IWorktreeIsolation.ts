import type { TaskDiffRead, TaskDiffResult } from '../services/taskDiffRead';
import type { Task } from '../models/Task';
import type { HandoffCommit } from '../models/Handoff';

/**
 * Why isolated execution is unavailable for a workspace. The orchestrator needs
 * the reason, not just a boolean: `dirty` is offered a stash or an explicit
 * "run without isolation", while the others fall back to the shared
 * workspace root with a one-line notice.
 */
export type IsolationInactiveReason = 'disabled' | 'git-missing' | 'not-git' | 'no-commits' | 'dirty';

/**
 * `repos` names, relative to the workspace, the repositories behind the answer:
 * when active, the ones that will isolate, with `shared` the paths every task
 * will share live — loose entries of the workspace root, or, for a lone
 * repository, the repositories nested inside it; otherwise the dirty ones of a
 * `dirty` group, or the commitless ones of a `no-commits` group. A group of one
 * names none.
 */
export type IsolationAvailability =
  | { active: true; repos?: string[]; shared?: string[] }
  | { active: false; reason: IsolationInactiveReason; repos?: string[] };

/**
 * What a repository's HEAD is. `unborn` is a repository with no commit yet,
 * on `branch`; `unknown` is one git could not be asked about.
 */
export type RepoHead =
  | { kind: 'branch'; branch: string; commit: string }
  | { kind: 'detached'; commit: string }
  | { kind: 'unborn'; branch?: string }
  | { kind: 'unknown' };

/** One repository of the group, as it is right now. */
export interface PreviewRepo {
  /** Relative to the workspace, as everywhere else: `.` for a workspace that is in one repository. */
  path: string;
  head: RepoHead;
  /** Whether tracked files differ from HEAD; absent when not inspected (isolation is off or git is missing). */
  dirty?: boolean;
  /** Only for the lone repository: the workspace-relative path of its top level when the workspace is below it, such as `..`. */
  top?: string;
}

/**
 * What a current look at a workspace says about isolation, for a surface that
 * shows it before any run (ADR-0013, ADR-0014). Every status but `failed`
 * answers as `isActive` would for the same workspace, so the two cannot
 * disagree; only `isActive` at run start is authoritative, and the base
 * branch a run forks from is read again then.
 *
 * - `ready`: code tasks get isolated worktrees from `repos`. A repo with no
 *   commit yet is listed with an `unborn` head and shared instead.
 * - `dirty`: as `ready` once the start-time decision (stash, or run without
 *   isolation) is made; `repos` marks the ones with `dirty`.
 * - `disabled`, `git-missing`, `no-commits`: code tasks run in the workspace.
 * - `no-repo`: nothing in the workspace is a repository (`repos` is empty).
 * - `failed`: git could not be read; says nothing about whether there is a
 *   repository. `error` is the reason.
 *
 * Ops and script tasks use the user's checkout whatever the status.
 */
export interface IsolationPreview {
  status: 'ready' | 'dirty' | 'disabled' | 'git-missing' | 'no-repo' | 'no-commits' | 'failed';
  repos: PreviewRepo[];
  /** What every task would share live, as `IsolationAvailability.shared` names it; empty unless `ready` or `dirty`. */
  shared: string[];
  error?: string;
}

/** The read-only look at a workspace's isolation: starts no run and changes nothing in any repository. */
export interface IIsolationPreview {
  /** Never rejects: a failed inspection is a `failed` preview. */
  preview(workspaceRoot: string): Promise<IsolationPreview>;
}

/**
 * Where a run's tasks work, as the planner is told it: the repos of the group
 * and the paths shared live between tasks. A lone repository is `['.']` with
 * nothing shared, unless it holds nested repositories, which are shared live
 * and named in `shared`.
 */
export interface RepoGroupLayout {
  repos: string[];
  shared: string[];
}

export type IsolationOutcome = 'merged' | 'conflict' | 'failed';

/**
 * `active` — worktree exists, a runner may be writing to it.
 * `kept` — released with its worktree and branch preserved for inspection.
 * `conflict` — integration stopped on a merge conflict; worktree and refs kept.
 * `repairing` — a conflict repair (ADR-0015) is working in the kept worktree;
 *   one that ends without landing leaves the task `conflict` again.
 * `failed` — integration hit a git error other than a conflict; refs kept.
 * `merged` — landed on the integration branch; worktree and task branch removed.
 */
export type IsolationTaskStatus = 'active' | 'kept' | 'conflict' | 'repairing' | 'failed' | 'merged';

/** One repo's share of a task: its worktree inside the task workspace. */
export interface IsolationTaskRepo {
  /** Integration tip when this task started; absent in older saved runs. */
  baseRef?: string;
  /** Task branch tip before integration removes it; excludes concurrent landings. */
  taskTip?: string;
  /** Absolute path of this repo's worktree: the task workspace joined with the repo's path. */
  worktree: string;
  /**
   * Paths linked from the real workspace and kept out of the task's commit:
   * the artifacts bootstrapped from the real repo, and a lone repository's
   * nested repositories (`run.shared`). Recorded because a symlink is not
   * matched by an ignore rule such as `node_modules/` and would otherwise be
   * committed.
   */
  linked: string[];
  /** Whether the task brought commits to this repo; unknown until it first integrates. */
  changed?: boolean;
  /**
   * The integration tip right after the task landed here: what the user's
   * HEAD must contain for the task's work to count as merged (ADR-0020).
   */
  landedTip?: string;
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
  /** Unrecovered branches from a conflict fallback, so a later continue cannot forget them. */
  continuationWork?: PreservedWork[];
  /** The repo whose merge stopped the task from landing, while `status` is `conflict` or `failed`. */
  conflictRepo?: string;
  /**
   * What a `failed` landing stopped on, in words a surface can repeat — a
   * missing worktree is the common one. Cleared by the next landing attempt,
   * so a stale reason cannot outlive the failure it explains.
   */
  landingError?: string;
  /**
   * The commit the task's done handoff stated, kept from the landing that
   * first brought it: what Ordewell's own commits for the task are written
   * from (ADR-0013), a repair's merge and every later landing included,
   * though a repair's handoff states none.
   */
  commit?: HandoffCommit;
  /** Repo-relative paths, in `conflictRepo`, that conflicted; set only while `status` is `conflict` or `repairing`. */
  conflictFiles?: string[];
  /**
   * Conflict repairs started for this task (ADR-0015). Counted when one starts,
   * so a crash cannot hand the spent attempt back; absent reads as none.
   */
  repairs?: number;
  /**
   * Keyed by repo path: each changed repo's integration tip when the repair in
   * flight started — what the task branch must contain before it may land.
   * Set only while `status` is `repairing`.
   */
  repairBase?: Record<string, string>;
  /**
   * Every file a repair was started for, across all of them: as `conflictFiles`
   * names it in a group of one, prefixed with its repo's path in a group.
   */
  repairedFiles?: string[];
  /**
   * A read-only task's (ADR-0046): never integrated, and removed whole
   * whenever it is released, whatever its worktrees hold, with nothing kept
   * on a branch and no git run inside them.
   */
  readOnly?: true;
  /**
   * Set once the task's landed work is merged into the user's branch in every
   * repo it landed in, by Merge all or by hand — never by a checkout that only
   * stands on the integration branch (ADR-0054) — or can no longer be merged
   * there, its integration branch gone. What a merge gate waits for (ADR-0020).
   * Git's answer as last read, so it goes when the user takes the merge back
   * out; it goes with the record too, so a revert asks git of each merge instead.
   */
  inHead?: true;
}

/**
 * A task's landing in flight: each changed repo's integration tip from before
 * the task's merge. On the run rather than the task record because it must
 * outlive that record — a retry drops and recreates it — until every repo is
 * back at its tip or the task has landed.
 */
export interface IsolationLanding {
  taskId: string;
  /** Keyed by repo path. */
  tips: Record<string, string>;
  /**
   * Set when this is a revert rather than a landing (ADR-0054), by repo path:
   * what a rollback has to find on that repo's tip to take it off again.
   */
  reverts?: Record<string, IsolationRepoRevert>;
}

/** A revert's share of one repo, saved so that it can tell its own commits from anyone else's. */
export interface IsolationRepoRevert {
  /** The commits it has made, oldest first, each saved before the branch moves onto it. */
  commits: string[];
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
  /** Branch name checked out at run start; absent on a detached HEAD, and on a record saved before this was noted. */
  baseBranch?: string;
  /** Set when the run started on a detached HEAD, so that is told from a record that never noted its branch. */
  startedDetached?: true;
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
   * repo, and `sharedRepos`. For a lone repository, the repositories nested
   * inside it, which cannot be isolated with it and so are linked live instead.
   * Empty when a group of one holds no nested repositories.
   */
  shared: string[];
  /** Repos of the group that could not be isolated — no commits, or git refused a worktree — and are among `shared`. */
  sharedRepos: string[];
  /** Keyed by task id — ids are unique within one plan and a run belongs to one plan. */
  tasks: Record<string, IsolationTaskRecord>;
  /**
   * Set before a task's first merge and cleared once it has landed or been
   * rolled back. One found set — after a crash, or a rollback git refused —
   * names exactly what to return each repo's integration branch to.
   */
  landing?: IsolationLanding;
  /**
   * Every merge that landed a task, by task id and repo, oldest first. A
   * continue or a retry lands a task again under a new record, so no record
   * holds them all, and a revert takes them all back (ADR-0054). A run saved
   * before these were kept has only each record's `landedTip`.
   */
  landings?: Record<string, Record<string, string[]>>;
  /**
   * Set on a run started with {@link landings} kept from its first merge. A
   * run saved before that can hold merges no record names, so a revert cannot
   * take the absence of a task's landings as proof it landed nothing.
   */
  keepsEveryLanding?: true;
  /**
   * Task branch tips another task's merge brought in, by task id and repo: a
   * resolver's merge carrying a conflicted task's work. No merge of that task
   * holds this work, and a later attempt's record says nothing of it, so
   * neither task can be reverted (ADR-0054).
   */
  carried?: Record<string, Record<string, string[]>>;
  /**
   * What each task in {@link landings} or {@link carried} landed as: all a
   * revert has to name it by once a retry has dropped its record and left its
   * merges on the branch.
   */
  landedTasks?: Record<string, LandedTask>;
  /**
   * What each task depended on when its worktree was cut and when it landed,
   * directly or not, by task id, across every attempt. A plan edit takes a link
   * while a worktree stays cut from what it stood on, and leaving the plan takes
   * a task's dependencies with it, and those of the tasks that named it, while
   * its merges stay on the branch, so this is what finds a dependent the plan
   * has lost, at work or landed. A landed task the plan no longer has and this
   * does not name refuses every revert of the run (ADR-0054).
   */
  landedOn?: Record<string, string[]>;
  /**
   * A task's revert was committed on this run (ADR-0054): the integration
   * branch holds commits no record names, so the run carries on even with no
   * record left, and a retry starts from its tip.
   */
  reverted?: true;
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
export type TaskIsolationState = 'none' | 'active' | 'integrated' | 'conflict' | 'repairing' | 'kept';

/** What a conflict repair that will start by itself waits for (ADR-0015). */
export type RepairWait = 'slot' | 'planner' | 'usage-limit';

export type TaskIsolation =
  /** `revertible`: no record, but merges of an earlier attempt are still on the branch. */
  | { state: 'none'; revertible?: true }
  | {
    state: Exclude<TaskIsolationState, 'none'>;
    branch: string;
    /** The task workspace; for a group of one, the task's worktree. */
    worktree: string;
    /** Paths of the repos the task changed. */
    repos: string[];
    conflictRepo?: string;
    /** Repo-relative paths, in `conflictRepo`, that conflicted. */
    conflictFiles?: string[];
    /** The conflict repair running or last run, of the most a task may have; absent before its first. */
    repair?: { attempt: number; limit: number };
    /** What {@link IsolationTaskRecord.repairedFiles} says. */
    repairedFiles?: string[];
    /** Its landing has a merge of its own and is not in the user's branch: what a surface offers a revert on (ADR-0054). */
    revertible?: true;
    /** A `conflict` whose repair starts by itself once this clears: progress, not a conflict to act on (ADR-0015). Said by the scheduler, not the record. */
    repairWaits?: RepairWait;
    /** A `conflict` a task was added to resolve, by id: its one worker (ADR-0015). */
    resolver?: string;
  };

export interface IsolationLandedTask {
  taskId: string;
  order: number;
  title: string;
  /** Set when the task landed only after a conflict repair (ADR-0015): the files it was started for. */
  repairedFiles?: string[];
}

export interface IsolationHandoffRepo {
  path: string;
  integrationBranch: string;
  baseRef: string;
  /** The branch the run started on in this repo; absent when it started on a detached HEAD or the record never noted one. */
  baseBranch?: string;
  /** Set when the run started on a detached HEAD. */
  startedDetached?: true;
  /** Tasks whose work landed in this repo, in plan order. */
  landed: IsolationLandedTask[];
}

export interface IsolationHandoff {
  repos: IsolationHandoffRepo[];
  /** Tasks that landed on the integration branches, in plan order. */
  landed: IsolationLandedTask[];
  /**
   * The run's end is an Act supervisor's to handle first (ADR-0029), so a
   * surface shows the handoff without popping it up. Sent again without this
   * once the supervisor's turn on it ends with the run still unmerged.
   */
  deferredTo?: 'supervisor';
}

/** A plan's isolation as a surface shows it: a mark for each task the run touched, and its handoff. */
export interface IsolationView {
  tasks: Record<string, TaskIsolation>;
  handoff: IsolationHandoff;
}

/**
 * Why "Merge all" would not touch a repo. `partial-landing`: a task's landing
 * was interrupted and could not be rolled back there, so its integration
 * branch holds part of a task. `wrong-branch`: the repo is not on the branch
 * the run started on, and the merge would land on some other one.
 */
export type IsolationMergeBlockReason = 'merge-in-progress' | 'conflict' | 'uncommitted-changes' | 'partial-landing' | 'wrong-branch' | 'git-error';

export interface IsolationMergeBlock {
  repo: string;
  reason: IsolationMergeBlockReason;
  /** The files that would conflict, or the user's uncommitted ones the merge would change or stand in the way of; empty for the other reasons. */
  files: string[];
  /** `wrong-branch` only: the branch the run started on. */
  expected?: string;
  /** `wrong-branch` only: the branch checked out now; absent on a detached HEAD. */
  actual?: string;
  /** `wrong-branch` only: the repo is in the middle of a rebase, which is what detached its HEAD. */
  rebasing?: true;
}

/**
 * How "Merge all" went.
 * - `merged`: every repo with work on its integration branch took it.
 * - `blocked`: a repo was on another branch than the run started on, or the
 *   preflight found repos that could not take their merge, so nothing was
 *   touched anywhere; `blocked` says which and why.
 * - `conflict` / `failed`: a merge stopped in `repo` — on git older than 2.38,
 *   which cannot preflight, or for a reason no preflight could foresee. That
 *   merge was aborted, leaving `repo` as it was; `landed` names the repos
 *   merged before it, which stay merged, and is absent when there are none.
 *   A `failed` merge git itself refused carries the first line it said as
 *   `error`; one that never started, for a merge of the user's already in
 *   progress, carries none.
 *
 * A group of one is blocked only by a partial landing or by being on the wrong
 * branch; otherwise its one merge lands or is aborted whole, so it reports as
 * it always has.
 */
export type IsolationMergeResult =
  | { outcome: 'merged' }
  | { outcome: 'blocked'; blocked: IsolationMergeBlock[] }
  | { outcome: 'conflict' | 'failed'; repo: string; files?: string[]; landed?: string[]; error?: string };

/**
 * What `discard` does with each repo's integration branch: `keep` it for review
 * or merge, `delete` it, or delete it only in the repos whose checked-out HEAD
 * already contains it (`delete-merged`) — the one way that can never give up
 * landed work the user has not merged.
 */
export type IntegrationDisposal = 'keep' | 'delete' | 'delete-merged';

/**
 * Whether a conflict repair's work may land. `not-merged`: the task branch in
 * `repo` does not contain the tip the repair started from. `conflict-markers`:
 * it adds leftover conflict markers to `files`. `failed`: git could not tell.
 */
export type RepairEvidence =
  | { ok: true }
  | { ok: false; reason: 'not-merged' | 'conflict-markers' | 'failed'; repo: string; files?: string[] };

export interface SetupFailure {
  /** Relative to the task workspace; `.` for a lone repository. */
  repo: string;
  detail: string;
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
  /** Repos whose setup command failed, so they got the default links instead; absent when none did. */
  setupFailed?: SetupFailure[];
  /** What the attempt this one replaces left unlanded, kept on a branch before its worktree went; absent when nothing was. */
  preserved?: PreservedWork[];
  /** Set for a `restore` prepare: whether the previous attempt's work was put back, or every repo fell back to its tip. */
  restoration?: 'restored' | 'fallback';
}

/**
 * How a task workspace starts: `fresh` from the integration tips, `restore`
 * with the previous attempt's preserved work merged on top of them — for a
 * continue (ADR-0018, K1) and for a carry-over to another runner.
 */
export type PrepareIntent = 'fresh' | 'restore';

/**
 * What a restoring attempt is told became of the previous attempt's work: in
 * its working tree, or kept on `preserved` branches because restoring it
 * conflicted with the integration tips.
 */
export type PreviousWork =
  | { outcome: 'restored' }
  | { outcome: 'fallback'; preserved: readonly PreservedWork[] };

/** A task as a removal names it. */
export type IsolationTaskRef = Pick<IsolationTaskRecord, 'taskId' | 'order' | 'title'>;

/** A task as its landings name it, and what the commit that reverts one is worded from. */
export type LandedTask = IsolationTaskRef & Pick<IsolationTaskRecord, 'commit'>;

/** A task a revert acts on, with the repos its landing changed. */
export interface IsolationRevertTask extends IsolationTaskRef {
  repos: string[];
}

/**
 * What undoes a task's landing once something of the user's holds it: a command
 * for them to run, which Ordewell shows and never runs (ADR-0054).
 */
export interface RevertCommand {
  task: IsolationTaskRef;
  repo: string;
  /** The task's merge commit, which `heldBy` holds. */
  commit: string;
  /** Ready to type at the workspace root. */
  command: string;
  /** What holds it and stops a revert: local branches by name, and 'HEAD' for a detached HEAD. */
  heldBy: string[];
  /** Whether the user's own branch is among them; if not, `heldBy` may be only a review. */
  merged: boolean;
}

/**
 * What git says of the landed work a revert would take, newest landing first.
 * `inBranch`: the part something of the user's holds, which no revert touches;
 * newest first too, the order to run the commands in. `no-own-merge`: a task's
 * work came in through another's merge, a conflict resolver's, so no merge of
 * its own can undo it. `git`: git could not read what the record names, or say
 * what holds it.
 */
export type LandedWork =
  | { ok: true; tasks: IsolationRevertTask[]; inBranch: RevertCommand[] }
  | { ok: false; reason: 'no-own-merge' | 'checked-out' | 'git'; error: string };

/** What {@link IWorktreeIsolation.revert} asks of its caller, in its turn. */
export interface RevertWatch {
  /** Why the revert may no longer go ahead, read once it has its turn and again with its commits made, which it then rolls back; null when it may. */
  refusal: () => string | null;
  /** Called once the tips are recorded and before the first commit, as a landing's `persist` is, and again as each commit is made. */
  persist: () => void;
  /** Called in the one synchronous step that lets the records go, so a save never sees them gone with the tasks not yet back. */
  settled: (taskIds: readonly string[]) => void;
}

/**
 * How a revert ended (ADR-0054). Anything but `reverted` left every integration
 * branch where it was, except a `failed` that says so: tips git would not put
 * back stay recorded on the run, which holds landings and Merge all off them.
 *
 * - `reverted`: `tasks`, newest landing first, in every repo each changed.
 * - `in-branch`: something of the user's holds part of it: `commands` undo it there.
 * - `refused`: {@link RevertWatch.refusal} said no, or git found work with no
 *   merge of its own, or the integration branch checked out where a revert
 *   cannot commit to it.
 * - `conflict`: reverting `task` conflicted in `repo`, over `files`.
 * - `failed`: git stopped it; `error` says on what.
 */
export type IsolationRevertResult =
  | { outcome: 'reverted'; tasks: IsolationRevertTask[] }
  | { outcome: 'in-branch'; commands: RevertCommand[] }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'conflict'; task: IsolationTaskRef; repo: string; files: string[] }
  | { outcome: 'failed'; error: string; task?: IsolationTaskRef; repo?: string };

/**
 * Work a removal found that had not landed — edits never committed, or
 * commits only the task's branch carried — committed and kept on `branch`,
 * a branch of its own under `ordewell-preserved/`, before the worktree went.
 */
export interface PreservedWork {
  /** Absent for a leftover directory no task record owned. */
  task?: IsolationTaskRef;
  repo: string;
  branch: string;
  /** The commit `branch` points at. */
  commit: string;
}

/** A worktree a removal left in place, because the work in it could not be kept any other way. */
export interface RefusedRemoval {
  /** Absent for a leftover directory no task record owned. */
  task?: IsolationTaskRef;
  worktree: string;
  /** What stopped git keeping it, in words a surface can repeat. */
  reason: string;
}

/**
 * What removing task worktrees did in place of deleting work. A removal never
 * deletes work that has not landed: it keeps it on a branch first
 * (`preserved`), and where it cannot, it leaves that worktree alone
 * (`refused`) — so the record of a refused task stays too.
 */
export interface IsolationRemoval {
  preserved: PreservedWork[];
  refused: RefusedRemoval[];
}

/**
 * What a crash-recovery prune found and left alone: task records that were
 * `active` yet still held unlanded work, so the prune kept them as `kept`
 * rather than deleting work no one else has.
 */
export interface IsolationPruneResult extends IsolationRemoval {
  kept: IsolationTaskRef[];
}

/**
 * The tracked changes of a workspace's repos at one moment, against each
 * repo's HEAD: repo path → file path → the content it held then. What an ops
 * task's tree check compares against (ADR-0020).
 */
export type TreeSnapshot = Record<string, Record<string, string>>;

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
   * the Runner into. Fresh attempts start clean from the tips. A `restore`
   * puts the previous attempt's preserved work on top of them, falling back
   * to the tips in every repo when any restoration conflicts (ADR-0018).
   * `readOnly` marks the record as a read-only task's (ADR-0046). A failure
   * after the last attempt was replaced throws `PrepareFailedError`, naming
   * the work that was kept on branches as that attempt's record went.
   */
  prepare(task: Task, run: IsolationRun, intent?: PrepareIntent, opts?: { readOnly?: boolean }): Promise<PreparedTask>;

  /**
   * Hand a conflicted task's kept workspace to a conflict repair (ADR-0015)
   * as it is — nothing is re-cut — and return the same cwd. Records each
   * changed repo's integration tip as `repairBase`, counts the repair, and
   * moves the task to `repairing`. Throws for a task that is not `conflict`.
   */
  reopen(task: Task, run: IsolationRun): Promise<PreparedTask>;

  /**
   * The evidence a repair must show before it lands: its work committed, and
   * in each repo of `repairBase` the task branch containing that tip
   * (`git merge-base --is-ancestor`) and adding no leftover conflict markers
   * (`git diff --check`; whitespace warnings do not count). Changes nothing
   * else: a task that fails stays `repairing` until released.
   */
  verifyRepair(task: Task, run: IsolationRun): Promise<RepairEvidence>;

  /**
   * Land the task atomically across the repos it changed: commit each
   * worktree, then `git merge --no-ff` the task branch into each changed
   * repo's integration branch. If any merge conflicts or fails, it is aborted
   * and the merges already made for the task are reset away, so `merged`
   * always means the whole task landed. Serialized inside the module; among
   * tasks waiting at once the lowest plan order goes first. On anything but
   * `merged` the worktrees and refs stay, and nothing is resolved here: a
   * conflict is repaired, if at all, by a new attempt of the task in its own
   * worktree (ADR-0015), never inside this queue. A read-only task's record
   * is never merged: it is `failed` (ADR-0046).
   *
   * `persist` is called once `run.landing` is set and before the first
   * merge; the caller saves the run there, synchronously, which is what
   * lets `pruneOrphans` finish a landing a crash interrupted.
   *
   * `commit`, the one the task's done handoff stated, is kept on the record,
   * and what Ordewell commits and merges for the task is written from it;
   * without one, the record's earlier commit, else the task title. A commit
   * the runner made is never rewritten.
   */
  integrate(task: Task, run: IsolationRun, persist?: () => void, commit?: HandoffCommit): Promise<IsolationOutcome>;

  /**
   * What git says of the tasks' landed work now. Reads only and takes no turn:
   * it answers a confirmation, and {@link revert} reads it all again in its own.
   */
  readLanded(run: IsolationRun, taskIds: readonly string[]): Promise<LandedWork>;

  /**
   * Revert the tasks' landings on the integration branches (ADR-0054): one
   * revert commit per landing, newest first, in every repo each changed or in
   * none. Takes its turn on the landing queue, so it never reads
   * a branch mid-landing, judges what it is asked again there, and writes only
   * to Ordewell's own branches. Each reverted task's record goes: its landing
   * no longer counts for anything. A record of a later attempt that did not
   * land stays for the worktree it holds, kept like a stopped one's. What
   * stops it puts every tip back.
   */
  revert(run: IsolationRun, taskIds: readonly string[], watch: RevertWatch): Promise<IsolationRevertResult>;

  /**
   * `keep: false` removes the task's worktree, branch and record (retry, task
   * removal), keeping whatever had not landed on a branch first; a record
   * whose work cannot be kept stays, off `active`. `keep: true` leaves the
   * worktree and branch exactly as they are
   * for inspection — a failed verdict, a stop, a cancel — and only moves the task off `active`,
   * so a crash-recovery prune does not sweep it away; a repair it ends leaves
   * the task `conflict`, as it was before the repair. A read-only task's
   * record goes whole either way, with nothing kept (ADR-0046). Takes the run
   * rather than a bare task id: ids are only unique within one plan, and one
   * daemon serves many (ADR-0025 D2).
   */
  release(run: IsolationRun, taskId: string, opts: { keep: boolean }): Promise<IsolationRemoval>;

  /** End of run: park the integration branch for review and report what landed. */
  handoff(run: IsolationRun): Promise<IsolationHandoff>;

  /**
   * Drop what a crash left behind: a landing it interrupted is rolled back in
   * every repo, a repair it interrupted leaves its task `conflict`, then stale
   * active worktrees and directories no record owns go. An `active` record
   * that still holds unlanded work — commits its branch alone carries, or
   * edits in its worktree — is not a crash orphan: it may belong to a runner
   * another host is still driving, so it is kept as `kept` and named in the
   * result. A leftover directory holding work is kept on a branch before it
   * goes, as {@link release} does.
   */
  pruneOrphans(run: IsolationRun): Promise<IsolationPruneResult>;

  /** Unified diff of each repo's integration branch against its base ref. */
  reviewDiff(run: IsolationRun): Promise<string>;
  taskDiff?(run: IsolationRun, taskId: string, options: TaskDiffRead): Promise<TaskDiffResult>;

  /**
   * Read each landed task's mark again from git: on where the user's branch
   * contains its work in every repo it changed (`git merge-base --is-ancestor`),
   * off where it no longer does. Returns the ids whose mark changed. A review
   * checkout of the integration branch, detached or not, contains nothing
   * merged (ADR-0054). A repo whose integration branch is gone counts as
   * containing it: no Merge all could bring that work in.
   */
  findInHead(run: IsolationRun): Promise<string[]>;

  /**
   * The tracked changes of each committed repo of the workspace's group,
   * except those in `exclude`; null when there is no repo to snapshot.
   * Untracked and ignored files never count.
   */
  snapshotTree(workspaceRoot: string, exclude: readonly string[]): Promise<TreeSnapshot | null>;

  /**
   * Tracked files whose content differs from what `snapshot` recorded: new
   * changes, and further changes to files already changed then. Paths are
   * from the workspace root. A repo git cannot read now is left out.
   */
  changedSince(workspaceRoot: string, snapshot: TreeSnapshot): Promise<string[]>;

  /**
   * "Merge all": merge each repo's integration branch into whatever the user
   * has checked out there. The one irreversible step, so it only ever happens
   * when a caller asks for it. Every repo with work is preflighted first — no
   * merge of the user's in progress, no conflict against their HEAD, no
   * uncommitted edit to a file the merge changes — and unless all pass,
   * nothing is merged anywhere. Only a merge Ordewell itself just started is
   * ever aborted; nothing of the user's is reset. Waits for a landing in
   * flight and holds the next back, so a merge during a run takes the
   * integration branches between two landings, never part of one.
   */
  mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult>;

  /**
   * Remove every worktree and task branch of the run, and settle each repo's
   * integration branch as `integration` says. Anything but `keep` also clears
   * the run's task records, except those of worktrees it refused to remove.
   * Work that had not landed is kept on a branch first, as {@link release} does.
   */
  discard(run: IsolationRun, opts: { integration: IntegrationDisposal }): Promise<IsolationRemoval>;

  /**
   * Clear what other runs left in each repo of `run`'s group: every
   * `ordewell/<run-id>/…` branch the repo's checked-out HEAD already contains.
   * Never a branch of `run` itself, one a worktree has checked out, or any
   * branch of a run that still has a worktree — that run may be live in
   * another plan. Tries every repo, then throws naming those where git failed.
   */
  sweep(run: IsolationRun): Promise<void>;
}

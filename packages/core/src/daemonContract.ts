import type { ApprovalDecision } from './interfaces/IApproval';
import type { AiProvider, PlannerBackendId } from './interfaces/IConfig';
import type { IsolationMergeResult, IsolationPreview } from './interfaces/IWorktreeIsolation';
import type { SessionMeta } from './models/Session';
import type { DiscoveredModel } from './models/Task';
import type { PlannerNotReady } from './services/plannerReadiness';
import type { SessionHeld } from './services/sessionLease';
import type { PendingApproval } from './services/PendingApprovals';
import type { AccountLimitsMessage, ChildMessageOutcome, ChildPlanEntry, ChildPlanView, RunView, SessionMessage, SessionNotice, SurfacePlan, SurfacePlanState } from './services/SessionMessage';
import type { ConversationCompaction, RewindTarget } from './services/PlannerConversation';
import type { PlannerModelRecall } from './services/PlannerModelMemory';
import type { OrchestratorOption } from './services/ProviderRouting';
import type { RunnerModeInfo } from './services/ModeResolver';
import type { GlobalRunSettings, UserSettings } from './services/SettingsService';
import type { TaskLogEvent } from './models/TaskLog';
import type { CommandPayload } from './services/ExecutionCommands';
import type { RunnerAuth } from './services/runnerAuth';
import type { Escalation } from './services/escalations';
import type { TaskRevertPreview } from './services/taskRevert';
import type { ContainerStatus } from './services/container/containerSetup';
import type { ContainerProblem } from './services/container/containerPreflight';
import type { TaskDiffResult } from './services/taskDiffRead';

/**
 * The daemon contract: every HTTP body the local daemon sends, in one place.
 *
 * The daemon's routes build their bodies against these types and the CLI's
 * `ApiClient` reads them back, so a field added on one side is a compile error
 * on the other. Before this there were three hand-written copies — the routes'
 * inline `c.json`, the client's per-method generics, and the TUI's slice of the
 * client — and they had drifted (the client declared a `headless` field the
 * daemon never sent, and typed `GET /sessions/:id`'s plan as the wrong shape).
 *
 * Types only. Core is the one package both the daemon and its clients already
 * depend on; importing from the daemon would pull its runtime into the CLI.
 * An incompatible change here raises `DAEMON_CONTRACT` (utils/daemonProcess.ts).
 */

/**
 * Why a request was refused, as a stable code a client switches on instead of
 * reading the message. Absent on a refusal nobody needs to tell apart — a
 * missing field, say — where the message is all there is.
 */
export type DaemonErrorCode =
  | 'session_not_found'
  | 'task_not_found'
  | 'no_plan'
  | 'already_executing'
  | 'workspace_not_found'
  | 'workspace_not_a_project'
  | 'conversation_busy'
  /** The user stopped the planner turn: the turn ended as asked, so a client stays quiet. */
  | 'planner_turn_stopped'
  /** The planner turn settled after its plan was dropped; nothing it produced was kept. */
  | 'planner_turn_discarded'
  /** The selected planner cannot plan yet (no key, no base URL, no model); `plannerNotReady` says which. */
  | 'planner_not_ready'
  /** The request asked for something the plan, task or conversation does not allow. */
  | 'refused'
  | 'checkpoint_not_waiting'
  /** Merge all would merge work no check has passed; the message names the checks, and a surface asks before sending `pastChecks` (ADR-0055 D9). */
  | 'merge_past_check'
  | 'approval_not_outstanding'
  /** Another live Ordewell host runs this session (ADR-0049); `sessionHeld` names it. */
  | 'session_held'
  /** The tree does not hold that child plan: one id is refused like any other outside it (ADR-0055 D20). */
  | 'child_not_found'
  /** The child plan's attempt has ended: it reads, and Continue on its task is what speaks to it. */
  | 'child_view_only'
  /** That child plan holds no such task: a task's id, exactly. Nothing falls back to the root (ADR-0055 D20). */
  | 'child_task_not_found'
  /** The child plan is open, but its mandate, its grants, the tree's budget or the task's state refuses this now; the message says which. */
  | 'child_refused'
  /** A user read's view scope no longer exists, or cannot be read: the message says why. It never falls back to another scope (ADR-0061 R2). */
  | 'gone'
  /** A user read named a path outside its scope: absolute, `..`, `.git`, Ordewell's state, or a link out of the root (ADR-0061 R3). */
  | 'path_refused'
  /** A user read named a path, ref or commit its scope does not hold. */
  | 'path_not_found'
  /** A user git action would move a live run's repository off its landing branch, or delete it; `landingBranchHeld` names the run (ADR-0062 G7). */
  | 'landing_branch_held'
  /** A user git action's `confirm` no longer matches the repository; `confirmStale` names the difference (ADR-0062 G3). */
  | 'confirm_stale'
  /** A save's `baseHash` is not the file's content on disk now, or a named stash is gone (ADR-0062 G10). */
  | 'stale'
  /** A user git action named a task worktree or another tree that is not the user's checkout (ADR-0062 G1). */
  | 'not_checkout'
  /** A user git action named, or would act on, a branch Ordewell made (`ordewell/*`) (ADR-0062 G1). */
  | 'ordewell_branch'
  /** An amend of a commit a remote-tracking branch already holds (ADR-0062 G4). */
  | 'pushed'
  /** The user's own git refused the action; the message is git's text (ADR-0062 G5). */
  | 'git_failed';

/** The body of every non-2xx answer a route gives. */
export interface ErrorBody {
  error: string;
  code?: DaemonErrorCode;
  /** Set with `workspace_not_a_project`: the directory the daemon refused, so a client can offer to initialize it. */
  workspace?: string;
  /** Set with `planner_not_ready`: the reason as data, so a client can word it in its own commands. */
  plannerNotReady?: PlannerNotReady;
  /** Set with `session_held`: the host that holds the session, and the runners a gone one left. */
  sessionHeld?: SessionHeld;
  /** Set on a command the seam refused after the act ran and stopped: the Merge all git would not take. */
  payload?: CommandPayload;
  /** Set with `landing_branch_held`: the live run that lands on the branch (ADR-0062 G7). */
  landingBranchHeld?: LandingBranchHeld;
  /** Set with `confirm_stale`: what the person was shown against what is there now (ADR-0062 G3). */
  confirmStale?: ConfirmDifference;
}

/**
 * What the command seam said of a control the user pressed (ADR-0029), for the
 * surface to show as it is, so each words a control alike. Absent from a daemon
 * older than the field, and from a call that never reached the seam.
 */
export interface Worded {
  message?: string;
}

export interface OkResponse extends Worded {
  ok: boolean;
}

/**
 * `GET /api/server`: which process owns the port, so a stop can be verified
 * before it signals one, and which daemon it is, so a client it did not start
 * can tell whether it speaks the same contract (ADR-0060 H3).
 */
export interface ServerInfoResponse {
  pid: number;
  port: number;
  /** The daemon's `@ordewell/web` package version. */
  version: string;
  /** `DAEMON_CONTRACT` as the daemon was built. */
  contract: number;
}

/**
 * `POST /api/plans/:id/execute-command`: the body is an `ExecutionCommand`, run
 * as the user (ADR-0029), and this is its answer. `message` is the seam's own
 * line, `payload` what a button needs beyond it (a queued message's id, a force
 * start's queued line). A refusal is the one `ErrorBody` every route gives, code
 * `refused`.
 */
export interface ExecuteCommandResponse {
  ok: true;
  message: string;
  payload?: CommandPayload;
}

/**
 * `GET /api/plans/:id/escalations`: what waits on a person now (ADR-0053). A
 * client holding a socket has the same list on every status update.
 */
export interface EscalationsResponse {
  escalations: Escalation[];
}

/**
 * The body of `POST /api/plans/:id/escalations/answer`, run as the user, and
 * answered as `execute-command` answers. `confirmed` is the user's yes to the
 * option's `confirm`.
 */
export interface AnswerEscalationRequest {
  id: string;
  option: string;
  note?: string;
  confirmed?: boolean;
}

/**
 * A plan as the planner routes return it: the session's plan state, not the
 * `SerializedPlan` a websocket `plan_generated` carries. The two differ —
 * this one holds raw tasks and the dialogue's bookkeeping — and a client that
 * reads either reads only the fields it needs. Skill bodies stay in the
 * session: loads and attempt snapshots arrive as notices.
 */
export interface PlanResponse {
  plan: SurfacePlan;
}

/** `POST /plans/:id/review/approve`: the plan the user signed off, as it now runs. */
export interface ApproveReviewResponse extends PlanResponse, Worded {}

/** `POST /plans/:id/resolve-conflict`: `null` when the session had no conflict to hand a resolver task. */
export interface ResolveConflictResponse {
  plan: SurfacePlan | null;
}

/** What `GET /api/models` returns, and what the pool's provider discovery produces. */
export interface ModelsResponse {
  models: DiscoveredModel[];
  modelsByRunner: Record<string, DiscoveredModel[]>;
  /** Each runner's manifest modes, so a surface can offer a per-task mode picker. */
  modesByRunner: Record<string, RunnerModeInfo[]>;
  orchestratorModel: string;
  providers: AiProvider[];
  /** Full cross-provider catalog for the orchestrator (planner) model picker. */
  orchestratorModels: OrchestratorOption[];
  /** Per-provider catalog-fetch failures, keyed by provider id. */
  providerErrors: Record<string, string>;
}

/** One-shot planning answers in the phase-tagged shape a saved session is read back in. */
export interface GeneratePlanResponse extends Pick<ModelsResponse, 'models' | 'modelsByRunner'> {
  plan: SurfacePlanState;
  /** The host notes the plan's transcript records, a skill check's warnings among them, which the phase-tagged plan does not carry. */
  notes?: string[];
}

export interface ExecuteResponse extends Worded {
  status: 'running';
}

export interface StopResponse extends Worded {
  status: 'stopped';
}

export interface CancelPlanningResponse {
  cancelled: boolean;
}

/** `POST …/converse/resend/cancel`: `cancelled` is false when nothing waited. */
export interface CancelResumeResponse extends Worded {
  cancelled: boolean;
}

export interface TaskMessageResponse {
  id: string;
}

export interface MergeGateEntry {
  id: string;
  order: number;
  title: string;
}

export interface MergeGateResponse {
  mergeGate: MergeGateEntry[];
}

/** A revert that would not go ahead is an answer, not a failure, so it comes back 200 with why (ADR-0054). */
export type TaskRevertPreviewResponse = TaskRevertPreview;

export interface IsolationDiffResponse {
  diff: string;
}

/** A merge that conflicts or is blocked is an outcome, not a refusal, so it answers 200 with the result. */
export type IsolationMergeResponse = IsolationMergeResult;

/** A fork the daemon has already adopted. */
export interface ConversationForkResponse {
  sessionId: string;
  goal: string;
  plan: SurfacePlan;
}

/** A fork made by a rewind, with the full text of the message it was made just before. */
export interface ConversationRewindResponse extends ConversationForkResponse {
  rewoundMessage: string;
}

export interface RewindTargetsResponse {
  targets: RewindTarget[];
}

export interface ConversationCompactResponse extends ConversationCompaction, PlanResponse {}

export interface PrdResponse {
  prdMarkdown: string;
}

export interface RunnerEntry {
  id: string;
  name: string;
  enabled: boolean;
  /** The runner's own login verdict, beside `enabled`: a signed-out agent is still offered, flagged. */
  auth?: RunnerAuth;
  /** What the CLI's `--version` printed, as a number; absent when it printed none. */
  version?: string;
}

export interface RunnersResponse {
  runners: RunnerEntry[];
  orchestratorModel: string;
}

type PlannerCompactionMessage = Extract<SessionMessage, { type: 'planner_compaction' }>;

/** Sessions: a saved one comes off its file, a live one from the pool's store. */
export interface SessionResponse {
  meta: SessionMeta;
  plan: SurfacePlanState;
  /**
   * The planner transcript, which the phase-tagged `plan` does not keep: what
   * a client that joins the session or only reads it redraws its conversation
   * from. Absent from a daemon that predates it.
   */
  conversation?: Pick<SurfacePlan, 'conversationHistory' | 'researchLog' | 'plannerUsage' | 'pendingTurns'>;
  /**
   * The live session's run as `Session.runSnapshot()` holds it, isolation
   * marks and handoff included. Absent for a session nobody holds: the saved
   * file has no run to speak of, and a surface does not rebuild one from it.
   */
  run?: RunView;
  /**
   * The planner turn running now, as {@link AdoptSessionResponse.plannerTurnId}:
   * how a client that joined the session at its holder (ADR-0060 H8), and so
   * never loads it, tells a live turn from one whose end it missed.
   */
  plannerTurnId?: string;
  /** The planner compaction running now, as {@link AdoptSessionResponse.plannerCompaction}. */
  plannerCompaction?: PlannerCompactionMessage;
}

export interface AdoptSessionResponse extends OkResponse {
  plan: SurfacePlan;
  goal: string;
  /** The adopted session's run, as {@link SessionResponse.run}. */
  run?: RunView;
  /**
   * The planner turn holding the session when it was adopted. Absent when none
   * is, which is what lets a surface that lost a turn end settle it.
   */
  plannerTurnId?: string;
  /**
   * The planner compaction running when the session was adopted, as its start
   * was announced (ADR-0017). It has no turn of its own, so `plannerTurnId`
   * cannot tell a surface that joins mid-compaction the planner is busy; this
   * can, and the id is the one its end will carry. Absent when none is.
   */
  plannerCompaction?: PlannerCompactionMessage;
}

export interface TaskLogAttemptsResponse {
  /** Captured with the synchronous listing, including an empty listing. */
  position?: StreamStamp;
  attempts: number[];
}

export interface TaskLogResponse {
  /** Captured with the synchronous log read; live batches after it are not in events. */
  position?: StreamStamp;
  attempt: number;
  events: TaskLogEvent[];
}

/** `GET /api/sessions/:id/children`: every plan below the root, parents before their children. */
export interface ChildListResponse {
  children: ChildPlanEntry[];
}

/**
 * `GET /api/sessions/:id/children/:childId`. Taken with `position`, which is
 * the last frame of the child's socket it accounts for. The numbering counts
 * only what a socket was watching, so a surface opens the socket first and
 * reads this and the child's logs after it.
 */
export type ChildPlanResponse = ChildPlanView & { position: StreamStamp };

/** `POST /api/sessions/:id/children/:childId/message`: `woken` opened a turn, `queued` goes with the next one the slots allow. */
export interface ChildMessageResponse {
  status: Extract<ChildMessageOutcome, { ok: true }>['status'];
}

/**
 * `POST /api/sessions/:id/children/:childId/tasks/:taskId/message`, body
 * `{ message }`, and `.../checkpoint/approve|reject`, body `{ question, reason? }`:
 * what the child's runner was told. `question` is the words the person read
 * (`ChildPlanEntry.checkpoints` names the tasks, `tasks[].checkpoint` of the view
 * holds them), so an answer can never reach a later question. `id` is the message
 * delivered, which a watching surface sees again on the child's socket; absent
 * for an answer, and for a message that resumed a paused task rather than reach
 * a running one.
 */
export interface ChildTaskControlResponse {
  message: string;
  id?: string;
}

export type SessionListResponse = SessionMeta[];

export interface SettingsResponse {
  orchestratorModel: string;
  /** Who plans (ADR-0009) — a vendor id, or a runner serving as a harness planner. */
  aiProvider: PlannerBackendId;
  plannerThinkingEffort: string;
  /** Full (true) or Guarded (false), ADR-0001; the user's saved level (ADR-0030). */
  autonomousMode: boolean;
  maxParallel: number;
  modelAllowlist: UserSettings['modelAllowlist'];
  plannerModels: UserSettings['plannerModels'];
  /**
   * The run settings (ADR-0030): the named open session's own copy when one is
   * asked about, else the file's values, each at its default until set.
   */
  run: GlobalRunSettings;
}

/** What `PATCH /api/settings/containers` answers: why the change was refused, if it was, and where the setting stands. */
export interface ContainerChangeResponse {
  refused: ContainerProblem[];
  status: ContainerStatus;
}

/** What `PATCH /api/settings` answers: the settings as they now stand, plus what the write itself decided. */
export interface SettingsUpdateResponse extends SettingsResponse {
  /**
   * Which model a planner switch landed on and why — remembered for that
   * backend, its catalog default, or none. Present only when the write changed
   * the planner; absent for every other write, where nothing was recalled.
   */
  switchRecall?: PlannerModelRecall;
  /** Env keys the daemon refused to apply, so a client does not persist what the daemon would not. */
  rejectedEnvKeys?: string[];
}

export interface CommandDescriptor {
  name: string;
  description: string;
}

export interface CommandsResponse {
  commands: CommandDescriptor[];
}

export interface WorkspacesResponse {
  workspaces: string[];
}

/**
 * The repositories and branches a run would isolate, as a surface shows them
 * before there is a run. Read-only: nothing about it is authoritative once a
 * run starts, which reads the base branch again.
 */
export interface IsolationPreviewResponse {
  preview: IsolationPreview;
}

export interface ApprovalsResponse {
  pending: PendingApproval[];
  approvedScopes: string[];
}

export interface ApprovalAnswerResponse extends OkResponse {
  granted: boolean;
  decision: ApprovalDecision['decision'];
}

/**
 * Where a frame stands in its session's broadcast stream. A client holding
 * several sockets on one session gets every broadcast on each, and a frame's
 * content is no identity: two identical status frames are the same JSON. `seq`
 * rises by one per broadcast of the session for as long as the daemon runs,
 * whichever Session object holds the id; `stream` names the daemon process,
 * so a restarted daemon's numbering is never compared with the last one's.
 */
export interface StreamStamp {
  stream: string;
  seq: number;
}

/** A broadcast as the session's socket carries it. Unstamped from a daemon older than the stamp. */
export type SessionFrame = (SessionMessage | SessionNotice) & Partial<StreamStamp>;

export type ApprovalRequestMessage = Extract<SessionMessage, { type: 'approval_request' }>;

/**
 * What a session's socket sends right after `connected`: its run as it stands,
 * so a client that joins mid-run has the run view before the next update,
 * and the planner's approval requests
 * still waiting, which no later frame would announce again. `seq` is the last
 * broadcast it accounts for. Session broadcasts are {@link SessionFrame}s;
 * host-owned account limits have their own snapshot and revision.
 */
export interface RunSnapshotFrame extends Partial<StreamStamp> {
  type: 'run_snapshot';
  sessionId: string;
  view: RunView;
  /** Absent from a daemon older than the field: nothing is known, not "none waiting". */
  approvals?: ApprovalRequestMessage[];
}

/**
 * The tree below a root, on the root's socket, whole each time: unstamped, so
 * it replaces what a surface holds. Sent after the greeting and whenever a
 * child opens, ends or changes state; a session with no child plan sends none.
 *
 * A child's own socket is `/ws/session/:root/child/:childId`: `connected`, then
 * a `run_snapshot` under the child's id and frames numbered on its own count,
 * with no approvals (ADR-0056 M8) and no account limits. It closes with 4404
 * for what this root does not hold, or a root no longer loaded; 1012 when the
 * root is replaced, so reconnect; 1001 when the root is closed.
 */
export interface ChildTreeFrame {
  type: 'child_tree';
  sessionId: string;
  children: ChildPlanEntry[];
}

/** Independent of run snapshot stamps: quota reads have their own revision. */
export interface AccountLimitsFrame extends AccountLimitsMessage {
  sessionId: string;
  stream: string;
  revision: number;
}

/**
 * Which tree a user read looks at, per repository (ADR-0061 R2): the user's
 * checkout on disk, a run's integration branch from git objects, or a task's
 * worktree on disk while it exists and its branch after.
 */
export type ViewScopeKind = 'checkout' | 'integration' | 'task';

/**
 * The query every file and git read takes. `repo` is a repository of the
 * workspace relative to it, `.` for the root; `scope` defaults to the checkout.
 * An integration scope names its session, a task scope its session and task.
 */
export interface ReadTarget {
  workspace: string;
  repo?: string;
  scope?: ViewScopeKind;
  sessionId?: string;
  taskId?: string;
}

/**
 * What an answer was read at (ADR-0061 R5), so a later write can say what it
 * saw: the files on disk over `commit` (null for a repository with none yet),
 * or the tree of `commit` alone. `branch` is the scope's branch, for the
 * breadcrumb: the checkout's, the integration branch or the task's.
 */
export interface ReadAt {
  repo: string;
  scope: ViewScopeKind;
  source: 'disk' | 'commit';
  commit: string | null;
  branch: string | null;
}

/**
 * A path's change in its scope: against HEAD in the checkout, against the
 * run's base on the integration branch, against the task's start in a task.
 * `?` untracked, `U` conflicted.
 */
export type FileChangeStatus = 'M' | 'A' | 'D' | '?' | 'U';

export interface FileTreeEntry {
  name: string;
  /** From the repository's scope root, `/`-separated: what every other read takes. */
  path: string;
  /** A link is listed as one and never followed (ADR-0061 R3); a nested repository is a `repository`. */
  kind: 'file' | 'directory' | 'symlink' | 'repository';
  ignored: boolean;
  /** A directory's is `M` when anything below it changed, or `?` when all of it is untracked. */
  status?: FileChangeStatus;
  /** The task whose work changed it: the task itself in its own scope, the task that landed it on an integration branch. */
  taskId?: string;
}

/** `GET /api/files/tree`: one directory's entries, `dir` `''` for the root. */
export interface FileTreeResponse {
  at: ReadAt;
  dir: string;
  entries: FileTreeEntry[];
}

/** `GET /api/files/content`: a file's text and the sha256 of its bytes, or why there is none (ADR-0061 R5). */
export type FileContentResponse =
  | { at: ReadAt; path: string; kind: 'text'; text: string; hash: string; size: number }
  | { at: ReadAt; path: string; kind: 'binary'; size: number }
  | { at: ReadAt; path: string; kind: 'too-large'; size: number; limit: number };

export interface FileFindMatch {
  path: string;
  /** Set on a text match: its 1-based line and the line itself, trimmed to a preview. */
  line?: number;
  preview?: string;
}

/** `GET /api/files/find`: paths whose name holds `query`, or lines holding it with `text`; `truncated` once the cap is hit. */
export interface FileFindResponse {
  at: ReadAt;
  query: string;
  mode: 'name' | 'text';
  matches: FileFindMatch[];
  truncated: boolean;
}

export interface GitRepoInfo {
  repo: string;
  /** Null on a detached HEAD. */
  branch: string | null;
  detached: boolean;
  /** Null in a repository with no commit yet. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** `GET /api/git/repos`: the workspace's repositories (ADR-0014), as the checkout has them. */
export interface GitReposResponse {
  repos: GitRepoInfo[];
}

export interface GitStatusChange {
  path: string;
  /** git's letter: `M`, `A`, `D`, `R`, `C` or `T`. */
  status: string;
  /** A rename's or copy's old path. */
  from?: string;
}

/** `GET /api/git/status`: the checkout's own changes, as `git status` sorts them. */
export interface GitStatusResponse {
  at: ReadAt;
  staged: GitStatusChange[];
  unstaged: GitStatusChange[];
  untracked: string[];
  conflicted: string[];
}

export interface GitDiffFile {
  path: string;
  status: string;
  /** Null for a binary change. */
  added: number | null;
  removed: number | null;
}

/**
 * `GET /api/git/diff`: the changed files first, and with `path` that one file's
 * patch (ADR-0061 R5). `from` and `to` name what was compared, null for the
 * index or the working tree.
 */
export interface GitDiffResponse {
  at: ReadAt;
  from: string | null;
  to: string | null;
  files: GitDiffFile[];
  patch?: string;
}

export interface GitCommitSummary {
  sha: string;
  parents: string[];
  /** The refs pointing at it, as `git log --decorate` names them (`HEAD -> main`, `tag: v1`, `origin/main`). */
  refs: string[];
  subject: string;
  author: string;
  email: string;
  /** ISO 8601, the author date. */
  date: string;
}

/** `GET /api/git/log`: one page of commits, newest first, with parents for the graph; `cursor` fetches the next, null at the end. */
export interface GitLogResponse {
  repo: string;
  ref: string;
  commits: GitCommitSummary[];
  cursor: string | null;
}

/** `GET /api/git/commit`: one commit and the files it changed against its first parent; with `path`, that file's patch. */
export interface GitCommitResponse {
  repo: string;
  commit: GitCommitSummary & { body: string };
  files: GitDiffFile[];
  patch?: string;
}

/** The session, run and task a branch or worktree of Ordewell's belongs to, as the saved isolation records name them. */
export interface OrdewellRefOwner {
  sessionId: string;
  runId: string;
  /** Absent on a run's integration branch. */
  taskId?: string;
}

export interface GitBranchInfo {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  current: boolean;
  /** Set on a branch Ordewell made, when a saved run still names it. */
  owner?: OrdewellRefOwner;
  /** The saved runs that land on this branch at Merge all: their landing branch (ADR-0062 G7). */
  landingFor?: Array<{ sessionId: string; runId: string }>;
}

export interface GitWorktreeInfo {
  /** Absolute, as git lists it. */
  path: string;
  branch: string | null;
  head: string | null;
  /** The user's own checkout, which every linked worktree hangs off. */
  main: boolean;
  owner?: OrdewellRefOwner;
}

/**
 * `GET /api/git/branches`: the repository's local branches, Ordewell's in their
 * own group (`ordewell/` and `ordewell-preserved/`), remote-tracking branches as
 * of the last fetch, its stashes and its worktrees.
 */
export interface GitBranchesResponse {
  repo: string;
  current: string | null;
  detached: boolean;
  local: GitBranchInfo[];
  ordewell: GitBranchInfo[];
  remote: GitBranchInfo[];
  stashes: Array<{ ref: string; sha: string; message: string }>;
  worktrees: GitWorktreeInfo[];
}

/** `GET /api/plans/:sessionId/tasks/:taskId/diff`: a task's diff as `readTaskDiff` reads it for VS Code, from the saved run. */
export type TaskDiffResponse = TaskDiffResult;

/*
 * The user's git actions on their checkout (ADR-0062). Every request names its
 * workspace and repository in the body, and every answer is the repository's
 * new state as `GET /api/git/repos` rows it.
 */

/** The run that holds a repository on its landing branch while it is live (ADR-0062 G7). */
export interface LandingBranchHeld {
  sessionId: string;
  runId: string;
  repo: string;
  branch: string;
}

export type ConfirmValue = string | boolean | string[] | null;

/** One field of a `confirm` that no longer matches: what the person was shown, and what is there now. */
export interface ConfirmDifference {
  field: string;
  shown: ConfirmValue;
  now: ConfirmValue;
}

export interface UserGitTarget {
  /** The daemon's working directory when absent, as for a read. */
  workspace?: string;
  /** Required when the workspace holds more than one repository. */
  repo?: string;
}

/** `PUT /api/files/content`: `baseHash` is the `hash` the file was read at, or null for a file that must not exist yet (ADR-0062 G10). */
export interface FileSaveRequest extends UserGitTarget {
  path: string;
  text: string;
  baseHash: string | null;
}

/**
 * Stage, unstage and discard name whole files in `paths`, or hunks in `hunks`:
 * a unified diff holding only the chosen hunks, cut from what `GET /api/git/diff`
 * showed (staged hunks to unstage, unstaged hunks otherwise).
 */
export interface GitChangesRequest extends UserGitTarget {
  paths?: string[];
  hunks?: string;
}

export interface GitDiscardRequest extends GitChangesRequest {
  /** The files the person was shown as discarded. */
  confirm: { files: string[] };
}

export interface GitCommitRequest extends UserGitTarget {
  message: string;
  amend?: boolean;
  /** Required with `amend`: the commit the person saw as the one amended. */
  confirm?: { head: string };
}

export interface GitBranchCreateRequest extends UserGitTarget {
  name: string;
  /** The commit or branch it starts at; `HEAD` when absent. */
  from?: string;
  switch?: boolean;
}

export interface GitSwitchRequest extends UserGitTarget {
  branch: string;
}

export interface GitBranchDeleteRequest extends UserGitTarget {
  branch: string;
  /** `unmerged`: whether the person was told the branch holds commits its upstream, or else `HEAD`, does not. */
  confirm: { branch: string; unmerged: boolean };
}

export interface GitStashRequest extends UserGitTarget {
  /** Only these paths; every change, untracked files included, when absent. */
  paths?: string[];
  message?: string;
}

/** `stash-pop` and `stash-drop`: a stash by the commit `stash` answered with or the branches read listed, never by its place in the stack. */
export interface GitStashRefRequest extends UserGitTarget {
  stash: string;
}

/** `pull` and `push`: always the checked-out branch's tracking remote and branch, as the person was shown them. */
export interface GitRemoteRequest extends UserGitTarget {
  confirm: { remote: string; branch: string };
}

export interface GitActionResponse {
  repo: GitRepoInfo;
  /** Said with an action that is allowed but has a cost: a switch away from a settled run's landing branch (ADR-0062 G7). */
  warning?: string;
  /** Set by `stash`: the stash it made, by the name `stash-pop` takes. */
  stash?: { sha: string; message: string };
}

/** One repository a run lands in, as Merge all would find it now (ADR-0062 G8). */
export interface MergePreflightRepo {
  repo: string;
  /** The branch Merge all lands on; null for a run that started detached. */
  branch: string | null;
  /** The user's uncommitted files that the incoming work also changes. */
  overlap: string[];
  /** Whether other uncommitted files exist beside the overlap. */
  otherDirty: boolean;
}

/** `GET /api/plans/:sessionId/isolation/merge-preflight`. */
export interface MergePreflightResponse {
  runId: string;
  repos: MergePreflightRepo[];
  /** The message a Stash choice gives `POST /api/git/stash` with the overlapping paths. */
  stashMessage: string;
}

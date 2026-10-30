import type { ApprovalDecision } from './interfaces/IApproval';
import type { AiProvider, PlannerBackendId } from './interfaces/IConfig';
import type { IsolationMergeResult, IsolationPreview } from './interfaces/IWorktreeIsolation';
import type { SessionMeta } from './models/Session';
import type { DiscoveredModel } from './models/Task';
import type { PlannerNotReady } from './services/plannerReadiness';
import type { SessionHeld } from './services/sessionLease';
import type { PendingApproval } from './services/PendingApprovals';
import type { AccountLimitsMessage, RunView, SessionMessage, SessionNotice, SurfacePlan, SurfacePlanState } from './services/SessionMessage';
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
  | 'approval_not_outstanding'
  /** Another live Ordewell host runs this session (ADR-0049); `sessionHeld` names it. */
  | 'session_held';

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

/** `GET /api/server`: which process owns the port, so a stop can be verified before it signals one. */
export interface ServerInfoResponse {
  pid: number;
  port: number;
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
   * The live session's run as `Session.runSnapshot()` holds it, isolation
   * marks and handoff included. Absent for a session nobody holds: the saved
   * file has no run to speak of, and a surface does not rebuild one from it.
   */
  run?: RunView;
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

export type SessionListResponse = SessionMeta[];

export interface SettingsResponse {
  orchestratorModel: string;
  /** Who plans (ADR-0009) — a vendor id, or a runner serving as a harness planner. */
  aiProvider: PlannerBackendId;
  plannerThinkingEffort: string;
  maxParallel: number;
  modelAllowlist: UserSettings['modelAllowlist'];
  plannerModels: UserSettings['plannerModels'];
  /**
   * The run settings (ADR-0030): the named open session's own copy when one is
   * asked about, else the file's values, each at its default until set.
   */
  run: GlobalRunSettings;
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

/** Independent of run snapshot stamps: quota reads have their own revision. */
export interface AccountLimitsFrame extends AccountLimitsMessage {
  sessionId: string;
  stream: string;
  revision: number;
}

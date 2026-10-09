import type { ApprovalDecision } from './interfaces/IApproval';
import type { AiProvider } from './interfaces/IConfig';
import type { IsolationMergeResult } from './interfaces/IWorktreeIsolation';
import type { SessionMeta } from './models/Session';
import type { DiscoveredModel } from './models/Task';
import type { PendingApproval } from './services/PendingApprovals';
import type { SurfacePlan, SurfacePlanState } from './services/SessionMessage';
import type { ConversationCompaction, RewindTarget } from './services/PlannerConversation';
import type { PlannerModelRecall } from './services/PlannerModelMemory';
import type { OrchestratorOption } from './services/ProviderRouting';
import type { RunnerModeInfo } from './services/ModeResolver';
import type { UserSettings } from './services/SettingsService';
import type { TaskLogEvent } from './models/TaskLog';

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
  /** The request asked for something the plan, task or conversation does not allow. */
  | 'refused'
  | 'checkpoint_not_waiting'
  | 'approval_not_outstanding';

/** The body of every non-2xx answer a route gives. */
export interface ErrorBody {
  error: string;
  code?: DaemonErrorCode;
  /** Set with `workspace_not_a_project`: the directory the daemon refused, so a client can offer to initialize it. */
  workspace?: string;
}

export interface OkResponse {
  ok: boolean;
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

export interface ExecuteResponse {
  status: 'running';
}

export interface StopResponse {
  status: 'stopped';
}

export interface CancelPlanningResponse {
  cancelled: boolean;
}

export interface TaskMessageResponse {
  id: string;
}

export interface ForceSendResponse {
  sent: boolean;
}

export interface RemoveMessageResponse {
  removed: boolean;
}

export interface MergeGateEntry {
  id: string;
  order: number;
  title: string;
}

export interface MergeGateResponse {
  mergeGate: MergeGateEntry[];
}

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
}

export interface RunnersResponse {
  runners: RunnerEntry[];
  orchestratorModel: string;
}

/** Sessions: a saved one comes off its file, a live one from the pool's store. */
export interface SessionResponse {
  meta: SessionMeta;
  plan: SurfacePlanState;
}

export interface AdoptSessionResponse extends OkResponse {
  plan: SurfacePlan;
  goal: string;
}

export interface TaskLogAttemptsResponse {
  attempts: number[];
}

export interface TaskLogResponse {
  attempt: number;
  events: TaskLogEvent[];
}

export type SessionListResponse = SessionMeta[];

export interface SettingsResponse {
  orchestratorModel: string;
  /** Who plans (ADR-0009) — a vendor id, or one of the three harness planners. */
  aiProvider: AiProvider;
  plannerThinkingEffort: string;
  maxParallel: number;
  modelAllowlist: UserSettings['modelAllowlist'];
  plannerModels: UserSettings['plannerModels'];
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

export interface ApprovalsResponse {
  pending: PendingApproval[];
  approvedScopes: string[];
}

export interface ApprovalAnswerResponse extends OkResponse {
  granted: boolean;
  decision: ApprovalDecision['decision'];
}

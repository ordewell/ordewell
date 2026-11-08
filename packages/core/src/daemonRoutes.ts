import type { ApprovalDecision } from './interfaces/IApproval';
import type { Task } from './models/Task';
import type { ExecutionCommand } from './services/ExecutionCommands';
import type { GlobalRunSettings } from './services/runSettingsDefaults';
import type { ContainerChange, ContainerStatus } from './services/container/containerSetup';
import type {
  AdoptSessionResponse,
  AnswerEscalationRequest,
  ApprovalAnswerResponse,
  ApprovalsResponse,
  ApproveReviewResponse,
  CancelPlanningResponse,
  CancelResumeResponse,
  ChildListResponse,
  ChildMessageResponse,
  ChildPlanResponse,
  ChildTaskControlResponse,
  ContainerChangeResponse,
  ConversationCompactResponse,
  ConversationForkResponse,
  ConversationRewindResponse,
  EscalationsResponse,
  ExecuteCommandResponse,
  ExecuteResponse,
  FileContentResponse,
  FileFindResponse,
  FileSaveRequest,
  FileTreeResponse,
  GeneratePlanResponse,
  GitActionResponse,
  GitBranchCreateRequest,
  GitBranchDeleteRequest,
  GitBranchesResponse,
  GitChangesRequest,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitDiscardRequest,
  GitLogResponse,
  GitRemoteRequest,
  GitReposResponse,
  GitStashRefRequest,
  GitStashRequest,
  GitStatusResponse,
  GitSwitchRequest,
  IsolationDiffResponse,
  IsolationMergeResponse,
  IsolationPreviewResponse,
  MergeGateResponse,
  MergePreflightResponse,
  ModelsResponse,
  OkResponse,
  PlanResponse,
  PrdResponse,
  ResolveConflictResponse,
  RewindTargetsResponse,
  RunnersResponse,
  ServerInfoResponse,
  SessionListResponse,
  SessionResponse,
  SettingsResponse,
  SettingsUpdateResponse,
  StopResponse,
  TaskDiffResponse,
  TaskLogAttemptsResponse,
  TaskLogResponse,
  TaskMessageResponse,
  TaskRevertPreviewResponse,
  UserGitTarget,
  WorkspacesResponse,
} from './daemonContract';

/**
 * The daemon's routes, one row per route id: what `daemonContract` says the
 * bodies are, this says where they go. The daemon's routers are checked
 * against it (packages/web's route table test), and each client derives its
 * calls from it rather than declaring the path again (ADR-0063 H4, ADR-0006
 * S3). Pure, and types only beside the rows: a renderer imports it through
 * `plan-utils`.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteSpec {
  method: HttpMethod;
  /** `:name` marks a path parameter, filled from the same-named param as one segment. */
  path: string;
  /** Query parameters the route reads; a client sends no other. */
  query?: readonly string[];
  /**
   * A planner turn: the daemon answers when the turn ends, which can be long
   * after the socket last carried a byte, so a client sets it no idle bound.
   * The turn's progress reaches the view over the session socket meanwhile.
   */
  turn?: true;
  /**
   * The path param naming a session whose live host answers this route. For
   * a session a window joined, the desktop sends it to the holder's daemon
   * (ADR-0063 H8); anything else, and every route without it, stays on the
   * app's own daemon: files, git, the catalog, and opening, closing or
   * deleting a session there. Every such row takes `workspace`: the daemon keeps
   * one session per id, so a call naming another workspace than the one the id
   * is open for is refused, never served from another project's session.
   */
  live?: 'id' | 'sessionId';
}

// Never set at runtime: the row carries its body and response as types only.
declare const SHAPES: unique symbol;

export interface DaemonRoute<Body = unknown, Response = unknown> extends RouteSpec {
  readonly [SHAPES]?: { body: Body; response: Response };
}

/** A row that answers `Response` and takes `Body`, `undefined` for a route that reads none. */
function row<Response, Body = undefined>() {
  return <const S extends RouteSpec>(spec: S): S & DaemonRoute<Body, Response> => spec;
}

const WS = ['workspace'] as const;
/** What the file and git reads take to pick the tree (ADR-0064 R2): the repo and the view scope. */
const AT = ['workspace', 'repo', 'scope', 'sessionId', 'taskId'] as const;

interface GoalRequest { goal: string; runners?: string[]; workspace?: string; model?: string; allowInit?: boolean }
interface MessageRequest { message: string }
interface ChildCheckpointRequest { question: string; reason?: string }
interface CheckpointRequest { reason?: string; raiseTokens?: number }
/** A runner request's whole answer (ADR-0018 A1), or the planner prompt's yes or no. */
type ApprovalDecideRequest = ApprovalDecision | { granted: boolean };
/** Any setting by name, with the run settings under `run` (ADR-0030) and where the change was made. */
interface SettingsUpdateRequest { run?: Partial<GlobalRunSettings>; sessionId?: string; workspace?: string; [setting: string]: unknown }

// Ids are `area.verb`, as the design's Daemon routes table names them.
export const DAEMON_ROUTES = {
  'server.info': row<ServerInfoResponse>()({ method: 'GET', path: '/api/server' }),

  'workspaces.list': row<WorkspacesResponse>()({ method: 'GET', path: '/api/workspaces' }),
  'workspaces.isolationPreview': row<IsolationPreviewResponse>()({ method: 'GET', path: '/api/workspaces/isolation-preview', query: WS }),

  'sessions.list': row<SessionListResponse>()({ method: 'GET', path: '/api/sessions', query: WS }),
  'sessions.get': row<SessionResponse>()({ method: 'GET', path: '/api/sessions/:id', query: WS, live: 'id' }),
  'sessions.load': row<AdoptSessionResponse>()({ method: 'POST', path: '/api/sessions/:id/load', query: WS }),
  'sessions.close': row<OkResponse>()({ method: 'POST', path: '/api/sessions/:id/close', query: WS }),
  'sessions.delete': row<OkResponse>()({ method: 'DELETE', path: '/api/sessions/:id', query: WS }),
  'sessions.taskLog': row<TaskLogAttemptsResponse>()({ method: 'GET', path: '/api/sessions/:id/tasks/:taskId/log', query: WS, live: 'id' }),
  'sessions.taskLogAttempt': row<TaskLogResponse>()({ method: 'GET', path: '/api/sessions/:id/tasks/:taskId/log/:attempt', query: WS, live: 'id' }),

  'children.list': row<ChildListResponse>()({ method: 'GET', path: '/api/sessions/:id/children', query: WS, live: 'id' }),
  'children.get': row<ChildPlanResponse>()({ method: 'GET', path: '/api/sessions/:id/children/:childId', query: WS, live: 'id' }),
  'children.taskLog': row<TaskLogAttemptsResponse>()({ method: 'GET', path: '/api/sessions/:id/children/:childId/tasks/:taskId/log', query: WS, live: 'id' }),
  'children.taskLogAttempt': row<TaskLogResponse>()({ method: 'GET', path: '/api/sessions/:id/children/:childId/tasks/:taskId/log/:attempt', query: WS, live: 'id' }),
  'children.message': row<ChildMessageResponse, MessageRequest>()({ method: 'POST', path: '/api/sessions/:id/children/:childId/message', query: WS, live: 'id' }),
  'children.taskMessage': row<ChildTaskControlResponse, MessageRequest>()({ method: 'POST', path: '/api/sessions/:id/children/:childId/tasks/:taskId/message', query: WS, live: 'id' }),
  'children.checkpointApprove': row<ChildTaskControlResponse, ChildCheckpointRequest>()({ method: 'POST', path: '/api/sessions/:id/children/:childId/tasks/:taskId/checkpoint/approve', query: WS, live: 'id' }),
  'children.checkpointReject': row<ChildTaskControlResponse, ChildCheckpointRequest>()({ method: 'POST', path: '/api/sessions/:id/children/:childId/tasks/:taskId/checkpoint/reject', query: WS, live: 'id' }),

  'plans.generate': row<GeneratePlanResponse, GoalRequest>()({ method: 'POST', path: '/api/plans/:sessionId/generate', query: ['workspace', 'runners'], turn: true, live: 'sessionId' }),
  'plans.execute': row<ExecuteResponse>()({ method: 'POST', path: '/api/plans/:sessionId/execute', query: WS, live: 'sessionId' }),
  'plans.stop': row<StopResponse>()({ method: 'POST', path: '/api/plans/:sessionId/stop', query: WS, live: 'sessionId' }),
  'plans.stopPlanning': row<CancelPlanningResponse>()({ method: 'POST', path: '/api/plans/:sessionId/planning/stop', query: WS, live: 'sessionId' }),
  'plans.executeCommand': row<ExecuteCommandResponse, ExecutionCommand>()({ method: 'POST', path: '/api/plans/:sessionId/execute-command', query: WS, live: 'sessionId' }),
  'plans.escalations': row<EscalationsResponse>()({ method: 'GET', path: '/api/plans/:sessionId/escalations', query: WS, live: 'sessionId' }),
  'plans.answerEscalation': row<ExecuteCommandResponse, AnswerEscalationRequest>()({ method: 'POST', path: '/api/plans/:sessionId/escalations/answer', query: WS, live: 'sessionId' }),
  'plans.taskCommands': row<TaskMessageResponse, { name: string; args?: string }>()({ method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/commands', query: WS, live: 'sessionId' }),
  'plans.mergeGate': row<MergeGateResponse>()({ method: 'GET', path: '/api/plans/:sessionId/tasks/:taskId/merge-gate', query: WS, live: 'sessionId' }),
  'plans.revertPreview': row<TaskRevertPreviewResponse>()({ method: 'GET', path: '/api/plans/:sessionId/tasks/:taskId/revert-preview', query: WS, live: 'sessionId' }),
  'plans.isolationDiff': row<IsolationDiffResponse>()({ method: 'GET', path: '/api/plans/:sessionId/isolation/diff', query: WS, live: 'sessionId' }),
  // Reads of the saved run (ADR-0064, ADR-0062 G8): neither needs the session open here.
  'plans.taskDiff': row<TaskDiffResponse>()({ method: 'GET', path: '/api/plans/:sessionId/tasks/:taskId/diff', query: ['workspace', 'repo', 'path', 'names'], live: 'sessionId' }),
  'plans.mergePreflight': row<MergePreflightResponse>()({ method: 'GET', path: '/api/plans/:sessionId/isolation/merge-preflight', query: WS, live: 'sessionId' }),
  'plans.isolationMerge': row<IsolationMergeResponse, { pastChecks?: true } | undefined>()({ method: 'POST', path: '/api/plans/:sessionId/isolation/merge', query: WS, live: 'sessionId' }),
  'plans.isolationDiscard': row<OkResponse>()({ method: 'POST', path: '/api/plans/:sessionId/isolation/discard', query: WS, live: 'sessionId' }),
  'plans.isolationCleanup': row<OkResponse>()({ method: 'POST', path: '/api/plans/:sessionId/isolation/cleanup', query: WS, live: 'sessionId' }),
  'plans.isolationStash': row<OkResponse>()({ method: 'POST', path: '/api/plans/:sessionId/isolation/stash-and-continue', query: WS, live: 'sessionId' }),
  'plans.isolationRunWithout': row<OkResponse>()({ method: 'POST', path: '/api/plans/:sessionId/isolation/run-without', query: WS, live: 'sessionId' }),
  'plans.checkpointApprove': row<OkResponse, CheckpointRequest | undefined>()({ method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/checkpoint/approve', query: WS, live: 'sessionId' }),
  'plans.checkpointReject': row<OkResponse, CheckpointRequest | undefined>()({ method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/checkpoint/reject', query: WS, live: 'sessionId' }),
  'plans.resolveConflict': row<ResolveConflictResponse>()({ method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/resolve-conflict', query: WS, live: 'sessionId' }),
  'plans.addTask': row<OkResponse, Partial<Task>>()({ method: 'POST', path: '/api/plans/:sessionId/tasks', query: WS, live: 'sessionId' }),
  'plans.updateTask': row<OkResponse, Partial<Task>>()({ method: 'PUT', path: '/api/plans/:sessionId/tasks/:taskId', query: WS, live: 'sessionId' }),
  'plans.deleteTask': row<OkResponse>()({ method: 'DELETE', path: '/api/plans/:sessionId/tasks/:taskId', query: WS, live: 'sessionId' }),
  'plans.approveReview': row<ApproveReviewResponse>()({ method: 'POST', path: '/api/plans/:sessionId/review/approve', query: WS, live: 'sessionId' }),
  'plans.converseStart': row<PlanResponse, GoalRequest>()({ method: 'POST', path: '/api/plans/:sessionId/converse/start', query: WS, turn: true, live: 'sessionId' }),
  'plans.converseMessage': row<PlanResponse, MessageRequest>()({ method: 'POST', path: '/api/plans/:sessionId/converse/message', query: WS, turn: true, live: 'sessionId' }),
  'plans.converseMessageNow': row<PlanResponse, MessageRequest>()({ method: 'POST', path: '/api/plans/:sessionId/converse/message/now', query: WS, turn: true, live: 'sessionId' }),
  'plans.cancelResend': row<CancelResumeResponse>()({ method: 'POST', path: '/api/plans/:sessionId/converse/resend/cancel', query: WS, live: 'sessionId' }),
  'plans.fork': row<ConversationForkResponse>()({ method: 'POST', path: '/api/plans/:sessionId/conversation/fork', query: WS, live: 'sessionId' }),
  'plans.rewindTargets': row<RewindTargetsResponse>()({ method: 'GET', path: '/api/plans/:sessionId/conversation/rewind-targets', query: WS, live: 'sessionId' }),
  'plans.rewind': row<ConversationRewindResponse, { index: number }>()({ method: 'POST', path: '/api/plans/:sessionId/conversation/rewind', query: WS, live: 'sessionId' }),
  'plans.compact': row<ConversationCompactResponse>()({ method: 'POST', path: '/api/plans/:sessionId/conversation/compact', query: WS, turn: true, live: 'sessionId' }),
  'plans.retryCompact': row<PlanResponse>()({ method: 'POST', path: '/api/plans/:sessionId/conversation/compact/retry', query: WS, turn: true, live: 'sessionId' }),
  'plans.prd': row<PrdResponse>()({ method: 'GET', path: '/api/plans/:sessionId/prd', query: WS, live: 'sessionId' }),

  'approvals.list': row<ApprovalsResponse>()({ method: 'GET', path: '/api/approvals/:sessionId', query: WS, live: 'sessionId' }),
  'approvals.decide': row<ApprovalAnswerResponse, ApprovalDecideRequest>()({ method: 'POST', path: '/api/approvals/:sessionId/:approvalId', query: WS, live: 'sessionId' }),

  'models.list': row<ModelsResponse>()({ method: 'GET', path: '/api/models', query: WS }),

  'runners.list': row<RunnersResponse>()({ method: 'GET', path: '/api/runners', query: WS }),
  'runners.setEnabled': row<OkResponse, { enabled: boolean }>()({ method: 'PUT', path: '/api/runners/:id' }),

  'files.tree': row<FileTreeResponse>()({ method: 'GET', path: '/api/files/tree', query: [...AT, 'dir'] }),
  'files.content': row<FileContentResponse>()({ method: 'GET', path: '/api/files/content', query: [...AT, 'path'] }),
  'files.find': row<FileFindResponse>()({ method: 'GET', path: '/api/files/find', query: [...AT, 'query', 'text', 'limit'] }),
  'files.save': row<GitActionResponse, FileSaveRequest>()({ method: 'PUT', path: '/api/files/content' }),

  'git.repos': row<GitReposResponse>()({ method: 'GET', path: '/api/git/repos', query: WS }),
  'git.status': row<GitStatusResponse>()({ method: 'GET', path: '/api/git/status', query: AT }),
  'git.branches': row<GitBranchesResponse>()({ method: 'GET', path: '/api/git/branches', query: AT }),
  'git.diff': row<GitDiffResponse>()({ method: 'GET', path: '/api/git/diff', query: [...AT, 'kind', 'from', 'to', 'path'] }),
  'git.log': row<GitLogResponse>()({ method: 'GET', path: '/api/git/log', query: [...AT, 'ref', 'cursor', 'limit'] }),
  // `git.show` reads a commit, leaving `git.commit` free for the POST that makes one.
  'git.show': row<GitCommitResponse>()({ method: 'GET', path: '/api/git/commit', query: [...AT, 'sha', 'path'] }),
  // The user's own actions on their checkout (ADR-0062 G1-G5): each names its workspace in the body.
  'git.stage': row<GitActionResponse, GitChangesRequest>()({ method: 'POST', path: '/api/git/stage' }),
  'git.unstage': row<GitActionResponse, GitChangesRequest>()({ method: 'POST', path: '/api/git/unstage' }),
  'git.commit': row<GitActionResponse, GitCommitRequest>()({ method: 'POST', path: '/api/git/commit' }),
  'git.discard': row<GitActionResponse, GitDiscardRequest>()({ method: 'POST', path: '/api/git/discard' }),
  'git.branch': row<GitActionResponse, GitBranchCreateRequest>()({ method: 'POST', path: '/api/git/branch' }),
  'git.switch': row<GitActionResponse, GitSwitchRequest>()({ method: 'POST', path: '/api/git/switch' }),
  'git.branchDelete': row<GitActionResponse, GitBranchDeleteRequest>()({ method: 'POST', path: '/api/git/branch-delete' }),
  'git.stash': row<GitActionResponse, GitStashRequest>()({ method: 'POST', path: '/api/git/stash' }),
  'git.stashPop': row<GitActionResponse, GitStashRefRequest>()({ method: 'POST', path: '/api/git/stash-pop' }),
  'git.stashDrop': row<GitActionResponse, GitStashRefRequest>()({ method: 'POST', path: '/api/git/stash-drop' }),
  'git.fetch': row<GitActionResponse, UserGitTarget>()({ method: 'POST', path: '/api/git/fetch' }),
  'git.pull': row<GitActionResponse, GitRemoteRequest>()({ method: 'POST', path: '/api/git/pull' }),
  'git.push': row<GitActionResponse, GitRemoteRequest>()({ method: 'POST', path: '/api/git/push' }),

  'settings.get': row<SettingsResponse>()({ method: 'GET', path: '/api/settings', query: ['workspace', 'sessionId'] }),
  'settings.update': row<SettingsUpdateResponse, SettingsUpdateRequest>()({ method: 'PATCH', path: '/api/settings' }),
  'settings.containers': row<ContainerStatus>()({ method: 'GET', path: '/api/settings/containers', query: ['workspace', 'prove'] }),
  // Its workspace rides in the body beside the one change, as `settings.update`'s does.
  'settings.updateContainers': row<ContainerChangeResponse, ContainerChange & { workspace?: string }>()({ method: 'PATCH', path: '/api/settings/containers' }),
} as const;

export type DaemonRouteId = keyof typeof DAEMON_ROUTES;

type ShapesOf<Id extends DaemonRouteId> = NonNullable<(typeof DAEMON_ROUTES)[Id][typeof SHAPES]>;

/** What the route answers with a 200. */
export type RouteResponse<Id extends DaemonRouteId> = ShapesOf<Id>['response'];

/** The JSON body the route reads; `undefined` for one that reads none. */
export type RouteBody<Id extends DaemonRouteId> = ShapesOf<Id>['body'];

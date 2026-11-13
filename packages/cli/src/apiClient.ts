import http from 'http';
import WebSocket from 'ws';
import { DEFAULT_PORT, isConnectionRefused } from './daemon';
import { bearerHeaderValue, readDaemonToken, tokenSubprotocols, mintSessionId, DAEMON_ROUTES } from '@ordewell/core';
import { routeRequest, sessionOf, socketPath, type CallParts, type QueryKeys, type RouteRequest } from './routeRequest';
import type {
  AdoptSessionResponse,
  ApprovalAnswer,
  ApproveReviewResponse,
  CancelPlanningResponse,
  CancelResumeResponse,
  ChildListResponse,
  ChildMessageResponse,
  ChildPlanResponse,
  ChildTaskControlResponse,
  ChildTreeFrame,
  ConfirmDifference,
  ContainerChange,
  ContainerChangeResponse,
  ContainerStatus,
  ConversationCompactResponse,
  ConversationForkResponse,
  ConversationRewindResponse,
  DaemonErrorCode,
  DaemonRouteId,
  ErrorBody,
  AnswerEscalationRequest,
  EscalationsResponse,
  ExecuteCommandResponse,
  ExecuteResponse,
  ExecutionCommand,
  FileContentResponse,
  FileFindResponse,
  FileTreeResponse,
  FileSaveRequest,
  GitActionResponse,
  GitBranchCreateRequest,
  GitBranchDeleteRequest,
  GitChangesRequest,
  GitCommitRequest,
  GitDiscardRequest,
  GitRemoteRequest,
  GitStashRequest,
  LandingBranchHeld,
  MergePreflightResponse,
  UserGitTarget,
  GitBranchesResponse,
  GitCommitResponse,
  GitDiffResponse,
  GitLogResponse,
  GitReposResponse,
  GitStatusResponse,
  ReadTarget,
  Task,
  TaskDiffResponse,
  GeneratePlanResponse,
  IsolationMergeResponse,
  IsolationPreviewResponse,
  MergeGateEntry,
  ModelsResponse,
  OkResponse,
  GlobalRunSettings,
  PlanResponse,
  PlannerNotReady,
  SurfacePlan,
  SurfacePlanState,
  ResolveConflictResponse,
  RewindTarget,
  RouteResponse,
  AccountLimitsFrame,
  RunSnapshotFrame,
  RunnersResponse,
  SessionFrame,
  SessionListResponse,
  SessionMeta,
  SessionHeld,
  SessionResponse,
  SettingsResponse,
  SettingsUpdateResponse,
  StopResponse,
  TaskLogAttemptsResponse,
  TaskLogResponse,
  TaskMessageResponse,
  TaskRevertPreviewResponse,
} from '@ordewell/core';

const DEFAULT_HTTP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The one agent every daemon call uses. `http.globalAgent` carries a 5000 ms
 * socket timer of its own, which a request that asked for no bound inherits and
 * times out under; `timeout: 0` keeps no timer here, so only a request's own
 * `timeout` bounds its socket idleness.
 */
const daemonAgent = new http.Agent({ keepAlive: true, timeout: 0 });

export interface PlanResult {
  sessionId: string;
  plan: SurfacePlanState;
  models?: GeneratePlanResponse['models'];
  modelsByRunner?: GeneratePlanResponse['modelsByRunner'];
  notes?: string[];
}

/** How a merge of the run into the user's checkout went, and on anything but `merged`, which repo stopped it. */
export type MergeRunResult = IsolationMergeResponse;

/** A fork the daemon has already adopted. */
export type ConversationForkResult = ConversationForkResponse;

/** A fork made by a rewind, with the full text of the message it was made just before. */
export type ConversationRewindResult = ConversationRewindResponse;

/**
 * A refusal the daemon gave, carrying the status and the stable `code` a caller
 * switches on. The message is for display only: nothing may branch on its text.
 */
export class DaemonError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: DaemonErrorCode,
    readonly plannerNotReady?: PlannerNotReady,
    /** With `session_held`: the host that runs the session (ADR-0049). */
    readonly sessionHeld?: SessionHeld,
    /** With `landing_branch_held`: the live run that lands on the branch (ADR-0062 G7). */
    readonly landingBranchHeld?: LandingBranchHeld,
    /** With `confirm_stale`: what the person was shown against what is there now (ADR-0062 G3). */
    readonly confirmStale?: ConfirmDifference,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

/**
 * What a rejected call says about whether the daemon got the request. The one
 * place that decides it, so a caller never re-guesses from an error's wording:
 * - `answered`: the daemon replied, with a refusal ({@link DaemonError}) or with
 *   a body this client could not use ({@link UnreadableResponseError}).
 * - `refused`: nothing was listening, so the request never arrived and may be replayed.
 * - `unknown`: a timeout, reset or hang-up after the request went out; the daemon
 *   may be running it or have finished it, and replaying it could run it twice.
 */
export type Delivery = 'answered' | 'refused' | 'unknown';

export function deliveryOf(err: unknown): Delivery {
  if (err instanceof DaemonError || err instanceof UnreadableResponseError) return 'answered';
  return isConnectionRefused(err) ? 'refused' : 'unknown';
}

/**
 * A 200 that arrived but whose body is not what its route promises. The daemon
 * did take the request and answer it, so this is never a lost reply: nothing
 * about the turn is in doubt, only what this client can show of its answer.
 */
export class UnreadableResponseError extends Error {
  constructor(route: string, readonly why: string) {
    super(`The server answered ${route}, but its reply could not be used: ${why}.`);
    this.name = 'UnreadableResponseError';
  }
}

/**
 * A request the client gave up on after `timeoutMs`, or one that had no bound
 * at all — `undefined` for a planner turn, which only Stop ends. `viaEnv` says
 * `ORDEWELL_HTTP_TIMEOUT_MS` set the bound.
 */
export class RequestTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(readonly timeoutMs: number | undefined, readonly viaEnv: boolean) {
    super('Request timed out');
    this.name = 'RequestTimeoutError';
  }
}

/** The `plan` a planner route answers with, or the reason the body is not one. */
function planOf<T extends { plan: unknown }>(data: unknown, route: string): T {
  if (typeof data !== 'object' || data === null) throw new UnreadableResponseError(route, data === null ? 'the body was empty' : 'the body was not JSON');
  const plan = (data as { plan?: unknown }).plan;
  if (typeof plan !== 'object' || plan === null) throw new UnreadableResponseError(route, 'it carried no plan');
  return data as T;
}

/** A workspace the daemon rejected for lacking a project marker, distinguished from other 400s so the TUI can offer to initialize it instead of just reporting failure. */
export class WorkspaceInitNeededError extends DaemonError {
  constructor(message: string, readonly workspace: string) {
    super(message, 400, 'workspace_not_a_project');
    this.name = 'WorkspaceInitNeededError';
  }
}

/**
 * A plan as a planner or session endpoint answers with it: the phase-tagged
 * state a saved session is read back in, or the session's plan itself. Which
 * one depends on the route, so a reader takes either.
 */
export type PlanBody = SurfacePlanState | SurfacePlan;

export type RunnerState = RunnersResponse['runners'][number];
export type { RunnersResponse };

export type { SessionMeta };


/**
 * What the daemon pushes over a websocket: the core union itself, not a bag
 * that happens to have a `type`.
 *
 * It used to be `{ type: string; [key: string]: unknown }`, which meant the CLI
 * and TUI adapters consumed no union at all — a new `SessionMessage` variant
 * compiled everywhere and was silently dropped by their `default:` arms. Naming
 * the real type turns that into a compile error at each surface. Each
 * broadcast carries its place in the session's stream, for a client holding
 * several sockets to tell one broadcast's copies from two broadcasts.
 */
export type WsEvent = SessionFrame | RunSnapshotFrame | AccountLimitsFrame | ChildTreeFrame;

/**
 * How a held socket ended: its close code, and the error that led there when
 * there was one — a refused connection, or the daemon's reason for refusing
 * the upgrade, which a caller that cannot go on without the socket raises.
 */
export interface SocketEnd {
  code: number;
  error?: Error;
}

/** A held subscription to a session or a child plan (`followSession`, `followChild`). */
export interface SessionSocket {
  /** True when the socket opened; false when it could not — resolved either way, never rejected. */
  ready: Promise<boolean>;
  /** How the socket ended; null when `close` ended it. */
  ended: Promise<SocketEnd | null>;
  close(): void;
}

/** A checkpoint in a child plan, by the words it waits on: a raise or a force is the plan above's to give. */
export interface ChildCheckpointAnswer {
  answer: 'approve' | 'reject';
  question: string;
  reason?: string;
}

/** A non-200 answer as an error. The body is not trusted to be JSON: an HTML error page arrives as a string. */
function daemonError(status: number, data: unknown, fallback: string): DaemonError {
  const { error, code, workspace, plannerNotReady, sessionHeld, landingBranchHeld, confirmStale } = (typeof data === 'object' && data !== null ? data : {}) as Partial<ErrorBody>;
  if (code === 'workspace_not_a_project') return new WorkspaceInitNeededError(error || 'Not a project directory', workspace ?? '');
  return new DaemonError(error || fallback, status, code, plannerNotReady, sessionHeld, landingBranchHeld, confirmStale);
}

/** A read's target (ADR-0064), its workspace the client's own unless named. */
export type ReadQuery = Partial<ReadTarget>;

/** The reads that take a view scope's target (ADR-0064) as their query. */
type UserReadId = 'files.tree' | 'files.content' | 'files.find' | 'git.repos' | 'git.status' | 'git.diff' | 'git.log' | 'git.show' | 'git.branches' | 'plans.taskDiff';

/** The user's git and file actions, whose body opens with their target. */
type UserActionId = 'files.save' | 'git.stage' | 'git.unstage' | 'git.commit' | 'git.discard' | 'git.branch' | 'git.switch' | 'git.branchDelete' | 'git.stash' | 'git.stashPop' | 'git.stashDrop' | 'git.fetch' | 'git.pull' | 'git.push';

export class ApiClient {
  /** Where a CLI invocation's sessions live, when a client is built without one: `--workspace`, else the cwd. */
  static defaultWorkspace: string | undefined;

  private port: number;
  private workspace: string;
  /** A session's open execution stream, so a new one can end it: one run is reported once. */
  private executionStreams = new Map<string, () => void>();

  constructor(port?: number, workspace?: string) {
    this.port = port || DEFAULT_PORT;
    this.workspace = workspace ?? ApiClient.defaultWorkspace ?? process.cwd();
  }

  /**
   * Read at call time rather than at construction: a daemon restarted mid-run
   * mints a new token, and a client built before that restart must pick it up.
   * A missing file is not an error here — the daemon's own 401 names the path.
   */
  private token(): string | undefined {
    return readDaemonToken(this.port);
  }

  /**
   * A daemon holds only the sessions adopted since it started, so after a
   * restart every session-scoped call answered "session not found" until the
   * user ran `ordewell sessions load`. The saved session is adopted here
   * instead — idempotent for one the daemon still holds — and the call made
   * once more; a 404 means the first attempt never ran, so the retry cannot
   * act twice. An adoption refused because another host runs the session
   * (ADR-0049) is the answer the caller gets: its 404 would say to reload a
   * session that reloading cannot open.
   */
  private async send<Id extends DaemonRouteId>(id: Id, parts: CallParts<Id>): Promise<{ status: number; data: RouteResponse<Id> }> {
    const request = routeRequest(id, parts, this.workspace);
    const res = await this.rawRequest<RouteResponse<Id>>(request);
    const sessionId = sessionOf(id, parts.params);
    const missing = res.status === 404 && (res.data as Partial<ErrorBody> | undefined)?.code === 'session_not_found';
    if (!missing || !sessionId || id === 'sessions.load') return res;
    const adopted = await this.rawRequest(routeRequest('sessions.load', { params: { id: sessionId }, query: { workspace: this.workspace } }));
    if (adopted.status === 200) return this.rawRequest<RouteResponse<Id>>(request);
    return (adopted.data as Partial<ErrorBody> | undefined)?.code === 'session_held' ? adopted as typeof res : res;
  }

  /** One request whose only good answer is a 200: anything else becomes a {@link DaemonError} carrying the daemon's code. */
  private async call<Id extends DaemonRouteId>(id: Id, fallback: string, parts: CallParts<Id>): Promise<RouteResponse<Id>> {
    const res = await this.send(id, parts);
    if (res.status !== 200) throw daemonError(res.status, res.data, fallback);
    return res.data;
  }

  /**
   * A call to a planner-turn route, which answers when the turn ends. The
   * daemon sends nothing until then, and a turn that awaits exploration agents
   * routinely idles past any bound a short call would want, so the row's `turn`
   * flag leaves a socket-idle timeout off: one would report a turn that is
   * still running as failed. The user stops a turn with Stop, which is the
   * bound; `ORDEWELL_HTTP_TIMEOUT_MS` still applies when set.
   */
  private async planOf<Id extends DaemonRouteId>(id: Id, fallback: string, parts: CallParts<Id>): Promise<PlanResponse['plan']> {
    return planOf<PlanResponse>(await this.call(id, fallback, parts), DAEMON_ROUTES[id].path).plan;
  }

  private rawRequest<T = unknown>(
    { method, path: urlPath, body, turn }: RouteRequest,
  ): Promise<{ status: number; data: T }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, `http://127.0.0.1:${this.port}`);
      const configuredTimeout = Number.parseInt(process.env.ORDEWELL_HTTP_TIMEOUT_MS || '', 10);
      const hasConfiguredTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0;
      const token = this.token();
      // The env override is explicit, so it bounds a turn too; without it a
      // turn has no idle bound (see `turn`) and anything else gets the default.
      const idleBoundMs = hasConfiguredTimeout ? configuredTimeout : turn ? undefined : DEFAULT_HTTP_TIMEOUT_MS;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        agent: daemonAgent,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: bearerHeaderValue(token) } : {}),
        },
        ...(idleBoundMs !== undefined ? { timeout: idleBoundMs } : {}),
      };
      const req = http.request(options, (res) => {
        // Decoded once at the end: per-chunk decoding turns a character split
        // across two chunks into U+FFFD.
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
          } catch {
            // Non-JSON body (e.g. an HTML error page) — genuinely unknown shape.
            resolve({ status: res.statusCode || 0, data: data as T });
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new RequestTimeoutError(idleBoundMs, hasConfiguredTimeout));
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async generatePlan(
    goal: string,
    runners?: string[],
    workspace?: string,
    sessionId: string = mintSessionId(),
  ): Promise<PlanResult> {
    const route = DAEMON_ROUTES['plans.generate'].path;
    const { plan, models, modelsByRunner, notes } = planOf<GeneratePlanResponse>(await this.call('plans.generate', 'Plan generation failed', {
      params: { sessionId },
      body: { goal, runners: runners || undefined, workspace },
    }), route);
    return { sessionId, plan, models, modelsByRunner, ...(notes ? { notes } : {}) };
  }

  /**
   * Open the ADR-0002 planner dialogue. Unlike `generatePlan`, the returned plan
   * may be a question (empty `tasks`, last word in `conversationHistory`) rather
   * than a committed plan.
   */
  startConversation(
    sessionId: string,
    goal: string,
    runners?: string[],
    workspace?: string,
    allowInit?: boolean,
  ): Promise<PlanResponse['plan']> {
    return this.planOf('plans.converseStart', 'Planning failed', {
      params: { sessionId },
      body: { goal, runners: runners || undefined, workspace, allowInit },
    });
  }

  sendConversationMessage(sessionId: string, message: string): Promise<PlanResponse['plan']> {
    return this.planOf('plans.converseMessage', 'Planner message failed', { params: { sessionId }, body: { message } });
  }

  /** Send now (ADR-0023, F5): stop the planner turn in flight and answer `message` in the turn that replaces it. */
  forceSendPlannerMessage(sessionId: string, message: string): Promise<PlanResponse['plan']> {
    return this.planOf('plans.converseMessageNow', 'Send now failed', { params: { sessionId }, body: { message } });
  }

  getRunners(workspace?: string): Promise<RunnersResponse> {
    // The login verdict is asked about the account the planner will use, so a
    // daemon started elsewhere judges this workspace's `.envrc`, not its cwd's.
    return this.call('runners.list', 'Failed to fetch runners', { query: { workspace: workspace ?? this.workspace } });
  }

  /** The full provider catalog the daemon has discovered (used by the TUI model picker). */
  getModels(): Promise<ModelsResponse> {
    // Discovered under this workspace's environment, as its tasks are launched:
    // its CLAUDE_CONFIG_DIR picks the Claude account whose models are offered.
    return this.call('models.list', 'Failed to fetch models', { query: { workspace: this.workspace } });
  }

  setRunnerEnabled(runner: string, enabled: boolean): Promise<OkResponse> {
    return this.call('runners.setEnabled', `Failed to ${enabled ? 'enable' : 'disable'} ${runner}`, { params: { id: runner }, body: { enabled } });
  }

  executePlan(sessionId: string): Promise<ExecuteResponse> {
    return this.call('plans.execute', 'Execute failed', { params: { sessionId } });
  }

  /**
   * Sign off a plan waiting on `review_needed` and let it continue.
   *
   * Deliberately not `executePlan`: that resets the run (`clearLog` +
   * `resetForRun`) before approving, which is right for starting a plan and
   * wrong for releasing one that is already part-way through a review pause.
   */
  approveReview(sessionId: string): Promise<ApproveReviewResponse> {
    return this.call('plans.approveReview', 'Approve failed', { params: { sessionId } });
  }

  /**
   * One execution control as the user (ADR-0029): any command at the seam, by
   * the task reference the user typed. The answer is the seam's line and its
   * payload; a refusal is a {@link DaemonError} worded as the seam worded it.
   * Execute, Stop, review approval, checkpoint answers and Merge all keep their
   * own methods, since their routes answer more than the seam does.
   */
  execute(sessionId: string, command: ExecutionCommand): Promise<ExecuteCommandResponse> {
    return this.call('plans.executeCommand', 'Command failed', { params: { sessionId }, body: command });
  }

  /** What waits on a person now (ADR-0053). */
  async escalations(sessionId: string): Promise<EscalationsResponse['escalations']> {
    const res = await this.call('plans.escalations', 'Could not read what waits on you', { params: { sessionId } });
    return res.escalations;
  }

  /** Answer an escalation by its id; a stale one is a {@link DaemonError} saying so. `confirmed` is the user's yes to the option's `confirm`. */
  answerEscalation(sessionId: string, answer: AnswerEscalationRequest): Promise<ExecuteCommandResponse> {
    return this.call('plans.answerEscalation', 'Could not answer', { params: { sessionId }, body: answer });
  }

  /** Keep what waits on the planner's usage limit from being sent at the reset; `cancelled` is false when nothing waited. */
  cancelPlannerResend(sessionId: string): Promise<CancelResumeResponse> {
    return this.call('plans.cancelResend', 'Cancel resend failed', { params: { sessionId } });
  }

  /** Run the task runner's own command `/name args` as a turn of its own (#66). */
  invokeTaskCommand(sessionId: string, taskId: string, name: string, args: string): Promise<TaskMessageResponse> {
    return this.call('plans.taskCommands', 'Command failed', { params: { sessionId, taskId }, body: { name, args } });
  }

  /** Let a task go on from the checkpoint it waits at, a delegated task's child with an answer's words and a raise; refused, with the reason, when none waits. */
  approveTaskCheckpoint(sessionId: string, taskId: string, child: { reason?: string; raiseTokens?: number } = {}): Promise<OkResponse> {
    return this.call('plans.checkpointApprove', 'Approve checkpoint failed', { params: { sessionId, taskId }, body: Object.keys(child).length > 0 ? child : undefined });
  }

  /** Turn a task back at its checkpoint; `reason` is what the agent is told. */
  rejectTaskCheckpoint(sessionId: string, taskId: string, reason?: string): Promise<OkResponse> {
    return this.call('plans.checkpointReject', 'Reject checkpoint failed', { params: { sessionId, taskId }, body: reason ? { reason } : {} });
  }

  addTask(sessionId: string, task: Partial<Task>): Promise<OkResponse> {
    return this.call('plans.addTask', 'Add task failed', { params: { sessionId }, body: task });
  }

  updateTask(sessionId: string, taskId: string, changes: Partial<Task>): Promise<OkResponse> {
    return this.call('plans.updateTask', 'Update task failed', { params: { sessionId, taskId }, body: changes });
  }

  removeTask(sessionId: string, taskId: string): Promise<OkResponse> {
    return this.call('plans.deleteTask', 'Remove task failed', { params: { sessionId, taskId } });
  }

  /**
   * Make a saved session live on the server. `getSession` only reads the file;
   * until the session is adopted there is no orchestrator behind it, so
   * execute/retry/cancel answer `session_not_found`.
   */
  async adoptSession(sessionId: string, workspace?: string): Promise<Pick<AdoptSessionResponse, 'plan' | 'goal' | 'run' | 'plannerTurnId' | 'plannerCompaction' | 'position'>> {
    const res = await this.call('sessions.load', 'Failed to load session', { params: { id: sessionId }, query: { workspace: workspace || undefined } });
    return {
      plan: res.plan,
      goal: res.goal ?? '',
      ...(res.run ? { run: res.run } : {}),
      ...(res.plannerTurnId ? { plannerTurnId: res.plannerTurnId } : {}),
      ...(res.plannerCompaction ? { plannerCompaction: res.plannerCompaction } : {}),
      ...(res.position ? { position: res.position } : {}),
    };
  }

  deleteSession(sessionId: string, workspace?: string): Promise<OkResponse> {
    return this.call('sessions.delete', 'Delete session failed', { params: { id: sessionId }, query: { workspace: workspace || undefined } });
  }

  /** Copy the conversation and its tasks into a new session the daemon has already adopted. */
  forkConversation(sessionId: string): Promise<ConversationForkResponse> {
    return this.call('plans.fork', 'Fork failed', { params: { sessionId } });
  }

  async rewindTargets(sessionId: string): Promise<RewindTarget[]> {
    const res = await this.call('plans.rewindTargets', 'Failed to list rewind targets', { params: { sessionId } });
    return res.targets;
  }

  /**
   * Fork the conversation from just before the user message at `index` (a
   * transcript position) into a session the daemon has already adopted. The
   * original is left as it was; `rewoundMessage` is that message in full.
   */
  rewindConversation(sessionId: string, index: number): Promise<ConversationRewindResponse> {
    return this.call('plans.rewind', 'Rewind failed', { params: { sessionId }, body: { index } });
  }

  /**
   * Condense the conversation into a summary. One planner call, so it can take
   * as long as a reply; a refusal or failure leaves the conversation as it was.
   */
  compactConversation(sessionId: string): Promise<ConversationCompactResponse> {
    return this.call('plans.compact', 'Compaction failed', { params: { sessionId } });
  }

  /**
   * Retry compaction of a planner paused on its context: the paused turn
   * opens again, so this takes as long as a reply. The plan answered carries
   * the pause again when the retry paused too.
   */
  retryPlannerCompaction(sessionId: string): Promise<PlanResponse['plan']> {
    return this.planOf('plans.retryCompact', 'Retry compaction failed', { params: { sessionId } });
  }

  /** The ancestors a task waits on at its merge gate (ADR-0020); empty when nothing gates it. */
  async getMergeGate(sessionId: string, taskId: string): Promise<MergeGateEntry[]> {
    const res = await this.call('plans.mergeGate', 'Could not read the merge gate', { params: { sessionId, taskId } });
    return res.mergeGate ?? [];
  }

  /** What reverting a task would do now (ADR-0054), which the user confirms before `execute` sends `revert_task`. */
  revertPreview(sessionId: string, taskId: string): Promise<TaskRevertPreviewResponse> {
    return this.call('plans.revertPreview', 'Could not read what the revert would take', { params: { sessionId, taskId } });
  }

  async reviewRunDiff(sessionId: string): Promise<string> {
    const res = await this.call('plans.isolationDiff', 'Could not read the diff', { params: { sessionId } });
    return res.diff;
  }

  /** A directory of one view scope (ADR-0064), `dir` `''` for its root. */
  getFileTree(target: ReadQuery, dir = ''): Promise<FileTreeResponse> {
    return this.read('files.tree', target, { dir }, 'Could not read the folder');
  }

  getFileContent(target: ReadQuery, path: string): Promise<FileContentResponse> {
    return this.read('files.content', target, { path }, 'Could not read the file');
  }

  /** Paths whose name holds `query`, or with `text` lines that do; `truncated` once the cap is hit. */
  findFiles(target: ReadQuery, options: { query: string; text?: boolean; limit?: number }): Promise<FileFindResponse> {
    return this.read('files.find', target, { query: options.query, text: options.text ? '1' : undefined, limit: options.limit?.toString() }, 'Could not search the files');
  }

  getGitRepos(workspace?: string): Promise<GitReposResponse> {
    return this.read('git.repos', { workspace }, {}, 'Could not read the repositories');
  }

  getGitStatus(target: ReadQuery): Promise<GitStatusResponse> {
    return this.read('git.status', target, {}, 'Could not read the status');
  }

  getGitDiff(target: ReadQuery, options: { kind?: 'staged' | 'unstaged'; from?: string; to?: string; path?: string } = {}): Promise<GitDiffResponse> {
    return this.read('git.diff', target, options, 'Could not read the diff');
  }

  /** One page of history; pass back the page's `cursor` for the next. */
  getGitLog(target: ReadQuery, options: { ref?: string; cursor?: string; limit?: number } = {}): Promise<GitLogResponse> {
    return this.read('git.log', target, { ref: options.ref, cursor: options.cursor, limit: options.limit?.toString() }, 'Could not read the history');
  }

  getGitCommit(target: ReadQuery, sha: string, path?: string): Promise<GitCommitResponse> {
    return this.read('git.show', target, { sha, path }, 'Could not read the commit');
  }

  getGitBranches(target: ReadQuery): Promise<GitBranchesResponse> {
    return this.read('git.branches', target, {}, 'Could not read the branches');
  }

  /** One task's diff from its saved run: the changed names with `names`, one file's patch with `path`. */
  getTaskDiff(sessionId: string, taskId: string, options: { workspace?: string; repo?: string; path?: string; names?: boolean } = {}): Promise<TaskDiffResponse> {
    const { workspace, repo, path, names } = options;
    return this.read('plans.taskDiff', { workspace, repo }, { path, names: names ? '1' : undefined }, 'Could not read the task\'s diff', { sessionId, taskId });
  }

  /** Saves a file read at `baseHash` (ADR-0062 G10); a file changed since answers `stale`. */
  saveFile(target: UserGitTarget, file: Omit<FileSaveRequest, keyof UserGitTarget>): Promise<GitActionResponse> {
    return this.act('files.save', target, file, 'Could not save the file');
  }

  gitStage(target: UserGitTarget, changes: Omit<GitChangesRequest, keyof UserGitTarget>): Promise<GitActionResponse> {
    return this.act('git.stage', target, changes, 'Could not stage');
  }

  gitUnstage(target: UserGitTarget, changes: Omit<GitChangesRequest, keyof UserGitTarget>): Promise<GitActionResponse> {
    return this.act('git.unstage', target, changes, 'Could not unstage');
  }

  gitCommit(target: UserGitTarget, commit: Omit<GitCommitRequest, keyof UserGitTarget>): Promise<GitActionResponse> {
    return this.act('git.commit', target, commit, 'Could not commit');
  }

  gitDiscard(target: UserGitTarget, discard: Omit<GitDiscardRequest, keyof UserGitTarget>): Promise<GitActionResponse> {
    return this.act('git.discard', target, discard, 'Could not discard');
  }

  gitCreateBranch(target: UserGitTarget, branch: Omit<GitBranchCreateRequest, keyof UserGitTarget>): Promise<GitActionResponse> {
    return this.act('git.branch', target, branch, 'Could not create the branch');
  }

  /** Refused with `landing_branch_held` while a live run lands on the branch checked out now (ADR-0062 G7). */
  gitSwitch(target: UserGitTarget, branch: string): Promise<GitActionResponse> {
    return this.act('git.switch', target, { branch }, 'Could not switch branch');
  }

  gitDeleteBranch(target: UserGitTarget, branch: string, confirm: GitBranchDeleteRequest['confirm']): Promise<GitActionResponse> {
    return this.act('git.branchDelete', target, { branch, confirm }, 'Could not delete the branch');
  }

  /** The answer's `stash` names the stash made, by the sha `gitStashPop` and `gitStashDrop` take. */
  gitStash(target: UserGitTarget, stash: Omit<GitStashRequest, keyof UserGitTarget> = {}): Promise<GitActionResponse> {
    return this.act('git.stash', target, stash, 'Could not stash');
  }

  gitStashPop(target: UserGitTarget, stash: string): Promise<GitActionResponse> {
    return this.act('git.stashPop', target, { stash }, 'Could not apply the stash');
  }

  gitStashDrop(target: UserGitTarget, stash: string): Promise<GitActionResponse> {
    return this.act('git.stashDrop', target, { stash }, 'Could not drop the stash');
  }

  gitFetch(target: UserGitTarget): Promise<GitActionResponse> {
    return this.act('git.fetch', target, {}, 'Could not fetch');
  }

  /** `confirm` is the tracking remote and branch the person was shown. */
  gitPull(target: UserGitTarget, confirm: GitRemoteRequest['confirm']): Promise<GitActionResponse> {
    return this.act('git.pull', target, { confirm }, 'Could not pull');
  }

  gitPush(target: UserGitTarget, confirm: GitRemoteRequest['confirm']): Promise<GitActionResponse> {
    return this.act('git.push', target, { confirm }, 'Could not push');
  }

  /** Per repository, the user's uncommitted files Merge all would collide with (ADR-0062 G8). */
  mergePreflight(sessionId: string, workspace?: string): Promise<MergePreflightResponse> {
    return this.call('plans.mergePreflight', 'Could not read the run', { params: { sessionId }, query: { workspace: workspace ?? this.workspace } });
  }

  /** A user git action's body: its target first, its workspace the client's own unless named, then the action's own fields. */
  private act<Id extends UserActionId>(id: Id, target: UserGitTarget, fields: object, fallback: string): Promise<GitActionResponse> {
    const scope = { workspace: target.workspace ?? this.workspace, ...(target.repo !== undefined ? { repo: target.repo } : {}) };
    // The callers' own field types are the row's body less the target, which
    // the compiler cannot see through `Omit` on a generic id.
    const parts = { body: { ...scope, ...fields } } as unknown as CallParts<Id>;
    return this.call(id, fallback, parts);
  }

  /**
   * A user read's query: the target first, as every read route takes it, then
   * the route's own parameters. `params` fills the path of a read that names a
   * session or a task.
   */
  private read<Id extends UserReadId>(
    id: Id,
    target: ReadQuery,
    extra: Partial<Record<Exclude<QueryKeys<Id>, keyof ReadTarget>, string | undefined>>,
    fallback: string,
    params?: Record<string, string>,
  ): Promise<RouteResponse<Id>> {
    const query = { workspace: target.workspace ?? this.workspace, repo: target.repo, scope: target.scope, sessionId: target.sessionId, taskId: target.taskId, ...extra };
    return this.call(id, fallback, { ...(params ? { params } : {}), query } as unknown as CallParts<Id>);
  }

  /**
   * A conflict or a block is an outcome, not an error. Passed on whole: which
   * repos blocked the merge, or landed before it stopped, is the answer.
   */
  mergeRun(sessionId: string, options: { pastChecks?: true; besideOps?: true } = {}): Promise<MergeRunResult> {
    return this.call('plans.isolationMerge', 'Merge failed', { params: { sessionId }, body: options.pastChecks || options.besideOps ? options : undefined });
  }

  discardRun(sessionId: string): Promise<void> {
    return this.isolationAction('plans.isolationDiscard', sessionId, 'Discard failed');
  }

  cleanupRun(sessionId: string): Promise<void> {
    return this.isolationAction('plans.isolationCleanup', sessionId, 'Cleanup failed');
  }

  continueWithStash(sessionId: string): Promise<void> {
    return this.isolationAction('plans.isolationStash', sessionId, 'Could not stash and continue');
  }

  continueWithoutIsolation(sessionId: string): Promise<void> {
    return this.isolationAction('plans.isolationRunWithout', sessionId, 'Could not continue without isolation');
  }

  private async isolationAction(id: 'plans.isolationDiscard' | 'plans.isolationCleanup' | 'plans.isolationStash' | 'plans.isolationRunWithout', sessionId: string, failure: string): Promise<void> {
    await this.call(id, failure, { params: { sessionId } });
  }

  async resolveConflictAsTask(sessionId: string, taskId: string): Promise<ResolveConflictResponse['plan']> {
    const res = await this.call('plans.resolveConflict', 'Could not add a resolver task', { params: { sessionId, taskId } });
    return res.plan;
  }

  closeSession(sessionId: string): Promise<OkResponse> {
    return this.call('sessions.close', 'Close session failed', { params: { id: sessionId }, query: { workspace: this.workspace } });
  }

  stopExecution(sessionId: string): Promise<StopResponse> {
    return this.call('plans.stop', 'Stop failed', { params: { sessionId } });
  }

  /** Aborts a planning turn in flight. A harmless no-op when the session isn't planning. */
  cancelPlanning(sessionId: string): Promise<CancelPlanningResponse> {
    return this.call('plans.stopPlanning', 'Cancel planning failed', { params: { sessionId } });
  }

  /**
   * The repositories and branches the daemon would isolate for `workspace`,
   * read without starting a run or touching any repository. Never rejects for
   * a repository that cannot be read: the daemon answers a `failed` preview.
   */
  getIsolationPreview(workspace?: string): Promise<IsolationPreviewResponse> {
    return this.call('workspaces.isolationPreview', 'Failed to read the repositories', { query: { workspace: workspace || undefined } });
  }

  getSessions(workspace?: string): Promise<SessionListResponse> {
    return this.call('sessions.list', 'Failed to list sessions', { query: { workspace: workspace || undefined } });
  }

  getSession(sessionId: string, workspace?: string): Promise<SessionResponse> {
    return this.call('sessions.get', 'Session not found', { params: { id: sessionId }, query: { workspace: workspace || undefined } });
  }

  /** The attempts of a structured task that have a saved log, oldest first. */
  getTaskLogAttempts(sessionId: string, taskId: string, workspace?: string): Promise<TaskLogAttemptsResponse> {
    return this.call('sessions.taskLog', 'Could not read the task log', { params: { id: sessionId, taskId }, query: { workspace: workspace || undefined } });
  }

  /** One attempt's saved log, for `replayTaskLog`. */
  getTaskLog(sessionId: string, taskId: string, attempt: number, workspace?: string): Promise<TaskLogResponse> {
    return this.call('sessions.taskLogAttempt', 'Could not read the task log', { params: { id: sessionId, taskId, attempt: String(attempt) }, query: { workspace: workspace || undefined } });
  }


  /**
   * The one place a socket is built, so the token travels on every stream
   * path. It rides as a subprotocol rather than a query parameter, so it never
   * reaches an access log.
   */
  private openSocket(socketPath: string): WebSocket {
    const token = this.token();
    const socket = new WebSocket(
      `ws://127.0.0.1:${this.port}${socketPath}`,
      token ? tokenSubprotocols(token) : undefined,
    );

    // Left to itself `ws` reports a refused upgrade as "Unexpected server
    // response: 401", discarding the body — which is where the daemon names the
    // token file. Read it and raise that instead, keeping ws's own error-then-
    // close ordering so callers see no change in shape.
    socket.on('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let reason = '';
        try {
          reason = (JSON.parse(body) as Partial<ErrorBody>).error ?? '';
        } catch {
          reason = body.trim();
        }
        socket.emit('error', new Error(reason || `Unexpected server response: ${res.statusCode}`));
        socket.emit('close', res.statusCode ?? 1006, Buffer.from(''));
      });
    });

    return socket;
  }

  listChildren(rootId: string): Promise<ChildListResponse> {
    return this.call('children.list', 'Could not list the child plans', { params: { id: rootId } });
  }

  getChild(rootId: string, childId: string): Promise<ChildPlanResponse> {
    return this.call('children.get', 'Could not read the child plan', { params: { id: rootId, childId } });
  }

  getChildTaskLogAttempts(rootId: string, childId: string, taskId: string): Promise<TaskLogAttemptsResponse> {
    return this.call('children.taskLog', 'Could not read the task log', { params: { id: rootId, childId, taskId } });
  }

  getChildTaskLog(rootId: string, childId: string, taskId: string, attempt: number): Promise<TaskLogResponse> {
    return this.call('children.taskLogAttempt', 'Could not read the task log', { params: { id: rootId, childId, taskId, attempt: String(attempt) } });
  }

  /** To the child's subplanner, as a turn of its conversation (ADR-0055 D20). */
  messageChild(rootId: string, childId: string, message: string): Promise<ChildMessageResponse> {
    return this.call('children.message', 'Could not message the child plan', { params: { id: rootId, childId }, body: { message } });
  }

  messageChildTask(rootId: string, childId: string, taskId: string, message: string): Promise<ChildTaskControlResponse> {
    return this.call('children.taskMessage', 'Could not message the task', { params: { id: rootId, childId, taskId }, body: { message } });
  }

  answerChildCheckpoint(rootId: string, childId: string, taskId: string, { answer, question, reason }: ChildCheckpointAnswer): Promise<ChildTaskControlResponse> {
    return this.call(answer === 'approve' ? 'children.checkpointApprove' : 'children.checkpointReject', 'Could not answer the checkpoint', {
      params: { id: rootId, childId, taskId },
      body: { question, ...(reason ? { reason } : {}) },
    });
  }

  /**
   * Every socket this client holds, one way: each frame parsed and handed on
   * until the holder closes it, and none after — `close()` only starts the
   * handshake, and frames already on the wire are still emitted.
   */
  private listen(socketPath: string, onEvent: (event: WsEvent) => void): SessionSocket {
    const socket = this.openSocket(socketPath);
    let closing = false;
    let error: Error | undefined;
    const ready = new Promise<boolean>((resolve) => {
      socket.once('open', () => resolve(true));
      socket.once('error', () => resolve(false));
      socket.once('close', () => resolve(false));
    });
    const ended = new Promise<SocketEnd | null>((resolve) => {
      socket.once('close', (code: number) => resolve(closing ? null : { code, ...(error ? { error } : {}) }));
    });
    socket.on('message', (data: Buffer) => {
      if (closing) return;
      try {
        onEvent(JSON.parse(data.toString()));
      } catch {
        // ignore malformed messages
      }
    });
    // Reported through `ended`, which the close that follows settles.
    socket.on('error', (err: Error) => { error = err; });
    return {
      ready,
      ended,
      close: () => {
        closing = true;
        socket.close();
      },
    };
  }

  /**
   * One child plan's own stream, through the root that holds it. Its close code
   * is what a surface acts on: the daemon closes 1012 for a replaced root, which
   * a reconnect recovers, and 4404 for an unknown child, which it may not.
   */
  followChild(rootId: string, childId: string, onEvent: (event: WsEvent) => void): SessionSocket {
    return this.listen(socketPath(rootId, childId, this.workspace), onEvent);
  }

  /**
   * One run's progress, for a caller that holds no other socket on the
   * session: it ends with the run's completion frame, or with a second stream
   * on the same session, so one run is reported once.
   */
  streamExecution(
    sessionId: string,
    onEvent: (event: WsEvent) => void,
    onReady?: (error?: Error) => void,
  ): Promise<'lost' | void> {
    this.executionStreams.get(sessionId)?.();
    return new Promise<'lost' | void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      const forget = () => { if (this.executionStreams.get(sessionId) === end) this.executionStreams.delete(sessionId); };
      const end = () => {
        forget();
        if (settled) return;
        settled = true;
        socket.close();
        resolve();
      };
      const socket = this.listen(socketPath(sessionId, undefined, this.workspace), (event) => {
        onEvent(event);
        if (event.type === 'execution_complete' || event.type === 'execution_stopped') end();
      });
      this.executionStreams.set(sessionId, end);
      void socket.ready.then((open) => {
        opened = open;
        if (open) onReady?.();
      });
      void socket.ended.then((ending) => {
        forget();
        if (settled || ending === null) return;
        settled = true;
        if (!opened && ending.error) {
          onReady?.(ending.error);
          reject(ending.error);
          return;
        }
        if (!opened) onReady?.(new Error('Execution stream closed before connecting'));
        // Neither a completion event nor a caller ended this: the daemon went
        // away, and the run may still be going, so the caller reports it lost.
        resolve('lost');
      });
    });
  }

  /**
   * Every broadcast of one session for as long as the caller holds it. Unlike
   * `streamExecution`, a run's end does not end it: the next run may be one
   * nobody on this surface asked for — autorun, the planner's `run_plan`, the
   * supervisor — and the daemon tells only the sockets already subscribed.
   * `ready` settles on a failure too, never rejects: a follow that cannot
   * connect costs the live view, not the request it opened around.
   */
  followSession(sessionId: string, onEvent: (event: WsEvent) => void): SessionSocket {
    return this.listen(socketPath(sessionId, undefined, this.workspace), onEvent);
  }

  /**
   * Answer an approval prompt: the planner's with a yes/no, a task runner's
   * with the whole decision (ADR-0018, A1). The planner's requests arrive over
   * the session socket; a runner's, in its task log.
   */
  async respondToApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer): Promise<OkResponse> {
    const { status, data } = await this.send('approvals.decide', {
      params: { sessionId, approvalId },
      body: typeof answer === 'boolean' ? { granted: answer } : answer,
    });
    if (status !== 200) throw daemonError(status, data, `Failed to answer approval ${approvalId} (HTTP ${status})`);
    return data;
  }

  /**
   * Subscribe to a session's WS stream during planning (issue #34 UX): fire
   * and forget, since the awaited plan-generation REST call is the actual
   * completion signal, not a terminal WS message like execution has.
   */
  streamPlanning(sessionId: string, onEvent: (event: WsEvent) => void): { ready: Promise<void>; close: () => void } {
    // The daemon broadcasts a turn's start the moment the REST call reaches
    // it, so the caller waits for the subscription first. It settles on a
    // failure too, never rejects: a broken socket costs the progress display,
    // not the turn.
    const { ready, close } = this.listen(socketPath(sessionId, undefined, this.workspace), onEvent);
    return { ready: ready.then(() => {}), close };
  }

  // Every settings call names this workspace, as `getModels` does: the
  // planner's model is judged against its runner catalog, which its own
  // CLAUDE_CONFIG_DIR can make another account's than the daemon's cwd.
  getSettings(sessionId?: string): Promise<SettingsResponse> {
    return this.call('settings.get', 'Failed to fetch settings', { query: { sessionId, workspace: this.workspace } });
  }

  /** Save run settings (ADR-0030); with `sessionId`, that session's run takes them at once. */
  updateRunSettings(changes: Partial<GlobalRunSettings>, sessionId?: string): Promise<SettingsResponse> {
    return this.call('settings.update', 'Change run settings failed', { body: { run: changes, ...(sessionId ? { sessionId } : {}), workspace: this.workspace } });
  }

  /** Where the `containers` setting stands; `prove` has the daemon start a throwaway container to measure. */
  getContainers(prove = false): Promise<ContainerStatus> {
    return this.call('settings.containers', 'Failed to read containers', { query: { prove: prove ? '1' : undefined, workspace: this.workspace } });
  }

  changeContainers(change: ContainerChange): Promise<ContainerChangeResponse> {
    return this.call('settings.updateContainers', 'Failed to change containers', { body: { ...change, workspace: this.workspace } });
  }

  updateSettings(changes: Record<string, unknown>): Promise<SettingsUpdateResponse> {
    return this.call('settings.update', 'Failed to update settings', { body: { ...changes, workspace: this.workspace } });
  }
}

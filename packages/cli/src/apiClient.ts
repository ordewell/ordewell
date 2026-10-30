import http from 'http';
import WebSocket from 'ws';
import { DEFAULT_PORT, isConnectionRefused } from './daemon';
import { bearerHeaderValue, readDaemonToken, tokenSubprotocols, mintSessionId } from '@ordewell/core';
import type {
  AdoptSessionResponse,
  ApprovalAnswer,
  ApproveReviewResponse,
  CancelPlanningResponse,
  CancelResumeResponse,
  ConversationCompactResponse,
  ConversationForkResponse,
  ConversationRewindResponse,
  DaemonErrorCode,
  ErrorBody,
  AnswerEscalationRequest,
  EscalationsResponse,
  ExecuteCommandResponse,
  ExecuteResponse,
  ExecutionCommand,
  GeneratePlanResponse,
  IsolationDiffResponse,
  IsolationMergeResponse,
  IsolationPreviewResponse,
  MergeGateEntry,
  MergeGateResponse,
  ModelsResponse,
  OkResponse,
  GlobalRunSettings,
  PlanResponse,
  PlannerNotReady,
  SurfacePlan,
  SurfacePlanState,
  ResolveConflictResponse,
  RewindTarget,
  RewindTargetsResponse,
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
export type WsEvent = SessionFrame | RunSnapshotFrame | AccountLimitsFrame;

/** A held subscription to a session (`followSession`). `ended` is `'lost'` unless `close` ended it. */
export interface SessionFollow {
  /** True when the socket opened; false when it could not — resolved either way, never rejected. */
  ready: Promise<boolean>;
  ended: Promise<'lost' | void>;
  close(): void;
}

/** `/api/plans/<id>/…` and `/api/sessions/<id>/…`: the session a request is about. */
const SESSION_PATH = /^\/api\/(?:plans|sessions)\/([^/?]+)/;

/** A non-200 answer as an error. The body is not trusted to be JSON: an HTML error page arrives as a string. */
function daemonError(status: number, data: unknown, fallback: string): DaemonError {
  const { error, code, workspace, plannerNotReady, sessionHeld } = (typeof data === 'object' && data !== null ? data : {}) as Partial<ErrorBody>;
  if (code === 'workspace_not_a_project') return new WorkspaceInitNeededError(error || 'Not a project directory', workspace ?? '');
  return new DaemonError(error || fallback, status, code, plannerNotReady, sessionHeld);
}

export class ApiClient {
  /** Where a CLI invocation's sessions live, when a client is built without one: `--workspace`, else the cwd. */
  static defaultWorkspace: string | undefined;

  private port: number;
  private workspace: string;
  /** A session's open execution stream, so a new one can end it: one run is reported once. */
  private executionStreams = new Map<string, () => void>();
  private executionStreamEnds = new WeakMap<Promise<'lost' | void>, () => void>();

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
  private async httpRequest<T = unknown>(
    method: string,
    urlPath: string,
    body?: object,
    turn = false,
  ): Promise<{ status: number; data: T }> {
    const res = await this.rawRequest<T>(method, urlPath, body, turn);
    const sessionId = urlPath.match(SESSION_PATH)?.[1];
    const missing = res.status === 404 && (res.data as Partial<ErrorBody> | undefined)?.code === 'session_not_found';
    if (!missing || !sessionId || urlPath.split('?')[0].endsWith('/load')) return res;
    const adopted = await this.rawRequest<T>('POST', `/api/sessions/${sessionId}/load?workspace=${encodeURIComponent(this.workspace)}`);
    if (adopted.status === 200) return this.rawRequest<T>(method, urlPath, body, turn);
    return (adopted.data as Partial<ErrorBody> | undefined)?.code === 'session_held' ? adopted : res;
  }

  /** One request whose only good answer is a 200: anything else becomes a {@link DaemonError} carrying the daemon's code. */
  private async call<T>(method: string, urlPath: string, fallback: string, body?: object, turn = false): Promise<T> {
    const res = await this.httpRequest<T>(method, urlPath, body, turn);
    if (res.status !== 200) throw daemonError(res.status, res.data, fallback);
    return res.data;
  }

  /**
   * A call that answers when a planner turn ends. The daemon sends nothing until
   * then, and a turn that awaits exploration agents routinely idles past any
   * bound a short call would want, so a socket-idle timeout here reports a turn
   * that is still running as failed. The user stops a turn with Stop, which is
   * the bound; `ORDEWELL_HTTP_TIMEOUT_MS` still applies when set.
   */
  private turn<T>(method: string, urlPath: string, fallback: string, body?: object): Promise<T> {
    return this.call<T>(method, urlPath, fallback, body, true);
  }

  private rawRequest<T = unknown>(
    method: string,
    urlPath: string,
    body?: object,
    turn = false,
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
    const route = `/api/plans/${sessionId}/generate`;
    const { plan, models, modelsByRunner, notes } = planOf<GeneratePlanResponse>(await this.turn('POST', route, 'Plan generation failed', {
      goal,
      runners: runners || undefined,
      workspace,
    }), route);
    return { sessionId, plan, models, modelsByRunner, ...(notes ? { notes } : {}) };
  }

  /**
   * Open the ADR-0002 planner dialogue. Unlike `generatePlan`, the returned plan
   * may be a question (empty `tasks`, last word in `conversationHistory`) rather
   * than a committed plan.
   */
  async startConversation(
    sessionId: string,
    goal: string,
    runners?: string[],
    workspace?: string,
    allowInit?: boolean,
  ): Promise<PlanResponse['plan']> {
    const route = `/api/plans/${sessionId}/converse/start`;
    return planOf<PlanResponse>(await this.turn('POST', route, 'Planning failed', {
      goal,
      runners: runners || undefined,
      workspace,
      allowInit,
    }), route).plan;
  }

  async sendConversationMessage(sessionId: string, message: string): Promise<PlanResponse['plan']> {
    const route = `/api/plans/${sessionId}/converse/message`;
    return planOf<PlanResponse>(await this.turn('POST', route, 'Planner message failed', { message }), route).plan;
  }

  /** Send now (ADR-0023, F5): stop the planner turn in flight and answer `message` in the turn that replaces it. */
  async forceSendPlannerMessage(sessionId: string, message: string): Promise<PlanResponse['plan']> {
    const route = `/api/plans/${sessionId}/converse/message/now`;
    return planOf<PlanResponse>(await this.turn('POST', route, 'Send now failed', { message }), route).plan;
  }

  getRunners(workspace?: string): Promise<RunnersResponse> {
    // The login verdict is asked about the account the planner will use, so a
    // daemon started elsewhere judges this workspace's `.envrc`, not its cwd's.
    const qs = `?workspace=${encodeURIComponent(workspace ?? this.workspace)}`;
    return this.call('GET', `/api/runners${qs}`, 'Failed to fetch runners');
  }

  /** The full provider catalog the daemon has discovered (used by the TUI model picker). */
  getModels(): Promise<ModelsResponse> {
    // Discovered under this workspace's environment, as its tasks are launched:
    // its CLAUDE_CONFIG_DIR picks the Claude account whose models are offered.
    return this.call('GET', `/api/models?workspace=${encodeURIComponent(this.workspace)}`, 'Failed to fetch models');
  }

  setRunnerEnabled(runner: string, enabled: boolean): Promise<OkResponse> {
    return this.call('PUT', `/api/runners/${runner}`, `Failed to ${enabled ? 'enable' : 'disable'} ${runner}`, { enabled });
  }

  executePlan(sessionId: string): Promise<ExecuteResponse> {
    return this.call('POST', `/api/plans/${sessionId}/execute`, 'Execute failed');
  }

  /**
   * Sign off a plan waiting on `review_needed` and let it continue.
   *
   * Deliberately not `executePlan`: that resets the run (`clearLog` +
   * `resetForRun`) before approving, which is right for starting a plan and
   * wrong for releasing one that is already part-way through a review pause.
   */
  approveReview(sessionId: string): Promise<ApproveReviewResponse> {
    return this.call('POST', `/api/plans/${sessionId}/review/approve`, 'Approve failed');
  }

  /**
   * One execution control as the user (ADR-0029): any command at the seam, by
   * the task reference the user typed. The answer is the seam's line and its
   * payload; a refusal is a {@link DaemonError} worded as the seam worded it.
   * Execute, Stop, review approval, checkpoint answers and Merge all keep their
   * own methods, since their routes answer more than the seam does.
   */
  execute(sessionId: string, command: ExecutionCommand): Promise<ExecuteCommandResponse> {
    return this.call('POST', `/api/plans/${sessionId}/execute-command`, 'Command failed', command);
  }

  /** What waits on a person now (ADR-0053). */
  async escalations(sessionId: string): Promise<EscalationsResponse['escalations']> {
    const res = await this.call<EscalationsResponse>('GET', `/api/plans/${sessionId}/escalations`, 'Could not read what waits on you');
    return res.escalations;
  }

  /** Answer an escalation by its id; a stale one is a {@link DaemonError} saying so. `confirmed` is the user's yes to the option's `confirm`. */
  answerEscalation(sessionId: string, answer: AnswerEscalationRequest): Promise<ExecuteCommandResponse> {
    return this.call('POST', `/api/plans/${sessionId}/escalations/answer`, 'Could not answer', answer);
  }

  /** Keep what waits on the planner's usage limit from being sent at the reset; `cancelled` is false when nothing waited. */
  cancelPlannerResend(sessionId: string): Promise<CancelResumeResponse> {
    return this.call('POST', `/api/plans/${sessionId}/converse/resend/cancel`, 'Cancel resend failed');
  }

  /** Run the task runner's own command `/name args` as a turn of its own (#66). */
  invokeTaskCommand(sessionId: string, taskId: string, name: string, args: string): Promise<TaskMessageResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${encodeURIComponent(taskId)}/commands`, 'Command failed', { name, args });
  }

  /** Let a task go on from the checkpoint it waits at; refused, with the reason, when none waits. */
  approveTaskCheckpoint(sessionId: string, taskId: string): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${encodeURIComponent(taskId)}/checkpoint/approve`, 'Approve checkpoint failed');
  }

  /** Turn a task back at its checkpoint; `reason` is what the agent is told. */
  rejectTaskCheckpoint(sessionId: string, taskId: string, reason?: string): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${encodeURIComponent(taskId)}/checkpoint/reject`, 'Reject checkpoint failed', reason ? { reason } : {});
  }

  addTask(sessionId: string, task: Record<string, unknown>): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks`, 'Add task failed', task);
  }

  updateTask(sessionId: string, taskId: string, changes: Record<string, unknown>): Promise<OkResponse> {
    return this.call('PUT', `/api/plans/${sessionId}/tasks/${encodeURIComponent(taskId)}`, 'Update task failed', changes);
  }

  removeTask(sessionId: string, taskId: string): Promise<OkResponse> {
    return this.call('DELETE', `/api/plans/${sessionId}/tasks/${encodeURIComponent(taskId)}`, 'Remove task failed');
  }

  /**
   * Make a saved session live on the server. `getSession` only reads the file;
   * until the session is adopted there is no orchestrator behind it, so
   * execute/retry/cancel answer `session_not_found`.
   */
  async adoptSession(sessionId: string, workspace?: string): Promise<Pick<AdoptSessionResponse, 'plan' | 'goal' | 'run' | 'plannerTurnId' | 'plannerCompaction'>> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    const res = await this.call<AdoptSessionResponse>('POST', `/api/sessions/${sessionId}/load${qs}`, 'Failed to load session');
    return {
      plan: res.plan,
      goal: res.goal ?? '',
      ...(res.run ? { run: res.run } : {}),
      ...(res.plannerTurnId ? { plannerTurnId: res.plannerTurnId } : {}),
      ...(res.plannerCompaction ? { plannerCompaction: res.plannerCompaction } : {}),
    };
  }

  deleteSession(sessionId: string, workspace?: string): Promise<OkResponse> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    return this.call('DELETE', `/api/sessions/${sessionId}${qs}`, 'Delete session failed');
  }

  /** Copy the conversation and its tasks into a new session the daemon has already adopted. */
  forkConversation(sessionId: string): Promise<ConversationForkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/conversation/fork`, 'Fork failed');
  }

  async rewindTargets(sessionId: string): Promise<RewindTarget[]> {
    const res = await this.call<RewindTargetsResponse>('GET', `/api/plans/${sessionId}/conversation/rewind-targets`, 'Failed to list rewind targets');
    return res.targets;
  }

  /**
   * Fork the conversation from just before the user message at `index` (a
   * transcript position) into a session the daemon has already adopted. The
   * original is left as it was; `rewoundMessage` is that message in full.
   */
  rewindConversation(sessionId: string, index: number): Promise<ConversationRewindResponse> {
    return this.call('POST', `/api/plans/${sessionId}/conversation/rewind`, 'Rewind failed', { index });
  }

  /**
   * Condense the conversation into a summary. One planner call, so it can take
   * as long as a reply; a refusal or failure leaves the conversation as it was.
   */
  compactConversation(sessionId: string): Promise<ConversationCompactResponse> {
    return this.turn('POST', `/api/plans/${sessionId}/conversation/compact`, 'Compaction failed');
  }

  /**
   * Retry compaction of a planner paused on its context: the paused turn
   * opens again, so this takes as long as a reply. The plan answered carries
   * the pause again when the retry paused too.
   */
  async retryPlannerCompaction(sessionId: string): Promise<PlanResponse['plan']> {
    const route = `/api/plans/${sessionId}/conversation/compact/retry`;
    return planOf<PlanResponse>(await this.turn('POST', route, 'Retry compaction failed'), route).plan;
  }

  /** The ancestors a task waits on at its merge gate (ADR-0020); empty when nothing gates it. */
  async getMergeGate(sessionId: string, taskId: string): Promise<MergeGateEntry[]> {
    const res = await this.call<MergeGateResponse>('GET', `/api/plans/${sessionId}/tasks/${encodeURIComponent(taskId)}/merge-gate`, 'Could not read the merge gate');
    return res.mergeGate ?? [];
  }

  /** What reverting a task would do now (ADR-0054), which the user confirms before `execute` sends `revert_task`. */
  revertPreview(sessionId: string, taskId: string): Promise<TaskRevertPreviewResponse> {
    return this.call('GET', `/api/plans/${sessionId}/tasks/${encodeURIComponent(taskId)}/revert-preview`, 'Could not read what the revert would take');
  }

  async reviewRunDiff(sessionId: string): Promise<string> {
    const res = await this.call<IsolationDiffResponse>('GET', `/api/plans/${sessionId}/isolation/diff`, 'Could not read the diff');
    return res.diff;
  }

  /**
   * A conflict or a block is an outcome, not an error. Passed on whole: which
   * repos blocked the merge, or landed before it stopped, is the answer.
   */
  mergeRun(sessionId: string): Promise<MergeRunResult> {
    return this.call('POST', `/api/plans/${sessionId}/isolation/merge`, 'Merge failed');
  }

  discardRun(sessionId: string): Promise<void> {
    return this.isolationAction(sessionId, 'discard', 'Discard failed');
  }

  cleanupRun(sessionId: string): Promise<void> {
    return this.isolationAction(sessionId, 'cleanup', 'Cleanup failed');
  }

  continueWithStash(sessionId: string): Promise<void> {
    return this.isolationAction(sessionId, 'stash-and-continue', 'Could not stash and continue');
  }

  continueWithoutIsolation(sessionId: string): Promise<void> {
    return this.isolationAction(sessionId, 'run-without', 'Could not continue without isolation');
  }

  private async isolationAction(sessionId: string, segment: string, failure: string): Promise<void> {
    await this.call<OkResponse>('POST', `/api/plans/${sessionId}/isolation/${segment}`, failure);
  }

  async resolveConflictAsTask(sessionId: string, taskId: string): Promise<ResolveConflictResponse['plan']> {
    const res = await this.call<ResolveConflictResponse>('POST', `/api/plans/${sessionId}/tasks/${encodeURIComponent(taskId)}/resolve-conflict`, 'Could not add a resolver task');
    return res.plan;
  }

  closeSession(sessionId: string): Promise<OkResponse> {
    return this.call('POST', `/api/sessions/${sessionId}/close`, 'Close session failed');
  }

  stopExecution(sessionId: string): Promise<StopResponse> {
    return this.call('POST', `/api/plans/${sessionId}/stop`, 'Stop failed');
  }

  /** Aborts a planning turn in flight. A harmless no-op when the session isn't planning. */
  cancelPlanning(sessionId: string): Promise<CancelPlanningResponse> {
    return this.call('POST', `/api/plans/${sessionId}/planning/stop`, 'Cancel planning failed');
  }

  /**
   * The repositories and branches the daemon would isolate for `workspace`,
   * read without starting a run or touching any repository. Never rejects for
   * a repository that cannot be read: the daemon answers a `failed` preview.
   */
  getIsolationPreview(workspace?: string): Promise<IsolationPreviewResponse> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    return this.call('GET', `/api/workspaces/isolation-preview${qs}`, 'Failed to read the repositories');
  }

  getSessions(workspace?: string): Promise<SessionListResponse> {
    const qs = workspace
      ? `?workspace=${encodeURIComponent(workspace)}`
      : '';
    return this.call('GET', `/api/sessions${qs}`, 'Failed to list sessions');
  }

  getSession(sessionId: string, workspace?: string): Promise<SessionResponse> {
    const qs = workspace
      ? `?workspace=${encodeURIComponent(workspace)}`
      : '';
    return this.call('GET', `/api/sessions/${sessionId}${qs}`, 'Session not found');
  }

  /** The attempts of a structured task that have a saved log, oldest first. */
  async getTaskLogAttempts(sessionId: string, taskId: string, workspace?: string): Promise<TaskLogAttemptsResponse> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    const res = await this.call<TaskLogAttemptsResponse>('GET', `/api/sessions/${sessionId}/tasks/${encodeURIComponent(taskId)}/log${qs}`, 'Could not read the task log');
    return res;
  }

  /** One attempt's saved log, for `replayTaskLog`. */
  async getTaskLog(sessionId: string, taskId: string, attempt: number, workspace?: string): Promise<TaskLogResponse> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    const res = await this.call<TaskLogResponse>('GET', `/api/sessions/${sessionId}/tasks/${encodeURIComponent(taskId)}/log/${attempt}${qs}`, 'Could not read the task log');
    return res;
  }


  /**
   * The one place a session socket is built, so the token travels on both
   * stream paths. It rides as a subprotocol rather than a query parameter, so
   * it never reaches an access log.
   */
  private openSessionSocket(sessionId: string): WebSocket {
    const token = this.token();
    const socket = new WebSocket(
      `ws://127.0.0.1:${this.port}/ws/session/${sessionId}`,
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

  /** Ends one stream `streamExecution` returned, leaving any newer stream the session has opened since alone. */
  closeExecutionStream(stream: Promise<'lost' | void>): void {
    this.executionStreamEnds.get(stream)?.();
  }

  streamExecution(
    sessionId: string,
    onEvent: (event: WsEvent) => void,
    onReady?: (error?: Error) => void,
  ): Promise<'lost' | void> {
    let endStream: () => void = () => {};
    const stream = new Promise<'lost' | void>((resolve, reject) => {
      this.executionStreams.get(sessionId)?.();
      const socket = this.openSessionSocket(sessionId);

      let resolved = false;
      let opened = false;
      const forget = () => { if (this.executionStreams.get(sessionId) === end) this.executionStreams.delete(sessionId); };
      const end = () => {
        forget();
        if (resolved) return;
        resolved = true;
        socket.close();
        resolve();
      };
      this.executionStreams.set(sessionId, end);
      endStream = end;

      socket.on('open', () => {
        opened = true;
        onReady?.();
      });

      socket.on('message', (data: Buffer) => {
        if (resolved) return;
        try {
          const event: WsEvent = JSON.parse(data.toString());
          onEvent(event);
          if (event.type === 'execution_complete' || event.type === 'execution_stopped') end();
        } catch {
          // ignore malformed messages
        }
      });

      socket.on('error', (err) => {
        forget();
        if (!opened) onReady?.(err);
        if (resolved) return;
        resolved = true;
        // A reset mid-run is the daemon going away, same as a close: the run
        // may still be going, so the caller reports it lost, not failed.
        if (opened) {
          socket.close();
          resolve('lost');
        } else {
          reject(err);
        }
      });

      socket.on('close', () => {
        forget();
        if (!opened) onReady?.(new Error('Execution stream closed before connecting'));
        if (!resolved) {
          resolved = true;
          // Neither a completion event nor a caller ended this: the daemon went away.
          resolve('lost');
        }
      });
    });
    this.executionStreamEnds.set(stream, endStream);
    return stream;
  }

  /**
   * Every broadcast of one session for as long as the caller holds it. Unlike
   * `streamExecution`, a run's end does not end it: the next run may be one
   * nobody on this surface asked for — autorun, the planner's `run_plan`, the
   * supervisor — and the daemon tells only the sockets already subscribed.
   * `ready` settles on a failure too, never rejects: a follow that cannot
   * connect costs the live view, not the request it opened around.
   */
  followSession(sessionId: string, onEvent: (event: WsEvent) => void): SessionFollow {
    const socket = this.openSessionSocket(sessionId);
    let closing = false;
    const ready = new Promise<boolean>((resolve) => {
      socket.once('open', () => resolve(true));
      socket.once('error', () => resolve(false));
      socket.once('close', () => resolve(false));
    });
    const ended = new Promise<'lost' | void>((resolve) => {
      socket.once('close', () => resolve(closing ? undefined : 'lost'));
    });
    socket.on('message', (data: Buffer) => {
      if (closing) return;
      try {
        onEvent(JSON.parse(data.toString()));
      } catch {
        // ignore malformed messages
      }
    });
    socket.on('error', () => {
      // Reported through `ended`, which the close that follows settles.
    });
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
   * Answer an approval prompt: the planner's with a yes/no, a task runner's
   * with the whole decision (ADR-0018, A1). The planner's requests arrive over
   * the session socket; a runner's, in its task log.
   */
  async respondToApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer): Promise<OkResponse> {
    const { status, data } = await this.httpRequest<OkResponse>(
      'POST',
      `/api/approvals/${encodeURIComponent(sessionId)}/${encodeURIComponent(approvalId)}`,
      typeof answer === 'boolean' ? { granted: answer } : answer,
    );
    if (status !== 200) throw new DaemonError(`Failed to answer approval ${approvalId} (HTTP ${status})`, status, (data as Partial<ErrorBody>).code);
    return data;
  }

  /**
   * Subscribe to a session's WS stream during planning (issue #34 UX): fire
   * and forget, since the awaited plan-generation REST call is the actual
   * completion signal, not a terminal WS message like execution has.
   */
  streamPlanning(sessionId: string, onEvent: (event: WsEvent) => void): { ready: Promise<void>; close: () => void } {
    const socket = this.openSessionSocket(sessionId);
    // The daemon broadcasts a turn's start the moment the REST call reaches
    // it, so the caller waits for the subscription first. It settles on a
    // failure too, never rejects: a broken socket costs the progress display,
    // not the turn.
    const ready = new Promise<void>((resolve) => {
      socket.once('open', () => resolve());
      socket.once('error', () => resolve());
      socket.once('close', () => resolve());
    });
    // `close()` only starts the handshake, and frames already on the wire are
    // still emitted: the next turn's, which the next converse's stream also hears.
    let closed = false;
    socket.on('message', (data: Buffer) => {
      if (closed) return;
      try {
        onEvent(JSON.parse(data.toString()));
      } catch {
        // ignore malformed messages
      }
    });
    socket.on('error', () => {
      // Best-effort progress display — a broken WS never blocks plan generation.
    });
    return { ready, close: () => { closed = true; socket.close(); } };
  }

  // Every settings call names this workspace, as `getModels` does: the
  // planner's model is judged against its runner catalog, which its own
  // CLAUDE_CONFIG_DIR can make another account's than the daemon's cwd.
  getSettings(sessionId?: string): Promise<SettingsResponse> {
    const session = sessionId ? `sessionId=${encodeURIComponent(sessionId)}&` : '';
    return this.call('GET', `/api/settings?${session}workspace=${encodeURIComponent(this.workspace)}`, 'Failed to fetch settings');
  }

  /** Save run settings (ADR-0030); with `sessionId`, that session's run takes them at once. */
  updateRunSettings(changes: Partial<GlobalRunSettings>, sessionId?: string): Promise<SettingsResponse> {
    return this.call('PATCH', '/api/settings', 'Change run settings failed', { run: changes, ...(sessionId ? { sessionId } : {}), workspace: this.workspace });
  }

  updateSettings(changes: Record<string, unknown>): Promise<SettingsUpdateResponse> {
    return this.call('PATCH', '/api/settings', 'Failed to update settings', { ...changes, workspace: this.workspace });
  }
}


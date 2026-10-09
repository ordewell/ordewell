import http from 'http';
import WebSocket from 'ws';
import { DEFAULT_PORT } from './daemon';
import { bearerHeaderValue, readDaemonToken, tokenSubprotocols, mintSessionId } from '@ordewell/core';
import type {
  AdoptSessionResponse,
  ApprovalAnswer,
  CancelPlanningResponse,
  CommandResponse,
  CommandsResponse,
  ConversationCompactResponse,
  ConversationForkResponse,
  ConversationRewindResponse,
  DaemonErrorCode,
  ErrorBody,
  ExecuteResponse,
  ForceSendResponse,
  GeneratePlanResponse,
  LegacyPlanState,
  IsolationDiffResponse,
  IsolationMergeResponse,
  MergeGateEntry,
  MergeGateResponse,
  ModelsResponse,
  OkResponse,
  PlanResponse,
  PlanState,
  RemoveMessageResponse,
  ResolveConflictResponse,
  RewindTarget,
  RewindTargetsResponse,
  RunnersResponse,
  SessionListResponse,
  SessionMessage,
  SessionMeta,
  SessionNotice,
  SessionResponse,
  SettingsResponse,
  SettingsUpdateResponse,
  StopResponse,
  TaskLogAttemptsResponse,
  TaskLogEvent,
  TaskLogResponse,
  TaskMessageResponse,
} from '@ordewell/core';

const DEFAULT_HTTP_TIMEOUT_MS = 15 * 60 * 1000;

export interface PlanResult {
  sessionId: string;
  plan: PlanState;
  models?: GeneratePlanResponse['models'];
  modelsByRunner?: GeneratePlanResponse['modelsByRunner'];
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
  constructor(message: string, readonly status: number, readonly code?: DaemonErrorCode) {
    super(message);
    this.name = 'DaemonError';
  }
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
export type PlanBody = PlanState | LegacyPlanState;

export type RunnerState = RunnersResponse['runners'][number];
export type { RunnersResponse };

export type { SessionMeta };


export interface TaskStatus {
  id: string;
  status: string;
  verdict: { outcome: string; reason: string; checks: unknown[] } | null;
}

export interface StatusUpdate {
  tasks: TaskStatus[];
}

export interface ExecutionSummary {
  total: number;
  completed: number;
  failed: number;
}

/**
 * What the daemon pushes over a websocket: the core union itself, not a bag
 * that happens to have a `type`.
 *
 * It used to be `{ type: string; [key: string]: unknown }`, which meant the CLI
 * and TUI adapters consumed no union at all — a new `SessionMessage` variant
 * compiled everywhere and was silently dropped by their `default:` arms. Naming
 * the real type turns that into a compile error at each surface.
 */
export type WsEvent = SessionMessage | SessionNotice;

/** `/api/plans/<id>/…` and `/api/sessions/<id>/…`: the session a request is about. */
const SESSION_PATH = /^\/api\/(?:plans|sessions)\/([^/?]+)/;

/** A non-200 answer as an error. The body is not trusted to be JSON: an HTML error page arrives as a string. */
function daemonError(status: number, data: unknown, fallback: string): DaemonError {
  const { error, code, workspace } = (typeof data === 'object' && data !== null ? data : {}) as Partial<ErrorBody>;
  if (code === 'workspace_not_a_project') return new WorkspaceInitNeededError(error || 'Not a project directory', workspace ?? '');
  return new DaemonError(error || fallback, status, code);
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
   * act twice.
   */
  private async httpRequest<T = unknown>(
    method: string,
    urlPath: string,
    body?: object,
  ): Promise<{ status: number; data: T }> {
    const res = await this.rawRequest<T>(method, urlPath, body);
    const sessionId = urlPath.match(SESSION_PATH)?.[1];
    const missing = res.status === 404 && (res.data as Partial<ErrorBody> | undefined)?.code === 'session_not_found';
    if (!missing || !sessionId || urlPath.split('?')[0].endsWith('/load')) return res;
    const adopted = await this.rawRequest('POST', `/api/sessions/${sessionId}/load?workspace=${encodeURIComponent(this.workspace)}`);
    return adopted.status === 200 ? this.rawRequest<T>(method, urlPath, body) : res;
  }

  /** One request whose only good answer is a 200: anything else becomes a {@link DaemonError} carrying the daemon's code. */
  private async call<T>(method: string, urlPath: string, fallback: string, body?: object): Promise<T> {
    const res = await this.httpRequest<T>(method, urlPath, body);
    if (res.status !== 200) throw daemonError(res.status, res.data, fallback);
    return res.data;
  }

  private rawRequest<T = unknown>(
    method: string,
    urlPath: string,
    body?: object,
  ): Promise<{ status: number; data: T }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, `http://127.0.0.1:${this.port}`);
      const configuredTimeout = Number.parseInt(process.env.ORDEWELL_HTTP_TIMEOUT_MS || '', 10);
      const token = this.token();
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: bearerHeaderValue(token) } : {}),
        },
        // Planner research on a real repository regularly exceeds two minutes.
        // The benchmark harness uses the same 15-minute default explicitly;
        // keep the env override for callers that need a tighter/looser bound.
        timeout:
          Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? configuredTimeout
            : DEFAULT_HTTP_TIMEOUT_MS,
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
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
        reject(new Error('Request timed out'));
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
    const { plan, models, modelsByRunner } = await this.call<GeneratePlanResponse>('POST', `/api/plans/${sessionId}/generate`, 'Plan generation failed', {
      goal,
      runners: runners || undefined,
      workspace,
    });
    return { sessionId, plan, models, modelsByRunner };
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
    const res = await this.call<PlanResponse>('POST', `/api/plans/${sessionId}/converse/start`, 'Planning failed', {
      goal,
      runners: runners || undefined,
      workspace,
      allowInit,
    });
    return res.plan;
  }

  async sendConversationMessage(sessionId: string, message: string): Promise<PlanResponse['plan']> {
    const res = await this.call<PlanResponse>('POST', `/api/plans/${sessionId}/converse/message`, 'Planner message failed', { message });
    return res.plan;
  }

  getRunners(): Promise<RunnersResponse> {
    return this.call('GET', '/api/runners', 'Failed to fetch runners');
  }

  /** The full provider catalog the daemon has discovered (used by the TUI model picker). */
  getModels(): Promise<ModelsResponse> {
    return this.call('GET', '/api/models', 'Failed to fetch models');
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
  approveReview(sessionId: string): Promise<PlanResponse> {
    return this.call('POST', `/api/plans/${sessionId}/review/approve`, 'Approve failed');
  }

  markTaskComplete(sessionId: string, taskId: string): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/complete`, 'Mark complete failed');
  }

  markTaskIncomplete(sessionId: string, taskId: string): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/uncomplete`, 'Mark not done failed');
  }

  /** run | force-start | retry | cancel — real orchestrator work, not a status patch. */
  taskControl(
    sessionId: string,
    taskId: string,
    action: 'run' | 'force-start' | 'retry' | 'cancel',
  ): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/${action}`, `${action} failed`);
  }

  /** A user message to a structured task: delivered now if it waits for input, else queued behind its turn. */
  sendTaskMessage(sessionId: string, taskId: string, text: string): Promise<TaskMessageResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/messages`, 'Send message failed', { text });
  }

  /** Force send: interrupt the task's running turn and deliver `text` next, ahead of anything queued (ADR-0023, F1). */
  forceSendTaskMessage(sessionId: string, taskId: string, text: string): Promise<TaskMessageResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/messages/now`, 'Send now failed', { text });
  }

  /** Force send a message still queued; `sent` is false once the runner already has it. */
  forceSendQueuedTaskMessage(sessionId: string, taskId: string, messageId: string): Promise<ForceSendResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/messages/${encodeURIComponent(messageId)}/now`, 'Send now failed');
  }

  /** Continue a finished structured task in its saved session, with `text` as its next turn. */
  continueTask(sessionId: string, taskId: string, text: string): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/continue`, 'Continue failed', { text });
  }

  /** `removed` is false once the message was already delivered. */
  removeQueuedTaskMessage(sessionId: string, taskId: string, messageId: string): Promise<RemoveMessageResponse> {
    return this.call('DELETE', `/api/plans/${sessionId}/tasks/${taskId}/messages/${encodeURIComponent(messageId)}`, 'Remove message failed');
  }

  interruptTask(sessionId: string, taskId: string): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/interrupt`, 'Interrupt failed');
  }

  /** Let a task go on from the checkpoint it waits at; refused, with the reason, when none waits. */
  approveTaskCheckpoint(sessionId: string, taskId: string): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/checkpoint/approve`, 'Approve checkpoint failed');
  }

  /** Turn a task back at its checkpoint; `reason` is what the agent is told. */
  rejectTaskCheckpoint(sessionId: string, taskId: string, reason?: string): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks/${taskId}/checkpoint/reject`, 'Reject checkpoint failed', reason ? { reason } : {});
  }

  addTask(sessionId: string, task: Record<string, unknown>): Promise<OkResponse> {
    return this.call('POST', `/api/plans/${sessionId}/tasks`, 'Add task failed', task);
  }

  updateTask(sessionId: string, taskId: string, changes: Record<string, unknown>): Promise<OkResponse> {
    return this.call('PUT', `/api/plans/${sessionId}/tasks/${taskId}`, 'Update task failed', changes);
  }

  removeTask(sessionId: string, taskId: string): Promise<OkResponse> {
    return this.call('DELETE', `/api/plans/${sessionId}/tasks/${taskId}`, 'Remove task failed');
  }

  /**
   * Make a saved session live on the server. `getSession` only reads the file;
   * until the session is adopted there is no orchestrator behind it, so
   * execute/retry/cancel answer `session_not_found`.
   */
  async adoptSession(sessionId: string, workspace?: string): Promise<{ plan: AdoptSessionResponse['plan']; goal: string }> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    const res = await this.call<AdoptSessionResponse>('POST', `/api/sessions/${sessionId}/load${qs}`, 'Failed to load session');
    return { plan: res.plan, goal: res.goal ?? '' };
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
    return this.call('POST', `/api/plans/${sessionId}/conversation/compact`, 'Compaction failed');
  }

  /** The dependencies a task waits on at its merge gate (ADR-0020); empty when nothing gates it. */
  async getMergeGate(sessionId: string, taskId: string): Promise<MergeGateEntry[]> {
    const res = await this.call<MergeGateResponse>('GET', `/api/plans/${sessionId}/tasks/${taskId}/merge-gate`, 'Could not read the merge gate');
    return res.mergeGate ?? [];
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
    const res = await this.call<ResolveConflictResponse>('POST', `/api/plans/${sessionId}/tasks/${taskId}/resolve-conflict`, 'Could not add a resolver task');
    return res.plan;
  }

  async closeSession(sessionId: string): Promise<OkResponse> {
    const res = await this.httpRequest<OkResponse>('POST', `/api/sessions/${sessionId}/close`);
    return res.data;
  }

  async stopExecution(sessionId: string): Promise<StopResponse> {
    const res = await this.httpRequest<StopResponse>('POST', `/api/plans/${sessionId}/stop`);
    return res.data;
  }

  /** Aborts a planning turn in flight. A harmless no-op when the session isn't planning. */
  async cancelPlanning(sessionId: string): Promise<CancelPlanningResponse> {
    const res = await this.httpRequest<CancelPlanningResponse>('POST', `/api/plans/${sessionId}/planning/stop`);
    return res.data;
  }

  async getSessions(workspace?: string): Promise<SessionListResponse> {
    const qs = workspace
      ? `?workspace=${encodeURIComponent(workspace)}`
      : '';
    const res = await this.httpRequest<SessionListResponse>('GET', `/api/sessions${qs}`);
    return res.data || [];
  }

  getSession(sessionId: string, workspace?: string): Promise<SessionResponse> {
    const qs = workspace
      ? `?workspace=${encodeURIComponent(workspace)}`
      : '';
    return this.call('GET', `/api/sessions/${sessionId}${qs}`, 'Session not found');
  }

  /** The attempts of a structured task that have a saved log, oldest first. */
  async getTaskLogAttempts(sessionId: string, taskId: string, workspace?: string): Promise<number[]> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    const res = await this.call<TaskLogAttemptsResponse>('GET', `/api/sessions/${sessionId}/tasks/${encodeURIComponent(taskId)}/log${qs}`, 'Could not read the task log');
    return res.attempts;
  }

  /** One attempt's saved log, for `replayTaskLog`. */
  async getTaskLog(sessionId: string, taskId: string, attempt: number, workspace?: string): Promise<TaskLogEvent[]> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    const res = await this.call<TaskLogResponse>('GET', `/api/sessions/${sessionId}/tasks/${encodeURIComponent(taskId)}/log/${attempt}${qs}`, 'Could not read the task log');
    return res.events;
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
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
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
    socket.on('message', (data: Buffer) => {
      try {
        onEvent(JSON.parse(data.toString()));
      } catch {
        // ignore malformed messages
      }
    });
    socket.on('error', () => {
      // Best-effort progress display — a broken WS never blocks plan generation.
    });
    return { ready, close: () => socket.close() };
  }

  getCommands(): Promise<CommandsResponse> {
    return this.call('GET', '/api/commands', 'Failed to fetch commands');
  }

  sendCommand(name: string, args: Record<string, string> = {}): Promise<CommandResponse> {
    return this.call('POST', `/api/commands/${name}`, `Command ${name} failed`, { args });
  }

  getSettings(): Promise<SettingsResponse> {
    return this.call('GET', '/api/settings', 'Failed to fetch settings');
  }

  updateSettings(changes: Record<string, unknown>): Promise<SettingsUpdateResponse> {
    return this.call('PATCH', '/api/settings', 'Failed to update settings', changes);
  }
}


import http from 'http';
import WebSocket from 'ws';
import { DEFAULT_PORT } from './daemon';
import { bearerHeaderValue, readDaemonToken, tokenSubprotocols } from '@ordewell/core';
import type { SerializedPlan, DiscoveredModel, SessionMessage } from '@ordewell/core';

const DEFAULT_HTTP_TIMEOUT_MS = 15 * 60 * 1000;

export interface PlanResult {
  sessionId: string;
  plan: SerializedPlan;
  models?: DiscoveredModel[];
  modelsByRunner?: Record<string, DiscoveredModel[]>;
}

interface ErrorResponse {
  error?: string;
}

export interface RunnerState {
  id: string;
  name: string;
  enabled: boolean;
}

export interface RunnersResponse {
  runners: RunnerState[];
  headless: boolean;
  orchestratorModel: string;
}

export interface SessionMeta {
  id: string;
  goal: string;
  runners: string[];
  taskCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

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
export type WsEvent = SessionMessage;

export class ApiClient {
  private port: number;

  constructor(port?: number) {
    this.port = port || DEFAULT_PORT;
  }

  /**
   * Read at call time rather than at construction: a daemon restarted mid-run
   * mints a new token, and a client built before that restart must pick it up.
   * A missing file is not an error here — the daemon's own 401 names the path.
   */
  private token(): string | undefined {
    return readDaemonToken(this.port);
  }

  private httpRequest<T = unknown>(
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
    sessionId: string = `session-${Date.now()}`,
  ): Promise<PlanResult> {
    const res = await this.httpRequest<Partial<PlanResult> & ErrorResponse>('POST', `/api/plans/${sessionId}/generate`, {
      goal,
      runners: runners || undefined,
      workspace,
    });
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Plan generation failed');
    }
    return { sessionId, plan: res.data.plan as SerializedPlan, models: res.data.models, modelsByRunner: res.data.modelsByRunner };
  }

  /**
   * Open the ADR-0002 planner dialogue. Unlike `generatePlan`, this path honours
   * the grill-me / PRD / review toggles, so the returned plan may be a question
   * (empty `tasks`, last word in `conversationHistory`) rather than a committed plan.
   */
  async startConversation(
    sessionId: string,
    goal: string,
    runners?: string[],
    workspace?: string,
  ): Promise<SerializedPlan> {
    const res = await this.httpRequest<{ plan: SerializedPlan } & ErrorResponse>('POST', `/api/plans/${sessionId}/converse/start`, {
      goal,
      runners: runners || undefined,
      workspace,
    });
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Planning failed');
    }
    return res.data.plan;
  }

  async sendConversationMessage(sessionId: string, message: string): Promise<SerializedPlan> {
    const res = await this.httpRequest<{ plan: SerializedPlan } & ErrorResponse>('POST', `/api/plans/${sessionId}/converse/message`, { message });
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Planner message failed');
    }
    return res.data.plan;
  }

  async getRunners(): Promise<RunnersResponse> {
    const res = await this.httpRequest<RunnersResponse & ErrorResponse>('GET', '/api/runners');
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Failed to fetch runners');
    }
    return res.data;
  }

  /** The full provider catalog the daemon has discovered (used by the TUI model picker). */
  async getModels(): Promise<{
    models: any[];
    modelsByRunner?: Record<string, any[]>;
    modesByRunner?: Record<string, any[]>;
    providers?: string[];
    orchestratorModels?: any[];
    providerErrors?: Record<string, string>;
  }> {
    const res = await this.httpRequest<{
      models: any[];
      modelsByRunner?: Record<string, any[]>;
      providers?: string[];
      orchestratorModels?: any[];
      providerErrors?: Record<string, string>;
    } & ErrorResponse>('GET', '/api/models');
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Failed to fetch models');
    }
    return res.data;
  }

  async setRunnerEnabled(runner: string, enabled: boolean): Promise<{ ok: boolean }> {
    const res = await this.httpRequest<{ ok: boolean } & ErrorResponse>('PUT', `/api/runners/${runner}`, { enabled });
    if (res.status !== 200) {
      throw new Error(res.data?.error || `Failed to ${enabled ? 'enable' : 'disable'} ${runner}`);
    }
    return res.data;
  }

  async executePlan(sessionId: string): Promise<{ status: string }> {
    const res = await this.httpRequest<{ status: string } & ErrorResponse>(
      'POST',
      `/api/plans/${sessionId}/execute`,
    );
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Execute failed');
    }
    return res.data;
  }

  /**
   * Sign off a plan waiting on `review_needed` and let it continue.
   *
   * Deliberately not `executePlan`: that resets the run (`clearLog` +
   * `resetForRun`) before approving, which is right for starting a plan and
   * wrong for releasing one that is already part-way through a review pause.
   */
  async approveReview(sessionId: string): Promise<{ plan: SerializedPlan }> {
    const res = await this.httpRequest<{ plan: SerializedPlan } & ErrorResponse>(
      'POST',
      `/api/plans/${sessionId}/review/approve`,
    );
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Approve failed');
    }
    return res.data;
  }

  async markTaskComplete(sessionId: string, taskId: string): Promise<{ ok: boolean }> {
    const res = await this.httpRequest<{ ok: boolean } & ErrorResponse>(
      'POST',
      `/api/plans/${sessionId}/tasks/${taskId}/complete`,
    );
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Mark complete failed');
    }
    return res.data;
  }

  async markTaskIncomplete(sessionId: string, taskId: string): Promise<{ ok: boolean }> {
    const res = await this.httpRequest<{ ok: boolean } & ErrorResponse>(
      'POST',
      `/api/plans/${sessionId}/tasks/${taskId}/uncomplete`,
    );
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Mark not done failed');
    }
    return res.data;
  }

  /** run | force-start | retry | cancel — real orchestrator work, not a status patch. */
  async taskControl(
    sessionId: string,
    taskId: string,
    action: 'run' | 'force-start' | 'retry' | 'cancel',
  ): Promise<{ ok: boolean }> {
    const res = await this.httpRequest<{ ok: boolean } & ErrorResponse>(
      'POST',
      `/api/plans/${sessionId}/tasks/${taskId}/${action}`,
    );
    if (res.status !== 200) {
      throw new Error(res.data?.error || `${action} failed`);
    }
    return res.data;
  }

  async addTask(sessionId: string, task: Record<string, unknown>): Promise<{ ok: boolean }> {
    const res = await this.httpRequest<{ ok: boolean } & ErrorResponse>('POST', `/api/plans/${sessionId}/tasks`, task);
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Add task failed');
    }
    return res.data;
  }

  async updateTask(
    sessionId: string,
    taskId: string,
    changes: Record<string, unknown>,
  ): Promise<{ ok: boolean }> {
    const res = await this.httpRequest<{ ok: boolean } & ErrorResponse>('PUT', `/api/plans/${sessionId}/tasks/${taskId}`, changes);
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Update task failed');
    }
    return res.data;
  }

  async removeTask(sessionId: string, taskId: string): Promise<{ ok: boolean }> {
    const res = await this.httpRequest<{ ok: boolean } & ErrorResponse>('DELETE', `/api/plans/${sessionId}/tasks/${taskId}`);
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Remove task failed');
    }
    return res.data;
  }

  /**
   * Make a saved session live on the server. `getSession` only reads the file;
   * until the session is adopted there is no orchestrator behind it, so
   * execute/retry/cancel answer "Session not found".
   */
  async adoptSession(sessionId: string, workspace?: string): Promise<{ plan: any; goal: string }> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    const res = await this.httpRequest<{ plan: any; goal?: string } & ErrorResponse>('POST', `/api/sessions/${sessionId}/load${qs}`);
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Failed to load session');
    }
    return { plan: res.data.plan, goal: res.data.goal ?? '' };
  }

  async deleteSession(sessionId: string, workspace?: string): Promise<{ ok: boolean }> {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    const res = await this.httpRequest<{ ok: boolean } & ErrorResponse>('DELETE', `/api/sessions/${sessionId}${qs}`);
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Delete session failed');
    }
    return res.data;
  }

  async closeSession(sessionId: string): Promise<{ ok: boolean }> {
    const res = await this.httpRequest<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/close`);
    return res.data;
  }

  async stopExecution(sessionId: string): Promise<{ status: string }> {
    const res = await this.httpRequest<{ status: string }>('POST', `/api/plans/${sessionId}/stop`);
    return res.data;
  }

  /** Aborts a planning turn in flight. A harmless no-op when the session isn't planning. */
  async cancelPlanning(sessionId: string): Promise<{ cancelled: boolean }> {
    const res = await this.httpRequest<{ cancelled: boolean }>('POST', `/api/plans/${sessionId}/planning/stop`);
    return res.data;
  }

  async processQueued(sessionId: string): Promise<{ ok: boolean }> {
    const res = await this.httpRequest<{ ok: boolean } & ErrorResponse>('POST', `/api/plans/${sessionId}/process-queued`);
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Process queued failed');
    }
    return res.data;
  }

  async getSessions(workspace?: string): Promise<SessionMeta[]> {
    const qs = workspace
      ? `?workspace=${encodeURIComponent(workspace)}`
      : '';
    const res = await this.httpRequest<SessionMeta[]>('GET', `/api/sessions${qs}`);
    return res.data || [];
  }

  async getSession(
    sessionId: string,
    workspace?: string,
  ): Promise<{ meta: SessionMeta; plan: SerializedPlan }> {
    const qs = workspace
      ? `?workspace=${encodeURIComponent(workspace)}`
      : '';
    const res = await this.httpRequest<{ meta: SessionMeta; plan: SerializedPlan } & ErrorResponse>(
      'GET',
      `/api/sessions/${sessionId}${qs}`,
    );
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Session not found');
    }
    return res.data;
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
          reason = (JSON.parse(body) as ErrorResponse).error ?? '';
        } catch {
          reason = body.trim();
        }
        socket.emit('error', new Error(reason || `Unexpected server response: ${res.statusCode}`));
        socket.emit('close', res.statusCode ?? 1006, Buffer.from(''));
      });
    });

    return socket;
  }

  streamExecution(
    sessionId: string,
    onEvent: (event: WsEvent) => void,
    onReady?: (error?: Error) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.openSessionSocket(sessionId);

      let resolved = false;
      let opened = false;

      socket.on('open', () => {
        opened = true;
        onReady?.();
      });

      socket.on('message', (data: Buffer) => {
        try {
          const event: WsEvent = JSON.parse(data.toString());
          onEvent(event);
          if (
            (event.type === 'execution_complete' ||
              event.type === 'execution_stopped') &&
            !resolved
          ) {
            resolved = true;
            socket.close();
            resolve();
          }
        } catch {
          // ignore malformed messages
        }
      });

      socket.on('error', (err) => {
        if (!opened) onReady?.(err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      socket.on('close', () => {
        if (!opened) onReady?.(new Error('Execution stream closed before connecting'));
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });
    });
  }

  /** Answer a planner approval prompt. Requests arrive over the session socket. */
  async respondToApproval(sessionId: string, approvalId: string, granted: boolean): Promise<{ ok: boolean }> {
    const { status, data } = await this.httpRequest<{ ok: boolean }>(
      'POST',
      `/api/approvals/${encodeURIComponent(sessionId)}/${encodeURIComponent(approvalId)}`,
      { granted },
    );
    if (status !== 200) throw new Error(`Failed to answer approval ${approvalId} (HTTP ${status})`);
    return data;
  }

  /**
   * Subscribe to a session's WS stream during planning (issue #34 UX): fire
   * and forget, since the awaited plan-generation REST call is the actual
   * completion signal, not a terminal WS message like execution has.
   */
  streamPlanning(sessionId: string, onEvent: (event: WsEvent) => void): { close: () => void } {
    const socket = this.openSessionSocket(sessionId);
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
    return { close: () => socket.close() };
  }

  async getCommands(): Promise<{ commands: { name: string; description: string }[] }> {
    const res = await this.httpRequest<{ commands: { name: string; description: string }[] } & ErrorResponse>('GET', '/api/commands');
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Failed to fetch commands');
    }
    return res.data;
  }

  async sendCommand(name: string, args: Record<string, string> = {}): Promise<{ ok: boolean; settings?: Record<string, unknown> }> {
    const res = await this.httpRequest<{ ok: boolean; settings?: Record<string, unknown> } & ErrorResponse>('POST', `/api/commands/${name}`, { args });
    if (res.status !== 200) {
      throw new Error(res.data?.error || `Command ${name} failed`);
    }
    return res.data;
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const res = await this.httpRequest<Record<string, unknown> & ErrorResponse>('GET', '/api/settings');
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Failed to fetch settings');
    }
    return res.data;
  }

  async updateSettings(changes: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.httpRequest<Record<string, unknown> & ErrorResponse>('PATCH', '/api/settings', changes);
    if (res.status !== 200) {
      throw new Error(res.data?.error || 'Failed to update settings');
    }
    return res.data;
  }
}

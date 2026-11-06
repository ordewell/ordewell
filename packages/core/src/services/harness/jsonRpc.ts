import type { AgentEvent } from './AgentAdapter';

/** One JSON-RPC frame: a response, a request of the other side's own, or a notification. */
export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: number; data?: unknown };
}

export type RpcResponse =
  | { ok: true; result: Record<string, unknown> }
  /**
   * `closed` is the connection ending before any answer; `timedOut` is the
   * caller giving up while the connection stays up; otherwise `message` and
   * `code` are the other side's own refusal, and `details` what it said of it
   * beyond the message.
   */
  | { ok: false; closed: boolean; timedOut?: true; message?: string; code?: number; details?: string };

type Emit = (event: AgentEvent) => void;

/**
 * Runs inside {@link JsonRpcPeer.dispatch}, on the line that carried the answer.
 * That is the contract: LineBuffer hands every line of a chunk over in one
 * synchronous pass, so a handler that waited a microtask would see
 * `turn/completed` — the next line of the same chunk — before the response it
 * is waiting on, and count an accepted steer as refused.
 */
export type RpcHandler = (response: RpcResponse, emit: Emit) => void;

/** A JSON-RPC error as a value a request handler returns or throws. */
export class JsonRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const CANCEL_REQUEST = '$/cancel_request';

export interface IncomingRequest {
  id: number | string;
  method: string;
  emit: Emit;
  /**
   * Aborted when the other side sends `$/cancel_request` naming this id, or the
   * peer closes. The handler still owes an answer on the first; the peer
   * decides nothing about what a cancelled request should reply.
   */
  cancelled: AbortSignal;
}

type HandlerResult = Record<string, unknown> | JsonRpcError;
/** Synchronous or not: a synchronous answer is written on the line that carried the request. */
export type RequestHandler = (params: Record<string, unknown>, request: IncomingRequest) => HandlerResult | Promise<HandlerResult>;
export type NotificationHandler = (params: Record<string, unknown>, emit: Emit) => void;

export interface CallOptions {
  /**
   * Bounds how long the caller waits, never the request: the slot stays so a
   * late answer is recognised and discarded instead of being a response nobody
   * asked for — which some peers treat as fatal (the AionUi/Zed study, F1).
   */
  timeoutMs?: number;
}

interface Pending {
  handler: RpcHandler;
  method: string;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The client side of a line-delimited JSON-RPC 2.0 connection, whatever the
 * protocol on top: the ids this side sends requests under, the handlers waiting
 * on their answers, the routing of the other side's requests and
 * notifications, and the answers it gives. What a method means stays with the
 * adapter.
 *
 * Ids count up from 1, so `initialize` is 1 and the request after it 2, as the
 * recorded transcripts have them. Ids the other side sends may be strings.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly inFlight = new Map<number | string, AbortController>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private closedBy: string | null = null;

  constructor(private readonly write: (payload: unknown) => void) {}

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Send a request; `onResponse` hears the answer, the connection closing first, or the timeout. */
  send(method: string, params: Record<string, unknown>, onResponse: RpcHandler = () => {}, options: CallOptions = {}): void {
    const payload = this.open(method, params, onResponse, options);
    if (!this.closedBy) this.write(payload);
  }

  /** The request as the awaited form of {@link send}, for steps that wait on one answer and nothing else. */
  call(method: string, params: Record<string, unknown>, options: CallOptions = {}): Promise<RpcResponse> {
    return new Promise((resolve) => this.send(method, params, (response) => resolve(response), options));
  }

  /** A notification: no id, no answer. Dropped after close, like a write to a dead process. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.closedBy) this.write({ jsonrpc: '2.0', method, params });
  }

  /**
   * A request framed as the line to write, left to the caller to write — for
   * the adapter base class, which writes whatever a turn's payload hands it.
   */
  frame(method: string, params: Record<string, unknown>, onResponse: RpcHandler): string {
    return `${JSON.stringify(this.open(method, params, onResponse, {}))}\n`;
  }

  /**
   * Whether the peer took `msg`: a response (settled — however long ago its
   * request gave up waiting, and whether or not anyone asked for it), a request
   * it routed or answered, or a notification it routed. False leaves the
   * message to the caller.
   */
  dispatch(msg: RpcMessage, emit: Emit): boolean {
    if (msg.method) {
      return typeof msg.id === 'number' || typeof msg.id === 'string'
        ? this.dispatchRequest(msg.id, msg.method, msg.params ?? {}, emit)
        : this.dispatchNotification(msg.method, msg.params ?? {}, emit);
    }
    if (typeof msg.id !== 'number') return typeof msg.id === 'string';
    const entry = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (entry?.timer) clearTimeout(entry.timer);
    entry?.handler(msg.error ? refusal(msg.error) : { ok: true, result: msg.result ?? {} }, emit);
    return true;
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /**
   * The process is gone: every request still waiting fails, and later ones
   * fail at once without a write. Handlers get an emitter that goes nowhere —
   * what ended the process is reported by the process's own exit, not by an
   * answer that never came.
   */
  close(reason: string): void {
    if (this.closedBy) return;
    this.closedBy = reason;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.handler({ ok: false, closed: true, message: reason }, () => {});
    }
    const running = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const controller of running) controller.abort();
  }

  /**
   * A request no handler is registered for. A peer answers it -32601 so the
   * other side is never left waiting; a subclass whose adapter handles its own
   * requests returns false to leave the message to it.
   */
  protected unroutedRequest(id: number | string, method: string): boolean {
    this.respondError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    return true;
  }

  private dispatchRequest(id: number | string, method: string, params: Record<string, unknown>, emit: Emit): boolean {
    const handler = this.requestHandlers.get(method);
    if (!handler) return this.unroutedRequest(id, method);
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    const answer = (outcome: HandlerResult | Promise<HandlerResult>): void => {
      if (outcome instanceof Promise) {
        void outcome.then(
          (value) => this.finish(id, controller, value, true),
          (error: unknown) => this.finish(id, controller, errorOf(error), true),
        );
      } else {
        this.finish(id, controller, outcome, false);
      }
    };
    try {
      answer(handler(params, { id, method, emit, cancelled: controller.signal }));
    } catch (error) {
      this.finish(id, controller, errorOf(error), false);
    }
    return true;
  }

  /** Answers a routed request, unless the connection closed while an asynchronous handler worked. */
  private finish(id: number | string, controller: AbortController, outcome: HandlerResult, late: boolean): void {
    if (this.inFlight.get(id) === controller) this.inFlight.delete(id);
    if (late && this.closedBy) return;
    if (outcome instanceof JsonRpcError) this.respondError(id, outcome.code, outcome.message);
    else this.respond(id, outcome);
  }

  private dispatchNotification(method: string, params: Record<string, unknown>, emit: Emit): boolean {
    if (method === CANCEL_REQUEST) {
      // ACP v1's `CancelRequestNotification` names the request in `requestId`, not LSP's `id`.
      const named = params.requestId;
      if (typeof named === 'number' || typeof named === 'string') this.inFlight.get(named)?.abort();
      return true;
    }
    const handler = this.notificationHandlers.get(method);
    if (!handler) return false;
    handler(params, emit);
    return true;
  }

  private open(method: string, params: Record<string, unknown>, onResponse: RpcHandler, options: CallOptions): Record<string, unknown> {
    const id = this.nextId++;
    if (this.closedBy) {
      const reason = this.closedBy;
      queueMicrotask(() => onResponse({ ok: false, closed: true, message: reason }, () => {}));
    } else {
      const entry: Pending = { handler: onResponse, method };
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => this.giveUp(id, entry, options.timeoutMs!), options.timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
    }
    return { jsonrpc: '2.0', id, method, params };
  }

  /** The caller stops waiting; the slot stays, its handler replaced by one that hears nothing. */
  private giveUp(id: number, entry: Pending, timeoutMs: number): void {
    const handler = entry.handler;
    entry.handler = () => {};
    entry.timer = undefined;
    this.pending.set(id, entry);
    handler({ ok: false, closed: false, timedOut: true, message: `No answer to ${entry.method} within ${timeoutMs} ms.` }, () => {});
  }
}

function errorOf(error: unknown): JsonRpcError {
  return error instanceof JsonRpcError ? error : new JsonRpcError(INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
}

function refusal(error: { message?: string; code?: number; data?: unknown }): RpcResponse {
  const details = detailsOf(error.data);
  return { ok: false, closed: false, message: error.message, ...(typeof error.code === 'number' ? { code: error.code } : {}), ...(details ? { details } : {}) };
}

/**
 * The words a refusal's `data` holds, which JSON-RPC leaves free: an agent
 * that wraps a vendor's failure in a generic message, as Qwen Code 0.26.6
 * answers one with "Internal error", puts the vendor's own reason there as
 * `details`, or as the data itself.
 */
function detailsOf(data: unknown): string | undefined {
  if (typeof data === 'string') return data.trim() || undefined;
  if (data && typeof data === 'object' && 'details' in data && typeof data.details === 'string') return data.details.trim() || undefined;
  return undefined;
}

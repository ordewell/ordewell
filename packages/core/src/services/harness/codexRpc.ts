import type { AgentEvent } from './AgentAdapter';

/** One JSON-RPC frame as Codex's `app-server` sends it: a response, a request of its own, or a notification. */
export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: number };
}

export type RpcResponse =
  | { ok: true; result: Record<string, unknown> }
  /** `closed` is the connection ending before any answer; otherwise `message` and `code` are the server's own refusal. */
  | { ok: false; closed: boolean; message?: string; code?: number };

type Emit = (event: AgentEvent) => void;

/**
 * Runs inside {@link CodexRpc.dispatch}, on the line that carried the answer.
 * That is the contract: LineBuffer hands every line of a chunk over in one
 * synchronous pass, so a handler that waited a microtask would see
 * `turn/completed` — the next line of the same chunk — before the response it
 * is waiting on, and count an accepted steer as refused.
 */
export type RpcHandler = (response: RpcResponse, emit: Emit) => void;

/**
 * The client side of Codex's JSON-RPC connection: the ids this adapter sends
 * requests under, the handlers waiting on their answers, and the answers it
 * gives Codex's own requests. What a notification or a request of Codex's
 * means stays with the adapter.
 *
 * Ids count up from 1, so `initialize` is 1 and the thread request after it
 * 2, as the recorded transcripts have them, unless a question comes between:
 * a read-only task's `config/read`, or a Windows change task's sandbox
 * readiness.
 */
export class CodexRpc {
  private nextId = 1;
  private readonly pending = new Map<number, RpcHandler>();
  private closedBy: string | null = null;

  constructor(private readonly write: (payload: unknown) => void) {}

  /** Send a request; `onResponse` hears the answer, or the connection closing first. */
  send(method: string, params: Record<string, unknown>, onResponse: RpcHandler = () => {}): void {
    const payload = this.open(method, params, onResponse);
    if (!this.closedBy) this.write(payload);
  }

  /** The request as the awaited form of {@link send}, for steps that wait on one answer and nothing else. */
  call(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    return new Promise((resolve) => this.send(method, params, (response) => resolve(response)));
  }

  /**
   * A request framed as the line to write, left to the caller to write — for
   * the adapter base class, which writes whatever a turn's payload hands it.
   */
  frame(method: string, params: Record<string, unknown>, onResponse: RpcHandler): string {
    return `${JSON.stringify(this.open(method, params, onResponse))}\n`;
  }

  /** Whether `msg` was a response, and so is settled — however long ago its request gave up waiting. */
  dispatch(msg: RpcMessage, emit: Emit): boolean {
    if (msg.method || typeof msg.id !== 'number') return false;
    const handler = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    handler?.(msg.error ? refusal(msg.error) : { ok: true, result: msg.result ?? {} }, emit);
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
    for (const handler of waiting) handler({ ok: false, closed: true, message: reason }, () => {});
  }

  private open(method: string, params: Record<string, unknown>, onResponse: RpcHandler): Record<string, unknown> {
    const id = this.nextId++;
    if (this.closedBy) {
      const reason = this.closedBy;
      queueMicrotask(() => onResponse({ ok: false, closed: true, message: reason }, () => {}));
    } else {
      this.pending.set(id, onResponse);
    }
    return { jsonrpc: '2.0', id, method, params };
  }
}

function refusal(error: { message?: string; code?: number }): RpcResponse {
  return { ok: false, closed: false, message: error.message, ...(typeof error.code === 'number' ? { code: error.code } : {}) };
}

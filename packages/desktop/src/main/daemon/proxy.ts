import http from 'node:http';
import WebSocket from 'ws';
import { bearerHeaderValue, isConnectionRefused, tokenSubprotocols } from '@ordewell/core/daemon-client';
import type { DaemonCallResult, StreamEvent } from '../../shared/bridge';
import type { DaemonRequest } from '../../shared/routes';

export interface DaemonProxyDeps {
  port(): number;
  /** Read at each call: a restarted daemon mints a new token. */
  token(): string | undefined;
  /** A call or socket found nothing listening. */
  onUnreachable?(): void;
  timeoutMs?: number;
}

/**
 * The renderer's only way to the daemon, and the only place the token is
 * attached (ADR-0060 H4). It takes a request `buildRequest` already checked
 * against the route table and adds what the renderer never holds: the bearer,
 * a loopback `Host` at the daemon's own port, and no `Origin`, since admission
 * refuses any request that carries one.
 */
export class DaemonProxy {
  constructor(private readonly deps: DaemonProxyDeps) {}

  call(request: DaemonRequest): Promise<DaemonCallResult> {
    const port = this.deps.port();
    const token = this.deps.token();
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, Accept: 'application/json' };
    if (token) headers.Authorization = bearerHeaderValue(token);
    const body = request.body !== undefined ? Buffer.from(request.body, 'utf8') : undefined;
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(body.length);
    }

    return new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: request.method, path: request.path, headers, timeout: request.turn ? 0 : this.deps.timeoutMs ?? 30_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString('utf8');
            const data = parseJson(text);
            if (status >= 200 && status < 300) {
              resolve({ ok: true, status, data });
              return;
            }
            resolve({ ok: false, status, error: errorText(data, text, status), ...(data !== undefined ? { data } : {}) });
          });
          res.on('error', (err) => resolve({ ok: false, status: res.statusCode, error: err.message }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('The daemon did not answer in time.')));
      req.on('error', (err) => {
        if (isConnectionRefused(err)) this.deps.onUnreachable?.();
        resolve({ ok: false, error: isConnectionRefused(err) ? 'The daemon is not running.' : err.message });
      });
      req.end(body);
    });
  }

  /**
   * Open a session socket and relay its frames. The token rides as a
   * subprotocol, as every client sends it; `ws` sends no `Origin` unless asked.
   */
  stream(path: string, onEvent: (event: StreamEvent) => void): () => void {
    const port = this.deps.port();
    const token = this.deps.token();
    let closed = false;
    if (!token) {
      queueMicrotask(() => onEvent({ kind: 'closed', code: 4401, reason: 'No daemon token to present.' }));
      return () => { closed = true; };
    }
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, tokenSubprotocols(token), {
      headers: { Host: `127.0.0.1:${port}` },
      perMessageDeflate: false,
    });
    socket.on('message', (data, isBinary) => {
      if (closed || isBinary) return;
      const frame = parseJson(data.toString());
      if (frame !== undefined) onEvent({ kind: 'frame', frame });
    });
    socket.on('error', (err) => {
      if (isConnectionRefused(err)) this.deps.onUnreachable?.();
    });
    socket.on('close', (code, reason) => {
      if (closed) return;
      closed = true;
      onEvent({ kind: 'closed', code, reason: reason.toString() });
    });
    return () => {
      if (closed) return;
      closed = true;
      socket.close();
    };
  }
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(data: unknown, text: string, status: number): string {
  if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') return data.error;
  return text.trim() !== '' && text.length < 500 ? text.trim() : `The daemon answered ${status}.`;
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { createApp, attachWsHandler } from '../app';
import { createRequestListener } from '../nodeAdapter';
import type { OrchestratorPool } from '../pool/orchestratorPool';

function fakePool(overrides: Partial<OrchestratorPool> = {}): OrchestratorPool {
  return {
    hasSession: vi.fn().mockReturnValue(true),
    resolveApproval: vi.fn().mockReturnValue(true),
    outstandingApprovals: vi.fn().mockReturnValue([]),
    approvedScopes: vi.fn().mockReturnValue([]),
    getSettings: vi.fn().mockReturnValue({}),
    getRunnerState: vi.fn().mockReturnValue({ runners: [], headless: false, orchestratorModel: 'm' }),
    getInstalledRunners: vi.fn().mockReturnValue([]),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    ...overrides,
  } as unknown as OrchestratorPool;
}

/**
 * A daemon on a real socket, so the Host header the admission check reads is
 * the one the transport actually produced rather than one a test invented.
 */
async function startDaemon(pool: OrchestratorPool) {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  server.on('request', createRequestListener(createApp(pool, port)));
  attachWsHandler(server, pool, port);
  return {
    port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** Deliberately low-level: `fetch` refuses to set a Host or Origin header. */
function request(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers ?? {} },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function openSocket(url: string, options?: WebSocket.ClientOptions): Promise<
  { outcome: 'open'; first: string } | { outcome: 'refused'; status?: number }
> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('websocket timed out')); }, 5000);
    socket.on('message', (data) => {
      clearTimeout(timer);
      socket.close();
      resolve({ outcome: 'open', first: data.toString() });
    });
    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ outcome: 'refused', status: res.statusCode });
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve({ outcome: 'refused' });
    });
  });
}

describe('daemon admission control', () => {
  let pool: OrchestratorPool;
  let daemon: Awaited<ReturnType<typeof startDaemon>>;

  beforeEach(async () => {
    pool = fakePool();
    daemon = await startDaemon(pool);
  });

  afterEach(async () => { await daemon.close(); });

  describe('the CLI, which is the only supported client', () => {
    it('reaches the API over loopback with no origin', async () => {
      const res = await request(daemon.port, '/api/approvals/s1');
      expect(res.status).toBe(200);
    });

    it('answers an approval prompt', async () => {
      const res = await request(daemon.port, '/api/approvals/s1/ap-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted: true }),
      });
      expect(res.status).toBe(200);
      expect(pool.resolveApproval).toHaveBeenCalledWith('s1', 'ap-1', true);
    });

    it('opens the session stream', async () => {
      const result = await openSocket(`ws://127.0.0.1:${daemon.port}/ws/session/s1`);
      expect(result.outcome).toBe('open');
      expect(result.outcome === 'open' && JSON.parse(result.first)).toMatchObject({ type: 'connected', sessionId: 's1' });
      expect(pool.subscribe).toHaveBeenCalled();
    });

    it('reaches the API when it dials localhost by name', async () => {
      const res = await request(daemon.port, '/api/runners', { headers: { host: `localhost:${daemon.port}` } });
      expect(res.status).toBe(200);
    });
  });

  describe('a page in the developer’s browser', () => {
    const ROUTES: Array<[string, string, string | undefined]> = [
      ['GET', '/api/approvals/s1', undefined],
      ['GET', '/api/runners', undefined],
      ['GET', '/api/settings', undefined],
      ['GET', '/api/sessions', undefined],
      ['POST', '/api/approvals/s1/ap-1', JSON.stringify({ granted: true })],
      ['POST', '/api/plans/s1/generate', JSON.stringify({ goal: 'x' })],
      ['POST', '/api/settings', JSON.stringify({ env: { FOO: 'bar' } })],
    ];

    it.each(ROUTES)('is refused on %s %s', async (method, path, body) => {
      const res = await request(daemon.port, path, {
        method,
        headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(403);
    });

    // The body used to be parsed regardless of content type, which made every
    // POST reachable as a form-style simple request needing no preflight.
    it.each([
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
    ])('is refused when it dodges preflight with content-type %s', async (contentType) => {
      const res = await request(daemon.port, '/api/approvals/s1/ap-1', {
        method: 'POST',
        headers: { origin: 'http://evil.example', 'content-type': contentType },
        body: JSON.stringify({ granted: true }),
      });
      expect(res.status).toBe(403);
      expect(pool.resolveApproval).not.toHaveBeenCalled();
    });

    it('is refused even when the origin is a former allowlist entry', async () => {
      const res = await request(daemon.port, '/api/runners', { headers: { origin: 'http://localhost:5173' } });
      expect(res.status).toBe(403);
    });

    it('cannot open the session stream', async () => {
      const result = await openSocket(`ws://127.0.0.1:${daemon.port}/ws/session/s1`, {
        origin: 'http://evil.example',
      });
      expect(result).toEqual({ outcome: 'refused', status: 403 });
      expect(pool.subscribe).not.toHaveBeenCalled();
    });
  });

  describe('a hostile hostname rebound to loopback', () => {
    it('is refused on the API, where same-origin requests carry no origin header', async () => {
      const res = await request(daemon.port, '/api/runners', { headers: { host: 'evil.example' } });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/Host header/);
    });

    it('is refused on the approval-answering route', async () => {
      const res = await request(daemon.port, '/api/approvals/s1/ap-1', {
        method: 'POST',
        headers: { host: `evil.example:${daemon.port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ granted: true }),
      });
      expect(res.status).toBe(403);
      expect(pool.resolveApproval).not.toHaveBeenCalled();
    });

    it('is refused on the upgrade, before any subscription', async () => {
      const result = await openSocket(`ws://127.0.0.1:${daemon.port}/ws/session/s1`, {
        headers: { host: `evil.example:${daemon.port}` },
      });
      expect(result).toEqual({ outcome: 'refused', status: 403 });
      expect(pool.subscribe).not.toHaveBeenCalled();
    });

    it('is refused when it names loopback at a port that is not ours', async () => {
      const res = await request(daemon.port, '/api/runners', { headers: { host: '127.0.0.1:1' } });
      expect(res.status).toBe(403);
    });
  });

  it('sends no CORS headers, having no allowlist to answer from', async () => {
    const res = await request(daemon.port, '/api/runners');
    expect(res.status).toBe(200);
    const preflight = await request(daemon.port, '/api/runners', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(403);
  });
});

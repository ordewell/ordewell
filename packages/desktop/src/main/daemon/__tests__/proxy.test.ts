import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { tokenSubprotocols } from '@ordewell/core/daemon-client';
import type { StreamEvent } from '../../../shared/bridge';
import { DaemonProxy } from '../proxy';

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function daemon(answer: (seen: Seen, res: http.ServerResponse) => void): Promise<{ port: number; seen: Seen[]; wss: WebSocketServer }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry: Seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      answer(entry, res);
    });
  });
  const wss = new WebSocketServer({ server, handleProtocols: (protocols) => [...protocols][0] ?? false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.close(() => resolve());
  }));
  return { port: (server.address() as AddressInfo).port, seen, wss };
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('DaemonProxy.call', () => {
  it('adds the bearer and a loopback Host, and sends no Origin', async () => {
    const d = await daemon((_seen, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }).end('[{"id":"s1"}]'); });
    const proxy = new DaemonProxy({ port: () => d.port, token: () => 'tok-123' });
    const result = await proxy.call({ method: 'GET', path: '/api/sessions?workspace=%2Fw' });
    expect(result).toEqual({ ok: true, status: 200, data: [{ id: 's1' }] });
    const [seen] = d.seen;
    expect(seen?.url).toBe('/api/sessions?workspace=%2Fw');
    expect(seen?.headers.authorization).toBe('Bearer tok-123');
    expect(seen?.headers.host).toBe(`127.0.0.1:${d.port}`);
    expect(seen?.headers.origin).toBeUndefined();
    expect(seen?.headers.referer).toBeUndefined();
  });

  it('sends a JSON body with its length', async () => {
    const d = await daemon((_seen, res) => { res.writeHead(204).end(); });
    const proxy = new DaemonProxy({ port: () => d.port, token: () => 'tok' });
    const result = await proxy.call({ method: 'PUT', path: '/api/runners/codex', body: '{"enabled":false}' });
    expect(result).toEqual({ ok: true, status: 204, data: undefined });
    expect(d.seen[0]?.method).toBe('PUT');
    expect(d.seen[0]?.body).toBe('{"enabled":false}');
    expect(d.seen[0]?.headers['content-type']).toBe('application/json');
    expect(d.seen[0]?.headers['content-length']).toBe('17');
  });

  it('reads the token at each call, so a restarted daemon\'s new token is used', async () => {
    const d = await daemon((_seen, res) => { res.writeHead(200).end('{}'); });
    let token = 'first';
    const proxy = new DaemonProxy({ port: () => d.port, token: () => token });
    await proxy.call({ method: 'GET', path: '/api/server' });
    token = 'second';
    await proxy.call({ method: 'GET', path: '/api/server' });
    expect(d.seen.map((s) => s.headers.authorization)).toEqual(['Bearer first', 'Bearer second']);
  });

  it('sends no Authorization at all when there is no token', async () => {
    const d = await daemon((_seen, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"missing bearer token"}'); });
    const proxy = new DaemonProxy({ port: () => d.port, token: () => undefined });
    const result = await proxy.call({ method: 'GET', path: '/api/server' });
    expect(d.seen[0]?.headers.authorization).toBeUndefined();
    expect(result).toEqual({ ok: false, status: 401, error: 'missing bearer token', data: { error: 'missing bearer token' } });
  });

  it('passes a non-JSON error body as its text', async () => {
    const d = await daemon((_seen, res) => { res.writeHead(500).end('boom\n'); });
    const proxy = new DaemonProxy({ port: () => d.port, token: () => 't' });
    expect(await proxy.call({ method: 'GET', path: '/api/server' })).toEqual({ ok: false, status: 500, error: 'boom' });
  });

  it('says the daemon is not running and reports it unreachable when nothing listens', async () => {
    const port = await freePort();
    const onUnreachable = vi.fn();
    const proxy = new DaemonProxy({ port: () => port, token: () => 't', onUnreachable });
    expect(await proxy.call({ method: 'GET', path: '/api/server' })).toEqual({ ok: false, error: 'The daemon is not running.' });
    expect(onUnreachable).toHaveBeenCalledTimes(1);
  });
});

describe('DaemonProxy.stream', () => {
  it('opens the socket with the token as a subprotocol, no Origin, and relays JSON frames', async () => {
    const d = await daemon((_seen, res) => { res.writeHead(404).end(); });
    const upgrade = new Promise<http.IncomingHttpHeaders>((resolve) => {
      d.wss.on('connection', (socket, req) => {
        resolve(req.headers);
        socket.send('{"type":"run_snapshot"}');
        socket.send('not json');
        socket.close(1000, 'done');
      });
    });
    const proxy = new DaemonProxy({ port: () => d.port, token: () => 'tok-9' });
    const events: StreamEvent[] = [];
    proxy.stream('/ws/session/s1', (event) => events.push(event));

    const headers = await upgrade;
    expect(headers['sec-websocket-protocol']?.split(/,\s*/)).toEqual(tokenSubprotocols('tok-9'));
    expect(headers.origin).toBeUndefined();
    expect(headers.host).toBe(`127.0.0.1:${d.port}`);
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('closed'));
    expect(events).toEqual([{ kind: 'frame', frame: { type: 'run_snapshot' } }, { kind: 'closed', code: 1000, reason: 'done' }]);
  });

  it('closes at once, opening nothing, without a token', async () => {
    const proxy = new DaemonProxy({ port: () => 1, token: () => undefined });
    const events: StreamEvent[] = [];
    proxy.stream('/ws/session/s1', (event) => events.push(event));
    await vi.waitFor(() => expect(events).toEqual([{ kind: 'closed', code: 4401, reason: 'No daemon token to present.' }]));
  });

  it('delivers nothing after the caller closed it', async () => {
    const d = await daemon((_seen, res) => { res.writeHead(404).end(); });
    const connected = new Promise<void>((resolve) => { d.wss.on('connection', () => resolve()); });
    const proxy = new DaemonProxy({ port: () => d.port, token: () => 't' });
    const events: StreamEvent[] = [];
    const close = proxy.stream('/ws/session/s1', (event) => events.push(event));
    await connected;
    close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual([]);
  });
});

import { EventEmitter } from 'events';
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { WebSocketServer } from 'ws';
import { ApiClient } from '../apiClient';

/** Spin up a throwaway server that records which port served each request. */
function startServer(label: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ id: label, goal: '', runners: [], taskCount: 0, status: '', createdAt: '', updatedAt: '' }]));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

type HandlerFn = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function startCustomServer(handler: HandlerFn): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe('ApiClient', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

  it('keeps each instance bound to its own port (no shared static clobbering)', async () => {
    const a = await startServer('server-a');
    const b = await startServer('server-b');
    servers.push(a, b);

    const clientA = new ApiClient(a.port);
    const clientB = new ApiClient(b.port);

    const [fromA, fromB] = await Promise.all([clientA.getSessions(), clientB.getSessions()]);
    expect(fromA[0].id).toBe('server-a');
    expect(fromB[0].id).toBe('server-b');
  });

  it('getCommands returns command list', async () => {
    const srv = await startCustomServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ commands: [{ name: 'tdd', description: 'Toggle TDD' }] }));
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);
    const result = await client.getCommands();
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].name).toBe('tdd');
  });

  it('sendCommand posts to /api/commands/:name', async () => {
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        expect(req.url).toBe('/api/commands/tdd');
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, settings: { tdd: { enabled: parsed.args.action === 'off' ? false : true } } }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);
    const result = await client.sendCommand('tdd', { action: 'off' });
    expect(result.ok).toBe(true);
    expect(result.settings?.tdd).toEqual({ enabled: false });
  });

  it('generatePlan posts to the caller-provided sessionId instead of minting its own', async () => {
    let requestedUrl = '';
    const srv = await startCustomServer((req, res) => {
      requestedUrl = req.url || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plan: { tasks: [] } }));
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);
    const result = await client.generatePlan('goal', undefined, undefined, 'session-fixed-id');
    expect(requestedUrl).toBe('/api/plans/session-fixed-id/generate');
    expect(result.sessionId).toBe('session-fixed-id');
  });

  it('streamPlanning delivers parsed WS events and close() ends the socket', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as { port: number }).port;
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'research_step', tool: 'read_file', args: '{}' }));
    });
    servers.push({ close: () => wss.close() });

    const client = new ApiClient(port);
    const events: unknown[] = [];
    const stream = client.streamPlanning('session-x', (e) => events.push(e));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([{ type: 'research_step', tool: 'read_file', args: '{}' }]);
    stream.close();
  });

  it('updateSettings sends PATCH to /api/settings with the payload', async () => {
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        expect(req.method).toBe('PATCH');
        expect(req.url).toBe('/api/settings');
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...parsed, saved: true }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);
    const result = await client.updateSettings({ modelAllowlist: { opencode: ['a', 'b'] } });
    expect(result).toEqual({ modelAllowlist: { opencode: ['a', 'b'] }, saved: true });
  });
});

describe('ApiClient — endpoints the TUI drives', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    servers.splice(0).forEach((s) => s.close());
    vi.restoreAllMocks();
  });

  it('fetches the provider model catalog', async () => {
    const server = await startCustomServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ path: req.url, models: [{ modelId: 'a/b' }], providers: ['openrouter'] }));
    });
    servers.push(server);

    const result = await new ApiClient(server.port).getModels();
    expect((result as any).path).toBe('/api/models');
    expect(result.models[0].modelId).toBe('a/b');
  });

  it('enables and disables a runner', async () => {
    let seen: { method?: string; url?: string; body: string } = { body: '' };
    const server = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen = { method: req.method, url: req.url, body };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(server);

    await new ApiClient(server.port).setRunnerEnabled('opencode', false);
    expect(seen.method).toBe('PUT');
    expect(seen.url).toBe('/api/runners/opencode');
    expect(JSON.parse(seen.body)).toEqual({ enabled: false });
  });

  it('reports a failed runner toggle', async () => {
    const server = await startCustomServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'nope' }));
    });
    servers.push(server);

    await expect(new ApiClient(server.port).setRunnerEnabled('opencode', true)).rejects.toThrow('nope');
  });

  it('updates a task through the generic plan mutation endpoint', async () => {
    let seen: { method?: string; url?: string; body?: unknown } = {};
    const server = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen = { method: req.method, url: req.url, body: JSON.parse(body) };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(server);

    await new ApiClient(server.port).updateTask('s1', 't1', { thinkingEffort: 'high' });
    expect(seen).toEqual({
      method: 'PUT',
      url: '/api/plans/s1/tasks/t1',
      body: { thinkingEffort: 'high' },
    });
  });

  it('allows a normal long planner turn instead of failing with Request timed out', async () => {
    const previous = process.env.ORDEWELL_HTTP_TIMEOUT_MS;
    delete process.env.ORDEWELL_HTTP_TIMEOUT_MS;

    vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, respond: (res: any) => void) => {
      const req = new EventEmitter() as any;
      req.write = vi.fn();
      req.destroy = vi.fn();
      req.end = () => {
        process.nextTick(() => {
          if (Number(options.timeout) < 900_000) {
            req.emit('timeout');
            return;
          }
          const res = new EventEmitter() as any;
          res.statusCode = 200;
          respond(res);
          res.emit('data', Buffer.from(JSON.stringify({ plan: { tasks: [] } })));
          res.emit('end');
        });
      };
      return req;
    }) as any);

    try {
      await expect(new ApiClient(3742).sendConversationMessage('s1', 'remove the header label'))
        .resolves.toEqual({ tasks: [] });
    } finally {
      if (previous === undefined) delete process.env.ORDEWELL_HTTP_TIMEOUT_MS;
      else process.env.ORDEWELL_HTTP_TIMEOUT_MS = previous;
    }
  });
});

describe('ApiClient — adopting a saved session', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

  it('asks the server to make a saved session live', async () => {
    let seen: { method?: string; url?: string } = {};
    const server = await startCustomServer((req, res) => {
      seen = { method: req.method, url: req.url };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, plan: { tasks: [{ id: 't1' }] }, goal: 'Rate limiting' }));
    });
    servers.push(server);

    const result = await new ApiClient(server.port).adoptSession('s1', '/ws');

    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/api/sessions/s1/load?workspace=%2Fws');
    expect(result.goal).toBe('Rate limiting');
    expect(result.plan.tasks).toHaveLength(1);
  });

  it('omits the workspace when none is given', async () => {
    let url = '';
    const server = await startCustomServer((req, res) => {
      url = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, plan: {}, goal: '' }));
    });
    servers.push(server);

    await new ApiClient(server.port).adoptSession('s1');
    expect(url).toBe('/api/sessions/s1/load');
  });

  it('reports a session the server could not find', async () => {
    const server = await startCustomServer((_req, res) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Session not found' }));
    });
    servers.push(server);

    await expect(new ApiClient(server.port).adoptSession('s1')).rejects.toThrow('Session not found');
  });
});

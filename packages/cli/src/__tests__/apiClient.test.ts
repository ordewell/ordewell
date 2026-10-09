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

  it('adopts a saved session a restarted daemon no longer holds, then retries the call once', async () => {
    const hits: string[] = [];
    let adopted = false;
    const srv = await startCustomServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.startsWith('/api/sessions/session-1/load')) {
        adopted = true;
        return res.end(JSON.stringify({ ok: true }));
      }
      if (!adopted) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: 'Session not found', code: 'session_not_found' }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(srv);

    await new ApiClient(srv.port, '/work/app').taskControl('session-1', 't1', 'retry');

    expect(hits).toEqual([
      'POST /api/plans/session-1/tasks/t1/retry',
      'POST /api/sessions/session-1/load?workspace=%2Fwork%2Fapp',
      'POST /api/plans/session-1/tasks/t1/retry',
    ]);
  });

  it('leaves a session that cannot be adopted as not found, without retrying', async () => {
    const hits: string[] = [];
    const srv = await startCustomServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Session not found', code: 'session_not_found' }));
    });
    servers.push(srv);

    await expect(new ApiClient(srv.port, '/work/app').taskControl('session-9', 't1', 'retry')).rejects.toThrow('Session not found');
    expect(hits).toHaveLength(2);
  });

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

    await vi.waitFor(() => expect(events).toEqual([{ type: 'research_step', tool: 'read_file', args: '{}' }]));
    stream.close();
  });

  it('streamPlanning says when its socket is open, and settles too when it cannot connect', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as { port: number }).port;
    let subscribed = false;
    wss.on('connection', () => { subscribed = true; });
    servers.push({ close: () => wss.close() });

    const stream = new ApiClient(port).streamPlanning('session-x', () => {});
    await stream.ready;
    await vi.waitFor(() => expect(subscribed).toBe(true));
    stream.close();

    const refused = new ApiClient(1).streamPlanning('session-x', () => {});
    await expect(refused.ready).resolves.toBeUndefined();
    refused.close();
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
    expect((result as { path?: string }).path).toBe('/api/models');
    expect(result.models?.[0]?.modelId).toBe('a/b');
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

  it('reads a structured task’s saved log: its attempts, then one attempt’s events', async () => {
    const urls: string[] = [];
    const server = await startCustomServer((req, res) => {
      urls.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url?.includes('/log/') ? { attempt: 2, events: [{ type: 'text', text: 'hi' }] } : { attempts: [1, 2] }));
    });
    servers.push(server);

    const client = new ApiClient(server.port);
    expect(await client.getTaskLogAttempts('s1', 't 1', '/ws')).toEqual([1, 2]);
    expect(await client.getTaskLog('s1', 't 1', 2, '/ws')).toEqual([{ type: 'text', text: 'hi' }]);
    expect(urls).toEqual(['/api/sessions/s1/tasks/t%201/log?workspace=%2Fws', '/api/sessions/s1/tasks/t%201/log/2?workspace=%2Fws']);
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

    vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, respond: (res: http.IncomingMessage) => void) => {
      const req = new EventEmitter() as EventEmitter & http.ClientRequest;
      req.write = vi.fn();
      req.destroy = vi.fn();
      req.end = () => {
        process.nextTick(() => {
          if (Number(options.timeout) < 900_000) {
            req.emit('timeout');
            return;
          }
          const res = new EventEmitter() as EventEmitter & http.IncomingMessage;
          res.statusCode = 200;
          respond(res);
          res.emit('data', Buffer.from(JSON.stringify({ plan: { tasks: [] } })));
          res.emit('end');
        });
        return req;
      };
      return req;
    }) as typeof http.request);

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
      res.end(JSON.stringify({ error: 'Session not found', code: 'session_not_found' }));
    });
    servers.push(server);

    await expect(new ApiClient(server.port).adoptSession('s1')).rejects.toThrow('Session not found');
  });

  it('sends, takes back and interrupts on a task\'s own routes, and surfaces a refusal', async () => {
    const hits: string[] = [];
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        hits.push(`${req.method} ${req.url} ${body}`.trim());
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.endsWith('/interrupt')) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'Task "Only" runs in a terminal' }));
        }
        res.end(JSON.stringify(req.method === 'DELETE' ? { removed: true } : { id: 'msg-1' }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);

    expect(await client.sendTaskMessage('s1', 't1', 'use Postgres')).toEqual({ id: 'msg-1' });
    expect(await client.removeQueuedTaskMessage('s1', 't1', 'msg-1')).toEqual({ removed: true });
    await expect(client.interruptTask('s1', 't1')).rejects.toThrow('runs in a terminal');

    expect(hits).toEqual([
      'POST /api/plans/s1/tasks/t1/messages {"text":"use Postgres"}',
      'DELETE /api/plans/s1/tasks/t1/messages/msg-1',
      'POST /api/plans/s1/tasks/t1/interrupt',
    ]);
  });

  it('force sends a new or a queued message on its own routes, and surfaces a refusal (ADR-0023, F1)', async () => {
    const hits: string[] = [];
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        hits.push(`${req.method} ${req.url} ${body}`.trim());
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.includes('/t2/')) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'Task "Two" runs in a terminal, which cannot take a message sent now' }));
        }
        res.end(JSON.stringify(req.url?.endsWith('/messages/now') ? { id: 'msg-3' } : { sent: true }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);

    expect(await client.forceSendTaskMessage('s1', 't1', 'stop now')).toEqual({ id: 'msg-3' });
    expect(await client.forceSendQueuedTaskMessage('s1', 't1', 'msg-2')).toEqual({ sent: true });
    await expect(client.forceSendTaskMessage('s1', 't2', 'stop now')).rejects.toThrow('cannot take a message sent now');

    expect(hits.slice(0, 2)).toEqual([
      'POST /api/plans/s1/tasks/t1/messages/now {"text":"stop now"}',
      'POST /api/plans/s1/tasks/t1/messages/msg-2/now',
    ]);
  });

  it('continues a finished task on its own route, and surfaces a refusal (ADR-0018, K1)', async () => {
    const hits: string[] = [];
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        hits.push(`${req.method} ${req.url} ${body}`.trim());
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.includes('/t2/')) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'Task "Two" cannot be continued: it ran in a terminal' }));
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);

    expect(await client.continueTask('s1', 't1', 'also handle arrays')).toEqual({ ok: true });
    await expect(client.continueTask('s1', 't2', 'go on')).rejects.toThrow('cannot be continued');

    expect(hits[0]).toBe('POST /api/plans/s1/tasks/t1/continue {"text":"also handle arrays"}');
  });

  it('answers a planner prompt with a yes/no and a runner\'s request with its whole decision', async () => {
    const hits: string[] = [];
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        hits.push(`${req.method} ${req.url} ${body}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);

    await client.respondToApproval('s1', 'ap-1', true);
    await client.respondToApproval('s1', 'ap-2', { decision: 'deny', note: 'not there' });
    expect(hits).toEqual([
      'POST /api/approvals/s1/ap-1 {"granted":true}',
      'POST /api/approvals/s1/ap-2 {"decision":"deny","note":"not there"}',
    ]);
  });
});


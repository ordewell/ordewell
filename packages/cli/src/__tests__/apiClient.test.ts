import { EventEmitter } from 'events';
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { WebSocketServer } from 'ws';
import { ApiClient, DaemonError, deliveryOf } from '../apiClient';

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

    await new ApiClient(srv.port, '/work/app').execute('session-1', { command: 'retry_task', task: 't1', from: 'fresh' });

    expect(hits).toEqual([
      'POST /api/plans/session-1/execute-command',
      'POST /api/sessions/session-1/load?workspace=%2Fwork%2Fapp',
      'POST /api/plans/session-1/execute-command',
    ]);
  });

  it('reads what waits on the user, and answers one by its id, on the daemon\'s two routes (ADR-0053)', async () => {
    const hits: string[] = [];
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        hits.push(`${req.method} ${req.url} ${body}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.method === 'GET' ? { escalations: [{ id: 'failed:t1:1' }] } : { ok: true, message: 'Retrying.' }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port, '/work/app');

    expect(await client.escalations('session-1')).toEqual([{ id: 'failed:t1:1' }]);
    expect(await client.answerEscalation('session-1', { id: 'failed:t1:1', option: 'retry' })).toEqual({ ok: true, message: 'Retrying.' });

    expect(hits).toEqual([
      'GET /api/plans/session-1/escalations ',
      'POST /api/plans/session-1/escalations/answer {"id":"failed:t1:1","option":"retry"}',
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

    await expect(new ApiClient(srv.port, '/work/app').execute('session-9', { command: 'retry_task', task: 't1', from: 'fresh' })).rejects.toThrow('Session not found');
    expect(hits).toHaveLength(2);
  });

  // ADR-0049: "not found" would send the user to /sessions to reload it, which
  // is refused the same way; who holds the session is what they need to hear.
  it('surfaces a re-adoption refused because another host holds the session, not the 404 before it', async () => {
    const hits: string[] = [];
    const holder = { hostId: 'host-a', pid: 37797, host: { kind: 'daemon', port: 3742 }, since: '2026-10-24T01:40:00.000Z', heartbeatAt: '2026-10-24T01:54:00.000Z', runnerGroups: [] };
    const srv = await startCustomServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.startsWith('/api/sessions/session-1/load')) {
        res.statusCode = 409;
        return res.end(JSON.stringify({ error: 'This session is open in another Ordewell host: the Ordewell daemon on port 3742 (pid 37797)', code: 'session_held', sessionHeld: { holder } }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Session not found', code: 'session_not_found' }));
    });
    servers.push(srv);

    const err = await new ApiClient(srv.port, '/work/app').execute('session-1', { command: 'retry_task', task: 't1', from: 'fresh' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe('session_held');
    expect((err as DaemonError).status).toBe(409);
    expect((err as DaemonError).sessionHeld?.holder.pid).toBe(37797);
    expect((err as Error).message).toContain('pid 37797');
    // Refused, so never retried.
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

  // Before this, each returned the error body as its success type: `stop`
  // printed "Execution stopped." and exited 0 while nothing had stopped.
  it.each([
    ['stopExecution', (client: ApiClient) => client.stopExecution('s1')],
    ['closeSession', (client: ApiClient) => client.closeSession('s1')],
    ['cancelPlanning', (client: ApiClient) => client.cancelPlanning('s1')],
    ['getSessions', (client: ApiClient) => client.getSessions()],
  ])('turns a 500 from %s into a DaemonError', async (_name, call) => {
    const srv = await startCustomServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    });
    servers.push(srv);

    const result = call(new ApiClient(srv.port));
    await expect(result).rejects.toBeInstanceOf(DaemonError);
    await expect(result).rejects.toThrow('boom');
  });

  it('reads a multi-byte character split across response chunks intact', async () => {
    const body = Buffer.from(JSON.stringify([{ id: 'prompt-😀-é', goal: '', runners: [], taskCount: 0, status: '', createdAt: '', updatedAt: '' }]));
    // Cut inside the 4-byte emoji so the first chunk ends on a partial sequence.
    const cut = body.indexOf(Buffer.from('😀')) + 2;
    const srv = await startCustomServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(body.subarray(0, cut));
      setTimeout(() => res.end(body.subarray(cut)), 20);
    });
    servers.push(srv);

    const sessions = await new ApiClient(srv.port).getSessions();
    expect(sessions[0].id).toBe('prompt-😀-é');
  });

  it('reads a refused WebSocket upgrade body with a split multi-byte character intact', async () => {
    const body = Buffer.from(JSON.stringify({ error: 'Token file: ~/café-😀/token' }));
    const cut = body.indexOf(Buffer.from('😀')) + 1;
    const srv = await startCustomServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.write(body.subarray(0, cut));
      setTimeout(() => res.end(body.subarray(cut)), 20);
    });
    servers.push(srv);
    const port = srv.port;

    const failure = await new ApiClient(port).streamExecution('session-x', () => {}).then(() => undefined, (err: Error) => err);
    expect(failure?.message).toBe('Token file: ~/café-😀/token');
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

  // A converse closes its stream once its turn settles, and the next queued
  // prompt's converse opens another at once. Frames still arriving on the old
  // one during its close handshake were heard twice: a reply streamed doubled.
  it('streamPlanning delivers nothing more once closed, even frames already on the wire', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as { port: number }).port;
    let markGone!: () => void;
    const gone = new Promise<void>((resolve) => { markGone = resolve; });
    wss.on('connection', (ws) => {
      // Both frames are queued in this turn, before the client's handler sees
      // the first and closes, so the second is on the wire and must be dropped.
      ws.send(JSON.stringify({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' }));
      ws.send(JSON.stringify({ type: 'planner_text_delta', turnId: 't2', segmentId: 's', text: 'uno' }));
      ws.on('close', markGone);
    });
    servers.push({ close: () => wss.close() });

    const events: { type: string }[] = [];
    const stream = new ApiClient(port).streamPlanning('session-x', (e) => {
      events.push(e as { type: string });
      if ((e as { type: string }).type === 'planner_turn_ended') stream.close();
    });
    await stream.ready;
    // The close handshake completing means the client has handled what the
    // server queued; a fixed sleep would race a loaded machine's handshake.
    await gone;

    expect(events.map((e) => e.type)).toEqual(['planner_turn_ended']);
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

  // One daemon serves several workspaces: the planner's model in a settings
  // answer is judged against the runner catalog of the one this client is in.
  it('getSettings names its workspace, and the session whose values it wants', async () => {
    const srv = await startCustomServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    });
    servers.push(srv);
    const client = new ApiClient(srv.port, '/work/space B');

    const withSession = await client.getSettings('s1');
    const without = await client.getSettings();

    expect((withSession as { path?: string }).path).toBe('/api/settings?sessionId=s1&workspace=%2Fwork%2Fspace%20B');
    expect((without as { path?: string }).path).toBe('/api/settings?workspace=%2Fwork%2Fspace%20B');
  });

  it('updateSettings sends PATCH to /api/settings with the payload and its workspace', async () => {
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
    const client = new ApiClient(srv.port, '/work/b');
    const result = await client.updateSettings({ modelAllowlist: { opencode: ['a', 'b'] } });
    expect(result).toEqual({ modelAllowlist: { opencode: ['a', 'b'] }, workspace: '/work/b', saved: true });
    const run = await client.updateRunSettings({ autorun: true }, 's1');
    expect(run).toEqual({ run: { autorun: true }, sessionId: 's1', workspace: '/work/b', saved: true });
  });
});

describe('ApiClient — endpoints the TUI drives', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    servers.splice(0).forEach((s) => s.close());
    vi.restoreAllMocks();
  });

  it('fetches the provider model catalog of its workspace', async () => {
    const server = await startCustomServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ path: req.url, models: [{ modelId: 'a/b' }], providers: ['openrouter'] }));
    });
    servers.push(server);

    const result = await new ApiClient(server.port, '/work/space B').getModels();
    expect((result as { path?: string }).path).toBe('/api/models?workspace=%2Fwork%2Fspace%20B');
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
    expect(await client.getTaskLogAttempts('s1', 't 1', '/ws')).toEqual({ attempts: [1, 2] });
    expect(await client.getTaskLog('s1', 't 1', 2, '/ws')).toEqual({ attempt: 2, events: [{ type: 'text', text: 'hi' }] });
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

  // The planner-turn routes send nothing until the turn ends, so a socket-idle
  // timeout reads a turn that is still running as a failure.
  describe('socket idle timeout', () => {
    const previous = process.env.ORDEWELL_HTTP_TIMEOUT_MS;
    afterEach(() => {
      if (previous === undefined) delete process.env.ORDEWELL_HTTP_TIMEOUT_MS;
      else process.env.ORDEWELL_HTTP_TIMEOUT_MS = previous;
    });

    /** The socket timer an agent names for itself; `http.Agent` does not type its options. */
    const agentTimeout = (agent: unknown): number | undefined => (agent as { options?: { timeout?: number } }).options?.timeout;

    /** Answers `{}` and records the `timeout` option and the agent each request was given. */
    function recordTimeouts(): Array<{ timeout: number | undefined; agent: unknown }> {
      const seen: Array<{ timeout: number | undefined; agent: unknown }> = [];
      vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, respond: (res: http.IncomingMessage) => void) => {
        seen.push({ timeout: options.timeout, agent: options.agent });
        const req = new EventEmitter() as EventEmitter & http.ClientRequest;
        req.write = vi.fn();
        req.destroy = vi.fn();
        req.end = () => {
          process.nextTick(() => {
            const res = new EventEmitter() as EventEmitter & http.IncomingMessage;
            res.statusCode = 200;
            respond(res);
            res.emit('data', Buffer.from(JSON.stringify({ plan: { tasks: [] }, runners: [] })));
            res.emit('end');
          });
          return req;
        };
        return req;
      }) as typeof http.request);
      return seen;
    }

    const turnCalls: Array<[string, (c: ApiClient) => Promise<unknown>]> = [
      ['startConversation', (c) => c.startConversation('s1', 'goal')],
      ['sendConversationMessage', (c) => c.sendConversationMessage('s1', 'hi')],
      ['forceSendPlannerMessage', (c) => c.forceSendPlannerMessage('s1', 'hi')],
      ['compactConversation', (c) => c.compactConversation('s1')],
      ['generatePlan', (c) => c.generatePlan('goal')],
    ];

    // A turn answers only when it ends, and one that waits on exploration
    // agents idles past five seconds routinely. Node's global agent carries a
    // 5000 ms socket timer of its own, which cut such a turn off and reported
    // the 15 minutes it never had.
    it('waits out a planner turn that stays silent past five seconds', async () => {
      delete process.env.ORDEWELL_HTTP_TIMEOUT_MS;
      const srv = await startCustomServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          setTimeout(() => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ plan: { tasks: [] } }));
          }, 5200);
        });
      });
      servers.push(srv);

      await expect(new ApiClient(srv.port).sendConversationMessage('s1', 'hi')).resolves.toEqual({ tasks: [] });
    }, 20_000);

    it.each(turnCalls)('does not bound %s by socket idleness', async (_name, call) => {
      delete process.env.ORDEWELL_HTTP_TIMEOUT_MS;
      const seen = recordTimeouts();
      await call(new ApiClient(3742));
      expect(seen).toHaveLength(1);
      expect(seen[0].timeout ?? 0).toBe(0);
      // Asking for no bound is not enough on its own: unnamed, the request
      // takes `http.globalAgent`, whose 5000 ms socket timer re-arms idleness
      // on it anyway. The client's own agent names none.
      expect(seen[0].agent).toBeInstanceOf(http.Agent);
      expect(seen[0].agent).not.toBe(http.globalAgent);
      expect(agentTimeout(seen[0].agent)).toBe(0);
    });

    it('still bounds a short call by the default idle timeout, on that same agent', async () => {
      delete process.env.ORDEWELL_HTTP_TIMEOUT_MS;
      const seen = recordTimeouts();
      await new ApiClient(3742).getRunners();
      expect(seen.map((s) => s.timeout)).toEqual([900_000]);
      expect(seen[0].agent).toBeInstanceOf(http.Agent);
      expect(seen[0].agent).not.toBe(http.globalAgent);
    });

    it('lets ORDEWELL_HTTP_TIMEOUT_MS override both', async () => {
      process.env.ORDEWELL_HTTP_TIMEOUT_MS = '1234';
      const seen = recordTimeouts();
      const client = new ApiClient(3742);
      await client.getRunners();
      await client.sendConversationMessage('s1', 'hi');
      expect(seen.map((s) => s.timeout)).toEqual([1234, 1234]);
      expect(seen[1].agent).toBe(seen[0].agent);
    });
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

  it('hands on the run the session holds', async () => {
    const run = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
    const server = await startCustomServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, plan: {}, goal: '', run }));
    });
    servers.push(server);

    expect((await new ApiClient(server.port).adoptSession('s1')).run).toEqual(run);
  });

  it('hands on the planner turn the session is running', async () => {
    const server = await startCustomServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, plan: {}, goal: '', plannerTurnId: 't1' }));
    });
    servers.push(server);

    expect((await new ApiClient(server.port).adoptSession('s1')).plannerTurnId).toBe('t1');
  });

  it('hands on the planner compaction the session is running, which no turn names', async () => {
    const started = { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'auto', at: '2026-01-02T00:00:00.000Z' } };
    const server = await startCustomServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, plan: {}, goal: '', plannerCompaction: started }));
    });
    servers.push(server);

    const adopted = await new ApiClient(server.port).adoptSession('s1');

    expect(adopted.plannerCompaction).toEqual(started);
    expect(adopted).not.toHaveProperty('plannerTurnId');
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

  it('sends one command to the one route, answering the seam\'s line and payload, and surfaces a refusal', async () => {
    const hits: string[] = [];
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        hits.push(`${req.method} ${req.url} ${body}`.trim());
        res.setHeader('Content-Type', 'application/json');
        if (body.includes('interrupt_task')) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'Task "Only" is not running', code: 'refused' }));
        }
        res.end(JSON.stringify({ ok: true, message: 'Sent.', payload: { kind: 'message', id: 'msg-1' } }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);

    expect(await client.execute('s1', { command: 'message_task', task: 't1', text: 'use Postgres' })).toEqual({ ok: true, message: 'Sent.', payload: { kind: 'message', id: 'msg-1' } });
    await expect(client.execute('s1', { command: 'interrupt_task', task: 't1' })).rejects.toThrow('is not running');

    expect(hits).toEqual([
      'POST /api/plans/s1/execute-command {"command":"message_task","task":"t1","text":"use Postgres"}',
      'POST /api/plans/s1/execute-command {"command":"interrupt_task","task":"t1"}',
    ]);
  });

  it('runs a task runner\'s own command on its route (#66)', async () => {
    const hits: string[] = [];
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        hits.push(`${req.method} ${req.url} ${body}`.trim());
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'msg-4' }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);

    expect(await client.invokeTaskCommand('s1', 't1', 'compact', 'keep the API notes')).toEqual({ id: 'msg-4' });
    expect(hits).toEqual(['POST /api/plans/s1/tasks/t1/commands {"name":"compact","args":"keep the API notes"}']);
  });

  it('send now in the planner chat posts to the converse/now route (ADR-0023, F5)', async () => {
    const hits: string[] = [];
    const srv = await startCustomServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        hits.push(`${req.method} ${req.url} ${body}`.trim());
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ plan: { tasks: [] } }));
      });
    });
    servers.push(srv);
    const client = new ApiClient(srv.port);

    expect(await client.forceSendPlannerMessage('s1', 'use Postgres instead')).toEqual({ tasks: [] });

    expect(hits).toEqual(['POST /api/plans/s1/converse/message/now {"message":"use Postgres instead"}']);
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


describe('deliveryOf', () => {
  it('reads a daemon refusal as an answer', () => {
    expect(deliveryOf(new DaemonError('no key', 400))).toBe('answered');
  });

  it('reads a refused connection as never delivered', () => {
    expect(deliveryOf(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3742'), { code: 'ECONNREFUSED' }))).toBe('refused');
  });

  it.each(['Request timed out', 'socket hang up', 'read ECONNRESET', 'write EPIPE'])('reads "%s" as an unknown outcome', (message) => {
    expect(deliveryOf(new Error(message))).toBe('unknown');
  });

  // The response arrived, so the request was delivered even though its body
  // could not be used. Calling that unknown is what made the TUI read the
  // session back as if the daemon might still be running the turn.
  it('reads a 200 whose body cannot be used as an answer, not as a lost request', async () => {
    const server = await startCustomServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('null');
    });
    try {
      const err = await new ApiClient(server.port).startConversation('s1', 'goal').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(deliveryOf(err)).not.toBe('unknown');
    } finally {
      server.close();
    }
  });
});

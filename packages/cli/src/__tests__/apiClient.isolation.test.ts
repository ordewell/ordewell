import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { WebSocketServer } from 'ws';
import { ApiClient } from '../apiClient';

type Seen = { method?: string; url?: string };

function startServer(status: number, body: unknown): Promise<{ port: number; seen: Seen; close: () => void }> {
  const seen: Seen = {};
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, seen, close: () => server.close() });
    });
  });
}

describe('ApiClient isolation endpoints', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

  async function client(status: number, body: unknown) {
    const srv = await startServer(status, body);
    servers.push(srv);
    return { api: new ApiClient(srv.port), seen: srv.seen };
  }

  it('reviewRunDiff reads the integration diff', async () => {
    const { api, seen } = await client(200, { diff: 'diff --git a/x b/x\n' });
    expect(await api.reviewRunDiff('s1')).toBe('diff --git a/x b/x\n');
    expect([seen.method, seen.url]).toEqual(['GET', '/api/plans/s1/isolation/diff']);
  });

  it('mergeRun answers the outcome, conflict included', async () => {
    const { api, seen } = await client(200, { outcome: 'conflict', repo: '.', files: ['a.txt'] });
    expect(await api.mergeRun('s1')).toEqual({ outcome: 'conflict', repo: '.', files: ['a.txt'] });
    expect([seen.method, seen.url]).toEqual(['POST', '/api/plans/s1/isolation/merge']);
  });

  it('mergeRun passes on each repository that blocked the merge, and what landed before one stopped it', async () => {
    const blocked = { outcome: 'blocked', blocked: [{ repo: 'web', reason: 'conflict', files: ['web.txt'] }] };
    expect(await (await client(200, blocked)).api.mergeRun('s1')).toEqual(blocked);
    const stopped = { outcome: 'failed', repo: 'web', landed: ['api'] };
    expect(await (await client(200, stopped)).api.mergeRun('s1')).toEqual(stopped);
  });

  it.each([
    ['discardRun', '/api/plans/s1/isolation/discard'],
    ['cleanupRun', '/api/plans/s1/isolation/cleanup'],
    ['continueWithStash', '/api/plans/s1/isolation/stash-and-continue'],
    ['continueWithoutIsolation', '/api/plans/s1/isolation/run-without'],
  ] as const)('%s posts to its route', async (method, url) => {
    const { api, seen } = await client(200, { ok: true });
    await api[method]('s1');
    expect([seen.method, seen.url]).toEqual(['POST', url]);
  });

  it('resolveConflictAsTask posts for the task and answers the plan', async () => {
    const { api, seen } = await client(200, { plan: { tasks: [] } });
    expect(await api.resolveConflictAsTask('s1', 't2')).toEqual({ tasks: [] });
    expect([seen.method, seen.url]).toEqual(['POST', '/api/plans/s1/tasks/t2/resolve-conflict']);
  });

  it("surfaces the daemon's refusal", async () => {
    const { api } = await client(400, { error: 'The run is still running — stop it first' });
    await expect(api.mergeRun('s1')).rejects.toThrow('The run is still running — stop it first');
  });
});

describe('ApiClient.streamExecution and a blocked run', () => {
  it('settles on isolation_blocked: nothing runs until the user chooses, and the choice opens its own stream', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'isolation_blocked', reason: 'dirty', message: 'dirty' }));
    });
    const events: string[] = [];

    await new ApiClient((wss.address() as { port: number }).port).streamExecution('s1', (e) => events.push(e.type));

    expect(events).toEqual(['isolation_blocked']);
    wss.close();
  });
});

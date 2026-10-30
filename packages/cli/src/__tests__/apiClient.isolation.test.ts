import { describe, it, expect, afterEach, vi } from 'vitest';
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

  it('revertPreview reads what a revert would take, a refusal included', async () => {
    const preview = { revertible: true, tasks: [{ taskId: 't 1', order: 1, title: 'One', repos: ['.'], dependent: false }] };
    const { api, seen } = await client(200, preview);
    expect(await api.revertPreview('s1', 't 1')).toEqual(preview);
    expect([seen.method, seen.url]).toEqual(['GET', '/api/plans/s1/tasks/t%201/revert-preview']);
    const refused = { revertible: false, reason: 'in-a-loop', message: 'Let the loop end first.' };
    expect(await (await client(200, refused)).api.revertPreview('s1', 't1')).toEqual(refused);
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
    const { api } = await client(400, { error: 'The run is still running: stop it first' });
    await expect(api.mergeRun('s1')).rejects.toThrow('The run is still running: stop it first');
  });
});

describe('ApiClient.streamExecution and a blocked run', () => {
  async function server(onConnection: (ws: import('ws').WebSocket) => void) {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', onConnection);
    return { wss, client: new ApiClient((wss.address() as { port: number }).port) };
  }

  it('stays open past isolation_blocked, so what still runs is shown while the user chooses', async () => {
    const { wss, client } = await server((ws) => {
      ws.send(JSON.stringify({ type: 'isolation_blocked', reason: 'dirty', message: 'dirty' }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'notice', level: 'info', message: 'ops task still running' }));
        ws.send(JSON.stringify({ type: 'execution_stopped' }));
      }, 50);
    });
    const events: string[] = [];

    await client.streamExecution('s1', (e) => events.push(e.type));

    expect(events).toEqual(['isolation_blocked', 'notice', 'execution_stopped']);
    wss.close();
  });

  it('ends the session\'s earlier stream when the choice opens a new one, so one run is never reported twice', async () => {
    const sockets: import('ws').WebSocket[] = [];
    const { wss, client } = await server((ws) => { sockets.push(ws); });
    const first: string[] = [];
    const second: string[] = [];

    const firstDone = client.streamExecution('s1', (e) => first.push(e.type));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const secondDone = client.streamExecution('s1', (e) => second.push(e.type));
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    await firstDone;
    for (const ws of sockets) ws.send(JSON.stringify({ type: 'notice', level: 'info', message: 'after' }));
    sockets[1].send(JSON.stringify({ type: 'execution_complete', summary: { total: 0, completed: 0, failed: 0 } }));
    await secondDone;

    expect(first).toEqual([]);
    expect(second).toEqual(['notice', 'execution_complete']);
    wss.close();
  });

  it('resolves lost, not rejects, when the socket errors after it opened', async () => {
    const { wss, client } = await server((ws) => {
      setTimeout(() => ws.terminate(), 20);
    });
    const ready = vi.fn();

    await expect(client.streamExecution('s1', () => {}, ready)).resolves.toBe('lost');

    expect(ready).toHaveBeenCalledWith();
    wss.close();
  });

  it('closes only the stream it is handed, not a newer one on the same session', async () => {
    const sockets: import('ws').WebSocket[] = [];
    const { wss, client } = await server((ws) => { sockets.push(ws); });
    const first = client.streamExecution('s1', () => {});
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const second = client.streamExecution('s1', () => {});
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await first;

    client.closeExecutionStream(first);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(secondSettled).toBe(false);

    client.closeExecutionStream(second);
    await second;
    wss.close();
  });
});

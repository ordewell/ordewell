import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ApiClient } from '../apiClient';
import { DaemonRefusal } from '@ordewell/core';

const path = (req: http.IncomingMessage) => new URL(req.url ?? '', 'http://x').pathname;

/** What the client sent, answered from a table: the wire is what a child route is pinned by. */
function recorder(answer: (req: http.IncomingMessage) => { status?: number; body: unknown }) {
  const hits: Array<{ line: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      hits.push({ line: `${req.method} ${req.url}`, body: raw ? JSON.parse(raw) : undefined });
      const { status = 200, body } = answer(req);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  return new Promise<{ client: ApiClient; hits: typeof hits; close(): void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ client: new ApiClient(port, '/w'), hits, close: () => server.close() });
    });
  });
}

describe('ApiClient: the plans below a root', () => {
  const open: Array<{ close(): void }> = [];
  afterEach(() => { open.splice(0).forEach((s) => s.close()); });

  it('lists a root\'s children and reads one, through the root', async () => {
    const srv = await recorder((req) => ({ body: path(req).endsWith('/children') ? { children: [] } : { child: { sessionId: 'c1' }, plan: null, position: { stream: 'x', seq: 0 } } }));
    open.push(srv);

    await expect(srv.client.listChildren('root')).resolves.toEqual({ children: [] });
    await expect(srv.client.getChild('root', 'c1')).resolves.toMatchObject({ child: { sessionId: 'c1' } });

    expect(srv.hits.map((h) => h.line)).toEqual(['GET /api/sessions/root/children?workspace=%2Fw', 'GET /api/sessions/root/children/c1?workspace=%2Fw']);
  });

  it('reads a child task\'s log on the child\'s routes, with the plan\'s exact task id', async () => {
    const srv = await recorder(() => ({ body: { attempts: [], position: { stream: 'x', seq: 0 } } }));
    open.push(srv);

    await srv.client.getChildTaskLogAttempts('root', 'c1', 'task/a');
    await srv.client.getChildTaskLog('root', 'c1', 'task/a', 2);

    expect(srv.hits.map((h) => h.line)).toEqual([
      'GET /api/sessions/root/children/c1/tasks/task%2Fa/log?workspace=%2Fw',
      'GET /api/sessions/root/children/c1/tasks/task%2Fa/log/2?workspace=%2Fw',
    ]);
  });

  // A raw `#` ends a URL's path and drops its query; a raw `/` or `?` names
  // another route. Every id the user can hold must ride as one segment.
  it('writes every path parameter as one encoded segment', async () => {
    const srv = await recorder(() => ({ body: { ok: true, children: [], attempts: [], tasks: [] } }));
    open.push(srv);
    const id = 'a#b/c?d';
    const enc = 'a%23b%2Fc%3Fd';

    await srv.client.listChildren(id);
    await srv.client.getChild(id, id);
    await srv.client.messageChild(id, id, 'hi');
    await srv.client.getSession(id, '/ws');
    await srv.client.executePlan(id);
    await srv.client.setRunnerEnabled(id, true);
    await srv.client.respondToApproval(id, id, true);

    expect(srv.hits.map((h) => h.line)).toEqual([
      `GET /api/sessions/${enc}/children?workspace=%2Fw`,
      `GET /api/sessions/${enc}/children/${enc}?workspace=%2Fw`,
      `POST /api/sessions/${enc}/children/${enc}/message?workspace=%2Fw`,
      `GET /api/sessions/${enc}?workspace=%2Fws`,
      `POST /api/plans/${enc}/execute?workspace=%2Fw`,
      `PUT /api/runners/${enc}`,
      `POST /api/approvals/${enc}/${enc}?workspace=%2Fw`,
    ]);
  });

  it('adopts a session whose id needs encoding by its encoded path', async () => {
    let adopted = false;
    const srv = await recorder((req) => {
      if (req.url?.includes('/load')) { adopted = true; return { body: { plan: { tasks: [] } } }; }
      return adopted ? { body: { ok: true } } : { status: 404, body: { error: 'Session not found', code: 'session_not_found' } };
    });
    open.push(srv);

    await srv.client.executePlan('s#1');

    expect(srv.hits.map((h) => h.line)).toEqual([
      'POST /api/plans/s%231/execute?workspace=%2Fw',
      expect.stringMatching(/^POST \/api\/sessions\/s%231\/load\?workspace=/),
      'POST /api/plans/s%231/execute?workspace=%2Fw',
    ]);
  });

  it('speaks to a subplanner and to a child\'s runner on their own routes', async () => {
    const srv = await recorder((req) => ({ body: path(req).endsWith('/children/c1/message') ? { status: 'queued' } : { message: 'sent' } }));
    open.push(srv);

    await expect(srv.client.messageChild('root', 'c1', 'how far along?')).resolves.toEqual({ status: 'queued' });
    await expect(srv.client.messageChildTask('root', 'c1', 'a', 'use the old table')).resolves.toEqual({ message: 'sent' });

    expect(srv.hits).toEqual([
      { line: 'POST /api/sessions/root/children/c1/message?workspace=%2Fw', body: { message: 'how far along?' } },
      { line: 'POST /api/sessions/root/children/c1/tasks/a/message?workspace=%2Fw', body: { message: 'use the old table' } },
    ]);
  });

  it('answers a child\'s checkpoint with the words it waits on, and never a raise or a force', async () => {
    const srv = await recorder(() => ({ body: { message: 'ok' } }));
    open.push(srv);

    await srv.client.answerChildCheckpoint('root', 'c1', 'a', { answer: 'approve', question: 'Ship it?' });
    await srv.client.answerChildCheckpoint('root', 'c1', 'a', { answer: 'approve', question: 'Ship it?', reason: 'yes, today' });
    await srv.client.answerChildCheckpoint('root', 'c1', 'a', { answer: 'reject', question: 'Ship it?', reason: 'not yet' });

    expect(srv.hits).toEqual([
      { line: 'POST /api/sessions/root/children/c1/tasks/a/checkpoint/approve?workspace=%2Fw', body: { question: 'Ship it?' } },
      { line: 'POST /api/sessions/root/children/c1/tasks/a/checkpoint/approve?workspace=%2Fw', body: { question: 'Ship it?', reason: 'yes, today' } },
      { line: 'POST /api/sessions/root/children/c1/tasks/a/checkpoint/reject?workspace=%2Fw', body: { question: 'Ship it?', reason: 'not yet' } },
    ]);
  });

  it('carries the daemon\'s refusal, code and words, to the caller', async () => {
    const srv = await recorder(() => ({ status: 409, body: { code: 'child_view_only', error: 'This plan has ended.' } }));
    open.push(srv);

    const refused = await srv.client.messageChild('root', 'c1', 'hello').catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(DaemonRefusal);
    expect(refused).toMatchObject({ code: 'child_view_only', status: 409, message: 'This plan has ended.' });
  });
});

describe('ApiClient.followChild', () => {
  async function server(onConnection: (ws: WebSocket, url: string) => void = () => {}) {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (ws, req) => onConnection(ws, req.url ?? ''));
    return { wss, client: new ApiClient((wss.address() as { port: number }).port, '/w') };
  }

  it('opens the child\'s own socket under the root and delivers its frames', async () => {
    const urls: string[] = [];
    const { wss, client } = await server((ws, url) => {
      urls.push(url);
      ws.send(JSON.stringify({ type: 'connected', sessionId: 'c1' }));
    });
    const events: string[] = [];

    const follow = client.followChild('root', 'c1', (e) => events.push(e.type));
    await expect(follow.ready).resolves.toBe(true);
    await vi.waitFor(() => expect(events).toEqual(['connected']));
    expect(urls).toEqual(['/ws/session/root/child/c1?workspace=%2Fw']);

    follow.close();
    await expect(follow.ended).resolves.toBeNull();
    wss.close();
  });

  it('says why the daemon closed it, since each close asks for something else', async () => {
    const { wss, client } = await server((ws) => { ws.close(4404, 'unknown child'); });

    const follow = client.followChild('root', 'gone', () => {});

    await expect(follow.ended).resolves.toEqual({ code: 4404 });
    wss.close();
  });

  it('reads a dropped socket as the abnormal close it is', async () => {
    const { wss, client } = await server((ws) => { setTimeout(() => ws.terminate(), 20); });

    const follow = client.followChild('root', 'c1', () => {});

    await expect(follow.ended).resolves.toEqual({ code: 1006 });
    wss.close();
  });
});

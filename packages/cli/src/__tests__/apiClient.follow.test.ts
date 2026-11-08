import { describe, it, expect, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ApiClient } from '../apiClient';

async function server(onConnection: (ws: WebSocket) => void = () => {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', onConnection);
  return { wss, client: new ApiClient((wss.address() as { port: number }).port, '/w') };
}

describe('ApiClient.followSession', () => {
  it('stays open past a run\'s end, so the next run is heard whoever starts it', async () => {
    const sockets: WebSocket[] = [];
    const { wss, client } = await server((ws) => { sockets.push(ws); });
    const events: string[] = [];

    const follow = client.followSession('s1', (e) => events.push(e.type));
    await expect(follow.ready).resolves.toBe(true);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].send(JSON.stringify({ type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0 } }));
    sockets[0].send(JSON.stringify({ type: 'task_started', taskId: 'a', order: 1, title: 'A', runner: 'claude-code' }));
    await vi.waitFor(() => expect(events).toEqual(['execution_complete', 'task_started']));

    follow.close();
    await expect(follow.ended).resolves.toBeNull();
    wss.close();
  });

  it('ends lost when the daemon goes away', async () => {
    const { wss, client } = await server((ws) => { setTimeout(() => ws.terminate(), 20); });

    const follow = client.followSession('s1', () => {});
    await follow.ready;

    await expect(follow.ended).resolves.toEqual({ code: 1006 });
    wss.close();
  });

  it('settles ready, never rejects, when nothing is listening', async () => {
    const { wss, client } = await server();
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    const follow = client.followSession('s1', () => {});
    await expect(follow.ready).resolves.toBe(false);
    await expect(follow.ended).resolves.toMatchObject({ code: 1006, error: expect.any(Error) });
  });
});

// A raw `#` fails to open the socket, and a raw `?` or `/` names another session to the daemon;
// the workspace says which project's session of the id the socket means.
describe('ApiClient socket paths', () => {
  async function upgradeUrl(open: (client: ApiClient) => { ready: Promise<unknown>; close: () => void }): Promise<string | undefined> {
    let url: string | undefined;
    const { wss, client } = await server();
    wss.on('connection', (_ws, request) => { url = request.url; });
    const socket = open(client);
    await socket.ready;
    socket.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    return url;
  }

  it('sends each session id as one encoded segment', async () => {
    expect(await upgradeUrl((c) => c.followSession('a#b', () => {}))).toBe('/ws/session/a%23b?workspace=%2Fw');
    expect(await upgradeUrl((c) => c.followSession('a?b', () => {}))).toBe('/ws/session/a%3Fb?workspace=%2Fw');
    expect(await upgradeUrl((c) => c.streamPlanning('a/b', () => {}))).toBe('/ws/session/a%2Fb?workspace=%2Fw');
  });

  it('sends a child plan\'s root and child ids as one encoded segment each', async () => {
    expect(await upgradeUrl((c) => c.followChild('r#1', 'c/2', () => {}))).toBe('/ws/session/r%231/child/c%2F2?workspace=%2Fw');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';
import { DAEMON_SUBPROTOCOL, DAEMON_TOKEN_SUBPROTOCOL_PREFIX, mintDaemonToken } from '@ordewell/core';
import { ApiClient } from '../apiClient';

/**
 * `os.homedir()` reads $HOME on POSIX, which is the seam both ends of the
 * handoff already go through — no module mocking required.
 */
let home = '';
let realHome: string | undefined;

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        close: () => server.close(),
      });
    });
  });
}

describe('the CLI authenticating to the daemon', () => {
  const servers: Array<{ close: () => void }> = [];

  beforeEach(() => {
    realHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-cli-token-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    servers.splice(0).forEach((s) => s.close());
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('attaches the token to an HTTP request with nothing asked of the user', async () => {
    let seen: string | undefined;
    const server = await startServer((req, res) => {
      seen = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ runners: [], headless: false, orchestratorModel: 'm' }));
    });
    servers.push(server);

    const { token } = mintDaemonToken(server.port);
    await new ApiClient(server.port).getRunners();

    expect(seen).toBe(`Bearer ${token}`);
  });

  it('picks up a token minted after the client was built, as a daemon restart mints a new one', async () => {
    const seen: Array<string | undefined> = [];
    const server = await startServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ runners: [], headless: false, orchestratorModel: 'm' }));
    });
    servers.push(server);

    const client = new ApiClient(server.port);
    const first = mintDaemonToken(server.port).token;
    await client.getRunners();
    const second = mintDaemonToken(server.port).token;
    await client.getRunners();

    expect(seen).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
  });

  it('surfaces the daemon’s token-file message rather than a bare HTTP failure', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthenticated: ... read it from /home/dev/.config/ordewell/server-1.token' }));
    });
    servers.push(server);

    await expect(new ApiClient(server.port).getRunners())
      .rejects.toThrow(/server-1\.token/);
  });

  describe('the session stream', () => {
    async function startWsServer(): Promise<{
      port: number;
      close: () => void;
      lastRequest: () => http.IncomingMessage | undefined;
    }> {
      const wss = new WebSocketServer({
        port: 0,
        handleProtocols: (protocols) => (protocols.has(DAEMON_SUBPROTOCOL) ? DAEMON_SUBPROTOCOL : false),
      });
      await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
      let last: http.IncomingMessage | undefined;
      wss.on('connection', (ws, req) => {
        last = req;
        ws.send(JSON.stringify({ type: 'connected', sessionId: 's1' }));
      });
      return {
        port: (wss.address() as { port: number }).port,
        close: () => wss.close(),
        lastRequest: () => last,
      };
    }

    it('carries the token as a subprotocol, never in the URL', async () => {
      const server = await startWsServer();
      servers.push(server);
      const { token } = mintDaemonToken(server.port);

      const client = new ApiClient(server.port);
      const events: unknown[] = [];
      const stream = client.streamPlanning('s1', (e) => events.push(e));
      await new Promise((r) => setTimeout(r, 150));
      stream.close();

      const request = server.lastRequest();
      expect(request?.headers['sec-websocket-protocol']).toContain(`${DAEMON_TOKEN_SUBPROTOCOL_PREFIX}${token}`);
      expect(request?.url).not.toContain(token);
      expect(events).toHaveLength(1);
    });

    it('carries the token on the execution stream too', async () => {
      const server = await startWsServer();
      servers.push(server);
      const { token } = mintDaemonToken(server.port);

      const client = new ApiClient(server.port);
      await new Promise<void>((resolve) => {
        client.streamExecution('s1', () => resolve(), undefined).catch(() => resolve());
      });

      expect(server.lastRequest()?.headers['sec-websocket-protocol'])
        .toContain(`${DAEMON_TOKEN_SUBPROTOCOL_PREFIX}${token}`);
    });

    it('reports a refused upgrade with the daemon’s explanation, not "Unexpected server response"', async () => {
      const server = await startServer((_req, res) => {
        // Not an upgrade response: exactly what the daemon sends a caller whose
        // token is stale.
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthenticated: read it from /home/dev/.config/ordewell/server-1.token' }));
      });
      servers.push(server);
      mintDaemonToken(server.port);

      const failure = await new ApiClient(server.port)
        .streamExecution('s1', () => {})
        .then(() => undefined, (err: Error) => err);

      expect(failure?.message).toContain('server-1.token');
    });
  });
});

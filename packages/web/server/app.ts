import { Hono } from 'hono';
import type { Server } from 'http';
import type { Duplex } from 'stream';
import { sessionsRoute } from './routes/sessions';
import { plansRoute } from './routes/plans';
import { runnersRoute } from './routes/runners';
import { modelsRoute } from './routes/models';
import { workspacesRoute } from './routes/workspaces';
import { approvalsRoute } from './routes/approvals';
import { settingsRoute } from './routes/settings';
import { commandsRoute } from './routes/commands';
import { createWsHandler } from './ws/stream';
import {
  decideAdmission,
  type AdmissionContext,
  type AdmissionDecision,
} from './security/admission';
import { OrchestratorPool } from './pool/orchestratorPool';

export function createApp(pool: OrchestratorPool, admission: AdmissionContext) {
  const app = new Hono();

  // There is no CORS allowlist: the daemon ships no browser front end, so a
  // browser has no legitimate reason to reach it at all. The bearer token
  // supersedes it, and covers every local caller rather than only browsers.
  app.use('*', async (c, next) => {
    const decision = decideAdmission({
      origin: c.req.header('origin') ?? null,
      // The request URL's authority is built from the Host header upstream, so
      // it is the same value; the fallback only matters when the header is
      // absent entirely, which fails the check anyway.
      host: c.req.header('host') ?? new URL(c.req.url).host,
      authorization: c.req.header('authorization') ?? null,
    }, admission);
    if (!decision.admit) return c.json({ error: decision.reason }, decision.status as 401 | 403);
    await next();
  });

  app.route('/api/sessions', sessionsRoute(pool));
  app.route('/api/plans', plansRoute(pool));
  app.route('/api/runners', runnersRoute(pool));
  app.route('/api/models', modelsRoute(pool));
  app.route('/api/settings', settingsRoute(pool));
  app.route('/api/commands', commandsRoute(pool));
  app.route('/api/workspaces', workspacesRoute());
  app.route('/api/approvals', approvalsRoute(pool));

  return app;
}

export function attachWsHandler(server: Server, pool: OrchestratorPool, admission: AdmissionContext) {
  const handler = createWsHandler(pool);
  server.on('upgrade', (request, socket, head) => {
    const decision = decideAdmission({
      origin: request.headers.origin ?? null,
      host: request.headers.host ?? null,
      authorization: request.headers.authorization ?? null,
      secWebSocketProtocol: request.headers['sec-websocket-protocol'] ?? null,
    }, admission);
    if (!decision.admit) {
      refuseUpgrade(socket, decision);
      return;
    }

    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    if (url.pathname.startsWith('/ws/session/')) {
      handler(request, socket, head);
    } else {
      socket.destroy();
    }
  });
}

const REASON_PHRASE: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden' };

function refuseUpgrade(socket: Duplex, decision: Extract<AdmissionDecision, { admit: false }>): void {
  const body = JSON.stringify({ error: decision.reason });
  socket.end(
    `HTTP/1.1 ${decision.status} ${REASON_PHRASE[decision.status] ?? 'Forbidden'}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `\r\n${body}`,
  );
  socket.destroy();
}

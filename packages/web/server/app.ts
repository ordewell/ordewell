import { Hono } from 'hono';
import type { Server } from 'http';
import type { Duplex } from 'stream';
import { childrenRoute } from './routes/children';
import { sessionsRoute } from './routes/sessions';
import { plansRoute } from './routes/plans';
import { runnersRoute } from './routes/runners';
import { modelsRoute } from './routes/models';
import { workspacesRoute } from './routes/workspaces';
import { approvalsRoute } from './routes/approvals';
import { settingsRoute } from './routes/settings';
import { commandsRoute } from './routes/commands';
import { filesRoute, gitRoute, taskDiffRoute } from './routes/workspaceRead';
import { fileWriteRoute, gitWriteRoute, mergePreflightRoute } from './routes/workspaceWrite';
import { WebConfig } from './adapters/WebConfig';
import { createWsHandler } from './ws/stream';
import {
  decideAdmission,
  type AdmissionContext,
  type AdmissionDecision,
} from './security/admission';
import { OrchestratorPool } from './pool/orchestratorPool';
import {
  DAEMON_CONTRACT,
  createUserGit,
  createWorkspaceReader,
  landingRuns,
  type ServerInfoResponse,
  type UserGit,
  type WorkspaceReader,
} from '@ordewell/core';
import { serverVersion } from './utils/serverVersion';

/**
 * The user's git actions (ADR-0062). The pool answers only whether a run is
 * live and where its timeline is: an action never takes a session's lease.
 */
export function userGitFor(pool: OrchestratorPool, reader: WorkspaceReader): UserGit {
  return createUserGit({
    reader,
    landingRuns: (checkout) => landingRuns(checkout, (workspace, sessionId, plan) => pool.userRunIsLive(sessionId, workspace, plan)),
    record: (workspace, held, text) => pool.recordUserAction(held.sessionId, workspace, text),
  });
}

export function createApp(
  pool: OrchestratorPool,
  admission: AdmissionContext,
  reader: WorkspaceReader = createWorkspaceReader({ config: new WebConfig() }),
  userGit: UserGit = userGitFor(pool, reader),
) {
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

  // `ordewell stop --server` verifies a PID file against the process that
  // actually owns the port before signalling anything, so a stale file cannot
  // terminate an unrelated process. The desktop app reads the version and the
  // contract before it drives a daemon it did not start (ADR-0063 H3). Behind
  // admission like every other route.
  app.get('/api/server', (c) => c.json({
    pid: process.pid,
    port: admission.port,
    version: serverVersion(),
    contract: DAEMON_CONTRACT,
  } satisfies ServerInfoResponse));

  app.route('/api/sessions', sessionsRoute(pool));
  app.route('/api/sessions', childrenRoute(pool));
  app.route('/api/plans', plansRoute(pool));
  app.route('/api/plans', taskDiffRoute(reader));
  app.route('/api/plans', mergePreflightRoute(reader));
  app.route('/api/runners', runnersRoute(pool));
  app.route('/api/models', modelsRoute(pool));
  app.route('/api/settings', settingsRoute(pool));
  app.route('/api/commands', commandsRoute());
  app.route('/api/workspaces', workspacesRoute(pool));
  app.route('/api/approvals', approvalsRoute(pool));
  // The user's reads of files and git (ADR-0064): the reader, never the pool.
  app.route('/api/files', filesRoute(reader));
  app.route('/api/git', gitRoute(reader));
  // The user's actions on their own checkout (ADR-0062), beside those reads.
  app.route('/api/files', fileWriteRoute(userGit));
  app.route('/api/git', gitWriteRoute(userGit));

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

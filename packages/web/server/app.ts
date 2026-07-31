import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Server } from 'http';
import { sessionsRoute } from './routes/sessions';
import { plansRoute } from './routes/plans';
import { runnersRoute } from './routes/runners';
import { modelsRoute } from './routes/models';
import { workspacesRoute } from './routes/workspaces';
import { approvalsRoute } from './routes/approvals';
import { settingsRoute } from './routes/settings';
import { commandsRoute } from './routes/commands';
import { createWsHandler } from './ws/stream';
import { OrchestratorPool } from './pool/orchestratorPool';

export function createApp(pool: OrchestratorPool) {
  const app = new Hono();

  app.use('*', cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3742', 'http://127.0.0.1:3742'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }));

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

export function attachWsHandler(server: Server, pool: OrchestratorPool) {
  const handler = createWsHandler(pool);
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    if (url.pathname.startsWith('/ws/session/')) {
      handler(request, socket, head);
    } else {
      socket.destroy();
    }
  });
}

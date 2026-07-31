import { Hono } from 'hono';
import { scanWorkspaces } from '../pool/orchestratorPool';

export function workspacesRoute() {
  const router = new Hono();

  router.get('/', (c) => {
    const workspaces = scanWorkspaces();
    return c.json({ workspaces });
  });

  return router;
}

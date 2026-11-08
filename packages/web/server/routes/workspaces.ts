import { Hono } from 'hono';
import { assertWorkspaceExists, type IsolationPreviewResponse, type WorkspacesResponse } from '@ordewell/core';
import { OrchestratorPool, scanWorkspaces } from '../pool/orchestratorPool';
import { failure } from './errors';

export function workspacesRoute(pool: OrchestratorPool) {
  const router = new Hono();

  // A read-only sibling of the list: it names the repositories behind one
  // workspace, while `/` keeps listing the workspaces sessions are saved under.
  router.get('/isolation-preview', async (c) => {
    try {
      const workspace = c.req.query('workspace') || process.cwd();
      assertWorkspaceExists(workspace);
      const preview = await pool.previewIsolation(workspace);
      return c.json({ preview } satisfies IsolationPreviewResponse);
    } catch (err) {
      return failure(c, err, 'read isolation preview', { message: 'Could not read the repositories' });
    }
  });

  router.get('/', (c) => {
    try {
      const workspaces = scanWorkspaces();
      return c.json({ workspaces } satisfies WorkspacesResponse);
    } catch (err) {
      return failure(c, err, 'list workspaces');
    }
  });

  return router;
}

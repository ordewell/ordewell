import { Hono } from 'hono';
import type { ModelsResponse } from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { failure } from './errors';

export function modelsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', async (c) => {
    // The catalog of the workspace's own runner environment, as its login verdict is.
    try {
      const result: ModelsResponse = await pool.getProviderModels(c.req.query('workspace'));
      return c.json(result);
    } catch (err) {
      return failure(c, err, 'list models');
    }
  });

  return router;
}

import { Hono } from 'hono';
import type { OrchestratorPool } from '../pool/orchestratorPool';

export function modelsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', async (c) => {
    const result = await pool.getProviderModels();
    return c.json(result);
  });

  return router;
}

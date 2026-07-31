import { Hono } from 'hono';
import type { OrchestratorPool } from '../pool/orchestratorPool';

export function settingsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', (c) => {
    return c.json(pool.getSettings());
  });

  router.patch('/', async (c) => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return c.json({ error: 'At least one setting field is required' }, 400);
    }
    const result = pool.updateSettings(body);
    return c.json(result);
  });

  return router;
}

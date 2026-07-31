import { Hono } from 'hono';
import { OrchestratorPool } from '../pool/orchestratorPool';

export function runnersRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', async (c) => {
    const state = pool.getRunnerState();
    const runners = await pool.getInstalledRunners();
    return c.json({
      runners,
      orchestratorModel: state.orchestratorModel,
    });
  });

  router.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    pool.setRunnerEnabled(id, body.enabled);
    return c.json({ ok: true });
  });

  return router;
}

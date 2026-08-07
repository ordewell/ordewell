import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

/**
 * Distinct from POST /:sessionId/stop (execution). This aborts a planning
 * turn in flight — a harmless no-op, not a 404, when the session simply
 * isn't planning right now.
 */
describe('POST /:sessionId/planning/stop', () => {
  async function post(pool: OrchestratorPool, sessionId = 's1') {
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));
    return app.request(`/api/plans/${sessionId}/planning/stop`, { method: 'POST' });
  }

  it('aborts an in-flight planning turn', async () => {
    const cancelPlanning = vi.fn().mockReturnValue(true);
    const pool = { cancelPlanning } as unknown as OrchestratorPool;

    const res = await post(pool);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(cancelPlanning).toHaveBeenCalledWith('s1');
  });

  it('is a harmless no-op when no planning turn is in flight', async () => {
    const cancelPlanning = vi.fn().mockReturnValue(false);
    const pool = { cancelPlanning } as unknown as OrchestratorPool;

    const res = await post(pool);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: false });
  });
});

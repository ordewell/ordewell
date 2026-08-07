import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Hono } from 'hono';
import { Session, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';

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

/**
 * The two tests above assert on a mocked pool — they pin the route's contract
 * but not the wiring. This drives the real seam a live daemon uses: the HTTP
 * route, a real OrchestratorPool, and a real Session, so the only double is
 * the planner call itself (the one edge no offline test can make real).
 */
describe('POST /:sessionId/converse/start then /planning/stop — real daemon wiring', () => {
  it('aborts the signal a live planning turn is actually waiting on', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-planstop-'));
    const pool = new OrchestratorPool();
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));

    let capturedSignal: AbortSignal | undefined;
    let resolvePlan!: (v: LegacyPlanState) => void;
    const deferred = new Promise<LegacyPlanState>((resolve) => { resolvePlan = resolve; });
    const spy = vi.spyOn(Session.prototype, 'startPlanning').mockImplementation(async (_goal, _runners, options) => {
      capturedSignal = options?.signal;
      return deferred;
    });

    try {
      const startCall = app.request('/api/plans/s-real/converse/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: 'ship it', runners: ['claude-code'], workspace }),
      });
      // Let the route parse the JSON body and reach pool.startPlanning before
      // we cancel — more hops than a direct pool call, so more ticks to drain.
      await new Promise((r) => setImmediate(r));

      const stopRes = await app.request(`/api/plans/s-real/planning/stop`, { method: 'POST' });

      expect(stopRes.status).toBe(200);
      expect(await stopRes.json()).toEqual({ cancelled: true });
      expect(capturedSignal?.aborted).toBe(true);

      resolvePlan({
        tasks: [], runners: ['claude-code'], generatedAt: new Date().toISOString(),
        status: 'approved', lastUpdated: new Date().toISOString(),
      });
      const startRes = await startCall;
      expect(startRes.status).toBe(200);
    } finally {
      spy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

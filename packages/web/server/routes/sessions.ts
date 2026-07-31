import { Hono } from 'hono';
import { OrchestratorPool, getSessionList, removeSession } from '../pool/orchestratorPool';
import { loadSessionPlanState } from '@ordewell/core';

export function sessionsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', (c) => {
    const ws = c.req.query('workspace') || process.cwd();
    const sessions = getSessionList(ws);
    return c.json(sessions);
  });

  /**
   * The saved file answers for a session nobody is holding. While the pool has
   * one, its store is the only honest source of task status: the file is
   * normalized as if nothing were running (`in_progress` → `pending`), so
   * serving it mid-run told every surface that the tasks it is watching had
   * never started.
   */
  router.get('/:id', (c) => {
    const ws = c.req.query('workspace') || process.cwd();
    const id = c.req.param('id');
    const saved = loadSessionPlanState(id, ws);
    if (!saved) return c.json({ error: 'Session not found' }, 404);
    return c.json({ meta: saved.meta, plan: pool.getPlanState(id) ?? saved.plan });
  });

  /**
   * Adopt a saved session into the running server. `GET /:id` only reads the
   * file; until a session is registered with the pool there is no orchestrator
   * behind it, so execution and task control answer "Session not found".
   */
  router.post('/:id/load', (c) => {
    const ws = c.req.query('workspace') || process.cwd();
    try {
      const id = c.req.param('id');
      const plan = pool.adoptSavedSession(id, ws);
      return c.json({ ok: true, plan, goal: pool.getGoal(id) });
    } catch (err: any) {
      const status = err?.message === 'Session not found' ? 404 : 500;
      return c.json({ error: err?.message ?? 'Failed to load session' }, status as any);
    }
  });

  router.delete('/:id', (c) => {
    const ws = c.req.query('workspace') || process.cwd();
    const ok = removeSession(c.req.param('id'), ws);
    return c.json({ ok });
  });

  // Stops the orchestrator (killing every tmux window it spawned) and drops
  // the in-memory planner conversation. No-op if already closed/unregistered.
  router.post('/:id/close', (c) => {
    pool.destroy(c.req.param('id'));
    return c.json({ ok: true });
  });

  return router;
}

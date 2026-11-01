import { Hono } from 'hono';
import { OrchestratorPool, getSessionList, removeSession } from '../pool/orchestratorPool';
import {
  listTaskLogAttempts,
  loadSessionPlanState,
  readTaskLog,
  surfacePlan,
  surfacePlanState,
  taskLogForSurface,
  type AdoptSessionResponse,
  type OkResponse,
  type SessionListResponse,
  type SessionResponse,
  type TaskLogAttemptsResponse,
  type TaskLogResponse,
} from '@ordewell/core';
import { failure, refuse } from './errors';

export function sessionsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', (c) => {
    const ws = c.req.query('workspace') || process.cwd();
    const sessions: SessionListResponse = getSessionList(ws);
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
    if (!saved) return refuse(c, 404, 'Session not found', 'session_not_found');
    const run = pool.runSnapshot(id);
    const plannerCompaction = pool.plannerCompaction(id);
    return c.json({
      meta: saved.meta,
      plan: surfacePlanState(pool.getPlanState(id) ?? saved.plan),
      ...(run ? { run } : {}),
      ...(plannerCompaction ? { plannerCompaction } : {}),
    } satisfies SessionResponse);
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
      const run = pool.runSnapshot(id);
      const plannerTurnId = pool.plannerTurnId(id);
      const plannerCompaction = pool.plannerCompaction(id);
      return c.json({
        ok: true,
        plan: surfacePlan(plan),
        goal: pool.getGoal(id),
        ...(run ? { run } : {}),
        ...(plannerTurnId ? { plannerTurnId } : {}),
        ...(plannerCompaction ? { plannerCompaction } : {}),
      } satisfies AdoptSessionResponse);
    } catch (err: unknown) {
      return failure(c, err, 'load session', { message: 'Failed to load session' });
    }
  });

  /**
   * A structured task's saved log (ADR-0018, P1), read off disk whether or
   * not the pool holds the session: every attempt is written as it happens,
   * so the file is as current as the stream a reopened view catches up with.
   */
  router.get('/:id/tasks/:taskId/log', (c) => {
    const ws = c.req.query('workspace') || process.cwd();
    return c.json({ attempts: listTaskLogAttempts({ baseDir: ws, sessionId: c.req.param('id') }, c.req.param('taskId')), position: pool.streamPosition(c.req.param('id')) } satisfies TaskLogAttemptsResponse);
  });

  router.get('/:id/tasks/:taskId/log/:attempt', (c) => {
    const ws = c.req.query('workspace') || process.cwd();
    const attempt = Number(c.req.param('attempt'));
    if (!Number.isInteger(attempt) || attempt < 1) return refuse(c, 400, 'attempt must be a positive integer');
    return c.json({ attempt, events: taskLogForSurface(readTaskLog({ baseDir: ws, sessionId: c.req.param('id') }, c.req.param('taskId'), attempt)), position: pool.streamPosition(c.req.param('id')) } satisfies TaskLogResponse);
  });

  // The live session goes before its files: it persists as it changes, so one
  // left running would write its file back and reappear in the list. A delete
  // refused before that point leaves it open, its tree stopped.
  router.delete('/:id', async (c) => {
    const ws = c.req.query('workspace') || process.cwd();
    const id = c.req.param('id');
    const held = pool.hasSession(id);
    let removed: boolean;
    try {
      removed = await removeSession(id, ws, () => pool.stopTree(id), () => pool.destroy(id, { notifyClients: true }));
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) } satisfies OkResponse);
    }
    const ok = held || removed;
    return c.json({
      ok,
      ...(ok ? {} : { message: `No session "${id}" was found in ${ws}.` }),
    } satisfies OkResponse);
  });

  // Stops the orchestrator (killing every runner it spawned) and drops the
  // in-memory planner conversation. No-op if already closed/unregistered.
  router.post('/:id/close', (c) => {
    pool.destroy(c.req.param('id'), { notifyClients: true });
    return c.json({ ok: true } satisfies OkResponse);
  });

  return router;
}

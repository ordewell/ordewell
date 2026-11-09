import { Hono } from 'hono';
import { OrchestratorPool, getSessionList, removeSession } from '../pool/orchestratorPool';
import {
  listTaskLogAttempts,
  loadSession,
  migratePlanState,
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
    try {
      const ws = c.req.query('workspace') || process.cwd();
      // The saved status reads approved for as long as a run lasts: whether one is at work is the pool's word, or its holder's.
      const sessions: SessionListResponse = getSessionList(ws).map((meta) => {
        const run = pool.runActivity(meta.id, ws);
        return run ? { ...meta, run } : meta;
      });
      return c.json(sessions);
    } catch (err) {
      return failure(c, err, 'list sessions');
    }
  });

  /**
   * The saved file answers for a session nobody is holding. While the pool has
   * one, its store is the only honest source of task status: the file is
   * normalized as if nothing were running (`in_progress` → `pending`), so
   * serving it mid-run told every surface that the tasks it is watching had
   * never started.
   */
  router.get('/:id', (c) => {
    try {
      const ws = c.req.query('workspace') || process.cwd();
      const id = c.req.param('id');
      const saved = loadSession(id, ws);
      if (!saved) return refuse(c, 404, 'Session not found', 'session_not_found');
      // The pool keeps one session per id: one open for another workspace is not this file's session.
      const live = pool.holds(id, ws);
      const run = live ? pool.runSnapshot(id) : null;
      const plannerTurnId = live ? pool.plannerTurnId(id) : undefined;
      const plannerCompaction = live ? pool.plannerCompaction(id) : undefined;
      // The phase-tagged plan keeps no transcript: a client that joins or only reads the session redraws its chat from this.
      const { conversationHistory, researchLog, plannerUsage, pendingTurns } = surfacePlan((live ? pool.getPlan(id) : null) ?? saved.plan);
      return c.json({
        meta: saved.meta,
        plan: surfacePlanState((live ? pool.getPlanState(id) : null) ?? migratePlanState(saved.plan)),
        conversation: { conversationHistory, researchLog, plannerUsage, pendingTurns },
        ...(run ? { run } : {}),
        ...(plannerTurnId ? { plannerTurnId } : {}),
        ...(plannerCompaction ? { plannerCompaction } : {}),
      } satisfies SessionResponse);
    } catch (err) {
      return failure(c, err, 'read session');
    }
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
  // Another workspace's session under this id streams nothing this log is part of.
  const position = (id: string, ws: string) => (pool.heldElsewhere(id, ws) ? {} : { position: pool.streamPosition(id) });

  router.get('/:id/tasks/:taskId/log', (c) => {
    try {
      const ws = c.req.query('workspace') || process.cwd();
      return c.json({ attempts: listTaskLogAttempts({ baseDir: ws, sessionId: c.req.param('id') }, c.req.param('taskId')), ...position(c.req.param('id'), ws) } satisfies TaskLogAttemptsResponse);
    } catch (err) {
      return failure(c, err, 'list task log');
    }
  });

  router.get('/:id/tasks/:taskId/log/:attempt', (c) => {
    try {
      const ws = c.req.query('workspace') || process.cwd();
      const attempt = Number(c.req.param('attempt'));
      if (!Number.isInteger(attempt) || attempt < 1) return refuse(c, 400, 'attempt must be a positive integer');
      return c.json({ attempt, events: taskLogForSurface(readTaskLog({ baseDir: ws, sessionId: c.req.param('id') }, c.req.param('taskId'), attempt)), ...position(c.req.param('id'), ws) } satisfies TaskLogResponse);
    } catch (err) {
      return failure(c, err, 'read task log');
    }
  });

  // The live session goes before its files: it persists as it changes, so one
  // left running would write its file back and reappear in the list. A delete
  // refused before that point leaves it open, its tree stopped. Only this
  // workspace's: another's open under the same id is not the one deleted, and
  // the containers its tree runs in carry the same id. The pool judges whose
  // session the id names at each step, not here: the tree stop can take long
  // enough for another workspace to open its own session of the id.
  router.delete('/:id', async (c) => {
    const ws = c.req.query('workspace') || process.cwd();
    const id = c.req.param('id');
    const held = pool.holds(id, ws);
    let removed: boolean;
    try {
      removed = await removeSession(id, ws, () => pool.stopTree(id, ws), () => pool.close(id, ws), () => pool.reclaim(id, ws));
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) } satisfies OkResponse);
    }
    const ok = held || removed;
    return c.json({
      ok,
      ...(ok ? {} : { message: `No session "${id}" was found in ${ws}.` }),
    } satisfies OkResponse);
  });

  // Stops the orchestrator (killing every runner it spawned, and every container
  // with what serves it) and drops the in-memory planner conversation, answering
  // once they have gone. No-op if already closed/unregistered, or open for
  // another workspace: that is another project's session under the same id.
  router.post('/:id/close', async (c) => {
    try {
      const id = c.req.param('id');
      await pool.close(id, c.req.query('workspace') || process.cwd());
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'close session');
    }
  });

  return router;
}

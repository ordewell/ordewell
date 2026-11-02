import { Hono, type Context } from 'hono';
import {
  listTaskLogAttempts,
  readTaskLog,
  taskLogForSurface,
  type ChildListResponse,
  type ChildMessageResponse,
  type ChildPlanHandle,
  type ChildPlanResponse,
  type TaskLogAttemptsResponse,
  type TaskLogResponse,
} from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { ChildNotFoundError, failure, jsonObject, refuse } from './errors';

/**
 * Selecting, reading and speaking to the plans below a root (ADR-0055 D20).
 * Each goes through the root a surface holds, and its directory, so an id this
 * tree does not name reads nothing. A person's message is the words and nothing
 * else: no field here raises a budget, adds a grant or approves an effect, and
 * a checkpoint is still answered on the plan that holds it. An unloaded root
 * answers `session_not_found`, and `POST /:id/load` loads it, starting nothing.
 */
export function childrenRoute(pool: OrchestratorPool) {
  const router = new Hono();

  const childOf = async (c: Context): Promise<ChildPlanHandle> => {
    const child = await pool.session(c.req.param('id')!).children.find(c.req.param('childId')!);
    if (!child) throw new ChildNotFoundError();
    return child;
  };
  const position = (c: Context) => pool.childPosition(c.req.param('id')!, c.req.param('childId')!);

  router.get('/:id/children', async (c) => {
    try {
      return c.json({ children: await pool.session(c.req.param('id')).children.list() } satisfies ChildListResponse);
    } catch (err) {
      return failure(c, err, 'list child plans');
    }
  });

  router.get('/:id/children/:childId', async (c) => {
    try {
      const child = await childOf(c);
      return c.json({ ...child.view(), position: position(c) } satisfies ChildPlanResponse);
    } catch (err) {
      return failure(c, err, 'read child plan');
    }
  });

  router.get('/:id/children/:childId/tasks/:taskId/log', async (c) => {
    try {
      const child = await childOf(c);
      return c.json({ attempts: listTaskLogAttempts(child.logLocation(), c.req.param('taskId')), position: position(c) } satisfies TaskLogAttemptsResponse);
    } catch (err) {
      return failure(c, err, 'list child task log');
    }
  });

  router.get('/:id/children/:childId/tasks/:taskId/log/:attempt', async (c) => {
    try {
      const child = await childOf(c);
      const attempt = Number(c.req.param('attempt'));
      if (!Number.isInteger(attempt) || attempt < 1) return refuse(c, 400, 'attempt must be a positive integer');
      return c.json({ attempt, events: taskLogForSurface(readTaskLog(child.logLocation(), c.req.param('taskId'), attempt)), position: position(c) } satisfies TaskLogResponse);
    } catch (err) {
      return failure(c, err, 'read child task log');
    }
  });

  router.post('/:id/children/:childId/message', async (c) => {
    try {
      const child = await childOf(c);
      const { message } = await jsonObject<{ message?: unknown }>(c);
      if (typeof message !== 'string' || !message.trim()) return refuse(c, 400, 'message must be a non-empty string');
      const outcome = child.message(message);
      if (!outcome.ok) return refuse(c, 409, outcome.message, outcome.code === 'view_only' ? 'child_view_only' : 'child_refused');
      return c.json({ status: outcome.status } satisfies ChildMessageResponse);
    } catch (err) {
      return failure(c, err, 'message child plan');
    }
  });

  return router;
}

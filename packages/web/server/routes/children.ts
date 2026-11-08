import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  listTaskLogAttempts,
  readTaskLog,
  taskLogForSurface,
  type ChildListResponse,
  type ChildMessageResponse,
  type ChildPlanHandle,
  type ChildPlanResponse,
  type ChildControlOutcome,
  type ChildTaskControlResponse,
  type DaemonErrorCode,
  type TaskLogAttemptsResponse,
  type TaskLogResponse,
} from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { ChildNotFoundError, failure, jsonObject, refuse } from './errors';
import { callerWorkspace, sameWorkspace } from './liveSession';

const ABOVE_THIS_PLAN = 'A raise or a force is the plan above this one to give: this request sets neither.';

const CONTROL_REFUSALS: Record<Extract<ChildControlOutcome, { ok: false }>['code'], { status: ContentfulStatusCode; code: DaemonErrorCode }> = {
  view_only: { status: 409, code: 'child_view_only' },
  refused: { status: 409, code: 'child_refused' },
  no_task: { status: 404, code: 'child_task_not_found' },
  not_waiting: { status: 409, code: 'checkpoint_not_waiting' },
};

/**
 * Selecting, reading and speaking to the plans below a root (ADR-0055 D20).
 * Each goes through the root a surface holds, and its directory, so an id this
 * tree does not name reads nothing. A person's message is the words and nothing
 * else: no field here raises a budget, adds a grant or approves an effect. A
 * checkpoint is answered on the plan that holds it, under what that plan's own
 * subplanner may do, and a task id is the plan's exactly: nothing here resolves
 * a reference or falls back to the root. An unloaded root answers
 * `session_not_found`, and `POST /:id/load` loads it, starting nothing.
 */
export function childrenRoute(pool: OrchestratorPool) {
  const router = new Hono();
  router.use('/:id/children', sameWorkspace(pool, 'id'));
  router.use('/:id/children/*', sameWorkspace(pool, 'id'));

  // A handler that reads a body finds the child after it: while the body
  // arrived, the root's id may have come to name another workspace's session.
  const childOf = async (c: Context): Promise<ChildPlanHandle> => {
    const child = await pool.session(c.req.param('id')!, callerWorkspace(c)).children.find(c.req.param('childId')!);
    if (!child) throw new ChildNotFoundError();
    return child;
  };
  const position = (c: Context) => pool.childPosition(c.req.param('id')!, c.req.param('childId')!, callerWorkspace(c));
  const controlled = (c: Context, outcome: ChildControlOutcome) => {
    if (!outcome.ok) return refuse(c, CONTROL_REFUSALS[outcome.code].status, outcome.message, CONTROL_REFUSALS[outcome.code].code);
    return c.json({ message: outcome.message, ...(outcome.id ? { id: outcome.id } : {}) } satisfies ChildTaskControlResponse);
  };
  // The root's routes take these. Dropped here, a person would believe a raise
  // or a force went through; the plan above holds both (ADR-0056 M8).
  const asksAboveItsPlan = (body: object) => 'raiseTokens' in body || 'force' in body;

  router.get('/:id/children', async (c) => {
    try {
      return c.json({ children: await pool.session(c.req.param('id'), callerWorkspace(c)).children.list() } satisfies ChildListResponse);
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
      const body = await jsonObject<{ message?: unknown }>(c);
      const child = await childOf(c);
      if (asksAboveItsPlan(body)) return refuse(c, 400, ABOVE_THIS_PLAN, 'refused');
      const { message } = body;
      if (typeof message !== 'string' || !message.trim()) return refuse(c, 400, 'message must be a non-empty string');
      const outcome = child.message(message);
      if (!outcome.ok) return refuse(c, 409, outcome.message, outcome.code === 'view_only' ? 'child_view_only' : 'child_refused');
      return c.json({ status: outcome.status } satisfies ChildMessageResponse);
    } catch (err) {
      return failure(c, err, 'message child plan');
    }
  });

  router.post('/:id/children/:childId/tasks/:taskId/message', async (c) => {
    try {
      const body = await jsonObject<{ message?: unknown }>(c);
      const child = await childOf(c);
      if (asksAboveItsPlan(body)) return refuse(c, 400, ABOVE_THIS_PLAN, 'refused');
      if (typeof body.message !== 'string' || !body.message.trim()) return refuse(c, 400, 'message must be a non-empty string', 'refused');
      return controlled(c, await child.control(c.req.param('taskId'), { kind: 'message', text: body.message }));
    } catch (err) {
      return failure(c, err, 'message child task');
    }
  });

  for (const answer of ['approve', 'reject'] as const) {
    router.post(`/:id/children/:childId/tasks/:taskId/checkpoint/${answer}`, async (c) => {
      try {
        const body = await jsonObject<{ question?: unknown; reason?: unknown }>(c);
        const child = await childOf(c);
        if (asksAboveItsPlan(body)) return refuse(c, 400, ABOVE_THIS_PLAN, 'refused');
        const { question } = body;
        if (typeof question !== 'string' || !question.trim()) return refuse(c, 400, 'question must be the words the task is waiting on', 'refused');
        if (body.reason !== undefined && typeof body.reason !== 'string') return refuse(c, 400, 'reason must be a string', 'refused');
        const reason = body.reason?.trim();
        if (answer === 'reject' && !reason) return refuse(c, 400, 'A rejection needs a reason: it is all the runner has to go on.', 'refused');
        return controlled(c, await child.control(c.req.param('taskId'), { kind: 'checkpoint', answer, question, ...(reason ? { reason } : {}) }));
      } catch (err) {
        return failure(c, err, 'answer child checkpoint');
      }
    });
  }

  return router;
}

import { Hono } from 'hono';
import { isGranted, toApprovalDecision, type ApprovalAnswer, type ApprovalAnswerResponse, type ApprovalsResponse } from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { failure, refuse } from './errors';
import { callerWorkspace, sameWorkspace } from './liveSession';

/**
 * A body's answer. `{ decision, note? }` carries a runner request's whole
 * answer (ADR-0018, A1); `{ granted }` is the planner prompt's yes/no.
 * Anything else — absent, malformed, an unknown decision — is a denial,
 * never consent.
 */
function answerOf(body: unknown): ApprovalAnswer {
  if (typeof body !== 'object' || body === null) return false;
  const { decision, note, granted } = body as { decision?: unknown; note?: unknown; granted?: unknown };
  if (decision === undefined) return granted === true;
  if (decision === 'allow' || decision === 'allowForTask') return { decision };
  if (decision === 'deny' && typeof note === 'string' && note.trim()) return { decision, note: note.trim() };
  return { decision: 'deny' };
}

/**
 * The answer channel for approval prompts — the planner's, and a task
 * runner's tool requests.
 *
 * Requests go out over the session WebSocket (they are ordinary
 * SessionMessages), but answers come back here rather than over the socket:
 * the CLI and TUI already speak HTTP to this server, a prompt can outlive the
 * socket that announced it, and a plain POST is answerable from any surface —
 * including `curl` in a pinch.
 */
export function approvalsRoute(pool: OrchestratorPool) {
  const router = new Hono();
  router.use('/:sessionId', sameWorkspace(pool, 'sessionId'));
  router.use('/:sessionId/*', sameWorkspace(pool, 'sessionId'));

  router.get('/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    try {
      const session = pool.session(sessionId, callerWorkspace(c));
      return c.json({ pending: session.outstandingApprovals(), approvedScopes: session.approvedScopes() } satisfies ApprovalsResponse);
    } catch (err) {
      return failure(c, err, 'read approvals');
    }
  });

  router.post('/:sessionId/:approvalId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const approvalId = c.req.param('approvalId');
    if (!pool.hasSession(sessionId)) return refuse(c, 404, `Unknown session: ${sessionId}`, 'session_not_found');

    const answer = answerOf(await c.req.json().catch(() => null));
    const decided = toApprovalDecision(answer);
    try {
      // Found after the body: while it arrived, the id may have come to name
      // another workspace's session, whose prompt this caller never saw.
      const session = pool.session(sessionId, callerWorkspace(c));
      // A runner request goes through the command seam as the user's answer, so
      // their action is kept in the timeline (ADR-0029). The planner's own
      // prompt is no execution action and is answered directly.
      const request = session.outstandingApprovals().find((pending) => pending.id === approvalId)?.request;
      if (request?.taskId) {
        const outcome = await session.execute(
          { command: 'answer_approval', task: request.taskId, approval: approvalId, answer: decided.decision, ...(decided.decision === 'deny' && decided.note ? { note: decided.note } : {}) },
          { kind: 'user' },
        );
        if (!outcome.ok) return refuse(c, 400, outcome.message, 'refused');
      } else if (!session.resolveApproval(approvalId, answer)) {
        return refuse(c, 409, 'Approval is no longer outstanding: it timed out or was already answered.', 'approval_not_outstanding');
      }
    } catch (err) {
      return failure(c, err, 'answer approval');
    }
    return c.json({ ok: true, granted: isGranted(decided), decision: decided.decision } satisfies ApprovalAnswerResponse);
  });

  return router;
}

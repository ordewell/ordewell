import { Hono } from 'hono';
import type { OrchestratorPool } from '../pool/orchestratorPool';

/**
 * The answer channel for planner approval prompts.
 *
 * Requests go out over the session WebSocket (they are ordinary
 * SessionMessages), but answers come back here rather than over the socket:
 * the CLI and TUI already speak HTTP to this server, a prompt can outlive the
 * socket that announced it, and a plain POST is answerable from any surface —
 * including `curl` in a pinch.
 */
export function approvalsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    if (!pool.hasSession(sessionId)) return c.json({ error: `Unknown session: ${sessionId}` }, 404);

    return c.json({
      pending: pool.outstandingApprovals(sessionId),
      approvedScopes: pool.approvedScopes(sessionId),
    });
  });

  router.post('/:sessionId/:approvalId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const approvalId = c.req.param('approvalId');
    if (!pool.hasSession(sessionId)) return c.json({ error: `Unknown session: ${sessionId}` }, 404);

    // Absent or malformed body is a denial, never consent.
    const body = await c.req.json().catch(() => ({}));
    const granted = body?.granted === true;

    if (!pool.resolveApproval(sessionId, approvalId, granted)) {
      return c.json({ error: 'Approval is no longer outstanding — it timed out or was already answered.' }, 409);
    }
    return c.json({ ok: true, granted });
  });

  return router;
}

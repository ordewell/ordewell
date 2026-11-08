import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ConversationBusyError, ConversationEditError, PlannerTurnStoppedError, SessionNotFoundError } from '@ordewell/core';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

describe('POST /conversation/compact/retry', () => {
  let app: Hono;
  let retryPlannerCompaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    retryPlannerCompaction = vi.fn();
    const pool = { retryPlannerCompaction } as unknown as OrchestratorPool;
    const { plansRoute } = await import('../../routes/plans');
    app = new Hono();
    app.route('/api/plans', plansRoute(pool));
  });

  const retry = () => app.request('/api/plans/s1/conversation/compact/retry', { method: 'POST' });

  it('answers with the plan the retried turn landed, or paused again on', async () => {
    const pause = { model: 'vendor/model', at: '2026-10-25T10:00:00Z', reason: 'Paused again.', inputs: ['turn-1'] };
    retryPlannerCompaction.mockResolvedValue({ tasks: [], generatedAt: '', lastUpdated: '', status: 'draft', runners: [], plannerContextPause: pause });

    const res = await retry();

    expect(res.status).toBe(200);
    expect((await res.json() as { plan: { plannerContextPause?: unknown } }).plan.plannerContextPause).toEqual(pause);
    expect(retryPlannerCompaction).toHaveBeenCalledWith('s1', undefined);
  });

  it.each([
    ['nothing is paused, or the retry cannot be made safely', new ConversationEditError('The planner is not paused on its context: there is nothing to retry.'), 400, 'refused'],
    ['a planner turn holds the conversation', new ConversationBusyError('retry compaction'), 409, 'conversation_busy'],
    ['the user stopped it', new PlannerTurnStoppedError(), 409, 'planner_turn_stopped'],
    ['the session is gone', new SessionNotFoundError(), 404, 'session_not_found'],
  ])('refuses when %s, saying why', async (_label, err, status, code) => {
    retryPlannerCompaction.mockRejectedValue(err);

    const res = await retry();

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: err.message, code });
  });
});

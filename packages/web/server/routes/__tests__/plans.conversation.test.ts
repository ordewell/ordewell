import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Hono } from 'hono';
import { ConversationBusyError, ConversationEditError, loadSession, saveSession, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

function appFor(pool: OrchestratorPool) {
  const app = new Hono();
  app.route('/api/plans', plansRoute(pool));
  return app;
}

function post(app: Hono, path: string, body?: unknown) {
  return app.request(`/api/plans/s1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function poolWith(session: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    session: vi.fn((id: string) => {
      if (id !== 's1') throw new Error('Session not found');
      return session;
    }),
    ...extra,
  } as unknown as OrchestratorPool;
}

describe('POST /:sessionId/conversation/fork', () => {
  it('answers the new session id and its plan', async () => {
    const forkConversation = vi.fn().mockReturnValue({ sessionId: 'session-fork', plan: { tasks: [] } });
    const app = appFor(poolWith({}, { forkConversation }));

    const res = await post(app, 'conversation/fork');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 'session-fork', plan: { tasks: [] } });
    expect(forkConversation).toHaveBeenCalledWith('s1');
  });

  it('is a conflict while the planner is answering', async () => {
    const forkConversation = vi.fn(() => { throw new ConversationBusyError('fork the conversation'); });
    const app = appFor(poolWith({}, { forkConversation }));

    const res = await post(app, 'conversation/fork');

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/planner is answering/);
  });

  it('is a 404 for a session the daemon does not hold', async () => {
    const forkConversation = vi.fn(() => { throw new Error('Session not found'); });
    const app = appFor(poolWith({}, { forkConversation }));

    expect((await post(app, 'conversation/fork')).status).toBe(404);
  });
});

describe('GET /:sessionId/conversation/rewind-targets', () => {
  it('lists the user messages a rewind can land before', async () => {
    const targets = [{ index: 2, preview: 'add streaming', timestamp: '2026-01-01T00:00:02Z' }];
    const app = appFor(poolWith({ rewindTargets: () => targets }));

    const res = await app.request('/api/plans/s1/conversation/rewind-targets');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ targets });
  });

  it('is a 404 for a session the daemon does not hold', async () => {
    const app = appFor(poolWith({ rewindTargets: () => [] }));

    expect((await app.request('/api/plans/nope/conversation/rewind-targets')).status).toBe(404);
  });
});

describe('POST /:sessionId/conversation/rewind', () => {
  it('rewinds to just before the given user message and answers the plan', async () => {
    const rewindConversation = vi.fn().mockReturnValue({ tasks: [], conversationHistory: [] });
    const app = appFor(poolWith({ rewindConversation }));

    const res = await post(app, 'conversation/rewind', { index: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: { tasks: [], conversationHistory: [] } });
    expect(rewindConversation).toHaveBeenCalledWith(2);
  });

  it.each([[{}], [{ index: '2' }], [{ index: 1.5 }], [{ index: -1 }]])('refuses %j without touching the session', async (body) => {
    const rewindConversation = vi.fn();
    const app = appFor(poolWith({ rewindConversation }));

    const res = await post(app, 'conversation/rewind', body);

    expect(res.status).toBe(400);
    expect(rewindConversation).not.toHaveBeenCalled();
  });

  it('is a 400 for an index that is not a rewind target', async () => {
    const app = appFor(poolWith({ rewindConversation: () => { throw new ConversationEditError('No user message at position 3 to rewind to.'); } }));

    const res = await post(app, 'conversation/rewind', { index: 3 });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('No user message at position 3 to rewind to.');
  });

  it('is a conflict while the planner is answering', async () => {
    const app = appFor(poolWith({ rewindConversation: () => { throw new ConversationBusyError('rewind the conversation'); } }));

    expect((await post(app, 'conversation/rewind', { index: 2 })).status).toBe(409);
  });
});

describe('POST /:sessionId/conversation/compact', () => {
  it('answers the condensed plan and the summary that replaced the conversation', async () => {
    const compactConversation = vi.fn().mockResolvedValue({ plan: { tasks: [] }, summary: 'the state', keptMessages: 4 });
    const app = appFor(poolWith({}, { compactConversation }));

    const res = await post(app, 'conversation/compact');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: { tasks: [] }, summary: 'the state', keptMessages: 4 });
    expect(compactConversation).toHaveBeenCalledWith('s1');
  });

  it('is a conflict while the planner is answering', async () => {
    const compactConversation = vi.fn().mockRejectedValue(new ConversationBusyError('condense the conversation'));
    const app = appFor(poolWith({}, { compactConversation }));

    expect((await post(app, 'conversation/compact')).status).toBe(409);
  });

  it('is a 400 with the reason when the conversation is too short or the summary failed', async () => {
    const compactConversation = vi.fn().mockRejectedValue(new ConversationEditError('The conversation is too short to condense.'));
    const app = appFor(poolWith({}, { compactConversation }));

    const res = await post(app, 'conversation/compact');

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/too short/);
  });

  it('is a 404 for a session the daemon does not hold', async () => {
    const compactConversation = vi.fn().mockRejectedValue(new Error('Session not found'));
    const app = appFor(poolWith({}, { compactConversation }));

    expect((await post(app, 'conversation/compact')).status).toBe(404);
  });

  it('is a 500 when the planner itself fails', async () => {
    const compactConversation = vi.fn().mockRejectedValue(new Error('rate limited'));
    const app = appFor(poolWith({}, { compactConversation }));

    const res = await post(app, 'conversation/compact');

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('rate limited');
  });
});

/** The mocked-pool tests pin the contract; this drives a real pool, Session and session store. */
describe('POST /:sessionId/converse/message', () => {
  it('is a conflict while the conversation is being condensed', async () => {
    const continuePlanning = vi.fn().mockRejectedValue(new ConversationBusyError('send a message'));
    const app = appFor(poolWith({}, { continuePlanning }));

    const res = await post(app, 'converse/message', { message: 'and CSV' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/planner is answering/);
  });
});

describe('conversation routes — real daemon wiring', () => {
  it('rewinds a saved session and persists it, then forks it into a second addressable session', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-conv-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool();
    try {
      const plan = {
        tasks: [], generatedAt: '2026-01-01T00:00:00.000Z', status: 'draft', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00.000Z',
        conversationHistory: [
          { role: 'user', content: 'goal', timestamp: '2026-01-01T00:00:00.000Z' },
          { role: 'assistant', content: 'which way?', timestamp: '2026-01-01T00:00:01.000Z' },
          { role: 'user', content: 'the long way', timestamp: '2026-01-01T00:00:02.000Z' },
          { role: 'assistant', content: 'ok', timestamp: '2026-01-01T00:00:03.000Z' },
        ],
      } as LegacyPlanState;
      saveSession(plan, 'goal', workspace, 's1');
      pool.adoptSavedSession('s1', workspace);
      const app = appFor(pool);

      const targets = (await (await app.request('/api/plans/s1/conversation/rewind-targets')).json()) as { targets: { index: number }[] };
      expect(targets.targets.map((t) => t.index)).toEqual([2]);

      expect((await post(app, 'conversation/rewind', { index: 2 })).status).toBe(200);
      expect(loadSession('s1', workspace)!.plan.conversationHistory!.map((m) => m.content)).toEqual(['goal', 'which way?']);

      const fork = (await (await post(app, 'conversation/fork')).json()) as { sessionId: string };
      expect(pool.hasSession(fork.sessionId)).toBe(true);
      expect(loadSession(fork.sessionId, workspace)!.plan.conversationHistory).toHaveLength(2);
    } finally {
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Hono } from 'hono';
import { ConversationBusyError, ConversationEditError, PlannerTurnStoppedError, listSessions, loadSession, saveSession, type LegacyPlanState, SessionNotFoundError } from '@ordewell/core';
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
      if (id !== 's1') throw new SessionNotFoundError();
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
    expect(forkConversation).toHaveBeenCalledWith('s1', undefined);
  });

  it('is a conflict while the planner is answering', async () => {
    const forkConversation = vi.fn(() => { throw new ConversationBusyError('fork the conversation'); });
    const app = appFor(poolWith({}, { forkConversation }));

    const res = await post(app, 'conversation/fork');

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/planner is answering/);
  });

  it('is a 404 for a session the daemon does not hold', async () => {
    const forkConversation = vi.fn(() => { throw new SessionNotFoundError(); });
    const app = appFor(poolWith({}, { forkConversation }));

    expect((await post(app, 'conversation/fork')).status).toBe(404);
  });
});

describe('GET /:sessionId/conversation/rewind-targets', () => {
  it('lists the user messages a rewind can land before', async () => {
    const targets = [{ index: 2, preview: 'add streaming', content: 'add streaming', timestamp: '2026-01-01T00:00:02Z' }];
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
  it('forks from just before the given user message and answers the fork and the rewound message', async () => {
    const fork = { sessionId: 'session-fork', goal: 'goal', plan: { tasks: [], conversationHistory: [] }, rewoundMessage: 'the long way\nround' };
    const rewindConversation = vi.fn().mockReturnValue(fork);
    const app = appFor(poolWith({}, { rewindConversation }));

    const res = await post(app, 'conversation/rewind', { index: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fork);
    expect(rewindConversation).toHaveBeenCalledWith('s1', 2, undefined);
  });

  it.each([[{}], [{ index: '2' }], [{ index: 1.5 }], [{ index: -1 }]])('refuses %j without touching the session', async (body) => {
    const rewindConversation = vi.fn();
    const app = appFor(poolWith({}, { rewindConversation }));

    const res = await post(app, 'conversation/rewind', body);

    expect(res.status).toBe(400);
    expect(rewindConversation).not.toHaveBeenCalled();
  });

  it('is a 400 for an index that is not a rewind target', async () => {
    const app = appFor(poolWith({}, { rewindConversation: () => { throw new ConversationEditError('No user message at position 3 to rewind to.'); } }));

    const res = await post(app, 'conversation/rewind', { index: 3 });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('No user message at position 3 to rewind to.');
  });

  it('is a conflict while the planner is answering', async () => {
    const app = appFor(poolWith({}, { rewindConversation: () => { throw new ConversationBusyError('rewind the conversation'); } }));

    expect((await post(app, 'conversation/rewind', { index: 2 })).status).toBe(409);
  });

  it('is a 404 for a session the daemon does not hold', async () => {
    const app = appFor(poolWith({}, { rewindConversation: () => { throw new SessionNotFoundError(); } }));

    expect((await post(app, 'conversation/rewind', { index: 2 })).status).toBe(404);
  });
});

describe('POST /:sessionId/conversation/compact', () => {
  it('answers the condensed plan and the summary that replaced the conversation', async () => {
    const compactConversation = vi.fn().mockResolvedValue({ plan: { tasks: [] }, summary: 'the state', keptMessages: 4 });
    const app = appFor(poolWith({}, { compactConversation }));

    const res = await post(app, 'conversation/compact');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: { tasks: [] }, summary: 'the state', keptMessages: 4 });
    expect(compactConversation).toHaveBeenCalledWith('s1', undefined);
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
    const compactConversation = vi.fn().mockRejectedValue(new SessionNotFoundError());
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

describe('POST /:sessionId/converse/message/now', () => {
  it('force sends the message and answers the plan its turn landed, like a plain send', async () => {
    const forceSendPrompt = vi.fn().mockResolvedValue({ tasks: [] });
    const app = appFor(poolWith({}, { forceSendPrompt }));

    const res = await post(app, 'converse/message/now', { message: 'use Postgres instead' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: { tasks: [] } });
    expect(forceSendPrompt).toHaveBeenCalledWith('s1', 'use Postgres instead', undefined);
  });

  it('needs a message', async () => {
    const forceSendPrompt = vi.fn();
    const app = appFor(poolWith({}, { forceSendPrompt }));

    expect((await post(app, 'converse/message/now', {})).status).toBe(400);
    expect(forceSendPrompt).not.toHaveBeenCalled();
  });

  it('is a 404 for a session the daemon does not hold', async () => {
    const forceSendPrompt = vi.fn(() => { throw new SessionNotFoundError(); });
    const app = appFor(poolWith({}, { forceSendPrompt }));

    const res = await app.request('/api/plans/nope/converse/message/now', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'now' }),
    });

    expect(res.status).toBe(404);
  });

  it('answers a stopped forced turn as the plain route does', async () => {
    const forceSendPrompt = vi.fn().mockRejectedValue(new PlannerTurnStoppedError());
    const app = appFor(poolWith({}, { forceSendPrompt }));

    const res = await post(app, 'converse/message/now', { message: 'now' });

    expect(res.status).toBe(409);
  });
});

describe('conversation routes — real daemon wiring', () => {
  it('rewinds a saved session into an adopted fork, leaving the original\'s file byte for byte, then forks the fork', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-conv-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool();
    try {
      const plan = {
        tasks: [], generatedAt: '2026-01-01T00:00:00.000Z', status: 'draft', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00.000Z',
        conversationHistory: [
          { role: 'user', content: 'goal', timestamp: '2026-01-01T00:00:00.000Z' },
          { role: 'assistant', content: 'which way?', timestamp: '2026-01-01T00:00:01.000Z' },
          { role: 'user', content: 'the long way\nround the hill', timestamp: '2026-01-01T00:00:02.000Z' },
          { role: 'assistant', content: 'ok', timestamp: '2026-01-01T00:00:03.000Z' },
        ],
      } as LegacyPlanState;
      saveSession(plan, 'goal', workspace, 's1');
      pool.adoptSavedSession('s1', workspace);
      const sessionsDir = join(workspace, '.ordewell', 'sessions');
      const [originalFile] = readdirSync(sessionsDir);
      const originalBytes = readFileSync(join(sessionsDir, originalFile));
      const app = appFor(pool);

      const targets = (await (await app.request('/api/plans/s1/conversation/rewind-targets')).json()) as { targets: { index: number }[] };
      expect(targets.targets.map((t) => t.index)).toEqual([2]);

      const res = await post(app, 'conversation/rewind', { index: 2 });
      expect(res.status).toBe(200);
      const rewound = (await res.json()) as { sessionId: string; goal: string; plan: LegacyPlanState; rewoundMessage: string };
      expect(Object.keys(rewound).sort()).toEqual(['goal', 'plan', 'rewoundMessage', 'sessionId']);
      expect(rewound.goal).toBe('goal');
      expect(rewound.rewoundMessage).toBe('the long way\nround the hill');
      expect(rewound.plan.conversationHistory).toEqual(plan.conversationHistory!.slice(0, 2));
      expect(pool.hasSession(rewound.sessionId)).toBe(true);
      expect(listSessions(workspace).map((m) => m.id).sort()).toEqual([rewound.sessionId, 's1'].sort());
      expect(readFileSync(join(sessionsDir, originalFile)).equals(originalBytes)).toBe(true);
      expect(pool.session('s1', undefined).planState!.conversationHistory).toHaveLength(4);

      const fork = (await (await app.request(`/api/plans/${rewound.sessionId}/conversation/fork`, { method: 'POST' })).json()) as { sessionId: string };
      expect(pool.hasSession(fork.sessionId)).toBe(true);
      expect(loadSession(fork.sessionId, workspace)!.plan.conversationHistory).toHaveLength(2);
    } finally {
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

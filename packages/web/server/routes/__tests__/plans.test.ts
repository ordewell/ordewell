import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { WorkspaceNotFoundError, WorkspaceNotAProjectError } from '@ordewell/core';

import type { OrchestratorPool } from '../../pool/orchestratorPool';

function fakePool(overrides: Partial<OrchestratorPool> = {}): OrchestratorPool {
  const pool = {
    generatePlan: vi.fn().mockResolvedValue({ tasks: [], runners: ['opencode'], generatedAt: new Date().toISOString() }),
    getProviderModels: vi.fn().mockResolvedValue({ models: [], modelsByRunner: {}, orchestratorModel: '', providers: [] }),
    ...overrides,
  } as unknown as OrchestratorPool;
  return pool;
}

describe('POST /:sessionId/generate', () => {
  let app: Hono;
  let pool: OrchestratorPool;

  beforeEach(async () => {
    pool = fakePool();
    const { plansRoute } = await import('../../routes/plans');
    app = new Hono();
    app.route('/api/plans', plansRoute(pool));
  });

  it('passes model override through to generatePlan', async () => {
    const res = await app.request('/api/plans/s1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'test goal', runners: ['opencode'], model: 'openai/gpt-4o' }),
    });

    expect(res.status).toBe(200);
    expect(pool.generatePlan).toHaveBeenCalledWith('s1', 'test goal', ['opencode'], expect.any(String), 'openai/gpt-4o', { allowInit: undefined });
  });

  it('omits model when not provided (backward compatible)', async () => {
    const res = await app.request('/api/plans/s1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'test goal', runners: ['opencode'] }),
    });

    expect(res.status).toBe(200);
    expect(pool.generatePlan).toHaveBeenCalledWith('s1', 'test goal', ['opencode'], expect.any(String), undefined, { allowInit: undefined });
  });

  it('returns error when no requested runners match enabled ones', async () => {
    // Use a real pool but with generatePlan rejecting, simulating the case
    // where all requested runners are disabled.
    const noMatchPool = fakePool({
      generatePlan: vi.fn().mockRejectedValue(new Error('None of the requested runners are enabled')),
    });
    const { plansRoute: plansRoute2 } = await import('../../routes/plans');
    const app2 = new Hono();
    app2.route('/api/plans', plansRoute2(noMatchPool));

    const res = await app2.request('/api/plans/s1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'test goal', runners: ['disabled-runner'] }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('requested runners');
  });

  // A missing workspace is a readable 400, not a 500 with a stack — the
  // client (TUI, VS Code, web) shows the message directly.
  it('reports a missing workspace as a 400 with a readable message, not a 500', async () => {
    const badWorkspacePool = fakePool({
      generatePlan: vi.fn().mockRejectedValue(new WorkspaceNotFoundError('/nope')),
    });
    const { plansRoute: plansRouteForBadWs } = await import('../../routes/plans');
    const app2 = new Hono();
    app2.route('/api/plans', plansRouteForBadWs(badWorkspacePool));

    const res = await app2.request('/api/plans/s1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'test goal', runners: ['opencode'] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('/nope');
  });

  // A workspace with no project marker (e.g. the filesystem root) is a
  // readable 400, not a 500 — same reasoning as the missing-workspace case.
  it('reports a non-project workspace as a 400 with a readable message, not a 500', async () => {
    const notAProjectPool = fakePool({
      generatePlan: vi.fn().mockRejectedValue(new WorkspaceNotAProjectError('/')),
    });
    const { plansRoute: plansRouteForNonProject } = await import('../../routes/plans');
    const app2 = new Hono();
    app2.route('/api/plans', plansRouteForNonProject(notAProjectPool));

    const res = await app2.request('/api/plans/s1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'test goal', runners: ['opencode'] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('/');
  });

  it('accepts runners from query param ?runners= comma-separated', async () => {
    const res = await app.request('/api/plans/s1/generate?runners=claude-code,opencode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'test goal' }),
    });

    expect(res.status).toBe(200);
    expect(pool.generatePlan).toHaveBeenCalledWith('s1', 'test goal', ['claude-code', 'opencode'], expect.any(String), undefined, { allowInit: undefined });
  });
});

describe('task control routes', () => {
  it.each([
    ['run', 'runTask'],
    ['force-start', 'forceStartTask'],
    ['retry', 'retryTask'],
    ['cancel', 'cancelTask'],
  ])('POST tasks/:taskId/%s calls session.%s', async (segment, method) => {
    const sessionMethods = { runTask: vi.fn(), forceStartTask: vi.fn(), retryTask: vi.fn(), cancelTask: vi.fn() };
    const pool = fakePool({ session: vi.fn().mockReturnValue(sessionMethods) } as never);
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));

    const res = await app.request(`/api/plans/s1/tasks/t9/${segment}`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((sessionMethods as never)[method]).toHaveBeenCalledWith('t9');
  });

  it('returns 404 for an unknown session', async () => {
    const pool = fakePool({
      session: vi.fn().mockImplementation(() => { throw new Error('Session not found'); }),
    } as never);
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));

    const res = await app.request('/api/plans/nope/tasks/t9/retry', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('does not shadow the tasks/merge route', async () => {
    const requestMerge = vi.fn().mockResolvedValue({ tasks: [] });
    const pool = fakePool({ session: vi.fn().mockReturnValue({ requestMerge }) } as never);
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));

    const res = await app.request('/api/plans/s1/tasks/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: ['a', 'b'] }),
    });

    expect(res.status).toBe(200);
    expect(requestMerge).toHaveBeenCalledWith(['a', 'b']);
  });
});

describe('POST /:sessionId/process-queued', () => {
  it('drains queued edits on the session so dependents resume fan-out', async () => {
    const processQueuedMessages = vi.fn().mockResolvedValue(undefined);
    const pool = fakePool({ session: vi.fn().mockReturnValue({ processQueuedMessages }) } as never);
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));

    const res = await app.request('/api/plans/s1/process-queued', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(processQueuedMessages).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for an unknown session', async () => {
    const pool = fakePool({
      session: vi.fn().mockImplementation(() => { throw new Error('Session not found'); }),
    } as never);
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));

    const res = await app.request('/api/plans/nope/process-queued', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

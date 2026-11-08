import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { WorkspaceNotFoundError, WorkspaceNotAProjectError, SessionNotFoundError } from '@ordewell/core';

import type { OrchestratorPool } from '../../pool/orchestratorPool';

function fakePool(overrides: Partial<OrchestratorPool> = {}): OrchestratorPool {
  const pool = {
    generatePlan: vi.fn().mockResolvedValue({ phase: 'planning', history: [], message: '', pendingTasks: [] }),
    getProviderModels: vi.fn().mockResolvedValue({ models: [], modelsByRunner: {}, orchestratorModel: '', providers: [] }),
    session: vi.fn().mockReturnValue({ planState: null }),
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
  // client (TUI, VS Code) shows the message directly.
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

describe('the execute-command route', () => {
  const send = async (execute: ReturnType<typeof vi.fn>, body: unknown, sessionId = 's1') => {
    const pool = fakePool({ session: vi.fn().mockReturnValue({ execute }) } as never);
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));
    return app.request(`/api/plans/${sessionId}/execute-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  it.each([
    { command: 'run_task', task: 't9' },
    { command: 'retry_task', task: 't9', from: 'fresh' },
    { command: 'stop_task', task: 't9' },
  ])('reaches the command seam as the user: %j', async (command) => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'done' });

    const res = await send(execute, command);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'done' });
    expect(execute).toHaveBeenCalledWith(command, { kind: 'user' });
  });

  it('answers a force start\'s queued line from its payload', async () => {
    const line = 'Task "Deploy" is approved and starts once task "Build" finishes.';
    const execute = vi.fn().mockResolvedValue({ ok: true, message: line, payload: { kind: 'queued', line } });

    const res = await send(execute, { command: 'force_start', task: 't9' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: line, payload: { kind: 'queued', line } });
    expect(execute).toHaveBeenCalledWith({ command: 'force_start', task: 't9' }, { kind: 'user' });
  });

  it('answers a seam refusal with 400 and its reason', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, outcome: 'refused', message: 'Task #9 "Deploy" is not running: there is nothing to stop.' });

    const res = await send(execute, { command: 'stop_task', task: 't9' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Task #9 "Deploy" is not running: there is nothing to stop.', code: 'refused' });
  });

  it('keeps the result of a Merge all that git stopped with its refusal', async () => {
    const result = { status: 'conflict', conflicts: ['a.ts'] };
    const execute = vi.fn().mockResolvedValue({ ok: false, outcome: 'refused', message: 'The merge stopped.', payload: { kind: 'merge', result } });

    const res = await send(execute, { command: 'merge_all' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The merge stopped.', code: 'refused', payload: { kind: 'merge', result } });
  });

  it('returns 404 for an unknown session', async () => {
    const pool = fakePool({
      session: vi.fn().mockImplementation(() => { throw new SessionNotFoundError(); }),
    } as never);
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));

    const res = await app.request('/api/plans/nope/execute-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'retry_task', task: 't9', from: 'fresh' }),
    });
    expect(res.status).toBe(404);
  });

  it('does not expose the retired task merge or split endpoints', async () => {
    const requestMerge = vi.fn();
    const requestSplit = vi.fn();
    const continuePlanning = vi.fn();
    const pool = fakePool({
      session: vi.fn().mockReturnValue({ requestMerge, requestSplit }),
      continuePlanning,
    } as never);
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));

    for (const [path, body] of [
      ['/api/plans/s1/tasks/merge', { taskIds: ['a', 'b'] }],
      ['/api/plans/s1/tasks/t1/split', {}],
    ] as const) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(404);
    }

    expect(requestMerge).not.toHaveBeenCalled();
    expect(requestSplit).not.toHaveBeenCalled();
    expect(continuePlanning).not.toHaveBeenCalled();
  });
});

describe('run controls reach the command seam as the user', () => {
  async function appFor(session: Record<string, unknown>): Promise<Hono> {
    const planSession = { planState: { tasks: [{}] }, planTasks: [{}], isExecuting: false, ...session };
    const pool = fakePool({ live: vi.fn().mockReturnValue(planSession), session: vi.fn().mockReturnValue(planSession) } as never);
    const { plansRoute } = await import('../../routes/plans');
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));
    return app;
  }

  it('POST /:sessionId/execute runs the plan through the seam', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'The plan is running.' });
    const res = await (await appFor({ execute })).request('/api/plans/s1/execute', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'running', message: 'The plan is running.' });
    expect(execute).toHaveBeenCalledWith({ command: 'run_plan' }, { kind: 'user' });
  });

  it('POST /:sessionId/execute answers a seam refusal with 400', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, outcome: 'refused', message: 'The plan is already running.' });
    const res = await (await appFor({ execute })).request('/api/plans/s1/execute', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The plan is already running.', code: 'refused' });
  });

  it('POST /:sessionId/stop stops the run through the seam', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Stopped the run.' });
    const res = await (await appFor({ execute })).request('/api/plans/s1/stop', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'stopped', message: 'Stopped the run.' });
    expect(execute).toHaveBeenCalledWith({ command: 'stop_run' }, { kind: 'user' });
  });
});

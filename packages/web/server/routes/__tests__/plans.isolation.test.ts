import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { PlanEditError } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

function appFor(session: Record<string, unknown>) {
  const pool = {
    session: vi.fn((id: string) => {
      if (id !== 's1') throw new Error('Session not found');
      return session;
    }),
  } as unknown as OrchestratorPool;
  const app = new Hono();
  app.route('/api/plans', plansRoute(pool));
  return app;
}

function post(app: Hono, path: string, sessionId = 's1') {
  return app.request(`/api/plans/${sessionId}/${path}`, { method: 'POST' });
}

describe('GET /:sessionId/isolation/diff', () => {
  it('answers the integration branch diff', async () => {
    const reviewRunDiff = vi.fn().mockResolvedValue('diff --git a/x b/x\n');
    const app = appFor({ reviewRunDiff });

    const res = await app.request('/api/plans/s1/isolation/diff');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ diff: 'diff --git a/x b/x\n' });
  });

  it('is a 400 when the plan has no isolated run', async () => {
    const app = appFor({ reviewRunDiff: vi.fn().mockRejectedValue(new PlanEditError('This plan has no isolated run')) });

    const res = await app.request('/api/plans/s1/isolation/diff');

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no isolated run/);
  });

  it('is a 404 for a session the daemon does not hold', async () => {
    const app = appFor({ reviewRunDiff: vi.fn() });

    expect((await app.request('/api/plans/nope/isolation/diff')).status).toBe(404);
  });
});

describe('POST /:sessionId/isolation/merge', () => {
  it.each(['merged', 'conflict', 'failed'] as const)('reports a %s merge as an outcome, not an HTTP error', async (outcome) => {
    const mergeRun = vi.fn().mockResolvedValue({ outcome });
    const app = appFor({ mergeRun });

    const res = await post(app, 'isolation/merge');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome });
  });

  it('passes on which repo stopped the merge and its conflicted files', async () => {
    const app = appFor({ mergeRun: vi.fn().mockResolvedValue({ outcome: 'conflict', repo: '.', files: ['shared.txt'] }) });

    const res = await post(app, 'isolation/merge');

    expect(await res.json()).toEqual({ outcome: 'conflict', repo: '.', files: ['shared.txt'] });
  });

  it('answers a blocked Merge all whole: each repo, why, and its files', async () => {
    const blocked = [
      { repo: 'api', reason: 'conflict', files: ['src/a.ts'] },
      { repo: 'web', reason: 'uncommitted-changes', files: ['index.html'] },
      { repo: 'infra', reason: 'merge-in-progress', files: [] },
    ];
    const app = appFor({ mergeRun: vi.fn().mockResolvedValue({ outcome: 'blocked', blocked }) });

    const res = await post(app, 'isolation/merge');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'blocked', blocked });
  });

  it('answers a Merge all that stopped part-way with the repos that stay merged', async () => {
    const result = { outcome: 'conflict', repo: 'web', files: ['web.txt'], landed: ['api'] };
    const app = appFor({ mergeRun: vi.fn().mockResolvedValue(result) });

    expect(await (await post(app, 'isolation/merge')).json()).toEqual(result);
  });

  it('is a 400 while the run is still running', async () => {
    const app = appFor({ mergeRun: vi.fn().mockRejectedValue(new PlanEditError('The run is still running — stop it first')) });

    expect((await post(app, 'isolation/merge')).status).toBe(400);
  });
});

describe.each([
  ['isolation/discard', 'discardRun'],
  ['isolation/cleanup', 'cleanupRun'],
  ['isolation/stash-and-continue', 'continueWithStash'],
  ['isolation/run-without', 'continueWithoutIsolation'],
] as const)('POST /:sessionId/%s', (path, method) => {
  it(`calls Session.${method}`, async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const app = appFor({ [method]: fn });

    const res = await post(app, path);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('is a 400 when the session refuses', async () => {
    const app = appFor({ [method]: vi.fn().mockRejectedValue(new PlanEditError('nope')) });

    expect((await post(app, path)).status).toBe(400);
  });

  it('is a 404 for a session the daemon does not hold', async () => {
    const app = appFor({ [method]: vi.fn() });

    expect((await post(app, path, 'nope')).status).toBe(404);
  });
});

describe('POST /:sessionId/tasks/:taskId/resolve-conflict', () => {
  it('adds the resolver task and answers the plan', async () => {
    const resolveConflictAsTask = vi.fn().mockResolvedValue({ tasks: [{ id: 'resolver' }] });
    const app = appFor({ resolveConflictAsTask });

    const res = await post(app, 'tasks/t2/resolve-conflict');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: { tasks: [{ id: 'resolver' }] } });
    expect(resolveConflictAsTask).toHaveBeenCalledWith('t2');
  });

  it('is a 400 for a task that has no conflict', async () => {
    const app = appFor({
      resolveConflictAsTask: vi.fn().mockRejectedValue(new PlanEditError('Only a task whose merge conflicted can be resolved as a task')),
    });

    expect((await post(app, 'tasks/t2/resolve-conflict')).status).toBe(400);
  });
});

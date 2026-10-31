import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createTask, PlanEditError, SessionNotFoundError } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

function appFor(session: Record<string, unknown>) {
  const pool = {
    session: vi.fn((id: string) => {
      if (id !== 's1') throw new SessionNotFoundError();
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

describe('GET /:sessionId/tasks/:taskId/merge-gate (ADR-0020)', () => {
  it('names each dependency whose work is not merged yet', async () => {
    const mergeGate = vi.fn().mockReturnValue(['fix']);
    const app = appFor({ mergeGate, planState: { tasks: [createTask({ id: 'fix', order: 1, title: 'Fix' }), createTask({ id: 'ops', order: 2, title: 'Deploy', ops: true })] } });

    const res = await app.request('/api/plans/s1/tasks/ops/merge-gate');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mergeGate: [{ id: 'fix', order: 1, title: 'Fix' }] });
    expect(mergeGate).toHaveBeenCalledWith('ops');
  });

  it('is empty for a task nothing gates, and a 404 for a session the daemon does not hold', async () => {
    const app = appFor({ mergeGate: vi.fn().mockReturnValue([]), planState: null });

    expect(await (await app.request('/api/plans/s1/tasks/t1/merge-gate')).json()).toEqual({ mergeGate: [] });
    expect((await app.request('/api/plans/nope/tasks/t1/merge-gate')).status).toBe(404);
  });
});

describe('GET /:sessionId/tasks/:taskId/revert-preview (ADR-0054)', () => {
  const planState = { tasks: [createTask({ id: 'fix', order: 3, title: 'Fix' })] };

  it('answers what a revert would take, for the reference the user typed', async () => {
    const preview = { revertible: true, tasks: [{ taskId: 'fix', order: 3, title: 'Fix', repos: ['.'], dependent: false }] };
    const revertPreview = vi.fn().mockResolvedValue(preview);
    const app = appFor({ revertPreview, planState });

    const res = await app.request('/api/plans/s1/tasks/%233/revert-preview');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(preview);
    expect(revertPreview).toHaveBeenCalledWith('fix');
  });

  it('answers a refusal 200, as what the surface shows, and a 404 for a session the daemon does not hold', async () => {
    const refused = { revertible: false, reason: 'in-branch', message: 'Already merged.', commands: [] };
    const app = appFor({ revertPreview: vi.fn().mockResolvedValue(refused), planState });

    const res = await app.request('/api/plans/s1/tasks/fix/revert-preview');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(refused);
    expect((await app.request('/api/plans/nope/tasks/fix/revert-preview')).status).toBe(404);
  });
});

/** What the seam answers the user's Merge all: the result in its payload, refused when git stopped it. */
const merged = (result: { outcome: string }) => result.outcome === 'merged'
  ? { ok: true, message: 'Merged.', payload: { kind: 'merge', result } }
  : { ok: false, outcome: 'refused', message: 'Merge all stopped.', payload: { kind: 'merge', result } };

describe('POST /:sessionId/isolation/merge', () => {
  it.each(['merged', 'conflict', 'failed'] as const)('reports a %s merge as an outcome, not an HTTP error', async (outcome) => {
    const execute = vi.fn().mockResolvedValue(merged({ outcome }));
    const app = appFor({ execute });

    const res = await post(app, 'isolation/merge');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome });
    expect(execute).toHaveBeenCalledWith({ command: 'merge_all' }, { kind: 'user' });
  });

  it('passes on which repo stopped the merge and its conflicted files', async () => {
    const app = appFor({ execute: vi.fn().mockResolvedValue(merged({ outcome: 'conflict', repo: '.', files: ['shared.txt'] } as never)) });

    const res = await post(app, 'isolation/merge');

    expect(await res.json()).toEqual({ outcome: 'conflict', repo: '.', files: ['shared.txt'] });
  });

  it('answers a blocked Merge all whole: each repo, why, and its files', async () => {
    const blocked = [
      { repo: 'api', reason: 'conflict', files: ['src/a.ts'] },
      { repo: 'web', reason: 'uncommitted-changes', files: ['index.html'] },
      { repo: 'infra', reason: 'merge-in-progress', files: [] },
    ];
    const app = appFor({ execute: vi.fn().mockResolvedValue(merged({ outcome: 'blocked', blocked } as never)) });

    const res = await post(app, 'isolation/merge');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'blocked', blocked });
  });

  it('answers a Merge all that stopped part-way with the repos that stay merged', async () => {
    const result = { outcome: 'conflict', repo: 'web', files: ['web.txt'], landed: ['api'] };
    const app = appFor({ execute: vi.fn().mockResolvedValue(merged(result)) });

    expect(await (await post(app, 'isolation/merge')).json()).toEqual(result);
  });

  it('is a 400, with the reason, when the seam refused before merging anything', async () => {
    const app = appFor({ execute: vi.fn().mockResolvedValue({ ok: false, outcome: 'refused', message: 'The run is still running — stop it first' }) });

    const res = await post(app, 'isolation/merge');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The run is still running — stop it first', code: 'refused' });
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
    const resolveConflictAsTask = vi.fn().mockResolvedValue({ tasks: [{ id: 'resolver', subtasks: [] }] });
    const app = appFor({ resolveConflictAsTask });

    const res = await post(app, 'tasks/t2/resolve-conflict');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: { tasks: [{ id: 'resolver', subtasks: [] }] } });
    expect(resolveConflictAsTask).toHaveBeenCalledWith('t2');
  });

  it('is a 400 for a task that has no conflict', async () => {
    const app = appFor({
      resolveConflictAsTask: vi.fn().mockRejectedValue(new PlanEditError('Only a task whose merge conflicted can be resolved as a task')),
    });

    expect((await post(app, 'tasks/t2/resolve-conflict')).status).toBe(400);
  });

  it('is a 400 in the seam\'s words for a conflict that has its worker', async () => {
    const app = appFor({
      resolveConflictAsTask: vi.fn().mockRejectedValue(new PlanEditError('Task "R" already resolves the conflict of task "T". Skip or remove it to add another.')),
    });

    const res = await post(app, 'tasks/t2/resolve-conflict');

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('already resolves');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { loadSessionPlanState } from '@ordewell/core';
import { sessionsRoute } from '../sessions';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

vi.mock('@ordewell/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ordewell/core')>()),
  loadSessionPlanState: vi.fn(),
}));

const readSaved = vi.mocked(loadSessionPlanState);

function fakePool(overrides: Partial<OrchestratorPool> = {}): OrchestratorPool {
  return {
    adoptSavedSession: vi.fn().mockReturnValue({ tasks: [{ id: 't1' }], runners: ['opencode'] }),
    getGoal: vi.fn().mockReturnValue('Rate limiting'),
    getPlanState: vi.fn().mockReturnValue(null),
    destroy: vi.fn(),
    ...overrides,
  } as unknown as OrchestratorPool;
}

describe('GET /api/sessions/:id', () => {
  const savedPlan = {
    phase: 'executing',
    history: [],
    message: '',
    executionLog: [],
    // What the file gives back: the disk boundary rewrites a live in_progress
    // to pending, because a session off disk has no runners behind it.
    pendingTasks: [{ id: 't1', order: 1, title: 'One', status: 'pending' }],
    goal: 'g',
    runners: ['opencode'],
    status: 'running',
  };
  const saved = { meta: { id: 's1', goal: 'g' }, plan: savedPlan };

  beforeEach(() => {
    readSaved.mockReset();
    readSaved.mockReturnValue(saved as never);
  });

  function appWith(pool: OrchestratorPool): Hono {
    const app = new Hono();
    app.route('/api/sessions', sessionsRoute(pool));
    return app;
  }

  it('serves the live plan while the pool holds the session — a running task must not read as pending', async () => {
    const livePlan = { ...savedPlan, pendingTasks: [{ id: 't1', order: 1, title: 'One', status: 'in_progress' }] };
    const pool = fakePool({ getPlanState: vi.fn().mockReturnValue(livePlan) } as Partial<OrchestratorPool>);

    const res = await appWith(pool).request('/api/sessions/s1?workspace=/ws');

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.plan.pendingTasks[0].status).toBe('in_progress');
    expect(body.meta.id).toBe('s1');
    expect(pool.getPlanState).toHaveBeenCalledWith('s1');
  });

  it('falls back to the saved plan when no live session holds that id', async () => {
    const res = await appWith(fakePool()).request('/api/sessions/s1?workspace=/ws');

    const body: any = await res.json();
    expect(body.plan.pendingTasks[0].status).toBe('pending');
  });

  it('answers 404 when there is no saved session in that workspace', async () => {
    readSaved.mockReturnValue(null);

    const res = await appWith(fakePool()).request('/api/sessions/nope?workspace=/ws');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/sessions/:id/load', () => {
  let app: Hono;
  let pool: OrchestratorPool;

  beforeEach(() => {
    pool = fakePool();
    app = new Hono();
    app.route('/api/sessions', sessionsRoute(pool));
  });

  it('registers the saved session with the pool so its tasks become live', async () => {
    const res = await app.request('/api/sessions/s1/load?workspace=/ws', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(pool.adoptSavedSession).toHaveBeenCalledWith('s1', '/ws');
  });

  it('returns the restored plan', async () => {
    const res = await app.request('/api/sessions/s1/load?workspace=/ws', { method: 'POST' });

    const body: any = await res.json();
    expect(body.plan.tasks).toHaveLength(1);
  });

  // The client needs the goal to label the session; a second round trip to
  // GET /:id just to read it would be wasteful.
  it('returns the restored goal alongside the plan', async () => {
    const res = await app.request('/api/sessions/s1/load?workspace=/ws', { method: 'POST' });
    expect((await res.json() as any).goal).toBe('Rate limiting');
  });

  it('falls back to the server cwd when no workspace is given', async () => {
    await app.request('/api/sessions/s1/load', { method: 'POST' });
    expect(pool.adoptSavedSession).toHaveBeenCalledWith('s1', process.cwd());
  });

  it('answers 404 when there is no such session on disk', async () => {
    const missing = fakePool({
      adoptSavedSession: vi.fn().mockImplementation(() => { throw new Error('Session not found'); }),
    });
    const app2 = new Hono();
    app2.route('/api/sessions', sessionsRoute(missing));

    const res = await app2.request('/api/sessions/nope/load', { method: 'POST' });

    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('Session not found');
  });

  it('answers 500 when adopting fails for another reason', async () => {
    const broken = fakePool({
      adoptSavedSession: vi.fn().mockImplementation(() => { throw new Error('disk on fire'); }),
    });
    const app2 = new Hono();
    app2.route('/api/sessions', sessionsRoute(broken));

    const res = await app2.request('/api/sessions/s1/load', { method: 'POST' });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/sessions/:id/close', () => {
  it('destroys the session in the pool, stopping its orchestrator and tmux runners', async () => {
    const pool = fakePool();
    const app = new Hono();
    app.route('/api/sessions', sessionsRoute(pool));

    const res = await app.request('/api/sessions/s1/close', { method: 'POST' });

    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
    expect(pool.destroy).toHaveBeenCalledWith('s1');
  });
});

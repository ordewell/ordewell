import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSessionPlanState, openTaskLog, SessionNotFoundError } from '@ordewell/core';
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
    const body = (await res.json()) as { plan: { pendingTasks: Array<{ status: string }> }; meta: { id: string } };
    expect(body.plan.pendingTasks[0].status).toBe('in_progress');
    expect(body.meta.id).toBe('s1');
    expect(pool.getPlanState).toHaveBeenCalledWith('s1');
  });

  it('falls back to the saved plan when no live session holds that id', async () => {
    const res = await appWith(fakePool()).request('/api/sessions/s1?workspace=/ws');

    const body = (await res.json()) as { plan: { pendingTasks: Array<{ status: string }> } };
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

    const body = (await res.json()) as { plan: { tasks: unknown[] } };
    expect(body.plan.tasks).toHaveLength(1);
  });

  // The client needs the goal to label the session; a second round trip to
  // GET /:id just to read it would be wasteful.
  it('returns the restored goal alongside the plan', async () => {
    const res = await app.request('/api/sessions/s1/load?workspace=/ws', { method: 'POST' });
    expect(((await res.json()) as { goal?: string }).goal).toBe('Rate limiting');
  });

  it('falls back to the server cwd when no workspace is given', async () => {
    await app.request('/api/sessions/s1/load', { method: 'POST' });
    expect(pool.adoptSavedSession).toHaveBeenCalledWith('s1', process.cwd());
  });

  it('answers 404 when there is no such session on disk', async () => {
    const missing = fakePool({
      adoptSavedSession: vi.fn().mockImplementation(() => { throw new SessionNotFoundError(); }),
    });
    const app2 = new Hono();
    app2.route('/api/sessions', sessionsRoute(missing));

    const res = await app2.request('/api/sessions/nope/load', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe('Session not found');
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
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
    expect(pool.destroy).toHaveBeenCalledWith('s1');
  });
});

describe('GET /api/sessions/:id/tasks/:taskId/log', () => {
  let ws: string;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-route-tasklog-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  function app(): Hono {
    const a = new Hono();
    a.route('/api/sessions', sessionsRoute(fakePool()));
    return a;
  }

  it('lists a task’s attempts and serves one attempt’s events from disk', async () => {
    const where = { baseDir: ws, sessionId: 's1' };
    openTaskLog(where, 't1').append([{ type: 'turn_start', message: 'go' }]);
    openTaskLog(where, 't1').append([{ type: 'text', text: 'again' }]);
    const qs = `?workspace=${encodeURIComponent(ws)}`;

    const list = await app().request(`/api/sessions/s1/tasks/t1/log${qs}`);
    expect(await list.json()).toEqual({ attempts: [1, 2] });

    const second = await app().request(`/api/sessions/s1/tasks/t1/log/2${qs}`);
    expect(await second.json()).toEqual({ attempt: 2, events: [{ type: 'text', text: 'again' }] });
  });

  it('answers an empty log for a task that has none, and refuses a malformed attempt', async () => {
    const qs = `?workspace=${encodeURIComponent(ws)}`;
    expect(await (await app().request(`/api/sessions/s1/tasks/none/log${qs}`)).json()).toEqual({ attempts: [] });
    expect((await app().request(`/api/sessions/s1/tasks/t1/log/zero${qs}`)).status).toBe(400);
  });
});

describe('skill bodies on the sessions routes', () => {
  const BODY = 'SECRET-SKILL-BODY';
  const attempt = { name: 'tdd', source: 'global', path: '~/.ordewell/skills/tdd/SKILL.md', content: BODY };
  const load = { invokedBy: 'user', name: 'grilling', source: 'global', path: '~/.ordewell/skills/grilling/SKILL.md', content: BODY };
  const appWith = (pool: OrchestratorPool): Hono => {
    const app = new Hono();
    app.route('/api/sessions', sessionsRoute(pool));
    return app;
  };

  it('GET /:id sends task attempts as notices', async () => {
    readSaved.mockReturnValue({ meta: { id: 's1' }, plan: { phase: 'planning', history: [], message: '', pendingTasks: [{ id: 't1', subtasks: [], attemptSkills: [attempt] }] } } as never);

    const res = await appWith(fakePool()).request('/api/sessions/s1?workspace=/ws');

    const text = await res.text();
    expect(text).not.toContain(BODY);
    expect(JSON.parse(text).plan.pendingTasks[0].attemptSkills).toEqual([{ name: 'tdd', source: 'global', path: attempt.path }]);
  });

  it('POST /:id/load sends the loaded plan with notices for its skill loads and queue', async () => {
    const plan = {
      tasks: [{ id: 't1', subtasks: [], attemptSkills: [attempt] }],
      runners: [],
      conversationHistory: [{ role: 'user', content: 'x', timestamp: 't', kind: 'skill_load', skill: load }],
      queuedMessages: [{ id: 'q1', text: 'go', timestamp: 't', skills: [load] }],
    };

    const res = await appWith(fakePool({ adoptSavedSession: vi.fn().mockReturnValue(plan) } as Partial<OrchestratorPool>)).request('/api/sessions/s1/load?workspace=/ws', { method: 'POST' });

    const text = await res.text();
    expect(text).not.toContain(BODY);
    expect(JSON.parse(text).plan.conversationHistory[0].skill).toEqual({ invokedBy: 'user', name: 'grilling', source: 'global', path: load.path });
  });
});

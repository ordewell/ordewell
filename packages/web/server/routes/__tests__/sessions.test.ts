import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWorktreeIsolation, listChildSessions, listSessions, loadSessionPlanState, openTaskLog, saveChildSession, saveSession, SessionHeldError, SessionNotFoundError } from '@ordewell/core';
import { sessionsRoute } from '../sessions';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

vi.mock('@ordewell/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ordewell/core')>()),
  loadSessionPlanState: vi.fn(),
  createWorktreeIsolation: vi.fn((await importOriginal<typeof import('@ordewell/core')>()).createWorktreeIsolation),
}));

const readSaved = vi.mocked(loadSessionPlanState);

function fakePool(overrides: Partial<OrchestratorPool> = {}): OrchestratorPool {
  return {
    adoptSavedSession: vi.fn().mockReturnValue({ tasks: [{ id: 't1' }], runners: ['opencode'] }),
    getGoal: vi.fn().mockReturnValue('Rate limiting'),
    getPlanState: vi.fn().mockReturnValue(null),
    runSnapshot: vi.fn().mockReturnValue(null),
    plannerTurnId: vi.fn().mockReturnValue(undefined),
    plannerCompaction: vi.fn().mockReturnValue(undefined),
    streamPosition: vi.fn().mockReturnValue({ stream: 'daemon', seq: 12 }),
    hasSession: vi.fn().mockReturnValue(false),
    stopTree: vi.fn(async () => undefined),
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

  it('carries the live session\'s run view, so a surface refreshing does not rebuild isolation from the saved record', async () => {
    const view = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
    const pool = fakePool({ getPlanState: vi.fn().mockReturnValue(savedPlan), runSnapshot: vi.fn().mockReturnValue(view) } as Partial<OrchestratorPool>);

    const res = await appWith(pool).request('/api/sessions/s1?workspace=/ws');

    expect(((await res.json()) as { run?: unknown }).run).toEqual(view);
    expect(pool.runSnapshot).toHaveBeenCalledWith('s1');
  });

  // A surface refreshing mid-compaction has no turn to follow; this is how it
  // learns the planner is busy and which block to keep drawing.
  it('names the planner compaction the live session is running', async () => {
    const start = { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'manual', at: '2026-10-25T10:00:00.000Z' } };
    const pool = fakePool({ getPlanState: vi.fn().mockReturnValue(savedPlan), plannerCompaction: vi.fn().mockReturnValue(start) } as Partial<OrchestratorPool>);

    const res = await appWith(pool).request('/api/sessions/s1?workspace=/ws');

    expect(((await res.json()) as { plannerCompaction?: unknown }).plannerCompaction).toEqual(start);
    expect(pool.plannerCompaction).toHaveBeenCalledWith('s1');
  });

  it('leaves the compaction out when none is running', async () => {
    const res = await appWith(fakePool()).request('/api/sessions/s1?workspace=/ws');

    expect(await res.json()).not.toHaveProperty('plannerCompaction');
  });

  it('leaves the run view out for a session nobody holds', async () => {
    const res = await appWith(fakePool()).request('/api/sessions/s1?workspace=/ws');

    expect(await res.json()).not.toHaveProperty('run');
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

  it('hands back the adopted session\'s run view', async () => {
    const view = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
    (pool.runSnapshot as ReturnType<typeof vi.fn>).mockReturnValue(view);

    const res = await app.request('/api/sessions/s1/load?workspace=/ws', { method: 'POST' });

    expect(((await res.json()) as { run?: unknown }).run).toEqual(view);
  });

  it('registers the saved session with the pool so its tasks become live', async () => {
    const res = await app.request('/api/sessions/s1/load?workspace=/ws', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(pool.adoptSavedSession).toHaveBeenCalledWith('s1', '/ws');
  });

  // A surface that lost the turn's end reads this back to tell a gate the
  // daemon has closed from one a live turn still holds.
  it('names the planner turn the adopted session is running', async () => {
    const running = fakePool({ plannerTurnId: vi.fn().mockReturnValue('t1') });
    const app2 = new Hono();
    app2.route('/api/sessions', sessionsRoute(running));

    const res = await app2.request('/api/sessions/s1/load', { method: 'POST' });

    expect(((await res.json()) as { plannerTurnId?: string }).plannerTurnId).toBe('t1');
  });

  it('names the planner compaction the adopted session is running, which has no turn of its own', async () => {
    const start = { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'auto', at: '2026-10-25T10:00:00.000Z' } };
    const running = fakePool({ plannerCompaction: vi.fn().mockReturnValue(start) });
    const app2 = new Hono();
    app2.route('/api/sessions', sessionsRoute(running));

    const body = (await (await app2.request('/api/sessions/s1/load', { method: 'POST' })).json()) as Record<string, unknown>;

    expect(body.plannerCompaction).toEqual(start);
    expect(body).not.toHaveProperty('plannerTurnId');
  });

  it('leaves the compaction out of an adoption when none is running', async () => {
    const res = await app.request('/api/sessions/s1/load', { method: 'POST' });

    expect(await res.json()).not.toHaveProperty('plannerCompaction');
  });

  it('leaves the turn out when no planner turn is running', async () => {
    const res = await app.request('/api/sessions/s1/load', { method: 'POST' });

    expect(await res.json()).not.toHaveProperty('plannerTurnId');
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

  // ADR-0049: a session another live host runs is refused with a code a client
  // switches on, and the holder as data beside the plain-words message.
  it('answers 409 session_held, naming the holder, when another host runs the session', async () => {
    const holder = { hostId: 'host-a', pid: 37797, host: { kind: 'daemon' as const, port: 3742 }, since: '2026-10-24T01:40:00.000Z', heartbeatAt: '2026-10-24T01:54:00.000Z', runnerGroups: [] };
    const held = fakePool({
      adoptSavedSession: vi.fn().mockImplementation(() => { throw new SessionHeldError({ holder }); }),
    });
    const app2 = new Hono();
    app2.route('/api/sessions', sessionsRoute(held));

    const res = await app2.request('/api/sessions/s1/load', { method: 'POST' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string; sessionHeld?: { holder: { pid: number } } };
    expect(body.code).toBe('session_held');
    expect(body.sessionHeld?.holder.pid).toBe(37797);
    expect(body.error).toContain('the Ordewell daemon on port 3742 (pid 37797)');
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

describe('DELETE /api/sessions/:id', () => {
  let ws: string;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-route-delete-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  const savedPlan = { tasks: [], runners: [], status: 'draft', generatedAt: '2026-10-13T00:00:00.000Z' };

  it('stops the live session before removing its files, or its next save writes them back', async () => {
    const meta = saveSession(savedPlan as never, 'g', ws, 's1');
    const filesWhenDestroyed: boolean[] = [];
    const pool = fakePool({
      stopTree: vi.fn(async () => undefined),
      destroy: vi.fn(() => { filesWhenDestroyed.push(listSessions(ws).some((s) => s.id === meta.id)); }),
    } as Partial<OrchestratorPool>);
    const app = new Hono();
    app.route('/api/sessions', sessionsRoute(pool));

    const res = await app.request(`/api/sessions/${meta.id}?workspace=${encodeURIComponent(ws)}`, { method: 'DELETE' });

    expect(await res.json()).toEqual({ ok: true });
    expect(pool.destroy).toHaveBeenCalledWith(meta.id, { notifyClients: true });
    expect(filesWhenDestroyed).toEqual([true]);
    expect(listSessions(ws)).toEqual([]);
  });

  it('discards a child\'s run first, and keeps the session when git could not let it go', async () => {
    const meta = saveSession(savedPlan as never, 'g', ws, 's1');
    saveChildSession({ ...savedPlan, isolation: { run: { id: 'child-run', workspaceRoot: path.join(ws, 'gone'), stateRoot: ws, repos: [], shared: [], sharedRepos: [], tasks: {} }, resolvers: {} } } as never, 'sub', { baseDir: ws, rootSessionId: meta.id, sessionId: 'child' });
    vi.mocked(createWorktreeIsolation).mockReturnValueOnce({
      discard: vi.fn().mockResolvedValue({ preserved: [], refused: [{ worktree: '/w/child', reason: 'git said no' }] }),
    } as never);
    const app = new Hono();
    app.route('/api/sessions', sessionsRoute(fakePool()));

    const res = await app.request(`/api/sessions/${meta.id}?workspace=${encodeURIComponent(ws)}`, { method: 'DELETE' });

    expect(await res.json()).toEqual({ ok: false, message: 'The session was kept: /w/child (git said no)' });
    expect(listSessions(ws).map((s) => s.id)).toEqual([meta.id]);
    expect(listChildSessions(meta.id, ws)).toEqual(['child']);
  });

  it('still reports failure when there was no saved file to remove', async () => {
    const pool = fakePool();
    const app = new Hono();
    app.route('/api/sessions', sessionsRoute(pool));

    const res = await app.request(`/api/sessions/missing?workspace=${encodeURIComponent(ws)}`, { method: 'DELETE' });

    const body = (await res.json()) as { ok: boolean; message?: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain('missing');
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
    expect(pool.destroy).toHaveBeenCalledWith('s1', { notifyClients: true });
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
    expect(await list.json()).toEqual({ attempts: [1, 2], position: { stream: 'daemon', seq: 12 } });

    const second = await app().request(`/api/sessions/s1/tasks/t1/log/2${qs}`);
    expect(await second.json()).toEqual({ attempt: 2, events: [{ type: 'text', text: 'again' }], position: { stream: 'daemon', seq: 12 } });
  });

  it('answers an empty log for a task that has none, and refuses a malformed attempt', async () => {
    const qs = `?workspace=${encodeURIComponent(ws)}`;
    expect(await (await app().request(`/api/sessions/s1/tasks/none/log${qs}`)).json()).toEqual({ attempts: [], position: { stream: 'daemon', seq: 12 } });
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

  it('POST /:id/load sends the loaded plan with notices for its skill loads and pending turns', async () => {
    const plan = {
      tasks: [{ id: 't1', subtasks: [], attemptSkills: [attempt] }],
      runners: [],
      conversationHistory: [{ role: 'user', content: 'x', timestamp: 't', kind: 'skill_load', skill: load }],
      pendingTurns: [{ id: 'turn-1', source: 'user', text: 'go', timestamp: 't', skills: [load] }],
    };

    const res = await appWith(fakePool({ adoptSavedSession: vi.fn().mockReturnValue(plan) } as Partial<OrchestratorPool>)).request('/api/sessions/s1/load?workspace=/ws', { method: 'POST' });

    const text = await res.text();
    expect(text).not.toContain(BODY);
    expect(JSON.parse(text).plan.conversationHistory[0].skill).toEqual({ invokedBy: 'user', name: 'grilling', source: 'global', path: load.path });
  });
});

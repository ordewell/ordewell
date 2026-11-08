import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveSession, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { sessionsRoute } from '../sessions';
import { withReadyPlanner } from '../../__tests__/readyPlanner';

withReadyPlanner();

const plan = {
  status: 'approved',
  runners: ['opencode'],
  generatedAt: '2026-07-21T10:00:00.000Z',
  tasks: [{
    id: 't1', order: 1, title: 'Wire it up', type: 'ai', status: 'pending',
    description: 'd', prompt: 'wire it up', dependencies: [], assignedRunner: 'opencode', subtasks: [],
  }],
} as unknown as LegacyPlanState;

// An id names a session only within its workspace: a session open for one
// project must not answer a load for another that has no such session.
describe('POST /api/sessions/:id/load across workspaces', () => {
  let a: string;
  let b: string;
  let pool: OrchestratorPool;
  let app: Hono;

  const project = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-load-'));
    mkdirSync(join(dir, '.git'));
    return dir;
  };

  beforeEach(() => {
    a = project();
    b = project();
    pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    app = new Hono().route('/api/sessions', sessionsRoute(pool));
  });

  afterEach(() => {
    pool.destroyAll();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  const load = (workspace: string) => app.request(`/api/sessions/session-a/load?workspace=${encodeURIComponent(workspace)}`, { method: 'POST' });

  it('answers a load from another workspace that has no such session with 404, not the live session of the first', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    expect((await load(a)).status).toBe(200);

    const res = await load(b);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'session_not_found' });
  });

  // The pool keeps one session per id, so adopting B's copy would stop A's run and take its place.
  it('refuses a load of another workspace\'s session under an id held for the first, which keeps running', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    saveSession({ ...plan, tasks: [{ ...plan.tasks[0], title: 'B task' }] }, 'Goal', b, 'session-a');
    await load(a);
    const live = pool.session('session-a', undefined);

    const res = await load(b);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'refused' });
    expect(pool.session('session-a', undefined)).toBe(live);
    expect(live.workspaceRoot).toBe(a);
  });

  it('reads another workspace\'s session under the same id from its own file, not from the live one', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    saveSession({ ...plan, tasks: [{ ...plan.tasks[0], title: 'B task' }] }, 'Goal', b, 'session-a');
    await load(a);

    const res = await app.request(`/api/sessions/session-a?workspace=${encodeURIComponent(b)}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { pendingTasks: Array<{ title: string }> } };
    expect(body.plan.pendingTasks.map((t) => t.title)).toEqual(['B task']);
  });

  it('still answers a repeated load from the session\'s own workspace with the live session', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    await load(a);
    const live = pool.session('session-a', undefined);

    expect((await load(a)).status).toBe(200);
    expect(pool.session('session-a', undefined)).toBe(live);
  });
});

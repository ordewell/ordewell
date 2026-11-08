import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadSession, saveSession, SettingsService, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { sessionsRoute } from '../sessions';
import { plansRoute } from '../plans';
import { childrenRoute } from '../children';
import { approvalsRoute } from '../approvals';
import { settingsRoute } from '../settings';
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

/**
 * The pool keeps one session per id, so a project's saved copy of an id that
 * another project has open names a different session: what B's client asks of
 * it must never stop, close, delete or drive A's.
 */
describe('a request from one workspace leaves another\'s live session of the same id alone', () => {
  let a: string;
  let b: string;
  let pool: OrchestratorPool;
  let app: Hono;

  const project = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-del-'));
    mkdirSync(join(dir, '.git'));
    return dir;
  };

  beforeEach(() => {
    a = project();
    b = project();
    pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    app = new Hono()
      .route('/api/sessions', sessionsRoute(pool))
      .route('/api/sessions', childrenRoute(pool))
      .route('/api/plans', plansRoute(pool))
      .route('/api/approvals', approvalsRoute(pool))
      .route('/api/settings', settingsRoute(pool));
  });

  afterEach(() => {
    pool.destroyAll();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  const load = (workspace: string) => app.request(`/api/sessions/session-a/load?workspace=${encodeURIComponent(workspace)}`, { method: 'POST' });
  const del = (workspace: string) => app.request(`/api/sessions/session-a?workspace=${encodeURIComponent(workspace)}`, { method: 'DELETE' });
  const post = (path: string, workspace: string, body?: object) => app.request(`${path}?workspace=${encodeURIComponent(workspace)}`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const get = (path: string, workspace: string) => app.request(`${path}?workspace=${encodeURIComponent(workspace)}`);
  const refused = async (res: Response) => {
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('refused');
  };
  /** A holds session-a, and B has its own saved copy of the id. */
  const heldByA = async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    saveSession(plan, 'Goal', b, 'session-a');
    expect((await load(a)).status).toBe(200);
    return pool.session('session-a', undefined);
  };

  it('a delete from B does not stop A\'s live session of the same id', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    saveSession(plan, 'Goal', b, 'session-a');
    expect((await load(a)).status).toBe(200);
    const live = pool.session('session-a', undefined);

    const res = await del(b);

    expect(res.status).toBe(200);
    expect(pool.holds('session-a', a)).toBe(true);
    expect(pool.session('session-a', undefined)).toBe(live);
    expect(loadSession('session-a', a)).not.toBeNull();
    expect(loadSession('session-a', b)).toBeNull();
  });

  it('a delete from B with no B file does not answer ok by destroying A\'s live session', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    expect((await load(a)).status).toBe(200);

    const res = await del(b);
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(false);
    expect(pool.holds('session-a', a)).toBe(true);
  });

  it('a close from a B client showing B\'s saved copy does not close A\'s live session', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    saveSession(plan, 'Goal', b, 'session-a');
    expect((await load(a)).status).toBe(200);
    // B's client can read B's file while A holds the id (GET now serves it).
    expect((await app.request(`/api/sessions/session-a?workspace=${encodeURIComponent(b)}`)).status).toBe(200);

    const res = await app.request('/api/sessions/session-a/close', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(pool.holds('session-a', a)).toBe(true);
  });

  it('a close naming B leaves A\'s live session open, and one naming A closes it', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    expect((await load(a)).status).toBe(200);

    expect((await post('/api/sessions/session-a/close', b)).status).toBe(200);
    expect(pool.holds('session-a', a)).toBe(true);

    expect((await post('/api/sessions/session-a/close', a)).status).toBe(200);
    expect(pool.hasSession('session-a')).toBe(false);
  });

  it('a delete from A still stops and removes its own live session', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    expect((await load(a)).status).toBe(200);

    const body = (await (await del(a)).json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(pool.hasSession('session-a')).toBe(false);
    expect(loadSession('session-a', a)).toBeNull();
  });

  it('a run, a stop or a command from B is refused while A holds the id', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    saveSession(plan, 'Goal', b, 'session-a');
    expect((await load(a)).status).toBe(200);
    const live = pool.session('session-a', undefined);

    for (const res of [
      await post('/api/plans/session-a/execute', b),
      await post('/api/plans/session-a/stop', b),
      await post('/api/plans/session-a/execute-command', b, { command: 'skip_task', task: 't1' }),
    ]) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('refused');
    }
    expect(pool.session('session-a', undefined)).toBe(live);
    expect(live.planTasks[0].status).toBe('pending');
  });

  it('B\'s task log carries no position from A\'s stream', async () => {
    saveSession(plan, 'Goal', a, 'session-a');
    saveSession(plan, 'Goal', b, 'session-a');
    expect((await load(a)).status).toBe(200);
    const log = (workspace: string) => app.request(`/api/sessions/session-a/tasks/t1/log?workspace=${encodeURIComponent(workspace)}`);

    expect(await (await log(b)).json()).not.toHaveProperty('position');
    expect(await (await log(a)).json()).toHaveProperty('position');
  });

  it('a child plan read or message from B is refused while A holds the id, and A\'s own is answered', async () => {
    await heldByA();

    await refused(await get('/api/sessions/session-a/children', b));
    await refused(await get('/api/sessions/session-a/children/c1', b));
    await refused(await post('/api/sessions/session-a/children/c1/message', b, { message: 'hi' }));
    expect((await get('/api/sessions/session-a/children', a)).status).toBe(200);
  });

  it('an approval list or answer from B is refused while A holds the id, and A\'s own is answered', async () => {
    await heldByA();

    await refused(await get('/api/approvals/session-a', b));
    await refused(await post('/api/approvals/session-a/ap1', b, { decision: 'approve' }));
    expect((await get('/api/approvals/session-a', a)).status).toBe(200);
  });

  it('a plan edit or a planning turn from B is refused, and does not replace A\'s session', async () => {
    const live = await heldByA();

    await refused(await post('/api/plans/session-a/tasks', b, { title: 'Theirs' }));
    await refused(await post('/api/plans/session-a/planning/stop', b));
    await refused(await post('/api/plans/session-a/converse/message', b, { message: 'hi' }));
    // The workspace in the body alone, as a client that names it there sends it.
    for (const path of ['/api/plans/session-a/generate', '/api/plans/session-a/converse/start']) {
      await refused(await app.request(path, { method: 'POST', body: JSON.stringify({ goal: 'Theirs', workspace: b }), headers: { 'content-type': 'application/json' } }));
    }
    expect(pool.session('session-a', undefined)).toBe(live);
    expect(pool.holds('session-a', a)).toBe(true);
    expect(live.planTasks.map((t) => t.title)).toEqual(['Wire it up']);
  });

  it('a settings read or change from B naming the id is refused, and leaves A\'s run settings as they were', async () => {
    const live = await heldByA();
    const before = live.runSettings();

    await refused(await app.request(`/api/settings?sessionId=session-a&workspace=${encodeURIComponent(b)}`));
    await refused(await app.request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ run: { autorun: !before.autorun }, sessionId: 'session-a', workspace: b }),
      headers: { 'content-type': 'application/json' },
    }));
    expect(live.runSettings()).toEqual(before);
    // Refused before anything is saved, so A's next session opens with what it had.
    expect(new SettingsService().getRunSettings().autorun).toBe(before.autorun);
    expect((await app.request(`/api/settings?sessionId=session-a&workspace=${encodeURIComponent(a)}`)).status).toBe(200);
  });
});

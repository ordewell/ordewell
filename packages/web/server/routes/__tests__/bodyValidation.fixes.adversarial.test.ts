import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { resetInstalledPlanner } from '@ordewell/core';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';
import { runnersRoute } from '../runners';
import { settingsRoute } from '../settings';

const MALFORMED = '{oops';

function plansApp(pool: OrchestratorPool = {} as OrchestratorPool): Hono {
  return new Hono().route('/api/plans', plansRoute(pool));
}

async function post(app: Hono, path: string, body: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.AI_PROVIDER = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'openrouter';
  resetInstalledPlanner();
});

afterEach(() => {
  if (savedEnv.AI_PROVIDER === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = savedEnv.AI_PROVIDER;
  resetInstalledPlanner();
});

describe('a plan route given a body that is not JSON', () => {
  it.each([
    '/api/plans/s1/generate',
    '/api/plans/s1/tasks',
    '/api/plans/s1/converse/start',
    '/api/plans/s1/converse/message',
    '/api/plans/s1/converse/message/now',
    '/api/plans/s1/conversation/rewind',
  ])('answers 400 at %s, not a 500 fault', async (path) => {
    const res = await post(plansApp(), path, MALFORMED);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/JSON/);
  });

  it('answers 400 for a PUT of a malformed task edit', async () => {
    const res = await plansApp().request('/api/plans/s1/tasks/t1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: MALFORMED,
    });

    expect(res.status).toBe(400);
  });
});

describe('the settings route given a malformed body', () => {
  it('answers 400', async () => {
    const pool = { getSettings: vi.fn(), writeSettings: vi.fn(), discoverPlannerCatalogs: vi.fn(async () => undefined) } as unknown as OrchestratorPool;
    const app = new Hono().route('/api/settings', settingsRoute(pool));

    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: MALFORMED,
    });

    expect(res.status).toBe(400);
  });
});

describe('the runner list', () => {
  it('asks the login probe and the planner model of the workspace that will plan', async () => {
    const getInstalledRunners = vi.fn(async () => []);
    const getRunnerState = vi.fn(() => ({ enabledRunners: [], orchestratorModel: '' }));
    const discoverPlannerCatalogs = vi.fn(async () => undefined);
    const pool = { getInstalledRunners, getRunnerState, discoverPlannerCatalogs } as unknown as OrchestratorPool;

    const res = await new Hono().route('/api/runners', runnersRoute(pool))
      .request('/api/runners?workspace=%2Fprojects%2Fa');

    expect(res.status).toBe(200);
    expect(getInstalledRunners).toHaveBeenCalledWith('/projects/a');
    expect(getRunnerState).toHaveBeenCalledWith('/projects/a');
    expect(discoverPlannerCatalogs).toHaveBeenCalledWith(undefined, '/projects/a');
    expect(discoverPlannerCatalogs.mock.invocationCallOrder[0]).toBeLessThan(getRunnerState.mock.invocationCallOrder[0]);
  });

  it('carries an installed but unavailable runner through, with its reason', async () => {
    const unavailable = {
      id: 'copilot-cli',
      name: 'GitHub Copilot CLI',
      enabled: true,
      usable: false,
      reason: 'GitHub Copilot CLI is too old for Ordewell: found 1.0.104, needs 1.0.105 or later.',
    };
    const pool = {
      getInstalledRunners: vi.fn(async () => [unavailable]),
      getRunnerState: vi.fn(() => ({ enabledRunners: [], orchestratorModel: '' })),
      discoverPlannerCatalogs: vi.fn(async () => undefined),
    } as unknown as OrchestratorPool;

    const res = await new Hono().route('/api/runners', runnersRoute(pool)).request('/api/runners');

    expect(await res.json()).toEqual({ runners: [unavailable], orchestratorModel: '' });
  });
});

describe('the runner toggle', () => {
  function appWith(pool: OrchestratorPool): Hono {
    return new Hono().route('/api/runners', runnersRoute(pool));
  }

  function fakePool(): OrchestratorPool {
    return { setRunnerEnabled: vi.fn() } as unknown as OrchestratorPool;
  }

  it.each([
    ['a malformed body', MALFORMED],
    ['no enabled field', '{}'],
    ['a non-boolean enabled', JSON.stringify({ enabled: 'yes' })],
  ])('refuses %s and does not change the runner', async (_label, body) => {
    const pool = fakePool();
    const res = await appWith(pool).request('/api/runners/claude-code', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(res.status).toBe(400);
    expect(pool.setRunnerEnabled).not.toHaveBeenCalled();
  });

  it('still toggles on an explicit boolean', async () => {
    const pool = fakePool();
    const res = await appWith(pool).request('/api/runners/claude-code', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(pool.setRunnerEnabled).toHaveBeenCalledWith('claude-code', false);
  });
});

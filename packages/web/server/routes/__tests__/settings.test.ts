import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { RUN_SETTINGS_DEFAULTS, detectInstalledPlanner, resetInstalledPlanner, type PlannerUsability } from '@ordewell/core';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

function fakePool(overrides: Partial<OrchestratorPool> = {}): OrchestratorPool {
  const pool = {
    getSettings: vi.fn(),
    discoverPlannerCatalogs: vi.fn(async () => undefined),
    setOrchestratorModel: vi.fn(),
    writeSettings: vi.fn(),
    ...overrides,
  } as unknown as OrchestratorPool;
  return pool;
}

type SettingsState = ReturnType<OrchestratorPool['getSettings']>;

function settingsState(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    orchestratorModel: '',
    aiProvider: 'openrouter',
    plannerThinkingEffort: '',
    autonomousMode: false,
    maxParallel: 3,
    modelAllowlist: undefined,
    plannerModels: undefined,
    run: { ...RUN_SETTINGS_DEFAULTS },
    ...overrides,
  };
}

describe('GET /api/settings', () => {
  let app: Hono;
  let pool: OrchestratorPool;

  beforeEach(async () => {
    pool = fakePool();
    const { settingsRoute } = await import('../../routes/settings');
    app = new Hono();
    app.route('/api/settings', settingsRoute(pool));
  });

  afterEach(() => resetInstalledPlanner());

  it('answers once the startup probe has, so the welcome screen names the planner that will plan', async () => {
    let answer!: (value: PlannerUsability) => void;
    const gate = new Promise<PlannerUsability>((resolve) => { answer = resolve; });
    void detectInstalledPlanner({ plannerUsability: () => gate });
    vi.mocked(pool.getSettings).mockReturnValue(settingsState({ aiProvider: 'claude-code' }));

    const response = app.request('/api/settings', { method: 'GET' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pool.getSettings).not.toHaveBeenCalled();

    answer({ usable: true });
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ aiProvider: 'claude-code' });
    expect(pool.getSettings).toHaveBeenCalled();
  });

  it('returns orchestratorModel and feature toggles', async () => {
    vi.mocked(pool.getSettings).mockReturnValue(settingsState({
      orchestratorModel: 'openai/gpt-4o',
    }));

    const res = await app.request('/api/settings', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      orchestratorModel: 'openai/gpt-4o',
      // Who plans (ADR-0009) — the planner picker reads it from here.
      aiProvider: 'openrouter',
      plannerThinkingEffort: '',
      autonomousMode: false,
      // How many tasks run at once — `/parallel` shows it from here.
      maxParallel: 3,
      run: { ...RUN_SETTINGS_DEFAULTS },
    });
  });
});

describe('/api/settings — the requesting workspace', () => {
  let app: Hono;
  let pool: OrchestratorPool;

  beforeEach(async () => {
    pool = fakePool({ updateRunSettings: vi.fn() });
    vi.mocked(pool.getSettings).mockReturnValue(settingsState());
    vi.mocked(pool.writeSettings).mockResolvedValue(settingsState());
    vi.mocked(pool.updateRunSettings).mockReturnValue(settingsState());
    const { settingsRoute } = await import('../../routes/settings');
    app = new Hono();
    app.route('/api/settings', settingsRoute(pool));
  });

  const patch = (body: unknown) => app.request('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  // One daemon serves several workspaces, and the planner's model is judged
  // against the runner catalog of the one the client is in.
  it('reads the settings for the workspace a client names, beside its session', async () => {
    await app.request('/api/settings?workspace=%2Fwork%2Fb', { method: 'GET' });
    await app.request('/api/settings?sessionId=s1&workspace=%2Fwork%2Fb', { method: 'GET' });
    await app.request('/api/settings', { method: 'GET' });

    expect(vi.mocked(pool.getSettings).mock.calls).toEqual([[undefined, '/work/b'], ['s1', '/work/b'], [undefined, undefined]]);
    expect(vi.mocked(pool.discoverPlannerCatalogs).mock.calls).toEqual([[undefined, '/work/b'], ['s1', '/work/b'], [undefined, undefined]]);
  });

  it('judges a write for the workspace a client names, never saving the name as a setting', async () => {
    await patch({ env: { AI_PROVIDER: 'claude-code' }, workspace: '/work/b' });
    await patch({ run: { autorun: true }, sessionId: 's1', workspace: '/work/b' });

    expect(vi.mocked(pool.writeSettings).mock.calls).toEqual([[{ env: { AI_PROVIDER: 'claude-code' } }, undefined, '/work/b']]);
    // Whether a write waits for a catalog is the pool's to judge (ADR-0040), never the route's.
    expect(pool.discoverPlannerCatalogs).not.toHaveBeenCalled();
    expect(vi.mocked(pool.updateRunSettings).mock.calls).toEqual([[{ autorun: true }, 's1', '/work/b']]);
    expect(vi.mocked(pool.getSettings).mock.calls).toEqual([['s1', '/work/b']]);
  });

  it('refuses a write that names only its workspace', async () => {
    const res = await patch({ workspace: '/work/b' });

    expect(res.status).toBe(400);
    expect(pool.writeSettings).not.toHaveBeenCalled();
  });

  it('refuses a workspace that is not a path', async () => {
    const res = await patch({ env: { AI_PROVIDER: 'claude-code' }, workspace: 7 });

    expect(res.status).toBe(400);
    expect(pool.writeSettings).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/settings', () => {
  let app: Hono;
  let pool: OrchestratorPool;

  beforeEach(async () => {
    pool = fakePool();
    const { settingsRoute } = await import('../../routes/settings');
    app = new Hono();
    app.route('/api/settings', settingsRoute(pool));
  });

  it('updates orchestratorModel and returns new state', async () => {
    vi.mocked(pool.writeSettings).mockResolvedValue(settingsState({
      orchestratorModel: 'gemini-2.5-flash',
    }));
    vi.mocked(pool.getSettings).mockReturnValue(settingsState({
      orchestratorModel: 'gemini-2.5-flash',
    }));

    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orchestratorModel: 'gemini-2.5-flash' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { orchestratorModel: string };
    expect(body.orchestratorModel).toBe('gemini-2.5-flash');
    expect(pool.writeSettings).toHaveBeenCalledWith({ orchestratorModel: 'gemini-2.5-flash' }, undefined, undefined);
  });

  it('updates modelAllowlist and returns it in settings', async () => {
    vi.mocked(pool.writeSettings).mockResolvedValue(settingsState({
      modelAllowlist: { opencode: ['model-a', 'model-b'] },
    }));
    vi.mocked(pool.getSettings).mockReturnValue(settingsState({
      modelAllowlist: { opencode: ['model-a', 'model-b'] },
    }));

    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelAllowlist: { opencode: ['model-a', 'model-b'] } }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { modelAllowlist: Record<string, string[]> };
    expect(body.modelAllowlist).toEqual({ opencode: ['model-a', 'model-b'] });
    expect(pool.writeSettings).toHaveBeenCalledWith({ modelAllowlist: { opencode: ['model-a', 'model-b'] } }, undefined, undefined);
  });

  it('updates the saved autonomy level, which is a setting and not an environment write', async () => {
    vi.mocked(pool.writeSettings).mockResolvedValue(settingsState({ autonomousMode: true }));
    vi.mocked(pool.getSettings).mockReturnValue(settingsState({ autonomousMode: true }));

    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autonomousMode: true }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { autonomousMode: boolean }).toMatchObject({ autonomousMode: true });
    expect(pool.writeSettings).toHaveBeenCalledWith({ autonomousMode: true }, undefined, undefined);
  });

  it('returns 400 for no body', async () => {
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

function fakePool(overrides: Partial<OrchestratorPool> = {}): OrchestratorPool {
  const pool = {
    getSettings: vi.fn(),
    setOrchestratorModel: vi.fn(),
    updateSettings: vi.fn(),
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
    maxParallel: 3,
    modelAllowlist: undefined,
    plannerModels: undefined,
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
      // How many tasks run at once — `/parallel` shows it from here.
      maxParallel: 3,
    });
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
    vi.mocked(pool.updateSettings).mockReturnValue(settingsState({
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
    expect(pool.updateSettings).toHaveBeenCalledWith({ orchestratorModel: 'gemini-2.5-flash' });
  });

  it('updates modelAllowlist and returns it in settings', async () => {
    vi.mocked(pool.updateSettings).mockReturnValue(settingsState({
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
    expect(pool.updateSettings).toHaveBeenCalledWith({ modelAllowlist: { opencode: ['model-a', 'model-b'] } });
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

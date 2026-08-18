import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

function fakePool(initialSettings?: Record<string, unknown>): OrchestratorPool {
  let state = initialSettings ?? {
    orchestratorModel: '',
    grillMe: { enabled: false },
    tdd: { enabled: true },
    prd: { enabled: false },
    verification: { enabled: false },
  };
  const pool = {
    getSettings: vi.fn(() => state),
    updateSettings: vi.fn((changes: Record<string, unknown>) => {
      state = { ...state, ...changes };
      return state;
    }),
  } as unknown as OrchestratorPool;
  return pool;
}

describe('GET /api/commands', () => {
  let app: Hono;
  let pool: OrchestratorPool;

  beforeEach(async () => {
    pool = fakePool();
    const { commandsRoute } = await import('../../routes/commands');
    app = new Hono();
    app.route('/api/commands', commandsRoute(pool));
  });

  it('returns a list of available commands with descriptions', async () => {
    const res = await app.request('/api/commands', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: Array<{ name: string; description: string }> };
    expect(body.commands).toBeInstanceOf(Array);
    expect(body.commands.length).toBeGreaterThan(0);
    for (const cmd of body.commands) {
      expect(cmd).toHaveProperty('name');
      expect(cmd).toHaveProperty('description');
    }
  });

  it('includes grill-me, tdd, prd, and verify commands', async () => {
    const res = await app.request('/api/commands', { method: 'GET' });
    const body = (await res.json()) as { commands: Array<{ name: string }> };
    const names = body.commands.map((c: { name: string }) => c.name);
    expect(names).toContain('grill-me');
    expect(names).toContain('tdd');
    expect(names).toContain('prd');
    expect(names).toContain('verify');
  });
});

describe('POST /api/commands/:name', () => {
  let app: Hono;
  let pool: OrchestratorPool;

  beforeEach(async () => {
    pool = fakePool();
    const { commandsRoute } = await import('../../routes/commands');
    app = new Hono();
    app.route('/api/commands', commandsRoute(pool));
  });

  it('enables grill-me via command', async () => {
    const res = await app.request('/api/commands/grill-me', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { action: 'on' } }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; settings: { grillMe: { enabled: boolean } } };
    expect(body.ok).toBe(true);
    expect(body.settings.grillMe.enabled).toBe(true);
    expect(pool.updateSettings).toHaveBeenCalledWith({ grillMe: { enabled: true } });
  });

  it('disables tdd via command', async () => {
    const res = await app.request('/api/commands/tdd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { action: 'off' } }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { tdd: { enabled: boolean } } };
    expect(body.settings.tdd.enabled).toBe(false);
    expect(pool.updateSettings).toHaveBeenCalledWith({ tdd: { enabled: false } });
  });

  it('returns current state when no action specified', async () => {
    const res = await app.request('/api/commands/grill-me', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; settings: { grillMe: { enabled: boolean } } };
    expect(body.ok).toBe(true);
    expect(body.settings.grillMe.enabled).toBe(false);
  });

  it('enables verification via the verify command', async () => {
    const res = await app.request('/api/commands/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { action: 'on' } }),
    });
    expect(res.status).toBe(200);
    expect(pool.updateSettings).toHaveBeenCalledWith({ verification: { enabled: true } });
  });

  it('disables verification via the verify command', async () => {
    const res = await app.request('/api/commands/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { action: 'off' } }),
    });
    expect(res.status).toBe(200);
    expect(pool.updateSettings).toHaveBeenCalledWith({ verification: { enabled: false } });
  });

  it('returns 404 for unknown command', async () => {
    const res = await app.request('/api/commands/nonexistent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });

    expect(res.status).toBe(404);
  });
});

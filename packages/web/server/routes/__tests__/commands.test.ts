import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

function fakePool(initialSettings?: Record<string, unknown>): OrchestratorPool {
  let state = initialSettings ?? {
    orchestratorModel: '',
    verification: { enabled: true },
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

  it('includes verify, and no tdd toggle now that tdd is a task skill', async () => {
    const res = await app.request('/api/commands', { method: 'GET' });
    const body = (await res.json()) as { commands: Array<{ name: string }> };
    const names = body.commands.map((c: { name: string }) => c.name);
    expect(names).not.toContain('tdd');
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

  it('refuses the retired tdd toggle', async () => {
    const res = await app.request('/api/commands/tdd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { action: 'off' } }),
    });

    expect(res.status).toBe(404);
    expect(pool.updateSettings).not.toHaveBeenCalled();
  });

  it('returns current state when no action specified', async () => {
    const res = await app.request('/api/commands/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; settings: { verification: { enabled: boolean } } };
    expect(body.ok).toBe(true);
    expect(body.settings.verification.enabled).toBe(true);
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

  it.each(['terminal', 'structured'])('sets the runner transport to %s via the transport command', async (action) => {
    const res = await app.request('/api/commands/transport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { action } }),
    });
    expect(res.status).toBe(200);
    expect(pool.updateSettings).toHaveBeenCalledWith({ runnerTransport: action });
  });

  it('refuses a transport that does not exist, changing nothing', async () => {
    const res = await app.request('/api/commands/transport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { action: 'telepathy' } }),
    });
    expect(res.status).toBe(400);
    expect(pool.updateSettings).not.toHaveBeenCalled();
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

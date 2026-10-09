import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';

describe('GET /api/commands', () => {
  let app: Hono;

  beforeEach(async () => {
    const { commandsRoute } = await import('../../routes/commands');
    app = new Hono();
    app.route('/api/commands', commandsRoute());
  });

  it('offers no command now that tdd is a task skill and verify and transport are gone', async () => {
    const res = await app.request('/api/commands', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: Array<{ name: string; description: string }> };
    expect(body.commands).toEqual([]);
  });
});

describe('POST /api/commands/:name', () => {
  let app: Hono;

  beforeEach(async () => {
    const { commandsRoute } = await import('../../routes/commands');
    app = new Hono();
    app.route('/api/commands', commandsRoute());
  });

  it.each(['tdd', 'verify', 'transport'])('refuses the removed %s command', async (name) => {
    const res = await app.request(`/api/commands/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { action: 'on' } }),
    });
    expect(res.status).toBe(404);
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

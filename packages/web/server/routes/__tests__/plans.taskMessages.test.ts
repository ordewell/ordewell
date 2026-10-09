import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { TaskControlError, SessionNotFoundError } from '@ordewell/core';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

function appFor(session: Record<string, unknown>, known = true) {
  const pool = {
    session: vi.fn(() => {
      if (!known) throw new SessionNotFoundError();
      return session;
    }),
  } as unknown as OrchestratorPool;
  const app = new Hono();
  app.route('/api/plans', plansRoute(pool));
  return app;
}

function request(app: Hono, method: string, path: string, body?: unknown) {
  return app.request(`/api/plans/s1/tasks/t1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('talking to a structured task over the daemon (ADR-0018, M1)', () => {
  it('sends a message and answers with its queued id', async () => {
    const sendTaskMessage = vi.fn(() => 'msg-1');
    const res = await request(appFor({ sendTaskMessage }), 'POST', '/messages', { text: 'use Postgres' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg-1' });
    expect(sendTaskMessage).toHaveBeenCalledWith('t1', 'use Postgres');
  });

  it('asks for the text rather than sending an empty message', async () => {
    const sendTaskMessage = vi.fn();
    const res = await request(appFor({ sendTaskMessage }), 'POST', '/messages', { text: '  ' });

    expect(res.status).toBe(400);
    expect(sendTaskMessage).not.toHaveBeenCalled();
  });

  it('takes back a queued message, saying whether it was still there', async () => {
    const removeQueuedTaskMessage = vi.fn(() => false);
    const res = await request(appFor({ removeQueuedTaskMessage }), 'DELETE', '/messages/msg-2');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: false });
    expect(removeQueuedTaskMessage).toHaveBeenCalledWith('t1', 'msg-2');
  });

  it('interrupts the running turn', async () => {
    const interruptTask = vi.fn(async () => {});
    const res = await request(appFor({ interruptTask }), 'POST', '/interrupt');

    expect(res.status).toBe(200);
    expect(interruptTask).toHaveBeenCalledWith('t1');
  });

  it('force sends a new message and answers with its id (ADR-0023, F1)', async () => {
    const forceSendTaskMessage = vi.fn(() => 'msg-3');
    const res = await request(appFor({ forceSendTaskMessage }), 'POST', '/messages/now', { text: 'stop, use Postgres' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg-3' });
    expect(forceSendTaskMessage).toHaveBeenCalledWith('t1', 'stop, use Postgres');
  });

  it('asks for the text rather than force sending an empty message', async () => {
    const forceSendTaskMessage = vi.fn();
    const res = await request(appFor({ forceSendTaskMessage }), 'POST', '/messages/now', {});

    expect(res.status).toBe(400);
    expect(forceSendTaskMessage).not.toHaveBeenCalled();
  });

  it('force sends a queued message, saying whether it was still queued', async () => {
    const forceSendQueuedTaskMessage = vi.fn(() => true);
    const res = await request(appFor({ forceSendQueuedTaskMessage }), 'POST', '/messages/msg-2/now');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(forceSendQueuedTaskMessage).toHaveBeenCalledWith('t1', 'msg-2');
  });

  it('answers a force send to a task that is not running with 400 and the reason', async () => {
    const refusal = new TaskControlError('Task "Only" is not running, so there is no turn to send a message to.');
    const app = appFor({
      forceSendTaskMessage: () => { throw refusal; },
      forceSendQueuedTaskMessage: () => { throw refusal; },
    });

    for (const res of [
      await request(app, 'POST', '/messages/now', { text: 'hi' }),
      await request(app, 'POST', '/messages/msg-1/now'),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: refusal.message, code: 'refused' });
    }
  });

  it('answers a refusal for a task that is not running with 400 and the reason', async () => {
    const refusal = new TaskControlError('Task "Only" is not running, so there is no turn to send a message to.');
    const app = appFor({
      sendTaskMessage: () => { throw refusal; },
      removeQueuedTaskMessage: () => { throw refusal; },
      interruptTask: async () => { throw refusal; },
    });

    for (const res of [
      await request(app, 'POST', '/messages', { text: 'hi' }),
      await request(app, 'DELETE', '/messages/msg-1'),
      await request(app, 'POST', '/interrupt'),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: refusal.message, code: 'refused' });
    }
  });

  it('answers 404 for a session the daemon does not have', async () => {
    const res = await request(appFor({}, false), 'POST', '/interrupt');
    expect(res.status).toBe(404);
  });
});

describe('continuing a finished structured task over the daemon (ADR-0018, K1)', () => {
  it('continues it with the message', async () => {
    const continueTask = vi.fn(async () => {});
    const res = await request(appFor({ continueTask }), 'POST', '/continue', { text: 'also handle arrays' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(continueTask).toHaveBeenCalledWith('t1', 'also handle arrays');
  });

  it('asks for the text rather than continuing with nothing', async () => {
    const continueTask = vi.fn();
    const res = await request(appFor({ continueTask }), 'POST', '/continue', {});

    expect(res.status).toBe(400);
    expect(continueTask).not.toHaveBeenCalled();
  });

  it('answers a refusal — a conflict, say — with 400 and the reason', async () => {
    const refusal = new TaskControlError('Task "Only" cannot be continued: its work is waiting on a merge conflict. Resolve or repair the conflict instead.');
    const res = await request(appFor({ continueTask: async () => { throw refusal; } }), 'POST', '/continue', { text: 'go on' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: refusal.message, code: 'refused' });
  });
});

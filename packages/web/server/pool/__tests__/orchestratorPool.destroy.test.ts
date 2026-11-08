import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenAiService, PlannerTurnDiscardedError, Session, type ConversationTurn, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';
import { withReadyPlanner } from '../../__tests__/readyPlanner';

withReadyPlanner();

afterEach(() => {
  // Each test stubs its own settings path and spies; leaking either would let
  // one test's environment or mock decide the next one's result.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Keeps the turn in flight until teardown aborts it, as a real planner would. */
function hangingPlanner() {
  return vi.spyOn(OpenAiService.prototype, 'startConversation').mockImplementation((request) => new Promise<ConversationTurn>((resolve) => {
    const stopped = () => resolve({ kind: 'message', text: '', researchLog: [], aborted: true });
    if (request.signal?.aborted) stopped();
    else request.signal?.addEventListener('abort', stopped, { once: true });
  }));
}

describe('closing a session', () => {
  it('closes the session it is still planning in, which abandons its planner turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-destroy-'));
    mkdirSync(join(workspace, '.git'));
    // The session's runners are the user's settings: not the developer's own.
    vi.stubEnv('ORDEWELL_SETTINGS_PATH', join(workspace, 'settings.json'));
    const pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    hangingPlanner();
    const destroySpy = vi.spyOn(Session.prototype, 'destroy');

    try {
      const turn = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
      const session = pool.session('s1', undefined);
      expect(session.isPlannerBusy).toBe(true);

      pool.destroy('s1');

      expect(destroySpy.mock.contexts).toContain(session);
      expect(pool.hasSession('s1')).toBe(false);
      expect(pool.cancelPlanning('s1', undefined)).toBe(false);
      await expect(turn).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    } finally {
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('a session a surface closes', () => {
  it('is dropped at once, and resolves once all it started has gone', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-close-'));
    mkdirSync(join(workspace, '.git'));
    vi.stubEnv('ORDEWELL_SETTINGS_PATH', join(workspace, 'settings.json'));
    const pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    hangingPlanner();

    try {
      const turn = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
      const session = pool.session('s1', undefined);
      let done!: () => void;
      vi.spyOn(session, 'gone', 'get').mockReturnValue(new Promise<void>((resolve) => { done = resolve; }));

      let closed = false;
      const closing = pool.close('s1', workspace).then(() => { closed = true; });

      expect(pool.hasSession('s1')).toBe(false);
      await expect(turn).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
      expect(closed).toBe(false);

      done();
      await closing;
    } finally {
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('is a no-op for one that is not there', async () => {
    const pool = new OrchestratorPool({ accountLimitCollectors: () => [] });

    await expect(pool.close('nobody', tmpdir())).resolves.toBeUndefined();
  });
});

describe('re-planning under a live session id', () => {
  it('destroys the previous session rather than orphaning its turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-replan-'));
    mkdirSync(join(workspace, '.git'));
    // The session's runners are the user's settings: not the developer's own.
    vi.stubEnv('ORDEWELL_SETTINGS_PATH', join(workspace, 'settings.json'));
    const pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    const destroySpy = vi.spyOn(Session.prototype, 'destroy');
    hangingPlanner();

    try {
      const firstTurn = pool.startPlanning('s1', 'first', ['claude-code'], workspace);
      const first = pool.session('s1', undefined);

      const secondTurn = pool.startPlanning('s1', 'second', ['claude-code'], workspace);
      const secondDiscarded = expect(secondTurn).rejects.toBeInstanceOf(PlannerTurnDiscardedError);

      expect(destroySpy.mock.contexts).toContain(first);
      expect(pool.session('s1', undefined)).not.toBe(first);
      // The first session's turn is abandoned with it, not left running unheard.
      await expect(firstTurn).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
      expect(first.isPlannerBusy).toBe(false);
      expect(pool.session('s1', undefined).isPlannerBusy).toBe(true);

      pool.destroyAll();
      await secondDiscarded;
    } finally {
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('deleting a session under a live subscriber', () => {
  function stubPlanning() {
    return {
      planSpy: vi.spyOn(Session.prototype, 'planState', 'get').mockReturnValue({ conversationHistory: [] } as unknown as LegacyPlanState),
      startSpy: vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState),
    };
  }

  it('sends a notice, closes the socket, and drops the subscriber set', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-destroy-subscriber-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    const { planSpy, startSpy } = stubPlanning();

    try {
      await pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
      const ws = { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn() };
      pool.subscribe('s1', ws as unknown as Parameters<OrchestratorPool['subscribe']>[1]);

      pool.destroy('s1', { notifyClients: true });

      expect(ws.send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(ws.send.mock.calls[1][0] as string)).toMatchObject({ type: 'notice', message: 'Session closed.' });
      expect(ws.close).toHaveBeenCalledWith(1001, 'Session closed');
      expect((pool as unknown as { clients: Map<string, unknown> }).clients.has('s1')).toBe(false);
    } finally {
      planSpy.mockRestore();
      startSpy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps subscribers when the session is replaced under the same id', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-replace-subscriber-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    const { planSpy, startSpy } = stubPlanning();

    try {
      await pool.startPlanning('s1', 'first', ['claude-code'], workspace);
      const ws = { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn() };
      pool.subscribe('s1', ws as unknown as Parameters<OrchestratorPool['subscribe']>[1]);

      await pool.startPlanning('s1', 'second', ['claude-code'], workspace);

      expect(ws.close).not.toHaveBeenCalled();
      expect((pool as unknown as { clients: Map<string, unknown> }).clients.has('s1')).toBe(true);
    } finally {
      planSpy.mockRestore();
      startSpy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('subscribing to a session', () => {
  it('sends a new socket nothing of the transcript: every client reads the conversation over REST, and a turn opens a socket each time', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-subscribe-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    const history = [{ role: 'user' as const, content: 'ship it', timestamp: '2026-01-01T00:00:00Z' }];
    const planSpy = vi.spyOn(Session.prototype, 'planState', 'get').mockReturnValue({ conversationHistory: history } as unknown as LegacyPlanState);
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);

    try {
      await pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
      const ws = { OPEN: 1, readyState: 1, send: vi.fn() };
      pool.subscribe('s1', ws as unknown as Parameters<OrchestratorPool['subscribe']>[1]);

      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ type: 'account_limits', limits: [] });
    } finally {
      planSpy.mockRestore();
      startSpy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

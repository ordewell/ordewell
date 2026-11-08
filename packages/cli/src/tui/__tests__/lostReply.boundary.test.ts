import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import { EventEmitter } from 'events';
import type { SurfacePlan } from '@ordewell/core';
import { ApiClient, type SessionSocket } from '../../apiClient';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

/**
 * A reply that arrived is never a lost reply.
 *
 * `converse` used to treat any failure from the whole call-plus-render block as
 * unknown delivery: a 200 whose body it could not read, and a plan this surface
 * could not fold, were both announced as lost, and the session was read back as
 * if the daemon might still be running the turn. Only the awaited request may
 * be a lost reply. A response that arrived keeps its session and shows its own
 * error, while a request that really died after it went out must still
 * reconcile.
 */

const PLAN: SurfacePlan = {
  tasks: [{ id: 't1', order: 1, title: 'First', description: '', status: 'pending', subtasks: [] }],
  conversationHistory: [],
} as unknown as SurfacePlan;

const TIMEOUT_ENV = 'ORDEWELL_HTTP_TIMEOUT_MS';
const previousTimeout = process.env[TIMEOUT_ENV];

afterEach(() => {
  vi.restoreAllMocks();
  if (previousTimeout === undefined) delete process.env[TIMEOUT_ENV];
  else process.env[TIMEOUT_ENV] = previousTimeout;
});

/** How the scripted socket answers one request. */
type Script =
  | { kind: 'answer'; status?: number; body: string }
  | { kind: 'reset'; afterMs?: number }
  | { kind: 'hangup'; afterMs?: number }
  | { kind: 'timeout'; afterMs: number };

/** Scripts the process's one `http` module so the real ApiClient runs without a listening socket. */
function serveHttp(script: (options: http.RequestOptions) => Script): { calls: string[] } {
  const calls: string[] = [];
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, respond: (res: http.IncomingMessage) => void) => {
    const req = new EventEmitter() as EventEmitter & { write: (chunk: unknown) => void; end: () => http.ClientRequest; destroy: () => void };
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      calls.push(`${String(options.method)} ${String(options.path)}`);
      const step = script(options);
      if (step.kind === 'answer') {
        process.nextTick(() => {
          const res = new EventEmitter() as EventEmitter & http.IncomingMessage;
          res.statusCode = step.status ?? 200;
          respond(res);
          res.emit('data', Buffer.from(step.body));
          res.emit('end');
        });
      } else if (step.kind === 'timeout') {
        setTimeout(() => req.emit('timeout'), step.afterMs).unref?.();
      } else {
        const fail = () => req.emit('error', step.kind === 'reset'
          ? Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
          : new Error('socket hang up'));
        const afterMs = step.afterMs ?? 0;
        if (afterMs > 0) setTimeout(fail, afterMs).unref?.();
        else process.nextTick(fail);
      }
      return req as unknown as http.ClientRequest;
    };
    return req as unknown as http.ClientRequest;
  }) as typeof http.request);
  return { calls };
}

/** The effect runner and reducer wired as the TUI wires them, so a test reads what the user would see. */
function tui(api: Partial<OrdewellApi>, start: Partial<TuiState> = {}) {
  let state = initialState(start);
  const actions: Action[] = [];
  const effects: Effect[] = [];
  const deps: EffectDeps = {
    api: {
      startConversation: vi.fn(async () => ({ tasks: [] })),
      sendConversationMessage: vi.fn(async () => ({ tasks: [] })),
      forceSendPlannerMessage: vi.fn(async () => ({ tasks: [] })),
      compactConversation: vi.fn(async () => ({ plan: { tasks: [] }, summary: '' })),
      adoptSession: vi.fn(async () => ({ plan: PLAN, goal: 'g' })),
      getSettings: vi.fn(async () => ({})),
      followSession: vi.fn(() => ({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} }) as SessionSocket),
      ...api,
    } as unknown as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action: Action) => apply(action),
    newSessionId: () => 'session-new',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: () => {},
    hasBin: () => true,
    pipeToClipboard: () => {},
    writeTerminal: () => {},
    reviveDaemon: vi.fn().mockResolvedValue(true),
    login: async () => ({ ok: true }),
    exit: () => {},
  };
  function apply(action: Action): void {
    actions.push(action);
    const step = reduce(state, action);
    state = step.state;
    effects.push(...step.effects);
  }
  return {
    actions,
    effects,
    deps,
    get state() { return state; },
    async run(effect: Effect): Promise<void> { await runEffect(effect, deps); },
  };
}

/** A real client over the scripted socket, with the three calls a turn makes counted. */
function realApi(script: (options: http.RequestOptions) => Script) {
  const wire = serveHttp(script);
  const client = new ApiClient(3742, '/ws');
  const counts = { start: 0, send: 0, adopt: 0 };
  const api: Partial<OrdewellApi> = {
    startConversation: vi.fn((id: string, goal: string, runners?: string[], workspace?: string, allowInit?: boolean) => {
      counts.start++;
      return client.startConversation(id, goal, runners, workspace, allowInit);
    }),
    sendConversationMessage: vi.fn((id: string, message: string) => {
      counts.send++;
      return client.sendConversationMessage(id, message);
    }),
    adoptSession: vi.fn((id: string, workspace?: string) => {
      counts.adopt++;
      return client.adoptSession(id, workspace);
    }),
  };
  return { client, wire, counts, api };
}

const types = (t: ReturnType<typeof tui>) => t.actions.map((a) => a.type);
const said = (t: ReturnType<typeof tui>) => messagesOf(t.state).map((m) => m.text);
const lossLines = (t: ReturnType<typeof tui>) => said(t).filter((text) => /lost on the way/i.test(text));
const errors = (t: ReturnType<typeof tui>) => messagesOf(t.state).filter((m) => m.role === 'error').map((m) => m.text);
/** Everything the TUI put in front of the user about a turn: the loss warning and any diagnostic line beside it. */
const diagnostics = (t: ReturnType<typeof tui>) => messagesOf(t.state).filter((m) => m.role === 'system' || m.role === 'error').map((m) => m.text).join('\n');

/** How long the request waited, in whichever unit the line chose; it must not read as the 1200 ms bound. */
const ELAPSED = /\b\d{1,3}(?:\.\d+)?\s*(?:ms|milliseconds?)\b|\b0\.\d+\s*(?:s|seconds?)\b/i;
/** The configured bound, `ORDEWELL_HTTP_TIMEOUT_MS`, in whichever unit the line chose. */
const BOUND = /\b1200\b|\b1[.,]2\s*(?:s|seconds?)\b/i;

/** A plan the surface cannot fold: a task row must have an identity. */
const MALFORMED = { ...PLAN, tasks: [null] } as unknown as SurfacePlan;

describe('a response that arrived is not a lost reply', () => {
  it('settles a real first-turn plan with no lost line and no read-back', async () => {
    const { api, counts } = realApi((options) => String(options.path).includes('/converse/start')
      ? { kind: 'answer', body: JSON.stringify({ plan: PLAN }) }
      : { kind: 'answer', body: JSON.stringify({ ok: true, plan: PLAN, goal: 'g' }) });
    const t = tui(api, { planner: 'planning' });
    await t.run({ type: 'startConversation', goal: 'ship it' });

    expect(lossLines(t)).toEqual([]);
    expect(types(t)).not.toContain('turnLost');
    expect(t.state.tasks).toHaveLength(1);
    expect(t.state.planner).toBe('idle');
    expect(counts.adopt).toBe(0);
    expect(counts.start).toBe(1);
  });

  it('shows a 200 it cannot read as its own error, keeping the session and reading nothing back', async () => {
    const { api, counts, wire } = realApi((options) => String(options.path).includes('/converse/start')
      ? { kind: 'answer', body: 'null' }
      : { kind: 'answer', body: JSON.stringify({ ok: true, plan: PLAN, goal: 'g' }) });
    const t = tui(api, { planner: 'planning' });
    await t.run({ type: 'startConversation', goal: 'ship it' });

    expect(lossLines(t)).toEqual([]);
    expect(types(t)).not.toContain('turnLost');
    expect(types(t)).not.toContain('sessionCleared');
    expect(errors(t).length).toBeGreaterThan(0);
    expect(t.state.sessionId).toBe('session-new');
    expect(t.state.planner).toBe('idle');
    expect(counts.adopt).toBe(0);
    expect(counts.start).toBe(1);
    expect(wire.calls).toEqual(['POST /api/plans/session-new/converse/start?workspace=%2Fws']);
  });

  it('shows a first-turn plan it cannot fold as its own error, keeping the session', async () => {
    const start = vi.fn().mockResolvedValue(MALFORMED);
    const adopt = vi.fn().mockResolvedValue({ plan: PLAN, goal: 'g' });
    const t = tui({
      startConversation: start as unknown as OrdewellApi['startConversation'],
      adoptSession: adopt as unknown as OrdewellApi['adoptSession'],
    }, { planner: 'planning' });
    await t.run({ type: 'startConversation', goal: 'ship it' });

    expect(lossLines(t)).toEqual([]);
    expect(types(t)).not.toContain('turnLost');
    expect(types(t)).not.toContain('sessionCleared');
    expect(errors(t).length).toBeGreaterThan(0);
    expect(t.state.sessionId).toBe('session-new');
    expect(t.state.planner).toBe('idle');
    expect(start).toHaveBeenCalledTimes(1);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('shows a later reply it cannot read as its own error, keeping the session and not resending', async () => {
    const { api, counts, wire } = realApi((options) => String(options.path).includes('/converse/message')
      ? { kind: 'answer', body: 'null' }
      : { kind: 'answer', body: JSON.stringify({ ok: true, plan: PLAN, goal: 'g' }) });
    const t = tui(api, { sessionId: 's1', planner: 'planning' });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'fix it' });

    expect(lossLines(t)).toEqual([]);
    expect(types(t)).not.toContain('turnLost');
    expect(types(t)).not.toContain('sessionCleared');
    expect(errors(t).length).toBeGreaterThan(0);
    expect(t.state.sessionId).toBe('s1');
    expect(t.state.planner).toBe('idle');
    expect(counts.send).toBe(1);
    expect(counts.adopt).toBe(0);
    expect(t.effects.filter((e) => e.type === 'sendMessage')).toEqual([]);
    expect(wire.calls).toEqual(['POST /api/plans/s1/converse/message?workspace=%2Fws']);
  });

  it('shows a later plan it cannot fold as its own error, keeping the session and not resending', async () => {
    const send = vi.fn().mockResolvedValue(MALFORMED);
    const adopt = vi.fn().mockResolvedValue({ plan: PLAN, goal: 'g' });
    const t = tui({
      sendConversationMessage: send as unknown as OrdewellApi['sendConversationMessage'],
      adoptSession: adopt as unknown as OrdewellApi['adoptSession'],
    }, { sessionId: 's1', planner: 'planning' });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'fix it' });

    expect(lossLines(t)).toEqual([]);
    expect(types(t)).not.toContain('turnLost');
    expect(types(t)).not.toContain('sessionCleared');
    expect(errors(t).length).toBeGreaterThan(0);
    expect(t.state.sessionId).toBe('s1');
    expect(t.state.planner).toBe('idle');
    expect(send).toHaveBeenCalledTimes(1);
    expect(adopt).not.toHaveBeenCalled();
    expect(t.effects.filter((e) => e.type === 'sendMessage')).toEqual([]);
  });
});

describe('a request that really died after it went out still reconciles', () => {
  it('keeps the opening session and follows the turn the daemon holds', async () => {
    const { api, counts } = realApi((options) => String(options.path).includes('/converse/start')
      ? { kind: 'reset' }
      : { kind: 'answer', body: JSON.stringify({ ok: true, plan: PLAN, goal: 'g', plannerTurnId: 'turn-1' }) });
    const t = tui(api, { planner: 'planning' });
    await t.run({ type: 'startConversation', goal: 'ship it' });

    expect(lossLines(t).length).toBeGreaterThan(0);
    expect(counts.adopt).toBe(1);
    expect(t.state.sessionId).toBe('session-new');
    expect(t.state.planner).toBe('awaiting');
    expect(t.state.turnGate.open).toBe('turn-1');
    expect(counts.start).toBe(1);
  });

  it('keeps a later turn\'s live gate and queued prompts instead of draining them into it', async () => {
    const { api, counts } = realApi((options) => String(options.path).includes('/converse/message')
      ? { kind: 'reset' }
      : { kind: 'answer', body: JSON.stringify({ ok: true, plan: PLAN, goal: 'g', plannerTurnId: 't1' }) });
    const t = tui(api, { sessionId: 's1', planner: 'planning', queuedPrompts: ['and the tests'] });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });

    expect(lossLines(t).length).toBeGreaterThan(0);
    expect(counts.adopt).toBe(1);
    expect(counts.send).toBe(1);
    expect(t.state.sessionId).toBe('s1');
    expect(t.state.planner).toBe('awaiting');
    expect(t.state.turnGate.open).toBe('t1');
    expect(t.state.queuedPrompts).toEqual(['and the tests']);
    expect(t.effects.filter((e) => e.type === 'sendMessage')).toEqual([]);
  });

  it('drains the queue once when a later send died and the daemon had finished the turn', async () => {
    const { api, counts } = realApi((options) => String(options.path).includes('/converse/message')
      ? { kind: 'hangup' }
      : { kind: 'answer', body: JSON.stringify({ ok: true, plan: PLAN, goal: 'g' }) });
    const t = tui(api, { sessionId: 's1', planner: 'planning', queuedPrompts: ['and the tests'] });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });

    expect(lossLines(t).length).toBeGreaterThan(0);
    expect(counts.adopt).toBe(1);
    expect(counts.send).toBe(1);
    expect(t.state.sessionId).toBe('s1');
    // The drain sends the held prompt, so the next turn is the one now in flight.
    expect(t.state.planner).toBe('planning');
    expect(t.state.tasks).toHaveLength(1);
    expect(t.state.queuedPrompts).toEqual([]);
    expect(t.effects.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'and the tests' }]);
  });
});

describe('the lost-reply warning says why the request failed', () => {
  it('names a timeout, its configured bound and how long it waited, without the prompt', async () => {
    process.env[TIMEOUT_ENV] = '1200';
    const prompt = 'SECRET-PROMPT-MUST-NOT-LEAK';
    const { api, counts } = realApi((options) => String(options.path).includes('/converse/message')
      ? { kind: 'timeout', afterMs: 150 }
      : { kind: 'answer', body: JSON.stringify({ ok: true, plan: PLAN, goal: 'g', plannerTurnId: 't1' }) });
    const t = tui(api, { sessionId: 's1', planner: 'planning', queuedPrompts: ['and the tests'] });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: prompt });

    const line = diagnostics(t);
    expect(line).toMatch(/lost on the way/i);
    expect(line).toMatch(/tim(?:ed out|eout)/i);
    expect(line).not.toMatch(/ECONNRESET|reset by peer/i);
    expect(line).toMatch(ELAPSED);
    expect(line).toMatch(BOUND);
    expect(line).not.toContain(prompt);
    expect(counts.send).toBe(1);
    expect(t.state.planner).toBe('awaiting');
    expect(t.state.turnGate.open).toBe('t1');
    expect(t.state.queuedPrompts).toEqual(['and the tests']);
  });

  it('names a timeout on a turn that had no bound at all, without claiming one', async () => {
    delete process.env[TIMEOUT_ENV];
    const { api, counts } = realApi((options) => String(options.path).includes('/converse/message')
      ? { kind: 'timeout', afterMs: 60 }
      : { kind: 'answer', body: JSON.stringify({ ok: true, plan: PLAN, goal: 'g', plannerTurnId: 't1' }) });
    const t = tui(api, { sessionId: 's1', planner: 'planning' });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'go on' });

    const line = diagnostics(t);
    expect(line).toMatch(/lost on the way/i);
    expect(line).toMatch(/tim(?:ed out|eout)/i);
    expect(line).toMatch(ELAPSED);
    // A turn has no idle bound unless ORDEWELL_HTTP_TIMEOUT_MS set one, so the
    // line must not name a limit (it used to claim the 15 minutes it never had).
    expect(line).not.toMatch(/\blimit\b/i);
    expect(counts.send).toBe(1);
    expect(t.state.planner).toBe('awaiting');
  });

  it('names a reset, not a timeout, and how long it waited, without the prompt', async () => {
    process.env[TIMEOUT_ENV] = '1200';
    const prompt = 'SECRET-PROMPT-MUST-NOT-LEAK';
    const { api } = realApi((options) => String(options.path).includes('/converse/message')
      ? { kind: 'reset', afterMs: 40 }
      : { kind: 'answer', body: JSON.stringify({ ok: true, plan: PLAN, goal: 'g', plannerTurnId: 't1' }) });
    const t = tui(api, { sessionId: 's1', planner: 'planning' });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: prompt });

    const line = diagnostics(t);
    expect(line).toMatch(/lost on the way/i);
    expect(line).toMatch(/ECONNRESET|reset/i);
    expect(line).not.toMatch(/tim(?:ed out|eout)/i);
    expect(line).toMatch(ELAPSED);
    expect(line).not.toContain(prompt);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { fromTranscript, type SurfacePlan } from '@ordewell/core';
import { UnreadableResponseError } from '../../apiClient';
import { DaemonRefusal } from '@ordewell/core';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

/**
 * A planner turn whose reply was lost in transit is not a failed turn. The
 * daemon runs a turn to its end whether or not the client is still waiting, so
 * a timeout or a reset leaves the outcome unknown — and the session, the
 * queue and the message all belong to a turn that may still be running.
 */

const timedOut = () => new Error('Request timed out');
const sessionGone = () => new DaemonRefusal('Session not found', 404, { code: 'session_not_found' });

const planWith = (...history: Array<{ role: 'user' | 'assistant'; content: string }>): SurfacePlan =>
  ({ tasks: [], conversationHistory: history } as unknown as SurfacePlan);

/** The effect runner and the reducer wired as the TUI wires them, so a test reads what the user would see. */
function tui(api: Partial<OrdewellApi>, start: Partial<TuiState> = {}) {
  let state = initialState(start);
  const sent: Effect[] = [];
  const unfollowed = vi.fn();
  const deps: EffectDeps = {
    api: {
      startConversation: vi.fn().mockResolvedValue({ tasks: [] }),
      sendConversationMessage: vi.fn().mockResolvedValue({ tasks: [] }),
      forceSendPlannerMessage: vi.fn().mockResolvedValue({ tasks: [] }),
      compactConversation: vi.fn().mockResolvedValue({ plan: { tasks: [] }, summary: '' }),
      adoptSession: vi.fn().mockResolvedValue({ plan: planWith(), goal: 'g' }),
      followSession: vi.fn().mockReturnValue({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: unfollowed }),
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
  const actions: Action[] = [];
  const pending: Promise<void>[] = [];
  function apply(action: Action): void {
    actions.push(action);
    const step = reduce(state, action);
    state = step.state;
    for (const effect of step.effects) {
      sent.push(effect);
      // Only the effects a lost reply is reconciled by run for real; the rest are recorded.
      if (effect.type === 'reconcileTurn') pending.push(runEffect(effect, deps));
    }
  }
  return {
    deps,
    actions,
    unfollowed,
    api: deps.api as { [K in keyof OrdewellApi]: ReturnType<typeof vi.fn> },
    get state() { return state; },
    sent,
    run: async (effect: Effect) => { await runEffect(effect, deps); await Promise.all(pending); },
    send: (action: Action) => apply(action),
    settle: () => Promise.all(pending),
    type(text: string) {
      state = { ...state, editor: { ...state.editor, text, cursor: text.length } };
      apply({ type: 'key', key: { name: 'enter' } });
    },
  };
}

const types = (actions: Action[]) => actions.map((a) => a.type);

describe('an opening turn whose reply was lost', () => {
  it('keeps the session, follows it, and reloads what the daemon holds', async () => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'startConversation', goal: 'ship the 44-task plan' });

    expect(types(t.actions)).not.toContain('sessionCleared');
    expect(t.unfollowed).not.toHaveBeenCalled();
    expect(t.api.adoptSession).toHaveBeenCalledWith('session-new', '/ws');
    expect(t.state.sessionId).toBe('session-new');
  });

  it('answers the next reply on the same session instead of opening a new one', async () => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'startConversation', goal: 'ship the 44-task plan' });
    t.sent.length = 0;

    t.type('ok looks good, output the plan and run it');

    expect(t.sent).toEqual([{ type: 'sendMessage', sessionId: 'session-new', message: 'ok looks good, output the plan and run it' }]);
  });

  it('says in one line that the reply was lost, not that the turn failed', async () => {
    const t = tui({ sendConversationMessage: vi.fn().mockRejectedValue(timedOut()) }, { sessionId: 's1', planner: 'planning' });
    t.send({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_started', turnId: 't1' } });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'x' });

    const said = messagesOf(t.state).map((m) => m.text).filter((text) => /lost/i.test(text));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/lost on the way/i);
    expect(types(t.actions)).not.toContain('failed');
  });

  it('keeps saying the reply was lost once the daemon\'s state is redrawn', async () => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(messagesOf(t.state).some((m) => /lost on the way/i.test(m.text))).toBe(true);
  });

  it.each([
    ['a reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['a hang-up', new Error('socket hang up')],
  ])('treats %s as the same unknown outcome', async (_name, err) => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(err) });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(types(t.actions)).not.toContain('sessionCleared');
  });

  it('clears the session only when the daemon says it holds none', async () => {
    const t = tui({
      startConversation: vi.fn().mockRejectedValue(timedOut()),
      adoptSession: vi.fn().mockRejectedValue(sessionGone()),
    });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(types(t.actions)).toContain('sessionCleared');
    expect(t.unfollowed).toHaveBeenCalled();
    expect(t.state.sessionId).toBeNull();
    expect(t.state.planner).toBe('idle');
  });

  it('still clears the session when the daemon answered with a refusal', async () => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(new DaemonRefusal('no key', 400)) });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(types(t.actions)).toContain('sessionCleared');
    expect(t.api.adoptSession).not.toHaveBeenCalled();
  });

  it('shows the conversation and plan the daemon finished', async () => {
    const t = tui({
      startConversation: vi.fn().mockRejectedValue(timedOut()),
      adoptSession: vi.fn().mockResolvedValue({
        plan: planWith({ role: 'user', content: 'x' }, { role: 'assistant', content: 'Plan committed: 44 tasks.' }),
        goal: 'x',
      }),
    });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(messagesOf(t.state).some((m) => m.text === 'Plan committed: 44 tasks.')).toBe(true);
    expect(t.state.planner).toBe('idle');
  });
});

describe('a later turn whose reply was lost', () => {
  const turnOpen = (sessionId: string): Partial<TuiState> => ({ sessionId, planner: 'planning', queuedPrompts: ['and the tests'] });

  /** The daemon's stream says turn `t1` is open, as it does for a turn awaiting exploration agents. */
  function runningTurn(api: Partial<OrdewellApi>) {
    const t = tui(api, turnOpen('s1'));
    t.send({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_started', turnId: 't1' } });
    return t;
  }

  it('does not drain the queue into a turn the daemon is still running', async () => {
    const t = runningTurn({
      sendConversationMessage: vi.fn().mockRejectedValue(timedOut()),
      adoptSession: vi.fn().mockResolvedValue({ plan: planWith(), goal: 'g', plannerTurnId: 't1' }),
    });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });

    expect(t.state.queuedPrompts).toEqual(['and the tests']);
    expect(t.state.planner).toBe('awaiting');
    expect(t.sent.filter((e) => e.type === 'sendMessage')).toEqual([]);
    expect(t.api.sendConversationMessage).toHaveBeenCalledTimes(1);
    expect(types(t.actions)).not.toContain('failed');
  });

  it('settles and sends the queue once, when the stream says the turn ended', async () => {
    const t = runningTurn({ sendConversationMessage: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });

    t.send({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' } });
    await t.settle();

    expect(t.sent.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'and the tests' }]);
    expect(t.state.queuedPrompts).toEqual([]);
  });

  it('does not resend the message that was lost', async () => {
    const t = runningTurn({ sendConversationMessage: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });
    t.send({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' } });
    await t.settle();

    expect(t.sent.filter((e) => e.type === 'sendMessage' && e.message === 'first')).toEqual([]);
  });

  it('keeps a lost send-now out of the composer, since the daemon may have taken it', async () => {
    const t = tui({ forceSendPlannerMessage: vi.fn().mockRejectedValue(timedOut()) }, { sessionId: 's1', planner: 'planning', forceSendPending: { text: 'now' } });
    await t.run({ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'now' });

    expect(t.state.forceSendPending).toBeNull();
    expect(t.state.editor.text).toBe('');
  });

  it('reloads the conversation after a lost compaction rather than reporting it failed', async () => {
    const t = tui({ compactConversation: vi.fn().mockRejectedValue(timedOut()) }, { sessionId: 's1', planner: 'planning' });
    await t.run({ type: 'compactConversation', sessionId: 's1' });

    expect(t.api.adoptSession).toHaveBeenCalledWith('s1', '/ws');
    expect(types(t.actions)).not.toContain('failed');
  });

  it('reports a daemon refusal as a failed turn, as before', async () => {
    const t = tui({ sendConversationMessage: vi.fn().mockRejectedValue(new DaemonRefusal('planner down', 500)) }, turnOpen('s1'));
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });

    expect(types(t.actions)).toContain('failed');
    expect(t.api.adoptSession).not.toHaveBeenCalled();
  });
});

describe('a turn end that went with the follow socket', () => {
  /** A lost reply with a prompt held behind it, as the turn's gate stays open after `turnLost`. */
  function lostTurn(api: Partial<OrdewellApi>) {
    const t = tui(api, { sessionId: 's1', planner: 'planning', queuedPrompts: ['and the tests'] });
    t.send({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_started', turnId: 't1' } });
    t.send({ type: 'turnLost', sessionId: 's1' });
    return t;
  }

  it('reads the session back when the follow reconnects', () => {
    const awaiting = initialState({ sessionId: 's1', planner: 'awaiting' });
    expect(reduce(awaiting, { type: 'followRestored', sessionId: 's1' }).effects)
      .toEqual([{ type: 'reconcileTurn', sessionId: 's1' }]);
  });

  it('does nothing when no reply is waiting on it', () => {
    const idle = initialState({ sessionId: 's1' });
    expect(reduce(idle, { type: 'followRestored', sessionId: 's1' }).effects).toEqual([]);
  });

  it('settles the lost turn and sends the queue once the daemon holds no turn', async () => {
    const t = lostTurn({});
    t.send({ type: 'followRestored', sessionId: 's1' });
    await t.settle();

    expect(t.sent.filter((e) => e.type === 'sendMessage'))
      .toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'and the tests' }]);
    expect(t.state.queuedPrompts).toEqual([]);
    expect(t.state.turnGate.open).toBeNull();
  });

  it('keeps the turn and its queue while the daemon still runs that turn', async () => {
    const t = lostTurn({ adoptSession: vi.fn().mockResolvedValue({ plan: planWith(), goal: 'g', plannerTurnId: 't1' }) });
    t.send({ type: 'followRestored', sessionId: 's1' });
    await t.settle();

    expect(t.state.planner).toBe('awaiting');
    expect(t.state.queuedPrompts).toEqual(['and the tests']);
    expect(t.state.turnGate.open).toBe('t1');
  });

  // The gate was the lost turn's; a turn the daemon runs now is the one whose
  // end has to release the queue.
  it('follows the turn the daemon runs when the gate held a different one', async () => {
    const t = lostTurn({ adoptSession: vi.fn().mockResolvedValue({ plan: planWith(), goal: 'g', plannerTurnId: 't2' }) });
    t.send({ type: 'followRestored', sessionId: 's1' });
    await t.settle();

    expect(t.state.turnGate.open).toBe('t2');
    expect(t.state.queuedPrompts).toEqual(['and the tests']);
  });
});

describe('a compaction the daemon is still running', () => {
  const running = { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'manual', at: '2026-01-02T00:00:00.000Z' } } as const;
  const condensedEnd = { type: 'planner_compaction', compaction: { phase: 'ended', id: 'c1', origin: 'ordewell', trigger: 'manual', outcome: 'condensed', at: '2026-01-02T00:00:09.000Z' } } as const;
  const conversation = { sessionId: 's1', conversation: fromTranscript([
    { role: 'user', content: 'build me a parser', timestamp: '2026-01-02T00:00:00.000Z' },
    { role: 'assistant', content: 'Which formats?', timestamp: '2026-01-02T00:00:01.000Z' },
  ], []) };
  const blocksOf = (state: TuiState) => state.conversation.blocks.filter((b) => b.type === 'compaction');

  it('survives a lost /compact reply: the planner stays busy, the view is not redrawn, and the end releases the queue', async () => {
    const t = tui(
      { compactConversation: vi.fn().mockRejectedValue(timedOut()), adoptSession: vi.fn().mockResolvedValue({ plan: planWith(), goal: 'g', plannerCompaction: running }) },
      { ...conversation, planner: 'condensing', queuedPrompts: ['and the tests'] },
    );
    t.send({ type: 'sessionMessage', sessionId: 's1', message: running });
    const before = t.state.conversation.blocks;

    await t.run({ type: 'compactConversation', sessionId: 's1' });

    expect(t.state.planner).toBe('compacting');
    expect(blocksOf(t.state)).toEqual([expect.objectContaining({ compactionId: 'c1', status: 'running' })]);
    // Only the turnLost notice is new: nothing is redrawn.
    expect(t.state.conversation.blocks.slice(0, before.length)).toEqual(before);
    expect(t.state.queuedPrompts).toEqual(['and the tests']);
    expect(types(t.actions)).not.toContain('chatRestored');

    t.send({ type: 'sessionMessage', sessionId: 's1', message: condensedEnd });

    expect(t.sent.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'and the tests' }]);
  });

  it('is shown after a reconnect that missed its start', async () => {
    const t = tui({ adoptSession: vi.fn().mockResolvedValue({ plan: planWith(), goal: 'g', plannerCompaction: running }) }, { ...conversation, planner: 'awaiting' });

    t.send({ type: 'followRestored', sessionId: 's1' });
    await t.settle();

    expect(t.state.planner).toBe('compacting');
    expect(blocksOf(t.state)).toEqual([expect.objectContaining({ compactionId: 'c1', status: 'running' })]);
  });

  it('settles a compaction whose end went with the socket: reconnecting finds none running, so nothing is claimed and the queue goes out', async () => {
    const t = tui({ adoptSession: vi.fn().mockResolvedValue({ plan: planWith(), goal: 'g' }) }, { ...conversation, queuedPrompts: ['and the tests'] });
    t.send({ type: 'sessionMessage', sessionId: 's1', message: running });
    expect(t.state.planner).toBe('compacting');

    t.send({ type: 'followRestored', sessionId: 's1' });
    await t.settle();

    expect(t.state.planner).toBe('planning');
    expect(blocksOf(t.state)).toEqual([]);
    expect(messagesOf(t.state).map((m) => m.text).join(' ')).not.toMatch(/lost on the way/);
    expect(t.sent.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'and the tests' }]);
  });

  it('keeps a compaction the daemon finished while the socket was down, with its summary', async () => {
    const checkpoint = { id: 'c1', keptFrom: 2, trigger: 'manual' as const };
    const done = { tasks: [], conversationHistory: [
      { role: 'user', content: 'build me a parser', timestamp: '2026-01-02T00:00:00.000Z' },
      { role: 'assistant', content: 'Which formats?', timestamp: '2026-01-02T00:00:01.000Z' },
      { role: 'assistant', content: 'Conversation condensed: the state', timestamp: '2026-01-02T00:00:09.000Z', kind: 'compaction', checkpoint },
    ] } as unknown as SurfacePlan;
    const t = tui({ adoptSession: vi.fn().mockResolvedValue({ plan: done, goal: 'g' }) }, conversation);
    t.send({ type: 'sessionMessage', sessionId: 's1', message: running });

    t.send({ type: 'followRestored', sessionId: 's1' });
    await t.settle();

    expect(t.state.planner).toBe('idle');
    expect(blocksOf(t.state)).toEqual([expect.objectContaining({ compactionId: 'c1', status: 'condensed', summary: 'Conversation condensed: the state' })]);
  });
});

/**
 * The user can load another session while a turn's call is out. What the call
 * ends in — a refusal, a loss the daemon cannot read back, an unusable reply —
 * is that turn's session's, and must not clear, idle or drain the one on screen.
 */
describe('a turn that ends after another session was loaded', () => {
  /** A call the test settles once session b is on screen. */
  function held() {
    let settle: ((err: unknown) => void) | undefined;
    const call = vi.fn(() => new Promise<SurfacePlan>((_, reject) => { settle = reject; }));
    return { call, fail: async (err: unknown) => { await vi.waitFor(() => expect(settle).toBeDefined()); settle?.(err); } };
  }

  /** Session b loaded with its own turn joined and a prompt queued behind it. */
  function loadB(t: ReturnType<typeof tui>): void {
    t.send({ type: 'sessionLoaded', sessionId: 'b', goal: 'goal b' });
    t.send({ type: 'turnJoined', sessionId: 'b', turnId: 'turn-b' });
    t.type('queued for b');
    expect(t.state.queuedPrompts).toEqual(['queued for b']);
    t.sent.length = 0;
  }

  function expectBUntouched(t: ReturnType<typeof tui>, foreign: RegExp): void {
    expect(t.state.sessionId).toBe('b');
    expect(t.state.goal).toBe('goal b');
    expect(t.state.planner).toBe('joined');
    expect(t.state.queuedPrompts).toEqual(['queued for b']);
    expect(t.sent).not.toContainEqual(expect.objectContaining({ type: 'sendMessage' }));
    expect(messagesOf(t.state).some((m) => foreign.test(m.text))).toBe(false);
  }

  it('a lost reply the daemon no longer holds the session for', async () => {
    const send = held();
    const t = tui({ sendConversationMessage: send.call, adoptSession: vi.fn().mockRejectedValue(sessionGone()) }, { sessionId: 'a', planner: 'planning' });
    const running = t.run({ type: 'sendMessage', sessionId: 'a', message: 'x' });
    loadB(t);

    await send.fail(timedOut());
    await running;

    expectBUntouched(t, /no longer holding that session/);
  });

  it('a reply that arrived unusable', async () => {
    const send = held();
    const t = tui({ sendConversationMessage: send.call }, { sessionId: 'a', planner: 'planning' });
    const running = t.run({ type: 'sendMessage', sessionId: 'a', message: 'x' });
    loadB(t);

    await send.fail(new UnreadableResponseError('/conversation', 'not JSON'));
    await running;

    expectBUntouched(t, /could not be used/);
  });

  it.each([
    ['refused', new DaemonRefusal('no key configured', 400), {}, /no key configured/],
    ['lost, and the daemon holds no session for it', timedOut(), { adoptSession: vi.fn().mockRejectedValue(sessionGone()) }, /holds no session for it/],
  ] as [string, unknown, Partial<OrdewellApi>, RegExp][])('an opening turn %s', async (_, err, api, foreign) => {
    const start = held();
    const t = tui({ startConversation: start.call, ...api });
    const running = t.run({ type: 'startConversation', goal: 'goal c' });
    loadB(t);

    await start.fail(err);
    await running;

    expectBUntouched(t, foreign);
  });

  // The guard above must not swallow the failure of the session that let
  // itself go: it is reported on the welcome it left, and ends the turn there.
  it('an opening turn refused with nothing else loaded still says why and ends the turn', async () => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(new DaemonRefusal('no key configured', 400)) });
    t.type('goal c');
    expect(t.state.planner).toBe('planning');

    await t.run(t.sent[0]!);

    expect(t.state.sessionId).toBeNull();
    expect(t.state.planner).toBe('idle');
    expect(messagesOf(t.state).some((m) => /no key configured/.test(m.text))).toBe(true);
  });
});

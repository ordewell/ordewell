import { describe, it, expect } from 'vitest';
import { DaemonError } from '../../apiClient';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import { chatActivity } from '../layout';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

/**
 * Only the planner turn's own calls end the turn. Every other effect that
 * fails mid-turn — a task's log, an approval answer — says so and leaves the
 * turn, and the prompts held behind it, where they were.
 */

const typed = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const enter = (state: TuiState, text: string): TuiState => reduce(typed(state, text), { type: 'key', key: { name: 'enter' } }).state;

/** A turn out, with one prompt held behind it. */
const midTurn = (): TuiState => enter(enter(initialState({ sessionId: 's1', rows: 30, cols: 100 }), 'build it'), 'and a README');

const rejects = (): Promise<never> => Promise.reject(new Error('socket hang up'));
/** What the daemon answers when the turn itself fails. */
const refusesTurn = (): Promise<never> => Promise.reject(new DaemonError('planner down', 500));
/** What Node rejects with when nothing is listening on the daemon's port. */
const refused = (): Promise<never> => Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3742'), { code: 'ECONNREFUSED' }));
/** The sockets a turn opens around its call, open at once and never dropping. */
const turnSockets: Partial<OrdewellApi> = {
  followSession: () => ({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} }),
};

/** Runs one effect against `api` and folds every action it dispatched into `state`. */
async function settle(state: TuiState, effect: Effect, api: Partial<OrdewellApi>, over: Partial<EffectDeps> = {}): Promise<{ state: TuiState; effects: Effect[] }> {
  const actions: Action[] = [];
  const deps: EffectDeps = {
    api: api as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action) => actions.push(action),
    newSessionId: () => 's1',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    reviveDaemon: () => Promise.resolve(false),
    setMouseCapture: () => {},
    writeTerminal: () => {},
    login: async () => ({ ok: true }),
    exit: () => {},
    ...over,
  };
  await runEffect(effect, deps);
  const effects: Effect[] = [];
  for (const action of actions) {
    const next = reduce(state, action);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

describe('a failure that is not the planner turn\'s', () => {
  it('a task-log read failing mid-turn keeps "Planning…" and the queue held', async () => {
    const { state, effects } = await settle(midTurn(), { type: 'openTaskLog', sessionId: 's1', taskId: 'a' }, { getTaskLogAttempts: rejects });

    expect(chatActivity(state)?.label).toBe('Planning…');
    expect(state.queuedPrompts).toEqual(['and a README']);
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)).toMatchObject({ role: 'error', text: 'socket hang up' });
  });

  it('an approval answer that cannot be delivered mid-turn keeps "Planning…" and the queue held', async () => {
    const { state, effects } = await settle(midTurn(), { type: 'respondApproval', sessionId: 's1', approvalId: 'ap1', granted: true }, { respondToApproval: rejects });

    expect(chatActivity(state)?.label).toBe('Planning…');
    expect(state.queuedPrompts).toEqual(['and a README']);
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)).toMatchObject({ role: 'error', text: 'Could not deliver the approval answer: the planner will treat it as denied.' });
  });

  // The turn's own calls go to the same daemon: if it is really gone, the
  // turn's request fails too and ends the turn with its own error.
  it('a refused connection on a call that is not the turn\'s leaves the turn running', async () => {
    const { state, effects } = await settle(midTurn(), { type: 'openTaskLog', sessionId: 's1', taskId: 'a' }, { getTaskLogAttempts: refused });

    expect(chatActivity(state)?.label).toBe('Planning…');
    expect(state.queuedPrompts).toEqual(['and a README']);
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)?.text).toContain('3742');
  });
});

describe('a failure of the planner turn itself', () => {
  it('ends the turn and sends the held prompt, as before', async () => {
    const { state, effects } = await settle(midTurn(), { type: 'sendMessage', sessionId: 's1', message: 'build it' }, {
      ...turnSockets,
      sendConversationMessage: refusesTurn,
    });

    expect(messagesOf(state).some((m) => m.role === 'error' && m.text === 'planner down')).toBe(true);
    expect(state.queuedPrompts).toEqual([]);
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'and a README' }]);
  });

  // The request went out and nothing came back: the daemon may be on the turn
  // still, so it is not over and the queue is not sent into it — even when the
  // daemon cannot be asked straight away.
  it('does not end the turn when its reply is lost in transit', async () => {
    const { state, effects } = await settle(midTurn(), { type: 'sendMessage', sessionId: 's1', message: 'build it' }, {
      ...turnSockets,
      sendConversationMessage: rejects,
      adoptSession: rejects,
    });

    expect(chatActivity(state)?.label).toBe('Waiting for the planner…');
    expect(state.queuedPrompts).toEqual(['and a README']);
    expect(effects).toEqual([]);
  });

  it('ends the turn when its connection is refused and the daemon cannot be brought back', async () => {
    const { state, effects } = await settle(midTurn(), { type: 'sendMessage', sessionId: 's1', message: 'build it' }, {
      ...turnSockets,
      sendConversationMessage: refused,
    });

    expect(state.queuedPrompts).toEqual([]);
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'and a README' }]);
  });
});

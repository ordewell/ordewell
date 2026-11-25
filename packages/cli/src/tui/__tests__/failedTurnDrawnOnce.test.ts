import { describe, it, expect } from 'vitest';
import type { SerializedConversationMessage, SerializedPlan } from '@ordewell/core';
import { initialState, reduce, type Action } from '../reducer';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

/**
 * An opening the daemon admitted, kept and saw fail reaches the view twice:
 * the session's saved failure on the stream (`plan_generated`) and the call's
 * failed answer. Whichever arrives first draws it, and the other does not draw
 * it again; a later turn's failure, however worded, is its own.
 */

const GOAL = 'Add a --name flag to hello.py';
const FAILURE = 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.';

const key = (name: string) => ({ type: 'key' as const, key: { name } });
const typed = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const apply = (state: TuiState, ...actions: Action[]): TuiState => actions.reduce((s, a) => reduce(s, a).state, state);
const lines = (state: TuiState) => messagesOf(state).map((m) => [m.role, m.text]);

const entry = (role: 'user' | 'assistant', content: string, timestamp: string, kind?: 'error'): SerializedConversationMessage =>
  ({ role, content, timestamp, ...(kind ? { kind } : {}) }) as SerializedConversationMessage;

/** The session as the daemon saved it once the opening failed. */
const SAVED: SerializedConversationMessage[] = [
  entry('user', GOAL, '2026-11-25T10:00:00.000Z'),
  entry('assistant', FAILURE, '2026-11-25T10:00:01.000Z', 'error'),
];

const live = (message: Extract<Action, { type: 'sessionMessage' }>['message']): Action =>
  ({ type: 'sessionMessage', sessionId: 's1', message, at: '2026-11-25T10:00:01.500Z' });
const turnStarted = (turnId: string, prompt: string) => live({ type: 'planner_turn_started', turnId, prompt });
const turnFailed = (turnId: string) => live({ type: 'planner_turn_ended', turnId, outcome: 'error' });
const savedBroadcast = (history = SAVED) =>
  live({ type: 'plan_generated', plan: { id: 's1', goal: GOAL, tasks: [], conversationHistory: history } as unknown as SerializedPlan, goal: GOAL, runners: [] });
const callFailed: Action = { type: 'failed', message: FAILURE, turn: true, sessionId: 's1' };

/** The goal sent from the welcome, its session opened and its turn started and failed on the daemon. */
function openingFailedOnDaemon(): TuiState {
  const sent = reduce(typed(initialState(), GOAL), key('enter'));
  expect(sent.effects).toEqual([expect.objectContaining({ type: 'startConversation', goal: GOAL })]);
  return apply(sent.state, { type: 'sessionStarted', sessionId: 's1', goal: GOAL }, turnStarted('t1', GOAL), turnFailed('t1'));
}

describe('an admitted opening that fails', () => {
  it('is drawn once when the saved failure arrives before the call answers', () => {
    const s = apply(openingFailedOnDaemon(), savedBroadcast(), callFailed);
    expect(lines(s)).toEqual([['user', GOAL], ['error', FAILURE]]);
    expect(s.planner).toBe('idle');
    expect(s.sessionId).toBe('s1');
  });

  it('is drawn once when the call answers before the saved failure arrives', () => {
    const s = apply(openingFailedOnDaemon(), callFailed, savedBroadcast());
    expect(lines(s)).toEqual([['user', GOAL], ['error', FAILURE]]);
    expect(s.planner).toBe('idle');
  });

  it('is drawn once when the stream was slower than the call for the whole turn', () => {
    const sent = reduce(typed(initialState(), GOAL), key('enter')).state;
    const s = apply(sent, { type: 'sessionStarted', sessionId: 's1', goal: GOAL }, callFailed, turnStarted('t1', GOAL), turnFailed('t1'), savedBroadcast());
    expect(lines(s)).toEqual([['user', GOAL], ['error', FAILURE]]);
  });

  it('is still drawn from the call when the stream never delivers it', () => {
    const s = apply(openingFailedOnDaemon(), callFailed);
    expect(lines(s)).toEqual([['user', GOAL], ['error', FAILURE]]);
  });

  it('is drawn once when the session is read back from its transcript', () => {
    for (const order of [[savedBroadcast(), callFailed], [callFailed, savedBroadcast()], [callFailed]]) {
      const s = apply(openingFailedOnDaemon(), ...order, { type: 'chatRestored', history: SAVED, sessionId: 's1' });
      expect(lines(s)).toEqual([['user', GOAL], ['error', FAILURE]]);
    }
  });

  it('leaves a later turn failing with the same words its own line, in either order', () => {
    for (const first of [[savedBroadcast(), callFailed], [callFailed, savedBroadcast()]]) {
      const opened = apply(openingFailedOnDaemon(), ...first);
      const again = reduce(typed(opened, 'Try again'), key('enter'));
      expect(again.effects).toEqual([expect.objectContaining({ type: 'sendMessage', message: 'Try again' })]);
      // A later turn's failure is not saved; were it, its copy would come after its own line.
      const resaved = [...SAVED, entry('user', 'Try again', '2026-11-25T10:01:00.000Z'), entry('assistant', FAILURE, '2026-11-25T10:01:01.000Z', 'error')];
      const s = apply(again.state, turnStarted('t2', 'Try again'), turnFailed('t2'), callFailed, savedBroadcast(resaved));
      expect(lines(s)).toEqual([['user', GOAL], ['error', FAILURE], ['user', 'Try again'], ['error', FAILURE]]);
    }
  });
});

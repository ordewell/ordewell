import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

/**
 * A message the daemon refused before any planner turn started (409
 * planner_not_ready) was never sent: it leaves the chat, and its text goes
 * back into the composer, ahead of anything typed since.
 */

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const withDraft = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const send = (state: TuiState, action: Parameters<typeof reduce>[1]) => reduce(state, action).state;
const userLines = (state: TuiState) => messagesOf(state).filter((m) => m.role === 'user').map((m) => m.text);

const refusal = { type: 'failed' as const, message: 'Claude Code is not signed in. Sign in with /login claude-code.', code: 'planner_not_ready' as const, turn: true as const };

describe('a message refused before its turn started', () => {
  it('a first goal leaves the chat and is back in the composer', () => {
    const goal = 'Add a --name flag to hello.py';
    const sent = reduce(withDraft(initialState(), goal), key('enter'));
    expect(sent.effects).toEqual([expect.objectContaining({ type: 'startConversation', goal })]);
    const opened = send(sent.state, { type: 'sessionStarted', sessionId: 's1', goal });
    const cleared = send(opened, { type: 'sessionCleared', sessionId: 's1' });

    const s = send(cleared, { ...refusal, unsent: goal });

    expect(s.editor.text).toBe(goal);
    expect(s.editor.cursor).toBe(goal.length);
    expect(userLines(s)).toEqual([]);
    expect(messagesOf(s).at(-1)).toMatchObject({ role: 'error', text: refusal.message });
    expect(s.planner).toBe('idle');
  });

  it('a later message leaves the chat, the session and the answered goal stay', () => {
    const start = { ...initialState({ sessionId: 's1' }) };
    const answered = send(send(withDraft(start, 'Add a flag'), key('enter')), { type: 'failed', message: 'unrelated', turn: true });
    const sent = reduce(withDraft(answered, 'Yes, default to world'), key('enter'));
    expect(sent.effects).toEqual([expect.objectContaining({ type: 'sendMessage', message: 'Yes, default to world' })]);

    const s = send(sent.state, { ...refusal, unsent: 'Yes, default to world', sessionId: 's1' });

    expect(s.sessionId).toBe('s1');
    expect(s.editor.text).toBe('Yes, default to world');
    expect(userLines(s)).toEqual(['Add a flag']);
  });

  it('goes back ahead of what was typed while it was refused', () => {
    const sent = send(withDraft(initialState({ sessionId: 's1' }), 'First thought'), key('enter'));
    const typed = withDraft(sent, 'and a second');

    const s = send(typed, { ...refusal, unsent: 'First thought', sessionId: 's1' });

    expect(s.editor.text).toBe('First thought\nand a second');
    expect(userLines(s)).toEqual([]);
  });

  it('a failure the daemon answered after the turn started leaves the message where it was', () => {
    const sent = send(withDraft(initialState({ sessionId: 's1' }), 'Plan it'), key('enter'));

    const s = send(sent, { type: 'failed', message: 'the planner crashed', turn: true, sessionId: 's1' });

    expect(s.editor.text).toBe('');
    expect(userLines(s)).toEqual(['Plan it']);
  });
});

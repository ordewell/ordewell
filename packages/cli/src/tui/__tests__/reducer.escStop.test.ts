import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TuiState } from '../state';

/**
 * ESC stops the planner (a planning turn in flight, any planner backend)
 * before it falls back to anything ESC did before this existed. See the
 * precedence note on `handleKey`.
 */

function press(overrides: Partial<TuiState> = {}, editorText = '') {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text: editorText, cursor: editorText.length } };
  return reduce(state, { type: 'key', key: { name: 'escape' } });
}

describe('ESC while planning', () => {
  it('emits cancelPlanning instead of clearing the draft', () => {
    const { state, effects } = press({ status: 'planning', sessionId: 'session-1' }, 'unsent draft');

    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 'session-1' }]);
    // The draft is untouched — cancelPlanning owns this ESC, not the editor clear.
    expect(state.editor.text).toBe('unsent draft');
  });

  it('also stops a research turn (the other in-flight planner status)', () => {
    const { effects } = press({ status: 'researching', sessionId: 'session-1' });
    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 'session-1' }]);
  });

  it('does nothing special without a session, even mid-status', () => {
    // Can't happen in practice (no session, no turn), but the guard is what
    // makes that true rather than an accident.
    const { effects } = press({ status: 'planning', sessionId: null }, 'x');
    expect(effects).toEqual([]);
  });

  it('an open overlay still owns ESC — planning does not preempt it', () => {
    const { state, effects } = press({
      status: 'planning',
      sessionId: 'session-1',
      overlay: { kind: 'confirm', title: 'New session?', message: 'Discard the current plan?', action: { kind: 'new-session' } },
    });

    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull(); // confirm's own escape handling: cancels
  });

  it('a second ESC after planning has settled clears the chat draft as before', () => {
    const { state, effects } = press({ status: 'idle', sessionId: 'session-1' }, 'left in the box');

    expect(effects).toEqual([]);
    expect(state.editor.text).toBe('');
  });

  it('returns plan-pane focus to chat when idle, as before', () => {
    const { state, effects } = press({ status: 'idle', sessionId: 'session-1', focus: 'plan' });
    expect(effects).toEqual([]);
    expect(state.focus).toBe('chat');
  });
});

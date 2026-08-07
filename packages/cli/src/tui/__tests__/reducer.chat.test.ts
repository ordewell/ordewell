import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import type { ChatMessage, TuiState } from '../state';

const typing = (text: string) => ({
  ...initialState(),
  editor: { ...initialState().editor, text, cursor: text.length },
});

describe('reduce — typing', () => {
  it('routes printable keys into the editor', () => {
    const { state } = reduce(initialState(), { type: 'key', key: { name: 'char', char: 'h' } });
    expect(state.editor.text).toBe('h');
  });

  it('emits no effects for plain typing', () => {
    const { effects } = reduce(initialState(), { type: 'key', key: { name: 'char', char: 'h' } });
    expect(effects).toEqual([]);
  });

  it('a paste with newlines lands in the editor without submitting', () => {
    const { state, effects } = reduce(typing('see: '), {
      type: 'key',
      key: { name: 'paste', text: 'line1\nline2' },
    });
    expect(effects).toEqual([]);
    expect(state.editor.text).toBe('see: line1\nline2');
    expect(state.messages).toEqual([]);
  });
});

describe('reduce — submitting a goal', () => {
  it('starts a planner conversation with the typed goal', () => {
    const { effects } = reduce(typing('add a login page'), { type: 'key', key: { name: 'enter' } });
    expect(effects).toEqual([{ type: 'startConversation', goal: 'add a login page' }]);
  });

  it('echoes the goal into the transcript and clears the input', () => {
    const { state } = reduce(typing('add a login page'), { type: 'key', key: { name: 'enter' } });
    expect(state.editor.text).toBe('');
    expect(state.messages.at(-1)).toMatchObject({ role: 'user', content: 'add a login page' });
  });

  it('marks the session busy while the planner works', () => {
    const { state } = reduce(typing('a goal'), { type: 'key', key: { name: 'enter' } });
    expect(state.status).toBe('planning');
  });

  it('ignores an empty submit', () => {
    const { state, effects } = reduce(initialState(), { type: 'key', key: { name: 'enter' } });
    expect(effects).toEqual([]);
    expect(state.messages).toEqual([]);
  });

  it('answers the planner instead of restarting once a conversation is open', () => {
    const open = { ...typing('use bcrypt'), sessionId: 'session-1' };
    const { effects } = reduce(open, { type: 'key', key: { name: 'enter' } });
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 'session-1', message: 'use bcrypt' }]);
  });
});

describe('reduce — multi-line input navigation', () => {
  it('up moves cursor within multi-line input instead of scrolling transcript', () => {
    const state = initialState({
      editor: {
        ...initialState().editor,
        text: 'line1\nline2\nline3',
        cursor: 12,
      },
    });
    const { state: next } = reduce(state, { type: 'key', key: { name: 'up' } });
    expect('cursor' in next).toBe(false);
    expect(next.editor.cursor).toBeLessThan(12);
    expect(next.scroll).toBe(0);
  });

  it('down moves cursor within multi-line input instead of scrolling transcript', () => {
    const state = initialState({
      editor: {
        ...initialState().editor,
        text: 'line1\nline2\nline3',
        cursor: 0,
      },
    });
    const { state: next } = reduce(state, { type: 'key', key: { name: 'down' } });
    expect(next.editor.cursor).toBeGreaterThan(0);
    expect(next.scroll).toBe(0);
  });

  it('shift-enter inserts newline in multi-line input', () => {
    const { state } = reduce(typing('hello'), { type: 'key', key: { name: 'shift-enter' } });
    expect(state.editor.text).toBe('hello\n');
    expect(state.editor.cursor).toBe(6);
  });

  it('shift-enter in the middle of text inserts newline at cursor', () => {
    const s = initialState({
      editor: {
        ...initialState().editor,
        text: 'hello',
        cursor: 2,
      },
    });
    const { state } = reduce(s, { type: 'key', key: { name: 'shift-enter' } });
    expect(state.editor.text).toBe('he\nllo');
    expect(state.editor.cursor).toBe(3);
  });

  it('alt-enter also inserts a newline instead of submitting, for terminals that cannot report shift-enter', () => {
    const { state } = reduce(typing('hello'), { type: 'key', key: { name: 'alt-enter' } });
    expect(state.editor.text).toBe('hello\n');
    expect(state.messages).toHaveLength(0);
  });
});

describe('reduce — stale session results', () => {
  it('drops a plannerMessage that arrives after /new has moved on to a fresh session', () => {
    const afterNew = { ...initialState(), sessionId: 'session-2' };
    const { state } = reduce(afterNew, {
      type: 'plannerMessage',
      content: 'stray follow-up from the old session',
      sessionId: 'session-1',
    });
    expect(state.messages).toHaveLength(0);
    expect(state).toBe(afterNew);
  });

  it('drops a planUpdated for a session that is no longer current', () => {
    const afterNew = { ...initialState(), sessionId: 'session-2' };
    const { state } = reduce(afterNew, {
      type: 'planUpdated',
      plan: { tasks: [{ id: 'a', title: 'stale' }] },
      sessionId: 'session-1',
    });
    expect(state.tasks).toHaveLength(0);
  });

  it('still applies a planUpdated/plannerMessage carrying the current session id', () => {
    const s = { ...initialState(), sessionId: 'session-2' };
    const { state } = reduce(s, { type: 'plannerMessage', content: 'hi', sessionId: 'session-2' });
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'hi' });
  });

  it('applies an untagged result (no sessionId) as before, for call sites that do not scope it', () => {
    const s = initialState();
    const { state } = reduce(s, { type: 'plannerMessage', content: 'hi' });
    expect(state.messages.at(-1)).toMatchObject({ content: 'hi' });
  });

  it('turns a tab in a planner turn into a space, the same as a pasted one', () => {
    const s = initialState();
    const { state } = reduce(s, { type: 'plannerMessage', content: 'columns:\tname\tage' });
    expect(state.messages.at(-1)).toMatchObject({ content: 'columns: name age' });
  });

  it('still dedups a repeated turn that carries a tab', () => {
    const s = { ...initialState(), sessionId: 's1' };
    const once = reduce(s, { type: 'plannerMessage', content: 'a\tb', sessionId: 's1' }).state;
    const { state } = reduce(once, { type: 'plannerMessage', content: 'a\tb', sessionId: 's1' });
    expect(state.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});

describe('reduce — one planner turn, two delivery paths', () => {
  const spoken = (content: string) =>
    reduce({ ...initialState(), sessionId: 's1' }, { type: 'plannerMessage', content, sessionId: 's1' }).state;

  it('speaks a turn that arrives over the socket and again in the REST reply only once', () => {
    const first = spoken('Tasks updated:\n- #3 added');
    const { state } = reduce(first, {
      type: 'plannerMessage',
      content: 'Tasks updated:\n- #3 added',
      sessionId: 's1',
    });
    expect(state.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('still settles the busy status on the duplicate, since it is the same turn ending', () => {
    const busy = { ...spoken('Which database?'), status: 'planning' as const, busyLabel: 'reading files', thinkingLine: 'hmm' };
    const { state } = reduce(busy, { type: 'plannerMessage', content: 'Which database?', sessionId: 's1' });
    expect(state.status).toBe('idle');
    expect(state.busyLabel).toBe('');
    expect(state.thinkingLine).toBe('');
  });

  it('speaks an identical reply again once the user has said something in between', () => {
    const asked = spoken('Which database?');
    const replied = reduce(asked, { type: 'key', key: { name: 'paste', text: 'postgres' } }).state;
    const sent = reduce(replied, { type: 'key', key: { name: 'enter' } }).state;
    const { state } = reduce(sent, { type: 'plannerMessage', content: 'Which database?', sessionId: 's1' });
    expect(state.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('does not confuse a research line landing between the two copies for a new turn', () => {
    const asked = spoken('Which database?');
    const researched = reduce(asked, { type: 'researchStep', summary: 'read package.json', sessionId: 's1' }).state;
    const { state } = reduce(researched, { type: 'plannerMessage', content: 'Which database?', sessionId: 's1' });
    expect(state.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});

describe('reduce — scrolling the transcript', () => {
  /** A transcript several screens deep, so there is room to page through. */
  const longTranscript = (): TuiState => initialState({
    messages: Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `m${i}`, timestamp: '' })),
  });

  it('pageup scrolls back through the transcript', () => {
    const { state } = reduce(longTranscript(), { type: 'key', key: { name: 'pageup' } });
    expect(state.scroll).toBeGreaterThan(0);
  });

  it('a transcript shorter than the pane has nothing to scroll, so pageup is a no-op', () => {
    const { state } = reduce(initialState(), { type: 'key', key: { name: 'pageup' } });
    expect(state.scroll).toBe(0);
  });

  it('pagedown scrolls forward and stops at the live tail', () => {
    const back = reduce(longTranscript(), { type: 'key', key: { name: 'pageup' } }).state;
    const forward = reduce(back, { type: 'key', key: { name: 'pagedown' } }).state;
    expect(forward.scroll).toBe(0);
    expect(reduce(forward, { type: 'key', key: { name: 'pagedown' } }).state.scroll).toBe(0);
  });

  it('a new message snaps the view back to the tail', () => {
    const scrolled = { ...initialState(), scroll: 12 };
    const { state } = reduce(scrolled, { type: 'notice', message: 'done' });
    expect(state.scroll).toBe(0);
  });

  it('leaves the plan pane selection alone', () => {
    const s = { ...initialState(), focus: 'plan' as const };
    const { state } = reduce(s, { type: 'key', key: { name: 'pageup' } });
    expect(state.scroll).toBe(0);
  });

  it('the mouse wheel scrolls back and forward by a small notch', () => {
    const long = initialState({
      messages: Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `m${i}`, timestamp: '' })),
    });
    const back = reduce(long, { type: 'key', key: { name: 'scrollup' } }).state;
    expect(back.scroll).toBe(3);
    const forward = reduce(back, { type: 'key', key: { name: 'scrolldown' } }).state;
    expect(forward.scroll).toBe(0);
  });

  /**
   * The transcript is taller than the pane by a couple of lines, so there is
   * something to scroll — but far less than twenty notches' worth.
   */
  const shortTranscript = (): TuiState => {
    const messages: ChatMessage[] = ['one', 'two', 'three'].map((content) => ({
      role: 'user' as const, content, timestamp: '',
    }));
    return initialState({ rows: 10, cols: 40, messages });
  };

  const frame = (state: TuiState): string => render(state).join('\n');

  it('a wheel-down after twenty wheel-ups moves the view on the very first notch', () => {
    let state = shortTranscript();
    for (let i = 0; i < 20; i++) state = reduce(state, { type: 'key', key: { name: 'scrollup' } }).state;

    const back = frame(state);
    const forward = reduce(state, { type: 'key', key: { name: 'scrolldown' } }).state;

    expect(frame(forward)).not.toBe(back);
  });

  it('up/down recall chat history instead of scrolling the transcript when the draft is single-line', () => {
    const state = initialState({
      editor: {
        ...initialState().editor,
        history: ['previous message'],
        historyIndex: 1,
      },
    });

    const back = reduce(state, { type: 'key', key: { name: 'up' } }).state;
    expect(back.scroll).toBe(0);
    expect(back.editor.text).toBe('previous message');

    const forward = reduce(back, { type: 'key', key: { name: 'down' } }).state;
    expect(forward.scroll).toBe(0);
    expect(forward.editor.text).toBe('');
  });

});

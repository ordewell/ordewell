import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TaskView, TuiState } from '../state';
import { chatActivity } from '../layout';
import { messagesOf } from './chat';

function run(text: string, overrides: Partial<TuiState> = {}) {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text, cursor: text.length } };
  return reduce(state, { type: 'key', key: { name: 'enter' } });
}

const task = (over: Partial<TaskView>): TaskView => ({
  id: 'task-1', order: 1, title: 'Do the thing', type: 'ai', status: 'pending', dependencies: [], ...over,
});

const planned: Partial<TuiState> = { sessionId: 'session-1', tasks: [task({})] };

const targets = [
  { index: 2, preview: 'JSON only', content: 'JSON only', timestamp: '2026-01-01T00:00:02Z' },
  { index: 4, preview: 'Streaming', content: 'Streaming\nand also resumable', timestamp: '2026-01-01T00:00:04Z' },
];

const lastError = (state: TuiState) => messagesOf(state).filter((m) => m.role === 'error').at(-1)?.text;

describe('/fork', () => {
  it('forks the current session', () => {
    expect(run('/fork', planned).effects).toEqual([{ type: 'forkConversation', sessionId: 'session-1' }]);
  });

  it('needs a session to fork', () => {
    const { effects, state } = run('/fork');
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/No active plan/);
  });

  it('waits for the planner while it is planning', () => {
    const planner = 'planning' as const;
    const { effects, state } = run('/fork', { ...planned, planner });
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/planner is still answering/);
  });

  it('is allowed while tasks execute', () => {
    expect(run('/fork', { ...planned, status: 'executing' }).effects).toEqual([{ type: 'forkConversation', sessionId: 'session-1' }]);
  });
});

describe('switching to a fork', () => {
  it('adopts the fork as the current session, not running and not yet approved', () => {
    const from = initialState({ ...planned, status: 'executing', planApproved: true, planner: 'condensing' });

    const { state } = reduce(from, { type: 'sessionForked', sessionId: 'session-2', goal: 'build me a parser' });

    expect(state.sessionId).toBe('session-2');
    expect(state.goal).toBe('build me a parser');
    expect(state.status).toBe('idle');
    expect(state.planApproved).toBe(false);
    expect(state.planner).toBe('idle');
  });

  it('then ignores the original session\'s events', () => {
    const forked = reduce(initialState(planned), { type: 'sessionForked', sessionId: 'session-2', goal: 'g' }).state;
    const state = reduce(forked, { type: 'planUpdated', sessionId: 'session-2', plan: { tasks: [{ id: 'task-1', order: 1, title: 'T', type: 'ai', status: 'pending', dependencies: [] }] } }).state;

    const after = reduce(state, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 'task-1', status: 'in_progress', verdict: null }] }, sessionId: 'session-1' });

    expect(after.state.tasks[0].status).toBe('pending');
  });
});

describe('/rewind', () => {
  it('needs a session to rewind', () => {
    const { effects, state } = run('/rewind');
    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
    expect(lastError(state)).toMatch(/No active plan/);
  });

  it('opens a picker of user messages and asks the daemon for them', () => {
    const { state, effects } = run('/rewind', planned);

    expect(effects).toEqual([{ type: 'loadRewindTargets', sessionId: 'session-1' }]);
    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'rewind' }, items: [] } });
  });

  it('fills the open picker, most recent message first, and asks before rewinding to the one chosen', () => {
    const { state } = run('/rewind', planned);

    const filled = reduce(state, { type: 'rewindTargetsLoaded', targets, sessionId: 'session-1' }).state;
    expect(filled.overlay?.kind === 'picker' && filled.overlay.picker.items.map((i) => i.label)).toEqual(['Streaming', 'JSON only']);

    const down = reduce(filled, { type: 'key', key: { name: 'down' } }).state;
    const chosen = reduce(down, { type: 'key', key: { name: 'enter' } });
    expect(chosen.effects).toEqual([]);
    expect(chosen.state.overlay).toMatchObject({
      kind: 'confirm',
      title: 'Rewind',
      message: 'Confirm you want to restore to the point before you sent this message:',
      quote: 'JSON only',
      note: 'The conversation will be forked.\nThe code will be unchanged.',
      action: { kind: 'rewind', index: 2 },
      choice: { index: 0, options: [{ label: 'Restore Conversation', confirms: true }, { label: 'Never mind', confirms: false }] },
    });
  });

  it('quotes the whole message, not the picker\'s one-line preview', () => {
    const { state } = run('/rewind', planned);
    const filled = reduce(state, { type: 'rewindTargetsLoaded', targets, sessionId: 'session-1' }).state;

    const chosen = reduce(filled, { type: 'key', key: { name: 'enter' } }).state;

    expect(chosen.overlay).toMatchObject({ kind: 'confirm', quote: 'Streaming\nand also resumable', action: { kind: 'rewind', index: 4 } });
  });

  it('explains an empty list instead of showing a blank picker', () => {
    const { state } = run('/rewind', planned);

    const filled = reduce(state, { type: 'rewindTargetsLoaded', targets: [], sessionId: 'session-1' }).state;

    expect(filled.overlay?.kind === 'picker' && filled.overlay.picker.items).toEqual([
      expect.objectContaining({ disabled: true, label: expect.stringMatching(/Nothing to rewind to/) }),
    ]);
  });

  it('ignores targets that arrive for a session it has left', () => {
    const { state } = run('/rewind', planned);

    const after = reduce({ ...state, sessionId: 'session-2' }, { type: 'rewindTargetsLoaded', targets, sessionId: 'session-1' }).state;

    expect(after.overlay?.kind === 'picker' && after.overlay.picker.items).toEqual([]);
  });

  it('/rewind <n> fetches the messages so it can quote that one, and opens nothing yet', () => {
    const { state, effects } = run('/rewind 4', planned);

    expect(effects).toEqual([{ type: 'loadRewindTargets', sessionId: 'session-1', pick: 4 }]);
    expect(state.overlay).toBeNull();
  });

  it('/rewind <n> asks for confirmation once the messages arrive', () => {
    const { state } = run('/rewind 4', planned);

    const loaded = reduce(state, { type: 'rewindTargetsLoaded', targets, sessionId: 'session-1', pick: 4 });

    expect(loaded.effects).toEqual([]);
    expect(loaded.state.overlay).toMatchObject({ kind: 'confirm', title: 'Rewind', quote: 'Streaming\nand also resumable', action: { kind: 'rewind', index: 4 } });
  });

  it('/rewind <n> names a message that is not there rather than opening a popup', () => {
    const { state } = run('/rewind 3', planned);

    const loaded = reduce(state, { type: 'rewindTargetsLoaded', targets, sessionId: 'session-1', pick: 3 }).state;

    expect(loaded.overlay).toBeNull();
    expect(lastError(loaded)).toMatch(/No message 3 to rewind to/);
  });

  it('/rewind <n> drops the answer when the planner got busy in the meantime', () => {
    const { state } = run('/rewind 4', planned);

    const loaded = reduce({ ...state, planner: 'planning' }, { type: 'rewindTargetsLoaded', targets, sessionId: 'session-1', pick: 4 }).state;

    expect(loaded.overlay).toBeNull();
    expect(lastError(loaded)).toMatch(/planner is still answering/);
  });

  it('gives a busy planner no popup, planning', () => {
    const planner = 'planning' as const;
    for (const text of ['/rewind', '/rewind 4']) {
      const { effects, state } = run(text, { ...planned, planner });
      expect(effects).toEqual([]);
      expect(state.overlay).toBeNull();
      expect(lastError(state)).toMatch(/planner is still answering/);
    }
  });

  it.each(['abc', '-1', '2.5'])('refuses /rewind %s', (arg) => {
    const { effects, state } = run(`/rewind ${arg}`, planned);
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/Usage: \/rewind/);
  });

  it('waits for the planner while it is answering', () => {
    const { effects, state } = run('/rewind', { ...planned, planner: 'planning' });
    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
    expect(lastError(state)).toMatch(/planner is still answering/);
  });

  it('is allowed while tasks execute', () => {
    expect(run('/rewind 4', { ...planned, status: 'executing' }).effects).toEqual([{ type: 'loadRewindTargets', sessionId: 'session-1', pick: 4 }]);
  });
});

describe('the rewind confirmation', () => {
  const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
  const press = (state: TuiState, ...actions: ReturnType<typeof key>[]) =>
    actions.reduce((acc, action) => reduce(acc.state, action), { state, effects: [] as ReturnType<typeof reduce>['effects'] });

  const asked = (over: Partial<TuiState> = {}): TuiState => {
    const opened = run('/rewind 4', { ...planned, ...over }).state;
    return reduce(opened, { type: 'rewindTargetsLoaded', targets, sessionId: 'session-1', pick: 4 }).state;
  };
  const highlighted = (state: TuiState) => (state.overlay?.kind === 'confirm' ? state.overlay.choice?.index : undefined);

  it('starts on Restore Conversation', () => {
    expect(highlighted(asked())).toBe(0);
  });

  it('moves the caret with the arrows and stops at the ends', () => {
    expect(highlighted(press(asked(), key('down')).state)).toBe(1);
    expect(highlighted(press(asked(), key('down'), key('down')).state)).toBe(1);
    expect(highlighted(press(asked(), key('down'), key('up')).state)).toBe(0);
    expect(highlighted(press(asked(), key('up')).state)).toBe(0);
  });

  it('enter on Restore Conversation rewinds and closes the popup', () => {
    const { state, effects } = press(asked(), key('enter'));

    expect(effects).toEqual([{ type: 'rewindConversation', sessionId: 'session-1', index: 4 }]);
    expect(state.overlay).toBeNull();
  });

  it('1 restores without moving the caret first', () => {
    const { state, effects } = press(asked(), key('down'), key('char', '1'));

    expect(effects).toEqual([{ type: 'rewindConversation', sessionId: 'session-1', index: 4 }]);
    expect(state.overlay).toBeNull();
  });

  it.each([
    ['2', [key('char', '2')]],
    ['enter on Never mind', [key('down'), key('enter')]],
    ['esc', [key('escape')]],
  ])('%s closes the popup and does nothing', (_label, keys) => {
    const before = asked();
    const { state, effects } = press(before, ...keys);

    expect(effects).toEqual([]);
    expect(state).toEqual({ ...before, overlay: null });
  });

  it('ignores other keys', () => {
    const before = asked();

    expect(press(before, key('char', 'x'), key('char', '3'), key('tab')).state).toEqual(before);
  });

  it('will not restore once the planner has started answering', () => {
    const { state, effects } = press({ ...asked(), planner: 'planning' }, key('enter'));

    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
    expect(lastError(state)).toMatch(/planner is still answering/);
  });
});

describe('prefilling the input after a rewind', () => {
  const typed: Partial<TuiState> = {
    ...planned,
    editor: { text: 'half a th', cursor: 4, history: ['one', 'two'], historyIndex: 1, draft: 'parked' },
  };

  it('puts the rewound message in the editor with the caret after it and history back at the end', () => {
    const { state } = reduce(initialState(typed), { type: 'inputPrefilled', text: 'Streaming\nand more', sessionId: 'session-1' });

    expect(state.editor).toEqual({ text: 'Streaming\nand more', cursor: 18, history: ['one', 'two'], historyIndex: 2, draft: '' });
  });

  it('moves focus to the chat, where the input is', () => {
    const { state } = reduce(initialState({ ...typed, focus: 'plan' }), { type: 'inputPrefilled', text: 'x', sessionId: 'session-1' });

    expect(state.focus).toBe('chat');
  });

  it('leaves a session the user has since left alone', () => {
    const from = initialState({ ...typed, sessionId: 'session-2' });

    expect(reduce(from, { type: 'inputPrefilled', text: 'x', sessionId: 'session-1' }).state).toEqual(from);
  });
});

describe('/compact', () => {
  it('condenses the current session and shows the planner as busy until it answers', () => {
    const { state, effects } = run('/compact', planned);

    expect(effects).toEqual([{ type: 'compactConversation', sessionId: 'session-1' }]);
    expect(state.planner).toBe('condensing');
    expect(chatActivity(state)?.label).toBe('Condensing…');
  });

  it('needs a session to condense', () => {
    const { effects, state } = run('/compact');
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/No active plan/);
  });

  it('waits for the planner while it is planning', () => {
    const planner = 'planning' as const;
    const { effects, state } = run('/compact', { ...planned, planner });
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/planner is still answering/);
  });

  it('is allowed while tasks execute', () => {
    expect(run('/compact', { ...planned, status: 'executing' }).effects).toEqual([{ type: 'compactConversation', sessionId: 'session-1' }]);
  });

  it('shows the summary entry as a compaction, not a spoken turn', () => {
    const history = [
      { role: 'assistant' as const, content: 'Conversation condensed: …\n\nGoal: a parser', timestamp: '2026-01-02T00:00:00Z', kind: 'compaction' as const },
      { role: 'user' as const, content: 'add CSV', timestamp: '2026-01-02T00:00:01Z' },
    ];

    const { state } = reduce(initialState(planned), { type: 'chatRestored', history, sessionId: 'session-1' });

    expect(state.conversation.blocks.map((b) => (b.type === 'message' ? [b.role, b.text] : b.type === 'compaction' ? ['compaction', b.summary] : [b.type]))).toEqual([
      ['compaction', 'Conversation condensed: …\n\nGoal: a parser'],
      ['user', 'add CSV'],
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TaskView, TuiState } from '../state';

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
  { index: 2, preview: 'JSON only', timestamp: '2026-01-01T00:00:02Z' },
  { index: 4, preview: 'Streaming', timestamp: '2026-01-01T00:00:04Z' },
];

const lastError = (state: TuiState) => state.messages.filter((m) => m.role === 'error').at(-1)?.content;

describe('/fork', () => {
  it('forks the current session', () => {
    expect(run('/fork', planned).effects).toEqual([{ type: 'forkConversation', sessionId: 'session-1' }]);
  });

  it('needs a session to fork', () => {
    const { effects, state } = run('/fork');
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/No active plan/);
  });

  it.each(['planning', 'researching'] as const)('waits for the planner while it is %s', (status) => {
    const { effects, state } = run('/fork', { ...planned, status });
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/planner is still answering/);
  });

  it('is allowed while tasks execute', () => {
    expect(run('/fork', { ...planned, status: 'executing' }).effects).toEqual([{ type: 'forkConversation', sessionId: 'session-1' }]);
  });
});

describe('switching to a fork', () => {
  it('adopts the fork as the current session, not running and not yet approved', () => {
    const from = initialState({ ...planned, status: 'executing', planApproved: true, busyLabel: 'running #1' });

    const { state } = reduce(from, { type: 'sessionForked', sessionId: 'session-2', goal: 'build me a parser' });

    expect(state.sessionId).toBe('session-2');
    expect(state.goal).toBe('build me a parser');
    expect(state.status).toBe('idle');
    expect(state.planApproved).toBe(false);
    expect(state.busyLabel).toBe('');
  });

  it('then ignores the original session\'s events', () => {
    const { state } = reduce(initialState(planned), { type: 'sessionForked', sessionId: 'session-2', goal: 'g' });

    const after = reduce(state, { type: 'taskStatus', taskId: 'task-1', status: 'in_progress', sessionId: 'session-1' });

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

  it('fills the open picker, most recent message first, and rewinds to the one chosen', () => {
    const { state } = run('/rewind', planned);

    const filled = reduce(state, { type: 'rewindTargetsLoaded', targets, sessionId: 'session-1' }).state;
    expect(filled.overlay?.kind === 'picker' && filled.overlay.picker.items.map((i) => i.label)).toEqual(['Streaming', 'JSON only']);

    const down = reduce(filled, { type: 'key', key: { name: 'down' } }).state;
    const chosen = reduce(down, { type: 'key', key: { name: 'enter' } });
    expect(chosen.state.overlay).toBeNull();
    expect(chosen.effects).toEqual([{ type: 'rewindConversation', sessionId: 'session-1', index: 2 }]);
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

  it('/rewind <n> rewinds straight to that message', () => {
    expect(run('/rewind 4', planned).effects).toEqual([{ type: 'rewindConversation', sessionId: 'session-1', index: 4 }]);
  });

  it.each(['abc', '-1', '2.5'])('refuses /rewind %s', (arg) => {
    const { effects, state } = run(`/rewind ${arg}`, planned);
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/Usage: \/rewind/);
  });

  it('waits for the planner while it is answering', () => {
    const { effects, state } = run('/rewind', { ...planned, status: 'planning' });
    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
    expect(lastError(state)).toMatch(/planner is still answering/);
  });

  it('is allowed while tasks execute', () => {
    expect(run('/rewind 4', { ...planned, status: 'executing' }).effects).toEqual([{ type: 'rewindConversation', sessionId: 'session-1', index: 4 }]);
  });
});

describe('/compact', () => {
  it('condenses the current session and shows the planner as busy until it answers', () => {
    const { state, effects } = run('/compact', planned);

    expect(effects).toEqual([{ type: 'compactConversation', sessionId: 'session-1' }]);
    expect(state.status).toBe('planning');
    expect(state.busyLabel).toMatch(/Condensing/);
  });

  it('needs a session to condense', () => {
    const { effects, state } = run('/compact');
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/No active plan/);
  });

  it.each(['planning', 'researching'] as const)('waits for the planner while it is %s', (status) => {
    const { effects, state } = run('/compact', { ...planned, status });
    expect(effects).toEqual([]);
    expect(lastError(state)).toMatch(/planner is still answering/);
  });

  it('is allowed while tasks execute', () => {
    expect(run('/compact', { ...planned, status: 'executing' }).effects).toEqual([{ type: 'compactConversation', sessionId: 'session-1' }]);
  });

  it('shows the summary entry as a system note, not a spoken turn', () => {
    const history = [
      { role: 'assistant' as const, content: 'Conversation condensed: …\n\nGoal: a parser', timestamp: '2026-01-02T00:00:00Z', kind: 'compaction' as const },
      { role: 'user' as const, content: 'add CSV', timestamp: '2026-01-02T00:00:01Z' },
    ];

    const { state } = reduce(initialState(planned), { type: 'chatRestored', history, sessionId: 'session-1' });

    expect(state.messages.map((m) => [m.role, m.content])).toEqual([
      ['system', 'Conversation condensed: …\n\nGoal: a parser'],
      ['user', 'add CSV'],
    ]);
  });

  it('does not repeat the summary when the daemon\'s notice arrives after the transcript was redrawn', () => {
    const summary = 'Conversation condensed: …\n\nGoal: a parser';
    const history = [{ role: 'assistant' as const, content: summary, timestamp: '2026-01-02T00:00:00Z', kind: 'compaction' as const }];
    let state = reduce(initialState(planned), { type: 'chatRestored', history, sessionId: 'session-1' }).state;

    state = reduce(state, { type: 'plannerMessage', content: summary, sessionId: 'session-1' }).state;

    expect(state.messages).toHaveLength(1);
  });
});

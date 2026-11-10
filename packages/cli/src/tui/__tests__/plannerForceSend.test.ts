import { describe, it, expect } from 'vitest';
import { fromTranscript } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { footerHints, helpLayout } from '../layout';
import { decodeKey } from '../keys';
import type { TaskLogState, TaskView, TuiState } from '../state';

/**
 * Send now in the planner chat (ADR-0023, F5): ctrl-s stops the planner turn
 * in flight and answers the composer text — or, with the composer empty, the
 * newest queued prompt — in the turn that replaces it. Turn-scoped: the run's
 * tasks are never touched, and the prompts still queued keep their order.
 */

const ctrlS = { type: 'key' as const, key: { name: 'ctrl-s' } };
const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });

const planning = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', planner: 'planning', ...over });

const withDraft = (state: TuiState, text: string): TuiState => ({
  ...state,
  editor: { ...state.editor, text, cursor: text.length },
});

// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const lastSaid = (state: TuiState) => state.conversation.blocks.at(-1);

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 2, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code',
  ...over,
});

const log = (queued: { id: string; text: string; forced?: boolean }[]): TaskLogState => ({
  taskId: 't1',
  view: {
    blocks: [{ type: 'message', id: 'b1', role: 'agent', text: 'Do the task', streaming: false }],
    nextId: 2,
    queued: queued.map((m) => ({ ...m, forced: m.forced ?? false })),
    working: true,
    streams: {},
  },
  attempts: [1],
  attempt: 1,
  pending: [],
  loaded: true,
  followLatest: true,
  queuedIndex: 0,
});

describe('ctrl-s in the planner chat', () => {
  it('decodes from the byte a terminal sends', () => {
    expect(decodeKey('\x13').name).toBe('ctrl-s');
  });

  it('force sends the composer text and empties the composer', () => {
    const { state, effects } = reduce(withDraft(planning(), '  stop, use Postgres '), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'stop, use Postgres' }]);
    expect(state.editor.text).toBe('');
  });

  it('force sends when the session reports a planner turn started by another client', () => {
    const idle = initialState({ sessionId: 's1', planner: 'idle' });
    const busy = reduce(idle, { type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_started', turnId: 'remote', prompt: 'Research the repository' } }).state;
    expect(reduce(withDraft(busy, 'Answer this first'), ctrlS).effects).toEqual([
      { type: 'forceSendPlannerMessage', sessionId: 's1', message: 'Answer this first' },
    ]);
  });

  it('settles the force-send request for a turn started by another client', () => {
    const idle = initialState({ sessionId: 's1', planner: 'idle' });
    const busy = reduce(idle, { type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_started', turnId: 'remote', prompt: 'Research the repository' } }).state;
    const sent = reduce(withDraft(busy, 'Answer this first'), ctrlS).state;
    const settled = reduce(sent, { type: 'planUpdated', plan: {}, sessionId: 's1' }).state;
    expect(settled.forceSendPending).toBeNull();
    expect(settled.planner).toBe('idle');
  });

  it('force sends the newest queued prompt when the composer is empty, keeping the rest in order', () => {
    const { state, effects } = reduce(planning({ queuedPrompts: ['one', 'two'] }), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'two' }]);
    expect(state.queuedPrompts).toEqual(['one']);
  });

  it('prefers the composer text over the queued prompts', () => {
    const { state, effects } = reduce(withDraft(planning({ queuedPrompts: ['one', 'two'] }), 'this one'), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'this one' }]);
    expect(state.queuedPrompts).toEqual(['one', 'two']);
  });

  it('is a plain send when no turn is running', () => {
    const { state, effects } = reduce(withDraft(planning({ planner: 'idle' }), 'use bcrypt'), ctrlS);
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'use bcrypt' }]);
    expect(state.editor.text).toBe('');
  });

  it('runs a TUI command in the composer as enter does, rather than sending it to the planner', () => {
    const { state, effects } = reduce(withDraft(planning(), '/stop'), ctrlS);
    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 's1' }]);
    expect(state.forceSendPending).toBeNull();
  });

  it('still force sends a slash line that is not a TUI command, for the planner to resolve', () => {
    const { effects } = reduce(withDraft(planning(), '/some-skill with args'), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendPlannerMessage', sessionId: 's1', message: '/some-skill with args' }]);
  });

  it('says what to do when there is nothing to send', () => {
    const { state, effects } = reduce(planning(), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: expect.stringMatching(/type a message, or queue one/) });
  });
});

describe('the queue across a stop', () => {
  it('keeps the held prompts when the stopped turn was a force send', () => {
    const sent = reduce(withDraft(planning({ queuedPrompts: ['one', 'two'] }), 'now'), ctrlS).state;
    const { state, effects } = reduce(sent, { type: 'failed', message: 'The planner turn was stopped.', code: 'planner_turn_stopped', turn: true });

    expect(state.queuedPrompts).toEqual(['one', 'two']);
    expect(state.planner).toBe('planning');
    expect(effects).toEqual([]);
  });

  it('keeps the held prompts when the turn a force send stopped settles with what it had said', () => {
    const sent = reduce(withDraft(planning({ queuedPrompts: ['one', 'two'] }), 'now'), ctrlS).state;
    const stopped = reduce(sent, { type: 'planUpdated', plan: {}, sessionId: 's1' });

    expect(stopped.effects).toEqual([]);
    expect(stopped.state.queuedPrompts).toEqual(['one', 'two']);
    expect(stopped.state.planner).toBe('planning');

    const forced = reduce(stopped.state, { type: 'planUpdated', plan: {}, sessionId: 's1' });
    expect(forced.effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'one' }]);
    expect(forced.state.queuedPrompts).toEqual(['two']);
  });

  it('shows the error and puts the composer text back when the forced send itself failed', () => {
    const sent = reduce(withDraft(planning(), 'use Postgres'), ctrlS).state;
    expect(sent.editor.text).toBe('');

    const { state, effects } = reduce(sent, { type: 'failed', message: 'connect ECONNREFUSED', turn: true });

    expect(state.editor.text).toBe('use Postgres');
    expect(lastSaid(state)).toMatchObject({ role: 'error', text: 'connect ECONNREFUSED' });
    expect(state.planner).toBe('idle');
    expect(effects).toEqual([]);
  });

  it('keeps what was typed since above the restored composer text', () => {
    const sent = reduce(withDraft(planning(), 'use Postgres'), ctrlS).state;
    const { state } = reduce(withDraft(sent, 'and also'), { type: 'failed', message: 'nope', code: 'refused', turn: true });

    expect(state.editor.text).toBe('use Postgres\nand also');
  });

  it('puts a force-sent queued prompt back at its position when the send failed', () => {
    const sent = reduce(planning({ queuedPrompts: ['one', 'two', 'three'] }), ctrlS).state;
    expect(sent.queuedPrompts).toEqual(['one', 'two']);

    const { state, effects } = reduce(sent, { type: 'failed', message: 'nope', code: 'session_not_found', turn: true });

    // The turn dying is a turn ending, so the oldest prompt goes out as it does after any failure.
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'one' }]);
    expect(state.queuedPrompts).toEqual(['two', 'three']);
    expect(lastSaid(state)).toMatchObject({ role: 'user', text: 'one' });
  });

  it('still returns the queue to the input on a user stop', () => {
    const state = withDraft(planning({ queuedPrompts: ['one', 'two'] }), '/stop');
    const { state: stopped, effects } = reduce(state, key('enter'));

    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 's1' }]);
    expect(stopped.queuedPrompts).toEqual([]);
    expect(stopped.editor.text).toBe('one\ntwo');
  });
});

describe('what the planner chat shows for force send', () => {
  it('names ctrl-s on the queued prompt, the hint dropping first at a narrow width', () => {
    const state = planning({ queuedPrompts: ['a parked thought'], cols: 200 });
    const row = plain(state).split('\n').find((line) => line.includes('a parked thought')) ?? '';
    expect(row).toContain('queued · esc to unsend · ctrl-s sends now');

    const narrow = planning({ queuedPrompts: ['a parked thought'], cols: 50 });
    const narrowRow = plain(narrow).split('\n').find((line) => line.includes('a parked thought')) ?? '';
    expect(narrowRow).toContain('a parked thought');
    expect(narrowRow).not.toContain('ctrl-s sends now');
  });

  it('puts the queued hints on the newest prompt only, the one esc and ctrl-s take', () => {
    const out = plain(planning({ queuedPrompts: ['first thought', 'second thought'], cols: 200 }));
    expect(out).toMatch(/first thought · queued(?! ·)/);
    expect(out).toContain('second thought · queued · esc to unsend · ctrl-s sends now');
  });

  it('drops ctrl-s from the newest prompt while the composer holds text, which ctrl-s would send instead', () => {
    const out = plain(withDraft(planning({ queuedPrompts: ['a parked thought'], cols: 200 }), 'typing'));
    expect(out).toMatch(/a parked thought · queued · esc to unsend(?! ·)/);
  });

  it('marks the forced user message, from a reloaded transcript too', () => {
    const conversation = fromTranscript(
      [{ role: 'user', content: 'use Postgres instead', timestamp: '2026-10-13T00:00:00.000Z', forced: true }],
      [], undefined, [],
    );
    const out = plain(initialState({ sessionId: 's1', rows: 24, cols: 120, conversation }));
    expect(out).toContain('use Postgres instead · sent now');
  });

  it('names ctrl-s in the chat footer while a turn is in flight', () => {
    expect(footerHints(planning())).toContain('ctrl-s send now');
    expect(footerHints(planning({ planner: 'idle' }))).not.toContain('ctrl-s send now');
  });

  it('documents ctrl-s for the planner in the help sheet', () => {
    // eslint-disable-next-line no-control-regex
    const sheet = helpLayout(200, 200).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(sheet.some((line) => line.includes('ctrl-s sends now') && line.includes('planner'))).toBe(true);
  });
});

describe('what the task view shows for force send', () => {
  it('names Esc and send-all on the newest queued row, ctrl-r on the picked one, and sending now once forced', () => {
    const state = initialState({
      sessionId: 's1', rows: 30, cols: 200, tasks: [task()],
      taskView: log([{ id: 'm1', text: 'use Postgres' }, { id: 'm2', text: 'stop now', forced: true }]),
    });
    const out = plain(state);
    expect(out).toContain('use Postgres · queued · esc takes back · ctrl-s sends all now · ctrl-r removes');
    expect(out).toContain('stop now · sending now…');
  });
});


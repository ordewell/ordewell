import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action } from '../reducer';
import { createInbound } from '../inbound';
import type { WsEvent } from '../../apiClient';
import { lastMessage } from './chat';

describe('a call at the command seam, from the daemon (ADR-0029)', () => {
  const wire: unknown = {
    type: 'execution_action',
    record: { command: 'stop_task', actor: 'planner-turn', task: { id: 't2', ref: '#2', title: 'Add the cache' }, outcome: 'done', at: '2026-10-11T10:00:00.000Z' },
    text: 'The planner stopped task #2 "Add the cache".',
    stream: 'd1',
    seq: 4,
  };

  it('is a line in the conversation, shown once whichever socket delivers it', () => {
    const actions: Action[] = [];
    const { receive } = createInbound((action) => actions.push(action), 's1');
    receive(wire as WsEvent);
    // A reconnect's socket that overlaps the one it replaces.
    receive(wire as WsEvent);

    const state = actions.reduce((s, action) => reduce(s, action).state, initialState({ sessionId: 's1' }));

    expect(actions).toHaveLength(1);
    expect(lastMessage(state)).toMatchObject({ role: 'system', text: 'The planner stopped task #2 "Add the cache".' });
  });
});

describe('the user\'s own Merge all, from the daemon', () => {
  const merged: unknown = {
    type: 'execution_action',
    record: { command: 'merge_all', actor: 'user', outcome: 'done', at: '2026-10-11T10:00:00.000Z' },
    text: 'You merged the run\'s work into your branch.',
    stream: 'd1',
    seq: 5,
  };

  // The merge's own notice ("Merged … into your checked-out branch.") is its one line: a second announcing it read as the merge twice.
  it('adds no line of its own to the conversation', () => {
    const actions: Action[] = [];
    const { receive } = createInbound((action) => actions.push(action), 's1');
    receive(merged as WsEvent);

    const state = actions.reduce((s, action) => reduce(s, action).state, initialState({ sessionId: 's1' }));

    expect(JSON.stringify(state.conversation)).not.toContain('You merged the run\'s work into your branch.');
  });
});

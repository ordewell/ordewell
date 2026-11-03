import { describe, it, expect } from 'vitest';
import type { WsEvent } from '../../apiClient';
import type { Action } from '../reducer';
import { forgetInbound, inboundFor } from '../inbound';

/**
 * What one session's inbound subscriptions have already delivered is held per
 * client and session; a session the TUI is done with must not stay there for
 * the life of the process.
 */
describe('forgetting a session\'s inbound state', () => {
  const turn = { type: 'planner_turn_started', turnId: 't1', stream: 's', seq: 1 } as WsEvent;
  it('lets a forgotten session start clean instead of growing a map entry forever', () => {
    const api = {};
    const actions: Action[] = [];
    const dispatch = (action: Action): void => { actions.push(action); };

    const first = inboundFor(api, dispatch, 's1');
    first.planning()(turn);
    // The same broadcast on a second socket is a copy, not a new turn.
    first.planning()(turn);
    expect(actions).toHaveLength(1);

    forgetInbound(api, 's1');
    const reopened = inboundFor(api, dispatch, 's1');
    reopened.planning()(turn);
    expect(actions).toHaveLength(2);
  });
});

describe('a socket held on a plan', () => {
  const children = [{ sessionId: 'child', node: 'root/1', parent: 's1', title: 'Delegated', depth: 1, state: 'working' }];

  function subscribed() {
    const api = {};
    const actions: Action[] = [];
    return { actions, onEvent: inboundFor(api, (action) => { actions.push(action); }, 's1').planning() };
  }

  it('takes the tree of its own plan', () => {
    const { actions, onEvent } = subscribed();

    onEvent({ type: 'child_tree', sessionId: 's1', children } as WsEvent);

    expect(actions).toEqual([{ type: 'childTree', sessionId: 's1', children }]);
  });

  it('drops a tree that is another plan\'s: a depth-1 subplanner\'s must not replace the root\'s', () => {
    const { actions, onEvent } = subscribed();

    onEvent({ type: 'child_tree', sessionId: 'other', children } as WsEvent);

    expect(actions).toEqual([]);
  });

  it('names the plan a notice came from, so a parent\'s word does not land on the child on screen', () => {
    const { actions, onEvent } = subscribed();

    onEvent({ type: 'notice', message: 'Heads up.', level: 'info' } as WsEvent);

    expect(actions).toEqual([{ type: 'notice', message: 'Heads up.', level: 'info', sessionId: 's1' }]);
  });
});

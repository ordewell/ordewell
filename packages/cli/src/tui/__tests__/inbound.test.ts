import { describe, it, expect } from 'vitest';
import type { WsEvent } from '../../apiClient';
import { initialState, reduce, type Action } from '../reducer';
import { lastMessage } from './chat';
import { createInbound } from '../inbound';
import { sessionLink, type LinkDeps } from '../sessionLink';

/**
 * What one session's inbound stream has already delivered is held per client
 * and session; a session the TUI is done with must not stay there for the life
 * of the process.
 */
describe('forgetting a session\'s inbound state', () => {
  const turn = { type: 'planner_turn_started', turnId: 't1', stream: 's', seq: 1 } as WsEvent;
  it('lets a forgotten session start clean instead of growing a map entry forever', async () => {
    const actions: Action[] = [];
    const handlers: ((event: WsEvent) => void)[] = [];
    const api = {
      followSession: (_id: string, onEvent: (event: WsEvent) => void) => {
        handlers.push(onEvent);
        return { ready: Promise.resolve(true), ended: new Promise<null>(() => {}), close: () => {} };
      },
    } as unknown as LinkDeps['api'];
    const deps: LinkDeps = { api, dispatch: (action) => { actions.push(action); } };

    await sessionLink(deps, 's1').ensure();
    handlers[0]!(turn);
    // The same stamped frame again is a copy, not a new turn.
    handlers[0]!(turn);
    expect(actions).toHaveLength(1);

    sessionLink(deps, 's1').close();
    await sessionLink(deps, 's1').ensure();
    handlers[1]!(turn);
    expect(actions).toHaveLength(2);
  });
});

describe('a socket held on a plan', () => {
  const children = [{ sessionId: 'child', node: 'root/1', parent: 's1', title: 'Delegated', depth: 1, state: 'working' }];

  function subscribed() {
    const actions: Action[] = [];
    return { actions, onEvent: createInbound((action) => { actions.push(action); }, 's1').receive };
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

  it('shows a task that could not start signed out with its way in, as the daemon worded it', () => {
    const { actions, onEvent } = subscribed();
    const said = 'Failed to start task "One": Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.';

    onEvent({ type: 'notice', message: said, level: 'error' } as WsEvent);
    const state = actions.reduce((s, action) => reduce(s, action).state, initialState({ sessionId: 's1' }));

    expect(lastMessage(state)).toMatchObject({ role: 'error', text: said });
  });
});

describe('a merge the socket carries', () => {
  it('hands on who made it: an automatic merge says why it ran', () => {
    const actions: Action[] = [];
    const onEvent = createInbound((action) => { actions.push(action); }, 's1').receive;
    const result = { outcome: 'merged' as const };

    onEvent({ type: 'isolation_merge', result, trigger: { kind: 'gate', taskId: 't1' } } as WsEvent);
    onEvent({ type: 'isolation_merge', result } as WsEvent);

    expect(actions).toEqual([
      { type: 'isolationMerged', result, trigger: { kind: 'gate', taskId: 't1' }, sessionId: 's1' },
      { type: 'isolationMerged', result, sessionId: 's1' },
    ]);
  });
});

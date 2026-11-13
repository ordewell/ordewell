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
      { type: 'runMessage', message: { type: 'isolation_merge', result, trigger: { kind: 'gate', taskId: 't1' } }, sessionId: 's1' },
      { type: 'runMessage', message: { type: 'isolation_merge', result }, sessionId: 's1' },
    ]);
  });
});

describe('a session opened from a read', () => {
  const view = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
  const status = (seq: number) => ({ type: 'status_update', tasks: [], stream: 'd', seq }) as WsEvent;
  const approvals = [{ id: 'a1' }] as never;

  function opened() {
    const actions: Action[] = [];
    const inbound = createInbound((action) => { actions.push(action); }, 's1');
    return { actions, inbound, types: () => actions.map((a) => a.type) };
  }

  it('draws the read first and what came after it on top, dropping what the read already holds', async () => {
    const { inbound, types } = opened();
    const drawn: string[] = [];

    const loading = inbound.openFrom(async () => ({
      position: { stream: 'd', seq: 5 },
      apply: () => { drawn.push(`read after ${types().length} dispatched`); },
    }));
    inbound.receive(status(4));
    inbound.receive(status(6));
    await loading;

    expect(drawn).toEqual(['read after 0 dispatched']);
    expect(types()).toEqual(['runMessage']);
  });

  it('keeps the approvals of a greeting the read covers, which no read returns', async () => {
    const { actions, inbound } = opened();

    const loading = inbound.openFrom(async () => ({ position: { stream: 'd', seq: 9 }, run: view as never, apply: () => {} }));
    inbound.receive({ type: 'run_snapshot', sessionId: 's1', view, approvals, stream: 'd', seq: 8 } as WsEvent);
    await loading;

    expect(actions).toEqual([{ type: 'runSnapshot', view, approvals, sessionId: 's1' }]);
  });

  it('says the tree and the quota once the session is on screen, not before the read draws it', async () => {
    const { inbound, types } = opened();
    const order: string[] = [];

    const loading = inbound.openFrom(async () => ({ apply: () => { order.push(`read (${types().join(',')})`); } }));
    inbound.receive({ type: 'child_tree', sessionId: 's1', children: [] } as WsEvent);
    await loading;

    expect(order).toEqual(['read ()']);
    expect(types()).toEqual(['childTree']);
  });

  it('rejects with the read\'s failure and draws nothing from it', async () => {
    const { inbound, types } = opened();

    const loading = inbound.openFrom(async () => { throw new Error('session gone'); });
    inbound.receive(status(1));

    await expect(loading).rejects.toThrow('session gone');
    expect(types()).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { SurfacePlan } from '@ordewell/core';
import type { WsEvent } from '../../apiClient';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { createInbound } from '../inbound';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import { chatOf, messagesOf } from './chat';

/**
 * A follow socket that blipped misses broadcasts the daemon sent meanwhile. The
 * stream's numbering says so, and the conversation is read back (ADR-0017) —
 * whether or not a turn of this surface's own is out to reconcile it.
 */
const started = (seq: number, stream = 's'): WsEvent => ({ type: 'planner_turn_started', turnId: `t${seq}`, stream, seq }) as WsEvent;

function followed() {
  const actions: Action[] = [];
  const onEvent = createInbound((action) => { actions.push(action); }, 's1').receive;
  return { actions, onEvent, gaps: () => actions.filter((a) => a.type === 'streamGap') };
}

describe('a follow subscription whose numbers skip', () => {
  it('reports the gap once, when the numbers jump', () => {
    const { onEvent, gaps } = followed();
    onEvent(started(1));
    onEvent(started(2));
    expect(gaps()).toEqual([]);

    onEvent(started(5));
    expect(gaps()).toEqual([{ type: 'streamGap', sessionId: 's1' }]);

    onEvent(started(6));
    expect(gaps()).toHaveLength(1);
  });

  it('is no gap when the first frame is not number one: nothing was held to miss it from', () => {
    const { onEvent, gaps } = followed();
    onEvent(started(40));
    expect(gaps()).toEqual([]);
  });

  it('is no gap when a late copy fills in a number a newer socket jumped over', () => {
    const { onEvent, gaps } = followed();
    onEvent(started(1));
    onEvent(started(3));
    expect(gaps()).toHaveLength(1);
    onEvent(started(2));
    expect(gaps()).toHaveLength(1);
  });

  it('reports a restarted daemon, whose numbering means nothing against the last one', () => {
    const { onEvent, gaps } = followed();
    onEvent(started(3));
    onEvent(started(1, 'other'));
    expect(gaps()).toHaveLength(1);
  });

  it('reports a snapshot past everything delivered, as a reconnect greets', () => {
    const { onEvent, gaps } = followed();
    onEvent(started(1));
    onEvent({ type: 'run_snapshot', sessionId: 's1', view: { tasks: [] }, stream: 's', seq: 4 } as unknown as WsEvent);
    expect(gaps()).toHaveLength(1);
  });
});

describe('the TUI on a gap', () => {
  it('reads the conversation back when no turn of its own is out', () => {
    const idle = initialState({ sessionId: 's1' });
    expect(reduce(idle, { type: 'streamGap', sessionId: 's1' }).effects).toEqual([{ type: 'resyncConversation', sessionId: 's1' }]);
  });

  it('leaves it to the turn\'s own settling while one is out, and to another session', () => {
    expect(reduce(initialState({ sessionId: 's1', planner: 'planning' }), { type: 'streamGap', sessionId: 's1' }).effects).toEqual([]);
    expect(reduce(initialState({ sessionId: 's1' }), { type: 'streamGap', sessionId: 'other' }).effects).toEqual([]);
  });

  it('redraws what it missed from the daemon\'s transcript', async () => {
    let state = initialState({ sessionId: 's1', conversation: chatOf(['user', 'build a parser']) });
    const plan = { tasks: [], conversationHistory: [
      { role: 'user', content: 'build a parser' },
      { role: 'assistant', content: 'Here is the plan.' },
    ] } as unknown as SurfacePlan;
    const pending: Promise<void>[] = [];
    const deps = {
      api: { getSession: vi.fn().mockResolvedValue({ plan }) } as unknown as OrdewellApi,
      workspace: '/ws',
      dispatch: (action: Action) => {
        const step = reduce(state, action);
        state = step.state;
        for (const effect of step.effects as Effect[]) if (effect.type === 'resyncConversation') pending.push(runEffect(effect, deps));
      },
    } as unknown as EffectDeps;

    deps.dispatch({ type: 'streamGap', sessionId: 's1' });
    await Promise.all(pending);

    expect(messagesOf(state).map((m) => m.text)).toEqual(['build a parser', 'Here is the plan.']);
  });
});

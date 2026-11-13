import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { createInbound } from '../inbound';
import type { TaskView, TuiState } from '../state';
import type { Action } from '../reducer';
import type { WsEvent } from '../../apiClient';

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai', status: 'awaiting_user', dependencies: [], assignedRunner: 'claude-code', ...over,
});

// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const planState = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 20, cols: 180, focus: 'plan', ...over });

describe('what an awaiting task waits on, on its row', () => {
  it.each([
    ['input', 'waiting for your input'],
    ['checkpoint', 'checkpoint'],
    ['conflict', 'merge conflict'],
  ] as const)('%s reads "%s"', (awaitingReason, label) => {
    expect(plain(planState({ tasks: [task({ awaitingReason })] }))).toContain(`${label} · claude-code`);
  });

  it('shows none for a wait with no saved reason', () => {
    const out = plain(planState({ tasks: [task()] }));
    expect(out).not.toContain('waiting for your input');
    expect(out).not.toContain('checkpoint');
  });
});

describe('the reason, from the daemon', () => {
  it('is taken from each status update, and dropped once the task stops waiting', () => {
    const base = initialState({ sessionId: 's1', tasks: [task({ status: 'in_progress' })] });
    const waiting = reduce(base, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 't1', status: 'awaiting_user', verdict: null, awaitingReason: 'input' }] }, sessionId: 's1' }).state;
    expect(waiting.tasks[0].awaitingReason).toBe('input');
    const resumed = reduce(waiting, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }] }, sessionId: 's1' }).state;
    expect(resumed.tasks[0].awaitingReason).toBeUndefined();
  });

  it('is read off the status_update message, and an unknown one is ignored', () => {
    const actions: Action[] = [];
    const receive = createInbound((action) => actions.push(action), 's1').receive;
    // As it comes off the wire, where nothing has checked the reason yet.
    const wire: unknown = {
      type: 'status_update',
      tasks: [
        { id: 't1', status: 'awaiting_user', verdict: null, awaitingReason: 'conflict' },
        { id: 't2', status: 'awaiting_user', verdict: null, awaitingReason: 'bogus' },
      ],
    };
    receive(wire as WsEvent);
    const base = initialState({ sessionId: 's1', tasks: [task({ id: 't1' }), task({ id: 't2' })] });
    const state = actions.reduce((s, action) => reduce(s, action).state, base);
    expect(state.tasks.find((t) => t.id === 't1')?.awaitingReason).toBe('conflict');
    expect(state.tasks.find((t) => t.id === 't2')?.awaitingReason).toBeUndefined();
  });

  it('comes with a loaded plan', () => {
    const { state } = reduce(initialState({ sessionId: 's1' }), {
      type: 'planUpdated',
      plan: { tasks: [{ id: 't1', order: 1, title: 'A', status: 'awaiting_user', awaitingReason: 'checkpoint' }] },
      sessionId: 's1',
    });
    expect(state.tasks[0]?.awaitingReason).toBe('checkpoint');
  });
});

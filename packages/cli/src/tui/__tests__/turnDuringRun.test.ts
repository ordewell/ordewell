import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action, type RunMessage } from '../reducer';
import { createInbound } from '../inbound';
import { chatActivity } from '../layout';
import { findTask, type TuiState } from '../state';
import type { WsEvent } from '../../apiClient';

/**
 * A planner turn and a run overlap: the user writes to the planner while tasks
 * run, and autorun starts a run inside the very turn that landed its plan.
 * Neither may end, hide or mark idle the other.
 */

const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a', order: 1, title: 'A', type: 'ai', status: 'pending', dependencies: [], ...over,
});

type StatusTasks = Extract<RunMessage, { type: 'status_update' }>['tasks'];

const apply = (state: TuiState, ...actions: Action[]): TuiState =>
  actions.reduce((s, action) => reduce(s, action).state, state);

const typed = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });

const running = (): TuiState => apply(
  initialState({ sessionId: 's1', rows: 30, cols: 100 }),
  { type: 'planUpdated', plan: { tasks: [task(), task({ id: 'b', order: 2, title: 'B' })] }, sessionId: 's1' },
  { type: 'runMessage', message: { type: 'task_started', taskId: 'a', order: 1, title: 'A', runner: 'claude-code' }, sessionId: 's1' },
);

const sentMidRun = (): TuiState => reduce(typed(running(), 'also add a README'), { type: 'key', key: { name: 'enter' } }).state;

describe('a planner turn sent while a run is going', () => {
  it('keeps "Planning…" through task status updates and run snapshots', () => {
    const turn = sentMidRun();
    expect(chatActivity(turn)?.label).toBe('Planning…');

    const updated = apply(turn, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 'a', status: 'in_progress', verdict: null }] as StatusTasks }, sessionId: 's1' });
    expect(chatActivity(updated)?.label).toBe('Planning…');

    const snapshotted = apply(updated, { type: 'runSnapshot', view: updated.run, sessionId: 's1' });
    expect(chatActivity(snapshotted)?.label).toBe('Planning…');
  });

  it('stops on a second Esc, leaving the run alone', () => {
    const updated = apply(sentMidRun(), { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 'a', status: 'in_progress', verdict: null }] as StatusTasks }, sessionId: 's1' });
    const armed = reduce(updated, { type: 'key', key: { name: 'escape' } }).state;
    const { effects } = reduce(armed, { type: 'key', key: { name: 'escape' } });

    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 's1' }]);
  });

  it('sends now on ctrl-s, interrupting the turn rather than queueing behind it', () => {
    const updated = apply(sentMidRun(), { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 'a', status: 'in_progress', verdict: null }] as StatusTasks }, sessionId: 's1' });
    const { effects } = reduce(typed(updated, 'use Markdown'), { type: 'key', key: { name: 'ctrl-s' } });

    expect(effects).toEqual([{ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'use Markdown' }]);
  });
});

describe('the run and the turn end on their own', () => {
  it('the run ending does not end a planner turn still out', () => {
    const queued = reduce(typed(sentMidRun(), 'and a CHANGELOG'), { type: 'key', key: { name: 'enter' } }).state;
    const { state, effects } = reduce(queued, { type: 'runMessage', message: { type: 'execution_complete', summary: { total: 2, completed: 2, failed: 0, blocked: 0, skipped: 0 } }, sessionId: 's1' });

    expect(state.status).toBe('idle');
    expect(chatActivity(state)?.label).toBe('Planning…');
    expect(state.queuedPrompts).toEqual(['and a CHANGELOG']);
    expect(effects).toEqual([]);
  });

  it('the turn ending does not mark a still-running run idle', () => {
    const turn = sentMidRun();
    const { state } = reduce(turn, { type: 'planUpdated', plan: { tasks: [task({ status: 'in_progress' }), task({ id: 'b', order: 2, title: 'B' })] }, sessionId: 's1' });

    expect(chatActivity(state)).toBeNull();
    expect(state.status).toBe('executing');
  });

  it('a failed turn does not mark a still-running run idle either', () => {
    const { state } = reduce(sentMidRun(), { type: 'failed', message: 'rate limited', turn: true });

    expect(chatActivity(state)).toBeNull();
    expect(state.status).toBe('executing');
  });
});

// Autorun starts the run inside the turn that landed the plan: the plan, the
// starts and the status updates all arrive while `converse` still awaits the
// turn's answer, on the session's socket.
describe('a run autorun starts inside the turn that landed its plan', () => {
  const planned = { tasks: [task(), task({ id: 'b', order: 2, title: 'B' })] };
  const wire = (event: Record<string, unknown>): WsEvent => event as unknown as WsEvent;

  const midTurn = (): { state: TuiState; effects: unknown[] } => {
    let state = reduce(typed(initialState({ sessionId: 's1', rows: 30, cols: 100 }), 'build it'), { type: 'key', key: { name: 'enter' } }).state;
    state = reduce(typed(state, 'and a README'), { type: 'key', key: { name: 'enter' } }).state;
    const effects: unknown[] = [];
    const { receive } = createInbound((action) => {
      const next = reduce(state, action);
      state = next.state;
      effects.push(...next.effects);
    }, 's1');

    receive(wire({ type: 'plan_generated', plan: planned, goal: 'build it', runners: ['claude-code'] }));
    receive(wire({ type: 'task_started', taskId: 'a', order: 1, title: 'A', runner: 'claude-code' }));
    receive(wire({ type: 'status_update', tasks: [{ id: 'a', status: 'in_progress', verdict: null, idleSince: '2026-10-14T09:00:00.000Z' }] }));
    return { state, effects };
  };

  it('shows the plan\'s tasks running while the turn is still out', () => {
    const { state } = midTurn();

    expect(state.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(findTask(state.tasks, 'a')?.status).toBe('in_progress');
    expect(state.status).toBe('executing');
  });

  it('holds the queued prompt until the turn settles', () => {
    const { state, effects } = midTurn();

    expect(chatActivity(state)?.label).toBe('Planning…');
    expect(state.queuedPrompts).toEqual(['and a README']);
    expect(effects).toEqual([]);
  });

  it('settles on the turn\'s own plan without duplicating or resetting the tasks', () => {
    const { state: mid } = midTurn();
    const returned = { tasks: [task({ status: 'in_progress' }), task({ id: 'b', order: 2, title: 'B' })] };
    const { state, effects } = reduce(mid, { type: 'planUpdated', plan: returned, sessionId: 's1' });

    expect(state.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(findTask(state.tasks, 'a')).toMatchObject({ status: 'in_progress', idleSince: '2026-10-14T09:00:00.000Z' });
    expect(state.status).toBe('executing');
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'and a README' }]);
  });
});


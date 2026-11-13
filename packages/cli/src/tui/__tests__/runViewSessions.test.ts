import { describe, it, expect } from 'vitest';
import { initialState, reduce, type RunMessage } from '../reducer';
import { findTask, type TuiState } from '../state';

/**
 * The run view belongs to one session's plan, and planner task ids repeat
 * across sessions (`task-1`), so nothing of the last session's run may show up
 * in the next one — whichever way the TUI got there.
 */

const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'task-1', order: 1, title: 'Old plan task', type: 'ai', status: 'pending', dependencies: [], ...over,
});

/** A session whose run holds a checkpoint, a merge gate and a continuable task. */
const oldRun = (): TuiState => {
  const planned = reduce(initialState({ sessionId: 'old', rows: 30, cols: 100 }), {
    type: 'planUpdated', plan: { tasks: [task()] }, sessionId: 'old',
  }).state;
  return reduce(planned, {
    type: 'runMessage',
    message: {
      type: 'status_update',
      tasks: [{
        id: 'task-1', status: 'awaiting_user', verdict: null, awaitingReason: 'checkpoint',
        checkpoint: 'Keep the old API?', continuable: true, mergeGate: ['task-0'], awaitingApproval: 2,
      }] as Extract<RunMessage, { type: 'status_update' }>['tasks'],
    },
    sessionId: 'old',
  }).state;
};

const newPlan = { tasks: [task({ title: 'New plan task' })] };

describe('a new session starts from an empty run', () => {
  it('shows no task of the previous plan once a cleared session starts again', () => {
    expect(oldRun().tasks).toHaveLength(1);
    const fresh = reduce(oldRun(), { type: 'sessionCleared' }).state;
    const started = reduce(fresh, { type: 'sessionStarted', sessionId: 'next', goal: 'again' }).state;
    expect(started.tasks).toEqual([]);
    expect(started.run.tasks).toEqual([]);
  });

  it('shows no task of the previous plan on sessionStarted over a live run', () => {
    const started = reduce(oldRun(), { type: 'sessionStarted', sessionId: 'next', goal: 'again' }).state;
    expect(started.tasks).toEqual([]);
  });

  it('does not hand a loaded session the old checkpoint, merge gate or continuable', () => {
    const started = reduce(oldRun(), { type: 'sessionStarted', sessionId: 'loaded', goal: 'g' }).state;
    const loaded = reduce(started, { type: 'planUpdated', plan: newPlan, sessionId: 'loaded' }).state;

    const t = findTask(loaded.tasks, 'task-1')!;
    expect(t.title).toBe('New plan task');
    expect(t.checkpoint).toBeUndefined();
    expect(t.mergeGate).toBeUndefined();
    expect(t.continuable).toBe(false);
    expect(t.awaitingApproval).toBeUndefined();
  });

  it('does not hand a fork the old run either', () => {
    const forked = reduce(oldRun(), { type: 'sessionForked', sessionId: 'fork', goal: 'g' }).state;
    expect(forked.tasks).toEqual([]);
    const planned = reduce(forked, { type: 'planUpdated', plan: newPlan, sessionId: 'fork' }).state;
    expect(findTask(planned.tasks, 'task-1')!.checkpoint).toBeUndefined();
  });

  it('empties the run on the new-session command', () => {
    const typed = { ...oldRun(), editor: { ...oldRun().editor, text: '/new', cursor: 4 } };
    const { state } = reduce(typed, { type: 'key', key: { name: 'enter' } });
    expect(state.overlay?.kind).toBe('confirm');
    const confirmed = reduce(state, { type: 'key', key: { name: 'enter' } }).state;
    expect(confirmed.run.tasks).toEqual([]);
    expect(confirmed.tasks).toEqual([]);
  });
});

describe('deleting a session', () => {
  it('leaves the deleted session the view was showing for a fresh one, as /new does', () => {
    const { state, effects } = reduce({ ...oldRun(), status: 'executing' }, { type: 'sessionDeleted', sessionId: 'old' });
    expect(state.sessionId).toBeNull();
    expect(state.tasks).toEqual([]);
    expect(state.status).toBe('idle');
    expect(effects).toEqual([{ type: 'closeSession', sessionId: 'old' }]);
  });

  it('keeps the view when another session was deleted', () => {
    const before = oldRun();
    const { state } = reduce(before, { type: 'sessionDeleted', sessionId: 'other' });
    expect(state).toBe(before);
  });
});

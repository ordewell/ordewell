import { describe, it, expect } from 'vitest';
import { createInbound } from '../inbound';
import type { WsEvent } from '../../apiClient';
import { initialState, reduce, type Action, type RunMessage } from '../reducer';
import { findTask, type TaskView, type TuiState } from '../state';

/**
 * The TUI folds core's run view, so a plan refresh keeps every status-only
 * field the stream reported. These pin the fields a field-by-field refresh
 * used to drop, and the run snapshot a socket is greeted with.
 */

const plan = (tasks: unknown[]): { tasks: unknown[] } => ({ tasks });

const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a', order: 1, title: 'A', type: 'ai', status: 'pending', dependencies: [], ...over,
});

const loaded = (tasks: unknown[]): TuiState =>
  reduce(initialState({ sessionId: 's1', rows: 30, cols: 100 }), { type: 'planUpdated', plan: plan(tasks), sessionId: 's1' }).state;

const status = (state: TuiState, tasks: unknown[]): TuiState =>
  reduce(state, { type: 'runMessage', message: { type: 'status_update', tasks: tasks as Extract<RunMessage, { type: 'status_update' }>['tasks'] }, sessionId: 's1' }).state;

describe('a plan refresh keeps what the status stream reported', () => {
  it('keeps the checkpoint card and continuable across a refresh', () => {
    // Task A waits at a checkpoint; the user then changes task B's model, so a
    // follow-up getSession lands as a plan refresh.
    const waiting = status(loaded([task(), task({ id: 'b', order: 2, title: 'B' })]), [
      { id: 'a', status: 'awaiting_user', verdict: null, awaitingReason: 'checkpoint', checkpoint: 'Keep the old API?', continuable: true },
    ]);

    const refreshed = reduce(waiting, {
      type: 'planUpdated',
      sessionId: 's1',
      plan: plan([task({ status: 'awaiting_user', awaitingReason: 'checkpoint' }), task({ id: 'b', order: 2, title: 'B' })]),
    }).state;

    const a = findTask(refreshed.tasks, 'a')!;
    expect(a.status).toBe('awaiting_user');
    expect(a.checkpoint).toBe('Keep the old API?');
    expect(a.awaitingReason).toBe('checkpoint');
    expect(a.continuable).toBe(true);
  });

  it('keeps the research mark from the plan and the stream (ADR-0037)', () => {
    const waiting = status(loaded([task({ research: true, readOnly: true })]), [
      { id: 'a', status: 'pending', verdict: null, research: true },
    ]);
    expect(findTask(waiting.tasks, 'a')).toMatchObject({ research: true });

    const refreshed = reduce(waiting, { type: 'planUpdated', sessionId: 's1', plan: plan([task({ research: true })]) }).state;
    expect(findTask(refreshed.tasks, 'a')).toMatchObject({ research: true });

    const started = status(refreshed, [{ id: 'a', status: 'in_progress', verdict: null, research: true }]);
    expect(findTask(started.tasks, 'a')).toMatchObject({ research: true });
  });

  it('keeps idleSince, approval count and a merge gate', () => {
    const running = status(loaded([task(), task({ id: 'b', order: 2, title: 'B' })]), [
      { id: 'a', status: 'in_progress', verdict: null, idleSince: '2026-10-13T09:05:00.000Z', awaitingApproval: 2, mergeGate: ['t0'] },
    ]);

    const refreshed = reduce(running, {
      type: 'planUpdated',
      sessionId: 's1',
      plan: plan([task({ status: 'in_progress' }), task({ id: 'b', order: 2, title: 'B' })]),
    }).state;

    const a = findTask(refreshed.tasks, 'a')!;
    expect(a.idleSince).toBe('2026-10-13T09:05:00.000Z');
    expect(a.awaitingApproval).toBe(2);
    expect(a.mergeGate).toEqual(['t0']);
  });

  it('keeps that a task waits for the user\'s approval to start across a plan refresh (ADR-0035)', () => {
    const waiting = status(loaded([task(), task({ id: 'b', order: 2, title: 'B' })]), [
      { id: 'b', status: 'pending', verdict: null, waitsForApproval: true },
    ]);

    const refreshed = reduce(waiting, { type: 'planUpdated', sessionId: 's1', plan: plan([task(), task({ id: 'b', order: 2, title: 'B' })]) }).state;

    expect(findTask(refreshed.tasks, 'b')!.waitsForApproval).toBe(true);
    expect(findTask(refreshed.tasks, 'a')!.waitsForApproval).toBeUndefined();
  });

  it('drops the checkpoint once the plan says the task no longer waits at it', () => {
    const waiting = status(loaded([task()]), [
      { id: 'a', status: 'awaiting_user', verdict: null, awaitingReason: 'checkpoint', checkpoint: 'Keep the old API?' },
    ]);

    const resumed = reduce(waiting, {
      type: 'planUpdated',
      sessionId: 's1',
      plan: plan([task({ status: 'in_progress' })]),
    }).state;

    expect(findTask(resumed.tasks, 'a')?.checkpoint).toBeUndefined();
  });
});

describe('a subtask start', () => {
  it('sets the subtask running, not only its top-level parent', () => {
    const parent = task({
      id: 'p', subtasks: [task({ id: 'p1', title: 'Child' })],
    });
    const started = reduce(loaded([parent]), { type: 'runMessage', message: { type: 'task_started', taskId: 'p1', order: 1, title: 'Child', runner: 'claude-code' }, sessionId: 's1' }).state;

    expect(findTask(started.tasks, 'p1')?.status).toBe('in_progress');
  });
});

describe('the connect snapshot', () => {
  it('is adopted whole when the socket greets the TUI', () => {
    const view = loaded([task({ id: 'x', status: 'in_progress' })]).run;

    const state = reduce(initialState({ sessionId: 's1' }), { type: 'runSnapshot', view, sessionId: 's1' }).state;

    expect(state.tasks.map((t: TaskView) => t.id)).toEqual(['x']);
    expect(state.tasks[0].status).toBe('in_progress');
  });

  it('is ignored when it names another session', () => {
    const view = loaded([task({ id: 'x' })]).run;

    const state = reduce(initialState({ sessionId: 's1' }), { type: 'runSnapshot', view, sessionId: 'other' }).state;

    expect(state.tasks).toEqual([]);
  });

  it('reaches the reducer from the socket frame', () => {
    const view = loaded([task({ id: 'x' })]).run;
    const actions: Action[] = [];
    const receive = createInbound((action) => actions.push(action), 's1').receive;

    receive({ type: 'run_snapshot', sessionId: 's1', view } as WsEvent);

    expect(actions).toEqual([{ type: 'runSnapshot', view, sessionId: 's1' }]);
  });

  it('is adopted again when a reconnect greets with the same view', () => {
    const view = loaded([task({ id: 'x' })]).run;
    const actions: Action[] = [];
    const inbound = createInbound((action) => actions.push(action), 's1');

    inbound.receive({ type: 'run_snapshot', sessionId: 's1', view } as WsEvent);
    inbound.receive({ type: 'run_snapshot', sessionId: 's1', view } as WsEvent);

    expect(actions.map((a) => a.type)).toEqual(['runSnapshot', 'runSnapshot']);
  });

  it('brings the status of a run the TUI joined mid-flight', () => {
    const view = loaded([task({ id: 'x', status: 'in_progress' })]).run;

    const state = reduce(initialState({ sessionId: 's1' }), { type: 'runSnapshot', view, sessionId: 's1' }).state;

    expect(state.status).toBe('executing');
  });
});

describe('a task edited elsewhere', () => {
  it('shows at once when another surface or the supervisor edits it', () => {
    const state = loaded([task(), task({ id: 'b', order: 2, title: 'B' })]);
    const actions: Action[] = [];
    createInbound((action) => actions.push(action), 's1').receive(
      { type: 'task_updated', taskId: 'b', changes: { title: 'B, renamed', assignedRunner: 'codex' } } as WsEvent,
    );

    const next = actions.reduce((current, action) => reduce(current, action).state, state);

    expect(findTask(next.tasks, 'b')).toMatchObject({ title: 'B, renamed', assignedRunner: 'codex' });
    expect(findTask(next.tasks, 'a')?.title).toBe('A');
  });
});

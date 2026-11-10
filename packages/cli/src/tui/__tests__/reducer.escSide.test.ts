import { describe, it, expect } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { emptyEditor } from '../editor';
import { initialState, reduce } from '../reducer';
import type { TaskLogState, TaskView, TuiState } from '../state';

// ESC belongs to the side the TAB selection is on: with a task chat open and a
// task expanded on the plan side, the focused pane backs out first.

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress',
  dependencies: [], assignedRunner: 'claude-code', attempted: true, ...over,
});

const loaded = (over: Partial<TaskLogState> = {}): TaskLogState => ({
  taskId: 't1',
  view: replayTaskLog([
    { type: 'turn_start', message: 'Do the task' },
    { type: 'text_delta', text: 'Hello from the runner.' },
    { type: 'turn_end', reason: 'completed' },
  ]),
  attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0,
  ...over,
});

const draft = (text: string) => ({ ...emptyEditor(), text, cursor: text.length });

const both = (over: Partial<TuiState> = {}): TuiState => initialState({
  sessionId: 's1',
  focus: 'plan',
  rows: 30,
  cols: 120,
  scroll: 4,
  tasks: [task({ subtasks: [task({ id: 'child', order: 1, title: 'Inspect greeting' })] })],
  expandedTaskId: 't1',
  taskView: loaded(),
  ...over,
});

const esc = (state: TuiState) => reduce(state, { type: 'key', key: { name: 'escape' } });

describe('ESC with a task chat open and a task expanded on the plan side', () => {
  describe('focus on the plan pane', () => {
    it('discards the prompt editor first and leaves the task chat as it was', () => {
      const before = both({ taskEditor: draft('edit me') });

      const after = esc(before).state;

      expect(after.taskEditor).toBeNull();
      expect(after.expandedTaskId).toBeNull();
      expect(after.taskView).toBe(before.taskView);
      expect(after.scroll).toBe(before.scroll);
      expect(after.focus).toBe('plan');
    });

    it('collapses the expansion when no editor is open, leaving the task chat as it was', () => {
      const before = both({ taskEditor: null, expandedTaskId: 't1' });

      const after = esc(before).state;

      expect(after.expandedTaskId).toBeNull();
      expect(after.taskView).toBe(before.taskView);
      expect(after.scroll).toBe(before.scroll);
      expect(after.focus).toBe('plan');
    });

    it('closes the task chat on the next ESC, with the cursor on that task', () => {
      const collapsed = esc(both({ taskEditor: null, expandedTaskId: 't1' })).state;

      const closed = esc(collapsed).state;

      expect(closed.taskView).toBeNull();
      expect(closed.focus).toBe('plan');
      expect(closed.selectedTask).toBe(0);
      expect(closed.expandedTaskId).toBeNull();
    });

    it('clears a draft first when nothing is open on the plan side', () => {
      const before = both({ taskEditor: null, expandedTaskId: null, editor: draft('half typed') });

      const cleared = esc(before).state;

      expect(cleared.editor.text).toBe('');
      expect(cleared.taskView).not.toBeNull();
      expect(esc(cleared).state.taskView).toBeNull();
    });
  });

  describe('focus on the chat pane', () => {
    it('clears a draft first and leaves the plan expansion untouched', () => {
      const before = both({ focus: 'chat', taskEditor: draft('edit me'), editor: draft('half typed') });

      const after = esc(before).state;

      expect(after.editor.text).toBe('');
      expect(after.taskView).not.toBeNull();
      expect(after.expandedTaskId).toBe('t1');
      expect(after.taskEditor?.text).toBe('edit me');
    });

    it('closes the task chat when there is no draft, leaving the plan expansion untouched', () => {
      const before = both({ focus: 'chat', taskEditor: null, expandedTaskId: 't1' });

      const closed = esc(before).state;

      expect(closed.taskView).toBeNull();
      expect(closed.focus).toBe('plan');
      expect(closed.selectedTask).toBe(0);
      expect(closed.expandedTaskId).toBe('t1');
    });
  });

  describe('while a planner turn is in flight', () => {
    it('lets the plan pane back out of what it opened instead of arming a stop', () => {
      const before = both({ taskEditor: draft('edit me'), planner: 'planning' });

      const after = esc(before).state;

      expect(after.expandedTaskId).toBeNull();
      expect(after.taskEditor).toBeNull();
      expect(after.planner).toBe('planning');
      expect(after.stopArmed).toBe(false);
    });

    it('does not commit a stop that was already armed', () => {
      const before = both({ taskEditor: null, expandedTaskId: 't1', planner: 'planning', stopArmed: true });

      const after = esc(before);

      expect(after.state.expandedTaskId).toBeNull();
      expect(after.state.planner).toBe('planning');
      expect(after.effects.some((e) => e.type === 'cancelPlanning')).toBe(false);
    });

    it('still lets the chat pane close its task view before arming a stop', () => {
      const before = both({ focus: 'chat', taskEditor: null, expandedTaskId: null, planner: 'planning' });

      const after = esc(before).state;

      expect(after.taskView).toBeNull();
      expect(after.planner).toBe('planning');
      expect(after.stopArmed).toBe(false);
    });
  });
});

// Queued messages come before the way back: Esc takes back the newest one the
// runner can still give up, and only an empty queue lets it leave.
describe('ESC with messages queued in a task chat', () => {
  const queued = (...events: TaskLogEvent[]): TuiState => both({
    focus: 'chat', taskEditor: null, expandedTaskId: null,
    taskView: loaded({
      view: replayTaskLog([
        { type: 'turn_start', message: 'Do the task' },
        { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
        { type: 'message_queued', messageId: 'm2', text: 'also tests' },
        ...events,
      ]),
      queuedIndex: null,
    }),
  });
  const removed = (state: TuiState, messageId: string): TuiState =>
    reduce(state, { type: 'taskLog', taskId: 't1', attempt: 1, sessionId: 's1', events: [{ type: 'message_removed', messageId }] }).state;
  const removals = (effects: readonly { type: string }[]) => effects.filter((e) => e.type === 'removeTaskMessage');

  it('removes the newest, then the other, then returns to the planner', () => {
    const typed = { ...queued(), editor: draft('half typed') };

    const first = esc(typed);
    expect(removals(first.effects)).toEqual([{ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm2' }]);
    expect(first.state.editor.text).toBe('half typed');
    expect(first.state.taskView).not.toBeNull();

    // A quick second Esc, before the daemon has said the first is gone, aims past it.
    const second = esc(first.state);
    expect(removals(second.effects)).toEqual([{ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }]);
    expect(second.state.editor.text).toBe('half typed');

    const gone = removed(removed(second.state, 'm2'), 'm1');
    expect(gone.taskView?.view.queued).toEqual([]);
    const cleared = esc(gone);
    expect(cleared.state.editor.text).toBe('');
    expect(cleared.state.taskView).not.toBeNull();

    const back = esc(cleared.state);
    expect(back.state.taskView).toBeNull();
    expect(back.state.focus).toBe('plan');
  });

  it('puts the newest in an empty composer, and the next one is dropped while that text is there', () => {
    const first = esc(queued());
    expect(removals(first.effects)).toEqual([{ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm2', filled: 'also tests' }]);
    expect(first.state.editor.text).toBe('also tests');
    expect(first.state.editor.cursor).toBe('also tests'.length);

    const second = esc(first.state);
    expect(removals(second.effects)).toEqual([{ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }]);
    expect(second.state.editor.text).toBe('also tests');
  });

  it('takes the text back out of the composer when the runner got the message first, and says so', () => {
    const first = esc(queued());
    const refusal = 'That message to task #1 "Build" was already delivered or taken back.';
    const kept = reduce(first.state, { type: 'taskMessageKept', sessionId: 's1', taskId: 't1', messageId: 'm2', filled: 'also tests', message: refusal }).state;
    expect(kept.editor.text).toBe('');
    expect(kept.taskView?.notice).toBe(refusal);
    // The message stays queued until the log says otherwise, and Esc may aim at it again.
    expect(removals(esc(kept).effects)).toEqual([{ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm2', filled: 'also tests' }]);

    // Text typed over the filled words is the person's own, and stays.
    const retyped = { ...first.state, editor: draft('also tests and docs') };
    const keptTyped = reduce(retyped, { type: 'taskMessageKept', sessionId: 's1', taskId: 't1', messageId: 'm2', filled: 'also tests', message: refusal }).state;
    expect(keptTyped.editor.text).toBe('also tests and docs');
  });

  it('passes over what the runner cannot give back: a handed-over or a forced message', () => {
    const held = queued(
      { type: 'message_handed_over', messageId: 'm2' },
      { type: 'message_queued', messageId: 'm3', text: 'stop now', forced: true },
    );
    expect(removals(esc(held).effects)).toEqual([{ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1', filled: 'use Postgres' }]);

    const nothing = queued({ type: 'message_handed_over', messageId: 'm1' }, { type: 'message_handed_over', messageId: 'm2' });
    expect(esc(nothing).state.taskView).toBeNull();
  });
});

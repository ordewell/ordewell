import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import type { PickerState, TaskView, TuiState } from '../state';

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));
const runSlash = (state: TuiState, text: string): Step =>
  reduce({ ...state, focus: 'chat', editor: { ...state.editor, text, cursor: text.length } }, key('enter'));

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1', order: 1, title: 'Setup', type: 'ai', status: 'pending',
    dependencies: [], assignedRunner: 'claude-code',
    ...over,
  };
}

const CHAIN: TaskView[] = [
  task(),
  task({ id: 't2', order: 2, title: 'Build', dependencies: ['t1'] }),
  task({ id: 't3', order: 3, title: 'Test', dependencies: ['t1', 't2'] }),
];

function planPane(over: Partial<TuiState> = {}): TuiState {
  return initialState({ sessionId: 's1', focus: 'plan', selectedTask: 0, tasks: CHAIN, ...over });
}

const pickerOf = (state: TuiState): PickerState => {
  if (state.overlay?.kind !== 'picker') throw new Error('no picker open');
  return state.overlay.picker;
};

describe('plan pane — remove (d)', () => {
  it('confirms before removing rather than acting on the keypress', () => {
    const asked = press(planPane({ selectedTask: 2 }), 'char', 'd');

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({
      kind: 'confirm',
      action: { kind: 'remove-task', taskId: 't3' },
    });
  });

  it('names the dependents that will silently lose the edge', () => {
    const asked = press(planPane({ selectedTask: 0 }), 'char', 'd').state;

    if (asked.overlay?.kind !== 'confirm') throw new Error('no confirm open');
    expect(asked.overlay.message).toContain('2 tasks depend on it');
    expect(asked.overlay.message).toContain('#2 Build');
    expect(asked.overlay.message).toContain('#3 Test');
  });

  it('agrees in number for a single dependent', () => {
    const asked = press(planPane({ selectedTask: 1 }), 'char', 'd').state;

    if (asked.overlay?.kind !== 'confirm') throw new Error('no confirm open');
    expect(asked.overlay.message).toContain('1 task depends on it');
  });

  it('removes on enter', () => {
    const asked = press(planPane({ selectedTask: 1 }), 'char', 'd').state;
    const confirmed = press(asked, 'enter');

    expect(confirmed.effects).toEqual([{ type: 'removeTask', sessionId: 's1', taskId: 't2' }]);
    expect(confirmed.state.overlay).toBeNull();
  });

  it('keeps the task on escape', () => {
    const asked = press(planPane({ selectedTask: 1 }), 'char', 'd').state;
    const cancelled = press(asked, 'escape');

    expect(cancelled.effects).toEqual([]);
    expect(cancelled.state.overlay).toBeNull();
  });
});

describe('plan pane — dependency picker (D)', () => {
  it('offers only the tasks that come before the selected one', () => {
    const picker = pickerOf(press(planPane({ selectedTask: 2 }), 'char', 'D').state);

    expect(picker.action).toEqual({ kind: 'set-task-deps', taskId: 't3' });
    expect(picker.items.map((i) => i.id)).toEqual(['t1', 't2']);
    expect(picker.multi).toBe(true);
  });

  it('starts from the dependencies the task already has', () => {
    const picker = pickerOf(press(planPane({ selectedTask: 2 }), 'char', 'D').state);

    expect(picker.chosen).toEqual(['t1', 't2']);
  });

  it('sends the toggled list on enter', () => {
    const open = press(planPane({ selectedTask: 2 }), 'char', 'D').state;
    const toggled = press(open, 'char', ' ').state;
    const chosen = press(toggled, 'enter');

    expect(chosen.effects).toEqual([expect.objectContaining({
      type: 'updateTask',
      sessionId: 's1',
      taskId: 't3',
      changes: { dependencies: ['t2'] },
    })]);
  });

  it('sends an empty list rather than treating "none selected" as a no-op', () => {
    const open = press(planPane({ selectedTask: 1 }), 'char', 'D').state;
    const cleared = press(open, 'char', ' ').state;

    expect(press(cleared, 'enter').effects).toEqual([expect.objectContaining({
      changes: { dependencies: [] },
    })]);
  });

  it('explains itself instead of opening an empty picker for the first task', () => {
    const attempted = press(planPane({ selectedTask: 0 }), 'char', 'D');

    expect(attempted.state.overlay).toBeNull();
    expect(attempted.state.messages.at(-1)?.content).toMatch(/no possible dependencies/i);
  });

  it('drops a stale dependency from the preselection rather than resending it', () => {
    // A dependency on a later task cannot be offered, so keeping it in `chosen`
    // would silently re-submit an edit the daemon rejects.
    const state = planPane({ selectedTask: 1, tasks: [CHAIN[0], task({ id: 't2', order: 2, title: 'Build', dependencies: ['t1', 't3'] }), CHAIN[2]] });

    expect(pickerOf(press(state, 'char', 'D').state).chosen).toEqual(['t1']);
  });

  it('opens from /task-deps with a task number', () => {
    const picker = pickerOf(runSlash(planPane(), '/task-deps 3').state);

    expect(picker.action).toEqual({ kind: 'set-task-deps', taskId: 't3' });
  });
});

describe('plan pane — add (a)', () => {
  it('asks for a title', () => {
    const asked = press(planPane(), 'char', 'a');

    expect(asked.state.overlay).toMatchObject({ kind: 'prompt', action: { kind: 'add-task' } });
  });

  it('adds the task on enter, leaving its assignment for the daemon to derive', () => {
    const asked = press(planPane(), 'char', 'a').state;
    const typed = 'Write docs'.split('').reduce((s, c) => press(s, 'char', c).state, asked);

    expect(press(typed, 'enter').effects).toEqual([
      { type: 'addTask', sessionId: 's1', title: 'Write docs' },
    ]);
  });

  it('adds nothing for an empty title', () => {
    const asked = press(planPane(), 'char', 'a').state;

    expect(press(asked, 'enter').effects).toEqual([]);
  });
});

describe('an expanded task edits its prompt, not its assignment', () => {
  // Every letter types into the open prompt, so the assignment keys are only
  // reachable once collapsed. The hint line says "then" for exactly that reason.
  it.each(['R', 'o', 'e', 'M', 'D', 'd', 'a'])('%s types instead of acting', (char) => {
    const expanded = press(planPane({ selectedTask: 1 }), 'enter').state;
    const after = press(expanded, 'char', char);

    expect(after.effects).toEqual([]);
    expect(after.state.overlay).toBeNull();
    expect(after.state.taskEditor!.text).toContain(char);
  });
});

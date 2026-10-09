import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import type { PickerState, TaskView, TuiState } from '../state';
import { lastMessage } from './chat';

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

function planPane(over: Partial<TuiState> = {}): TuiState {
  return initialState({
    sessionId: 's1', focus: 'plan', selectedTask: 0,
    tasks: [task({ skills: ['tdd'] }), task({ id: 't2', order: 2, title: 'Build' })],
    taskSkills: [
      { name: 'tdd', description: 'Test first' },
      { name: 'api-conventions', description: 'House API style' },
    ],
    ...over,
  });
}

const pickerOf = (state: TuiState): PickerState => {
  if (state.overlay?.kind !== 'picker') throw new Error('no picker open');
  return state.overlay.picker;
};

describe('task skills picker (K)', () => {
  it('offers every task skill with the attached ones chosen', () => {
    const p = pickerOf(press(planPane(), 'char', 'K').state);

    expect(p.multi).toBe(true);
    expect(p.items.map((i) => i.id)).toEqual(['tdd', 'api-conventions']);
    expect(p.chosen).toEqual(['tdd']);
  });

  it('keeps an attached skill the catalog does not list, so confirming does not detach it', () => {
    const state = planPane({ tasks: [task({ skills: ['made-by-earlier-task'] })] });

    expect(pickerOf(press(state, 'char', 'K').state).items).toContainEqual({ id: 'made-by-earlier-task', label: 'made-by-earlier-task (not found)', detail: 'not found in the catalog' });
  });

  it('offers unresolved attachments when the task skill catalog is empty', () => {
    const state = planPane({ taskSkills: [], tasks: [task({ skills: ['not-created'] })] });
    const picker = pickerOf(runSlash(state, '/task-skills 1').state);
    expect(picker.items.map((item) => item.label)).toEqual(['not-created (not found)']);
    expect(picker.chosen).toEqual(['not-created']);
  });

  it('commits the whole selection through updateTask on enter', () => {
    let state = press(planPane(), 'char', 'K').state;
    state = press(state, 'down').state;
    state = press(state, 'char', ' ').state;
    const done = press(state, 'enter');

    expect(done.state.overlay).toBeNull();
    expect(done.effects).toMatchObject([
      { type: 'updateTask', sessionId: 's1', taskId: 't1', changes: { skills: ['tdd', 'api-conventions'] } },
    ]);
  });

  it('clears every skill when nothing is chosen', () => {
    let state = press(planPane(), 'char', 'K').state;
    state = press(state, 'char', ' ').state;

    expect(press(state, 'enter').effects).toMatchObject([{ type: 'updateTask', changes: { skills: [] } }]);
  });

  it('says so when no task skills exist', () => {
    const asked = press(planPane({ taskSkills: [], tasks: [task()] }), 'char', 'K');

    expect(asked.state.overlay).toBeNull();
    expect(lastMessage(asked.state)!.text).toContain('No task skills found');
  });

  it('refuses a manual task', () => {
    const asked = press(planPane({ tasks: [task({ type: 'user' })] }), 'char', 'K');

    expect(asked.state.overlay).toBeNull();
    expect(lastMessage(asked.state)!.text).toContain('Manual tasks');
  });
});

describe('/task-skills', () => {
  it('opens the picker without a list', () => {
    expect(pickerOf(runSlash(planPane(), '/task-skills 1').state).title).toContain('Skills');
  });

  it('sets the named skills', () => {
    const done = runSlash(planPane(), '/task-skills 2 TDD,API-CONVENTIONS tdd');

    expect(done.effects).toMatchObject([
      { type: 'updateTask', taskId: 't2', changes: { skills: ['tdd', 'api-conventions'] } },
    ]);
  });

  it('clears with none', () => {
    expect(runSlash(planPane(), '/task-skills 1 none').effects).toMatchObject([
      { type: 'updateTask', taskId: 't1', changes: { skills: [] } },
    ]);
  });

  it('refuses a name that is not a task skill', () => {
    const done = runSlash(planPane(), '/task-skills 1 nope');

    expect(done.effects).toEqual([]);
    expect(lastMessage(done.state)!.text).toContain('No task skill named "nope"');
  });
});

describe('plan row', () => {
  it('lists attached skills compactly under the task', async () => {
    const { render } = await import('../render');
    const text = render(planPane({ cols: 160, tasks: [task({ skills: ['tdd', 'made-by-earlier-task'], subtasks: [task({ id: 's1', order: 1, title: 'Sub', skills: ['tdd'] })] })] }))
      .join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

    expect(text).toContain('skills: tdd · made-by-earlier-task');
  });
});

import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import type { PickerState, TaskView, TuiState } from '../state';

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai', status: 'pending',
    dependencies: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits',
    assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5' },
    ...over,
  };
}

function planPane(over: Partial<TuiState> = {}): TuiState {
  return initialState({
    sessionId: 's1',
    focus: 'plan',
    selectedTask: 0,
    tasks: [task()],
    runners: [
      { id: 'claude-code', name: 'Claude Code', enabled: true },
      { id: 'codex', name: 'Codex', enabled: true },
      { id: 'opencode', name: 'OpenCode', enabled: false },
    ],
    modesByRunner: {
      'claude-code': [{ id: 'default', label: 'Default', description: 'Ask before editing' }, { id: 'acceptEdits', label: 'Accept Edits', description: 'Edit freely' }],
      codex: [{ id: 'agent', label: 'Agent', description: 'Edit files' }, { id: 'plan', label: 'Plan', description: 'Read only' }],
    },
    ...over,
  });
}

const pickerOf = (state: TuiState): PickerState => {
  if (state.overlay?.kind !== 'picker') throw new Error('no picker open');
  return state.overlay.picker;
};

describe('plan pane — runner picker (R)', () => {
  it('opens on R with every installed runner, marking the task current one', () => {
    const picker = pickerOf(press(planPane(), 'char', 'R').state);

    expect(picker.action).toEqual({ kind: 'set-task-runner', taskId: 't1' });
    expect(picker.items.map((i) => i.id)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(picker.items.find((i) => i.id === 'claude-code')!.selected).toBe(true);
  });

  it('sends only the runner and lets the daemon derive model, effort and mode', () => {
    // The new runner's catalog lives server-side; sending a model picked here
    // would race the retarget and could name one the runner cannot spawn.
    const open = press(planPane(), 'char', 'R').state;
    const chosen = press(press(open, 'down').state, 'enter');

    expect(chosen.effects).toEqual([expect.objectContaining({
      type: 'updateTask',
      sessionId: 's1',
      taskId: 't1',
      changes: { assignedRunner: 'codex' },
    })]);
  });

  it('closes the overlay after choosing', () => {
    const open = press(planPane(), 'char', 'R').state;

    expect(press(press(open, 'down').state, 'enter').state.overlay).toBeNull();
  });

  it('refuses on a manual task, which no runner executes', () => {
    const state = planPane({ tasks: [task({ type: 'user' })] });

    const after = press(state, 'char', 'R').state;

    expect(after.overlay).toBeNull();
    expect(after.messages.at(-1)!.content).toMatch(/manual/i);
  });
});

describe('plan pane — mode picker (M)', () => {
  it('offers the modes of the task own runner', () => {
    const picker = pickerOf(press(planPane(), 'char', 'M').state);

    expect(picker.action).toEqual({ kind: 'set-task-mode', taskId: 't1' });
    expect(picker.items.map((i) => i.id)).toEqual(['default', 'acceptEdits']);
    expect(picker.items.find((i) => i.id === 'acceptEdits')!.selected).toBe(true);
  });

  it('offers a different runner modes when the task moved to it', () => {
    const state = planPane({ tasks: [task({ assignedRunner: 'codex', taskMode: 'plan' })] });

    const picker = pickerOf(press(state, 'char', 'M').state);

    expect(picker.items.map((i) => i.id)).toEqual(['agent', 'plan']);
    expect(picker.items.find((i) => i.id === 'plan')!.selected).toBe(true);
  });

  it('sends the chosen mode', () => {
    const open = press(planPane(), 'char', 'M').state;
    const chosen = press(open, 'enter');

    expect(chosen.effects).toEqual([expect.objectContaining({
      type: 'updateTask',
      sessionId: 's1',
      taskId: 't1',
      changes: { taskMode: 'default' },
    })]);
  });

  it('reports when the runner declares no modes rather than opening an empty picker', () => {
    const state = planPane({ tasks: [task({ assignedRunner: 'aider' })] });

    const after = press(state, 'char', 'M').state;

    expect(after.overlay).toBeNull();
    expect(after.messages.at(-1)!.content).toMatch(/no modes/i);
  });
});

describe('plan pane — new keys do not disturb the existing ones', () => {
  it('keeps lowercase f as start and lowercase m as mark-complete', () => {
    expect(press(planPane(), 'char', 'f').effects).toEqual([expect.objectContaining({ type: 'taskAction', action: 'force-start' })]);
    expect(press(planPane(), 'char', 'm').effects).toEqual([expect.objectContaining({ type: 'taskAction', action: 'complete' })]);
  });

  it('m on a completed task un-marks it — one key for both directions', () => {
    const done = planPane({ tasks: [task({ status: 'completed' })] });

    expect(press(done, 'char', 'm').effects).toEqual([expect.objectContaining({
      type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'uncomplete',
    })]);
  });
});

describe('/task-runner and /task-mode', () => {
  function runSlash(text: string, state: TuiState = planPane()): Step {
    return reduce({ ...state, editor: { ...state.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });
  }

  it('/task-runner with a runner assigns it directly', () => {
    const after = runSlash('/task-runner 1 codex', { ...planPane(), focus: 'chat' });

    expect(after.effects).toEqual([expect.objectContaining({
      type: 'updateTask', taskId: 't1', changes: { assignedRunner: 'codex' },
    })]);
  });

  it('/task-runner without a runner opens the picker', () => {
    const after = runSlash('/task-runner 1', { ...planPane(), focus: 'chat' });

    expect(pickerOf(after.state).action).toEqual({ kind: 'set-task-runner', taskId: 't1' });
  });

  it('/task-runner rejects a runner the daemon never reported', () => {
    const after = runSlash('/task-runner 1 nope', { ...planPane(), focus: 'chat' });

    expect(after.effects).toEqual([]);
    expect(after.state.messages.at(-1)!.content).toMatch(/nope/);
  });

  it('/task-mode with a mode assigns it directly', () => {
    const after = runSlash('/task-mode 1 default', { ...planPane(), focus: 'chat' });

    expect(after.effects).toEqual([expect.objectContaining({
      type: 'updateTask', taskId: 't1', changes: { taskMode: 'default' },
    })]);
  });

  it('/task-mode rejects a mode the task runner does not declare', () => {
    const after = runSlash('/task-mode 1 agent', { ...planPane(), focus: 'chat' });

    expect(after.effects).toEqual([]);
    expect(after.state.messages.at(-1)!.content).toMatch(/agent/);
  });
});

import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import { bodyRows, footerHints, planLayout } from '../layout';
import { planPaneWidth } from '../geometry';
import { stripAnsi } from '../ansi';
import type { TaskView, TuiState } from '../state';

/**
 * Subtask rows share the plan pane's one cursor (`selectedTask`), so they need
 * the same flattening in the reducer and the renderer or the two drift: the
 * renderer paints a subtask the cursor can never land on, or the reducer steps
 * past a row the pane shows. These pin the shared shape down.
 */

const press = (state: TuiState, name: string, char?: string): TuiState =>
  reduce(state, { type: 'key', key: { name, char } }).state;

/** The plan pane's own lines, unpainted and un-offset, so indentation reads. */
const planLines = (state: TuiState): string[] =>
  planLayout(state, bodyRows(state), planPaneWidth(state)).lines.map(stripAnsi);

const task = (over: Partial<TaskView>): TaskView => ({
  id: 't', order: 1, title: 'Task', type: 'ai', status: 'pending', dependencies: [], ...over,
});

const parent = task({
  id: 'p1', order: 1, title: 'Parent', subtasks: [
    task({ id: 's1', order: 1, title: 'First child' }),
    task({ id: 's2', order: 2, title: 'Second child' }),
  ],
});

const sibling = task({ id: 't2', order: 2, title: 'Sibling' });

const state = (over: Partial<TuiState> = {}): TuiState =>
  initialState({
    sessionId: 's1', rows: 20, cols: 80, focus: 'plan', tasks: [parent, sibling], ...over,
  });

describe('subtask rows in the plan pane', () => {
  it('renders indented dotted-order subtask lines under an expanded parent', () => {
    const lines = planLines(state({ expandedTaskId: 'p1' }));
    expect(lines.join('\n')).toContain(' 1  AI Parent');
    expect(lines.join('\n')).toContain('1.1  AI First child');
    expect(lines.join('\n')).toContain('1.2  AI Second child');
    const subLine = lines.find((l) => l.includes('1.1'))!;
    expect(subLine.startsWith('  ')).toBe(true);
    // The meta row under a subtask steps in with it, not back out to the
    // top-level indent.
    const subLineIndex = lines.findIndex((l) => l.includes('1.1'));
    const subMeta = lines.slice(subLineIndex + 1).find((l) => l.includes('default model'))!;
    expect(subMeta.startsWith('      ')).toBe(true);
  });

  it('omits subtask lines when the parent is collapsed', () => {
    const lines = planLines(state());
    expect(lines.join('\n')).not.toContain('1.1');
    expect(lines.join('\n')).not.toContain('First child');
    expect(lines.join('\n')).toContain(' 1  AI Parent');
  });
});

describe('arrow-key navigation over subtask rows', () => {
  it('steps onto each subtask row in turn and back out, without skipping or double-counting', () => {
    const open = state({ expandedTaskId: 'p1' });
    // Visible rows: p1, s1, s2, t2.
    const d1 = press(open, 'down');
    const d2 = press(d1, 'down');
    const d3 = press(d2, 'down');
    const u1 = press(d3, 'up');
    const u2 = press(u1, 'up');
    const u3 = press(u2, 'up');
    expect([d1.selectedTask, d2.selectedTask, d3.selectedTask, u1.selectedTask, u2.selectedTask, u3.selectedTask])
      .toEqual([1, 2, 3, 2, 1, 0]);
    // The parent stays expanded while navigating, or the rows would vanish
    // under the cursor mid-step.
    expect(d1.expandedTaskId).toBe('p1');
    expect(d2.expandedTaskId).toBe('p1');
  });

  it('clamps at the first and last visible row, subtasks included', () => {
    const open = state({ expandedTaskId: 'p1' });
    expect(press(open, 'up').selectedTask).toBe(0);
    const bottom = press(press(press(open, 'down'), 'down'), 'down');
    expect(bottom.selectedTask).toBe(3);
    expect(press(bottom, 'down').selectedTask).toBe(3);
  });

  it('navigates only the top-level rows when nothing is expanded', () => {
    const collapsed = state();
    expect(press(collapsed, 'down').selectedTask).toBe(1);
    expect(press(press(collapsed, 'down'), 'down').selectedTask).toBe(1);
  });

  it('keeps a subtask\'s own expansion visible so its prompt editor can open on it', () => {
    const open = state({ expandedTaskId: 'p1' });
    const onSubtask = press(press(open, 'down'), 'down');
    expect(onSubtask.selectedTask).toBe(2);
    const expanded = press(onSubtask, 'enter');
    expect(expanded.expandedTaskId).toBe('s2');
    // The parent must stay open, or the subtask row (and its editor) vanish.
    expect(planLines(expanded).join('\n')).toContain('1.2  AI Second child');
  });
});

describe('expanding a task with subtasks from a real key press', () => {
  it('enter reveals subtask rows without opening the prompt editor', () => {
    const expanded = press(state(), 'enter');
    expect(expanded.expandedTaskId).toBe('p1');
    expect(expanded.taskEditor).toBeNull();
    expect(planLines(expanded).join('\n')).toContain('1.1  AI First child');
  });

  it('down then navigates the cursor onto the revealed subtask row', () => {
    const expanded = press(state(), 'enter');
    const onFirstChild = press(expanded, 'down');
    expect(onFirstChild.selectedTask).toBe(1);
    expect(onFirstChild.expandedTaskId).toBe('p1');
    expect(onFirstChild.taskEditor).toBeNull();
  });

  it('a second enter on the still-selected parent opens its prompt editor', () => {
    const expanded = press(state(), 'enter');
    const edited = press(expanded, 'enter');
    expect(edited.expandedTaskId).toBe('p1');
    expect(edited.taskEditor?.text).toBe('Parent');
  });

  it('enter on a revealed subtask row opens that subtask\'s own prompt editor', () => {
    const expanded = press(state(), 'enter');
    const onFirstChild = press(expanded, 'down');
    const edited = press(onFirstChild, 'enter');
    expect(edited.expandedTaskId).toBe('s1');
    expect(edited.taskEditor?.text).toBe('First child');
  });

  it('typing a character while editing a subtask\'s prompt types into the draft, not a shortcut', () => {
    const editingSubtask = press(press(press(state(), 'enter'), 'down'), 'enter');
    const typed = press(editingSubtask, 'char', 'c');
    expect(typed.taskEditor?.text).toBe('First childc');
    expect(typed.expandedTaskId).toBe('s1');
  });

  it('escape while browsing a parent\'s subtasks collapses it instead of leaving the plan pane', () => {
    const expanded = press(state(), 'enter');
    const collapsed = press(expanded, 'escape');
    expect(collapsed.expandedTaskId).toBeNull();
    expect(collapsed.focus).toBe('plan');
  });

  it('a leaf task with no subtasks still opens its editor on the first enter', () => {
    const expanded = press(state(), 'down');
    const edited = press(expanded, 'enter');
    expect(edited.expandedTaskId).toBe('t2');
    expect(edited.taskEditor?.text).toBe('Sibling');
  });

  it('the footer hints still say "enter expand" while browsing revealed subtasks, not "type to edit prompt"', () => {
    const expanded = press(state(), 'enter');
    expect(footerHints(expanded)).toContain('enter expand');
    expect(footerHints(expanded)).not.toContain('type to edit prompt');
  });
});

describe('a plan refresh while a subtask is expanded', () => {
  it('does not reset expandedTaskId to null when the subtask still exists', () => {
    const editingSubtask = press(press(press(state(), 'enter'), 'down'), 'enter');
    const plan = {
      tasks: [
        {
          id: 'p1', order: 1, title: 'Parent', description: 'Parent', status: 'pending', dependencies: [],
          subtasks: [
            { id: 's1', order: 1, title: 'First child', description: 'First child', status: 'pending', dependencies: [] },
            { id: 's2', order: 2, title: 'Second child', description: 'Second child', status: 'pending', dependencies: [] },
          ],
        },
        { id: 't2', order: 2, title: 'Sibling', description: 'Sibling', status: 'pending', dependencies: [] },
      ],
    };
    const refreshed = reduce(editingSubtask, { type: 'planUpdated', plan }).state;
    expect(refreshed.expandedTaskId).toBe('s1');
    expect(refreshed.taskEditor).not.toBeNull();
  });
});

describe('planUpdated with subtasks', () => {
  it('carries sorted subtasks into the pane', () => {
    const plan = {
      tasks: [{
        id: 'p1', order: 1, title: 'Parent', description: 'Parent', status: 'pending', dependencies: [],
        subtasks: [
          { id: 's2', order: 2, title: 'Second child', description: 'Second child', status: 'pending', dependencies: [] },
          { id: 's1', order: 1, title: 'First child', description: 'First child', status: 'pending', dependencies: [] },
        ],
      }],
    };
    const s = reduce(state(), { type: 'planUpdated', plan }).state;
    expect(s.tasks[0].subtasks?.map((x) => x.id)).toEqual(['s1', 's2']);
  });

  it('clamps the cursor to the visible rows, subtasks included, when a plan lands', () => {
    const plan = {
      tasks: [{
        id: 'p1', order: 1, title: 'Parent', description: 'Parent', status: 'pending', dependencies: [],
        subtasks: [{ id: 's1', order: 1, title: 'Child', description: 'Child', status: 'pending', dependencies: [] }],
      }],
    };
    const s = reduce(state({ expandedTaskId: 'p1', selectedTask: 9 }), { type: 'planUpdated', plan }).state;
    expect(s.selectedTask).toBe(1);
  });
});

describe('per-task pickers opened on a subtask row', () => {
  // `state.tasks` only holds top-level tasks; a subtask lives inside its
  // parent's `subtasks`. Looking it up with a flat `state.tasks.find(...)`
  // instead of the recursive `findTask` silently "finds" nothing, and every
  // picker built from that renders the generic empty-picker fallback ("Nothing
  // to show yet…") instead of the subtask's actual options.
  const runnerSubtask = task({ id: 's1', order: 1, title: 'First child', assignedRunner: 'opencode' });
  const runnerParent = task({ id: 'p1', order: 1, title: 'Parent', subtasks: [runnerSubtask] });
  const model = { id: 'opencode/x', label: 'X', provider: 'opencode', runners: ['opencode'] };

  it('"o" lists the subtask\'s own discovered models, not the empty-picker fallback', () => {
    const opened = press(state({ expandedTaskId: 'p1', selectedTask: 1, tasks: [runnerParent], models: [model] }), 'char', 'o');
    expect(opened.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'set-task-model', taskId: 's1' } } });
    const items = opened.overlay?.kind === 'picker' ? opened.overlay.picker.items : [];
    expect(items.map((i) => i.id)).toEqual(['opencode/x']);
  });

  it('confirming a subtask model picker selection updates that subtask, not a no-op', () => {
    const opened = press(state({ expandedTaskId: 'p1', selectedTask: 1, tasks: [runnerParent], models: [model] }), 'char', 'o');
    const { effects } = reduce(opened, { type: 'key', key: { name: 'enter' } });
    expect(effects).toEqual([expect.objectContaining({ type: 'updateTask', taskId: 's1' })]);
  });

  it('"R" (runner) and "e" (effort) pickers also resolve against the subtask, not the empty fallback', () => {
    const runnerOpened = press(state({ expandedTaskId: 'p1', selectedTask: 1, tasks: [runnerParent], models: [model], runners: [{ id: 'opencode', name: 'OpenCode', enabled: true }] }), 'char', 'R');
    expect(runnerOpened.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'set-task-runner', taskId: 's1' } } });
    const runnerItems = runnerOpened.overlay?.kind === 'picker' ? runnerOpened.overlay.picker.items : [];
    expect(runnerItems.length).toBeGreaterThan(0);
  });
});
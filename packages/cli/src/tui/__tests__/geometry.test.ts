import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import { render } from '../render';
import { chatEditorRoom, planScrollBound, planPaneWidth, taskEditorRoom } from '../geometry';
import { cursorPosition } from '../editor';
import { width } from '../ansi';
import type { TaskView, TuiState } from '../state';

/**
 * The reducer/render pair, asserted through both halves at once. Each half was
 * already tested alone, which is exactly how the two of them came to disagree
 * about how wide the expanded task's prompt is.
 */

const press = (state: TuiState, name: string, char?: string): Step =>
  reduce(state, { type: 'key', key: { name, char } });

/** Long enough to wrap several times inside the plan pane at any usable width. */
const LONG_PROMPT = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';

/** The rendered row holding the selection caret, or -1 when it scrolled out of the pane. */
function selectedRow(state: TuiState): number {
  return render(state)
    // eslint-disable-next-line no-control-regex
    .map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''))
    .map((row) => (row.includes('│') ? row.slice(row.indexOf('│') + 1) : row))
    .findIndex((row) => row.includes('❯'));
}

function taskState(over: Partial<TuiState> = {}, prompt = LONG_PROMPT): TuiState {
  const tasks: TaskView[] = [
    { id: 'a', order: 1, title: 'Long task', type: 'ai', status: 'pending', dependencies: [], prompt },
  ];
  return initialState({ sessionId: 's1', tasks, focus: 'plan', rows: 24, cols: 80, ...over });
}

describe('pane geometry', () => {
  it('wraps the task editor inside the plan pane, not across the terminal', () => {
    const state = taskState();

    expect(planPaneWidth(state)).toBeGreaterThan(0);
    expect(taskEditorRoom(state)).toBe(planPaneWidth(state) - 4);
    // The defect this replaces: the reducer used the full terminal width here,
    // wrapping at 76 columns inside a 36-column pane.
    expect(taskEditorRoom(state)).toBeLessThan(state.cols - 4);
  });

  it('gives the task editor one column when the plan pane is too narrow to show', () => {
    const state = taskState({ cols: 20 });

    expect(planPaneWidth(state)).toBe(0);
    expect(taskEditorRoom(state)).toBe(1);
  });

  it('lets the wheel scroll past the rows a long expanded prompt occupies', () => {
    const collapsed = taskState();
    let state = press(collapsed, 'enter').state;

    // Four rows per task — the old fixed estimate — saturated partway through a
    // prompt that wraps further than that on its own.
    const oldEstimate = collapsed.tasks.length * 4 - 1;
    expect(planScrollBound(state)).toBeGreaterThan(oldEstimate);

    for (let i = 0; i < 20; i++) state = press(state, 'scrolldown').state;
    expect(state.planScroll).toBeGreaterThan(oldEstimate);
  });

  it('reserves the caret column only while the chat editor has focus', () => {
    expect(chatEditorRoom(80, true)).toBe(77);
    expect(chatEditorRoom(80, false)).toBe(78);
  });
});

describe('task editor caret, through the rendered frame', () => {
  it('moves up to the line the user can actually see above the caret', () => {
    const expanded = press(taskState(), 'enter').state;
    const room = taskEditorRoom(expanded);

    const before = cursorPosition(expanded.taskEditor!.text, expanded.taskEditor!.cursor, room);
    expect(before.line, 'the prompt must wrap for this to mean anything').toBeGreaterThan(0);

    const up = press(expanded, 'up').state;
    const after = cursorPosition(up.taskEditor!.text, up.taskEditor!.cursor, room);

    expect(after.line).toBe(before.line - 1);
    expect(after.col).toBe(before.col);
  });

  it('returns to where it started after up then down', () => {
    const expanded = press(taskState(), 'enter').state;
    const start = expanded.taskEditor!.cursor;

    const round = press(press(expanded, 'up').state, 'down').state;

    expect(round.taskEditor!.cursor).toBe(start);
  });

  it('keeps the selected task on screen however far the list is navigated', () => {
    // Rewritten from a committed scratch file that printed these positions to
    // the console and asserted nothing. The invariant it was chasing is real:
    // the reducer moves the selection, the renderer decides what is visible,
    // and the selection must survive the round trip.
    const many: TaskView[] = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i}`,
      order: i + 1,
      title: i % 3 === 2 ? `Task ${i + 1} with a title long enough to wrap across more than one line` : `Task ${i + 1}`,
      type: 'ai' as const,
      status: 'pending',
      dependencies: [],
    }));
    let state = initialState({ rows: 15, cols: 80, tasks: many, focus: 'plan', selectedTask: 0 });

    for (const direction of ['down', 'up'] as const) {
      for (let i = 0; i < 20; i++) {
        state = press(state, direction).state;
        expect(selectedRow(state), `selection left the pane going ${direction}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('re-anchors on the selection after a manual wheel scroll', () => {
    const many: TaskView[] = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i}`, order: i + 1, title: `Task ${i + 1}`, type: 'ai' as const, status: 'pending', dependencies: [],
    }));
    let state = initialState({ rows: 15, cols: 80, tasks: many, focus: 'plan', selectedTask: 2 });

    for (let i = 0; i < 10; i++) state = press(state, 'scrollup').state;
    state = press(state, 'down').state;

    expect(state.planScroll).toBe(0);
    expect(selectedRow(state)).toBeGreaterThanOrEqual(0);
  });

  it('renders a frame whose rows never exceed the terminal width', () => {
    const expanded = press(taskState(), 'enter').state;
    const frame = render(expanded);

    expect(frame).toHaveLength(expanded.rows);
    expect(Math.max(...frame.map(width))).toBeLessThanOrEqual(expanded.cols);
  });
});

import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import { planOffset, planScrollExtent } from '../layout';
import type { TaskView, TuiState } from '../state';

/**
 * The plan pane's viewport is its own: the cursor walks inside it, and it
 * scrolls only when the cursor would leave. These assert the offset and the
 * selection together, since either one alone can look right while the pair
 * is what the user sees.
 */

const press = (state: TuiState, name: string, extra: Record<string, unknown> = {}): TuiState =>
  reduce(state, { type: 'key', key: { name, ...extra } }).state;

const repeat = (state: TuiState, name: string, times: number): TuiState => {
  let next = state;
  for (let i = 0; i < times; i++) next = press(next, name);
  return next;
};

const aiTasks = (n: number): TaskView[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`, order: i + 1, title: `Task ${i + 1}`,
    type: 'ai' as const, status: 'pending', dependencies: [],
  }));

// A mix of heights: a manual task is one line, an AI task carries meta and
// effort lines under its title, and a long title wraps.
const mixedTasks = (n: number): TaskView[] =>
  aiTasks(n).map((task, i) => {
    if (i % 3 === 0) return { ...task, type: 'user' as const };
    if (i % 3 === 1) return { ...task, title: `Task ${i + 1} with a title long enough to wrap across more than one line` };
    return task;
  });

const planState = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 20, cols: 80, tasks: aiTasks(30), focus: 'plan', selectedTask: 0, ...over });

interface View {
  offset: number;
  top: number;
  bottom: number;
  spans: { start: number; end: number }[];
}

function view(state: TuiState): View {
  const layout = planScrollExtent(state);
  const offset = planOffset(layout, state.planScroll);
  return { offset, top: 1 + offset, bottom: offset + layout.rows - 1, spans: layout.rowSpans };
}

const fullyVisible = (v: View): number[] =>
  v.spans.flatMap((span, i) => (span.start >= v.top && span.end <= v.bottom ? [i] : []));

const selectedIsFullyVisible = (state: TuiState): boolean =>
  fullyVisible(view(state)).includes(state.selectedTask);

describe('plan pane viewport — arrows', () => {
  it('scrolls exactly at the edge and no earlier', () => {
    let state = planState();
    for (let i = 0; i < 29; i++) {
      const before = view(state);
      const next = press(state, 'down');
      const span = before.spans[next.selectedTask];
      const wasVisible = span.start >= before.top && span.end <= before.bottom;
      if (wasVisible) expect(next.planScroll, `stepping onto row ${next.selectedTask}`).toBe(state.planScroll ?? before.offset);
      expect(selectedIsFullyVisible(next), `row ${next.selectedTask} on screen`).toBe(true);
      state = next;
    }
  });

  it('keeps the selection fully visible through rows of every height, going both ways', () => {
    let state = planState({ tasks: mixedTasks(24) });
    for (const direction of ['down', 'up'] as const) {
      for (let i = 0; i < 30; i++) {
        state = press(state, direction);
        expect(selectedIsFullyVisible(state), `${direction} at row ${state.selectedTask}`).toBe(true);
      }
    }
    expect(state.selectedTask).toBe(0);
  });

  it('shows the spacer under the header again once the first row is selected', () => {
    const state = repeat(repeat(planState(), 'down', 20), 'up', 20);
    expect(state.selectedTask).toBe(0);
    expect(state.planScroll).toBe(0);
  });

  it('brings an expanded task into full view when stepping onto it', () => {
    // Expanded without an editor open, so the rows below it are pushed down by
    // its detail lines rather than by a caret.
    const state = planState({ tasks: mixedTasks(12), expandedTaskId: 't7', selectedTask: 5 });
    const onto = press(press(state, 'down'), 'down');
    expect(onto.selectedTask).toBe(7);
    expect(selectedIsFullyVisible(onto)).toBe(true);
    const back = press(onto, 'up');
    expect(back.selectedTask).toBe(6);
    expect(selectedIsFullyVisible(back)).toBe(true);
  });

  it('starts a task taller than the pane at its first line', () => {
    const tall: TaskView = {
      id: 'big', order: 2, title: Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '),
      type: 'ai', status: 'pending', dependencies: [],
    };
    const state = press(planState({ tasks: [aiTasks(1)[0], tall, ...aiTasks(3).slice(1)], expandedTaskId: 'big', rows: 12 }), 'down');
    expect(state.selectedTask).toBe(1);
    expect(view(state).top).toBe(view(state).spans[1].start);
  });
});

describe('plan pane viewport — page keys', () => {
  it('pagedown scrolls a page and selects the first task fully in view at the top', () => {
    const start = planState();
    const paged = press(start, 'pagedown');
    const v = view(paged);

    expect(paged.planScroll).toBeGreaterThan(0);
    expect(paged.selectedTask).toBe(fullyVisible(v)[0]);
  });

  it('pageup scrolls a page back and selects the last task fully in view at the bottom', () => {
    const end = repeat(planState(), 'pagedown', 20);
    const paged = press(end, 'pageup');
    const rows = fullyVisible(view(paged));

    expect(paged.planScroll).toBeLessThan(end.planScroll!);
    expect(paged.selectedTask).toBe(rows[rows.length - 1]);
  });

  it('pagedown at the end of the plan selects the last row, and pageup at the start the first', () => {
    const end = repeat(planState(), 'pagedown', 20);
    expect(end.selectedTask).toBe(29);
    const start = repeat(end, 'pageup', 20);
    expect(start.planScroll).toBe(0);
    expect(start.selectedTask).toBe(0);
  });

  it('picks the task covering the edge when none is fully in view', () => {
    const tall: TaskView = {
      id: 'big', order: 1, title: Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '),
      type: 'ai', status: 'pending', dependencies: [],
    };
    const state = planState({ tasks: [tall, ...aiTasks(3)], expandedTaskId: 'big', rows: 12 });
    const paged = press(state, 'pagedown');
    expect(fullyVisible(view(paged))).toEqual([]);
    expect(paged.selectedTask).toBe(0);
  });
});

describe('plan pane viewport — wheel', () => {
  it('scrolls by its notch and leaves a selection that is still on screen alone', () => {
    const state = planState({ selectedTask: 1 });
    const scrolled = press(state, 'scrolldown', { col: 70 });
    expect(scrolled.planScroll).toBe(3);
    expect(scrolled.selectedTask).toBe(1);
  });

  it('pushes the selection back on screen when the wheel would leave it behind', () => {
    const state = planState({ selectedTask: 0 });
    const scrolled = repeat(state, 'scrolldown', 8);
    expect(scrolled.selectedTask).toBeGreaterThan(0);
    expect(selectedIsFullyVisible(scrolled)).toBe(true);
    expect(scrolled.selectedTask).toBe(fullyVisible(view(scrolled))[0]);

    const back = repeat(press(planState({ selectedTask: 29 }), 'pageup'), 'scrollup', 8);
    expect(selectedIsFullyVisible(back)).toBe(true);
  });
});

describe('plan pane viewport — the pane changing under the cursor', () => {
  it('keeps the selection visible when the terminal shrinks', () => {
    const state = repeat(planState({ rows: 40 }), 'down', 10);
    const shrunk = reduce(state, { type: 'resize', rows: 14, cols: 80 }).state;
    expect(selectedIsFullyVisible(shrunk)).toBe(true);
  });

  it('keeps the offset reachable when the terminal grows', () => {
    const state = repeat(planState(), 'down', 25);
    const grown = reduce(state, { type: 'resize', rows: 60, cols: 80 }).state;
    expect(grown.planScroll).toBeLessThanOrEqual(planScrollExtent(grown).maxScroll);
    expect(selectedIsFullyVisible(grown)).toBe(true);
  });

  it('keeps the selection visible when the plan loses tasks', () => {
    const state = repeat(planState(), 'down', 25);
    const plan = { tasks: aiTasks(10).map((t) => ({ ...t })) };
    const updated = reduce(state, { type: 'planUpdated', sessionId: 's1', plan: plan as never }).state;
    expect(updated.selectedTask).toBe(9);
    expect(selectedIsFullyVisible(updated)).toBe(true);
  });

  it('does not move the view when collapsing an expanded task whose row stays visible', () => {
    const expanded = press(planState({ selectedTask: 2 }), 'right');
    const collapsed = press(expanded, 'escape');
    expect(collapsed.expandedTaskId).toBeNull();
    expect(collapsed.planScroll).toBe(expanded.planScroll);
  });

  it('follows the prompt caret while the editor is open', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const tasks = aiTasks(6).map((t, i) => (i === 0 ? { ...t, prompt: long } : t));
    const editing = press(planState({ tasks, rows: 16 }), 'right');
    const layout = planScrollExtent(editing);
    const offset = planOffset(layout, editing.planScroll);
    expect(layout.anchor.start).toBeGreaterThanOrEqual(1 + offset);
    expect(layout.anchor.end).toBeLessThanOrEqual(offset + layout.rows - 1);
  });
});

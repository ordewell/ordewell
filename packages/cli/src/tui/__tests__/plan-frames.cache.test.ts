import { afterEach, describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { measureCache } from '../ansi';
import { planRowCache } from '../layout';
import type { TaskView, TuiState } from '../state';

// The plan pane keeps what it laid out and the wrap memo what it wrapped, so a
// frame repaints without measuring every row again. A cache of a pure function
// may change what a frame costs and nothing else (ADR-0006): every frame below
// is painted with the caches warm from the frames before it, cold, and off, and
// the three must agree line for line.

const caches = (enabled: boolean): void => {
  measureCache.enabled = enabled;
  planRowCache.enabled = enabled;
};
const clearCaches = (): void => {
  measureCache.clear();
  planRowCache.clear();
};

afterEach(() => {
  caches(true);
  clearCaches();
});

function tasks(): TaskView[] {
  const out: TaskView[] = Array.from({ length: 36 }, (_, i) => ({
    id: `t${i + 1}`,
    order: i + 1,
    title: i % 5 === 1
      ? `Task ${i + 1}: a title long enough to wrap across more than one line of the plan pane, and then some more`
      : i % 7 === 3 ? `タスク ${i + 1} 日本語のタイトル ✅` : `Task ${i + 1}`,
    type: i % 4 === 0 ? 'user' as const : 'ai' as const,
    status: i < 10 ? 'completed' : i === 12 ? 'failed' : i === 14 || i === 20 ? 'in_progress' : 'pending',
    dependencies: i === 15 ? ['t13'] : i > 0 && i % 6 === 0 ? [`t${i}`] : [],
    ...(i % 3 === 2 ? { prompt: `Do task ${i + 1} carefully.\nIt has a second paragraph.` } : {}),
    ...(i % 4 !== 0 ? { assignedModel: { modelId: 'm', modelLabel: 'Model M', thinkingEffort: 'high' } } : {}),
  }));
  out[8] = {
    ...out[8],
    subtasks: [
      { id: 't9a', order: 1, title: 'Subtask one', type: 'ai', status: 'completed', dependencies: [] },
      { id: 't9b', order: 2, title: 'Subtask two with a longer title that wraps in a narrow pane', type: 'ai', status: 'pending', dependencies: ['t9a'] },
    ],
  };
  return out;
}

const key = (state: TuiState, name: string, extra: Record<string, unknown> = {}): TuiState =>
  reduce(state, { type: 'key', key: { name, ...extra } }).state;
const tick = (state: TuiState): TuiState => reduce(state, { type: 'spinnerTick' }).state;
const resize = (state: TuiState, rows: number, cols: number): TuiState => reduce(state, { type: 'resize', rows, cols }).state;
const editTask = (state: TuiState, id: string, edit: (t: TaskView) => TaskView): TuiState =>
  ({ ...state, tasks: state.tasks.map((t) => (t.id === id ? edit(t) : t)) });

/** A walk through what changes a frame, each state from the one before. */
function states(): [string, TuiState][] {
  const out: [string, TuiState][] = [];
  let state = initialState({ sessionId: 's1', rows: 30, cols: 140, tasks: tasks(), focus: 'plan', selectedTask: 0 });
  const at = (label: string, next: TuiState): void => {
    state = next;
    out.push([label, state]);
  };
  at('loaded', state);
  for (let i = 0; i < 4; i++) at(`down ${i + 1}`, key(state, 'down'));
  at('spinner', tick(state));
  at('spinner again', tick(state));
  for (let i = 0; i < 4; i++) at(`down to the parent ${i + 1}`, key(state, 'down'));
  at('parent opened', key(state, 'right'));
  at('onto a subtask', key(state, 'down'));
  at('subtask expanded', key(state, 'right'));
  at('typing in its prompt', key(state, 'char', { char: 'x' }));
  at('prompt closed', key(state, 'escape'));
  expect(state.focus).toBe('plan');
  at('page down', key(state, 'pagedown'));
  at('page down again', key(state, 'pagedown'));
  at('end of the plan', key(state, 'end'));
  at('page up', key(state, 'pageup'));
  for (let i = 0; i < 40 && state.selectedTask !== 15; i++) at(`to row 16 from ${state.selectedTask}`, key(state, state.selectedTask < 15 ? 'down' : 'up'));
  // The row of t16 is not touched: its task view keeps its identity while the
  // task it is blocked by is renumbered, so its row must say the new number.
  at('a dependency renumbered', editTask(state, 't13', (t) => ({ ...t, order: 99 })));
  at('a title edited', editTask(state, 't12', (t) => ({ ...t, title: 'Renamed task twelve, now with a title that wraps over the line' })));
  at('a status change', editTask(state, 't17', (t) => ({ ...t, status: 'in_progress' })));
  at('a running task finished', editTask(state, 't15', (t) => ({ ...t, status: 'completed' })));
  at('spinner after the change', tick(state));
  at('focus to the chat', { ...state, focus: 'chat' });
  at('focus back', { ...state, focus: 'plan' });
  at('narrower', resize(state, 30, 100));
  at('stacked', resize(state, 40, 60));
  at('stacked, scrolled', key(state, 'pagedown'));
  at('wide again', resize(state, 50, 200));
  at('a task added', { ...state, tasks: [...state.tasks, { id: 't40', order: 40, title: 'A new task', type: 'ai', status: 'pending', dependencies: ['t39'] }] });
  at('a task removed', { ...state, tasks: state.tasks.filter((t) => t.id !== 't20') });
  return out;
}

describe('plan pane caches', () => {
  it('paint every frame the same warm, cold and off', () => {
    const walk = states();
    caches(true);
    clearCaches();
    const warm = walk.map(([, state]) => render(state));

    const cold = walk.map(([, state]) => {
      clearCaches();
      return render(state);
    });

    caches(false);
    const off = walk.map(([, state]) => render(state));

    walk.forEach(([label], i) => {
      expect(warm[i], `${label}: warm`).toEqual(off[i]);
      expect(cold[i], `${label}: cold`).toEqual(off[i]);
    });
  });

  it('shows a renumbered dependency on a row whose own task did not change', () => {
    const walk = states();
    const at = walk.findIndex(([label]) => label === 'a dependency renumbered');
    const before = render(walk[at - 1][1]).join('\n');
    const frame = render(walk[at][1]).join('\n');
    expect(before).toContain('#13');
    expect(frame).toContain('#99');
  });
});

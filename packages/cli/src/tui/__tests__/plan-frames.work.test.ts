import { beforeEach, describe, it, expect, vi } from 'vitest';

// What a plan-pane row says is read off core's row view, once per row laid
// out, and the pane's header totals the plan's usage once per layout. Counting
// the two tells how much of the plan a frame laid out again.
vi.mock('@ordewell/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ordewell/core')>();
  return { ...actual, taskRowView: vi.fn(actual.taskRowView), tasksTotalText: vi.fn(actual.tasksTotalText) };
});

import { taskRowView, tasksTotalText } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { planRowCache } from '../layout';
import type { TaskView, TuiState } from '../state';

const rowsLaidOut = (): number => vi.mocked(taskRowView).mock.calls.filter(([, context]) => context?.tasks).length;
const layouts = (): number => vi.mocked(tasksTotalText).mock.calls.length;

const plan = (n: number, running: number[]): TaskView[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`, order: i + 1, title: `Task ${i + 1} with a title of a few words`,
    type: 'ai' as const, status: running.includes(i) ? 'in_progress' : i < n / 2 ? 'completed' : 'pending', dependencies: [],
  }));

const loaded = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 40, cols: 160, tasks: plan(200, [150, 151]), focus: 'plan', selectedTask: 0, ...over });

beforeEach(() => {
  planRowCache.clear();
  vi.mocked(taskRowView).mockClear();
  vi.mocked(tasksTotalText).mockClear();
});

describe('a frame of a long plan', () => {
  it('lays out again only the running rows on a spinner tick', () => {
    const state = loaded();
    render(state);
    vi.mocked(taskRowView).mockClear();

    render(reduce(state, { type: 'spinnerTick' }).state);

    expect(rowsLaidOut()).toBe(2);
  });

  it('lays out again only the two rows a selection step changes', () => {
    const state = loaded();
    render(state);
    vi.mocked(taskRowView).mockClear();

    render(reduce(state, { type: 'key', key: { name: 'down' } }).state);

    expect(rowsLaidOut()).toBe(2);
  });

  it('lays the plan out once for a key and the frame it paints', () => {
    const state = loaded({ selectedTask: 5 });
    render(state);
    vi.mocked(tasksTotalText).mockClear();

    render(reduce(state, { type: 'key', key: { name: 'down' } }).state);

    expect(layouts()).toBe(1);
  });
});

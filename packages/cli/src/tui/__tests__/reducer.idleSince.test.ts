import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TaskView, TuiState } from '../state';

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress',
    dependencies: [],
    ...over,
  };
}

function planPane(over: Partial<TuiState> = {}): TuiState {
  return initialState({ sessionId: 's1', tasks: [task()], ...over });
}

describe('tasksStatus — idleSince threading', () => {
  it('sets idleSince on the matching task', () => {
    const state = planPane();
    const { state: next } = reduce(state, {
      type: 'tasksStatus',
      updates: { t1: { status: 'in_progress', idleSince: '2026-08-18T00:00:00.000Z' } },
      sessionId: 's1',
    });
    expect(next.tasks[0].idleSince).toBe('2026-08-18T00:00:00.000Z');
  });

  it('clears idleSince once the task resumes', () => {
    const state = planPane({ tasks: [task({ idleSince: '2026-08-18T00:00:00.000Z' })] });
    const { state: next } = reduce(state, {
      type: 'tasksStatus',
      updates: { t1: { status: 'in_progress', idleSince: null } },
      sessionId: 's1',
    });
    expect(next.tasks[0].idleSince).toBeNull();
  });
});

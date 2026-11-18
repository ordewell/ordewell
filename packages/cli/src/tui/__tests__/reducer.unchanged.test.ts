import { describe, expect, it } from 'vitest';
import type { TaskLogEvent } from '@ordewell/core';
import { reduce, type Action } from '../reducer';
import { initialState, type TaskView, type TuiState } from '../state';

const task = (id: string, order: number, status = 'in_progress'): TaskView => ({
  id, order, title: `Task ${order}`, type: 'ai', status, dependencies: [], assignedRunner: 'opencode',
  assignedModel: { modelId: 'opencode-go/kimi', modelLabel: 'Kimi' },
});

const usage: TaskLogEvent = { type: 'usage', record: { source: 'opencode', model: 'opencode-go/kimi', inputTokens: 1000 } };
const log = (events: TaskLogEvent[], over: Partial<Extract<Action, { type: 'taskLog' }>> = {}): Action =>
  ({ type: 'taskLog', sessionId: 's', taskId: 't1', attempt: 1, events, ...over });

function session(over: Partial<TuiState> = {}): TuiState {
  return initialState({ sessionId: 's', rows: 40, cols: 60, tasks: Array.from({ length: 30 }, (_, i) => task(`t${i + 1}`, i + 1, i < 2 ? 'in_progress' : 'pending')), ...over });
}

describe('a task log no open view shows', () => {
  it('leaves the state as it was once its served model is known', () => {
    const first = reduce(session(), log([usage])).state;
    expect(reduce(first, log([usage])).state).toBe(first);
    expect(reduce(first, log([{ type: 'text', text: 'working' } as TaskLogEvent])).state).toBe(first);
  });

  it('leaves the state as it was in a stacked body whose plan the user scrolled', () => {
    // 60 columns stack the panes; a scrolled plan is re-settled after every message that may grow the chat.
    const first = reduce(session({ focus: 'plan', planScroll: 4 }), log([usage])).state;
    expect(reduce(first, log([usage])).state).toBe(first);
  });

  it('still records a model the task is served by for the first time', () => {
    const first = reduce(session(), log([usage])).state;
    const other: TaskLogEvent = { type: 'usage', record: { source: 'opencode', model: 'opencode-go/glm', inputTokens: 10 } };
    const next = reduce(first, log([other])).state;
    expect(next).not.toBe(first);
    expect(next.servedModels.t1?.model).toBe('opencode-go/glm');
  });
});

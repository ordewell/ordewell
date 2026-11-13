import { describe, it, expect } from 'vitest';
import { EMPTY_RUN, type RunTask, type RunView } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import type { TuiState } from '../state';

// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

const runTask = (over: Partial<RunTask> = {}): RunTask => ({
  id: 't1', order: 1, title: 'Refactor PlanStore', description: 'Refactor PlanStore', type: 'ai', status: 'in_progress',
  dependencies: [], assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: 'Do it', verdict: null,
  userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined, attempted: true, subtasks: [], ...over,
});

const run = (task: RunTask): RunView => ({ ...EMPTY_RUN, tasks: [task] });

// Wide enough that the plan pane keeps each label on one line.
const joined = (task: RunTask): TuiState =>
  reduce(initialState({ sessionId: 's1', rows: 20, cols: 200, focus: 'plan' }), { type: 'runSnapshot', view: run(task), sessionId: 's1' }).state;

describe('plan pane: a runner starting while Ordewell\'s tools attach (ADR-0025)', () => {
  it('says the tools are connecting on the row, beside the runner', () => {
    expect(plain(joined(runTask({ attaching: 1 })))).toContain('connecting Ordewell\'s tools · claude-code');
  });

  it('says so of the respawn', () => {
    expect(plain(joined(runTask({ attaching: 2 })))).toContain('connecting Ordewell\'s tools, retry · claude-code');
  });

  it('drops it once a status update no longer carries it', () => {
    const state = joined(runTask({ attaching: 1 }));

    const next = reduce(state, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }] }, sessionId: 's1' }).state;

    expect(plain(next)).not.toContain('connecting');
  });

  it('shows the hold a second miss leaves, with no progress', () => {
    const state = joined(runTask({ attaching: 2 }));

    const next = reduce(state, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 't1', status: 'pending', verdict: null, holdReason: 'could not connect to Ordewell\'s tools; start it again' }] }, sessionId: 's1' }).state;

    expect(plain(next)).not.toContain('connecting');
    expect(plain(next)).toContain('could not connect to Ordewell\'s tools');
  });
});

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

/** A terminal that connects while the task's attempt winds down: the daemon's snapshot is all it has. */
const joined = (task: RunTask): TuiState =>
  reduce(initialState({ sessionId: 's1', rows: 20, cols: 100, focus: 'plan' }), { type: 'runSnapshot', view: run(task), sessionId: 's1' }).state;

describe('plan pane: a report received while its attempt winds down (ADR-0018, L1)', () => {
  it('says so on the row of a terminal that joins mid wind-down, and never as done', () => {
    const frame = plain(joined(runTask({ completionReceived: 'done' })));

    expect(frame).toContain('completion received · claude-code');
    expect(frame).toContain('1 RUN Refactor PlanStore');
  });

  it('words a failed report as received, not passed', () => {
    expect(plain(joined(runTask({ completionReceived: 'failed' })))).toContain('failure report received');
  });

  it('drops the receipt once a status update no longer carries it', () => {
    const state = joined(runTask({ completionReceived: 'done' }));

    const next = reduce(state, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }] }, sessionId: 's1' }).state;

    expect(plain(next)).not.toContain('received');
  });
});

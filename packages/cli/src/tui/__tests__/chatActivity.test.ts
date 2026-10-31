import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EMPTY_TASK_LOG, replayTaskLog } from '@ordewell/core';
import { chatActivity } from '../layout';
import { initialState, type TaskLogState, type TaskView, type TuiState } from '../state';

function task(over: Partial<TaskView> = {}): TaskView {
  return { id: 't1', order: 1, title: 'Add multiply', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', ...over };
}

function viewing(taskId: string, over: Partial<TaskLogState> = {}): TaskLogState {
  return { taskId, view: { ...EMPTY_TASK_LOG, working: true }, attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0, ...over };
}

const state = (over: Partial<TuiState>): TuiState => initialState({ sessionId: 's1', ...over });

// The resume label shortens a same-day time and names the date on another day,
// so the clock is fixed rather than read: a real clock makes this a date bomb.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 9, 14, 11, 0), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('chatActivity: the planner chat', () => {
  it('is empty while the planner is idle, even with tasks running', () => {
    expect(chatActivity(state({ status: 'executing', tasks: [task({ status: 'in_progress' })] }))).toBeNull();
  });

  it('says Planning while a planner turn is in flight', () => {
    expect(chatActivity(state({ planner: 'planning' }))).toEqual({ label: 'Planning…', busy: true });
  });

  it('says what a turn waits for while no planner has heard of it yet', () => {
    expect(chatActivity(state({ planner: 'planning', plannerDetecting: true }))).toEqual({ label: 'Detecting coding agents…', busy: true });
  });

  it('says nothing of detection with no turn out', () => {
    expect(chatActivity(state({ plannerDetecting: true }))).toBeNull();
  });

  it('says Condensing while /compact runs', () => {
    expect(chatActivity(state({ planner: 'condensing' }))).toEqual({ label: 'Condensing…', busy: true });
  });
});

describe('chatActivity: a task chat', () => {
  it('says Working while that task\'s attempt is in progress', () => {
    const tasks = [task({ status: 'in_progress' })];
    expect(chatActivity(state({ tasks, taskView: viewing('t1') }))).toEqual({ label: 'Working…', busy: true });
  });

  it.each(['completed', 'interrupted', 'failed'] as const)('says nothing between turns, after one %s: a stopped runner must not look busy', (reason) => {
    const tasks = [task({ status: 'in_progress' })];
    const view = replayTaskLog([{ type: 'turn_start', message: 'go', startedAt: '2026-10-30T10:00:00.000Z' }, { type: 'turn_end', reason }]);
    expect(chatActivity(state({ tasks, taskView: viewing('t1', { view }) }))).toBeNull();
  });

  it('says nothing for an earlier attempt browsed while the task runs a later one, whatever it was left on', () => {
    const tasks = [task({ status: 'in_progress' })];
    const view = replayTaskLog([{ type: 'turn_start', message: 'go', startedAt: '2026-10-30T10:00:00.000Z' }, { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"sleep 999"}' }]);
    expect(chatActivity(state({ tasks, taskView: viewing('t1', { view, attempts: [1, 2], attempt: 1 }) }))).toBeNull();
    expect(chatActivity(state({ tasks, taskView: viewing('t1', { view, attempts: [1, 2], attempt: 2 }) }))?.label).toBe('Running Bash(sleep 999)…');
  });

  it('still names a background subagent that outlives its turn', () => {
    const tasks = [task({ status: 'in_progress' })];
    const view = replayTaskLog([
      { type: 'turn_start', message: 'go' },
      { type: 'subagent_started', subagentId: 's1', brief: 'Scan the repo' },
      { type: 'turn_end', reason: 'completed' },
    ]);
    expect(chatActivity(state({ tasks, taskView: viewing('t1', { view }) }))).toEqual({ label: 'Subagent: Scan the repo…', busy: true });
  });

  it('says its runner is connecting Ordewell\'s tools, not working, while nothing has been sent to it (ADR-0025)', () => {
    expect(chatActivity(state({ tasks: [task({ status: 'in_progress', attaching: 1 })], taskView: viewing('t1') }))).toEqual({ label: 'Connecting Ordewell\'s tools…', busy: true });
    expect(chatActivity(state({ tasks: [task({ status: 'in_progress', attaching: 2 })], taskView: viewing('t1') }))).toEqual({ label: 'Connecting Ordewell\'s tools, retry…', busy: true });
  });

  it('is empty when another task is running and the selected one is not', () => {
    const tasks = [task({ status: 'in_progress' }), task({ id: 't2', order: 2, status: 'completed' })];
    expect(chatActivity(state({ status: 'executing', tasks, taskView: viewing('t2') }))).toBeNull();
  });

  it('is empty during a planner turn, which is not that task\'s', () => {
    expect(chatActivity(state({ planner: 'planning', tasks: [task({ status: 'completed' })], taskView: viewing('t1') }))).toBeNull();
  });

  it('follows the parent\'s attempt from a subtask view', () => {
    const subtask = task({ id: 't1.1', order: 1, status: 'pending' });
    const tasks = [task({ status: 'in_progress', subtasks: [subtask] })];
    expect(chatActivity(state({ tasks, taskView: viewing('t1.1') }))).toEqual({ label: 'Working…', busy: true });
  });

  it('shows when a usage-limit pause resumes, without claiming the task is busy', () => {
    const resumeAt = new Date(2026, 9, 14, 12, 12).toISOString();
    const tasks = [task({ status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt })];
    const activity = chatActivity(state({ tasks, taskView: viewing('t1') }));
    expect(activity?.label).toBe('paused · resumes 12:12pm');
    expect(activity?.busy).toBe(false);
  });
});

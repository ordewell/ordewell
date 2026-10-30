import { describe, it, expect } from 'vitest';
import { EMPTY_TASK_LOG } from '@ordewell/core';
import { stripAnsi } from '../ansi';
import { chatLayout, footerHints } from '../layout';
import { initialState } from '../reducer';
import { render } from '../render';
import type { TaskLogState, TaskView, TuiState } from '../state';

/** Stopping a working runner is named where a user watching it will look. */

const RESUME_AT = new Date(2026, 9, 11, 20, 10).toISOString();

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Fix the parser', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', ...over,
});

const opened = (over: Partial<TaskView> = {}, cols = 100): TuiState => {
  const tv: TaskLogState = { taskId: 't1', view: EMPTY_TASK_LOG, attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0 };
  return initialState({ sessionId: 's1', rows: 30, cols, focus: 'chat', tasks: [task(over)], taskView: tv });
};

const statusRow = (state: TuiState): string => {
  const lines = render(state).map(stripAnsi);
  return lines.find((l) => !l.includes('│') && l.includes('⠋')) ?? '';
};
const headerKeys = (state: TuiState): string => stripAnsi(chatLayout(state, 30, 200).header[1] ?? '');

const finished = { status: 'completed' } as const;
const approval = { awaitingApproval: 1 } as const;
const resumeLater = { status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT } as const;

describe('naming ctrl-x while the runner works', () => {
  it('puts the stop key in the footer, ahead of the keys that wrap away', () => {
    const hints = footerHints(opened());
    expect(hints).toContain('ctrl-x stop runner');
    expect(hints.indexOf('ctrl-x stop runner')).toBeLessThan(hints.indexOf('ctrl-c quit'));
    expect(hints.indexOf('ctrl-x stop runner')).toBeLessThan(hints.indexOf('tab plan'));
  });

  it('says it on the status row, next to the spinner, on one line', () => {
    const row = statusRow(opened());
    expect(row.trimStart()).toMatch(/^⠋ Working… · ctrl-x to stop(\s{2,}\S.*)?$/);
  });

  it('leads the header keys with it, so truncation drops the others first', () => {
    expect(headerKeys(opened())).toMatch(/^ctrl-x stop runner · ctrl-r remove queued · ctrl-s send now/);
  });

  it.each([
    ['finished', finished],
    ['waiting on an approval', approval],
    ['paused on a usage limit', resumeLater],
    ['waiting for input', { status: 'awaiting_user', awaitingReason: 'input' } as const],
  ])('names no stop key once the task is %s', (_, over) => {
    const state = opened(over);
    expect(footerHints(state).join(' ')).not.toContain('ctrl-x');
    expect(statusRow(state)).not.toContain('ctrl-x');
    expect(headerKeys(state)).not.toContain('stop runner');
    expect(headerKeys(state)).not.toContain('interrupt');
  });

  it('keeps ctrl-x as "don\'t resume" on a paused task', () => {
    expect(headerKeys(opened(resumeLater))).toContain('ctrl-x don\'t resume');
  });
});

import { describe, it, expect } from 'vitest';
import type { SessionMessage, TaskLogEvent } from '@ordewell/core';
import { replayTaskLog } from '@ordewell/core';
import { stripAnsi } from '../ansi';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { chatScrollMax } from '../layout';
import type { TuiState } from '../state';

const painted = (state: TuiState): string => render(state).map(stripAnsi).join('\n');

const plannerReply = (n: number): SessionMessage =>
  ({ type: 'planner_message', content: `planner line ${n}`, timestamp: '2026-10-02T10:00:00.000Z' });

const fed = (state: TuiState, messages: SessionMessage[]): TuiState =>
  messages.reduce((s, message) => reduce(s, { type: 'sessionMessage', message }).state, state);

const ROWS = { rows: 20, cols: 80 };

describe('the planner chat while output arrives', () => {
  const long = (): TuiState => fed(initialState(ROWS), Array.from({ length: 30 }, (_, i) => plannerReply(i)));

  it('follows new output when already at the tail', () => {
    const state = fed(long(), [plannerReply(99)]);
    expect(state.scroll).toBe(0);
    expect(painted(state)).toContain('planner line 99');
  });

  it('keeps a scrolled-back reader on the same lines', () => {
    const back = { ...long(), scroll: 12 };
    const before = painted(back);

    const after = fed(back, [plannerReply(98), plannerReply(99)]);

    expect(after.scroll).toBeGreaterThan(12);
    expect(painted(after)).toBe(before);
    expect(painted(after)).not.toContain('planner line 99');
  });

  it('never scrolls past what exists above the pane', () => {
    const after = fed({ ...long(), scroll: chatScrollMax(long()) }, [plannerReply(99)]);
    expect(after.scroll).toBeLessThanOrEqual(chatScrollMax(after));
  });

  it('still brings the pane to the tail for the TUI\'s own lines', () => {
    const { state } = reduce({ ...long(), scroll: 12 }, { type: 'notice', message: 'done' });
    expect(state.scroll).toBe(0);
  });
});

describe('a task view while its log streams', () => {
  const lines = (from: number, to: number): TaskLogEvent[] => Array.from({ length: to - from }, (_, i): TaskLogEvent => (
    { type: 'text_delta', text: `runner line ${from + i}\n\n` }
  ));

  const open = (scroll: number): TuiState => initialState({
    ...ROWS,
    sessionId: 's1',
    focus: 'chat',
    scroll,
    tasks: [{ id: 't1', order: 1, title: 'Do it', type: 'ai', status: 'in_progress', dependencies: [] }],
    taskView: {
      taskId: 't1', view: replayTaskLog([{ type: 'turn_start', message: 'go' }, ...lines(0, 60)]),
      attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0,
    },
  });

  const arrive = (state: TuiState, events: TaskLogEvent[]): TuiState =>
    reduce(state, { type: 'taskLog', taskId: 't1', attempt: 1, events, sessionId: 's1' }).state;

  it('follows at the tail', () => {
    const state = arrive(open(0), lines(60, 61));
    expect(state.scroll).toBe(0);
    expect(painted(state)).toContain('runner line 60');
  });

  it('holds the reader\'s place when they have scrolled back', () => {
    const back = open(15);
    expect(chatScrollMax(back), 'the log must overflow for this to mean anything').toBeGreaterThan(15);
    const before = painted(back);

    const after = arrive(back, lines(60, 64));

    expect(after.scroll).toBeGreaterThan(15);
    expect(painted(after)).toBe(before);
  });
});

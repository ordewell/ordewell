import { describe, it, expect } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { stripAnsi } from '../ansi';
import { initialState, reduce, type Action } from '../reducer';
import { render } from '../render';
import type { TaskView, TuiState } from '../state';

/** The status row above the composer is the activity line (#80). */

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const turn: TaskLogEvent = { type: 'turn_start', message: 'Do the task' };

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Fix the parser', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', ...over,
});

const opened = (events: TaskLogEvent[], over: Partial<TaskView> = {}, state: Partial<TuiState> = {}): TuiState =>
  initialState({
    sessionId: 's1', rows: 30, cols: 100, focus: 'chat', tasks: [task(over)],
    taskView: { taskId: 't1', view: replayTaskLog(events), attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0 },
    ...state,
  });

/** The row directly above the input box, where the activity line sits. */
const frame = (state: TuiState): string => render(state).map(stripAnsi).join('\n');
/** Rows outside the plan pane that lead with a spinner frame or the quiet marker: the status row, when it shows a line. */
const activityRows = (state: TuiState): string[] =>
  render(state).map(stripAnsi).filter((l) => !l.includes('│') && [...SPINNER, '~'].some((g) => l.trimStart().startsWith(g)));

describe('the status row as the activity line', () => {
  it('spins and says what the runner is doing while a turn is open', () => {
    const state = opened([turn, { type: 'thinking_delta', text: 'Hmm' }]);
    expect(frame(state)).toContain('⠋ Thinking…');
    const later = { ...state, spinnerFrame: 3 };
    expect(frame(later)).toContain('⠸ Thinking…');
  });

  it('names a pending tool from its headline', () => {
    const state = opened([turn, { type: 'tool_call', id: 'r1', name: 'Read', args: '{"file_path":"README.md"}' }]);
    expect(frame(state)).toContain('Running Read(README.md)…');
  });

  it('is static once the task is quiet, worded as the plan pane words it', () => {
    const state = opened([turn, { type: 'thinking_delta', text: 'Hmm' }], { idleSince: '2026-08-18T00:00:00.000Z' });
    expect(activityRows(state)).toEqual([expect.stringMatching(/^~ Stalled/)]);
    expect(activityRows({ ...state, spinnerFrame: 5 })).toEqual([expect.stringMatching(/^~ Stalled/)]);
  });

  it('keeps the stop key beside a quiet runner', () => {
    const state = opened([turn], { idleSince: '2026-08-18T00:00:00.000Z' });
    expect(frame(state)).toContain('~ Stalled · ctrl-x to stop');
  });

  it('still shows the line for a log that streams without having seen its turn start', () => {
    const state = opened([{ type: 'thinking_delta', text: 'Hmm' }]);
    expect(state.taskView?.view.working).toBe(false);
    expect(activityRows(state)).toEqual([expect.stringMatching(/^⠋ Thinking… · ctrl-x to stop/)]);
  });

  it('shows no line while a runner request waits', () => {
    const asked: TaskLogEvent = { type: 'approval_requested', approvalId: 'p1', tool: 'Bash', args: '{}', allowForTask: true };
    expect(activityRows(opened([turn, asked]))).toEqual([]);
    expect(activityRows(opened([turn], { awaitingApproval: 1 }))).toEqual([]);
  });

  it('shows no line while a checkpoint waits', () => {
    expect(activityRows(opened([turn], { status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: 'Ship it?' }))).toEqual([]);
  });

  it('strips terminal escapes a runner put in the label', () => {
    const state = opened([turn, { type: 'tool_call', id: 'r1', name: 'Bash', args: '{"command":"echo \\u001b[31mred\\u0007"}' }]);
    // eslint-disable-next-line no-control-regex
    expect(render(state).join('\n')).not.toMatch(/\x07|\x1b\[31m/);
  });

  it('truncates the label to the row and keeps the stop key', () => {
    const long = 'x'.repeat(300);
    const state = opened([turn, { type: 'tool_call', id: 'r1', name: 'Bash', args: JSON.stringify({ command: long }) }], {}, { cols: 60 });
    const row = frame(state).split('\n').find((l) => l.includes('Running Bash')) ?? '';
    expect(row.length).toBeLessThanOrEqual(60);
    expect(row).toContain('…');
    expect(row).toContain('ctrl-x to stop');
  });
});

describe('the planner row', () => {
  it('spins while the planner is busy', () => {
    const out = frame(initialState({ sessionId: 's1', rows: 30, cols: 100, planner: 'planning', spinnerFrame: 2 }));
    expect(out).toContain('⠹ Planning…');
  });

  it('lets a standing stop-arm replace the row', () => {
    const out = frame(initialState({ sessionId: 's1', rows: 30, cols: 100, planner: 'planning', stopArmed: true }));
    expect(out).toContain('Press Esc again to stop');
    expect(out).not.toContain('Planning…');
  });
});

describe('the elapsed time on the activity line (#81)', () => {
  const startedAt = '2026-10-30T10:00:00.000Z';
  const dated: TaskLogEvent = { ...turn, startedAt };
  const secondsIn = (n: number): Partial<TuiState> => ({ now: Date.parse(startedAt) + n * 1000 });

  it('ends the line with the time since the open turn began', () => {
    const events: TaskLogEvent[] = [dated, { type: 'thinking_delta', text: 'Hmm' }];
    expect(frame(opened(events, {}, secondsIn(42)))).toContain('⠋ Thinking… 42s');
    expect(frame(opened(events, {}, secondsIn(185)))).toContain('⠋ Thinking… 3m 05s');
  });

  it('keeps counting once the task is quiet, before the stop key', () => {
    const state = opened([dated], { idleSince: '2026-10-30T10:01:00.000Z' }, secondsIn(185));
    expect(frame(state)).toContain('~ Stalled 3m 05s · ctrl-x to stop');
  });

  it('shows the spinner and no time for a turn saved before they were dated', () => {
    const state = opened([turn, { type: 'thinking_delta', text: 'Hmm' }], {}, secondsIn(42));
    expect(activityRows(state)).toEqual([expect.stringMatching(/^⠋ Thinking… · ctrl-x to stop/)]);
  });

  it('shows no time for a start the clock has not reached', () => {
    expect(activityRows(opened([dated], {}, secondsIn(-5)))).toEqual([expect.stringMatching(/^⠋ Working… · ctrl-x to stop/)]);
  });

  it('is on the planner row too, from when its turn began', () => {
    const planning = initialState({
      sessionId: 's1', rows: 30, cols: 100, planner: 'planning', turnGate: { open: 't-1', stopped: null, openedAt: startedAt }, ...secondsIn(7),
    });
    expect(frame(planning)).toContain('⠋ Planning… 7s');
  });

  it('is absent on the planner row when its daemon did not date the turn', () => {
    const planning = initialState({ sessionId: 's1', rows: 30, cols: 100, planner: 'planning', turnGate: { open: 't-1', stopped: null }, ...secondsIn(7) });
    expect(activityRows(planning)).toEqual([expect.stringMatching(/^⠋ Planning…\s*$/)]);
  });

  describe('on the planner row after a turn ends', () => {
    const open = { open: 't-1', stopped: null, openedAt: startedAt };
    const planning = (): TuiState => initialState({ sessionId: 's1', rows: 30, cols: 100, planner: 'planning', turnGate: open, ...secondsIn(1200) });
    const plan = { id: 'p1', goal: 'g', status: 'draft', tasks: [] };

    it.each([
      ['its call failed', { type: 'failed', turn: true, message: 'boom' } as Action],
      ['it returned the plan before its end was heard', { type: 'planUpdated', plan, sessionId: 's1' } as Action],
    ])('does not carry the start into the next turn when %s', (_how, action) => {
      const ended = reduce(planning(), action).state;
      expect(ended.planner).toBe('idle');
      expect(ended.turnGate.open).toBeNull();
      expect(ended.turnGate.openedAt).toBeUndefined();
      const next = reduce({ ...ended, editor: { ...ended.editor, text: 'again', cursor: 5 } }, { type: 'key', key: { name: 'enter' } }).state;
      expect(next.planner).toBe('planning');
      // The settings badge shares the row; a time would follow the label by one space.
      expect(activityRows(next)).toEqual([expect.stringMatching(/^⠋ Planning… {2}/)]);
    });

    it('does not make ctrl-s a force send once the turn has failed', () => {
      const ended = reduce(planning(), { type: 'failed', turn: true, message: 'boom' } as Action).state;
      const { effects } = reduce({ ...ended, editor: { ...ended.editor, text: 'again', cursor: 5 } }, { type: 'key', key: { name: 'ctrl-s' } });
      expect(effects.map((e) => e.type)).toEqual(['sendMessage']);
    });

    it('does not outlive an opening the workspace check refused', () => {
      const refused = reduce(planning(), { type: 'workspaceNeedsInit', workspace: '/ws', goal: 'g' } as Action).state;
      expect(refused.planner).toBe('idle');
      expect(refused.turnGate).toEqual({ open: null, stopped: null });
    });

    it('keeps a stop standing while closing the turn', () => {
      const stopped = { ...planning(), turnGate: { ...open, stopped: 't-0' } };
      expect(reduce(stopped, { type: 'failed', turn: true, message: 'boom' } as Action).state.turnGate).toEqual({ open: null, stopped: 't-0' });
    });
  });

  it('gives way to the stop key last: the label is cut before the time and the key', () => {
    const long = 'x'.repeat(300);
    const state = opened([dated, { type: 'tool_call', id: 'r1', name: 'Bash', args: JSON.stringify({ command: long }) }], {}, { cols: 60, ...secondsIn(42) });
    const row = frame(state).split('\n').find((l) => l.includes('Running Bash')) ?? '';
    expect(row.length).toBeLessThanOrEqual(60);
    expect(row).toContain('… 42s · ctrl-x to stop');
  });
});

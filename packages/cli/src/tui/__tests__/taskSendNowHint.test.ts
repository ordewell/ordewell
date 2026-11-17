import { describe, it, expect } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { footerHints } from '../layout';
import type { TaskLogState, TaskView, TuiState } from '../state';

/**
 * Send now in a running task's chat (ADR-0023, F1): the footer names ctrl-s
 * where the planner chat names its own, in the same words, whenever the key
 * would act — not only once text is typed.
 */

// Every runner kind a task view can hold: each structured one takes a forced
// message through its adapter's interrupt, the built-in runner (`anthropic`)
// included; ACP's is `copilot`.
const RUNNERS = ['claude-code', 'codex', 'opencode', 'copilot', 'anthropic'];

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 2, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', attempted: true,
  ...over,
});

const log = (events: TaskLogEvent[] = [], working = true): TaskLogState => {
  const view = replayTaskLog([{ type: 'turn_start', message: 'Do the task' }, ...events]);
  return {
    taskId: 't1',
    view: working ? view : { ...view, working: false },
    attempts: [1],
    attempt: 1,
    pending: [],
    loaded: true,
    followLatest: true,
    queuedIndex: null,
  };
};

const queued: TaskLogEvent[] = [
  { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
  { type: 'message_queued', messageId: 'm2', text: 'also tests' },
];

const opened = (tv: TaskLogState = log(), tasks: TaskView[] = [task()], cols = 160): TuiState =>
  initialState({ sessionId: 's1', focus: 'chat', rows: 30, cols, tasks, taskView: tv });

const withDraft = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const ctrlS = { type: 'key' as const, key: { name: 'ctrl-s' } };
const sendNowHints = (state: TuiState): string[] => footerHints(state).filter((h) => h.includes('ctrl-s') || h.includes('next step'));

describe('the footer names send now in a running task\'s chat', () => {
  it('in the words the planner chat uses for its own turn', () => {
    const planner = initialState({ sessionId: 's1', focus: 'chat', planner: 'planning' });
    expect(footerHints(planner)).toContain('ctrl-s send now');
    expect(footerHints({ ...planner, queuedPrompts: ['also tests'] })).toContain('ctrl-s send all now');
  });

  for (const runner of RUNNERS) {
    describe(`on ${runner}`, () => {
      const on = (tv: TaskLogState = log(), over: Partial<TaskView> = {}) => opened(tv, [task({ assignedRunner: runner, ...over })]);

      it('with an empty composer and nothing queued, as the planner chat does', () => {
        expect(sendNowHints(on())).toEqual(['ctrl-s send now']);
      });

      it('with messages queued and an empty composer, where ctrl-s sends them all', () => {
        const state = on(log(queued));
        expect(sendNowHints(state)).toEqual(['ctrl-s send all now']);
        expect(reduce(state, ctrlS).effects).toEqual([{ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }]);
      });

      it('with text typed, alone or behind a queue', () => {
        expect(sendNowHints(withDraft(on(), 'stop'))).toEqual(['ctrl-s send now']);
        expect(sendNowHints(withDraft(on(log(queued)), 'stop'))).toEqual(['ctrl-s send all now']);
        expect(reduce(withDraft(on(), 'stop'), ctrlS).effects).toEqual([{ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'stop' }]);
      });

      it('between tool calls, the turn still open', () => {
        const between = log([
          { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
          { type: 'tool_result', id: 'c1', output: 'a b', success: true },
        ]);
        expect(sendNowHints(on(between))).toEqual(['ctrl-s send now']);
      });

      it('while a tool call waits for approval, which the interrupt cancels', () => {
        const asking = log([{ type: 'approval_requested', approvalId: 'ap', tool: 'Bash', args: '{}', allowForTask: false }]);
        expect(sendNowHints(withDraft(on(asking), 'do this instead'))).toEqual(['ctrl-s send now']);
      });

      it('not at a checkpoint, where a message is refused and enter replies', () => {
        const state = withDraft(on(log(), { status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: 'Ship it?' }), 'no');
        expect(sendNowHints(state)).toEqual([]);
        expect(footerHints(state)).toContain('enter reply');
      });

      it('not once the turn has ended, where enter sends at once', () => {
        expect(sendNowHints(withDraft(on(log([], false), { status: 'awaiting_user', awaitingReason: 'input' }), 'more'))).toEqual([]);
      });

      it('not on a finished task its composer continues, nor one paused on a usage limit', () => {
        expect(sendNowHints(withDraft(on(log([], false), { status: 'completed', continuable: true }), 'more'))).toEqual([]);
      });
    });
  }

  it('in a subtask\'s chat as in its parent\'s', () => {
    const parent = task({ id: 'p1', order: 1, subtasks: [task()] });
    expect(sendNowHints(opened(log(), [parent]))).toEqual(['ctrl-s send now']);
    expect(sendNowHints(opened(log(queued), [parent]))).toEqual(['ctrl-s send all now']);
  });

  it('on a narrow terminal with a queue and several attempts, where the header line is cut', () => {
    const state = opened({ ...log(queued), attempts: [1, 2], attempt: 2 }, [task()], 80);
    expect(sendNowHints(state)).toEqual(['ctrl-s send all now']);
  });
});

describe('a delegated task\'s log, whose subplanner has no turn to interrupt', () => {
  const delegated = (tv: TaskLogState = log()) => opened(tv, [task({ type: 'delegated', assignedRunner: undefined })]);

  it('offers no ctrl-s and says enter sends at its next step', () => {
    expect(sendNowHints(withDraft(delegated(), 'also check the docs'))).toEqual(['enter sends at its next step']);
    expect(sendNowHints(delegated())).toEqual(['enter sends at its next step']);
  });

  it('sends nothing on ctrl-s, and says why', () => {
    const { state, effects } = reduce(withDraft(delegated(), 'also check the docs'), ctrlS);
    expect(effects).toEqual([]);
    expect(state.editor.text).toBe('also check the docs');
    expect(state.conversation.blocks.at(-1)).toMatchObject({ text: expect.stringMatching(/no turn to interrupt: enter sends it at its next step/) });
  });
});

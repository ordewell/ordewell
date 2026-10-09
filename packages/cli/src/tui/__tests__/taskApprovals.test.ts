import { describe, it, expect } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { initialState, reduce, type Action } from '../reducer';
import { render } from '../render';
import { chatLayout } from '../layout';
import { inboundFor } from '../inbound';
import { decodeKey } from '../keys';
import type { TaskLogState, TaskView, TuiState } from '../state';
import type { WsEvent } from '../../apiClient';

/**
 * A structured task's runner asking to use a tool (ADR-0018, A1), as the TUI
 * shows and answers it: a notice wherever the user is, "waiting for
 * approval" on the task, and the task view's keys.
 */

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 2, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code',
  ...over,
});

const asked = (approvalId: string, allowForTask = true): TaskLogEvent => ({
  type: 'approval_requested', approvalId, tool: 'Bash', args: '{"command":"npm test"}', allowForTask,
});

const log = (...events: TaskLogEvent[]): TaskLogState => ({
  taskId: 't1',
  view: replayTaskLog([{ type: 'turn_start', message: 'Do the task' }, ...events]),
  attempts: [1],
  attempt: 1,
  pending: [],
  loaded: true,
  followLatest: true,
  queuedIndex: 0,
});

const opened = (tv: TaskLogState, over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', focus: 'chat', rows: 30, cols: 160, tasks: [task()], taskView: tv, ...over });

const withDraft = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const key = (name: string) => ({ type: 'key' as const, key: { name } });

// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

describe('the task view\'s approval keys', () => {
  it('ctrl-y allows the oldest request still waiting', () => {
    const state = opened(log(asked('ap-1'), asked('ap-2')));
    expect(reduce(state, key('ctrl-y')).effects).toEqual([
      { type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap-1', answer: { decision: 'allow' } },
    ]);
  });

  it('ctrl-t allows it for the rest of the task when the runner offered that', () => {
    expect(reduce(opened(log(asked('ap-1'))), key('ctrl-t')).effects).toEqual([
      { type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap-1', answer: { decision: 'allowForTask' } },
    ]);
  });

  it('ctrl-t says so, and sends nothing, when the runner offered no grant', () => {
    const { state, effects } = reduce(opened(log(asked('ap-1', false))), key('ctrl-t'));
    expect(effects).toEqual([]);
    expect(state.conversation.blocks.at(-1)).toMatchObject({ type: 'message', text: expect.stringMatching(/offered no grant/) });
  });

  it('ctrl-g denies with the composer text as the note, and empties the composer', () => {
    const { state, effects } = reduce(withDraft(opened(log(asked('ap-1'))), '  put it under notes/  '), key('ctrl-g'));
    expect(effects).toEqual([
      { type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap-1', answer: { decision: 'deny', note: 'put it under notes/' } },
    ]);
    expect(state.editor.text).toBe('');
  });

  it('ctrl-g with an empty composer denies without a note', () => {
    expect(reduce(opened(log(asked('ap-1'))), key('ctrl-g')).effects).toEqual([
      { type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap-1', answer: { decision: 'deny' } },
    ]);
  });

  it('skips a request already answered, and says when nothing waits', () => {
    const answered = opened(log(asked('ap-1'), { type: 'approval_decided', approvalId: 'ap-1', decision: 'allow' }));
    const { state, effects } = reduce(answered, key('ctrl-y'));
    expect(effects).toEqual([]);
    expect(state.conversation.blocks.at(-1)).toMatchObject({ text: 'Nothing is waiting for approval.' });
  });

  it('decodes the keys from the bytes a terminal sends', () => {
    expect(['\x19', '\x14', '\x07', '\x12', '\x18'].map((byte) => decodeKey(byte).name)).toEqual(['ctrl-y', 'ctrl-t', 'ctrl-g', 'ctrl-r', 'ctrl-x']);
  });
});

describe('what the task view shows', () => {
  it('puts the card in the log and the keys in the header while a request waits', () => {
    const state = opened(log(asked('ap-1')), { tasks: [task({ awaitingApproval: 1 })] });
    const out = plain(state);
    expect(out).toContain('waiting for approval');
    expect(out).toContain('? Waiting for you · Use a tool: Bash(npm test)');
    expect(out).toContain('ctrl-y allow · ctrl-t allow for task · ctrl-g deny');
  });

  it('leaves out allow for task when the runner offered none', () => {
    const out = plain(opened(log(asked('ap-1', false)), { tasks: [task({ awaitingApproval: 1 })] }));
    expect(out).toContain('ctrl-y allow · ctrl-g deny');
    expect(out).not.toContain('ctrl-t');
  });

  it('settles the card with how it was answered', () => {
    const out = plain(opened(log(
      asked('ap-1'), { type: 'approval_decided', approvalId: 'ap-1', decision: 'allowForTask' },
      asked('ap-2'), { type: 'approval_decided', approvalId: 'ap-2', decision: 'deny', note: 'use notes/' },
      asked('ap-3'), { type: 'approval_withdrawn', approvalId: 'ap-3' },
    )));
    expect(out).toContain('✓ Approved for this task · Use a tool: Bash(npm test)');
    expect(out).toContain('⊘ Denied · Use a tool: Bash(npm test) — “use notes/”');
    expect(out).toContain('· Withdrawn · Use a tool: Bash(npm test)');
    expect(out).toContain('ctrl-r remove queued');
  });
});

describe('waiting for approval, from the daemon', () => {
  it('is read off the status update and shown on the task\'s row', () => {
    const actions: Action[] = [];
    const receive = inboundFor({}, (action) => actions.push(action), 's1').execution();
    const wire: unknown = { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null, awaitingApproval: 2 }] };
    receive(wire as WsEvent);
    const update = actions.find((a): a is Extract<Action, { type: 'tasksStatus' }> => a.type === 'tasksStatus');
    expect(update?.updates.t1.awaitingApproval).toBe(2);

    const base = initialState({ sessionId: 's1', focus: 'plan', rows: 20, cols: 180, tasks: [task()] });
    const waiting = reduce(base, update!).state;
    expect(waiting.tasks[0]).toMatchObject({ status: 'in_progress', awaitingApproval: 2 });
    expect(plain(waiting)).toContain('waiting for approval (2) — enter opens it');

    const answered = reduce(waiting, { type: 'tasksStatus', updates: { t1: { status: 'in_progress' } }, sessionId: 's1' }).state;
    expect(answered.tasks[0].awaitingApproval).toBeUndefined();
  });
});

describe('the notice a request raises', () => {
  const arrived = (events: TaskLogEvent[]): Action => ({ type: 'taskLog', taskId: 't1', attempt: 1, events, sessionId: 's1' });

  it('speaks in the planner chat, where the task view is not open', () => {
    const state = initialState({ sessionId: 's1', tasks: [task()] });
    const next = reduce(state, arrived([asked('ap-1')])).state;
    expect(next.conversation.blocks.at(-1)).toMatchObject({ text: '· Task 2 waits for approval: Bash(npm test) — enter on it, then ctrl-y to allow or ctrl-g to deny' });
  });

  it('says nothing in the view already showing the card', () => {
    const state = opened(log());
    const next = reduce(state, arrived([asked('ap-1')])).state;
    expect(next.conversation).toBe(state.conversation);
    expect(next.taskView?.view.blocks.some((b) => b.type === 'approval')).toBe(true);
  });

  it('keeps another task\'s open view where it was', () => {
    const other = { ...log(), taskId: 't9' };
    const state = { ...opened(other, { tasks: [task(), task({ id: 't9', order: 3 })] }), scroll: 4 };
    const next = reduce(state, arrived([asked('ap-1')])).state;
    expect(next.conversation.blocks.length).toBe(state.conversation.blocks.length + 1);
    expect(next.scroll).toBe(4);
  });

  it('speaks once per request, not for the rest of the log', () => {
    const state = initialState({ sessionId: 's1', tasks: [task()] });
    const next = reduce(state, arrived([{ type: 'text', text: 'hi' }, { type: 'approval_decided', approvalId: 'ap-1', decision: 'allow' }])).state;
    expect(next.conversation).toBe(state.conversation);
  });
});

describe('the keys under the waiting request', () => {
  // The body only: the header row repeats the keys, so the frame would pass for the wrong reason.
  // eslint-disable-next-line no-control-regex
  const body = (state: TuiState, cols = 160): string => chatLayout(state, 30, cols).lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

  it('sit under the request, with ctrl-t when the runner offered it', () => {
    const text = body(opened(log(asked('ap-1'))));
    expect(text).toMatch(/Waiting for you[^\n]*\n {2}ctrl-y allow · ctrl-t allow for task · ctrl-g deny/);
  });

  it('leave ctrl-t out when the runner offered no grant', () => {
    const text = body(opened(log(asked('ap-1', false))));
    expect(text).toContain('ctrl-y allow · ctrl-g deny');
    expect(text).not.toContain('ctrl-t');
  });

  it.each([
    ['granted', { type: 'approval_decided', approvalId: 'ap-1', decision: 'allow' } as const],
    ['denied', { type: 'approval_decided', approvalId: 'ap-1', decision: 'deny' } as const],
    ['withdrawn', { type: 'approval_withdrawn', approvalId: 'ap-1' } as const],
  ])('are gone once the request is %s', (_name, settle) => {
    expect(body(opened(log(asked('ap-1'), settle)))).not.toContain('ctrl-y');
  });

  it('keep ctrl-y on a narrow pane', () => {
    expect(body(opened(log(asked('ap-1'))), 24)).toContain('ctrl-y');
  });

  it('are not drawn in the planner chat', () => {
    expect(body(initialState({ sessionId: 's1', rows: 30, cols: 160 }))).not.toContain('ctrl-y');
  });
});

describe('the planner\'s approval modal', () => {
  it('never opens for a runner\'s request', () => {
    const state = initialState({ sessionId: 's1' });
    const message = { type: 'approval_request' as const, id: 'ap-1', kind: 'runner_tool' as const, subject: 'Bash(npm test)', scope: 'Bash' };
    const next = reduce(state, { type: 'sessionMessage', message, sessionId: 's1' }).state;
    expect(next.overlay).toBeNull();
    expect(next.pendingApprovals).toEqual([]);
  });
});

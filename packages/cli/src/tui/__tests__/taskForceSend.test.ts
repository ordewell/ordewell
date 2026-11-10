import { describe, it, expect, vi } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { footerHints, helpLayout } from '../layout';
import { decodeKey } from '../keys';
import { openTaskView } from '../reducers/taskView';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { DaemonError } from '../../apiClient';
import type { Action } from '../reducer';
import type { TaskLogState, TaskView, TuiState } from '../state';

/**
 * Force send from the task view (ADR-0023, F1): ctrl-s interrupts the running
 * step and sends what is queued, the composer text last, all at once — as the
 * planner chat's send now does.
 */

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 2, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', attempted: true,
  ...over,
});

const log = (events: TaskLogEvent[], queuedIndex: number | null = 0): TaskLogState => ({
  taskId: 't1',
  view: replayTaskLog([{ type: 'turn_start', message: 'Do the task' }, ...events]),
  attempts: [1],
  attempt: 1,
  pending: [],
  loaded: true,
  followLatest: true,
  queuedIndex,
});

const queued: TaskLogEvent[] = [
  { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
  { type: 'message_queued', messageId: 'm2', text: 'also tests' },
];

const opened = (tv: TaskLogState = log([]), over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', focus: 'chat', rows: 30, cols: 160, tasks: [task()], taskView: tv, ...over });

const withDraft = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const ctrlS = { type: 'key' as const, key: { name: 'ctrl-s' } };
// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const lastSaid = (state: TuiState) => state.conversation.blocks.at(-1);

describe('ctrl-s in the task view', () => {
  it('decodes from the byte a terminal sends', () => {
    expect(decodeKey('\x13').name).toBe('ctrl-s');
  });

  it('force sends the composer text and empties the composer', () => {
    const { state, effects } = reduce(withDraft(opened(), '  stop, use Postgres '), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'stop, use Postgres' }]);
    expect(state.editor.text).toBe('');
  });

  it('force sends the oldest queued message when the composer is empty, wherever the pick is', () => {
    const { effects } = reduce(opened(log(queued, 1)), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }]);
  });

  it('prefers the composer text over the queued messages', () => {
    const { effects } = reduce(withDraft(opened(log(queued, 1)), 'this one'), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'this one' }]);
  });

  it('starts from the oldest the runner does not have yet, and past one being taken back', () => {
    const handed = log([...queued, { type: 'message_queued', messageId: 'm3', text: 'and docs' }, { type: 'message_handed_over', messageId: 'm1' }], null);
    expect(reduce(opened(handed), ctrlS).effects).toEqual([{ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm2' }]);
    expect(reduce(opened({ ...handed, removing: ['m2'] }), ctrlS).effects).toEqual([{ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm3' }]);
  });

  it('has nothing to send now when the runner already has every queued message', () => {
    const { state, effects } = reduce(opened(log([...queued, { type: 'message_handed_over', messageId: 'm1' }, { type: 'message_handed_over', messageId: 'm2' }])), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: expect.stringMatching(/^Nothing to send now/) });
  });

  it('opens a task with no message picked', () => {
    const state = initialState({ sessionId: 's1', focus: 'chat', rows: 30, cols: 160, tasks: [task()] });
    expect(openTaskView(state, 's1', 't1').state.taskView?.queuedIndex).toBeNull();
  });

  it('goes back to the newest once the queue is sent now', () => {
    const sent = reduce(opened(log(queued, 0)), ctrlS).state;
    expect(sent.taskView?.queuedIndex).toBeNull();
  });

  it('says what to do when there is nothing to send', () => {
    const { state, effects } = reduce(opened(), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: 'Nothing to send now: type a message first.' });
  });

  it('does not force send to a finished task, whose composer continues it', () => {
    const finished = opened(log([]), { tasks: [task({ status: 'completed', continuable: true })] });
    const { state, effects } = reduce(withDraft(finished, 'more'), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: expect.stringMatching(/enter continues it/) });
  });
});

describe('what the task view shows for force send', () => {
  it('keeps the sent-now mark visible when the delivered message wraps', () => {
    const out = plain(opened(log([{ type: 'turn_start', message: 'Interrupt that sleep; call task_complete done with summary TUI_FORCE_OK. Do not perform any other work.', forced: true }])));
    expect(out).toContain('sent now');
    expect(out).toContain('other work.');
  });

  it('names ctrl-s in the header next to interrupt', () => {
    const out = plain(opened());
    expect(out).toContain('ctrl-x stop runner · ctrl-r remove queued · ctrl-s send now');
    expect(out).toContain('esc back');
  });

  it('names Esc and send-all in the header while a message can be taken back, as the planner chat does', () => {
    const out = plain(opened(log(queued, null)));
    expect(out).toContain('esc takes back the newest · ctrl-s sends all now');
    expect(out).not.toContain('esc back');
    const handed = plain(opened(log([...queued, { type: 'message_handed_over', messageId: 'm1' }, { type: 'message_handed_over', messageId: 'm2' }], null)));
    expect(handed).toContain('esc back');
    expect(handed).not.toContain('esc takes back');
  });

  it('puts Esc and send-all on the newest queued message only, and ctrl-r on a picked one', () => {
    const out = plain(opened(log(queued, null)));
    expect(out).toContain('also tests · queued · esc takes back · ctrl-s sends all now');
    expect(out).toMatch(/use Postgres · queued(?! ·)/);
    const picked = plain(opened(log(queued, 0)));
    expect(picked).toContain('use Postgres · queued · ctrl-r removes');
    expect(picked).toContain('also tests · queued · esc takes back · ctrl-s sends all now');
  });

  it('says a handed-over message waits for the current step, and offers no key on it', () => {
    const out = plain(opened(log([...queued, { type: 'message_handed_over', messageId: 'm1' }], 0)));
    expect(out).toMatch(/use Postgres · waiting for the current step(?! ·)/);
    expect(out).not.toContain('handed over');
  });

  it('keeps the send-all hint off the queue while the composer holds text, and names it in the footer', () => {
    const out = plain(withDraft(opened(log(queued, null)), 'one more'));
    expect(out).toMatch(/also tests · queued · esc takes back(?! ·)/);
    expect(footerHints(withDraft(opened(log(queued, null)), 'one more'))).toContain('ctrl-s sends all now');
    expect(footerHints(withDraft(opened(), 'one more'))).toContain('ctrl-s send now');
    expect(footerHints(opened(log(queued, null))).join(' ')).not.toContain('ctrl-s');
  });

  it('shows a forced message first, as sending now', () => {
    const out = plain(opened(log([...queued, { type: 'message_queued', messageId: 'm3', text: 'stop now', forced: true }])));
    expect(out).toMatch(/stop now · sending now…(?! ·)/);
    expect(out.indexOf('stop now')).toBeLessThan(out.indexOf('use Postgres'));
  });

  it('lists ctrl-s and Esc in the help sheet, each task-view line whole', () => {
    const sheet = helpLayout(200, 160).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')); // eslint-disable-line no-control-regex
    expect(sheet).toContain('  ctrl-s sends now: interrupts the running step, then delivers every queued message and the composer text at once, in the order typed');
    expect(sheet).toContain('  esc takes back the newest queued message, into the composer when it is empty, then clears the draft, then returns');
    expect(sheet.some((l) => l.includes('ctrl-r removes the picked one'))).toBe(true);
    expect(sheet.some((l) => l.includes('ctrl-x stops the runner\'s running turn, and it then waits for your next message'))).toBe(true);
  });
});

describe('the force send effects', () => {
  function deps(api: Partial<OrdewellApi>) {
    const actions: Action[] = [];
    const effectDeps = { api, dispatch: (a: Action) => actions.push(a) } as unknown as EffectDeps;
    return { effectDeps, actions };
  }

  it('posts the composer text to the daemon', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Sent now.', payload: { kind: 'message', id: 'm3' } });
    const { effectDeps, actions } = deps({ execute });
    await runEffect({ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'now' }, effectDeps);
    expect(execute).toHaveBeenCalledWith('s1', { command: 'message_task', task: 't1', text: 'now', force: true });
    expect(actions).toEqual([]);
  });

  it('leaves what it says to the timeline, and shows the daemon\'s words when the message was delivered before send now reached it', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Sent.' });
    const { effectDeps, actions } = deps({ execute });
    await runEffect({ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }, effectDeps);
    expect(execute).toHaveBeenCalledWith('s1', { command: 'force_send_queued', task: 't1', id: 'm1' });
    expect(actions).toEqual([]);

    const refusal = new DaemonError('That message to task #1 "Build" was already delivered.', 400, 'refused');
    const late = deps({ execute: vi.fn().mockRejectedValue(refusal) });
    await runEffect({ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }, late.effectDeps);
    expect(late.actions).toEqual([{ type: 'failed', message: refusal.message, code: 'refused' }]);
  });
});

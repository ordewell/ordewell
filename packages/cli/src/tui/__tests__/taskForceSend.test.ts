import { describe, it, expect, vi } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { helpLayout } from '../layout';
import { decodeKey } from '../keys';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import type { Action } from '../reducer';
import type { TaskLogState, TaskView, TuiState } from '../state';

/**
 * Force send from the task view (ADR-0023, F1): ctrl-s interrupts the running
 * step and sends the composer text next — or, with the composer empty, the
 * selected queued message.
 */

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 2, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code',
  ...over,
});

const log = (events: TaskLogEvent[], queuedIndex = 0): TaskLogState => ({
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

  it('force sends the selected queued message when the composer is empty', () => {
    const { effects } = reduce(opened(log(queued, 1)), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm2' }]);
  });

  it('prefers the composer text over the selected queued message', () => {
    const { effects } = reduce(withDraft(opened(log(queued, 1)), 'this one'), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'this one' }]);
  });

  it('leaves a handed-over message with the runner, saying so', () => {
    const { state, effects } = reduce(opened(log([...queued, { type: 'message_handed_over', messageId: 'm1' }])), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: expect.stringMatching(/runner already has that message/) });
  });

  it('says what to do when there is nothing to send', () => {
    const { state, effects } = reduce(opened(), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: expect.stringMatching(/type a message, or pick a queued one/) });
  });

  it('does not force send to a finished task, whose composer continues it', () => {
    const finished = opened(log([]), { tasks: [task({ status: 'completed', continuable: true })] });
    const { state, effects } = reduce(withDraft(finished, 'more'), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: expect.stringMatching(/enter continues it/) });
  });
});

describe('what the task view shows for force send', () => {
  it('names ctrl-s in the header next to interrupt', () => {
    const out = plain(opened());
    expect(out).toContain('ctrl-x interrupt · ctrl-s send now');
  });

  it('shows a forced message first, as sending now', () => {
    const out = plain(opened(log([...queued, { type: 'message_queued', messageId: 'm3', text: 'stop now', forced: true }])));
    expect(out).toContain('stop now · sending now');
    expect(out.indexOf('stop now')).toBeLessThan(out.indexOf('use Postgres'));
  });

  it('lists ctrl-s in the help sheet, each task-view line whole', () => {
    const sheet = helpLayout(200, 160).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')); // eslint-disable-line no-control-regex
    expect(sheet).toContain('  ctrl-s sends now: interrupts the running step, then delivers the composer text — or, with it empty, the selected queued message');
    expect(sheet.some((l) => l.includes('ctrl-r removes it · ctrl-x interrupts'))).toBe(true);
  });
});

describe('the force send effects', () => {
  function deps(api: Partial<OrdewellApi>) {
    const actions: Action[] = [];
    const effectDeps = { api, dispatch: (a: Action) => actions.push(a) } as unknown as EffectDeps;
    return { effectDeps, actions };
  }

  it('posts the composer text to the daemon', async () => {
    const forceSendTaskMessage = vi.fn().mockResolvedValue({ id: 'm3' });
    const { effectDeps, actions } = deps({ forceSendTaskMessage });
    await runEffect({ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'now' }, effectDeps);
    expect(forceSendTaskMessage).toHaveBeenCalledWith('s1', 't1', 'now');
    expect(actions).toEqual([]);
  });

  it('says so when the runner already had the queued message', async () => {
    const forceSendQueuedTaskMessage = vi.fn().mockResolvedValue({ sent: false });
    const { effectDeps, actions } = deps({ forceSendQueuedTaskMessage });
    await runEffect({ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }, effectDeps);
    expect(forceSendQueuedTaskMessage).toHaveBeenCalledWith('s1', 't1', 'm1');
    expect(actions).toEqual([{ type: 'notice', message: expect.stringMatching(/runner already has that message/) }]);
  });
});

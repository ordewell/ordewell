import { describe, it, expect, vi } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { initialState, reduce, type Action } from '../reducer';
import { render } from '../render';
import { chatLayout, footerHints, helpLayout } from '../layout';
import { createInbound } from '../inbound';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { lastMessage } from './chat';
import type { TaskLogState, TaskView, TuiState } from '../state';
import type { WsEvent } from '../../apiClient';

/**
 * A structured task asking a checkpoint question, as the TUI shows and
 * answers it: the whole question as a card in the task view, a notice
 * wherever the user is, and `ctrl-y` / `ctrl-g` / `/checkpoint` to answer.
 */

const QUESTION = 'Drop the users table?\nIt holds 40k rows and no backup exists, so this cannot be undone.';

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 2, title: 'Migrate the schema', type: 'ai', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: QUESTION,
  dependencies: [], assignedRunner: 'claude-code', attempted: true, ...over,
});

const asked = (approvalId: string): TaskLogEvent => ({
  type: 'approval_requested', approvalId, tool: 'Bash', args: '{"command":"npm test"}', allowForTask: true,
});

const log = (...events: TaskLogEvent[]): TaskLogState => ({
  taskId: 't1',
  view: replayTaskLog([{ type: 'turn_start', message: 'Do the task' }, ...events]),
  attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0,
});

const opened = (over: Partial<TuiState> = {}, tv: TaskLogState = log()): TuiState =>
  initialState({ sessionId: 's1', focus: 'chat', rows: 30, cols: 160, tasks: [task()], taskView: tv, ...over });

const withDraft = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const key = (name: string) => ({ type: 'key' as const, key: { name } });
const run = (text: string, state: TuiState) => reduce(withDraft(state, text), key('enter'));

/* eslint-disable no-control-regex */
const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '');
const plain = (state: TuiState): string => render(state).map(strip).join('\n');
const bodyAt = (state: TuiState, cols: number): string[] => chatLayout(state, 60, cols).lines.map(strip);

describe('the checkpoint card', () => {
  it('shows the whole question, with the keys after it', () => {
    const lines = bodyAt(opened(), 80);
    const at = lines.indexOf('◆ Task 2 asks');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines.slice(at, at + 6)).toEqual([
      '◆ Task 2 asks',
      '  Drop the users table?',
      '  It holds 40k rows and no backup exists, so this cannot be undone.',
      '  enter   reply: the task goes on with what you typed',
      '  ctrl-y  approve as is',
      '  ctrl-g  reject (with nothing typed, a plain no)',
    ]);
  });

  it('paints the keys as the choices, in the accent and bold, ahead of grey text', () => {
    const raw = chatLayout(opened(), 60, 80).lines;
    const enter = raw.find((l) => strip(l).startsWith('  enter'));
    expect(enter).toContain('\x1b[1m');
    expect(enter).toMatch(/\x1b\[[0-9;]*menter/);
    expect(raw.findIndex((l) => strip(l).startsWith('  enter'))).toBeLessThan(raw.findIndex((l) => strip(l).startsWith('  ctrl-y')));
  });

  it('wraps a long question at a narrow pane and never cuts a word of it', () => {
    const lines = bodyAt(opened(), 32).join('\n');
    expect(lines.split('\n').every((line) => [...line].length <= 32)).toBe(true);
    const text = lines.slice(lines.indexOf('◆ Task 2 asks')).replace(/\n\s*/g, ' ');
    for (const word of QUESTION.split(/\s+/)) expect(text).toContain(word);
    expect(text).not.toContain('…');
    for (const choice of ['enter', 'ctrl-y', 'ctrl-g', 'what you typed']) expect(text).toContain(choice);
  });

  it('keeps its keys in the pinned header, where a long question cannot push them out', () => {
    const header = chatLayout(opened(), 60, 200).header.map(strip);
    expect(header[0]).toContain('→ Task 2 · Migrate the schema · claude-code ·');
    expect(header[1]).toContain('enter reply · ctrl-y approve · ctrl-g reject · ctrl-x stop runner');
    expect(header[1]).not.toContain('ctrl-s send now');
  });

  it('shows nothing for a task that waits for input, or has left the checkpoint', () => {
    for (const [task_, keys] of [
      [task({ awaitingReason: 'input', checkpoint: undefined }), 'ctrl-r remove queued · ctrl-s send now'],
      [task({ status: 'in_progress', awaitingReason: undefined, checkpoint: undefined }), 'ctrl-x stop runner · ctrl-r remove queued · ctrl-s send now'],
    ] as const) {
      const layout = chatLayout(opened({ tasks: [task_] }), 60, 200);
      expect(layout.lines.join('\n')).not.toContain('asks');
      expect(layout.header[1]).toContain(keys);
    }
  });

  it('does not show a question the daemon has not sent (an older daemon), though the task waits', () => {
    expect(plain(opened({ tasks: [task({ checkpoint: undefined })] }))).not.toContain('Task 2 asks');
  });

  it('draws only for the task in view', () => {
    const state = opened({ tasks: [task({ id: 't9', order: 9 }), task({ id: 't1', status: 'in_progress', awaitingReason: undefined, checkpoint: undefined })] });
    expect(plain(state)).not.toContain('asks');
  });

  it('lists the keys in the help sheet', () => {
    const sheet = helpLayout(200, 160).lines.map(strip);
    expect(sheet.some((l) => l.includes('at a checkpoint, enter replies with what you typed, ctrl-y approves, ctrl-g rejects'))).toBe(true);
    expect(sheet.some((l) => l.includes('/checkpoint <id> approve|reject [reason]'))).toBe(true);
  });
});

describe('a delegated task\'s card', () => {
  it('says a number typed there goes as a raise', () => {
    expect(bodyAt(opened({ tasks: [task({ type: 'delegated' })] }), 120).join('\n')).toContain('approve as is, or with a number typed here as a raise of its tokens');
  });
});

describe('answering from the task view', () => {
  it('ctrl-y approves, carrying no note', () => {
    const { state, effects } = reduce(withDraft(opened(), 'half-typed message'), key('ctrl-y'));
    expect(effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'approve' }]);
    expect(state.editor.text).toBe('half-typed message');
  });

  it('ctrl-y on a delegated task takes a number in the composer as a raise, and empties it', () => {
    const delegated = opened({ tasks: [task({ type: 'delegated' })] });
    const { state, effects } = reduce(withDraft(delegated, ' 800000 '), key('ctrl-y'));
    expect(effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'approve', raiseTokens: 800000 }]);
    expect(state.editor.text).toBe('');
  });

  it('ctrl-y leaves a number alone on any other task, and words alone on a delegated one', () => {
    expect(reduce(withDraft(opened(), '800000'), key('ctrl-y')).effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'approve' }]);
    const delegated = opened({ tasks: [task({ type: 'delegated' })] });
    const { state, effects } = reduce(withDraft(delegated, 'more please'), key('ctrl-y'));
    expect(effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'approve' }]);
    expect(state.editor.text).toBe('more please');
  });

  it('enter on a delegated task answers with an approval, so its subplanner does not read the answer as a refusal', () => {
    const { effects } = run(' Round half away from zero. ', opened({ tasks: [task({ type: 'delegated' })] }));
    expect(effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'approve', reason: 'Round half away from zero.' }]);
  });

  it('ctrl-g rejects with the composer text as the reason, and empties the composer', () => {
    const { state, effects } = reduce(withDraft(opened(), '  keep the table, add a column  '), key('ctrl-g'));
    expect(effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'reject', reason: 'keep the table, add a column' }]);
    expect(state.editor.text).toBe('');
  });

  it('ctrl-g with an empty composer rejects without a reason', () => {
    expect(reduce(opened(), key('ctrl-g')).effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'reject' }]);
  });

  it('enter with text answers the checkpoint with it, and empties the composer', () => {
    const { state, effects } = run('  keep the table, add a column  ', opened());
    expect(effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'reject', reason: 'keep the table, add a column' }]);
    expect(state.editor.text).toBe('');
    expect(state.editor.history.at(-1)).toBe('keep the table, add a column');
  });

  it('enter with an empty composer does nothing: no silent approval', () => {
    for (const text of ['', '   ']) {
      const { state, effects } = run(text, opened());
      expect(effects).toEqual([]);
      expect(state.conversation.blocks).toEqual(opened().conversation.blocks);
    }
  });

  it('enter does not skip a tool request waiting ahead of the checkpoint', () => {
    const { state, effects } = run('use Postgres', opened({}, log(asked('ap-1'))));
    expect(effects).toEqual([]);
    expect(state.editor.text).toBe('use Postgres');
    expect(lastMessage(state)).toMatchObject({ role: 'system', text: expect.stringContaining('tool request') });
  });

  it('enter still sends a message to a task that only waits for input', () => {
    const waiting = opened({ tasks: [task({ awaitingReason: 'input', checkpoint: undefined })] });
    expect(run('go on', waiting).effects).toEqual([{ type: 'sendTaskMessage', sessionId: 's1', taskId: 't1', text: 'go on' }]);
  });

  it('answers a waiting tool request first, and says so; then the checkpoint', () => {
    const both = opened({}, log(asked('ap-1')));
    expect(reduce(both, key('ctrl-y')).effects).toEqual([
      { type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap-1', answer: { decision: 'allow' } },
    ]);
    expect(reduce(withDraft(both, 'no'), key('ctrl-g')).effects).toEqual([
      { type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap-1', answer: { decision: 'deny', note: 'no' } },
    ]);
    const layout = chatLayout(both, 60, 200);
    expect(layout.header.map(strip)[1]).toContain('ctrl-y allow · ctrl-t allow for task · ctrl-g deny (composer text is the note) · then the checkpoint');
    const card = layout.lines.map(strip).join('\n');
    expect(card).toContain('answer the tool request above first');
    expect(card).toContain('enter   reply');

    const settled = opened({}, log(asked('ap-1'), { type: 'approval_decided', approvalId: 'ap-1', decision: 'allow' }));
    expect(reduce(settled, key('ctrl-y')).effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'approve' }]);
  });

  it('keeps ctrl-t for tool requests: it has nothing to grant at a checkpoint', () => {
    const { state, effects } = reduce(opened(), key('ctrl-t'));
    expect(effects).toEqual([]);
    expect(lastMessage(state)).toMatchObject({ text: 'Nothing is waiting for approval.' });
  });

  it('leaves force send, interrupt and the queue keys as they were', () => {
    const state = withDraft(opened(), 'stop, use Postgres');
    expect(reduce(state, key('ctrl-s')).effects).toEqual([{ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'stop, use Postgres' }]);
    expect(reduce(opened(), key('ctrl-x')).effects).toEqual([{ type: 'interruptTask', sessionId: 's1', taskId: 't1' }]);
  });

  it('says so, and sends nothing, once the checkpoint settled or was withdrawn', () => {
    const settled = reduce(opened(), { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }] }, sessionId: 's1' }).state;
    expect(plain(settled)).not.toContain('asks');
    for (const name of ['ctrl-y', 'ctrl-g']) {
      const { state, effects } = reduce(settled, key(name));
      expect(effects).toEqual([]);
      expect(lastMessage(state)).toMatchObject({ text: 'Nothing is waiting for approval.' });
    }

    const withdrawn = reduce(opened(), { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 't1', status: 'awaiting_user', verdict: null, awaitingReason: 'input' }] }, sessionId: 's1' }).state;
    expect(plain(withdrawn)).not.toContain('Task 2 asks');
    expect(reduce(withdrawn, key('ctrl-y')).effects).toEqual([]);
  });
});

describe('the question, from the daemon', () => {
  it('is read off the status update, and gone with the next one that does not carry it', () => {
    const actions: Action[] = [];
    const receive = createInbound((action) => actions.push(action), 's1').receive;
    const wire: unknown = { type: 'status_update', tasks: [{ id: 't1', status: 'awaiting_user', verdict: null, awaitingReason: 'checkpoint', checkpoint: `Drop it?\x1b[2J\n${'x'.repeat(10)}` }] };
    receive(wire as WsEvent);
    const update = actions.find((a): a is Extract<Action, { type: 'runMessage' }> => a.type === 'runMessage' && a.message.type === 'status_update');

    const base = initialState({ sessionId: 's1', focus: 'plan', rows: 20, cols: 180, tasks: [task({ status: 'in_progress', awaitingReason: undefined, checkpoint: undefined })] });
    const waiting = reduce(base, update!).state;
    expect(waiting.tasks[0]).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: `Drop it?\n${'x'.repeat(10)}` });

    const settled = reduce(waiting, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }] }, sessionId: 's1' }).state;
    expect(settled.tasks[0].checkpoint).toBeUndefined();
  });

  it('opens a view that already has the question, though it was asked before the view existed', () => {
    const { state } = reduce(initialState({ sessionId: 's1', focus: 'plan', rows: 30, cols: 100, tasks: [task()] }), { type: 'taskViewRequested', taskId: 't1', sessionId: 's1' });
    expect(plain(state)).toContain('◆ Task 2 asks');
    expect(plain(state)).toContain('It holds 40k rows');
  });
});

describe('the notice in the chat pane', () => {
  it('names a subtask by its dotted reference', () => {
    const base = initialState({ sessionId: 's1', tasks: [
      task({ id: 'parent', order: 2, subtasks: [task({ id: 'child', order: 1 })] }),
    ] });
    const state = reduce(base, { type: 'taskCheckpoint', taskId: 'child', title: 'Migrate the schema', summary: 'Proceed?', sessionId: 's1' }).state;

    expect(lastMessage(state)?.text).toBe('Task #2.1 asks: Proceed?: tab to the plan, select task #2.1 and press enter (or /open #2.1) to answer');
  });

  const asks = (over: Partial<Extract<Action, { type: 'taskCheckpoint' }>> = {}): Action =>
    ({ type: 'taskCheckpoint', taskId: 't1', title: 'Migrate the schema', summary: QUESTION, sessionId: 's1', ...over });

  it('names the task and the first line of its question, and points at the view', () => {
    const state = reduce(initialState({ sessionId: 's1', tasks: [task()] }), asks()).state;
    expect(lastMessage(state)).toMatchObject({ role: 'system', text: 'Task #2 asks: Drop the users table?: tab to the plan, select task #2 and press enter (or /open #2) to answer' });
  });

  it('arrives from the daemon\'s checkpoint message', () => {
    const actions: Action[] = [];
    const receive = createInbound((action) => actions.push(action), 's1').receive;
    const wire: unknown = { type: 'checkpoint', taskId: 't1', taskTitle: 'Migrate the schema', summary: QUESTION };
    receive(wire as WsEvent);
    expect(actions).toEqual([{ type: 'taskCheckpoint', taskId: 't1', title: 'Migrate the schema', summary: QUESTION, sessionId: 's1' }]);
  });
});

describe('/open', () => {
  const planned = (): TuiState => initialState({ sessionId: 's1', tasks: [task()] });

  it('opens the waiting task\'s view from the planner chat, by number', () => {
    const { state, effects } = run('/open 2', planned());
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
    expect(state.taskView?.taskId).toBe('t1');
    expect(state.focus).toBe('chat');
  });

  it('asks which task, and says when there is none', () => {
    expect(lastMessage(run('/open', planned()).state)?.text).toMatch(/Which task\?/);
    expect(lastMessage(run('/open 9', planned()).state)?.text).toMatch(/No task matching "9"/);
  });
});

describe('the composer at a checkpoint', () => {
  it('leaves a runner command to the runner, not to the checkpoint', () => {
    const commands = [{ name: 'compact', description: 'Free up context', kind: 'builtin' as const }];
    const state = opened({}, { ...log(), view: replayTaskLog([{ type: 'turn_start', message: 'Do the task' }, { type: 'runner_loaded', commands, mcpServers: [] }]) });
    expect(run('/compact', state).effects).toEqual([{ type: 'invokeTaskCommand', sessionId: 's1', taskId: 't1', name: 'compact', args: '' }]);
  });

  it('names the choices in the footer, with enter first', () => {
    const hints = footerHints(opened());
    expect(hints.slice(0, 4)).toEqual(['/help', 'enter reply', 'ctrl-y approve', 'ctrl-g reject']);
    expect(footerHints(opened({}, log(asked('ap-1'))))).not.toContain('enter reply');
  });
});

describe('/checkpoint', () => {
  const planned = (): TuiState => initialState({ sessionId: 's1', tasks: [task(), task({ id: 't3', order: 3, title: 'Other', status: 'in_progress', awaitingReason: undefined, checkpoint: undefined })] });

  it('approves by number or id', () => {
    for (const token of ['2', 't1']) {
      expect(run(`/checkpoint ${token} approve`, planned()).effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'approve' }]);
    }
  });

  it('rejects with the rest of the line as the reason, case kept', () => {
    expect(run('/checkpoint 2 reject Keep the Users table', planned()).effects).toEqual([
      { type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'reject', reason: 'Keep the Users table' },
    ]);
    expect(run('/checkpoint 2 reject', planned()).effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'reject' }]);
  });

  it('refuses an approval that carries a note, rather than dropping the note', () => {
    const { state, effects } = run('/checkpoint 2 approve go ahead', planned());
    expect(effects).toEqual([]);
    expect(lastMessage(state)).toMatchObject({ text: expect.stringMatching(/takes no note/) });
  });

  it.each(['/checkpoint', '/checkpoint 2', '/checkpoint 2 maybe'])('prints its usage for %s', (text) => {
    const { state, effects } = run(text, planned());
    expect(effects).toEqual([]);
    expect(lastMessage(state)?.text).toMatch(/Which task\?|Usage: \/checkpoint <id> approve\|reject \[reason\]/);
  });

  it('says a task is not waiting rather than sending the answer', () => {
    const { state, effects } = run('/checkpoint 3 approve', planned());
    expect(effects).toEqual([]);
    expect(lastMessage(state)).toMatchObject({ text: 'Task 3 is not waiting at a checkpoint.' });
  });

  it('is in the command list the help sheet and completion draw from', () => {
    expect(helpLayout(200, 160).lines.map(strip).some((l) => l.includes('/checkpoint <id> approve|reject [reason]'))).toBe(true);
  });
});

describe('the answer effect', () => {
  function deps(api: Partial<OrdewellApi>) {
    const actions: Action[] = [];
    return { effectDeps: { api, dispatch: (a: Action) => actions.push(a) } as unknown as EffectDeps, actions };
  }

  it('approves and rejects over the daemon, the reason going with a rejection', async () => {
    const approveTaskCheckpoint = vi.fn().mockResolvedValue({ ok: true });
    const rejectTaskCheckpoint = vi.fn().mockResolvedValue({ ok: true });
    const { effectDeps, actions } = deps({ approveTaskCheckpoint, rejectTaskCheckpoint });

    await runEffect({ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'approve' }, effectDeps);
    await runEffect({ type: 'answerTaskCheckpoint', sessionId: 's1', taskId: 't1', answer: 'reject', reason: 'keep it' }, effectDeps);

    expect(approveTaskCheckpoint).toHaveBeenCalledWith('s1', 't1', {});
    expect(rejectTaskCheckpoint).toHaveBeenCalledWith('s1', 't1', 'keep it');
    expect(actions).toEqual([]);
  });
});

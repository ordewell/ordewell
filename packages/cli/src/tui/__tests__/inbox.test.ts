import { describe, it, expect, vi } from 'vitest';
import { EMPTY_RUN, type Escalation } from '@ordewell/core';
import { initialState, reduce, type Action } from '../reducer';
import { render } from '../render';
import { width } from '../ansi';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { DaemonError, type WsEvent } from '../../apiClient';
import { inboundFor } from '../inbound';
import type { TaskView, TuiState } from '../state';
import { lastMessage } from './chat';

const failed: Escalation = {
  id: 'failed:task-a:1',
  kind: 'failed',
  task: { id: 'task-a', ref: '1', title: 'Build the thing' },
  attempt: 1,
  reason: 'The build failed.',
  options: [
    { id: 'retry', label: 'Retry' },
    { id: 'skip', label: 'Skip' },
    { id: 'complete', label: 'Mark complete', confirm: 'Mark this task complete without a passing check?' },
  ],
};
const approval: Escalation = {
  id: 'approval:task-b:1:ap1',
  kind: 'approval',
  task: { id: 'task-b', ref: '2', title: 'Second' },
  attempt: 1,
  approval: 'ap1',
  reason: 'Run `rm -rf build` ?',
  options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny', note: 'optional' }],
};
const gate: Escalation = { id: 'merge-all', kind: 'merge-all', reason: 'Landed work waits to be merged.', options: [{ id: 'merge-all', label: 'Merge all' }] };

const task = (over: Partial<TaskView>): TaskView => ({
  id: 'task-a', order: 1, title: 'Build the thing', type: 'ai', status: 'failed', dependencies: [], attempted: true, ...over,
});

const waiting = (escalations: Escalation[], over: Partial<TuiState> = {}): TuiState =>
  initialState({
    sessionId: 's1',
    run: { ...EMPTY_RUN, escalations },
    tasks: [task({}), task({ id: 'task-b', order: 2, title: 'Second' })],
    ...over,
  });

function type(state: TuiState, text: string) {
  const withText = { ...state, editor: { ...state.editor, text, cursor: text.length } };
  return reduce(withText, { type: 'key', key: { name: 'enter' } });
}
const press = (state: TuiState, name: string) => reduce(state, { type: 'key', key: { name } } as Extract<Action, { type: 'key' }>);
const digit = (state: TuiState, n: number) => reduce(state, { type: 'key', key: { name: 'char', char: String(n) } } as Extract<Action, { type: 'key' }>);
const typed = (state: TuiState, text: string) => [...text].reduce((s, char) => reduce(s, { type: 'key', key: { name: 'char', char } } as Extract<Action, { type: 'key' }>).state, state);

/** /inbox, then the escalation at the 1-based row, then the option at its row. */
function answering(escalations: Escalation[], row: number, optionRow: number, over: Partial<TuiState> = {}) {
  const listed = type(waiting(escalations, over), '/inbox').state;
  const opened = digit(listed, row).state;
  return digit(opened, optionRow);
}

const optionsShown = (state: TuiState): string[] => (state.overlay?.kind === 'picker' ? state.overlay.picker.items.map((i) => i.label) : []);
const screen = (state: TuiState): string => render(state).join('\n');

describe('/inbox: the list', () => {
  it('lists what waits, numbered, with the task and the reason', () => {
    const { state } = type(waiting([failed, approval]), '/inbox');
    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'inbox' }, filterable: false } });
    const items = state.overlay?.kind === 'picker' ? state.overlay.picker.items : [];
    expect(items.map((i) => i.id)).toEqual([failed.id, approval.id]);
    expect(items[0].label).toContain('Build the thing');
    expect(items[0].detail).toContain('The build failed.');
  });

  it('says in one line that nothing waits, and opens nothing', () => {
    const { state } = type(waiting([]), '/inbox');
    expect(state.overlay).toBeNull();
    expect(lastMessage(state)).toMatchObject({ text: 'Nothing is waiting on you.' });
  });

  it('is in /help and the completion menu', async () => {
    const { findCommand } = await import('../slash');
    expect(findCommand('inbox')).toMatchObject({ usage: '/inbox', category: 'tasks' });
  });
});


describe('/inbox: answering an entry', () => {
  it('shows the entry\'s options, then the task to open', () => {
    const listed = type(waiting([failed, approval]), '/inbox').state;
    const opened = digit(listed, 1).state;
    expect(optionsShown(opened)).toEqual(['Retry', 'Skip', 'Mark complete', 'Open the task']);
  });

  it('answers through answerEscalation, holding the stream open for an answer that starts a runner', () => {
    const { effects } = answering([failed], 1, 1);
    expect(effects).toEqual([{ type: 'answerEscalation', sessionId: 's1', id: failed.id, option: 'retry', watch: true }]);
  });

  it('does not hold a stream open while the run already has one', () => {
    const { effects } = answering([failed], 1, 1, { status: 'executing' });
    expect(effects).toEqual([{ type: 'answerEscalation', sessionId: 's1', id: failed.id, option: 'retry' }]);
  });

  it('answers a plain option with no question', () => {
    const { effects, state } = answering([failed], 1, 2);
    expect(effects).toEqual([{ type: 'answerEscalation', sessionId: 's1', id: failed.id, option: 'skip' }]);
    expect(state.overlay).toBeNull();
  });

  it('asks the option\'s own question first, and sends confirmed only after the yes', () => {
    const asked = answering([failed], 1, 3);
    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', message: failed.options[2].confirm });

    const yes = press(asked.state, 'enter');
    expect(yes.effects).toEqual([{ type: 'answerEscalation', sessionId: 's1', id: failed.id, option: 'complete', confirmed: true }]);
  });

  it('sends nothing when the question is declined', () => {
    const asked = answering([failed], 1, 3);
    const no = press(asked.state, 'escape');
    expect(no.effects).toEqual([]);
    expect(no.state.overlay).toBeNull();
  });

  it('takes an optional note, sent as typed, and an empty one sends none', () => {
    const asked = answering([approval], 1, 2);
    expect(asked.state.overlay).toMatchObject({ kind: 'prompt', action: { kind: 'escalation-note', required: false } });

    const withNote = press(typed(asked.state, 'too risky'), 'enter');
    expect(withNote.effects).toEqual([{ type: 'answerEscalation', sessionId: 's1', id: approval.id, option: 'deny', note: 'too risky' }]);

    expect(press(asked.state, 'enter').effects).toEqual([{ type: 'answerEscalation', sessionId: 's1', id: approval.id, option: 'deny' }]);
  });

  it('keeps asking for a required note until there is one', () => {
    const needsNote: Escalation = { ...approval, id: 'input:task-b:1', kind: 'input', options: [{ id: 'reply', label: 'Reply', note: 'required' }] };
    const asked = answering([needsNote], 1, 1);
    const empty = press(asked.state, 'enter');
    expect(empty.effects).toEqual([]);
    expect(empty.state.overlay).toMatchObject({ kind: 'prompt' });

    expect(press(typed(asked.state, 'use postgres'), 'enter').effects).toEqual([
      { type: 'answerEscalation', sessionId: 's1', id: needsNote.id, option: 'reply', note: 'use postgres' },
    ]);
  });

  it('opens the entry\'s task as /open does', () => {
    const { effects, state } = answering([failed], 1, 4);
    expect(effects).toEqual([expect.objectContaining({ type: 'openTaskLog', taskId: 'task-a' })]);
    expect(state.taskView?.taskId).toBe('task-a');
  });

  it('has no task to open on the run\'s own entry', () => {
    const listed = type(waiting([gate]), '/inbox').state;
    expect(optionsShown(digit(listed, 1).state)).toEqual(['Merge all']);
  });
});

describe('/inbox: a stale entry', () => {
  it('says plainly that it is gone and sends nothing, when it was answered while the options were open', () => {
    const opened = digit(type(waiting([failed, approval]), '/inbox').state, 1).state;
    const answeredElsewhere = { ...opened, run: { ...opened.run, escalations: [approval] } };
    const refused = digit(answeredElsewhere, 1);
    expect(refused.effects).toEqual([]);
    expect(lastMessage(refused.state)).toMatchObject({ role: 'error', text: expect.stringMatching(/no longer waiting on you/) });
  });

  it('shows the daemon\'s own refusal as it was said', async () => {
    const dispatched: Action[] = [];
    const answerEscalation = vi.fn().mockRejectedValue(new DaemonError('That is no longer waiting on you.', 400, 'refused'));
    const deps = {
      api: { answerEscalation } as unknown as OrdewellApi, workspace: '/ws', port: 1, dispatch: (a: Action) => dispatched.push(a),
    } as unknown as EffectDeps;

    await runEffect({ type: 'answerEscalation', sessionId: 's1', id: failed.id, option: 'retry' }, deps);

    expect(answerEscalation).toHaveBeenCalledWith('s1', { id: failed.id, option: 'retry' });
    expect(dispatched).toEqual([expect.objectContaining({ type: 'failed', message: expect.stringContaining('no longer waiting on you') })]);
  });

  it('reports what the daemon says on success as a notice', async () => {
    const dispatched: Action[] = [];
    const deps = {
      api: {
        answerEscalation: vi.fn().mockResolvedValue({ ok: true, message: 'Retrying task 1.' }),
        getSession: vi.fn().mockResolvedValue({ plan: { tasks: [] } }),
      } as unknown as OrdewellApi,
      workspace: '/ws', port: 1, dispatch: (a: Action) => dispatched.push(a),
    } as unknown as EffectDeps;

    await runEffect({ type: 'answerEscalation', sessionId: 's1', id: failed.id, option: 'retry', note: 'again' }, deps);

    expect(dispatched).toContainEqual({ type: 'notice', message: 'Retrying task 1.' });
  });
});

describe('/inbox: the list follows core', () => {
  const update = (state: TuiState, escalations: Escalation[]): TuiState =>
    reduce(state, { type: 'runSnapshot', view: { ...state.run, escalations }, sessionId: 's1' }).state;

  it('adds a new escalation to an open list, keeping the highlight on the same one', () => {
    const open = press(type(waiting([failed, approval]), '/inbox').state, 'down').state;
    const next = update(open, [gate, failed, approval]);
    const picker = next.overlay?.kind === 'picker' ? next.overlay.picker : null;
    expect(picker?.items.map((i) => i.id)).toEqual([gate.id, failed.id, approval.id]);
    expect(picker?.items[picker.index].id).toBe(approval.id);
  });

  it('closes the list, in one line, when the last one is answered', () => {
    const open = type(waiting([failed]), '/inbox').state;
    const next = update(open, []);
    expect(next.overlay).toBeNull();
    expect(lastMessage(next)).toMatchObject({ text: 'Nothing is waiting on you.' });
  });

  it('returns to the list when the open entry is answered elsewhere', () => {
    const open = digit(type(waiting([failed, approval]), '/inbox').state, 1).state;
    const next = update(open, [approval]);
    expect(next.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'inbox' } } });
  });

  it('follows a status update off the stream, as the daemon sends it', () => {
    const actions: Action[] = [];
    const receive = inboundFor({}, (action) => actions.push(action), 's1').execution();
    const wire: unknown = { type: 'status_update', tasks: [], escalations: [failed, approval] };
    receive(wire as WsEvent);

    const open = type(waiting([failed]), '/inbox').state;
    const next = actions.reduce((s, action) => reduce(s, action).state, open);
    expect(next.overlay?.kind === 'picker' && next.overlay.picker.items).toHaveLength(2);
    expect(screen(next)).toContain('2 waiting: /inbox');
  });
});

describe('the status row count', () => {
  it('shows how many wait, and nothing when none do', () => {
    expect(screen(waiting([failed, approval]))).toContain('2 waiting: /inbox');
    expect(screen(waiting([]))).not.toContain('waiting: /inbox');
  });

  it('goes when the list empties', () => {
    const state = waiting([failed]);
    const emptied = reduce(state, { type: 'runSnapshot', view: { ...state.run, escalations: [] }, sessionId: 's1' }).state;
    expect(screen(state)).toContain('1 waiting: /inbox');
    expect(screen(emptied)).not.toContain('waiting: /inbox');
  });

  it('reads an older daemon\'s run, which has no list, as empty', () => {
    const older = { ...waiting([]).run, escalations: undefined };
    expect(screen({ ...waiting([]), run: older })).not.toContain('waiting: /inbox');
  });

  it('gives way to a standing stop-arm', () => {
    const armed = waiting([failed], { planner: 'planning', stopArmed: true });
    expect(screen(armed)).toContain('Press Esc again to stop');
    expect(screen(armed)).not.toContain('waiting: /inbox');
  });
});

/** No escape, bell or line break survives into a row. */
const isClean = (text: string): boolean => ![...text].some((c) => c === '\u001b' || c === '\u0007' || c === '\n');

describe('runner-controlled text and a narrow terminal', () => {
  const hostile: Escalation = {
    ...failed,
    task: { id: 'task-a', ref: '1', title: 'Evil\u001b[2J title\nsecond line' },
    reason: `Run \u001b]0;pwned\u0007\u001b[31mthis\u001b[0m\n${'very long '.repeat(40)}`,
  };

  it('strips terminal escapes and newlines from the list and the options', () => {
    const listed = type(waiting([hostile]), '/inbox').state;
    const items = listed.overlay?.kind === 'picker' ? listed.overlay.picker.items : [];
    for (const text of [items[0].label, items[0].detail ?? '']) {
      expect(isClean(text)).toBe(true);
    }
    const opened = digit(listed, 1).state;
    const hint = opened.overlay?.kind === 'picker' ? opened.overlay.picker.hint ?? '' : '';
    expect(isClean(hint)).toBe(true);
  });

  it.each([24, 40, 80])('keeps every row within %i columns, list and options', (cols) => {
    const listed = type(waiting([hostile, approval, gate], { cols, rows: 24 }), '/inbox').state;
    for (const line of render(listed)) expect(width(line)).toBeLessThanOrEqual(cols);
    const opened = digit(listed, 1).state;
    for (const line of render(opened)) expect(width(line)).toBeLessThanOrEqual(cols);
  });

  it('clips each entry to the terminal width', () => {
    const listed = type(waiting([hostile], { cols: 30 }), '/inbox').state;
    const items = listed.overlay?.kind === 'picker' ? listed.overlay.picker.items : [];
    expect(width(items[0].detail ?? '')).toBeLessThanOrEqual(30);
    expect(width(items[0].label)).toBeLessThanOrEqual(30);
  });

  it('keeps the status row within a narrow terminal', () => {
    for (const line of render(waiting([failed, approval], { cols: 12, rows: 20 }))) expect(width(line)).toBeLessThanOrEqual(12);
  });
});

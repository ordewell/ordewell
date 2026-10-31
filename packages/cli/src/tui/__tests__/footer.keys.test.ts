import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { stripAnsi } from '../ansi';
import { footerHints, helpLayout, packHints } from '../layout';
import { PLAN_KEYS } from '../planKeys';
import type { TaskView, TuiState } from '../state';

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Add the route', type: 'ai', status: 'pending', dependencies: [], ...over,
});

const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 30, cols: 100, focus: 'plan', tasks, ...over });

const press = (state: TuiState, name: string, char?: string): TuiState =>
  reduce(state, { type: 'key', key: { name, char } }).state;

const SHARED_TAIL = ['→ expand', '? keys', 'tab chat'];

describe('plan footer — the keys that fit the selected task', () => {
  it.each<[string, Partial<TaskView>, Partial<TuiState>, string[]]>([
    ['a pending task', {}, {}, ['f start', 'E run plan', 'o model', 'e effort']],
    ['a task that waits for approval', { waitsForApproval: true }, {}, ['f approve', 'E run plan', 'o model', 'e effort']],
    ['a blocked task', { status: 'blocked' }, {}, ['f start', 's skip', 'E run plan']],
    ['a manual task', { type: 'user' }, {}, ['m done', 'E run plan']],
    ['a cancelled task back to pending', { attempted: true }, {}, ['enter chat', 'f start', 'E run plan', 'o model', 'e effort']],
    ['a running task', { status: 'in_progress', attempted: true }, {}, ['enter chat', 'c cancel']],
    ['a running task during a run', { status: 'in_progress', attempted: true }, { status: 'executing' }, ['enter chat', 'c cancel', 'S stop']],
    ['a task waiting on an approval', { status: 'in_progress', awaitingApproval: 1, attempted: true }, {}, ['enter chat', 'c cancel']],
    ['a task waiting on input', { status: 'awaiting_user', awaitingReason: 'input', attempted: true }, {}, ['enter chat', 'm done', 's skip']],
    ['a task at a checkpoint', { status: 'awaiting_user', awaitingReason: 'checkpoint', attempted: true }, {}, ['enter answer', 'm done', 's skip']],
    [
      'a task paused on a usage limit',
      { status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2999-01-01T00:00:00.000Z', attempted: true },
      {},
      ['c don\'t resume', 's skip', 'enter chat'],
    ],
    [
      'a task paused on a usage limit with a saved session',
      { status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2999-01-01T00:00:00.000Z', continuable: true, attempted: true },
      {},
      ['r resume now', 'c don\'t resume', 's skip', 'enter chat'],
    ],
    [
      'a task waiting for the user after a usage limit',
      { status: 'awaiting_user', awaitingReason: 'usage-limit', continuable: true, attempted: true },
      {},
      ['r resume now', 's skip', 'enter chat'],
    ],
    ['a failed task', { status: 'failed', attempted: true }, {}, ['/retry', 's skip', 'enter chat']],
    ['a started task with no saved attempt ledger', { status: 'completed', attempted: true }, {}, ['m undone', 'enter chat']],
    ['a skipped task that ran', { status: 'skipped', attempted: true }, {}, ['m done', 'enter chat']],
    ['a skipped task that never ran', { status: 'skipped' }, {}, ['m done']],
    ['a completed task that never ran', { status: 'completed' }, {}, ['m undone']],
    [
      'a task with a merge conflict',
      { status: 'awaiting_user', awaitingReason: 'conflict', attempted: true, isolation: { state: 'conflict', branch: 'b', worktree: '/w', repos: [] } },
      {},
      ['x resolve conflict', 'enter chat'],
    ],
    [
      'a conflict a resolver has, which offers no second one',
      { status: 'awaiting_user', awaitingReason: 'conflict', attempted: true, isolation: { state: 'conflict', branch: 'b', worktree: '/w', repos: [], resolver: 't9' } },
      {},
      ['enter chat'],
    ],
    [
      'a repair waiting for a slot, which is no conflict to act on',
      { status: 'pending', attempted: true, isolation: { state: 'conflict', branch: 'b', worktree: '/w', repos: [], repairWaits: 'slot' } },
      {},
      ['c stop repair', 'enter chat'],
    ],
  ])('lists exactly the hints of %s', (_name, over, stateOver, expected) => {
    expect(footerHints(plan([task(over)], stateOver))).toEqual([...expected, ...SHARED_TAIL]);
  });

  it('follows the cursor to another task', () => {
    const state = plan([task(), task({ id: 't2', order: 2, status: 'failed' })]);
    expect(footerHints(state)).toContain('f start');
    expect(footerHints(press(state, 'down'))).toContain('/retry');
  });

  it('keeps the esc hint first while a planning turn is in flight', () => {
    const hints = footerHints(plan([task()], { planner: 'planning' }));
    expect(hints[0]).toBe('esc ×2 stop planning');
    expect(hints[1]).toBe('f start');
  });

  it('leaves the task editor hints alone', () => {
    const editing = plan([task()], {
      expandedTaskId: 't1',
      taskEditor: { text: 'do it', cursor: 5, history: [], historyIndex: 0, draft: '' },
    });
    expect(footerHints(editing)).toEqual(['type to edit prompt', 'pgup/pgdn scroll', 'alt-enter newline', 'enter save', 'esc cancel']);
  });

  it.each([
    ['pending', {}, {}],
    ['running', { status: 'in_progress' }, { status: 'executing' as const }],
    ['failed', { status: 'failed' }, {}],
    ['completed', { status: 'completed' }, {}],
    ['paused on a usage limit', { status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2999-01-01T00:00:00.000Z', continuable: true }, {}],
    ['conflicted', { status: 'awaiting_user', awaitingReason: 'conflict', isolation: { state: 'conflict', branch: 'b', worktree: '/w', repos: [] } }, {}],
  ] as const)('fits one row at 100 columns for a %s task', (_name, over, stateOver) => {
    const state = plan([task({ ...over } as Partial<TaskView>)], { ...stateOver });
    expect(packHints(footerHints(state), 100)).toHaveLength(1);
  });

  it('fits one row at 100 columns even with the planning esc hint', () => {
    expect(packHints(footerHints(plan([task()], { planner: 'planning', queuedPrompts: ['next'] })), 100)).toHaveLength(1);
  });

});

describe('chat footer', () => {
  const chat = (over: Partial<TuiState> = {}): TuiState => initialState({ rows: 24, cols: 100, ...over });

  it('names help, the pane switch and quit, and nothing about scrolling or newlines', () => {
    expect(footerHints(chat())).toEqual(['/help', 'tab plan', 'ctrl-c quit']);
  });
});

describe('the key sheet', () => {
  const sheet = (state: TuiState): string => stripAnsi(render(state).join('\n'));
  const keysOpen = (): TuiState => press(plan([task()], { rows: 60 }), 'char', '?');

  it('opens on ? in the plan pane', () => {
    const state = keysOpen();
    expect(state.overlay).toMatchObject({ kind: 'help', sheet: 'keys' });
    expect(sheet(state)).toContain('Navigation');
  });

  it.each(['enter', 'escape', 'tab', 'right'])('closes on %s', (name) => {
    expect(press(keysOpen(), name).overlay).toBeNull();
  });

  it('closes on a letter key', () => {
    expect(press(keysOpen(), 'char', 'f').overlay).toBeNull();
  });

  it('does not open while a task prompt is being edited — the key types into the draft', () => {
    const editing = plan([task()], {
      expandedTaskId: 't1',
      taskEditor: { text: '', cursor: 0, history: [], historyIndex: 0, draft: '' },
    });
    const typed = press(editing, 'char', '?');
    expect(typed.overlay).toBeNull();
    expect(typed.taskEditor?.text).toBe('?');
  });

  it('does not open from the chat, where ? is text', () => {
    const typed = press(initialState({ rows: 24, cols: 100 }), 'char', '?');
    expect(typed.overlay).toBeNull();
    expect(typed.editor.text).toBe('?');
  });

  it('lists every plan-pane binding with its meaning', () => {
    const text = stripAnsi(helpLayout(200, 200, 'keys').lines.join('\n'));
    // Written out rather than read back from PLAN_KEYS: this is the list of
    // what planPane.ts binds, so a binding added there without a row fails here.
    for (const key of ['R', 'o', 'e', 'M', 'D', 'K', 'O', 'f', 'E', 'S', 'c', 'x', 'm', 's', 'd', 'a', '?', 'tab', 'enter', 'esc', '→']) {
      expect(text, `key ${key}`).toMatch(new RegExp(`^\\s+${key.replace('?', '\\?')}\\s+\\S`, 'm'));
    }
    for (const { keys, meaning } of Object.values(PLAN_KEYS)) {
      expect(text).toContain(keys);
      expect(text).toContain(meaning);
    }
  });

  it('says f approves a task as well as starts it, since it starts once its dependencies finish', () => {
    const text = stripAnsi(helpLayout(200, 200, 'keys').lines.join('\n'));
    expect(text).toMatch(/\bf\s+start the task, approving it if it waits for you; it starts once its dependencies finish/);
  });

  it('groups the keys under navigation, assign, run, status and other', () => {
    const text = stripAnsi(helpLayout(200, 200, 'keys').lines.join('\n'));
    const at = ['Navigation', 'Assign', 'Run', 'Status', 'Other'].map((group) => text.indexOf(group));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('scrolls like the command sheet when the terminal is short', () => {
    const open = press(plan([task()], { rows: 12 }), 'char', '?');
    const down = press(open, 'pagedown');
    expect(down.overlay).toMatchObject({ kind: 'help', sheet: 'keys' });
    expect(down.overlay && 'scroll' in down.overlay ? down.overlay.scroll : 0).toBeGreaterThan(0);
  });

  it('is what the footer picks from: every hint it shows is a row of the sheet', () => {
    const text = stripAnsi(helpLayout(200, 200, 'keys').lines.join('\n'));
    const states = [
      plan([task()]),
      plan([task({ status: 'in_progress' })], { status: 'executing' }),
      plan([task({ status: 'failed' })]),
      plan([task({ status: 'completed' })]),
    ];
    for (const hint of states.flatMap(footerHints)) {
      const keys = hint.split(' ')[0];
      expect(text, hint).toContain(keys);
    }
  });
});

describe('the command sheet', () => {
  it('covers what the chat footer no longer advertises', () => {
    const text = stripAnsi(helpLayout(200, 200).lines.join('\n'));
    expect(text).toContain('pgup/pgdn scroll');
    expect(text).toContain('alt-enter inserts a newline');
    expect(text).toContain('? lists the plan pane');
  });
});

import { describe, it, expect } from 'vitest';
import { EMPTY_RUN, replayTaskLog, type AttemptUsage, type RunnerCommand, type TaskLogEvent } from '@ordewell/core';
import { stripAnsi, width } from '../ansi';
import { chatPaneWidth } from '../geometry';
import { inboundFor } from '../inbound';
import { bodyRows, chatLayout } from '../layout';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { registerSkillCommands } from '../slash';
import type { TaskLogState, TaskView, TuiState } from '../state';
import { chatOf, messagesOf } from './chat';

function run(text: string, overrides: Partial<TuiState> = {}) {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text, cursor: text.length } };
  return reduce(state, { type: 'key', key: { name: 'enter' } });
}

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code',
  attempted: true, ...over,
});

const planned = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', focus: 'plan', tasks: [task()], ...over });

const events: TaskLogEvent[] = [
  { type: 'turn_start', message: 'Do the task' },
  { type: 'text_delta', text: 'Hello from the runner.' },
  { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"npm test"}' },
  { type: 'tool_result', id: 'c1', output: 'ok', success: true },
  { type: 'turn_end', reason: 'completed' },
];

const loaded = (over: Partial<TaskLogState> = {}): TaskLogState => ({
  taskId: 't1',
  view: replayTaskLog(events),
  attempts: [1],
  attempt: 1,
  pending: [],
  loaded: true,
  followLatest: true,
  queuedIndex: 0,
  ...over,
});

const notLoaded = (over: Partial<TaskLogState> = {}): TaskLogState =>
  loaded({ view: replayTaskLog([]), attempts: [], attempt: 0, loaded: false, ...over });

const opened = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', focus: 'chat', tasks: [task()], taskView: loaded(), ...over });

// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const accent = (state: TuiState): boolean => render(state).some((l) => l.includes('\x1b[94m'));
const key = (name: string, char?: string) => ({ name, ...(char ? { char } : {}) });

describe('opening and closing the task view', () => {
  it('enter opens a task without transport info and reads the saved log', () => {
    const { state, effects } = reduce(planned(), { type: 'key', key: key('enter') });
    expect(state.taskView?.taskId).toBe('t1');
    expect(state.focus).toBe('chat');
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
  });

  it('enter on a selected subtask opens its log', () => {
    const base = planned({
      expandedTaskId: 'parent', selectedTask: 1,
      tasks: [task({ id: 'parent', subtasks: [task({ id: 'child' })] })],
    });
    const { state, effects } = reduce(base, { type: 'key', key: key('enter') });
    expect(state.taskView?.taskId).toBe('child');
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 'child' }]);
  });

  it('does not open a chat for a task that never started, and says why in the planner chat', () => {
    const { state, effects } = reduce(planned({ tasks: [task({ status: 'pending', attempted: undefined })] }), { type: 'key', key: key('enter') });
    expect(state.taskView).toBeNull();
    expect(state.focus).toBe('plan');
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)).toMatchObject({
      role: 'error',
      text: 'This task hasn’t started yet. Its chat becomes available when it starts.',
    });
  });

  it.each(['completed', 'skipped'] as const)('does not open an empty chat for a never-run %s task', (status) => {
    const before = planned({ tasks: [task({ status, attempted: undefined })] });
    const { state, effects } = reduce(before, { type: 'key', key: key('enter') });
    expect(state.taskView).toBeNull();
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)?.text).toBe('This task hasn’t started yet. Its chat becomes available when it starts.');
  });

  it('opens a script task\'s own chat once it started, though it has no usage ledger', () => {
    const { state, effects } = reduce(planned({ tasks: [task({ type: 'script', status: 'in_progress', attempted: true, attemptUsage: undefined })] }), { type: 'key', key: key('enter') });
    expect(state.taskView?.taskId).toBe('t1');
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
  });

  it('keeps the chat reachable after a cancel returned it to pending', () => {
    const { state, effects } = reduce(planned({ tasks: [task({ status: 'pending', attempted: true })] }), { type: 'key', key: key('enter') });
    expect(state.taskView?.taskId).toBe('t1');
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
  });

  it('refuses /open for a task that never started, with the same error', () => {
    const base = planned({ focus: 'chat', tasks: [task({ status: 'pending', attempted: undefined })] });
    const { state, effects } = run('/open 1', base);
    expect(state.taskView).toBeNull();
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)?.text).toBe('This task hasn’t started yet. Its chat becomes available when it starts.');
  });

  it('takes a live status update\'s attempted mark before any output or usage arrives', () => {
    const base = planned({ tasks: [task({ status: 'pending', attempted: undefined })] });
    const live = reduce(base, {
      type: 'statusUpdate', sessionId: 's1',
      tasks: [{ id: 't1', status: 'in_progress', verdict: null, attempted: true }],
    }).state;
    expect(live.tasks[0].attempted).toBe(true);
    expect(reduce(live, { type: 'key', key: key('enter') }).effects).toEqual([
      { type: 'openTaskLog', sessionId: 's1', taskId: 't1' },
    ]);
  });

  it('keeps a subtask\'s chat its own', () => {
    const base = planned({
      expandedTaskId: 'parent', selectedTask: 1,
      tasks: [task({ id: 'parent', attempted: true, subtasks: [task({ id: 'child', status: 'pending', attempted: undefined })] })],
    });
    const { state, effects } = reduce(base, { type: 'key', key: key('enter') });
    expect(state.taskView).toBeNull();
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)?.text).toBe('This task hasn’t started yet. Its chat becomes available when it starts.');
  });

  it('t is no longer a plan shortcut', () => {
    const base = planned();
    const { state, effects } = reduce(base, { type: 'key', key: key('char', 't') });
    expect(state).toBe(base);
    expect(effects).toEqual([]);
  });

  it('esc clears a draft first, then closes back to the plan pane', () => {
    const withDraft = { ...opened(), editor: { ...opened().editor, text: 'half typed', cursor: 10 } };
    const cleared = reduce(withDraft, { type: 'key', key: key('escape') }).state;
    expect(cleared.taskView).not.toBeNull();
    expect(cleared.editor.text).toBe('');
    expect(reduce(cleared, { type: 'key', key: key('escape') }).state.taskView).toBeNull();
  });

  it('a new session drops the task view', () => {
    const { state } = reduce(opened(), { type: 'sessionCleared' });
    expect(state.taskView).toBeNull();
  });
});

describe('a refusal while a task view is open', () => {
  const second = task({ id: 't2', order: 2, title: 'Second task', status: 'pending', attempted: undefined });
  const viewing = (over: Partial<TuiState> = {}): TuiState =>
    initialState({ sessionId: 's1', focus: 'plan', selectedTask: 1, tasks: [task(), second], taskView: loaded(), ...over });

  it('shows a refused open in the view\'s notice row, not only the hidden transcript', () => {
    const { state, effects } = reduce(viewing(), { type: 'key', key: key('enter') });

    expect(state.taskView?.taskId).toBe('t1');
    expect(effects).toEqual([]);
    expect(state.taskView?.notice).toContain('hasn’t started');
    expect(plain(state)).toContain('hasn’t started');
  });

  it('shows a refused mark in the view\'s notice row too', () => {
    const done = task({ status: 'completed' });
    const activity = { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: true };
    const before = viewing({ tasks: [done, second], selectedTask: 0, run: { ...EMPTY_RUN, activity } });

    const { state, effects } = reduce(before, { type: 'key', key: key('char', 'm') });

    expect(state.overlay).toBeNull();
    expect(effects).toEqual([]);
    expect(state.taskView?.notice).toContain('Stop the run first');
    expect(plain(state)).toContain('cannot be mark');
  });

  it('dismisses the notice on the next key that is not a scroll, bringing the key hints back', () => {
    const done = task({ status: 'completed' });
    const activity = { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: true };
    const before = viewing({ tasks: [done, second], selectedTask: 0, run: { ...EMPTY_RUN, activity } });
    const refused = reduce(before, { type: 'key', key: key('char', 'm') }).state;
    expect(plain(refused)).not.toContain('ctrl-r remove queued');

    const scrolled = reduce(refused, { type: 'key', key: key('pagedown') }).state;
    expect(scrolled.taskView?.notice).toContain('Stop the run first');

    const next = reduce(scrolled, { type: 'key', key: key('tab') }).state;
    expect(next.taskView?.notice).toBeUndefined();
    expect(plain(next)).toContain('ctrl-r remove queued');
  });
});

describe('a script task\'s view', () => {
  const script = task({ type: 'script', status: 'in_progress', assignedRunner: undefined });
  const scriptOpened = (): TuiState => initialState({
    sessionId: 's1', focus: 'chat', tasks: [script],
    taskView: loaded({ view: { ...replayTaskLog([]), working: true } }),
  });

  it('is output only: no runner, queue or send hints and no composer', () => {
    const frame = plain(scriptOpened());

    expect(frame).not.toContain('ctrl-x stop runner');
    expect(frame).not.toContain('ctrl-r remove queued');
    expect(frame).not.toContain('ctrl-s send now');
    expect(frame).toContain('takes no messages');
    expect(frame).toContain('read-only output');
  });

  it('takes no typed message and sends nothing', () => {
    const before = scriptOpened();

    const typed = reduce(before, { type: 'key', key: key('char', 'h') });

    expect(typed.state.editor.text).toBe('');
    expect(reduce(before, { type: 'key', key: key('enter') }).effects).toEqual([]);
    expect(reduce(before, { type: 'key', key: key('ctrl-s') }).effects).toEqual([]);
  });

  it('dismisses a refusal notice on the next key, since it has no composer to send', () => {
    const base = scriptOpened();
    const refused = { ...base, taskView: { ...base.taskView!, notice: 'This task hasn’t started yet.' } };
    expect(plain(refused)).toContain('This task hasn’t started yet.');

    const scrolled = reduce(refused, { type: 'key', key: key('pagedown') }).state;
    expect(scrolled.taskView?.notice).toBe('This task hasn’t started yet.');

    const cleared = reduce(scrolled, { type: 'key', key: key('char', 'h') }).state;
    expect(cleared.taskView?.notice).toBeUndefined();
    expect(plain(cleared)).toContain('read-only output');
  });
});

describe('loading the log', () => {
  it('keeps approval and turn end batches broadcast after the saved read while opening', () => {
    const loading = opened({ taskView: notLoaded() });
    let buffered = loading;
    const receive = inboundFor({}, (action) => { buffered = reduce(buffered, action).state; }, 's1').execution();
    receive({
      type: 'task_log', taskId: 't1', attempt: 1, stream: 'daemon', seq: 12,
      events: [
        { type: 'text_delta', text: 'live text' },
        { type: 'tool_call', id: 'c', name: 'Bash', args: '{}' },
        { type: 'approval_requested', approvalId: 'ap', tool: 'Bash', args: '{}', allowForTask: false },
        { type: 'turn_end', reason: 'completed' },
      ],
    });
    const caughtUp = reduce(buffered, {
      type: 'taskLogLoaded', taskId: 't1', attempt: 1, attempts: [1],
      events: [{ type: 'turn_start', message: 'go' }], position: { stream: 'daemon', seq: 10 },
    }).state;
    expect(caughtUp.taskView?.view.working).toBe(false);
    expect(caughtUp.taskView?.view.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message', text: 'live text' }),
      expect.objectContaining({ type: 'tool', toolCallId: 'c' }),
    ]));
    expect(reduce(caughtUp, { type: 'key', key: key('ctrl-y') }).effects).toEqual([
      { type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap', answer: { decision: 'allow' } },
    ]);
  });

  it('replays a saved attempt into the view', () => {
    const { state } = reduce(opened({ taskView: notLoaded() }), {
      type: 'taskLogLoaded', taskId: 't1', attempts: [1], attempt: 1, events, sessionId: 's1',
    });
    expect(state.taskView?.view.blocks.length).toBeGreaterThan(0);
    expect(state.taskView?.attempt).toBe(1);
  });

  it('folds live batches after the saved log', () => {
    const after = reduce(opened(), {
      type: 'taskLog', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: ' More.' }], sessionId: 's1',
    }).state;
    const text = after.taskView!.view.blocks.filter((b) => b.type === 'message' && b.role === 'agent').at(-1);
    expect(text?.type === 'message' ? text.text : '').toContain('More.');
  });

  it('buffers a batch until the saved log lands, then drops the copy the file holds', () => {
    const loading = opened({ taskView: notLoaded() });
    const buffered = reduce(loading, {
      type: 'taskLog', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: 'Hello' }], sessionId: 's1',
    }).state;
    expect(buffered.taskView!.view.blocks).toHaveLength(0);

    const caughtUp = reduce(buffered, {
      type: 'taskLogLoaded', taskId: 't1', attempts: [1], attempt: 1, events: [{ type: 'text_delta', text: 'Hello' }], sessionId: 's1',
    }).state;
    const agents = caughtUp.taskView!.view.blocks.filter((b) => b.type === 'message' && b.role === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0].type === 'message' ? agents[0].text : '').toBe('Hello');
  });

  it('applies a buffered batch for a retry that raced the log read', () => {
    const loading = opened({ taskView: notLoaded() });
    const buffered = reduce(loading, {
      type: 'taskLog', taskId: 't1', attempt: 2, events: [{ type: 'turn_start', message: 'again' }], sessionId: 's1',
    }).state;
    const caughtUp = reduce(buffered, {
      type: 'taskLogLoaded', taskId: 't1', attempts: [1], attempt: 1, events, sessionId: 's1',
    }).state;
    expect(caughtUp.taskView?.attempt).toBe(2);
    expect(caughtUp.taskView?.attempts).toEqual([1, 2]);
  });

  it('falls back to the live stream when the saved log cannot be read', () => {
    const loading = opened({ taskView: notLoaded() });
    const buffered = reduce(loading, {
      type: 'taskLog', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: 'Hello' }], sessionId: 's1',
    }).state;
    const failed = reduce(buffered, { type: 'failed', message: 'boom' }).state;
    expect(failed.taskView?.loaded).toBe(true);
    const agents = failed.taskView!.view.blocks.filter((b) => b.type === 'message' && b.role === 'agent');
    expect(agents).toHaveLength(1);
  });

  it('ignores a batch for another task', () => {
    const before = opened();
    const state = reduce(before, {
      type: 'taskLog', taskId: 'other', attempt: 1, events: [{ type: 'text_delta', text: 'nope' }], sessionId: 's1',
    }).state;
    expect(state.taskView).toBe(before.taskView);
  });
});

describe('earlier attempts', () => {
  const twoAttempts = opened({ taskView: loaded({ attempts: [1, 2], attempt: 2 }) });

  it('buffers a picked attempt while its saved read is in flight', () => {
    const picking = reduce(opened({ taskView: loaded({ attempts: [1, 2], attempt: 1 }) }), {
      type: 'key', key: key('alt-right'),
    }).state;
    const streamed = reduce(picking, {
      type: 'taskLog', taskId: 't1', attempt: 2, position: { stream: 'd', seq: 8 },
      events: [{ type: 'text_delta', text: 'live tail' }, { type: 'turn_end', reason: 'completed' }],
    }).state;
    const caughtUp = reduce(streamed, {
      type: 'taskLogLoaded', taskId: 't1', attempt: 2, position: { stream: 'd', seq: 7 },
      events: [{ type: 'turn_start', message: 'again' }],
    }).state;
    expect(plain(caughtUp)).toContain('live tail');
    expect(caughtUp.taskView?.view.working).toBe(false);
    expect(caughtUp.taskView?.followLatest).toBe(true);
  });

  it('alt-left asks for the earlier attempt and stops following the latest', () => {
    const { state, effects } = reduce(twoAttempts, { type: 'key', key: key('alt-left') });
    expect(effects).toEqual([{ type: 'loadTaskAttempt', sessionId: 's1', taskId: 't1', attempt: 1 }]);
    expect(state.taskView?.followLatest).toBe(false);
  });

  it('alt-left at the first attempt says so instead of loading', () => {
    const first = opened({ taskView: loaded({ attempts: [1], attempt: 1 }) });
    const { state, effects } = reduce(first, { type: 'key', key: key('alt-left') });
    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
  });

  it('a live batch for a newer attempt is recorded, not forced onto a pinned view', () => {
    const pinned = opened({ taskView: loaded({ attempts: [1], attempt: 1, followLatest: false }) });
    const state = reduce(pinned, {
      type: 'taskLog', taskId: 't1', attempt: 2, events: [{ type: 'turn_start', message: 'again' }], sessionId: 's1',
    }).state;
    expect(state.taskView?.attempt).toBe(1);
    expect(state.taskView?.attempts).toEqual([1, 2]);
  });
});

describe('talking to the task', () => {
  it('submitting sends the message instead of reaching the planner', () => {
    const { state, effects } = run('use Postgres', opened({ focus: 'chat' }));
    expect(effects).toEqual([{ type: 'sendTaskMessage', sessionId: 's1', taskId: 't1', text: 'use Postgres' }]);
    expect(state.editor.text).toBe('');
  });

  it('ctrl-r removes the selected queued message', () => {
    const queued = opened({
      taskView: loaded({
        view: replayTaskLog([
          ...events,
          { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
          { type: 'message_queued', messageId: 'm2', text: 'also tests' },
        ]),
        queuedIndex: 1,
      }),
    });
    const { effects } = reduce(queued, { type: 'key', key: key('ctrl-r') });
    expect(effects).toEqual([{ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm2' }]);
  });

  it('ctrl-n walks the queue selection, ctrl-p walks it back', () => {
    const queued = opened({
      taskView: loaded({
        view: replayTaskLog([{ type: 'message_queued', messageId: 'm1', text: 'one' }, { type: 'message_queued', messageId: 'm2', text: 'two' }]),
        queuedIndex: 0,
      }),
    });
    const down = reduce(queued, { type: 'key', key: key('ctrl-n') }).state;
    expect(down.taskView?.queuedIndex).toBe(1);
    expect(reduce(down, { type: 'key', key: key('ctrl-p') }).state.taskView?.queuedIndex).toBe(0);
  });

  it('ctrl-x interrupts the running turn', () => {
    const { effects } = reduce(opened(), { type: 'key', key: key('ctrl-x') });
    expect(effects).toEqual([{ type: 'interruptTask', sessionId: 's1', taskId: 't1' }]);
  });

  it('shows queued messages, the selected one highlighted', () => {
    const queued = opened({
      taskView: loaded({
        view: replayTaskLog([{ type: 'message_queued', messageId: 'm1', text: 'use Postgres' }]),
        queuedIndex: 0,
      }),
      cols: 160,
    });
    const out = plain(queued);
    expect(out).toContain('use Postgres');
    expect(out).toContain('queued');
    expect(out).toContain('ctrl-r removes');
  });
});

describe('the task view draws as a runner, not the planner', () => {
  it('takes the accent on the header and the pane border', () => {
    const out = render(opened());
    expect(accent(opened())).toBe(true);
    expect(out.join('\n')).toContain('\x1b[94m');
  });

  it('names the task, its runner and its live state in the header', () => {
    // Wide enough that the header's trailing state word is not truncated away.
    const out = plain(opened({ cols: 160 }));
    expect(out).toContain('→ Task 1');
    expect(out).toContain('Refactor PlanStore');
    // The log ends with a completed turn, so the header reads the saved status;
    // "working" is the header's word only while a turn is live, and ctrl-x
    // stops a turn, so it is named only then.
    expect(out).toContain('claude-code · running');
    expect(out).toContain('ctrl-r remove queued');
    expect(out).not.toContain('ctrl-x stop runner');
  });

  it('says what an awaiting task waits on', () => {
    const waiting = opened({
      tasks: [task({ status: 'awaiting_user', awaitingReason: 'input' })],
      taskView: loaded({ view: replayTaskLog([]) }),
    });
    expect(plain(waiting)).toContain('waiting for your input');
  });

  it('says why a skipped task was skipped', () => {
    const skipped = opened({ tasks: [task({ status: 'skipped', skipReason: 'no GPU on this host' })] });
    expect(plain(skipped)).toContain('skipped: no GPU on this host');
  });

  it('labels the composer with the task number', () => {
    expect(plain(opened())).toContain('→ Task 1');
    expect(plain(opened({ taskView: null }))).not.toContain('→ Task 1');
  });

  it('shows the usage line from the log', () => {
    const withUsage = opened({
      taskView: loaded({
        view: replayTaskLog([
          { type: 'turn_start', message: 'x' },
          { type: 'usage', record: { source: 'claude-code', inputTokens: 12400, outputTokens: 3100 } },
        ]),
      }),
    });
    expect(plain(withUsage)).toContain('ctx 12k');
    expect(plain(withUsage)).not.toMatch(/12\.4k in|3\.1k out/);
  });

  describe('the task usage footer', () => {
    const attempt = (n: number, over: Partial<AttemptUsage> = {}): AttemptUsage => ({
      attempt: n, runner: 'claude-code', startedAt: '', wallTimeMs: 65_000,
      totals: { inputTokens: 12_400, outputTokens: 3_100 }, byModel: [], lastPromptTokens: 36_000, contextWindow: 200_000, ...over,
    });
    const bottom = (state: TuiState, count = 1): string[] => {
      const rows = render(state).map((l) => stripAnsi(l).split('│')[0].trimEnd());
      const end = bodyRows(state);
      return rows.slice(end - count, end);
    };
    const withUsage = (usage: AttemptUsage[], over: Partial<TaskLogState> = {}): TuiState =>
      opened({ tasks: [task({ attemptUsage: usage })], taskView: loaded(over), rows: 24, cols: 100 });

    it('pins the task\'s meter on the pane\'s bottom row, with no token count, no wall time and no cost it was not told', () => {
      expect(bottom(withUsage([attempt(1)]))).toEqual(['ctx 36k (18%)']);
    });

    it('adds a reported cost, and never one row per model', () => {
      const models = [
        { source: 'claude-code', model: 'sonnet-x', totals: { inputTokens: 10_000, outputTokens: 2_000 } },
        { source: 'claude-code', model: 'haiku-y', totals: { inputTokens: 2_400, outputTokens: 1_100 } },
      ];
      const state = withUsage([attempt(1, { byModel: models, totals: { inputTokens: 12_400, outputTokens: 3_100, cachedInputTokens: 2_000, reportedCost: { USD: 0.42 } } })], { view: replayTaskLog([]) });
      expect(bottom(state, 3).map((l) => l.trim()).filter(Boolean).at(-1)).toBe('ctx 36k (18%) · $0.42');
      expect(bottom(state, 3).join('\n')).not.toContain('sonnet-x');
    });

    it('sums every attempt on the latest one, with the meter of its model', () => {
      const state = withUsage([attempt(1, { totals: { reportedCost: { USD: 1 } } }), attempt(2, { totals: { reportedCost: { USD: 0.5 } }, lastPromptTokens: 100_000 })], { attempts: [1, 2], attempt: 2 });
      expect(bottom(state)).toEqual(['ctx 100k (50%) · $1.50']);
    });

    it('shows a past attempt\'s own numbers over the task total', () => {
      const state = withUsage(
        [attempt(1, { totals: { reportedCost: { USD: 1 } } }), attempt(2, { totals: { reportedCost: { USD: 0.5 } }, lastPromptTokens: 100_000 })],
        { attempts: [1, 2], attempt: 1, followLatest: false },
      );
      expect(bottom(state, 2)).toEqual(['attempt 1: ctx 36k (18%) · $1.00', 'task total: ctx 100k (50%) · $1.50']);
    });

    it('keeps a saved log\'s usage line last, so the task view draws it after later text', () => {
      // A log saved before attempt ledgers has only its own reports; the usage
      // line stays pinned below the reply that followed it.
      const view = replayTaskLog([
        { type: 'turn_start', message: 'x' },
        { type: 'usage', record: { source: 'claude-code', inputTokens: 500, outputTokens: 40 } },
        { type: 'text_delta', text: 'Done.' },
        { type: 'text', text: 'Done.' },
        { type: 'turn_end', reason: 'completed' },
      ]);
      expect(view.blocks.at(-1)?.type).toBe('usage');
      const state = withUsage([], { attempts: [1], attempt: 1, view });
      expect(bottom(state)).toEqual(['ctx 500']);
    });

    it('keeps the task total under a log no attempt ledger matches, with the log\'s own usage over it', () => {
      // A log saved before logs and ledgers shared their number: nothing ties it to a ledger.
      const view = replayTaskLog([
        { type: 'turn_start', message: 'x' },
        { type: 'usage', record: { source: 'claude-code', inputTokens: 500, outputTokens: 40 } },
      ]);
      const state = withUsage(
        [attempt(1), attempt(2, { totals: { inputTokens: 900, outputTokens: 80 }, lastPromptTokens: 100_000 })],
        { attempts: [3, 4], attempt: 3, followLatest: false, view },
      );
      expect(bottom(state, 2)).toEqual(['ctx 500', 'task total: ctx 100k (50%)']);
    });

    it('keeps the scroll bound exact with the footer pinned', () => {
      const many = replayTaskLog(Array.from({ length: 40 }, (_, i): TaskLogEvent => ({ type: 'text_delta', text: `line ${i}\n\n` })));
      const state = withUsage([attempt(1)], { view: many });
      const layout = chatLayout(state, bodyRows(state), chatPaneWidth(state));
      expect(layout.footer).toHaveLength(1);
      expect(layout.maxScroll).toBe(layout.lines.length - (bodyRows(state) - layout.header.length - 1));
      expect(render(state)).toHaveLength(state.rows);
    });
  });

  it('draws the tool call and its result', () => {
    const out = plain(opened());
    expect(out).toContain('Bash');
    expect(out).toContain('ok');
  });

  it('never overruns the terminal, at every width', () => {
    const queued = opened({
      taskView: loaded({
        view: replayTaskLog([
          ...events,
          { type: 'message_queued', messageId: 'm1', text: 'a queued message that is quite long and should wrap' },
        ]),
      }),
    });
    for (const cols of [40, 60, 80, 120, 200]) {
      const frame = render({ ...queued, cols, rows: 20 });
      expect(frame).toHaveLength(20);
      for (const line of frame) {
        expect(line.includes('\n')).toBe(false);
        expect(width(line)).toBeLessThanOrEqual(cols);
      }
    }
  });
});

describe('a /command in the task view is the runner\'s own (#66)', () => {
  const commands: RunnerCommand[] = [
    { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', kind: 'builtin' },
    { name: 'clear', description: 'Start a new session with empty context', argumentHint: '[name]', kind: 'builtin', aliases: ['reset', 'new'] },
    { name: 'pingskill', description: 'Reply with the word PONG-SKILL and nothing else. (project)', kind: 'skill' },
  ];
  const withRunner = (over: Partial<TuiState> = {}, taskOver: Partial<TaskView> = {}) => opened({
    tasks: [task(taskOver)],
    taskView: loaded({ view: replayTaskLog([events[0], { type: 'runner_loaded', commands, mcpServers: [] }, ...events.slice(1)]) }),
    ...over,
  });

  it('runs the runner\'s command with what was typed after it, not Ordewell\'s', () => {
    const { state, effects } = run('/compact keep the API notes', withRunner());
    expect(effects).toEqual([{ type: 'invokeTaskCommand', sessionId: 's1', taskId: 't1', name: 'compact', args: 'keep the API notes' }]);
    expect(state.planner).toBe('idle');
    expect(state.editor.text).toBe('');
  });

  it('runs a skill the runner offers, and a command by one of its other names', () => {
    expect(run('/pingskill', withRunner()).effects).toEqual([{ type: 'invokeTaskCommand', sessionId: 's1', taskId: 't1', name: 'pingskill', args: '' }]);
    expect(run('/reset', withRunner()).effects).toEqual([{ type: 'invokeTaskCommand', sessionId: 's1', taskId: 't1', name: 'reset', args: '' }]);
  });

  it('says so in the task view for a name the runner did not report, sending nothing, until the next send', () => {
    const result = run('/retyr now', withRunner({ cols: 200 }));
    expect(result.effects).toEqual([]);
    expect(plain(result.state)).toContain('/retyr is not a command claude-code offers this task: type / to see them.');

    const next = run('/compact', { ...result.state });
    expect(next.effects).toHaveLength(1);
    expect(plain(next.state)).not.toContain('/retyr is not a command');
  });

  it('neither offers nor runs Ordewell\'s run and plan commands from a task\'s chat', () => {
    for (const text of ['/approve', '/help', '/retry 1', '/stop']) {
      const result = run(text, withRunner({ cols: 200 }));
      expect(result.effects).toEqual([]);
      expect(result.state.overlay).toBeNull();
      expect(plain(result.state)).toContain('is not a command claude-code offers this task');
    }
  });

  it('sends a message that starts with a path as a message, not as a command', () => {
    expect(run('/tmp/x.ts is broken', withRunner()).effects).toEqual([{ type: 'sendTaskMessage', sessionId: 's1', taskId: 't1', text: '/tmp/x.ts is broken' }]);
  });

  it('sends a /name as typed to a runner that reported no commands', () => {
    expect(run('/retyr', opened()).effects).toEqual([{ type: 'sendTaskMessage', sessionId: 's1', taskId: 't1', text: '/retyr' }]);
  });

  it('continues a finished task with the command as typed, which its resumed runner reads first', () => {
    const { effects } = run('/compact', withRunner({ status: 'executing' }, { status: 'completed', continuable: true }));
    expect(effects).toEqual([{ type: 'continueTask', sessionId: 's1', taskId: 't1', text: '/compact' }]);
  });

  it('keeps Ordewell\'s commands and skills in the planner chat', () => {
    registerSkillCommands([{ name: 'tdd', description: 'Test first', appliesTo: 'task', userInvocable: true }]);
    try {
      expect(run('/retyr', initialState({ sessionId: 's1', focus: 'chat' })).effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: '/retyr' }]);
      expect(run('/help', initialState({ sessionId: 's1', focus: 'chat' })).state.overlay).toEqual({ kind: 'help', scroll: 0 });
    } finally {
      registerSkillCommands([]);
    }
  });

  it('completes from the runner\'s list alone, and only at the start of the message', () => {
    const typed = (text: string) => {
      const base = withRunner();
      return { ...base, editor: { ...base.editor, text, cursor: text.length } };
    };
    expect(reduce(typed('/pi'), { type: 'key', key: key('tab') }).state.editor.text).toBe('/pingskill ');
    expect(reduce(typed('/app'), { type: 'key', key: key('tab') }).state.editor.text).toBe('/app');
    expect(reduce(typed('then /pi'), { type: 'key', key: key('tab') }).state.editor.text).toBe('then /pi');

    const hint = plain(typed('/c'));
    expect(hint).toContain('compact clear');
    expect(hint).not.toContain('cancel');
  });
});

describe('continuing a finished task (ADR-0018, K1)', () => {
  const finished = (over: Partial<TaskView> = {}) =>
    opened({ focus: 'chat', tasks: [task({ status: 'completed', continuable: true, ...over })] });

  it('labels the composer as a continue', () => {
    expect(plain(finished())).toContain('→ Continue task 1');
    expect(plain(opened())).not.toContain('Continue task');
    expect(plain(finished({ continuable: false }))).not.toContain('Continue task');
  });

  it('submitting continues the task, following the new attempt, instead of messaging a turn', () => {
    const pinned = { ...finished(), taskView: loaded({ attempts: [1, 2], attempt: 1, followLatest: false }) };
    const { state, effects } = run('also handle arrays', pinned);

    expect(effects).toEqual([{ type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'also handle arrays', watch: true }]);
    expect(state.taskView?.followLatest).toBe(true);
    expect(state.editor.text).toBe('');
  });

  it('does not watch a second stream while a run is already executing', () => {
    const { effects } = run('go on', { ...finished(), status: 'executing' });
    expect(effects).toEqual([{ type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'go on' }]);
  });

  it('a started continue is messaged, not continued twice, even before the flag clears', () => {
    const { effects } = run('use Postgres', finished({ status: 'in_progress' }));
    expect(effects).toEqual([{ type: 'sendTaskMessage', sessionId: 's1', taskId: 't1', text: 'use Postgres' }]);
  });

  it('/continue <id> <message> opens the task\'s view and continues it', () => {
    const planner = initialState({ sessionId: 's1', focus: 'chat', tasks: [task({ status: 'failed', continuable: true })] });
    const { state, effects } = run('/continue 1 the tests need Node 22', planner);

    expect(state.taskView?.taskId).toBe('t1');
    expect(effects).toEqual([
      { type: 'openTaskLog', sessionId: 's1', taskId: 't1' },
      { type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'the tests need Node 22', watch: true },
    ]);
  });

  it('/continue without a message says how to use it, in the planner chat', () => {
    const { state, effects } = run('/continue 1', initialState({ sessionId: 's1', focus: 'chat', tasks: [task({ status: 'completed', continuable: true })] }));
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)?.text).toBe('Usage: /continue <id> <message>');
  });

  it('keeps the continuable flag in step with the daemon\'s status', () => {
    const base = initialState({ sessionId: 's1', tasks: [task({ status: 'completed' })] });
    const on = reduce(base, { type: 'statusUpdate', sessionId: 's1', tasks: [{ id: 't1', status: 'completed', verdict: null, continuable: true }] }).state;
    expect(on.tasks[0].continuable).toBe(true);
    const off = reduce(on, { type: 'statusUpdate', sessionId: 's1', tasks: [{ id: 't1', status: 'in_progress', verdict: null }] }).state;
    expect(off.tasks[0].continuable).toBe(false);
  });
});

describe('the task view header says what the task is doing', () => {
  const header = (state: TuiState): string => plain({ ...state, cols: 160 }).split('\n').find((line) => line.includes('→ Task 1 ·')) ?? '';

  it('shows a completed task after its runner was stopped with a turn still open', () => {
    const completed = opened({
      tasks: [task({ status: 'completed', continuable: true })],
      taskView: loaded({ view: replayTaskLog([{ type: 'turn_start', message: 'Do the task' }]) }),
    });

    expect(header(completed)).toContain('· done');
    expect(header(completed)).not.toContain('· working');
  });

  // The header words the store's status the way the plan pane and VS Code do,
  // rather than printing `pending`/`completed`/`skipped` raw.
  it.each([
    ['pending', 'to do'],
    ['approved', 'to do'],
    ['in_progress', 'running'],
    ['completed', 'done'],
    ['failed', 'failed'],
    ['skipped', 'skipped'],
    ['blocked', 'blocked'],
    ['cancelled', 'to do'],
  ])('words the store status %s as %s', (status, word) => {
    const state = opened({ tasks: [task({ status })], taskView: loaded({ view: replayTaskLog([]) }) });
    expect(header(state)).toContain(`· ${word}`);
  });

  it('names a subtask by its dotted reference in the log header', () => {
    const subtask = task({ id: 'child', order: 1, title: 'Inspect greeting' });
    const state = opened({
      tasks: [task({ id: 'parent', order: 2, subtasks: [subtask] })],
      taskView: loaded({ taskId: 'child' }),
      cols: 160,
    });

    expect(plain(state).split('\n')[0]).toContain('→ Task 2.1 · Inspect greeting');
  });

  it.each([
    ['input', 'waiting for your input'],
    ['checkpoint', 'checkpoint'],
    ['conflict', 'merge conflict'],
  ] as const)('an awaiting task waiting on %s reads "%s"', (awaitingReason, label) => {
    const waiting = opened({
      tasks: [task({ status: 'awaiting_user', awaitingReason })],
      taskView: loaded({ view: replayTaskLog([]) }),
    });
    expect(header(waiting)).toContain(`→ Task 1 · Refactor PlanStore · claude-code · ${label}`);
  });

  it('a live turn reads as working, whatever reason is still saved', () => {
    const live = opened({
      tasks: [task({ status: 'awaiting_user', awaitingReason: 'input' })],
      taskView: loaded({ view: replayTaskLog([{ type: 'turn_start', message: 'go on' }]) }),
    });
    expect(header(live)).toContain('· working');
    expect(header(live)).not.toContain('waiting for your input');
  });

  it('a runner request waiting for an answer beats the live turn it stopped', () => {
    const asking = opened({ tasks: [task({ awaitingApproval: 2 })] });
    expect(header(asking)).toContain('· waiting for approval (2)');
  });

  it('a task removed from the plan under an open view says so', () => {
    expect(plain({ ...opened({ tasks: [] }), cols: 160 })).toContain('→ Task ? · (task removed)');
  });

  it('shows which attempt is on screen once there is more than one', () => {
    expect(plain({ ...opened({ taskView: loaded({ attempts: [1, 2, 3], attempt: 2 }) }), cols: 160 })).toContain('alt←/→ attempt 2/3');
    expect(plain({ ...opened(), cols: 160 })).not.toContain('alt←/→');
  });

  it('keeps the accent to the task view: the planner chat never takes it', () => {
    expect(accent(opened())).toBe(true);
    expect(accent(opened({ taskView: null }))).toBe(false);
  });
});

describe('the task view\'s keys at their edges', () => {
  const last = (state: TuiState): string | undefined => messagesOf(state).at(-1)?.text;

  it('alt-left at the first attempt and alt-right at the latest say so', () => {
    const only = opened({ taskView: loaded({ attempts: [1, 2], attempt: 1 }) });
    expect(last(reduce(only, { type: 'key', key: key('alt-left') }).state)).toBe('This is the first attempt.');
    const latest = opened({ taskView: loaded({ attempts: [1, 2], attempt: 2 }) });
    const { state, effects } = reduce(latest, { type: 'key', key: key('alt-right') });
    expect(effects).toEqual([]);
    expect(last(state)).toBe('This is the latest attempt.');
  });

  it('alt-right from an earlier attempt loads the next one', () => {
    const earlier = opened({ taskView: loaded({ attempts: [1, 2], attempt: 1, followLatest: false }) });
    expect(reduce(earlier, { type: 'key', key: key('alt-right') }).effects).toEqual([
      { type: 'loadTaskAttempt', sessionId: 's1', taskId: 't1', attempt: 2 },
    ]);
  });

  it('ctrl-r with nothing queued says so and sends nothing', () => {
    const { state, effects } = reduce(opened(), { type: 'key', key: key('ctrl-r') });
    expect(effects).toEqual([]);
    expect(last(state)).toBe('No queued message to remove.');
  });

  it('ctrl-n with nothing queued leaves the selection alone', () => {
    const { state, effects } = reduce(opened(), { type: 'key', key: key('ctrl-n') });
    expect(effects.some((e) => e.type === 'removeTaskMessage')).toBe(false);
    expect(state.taskView?.queuedIndex).toBe(0);
  });

  it('ctrl-x interrupts even while nothing is queued, and ctrl-r never interrupts', () => {
    expect(reduce(opened(), { type: 'key', key: key('ctrl-x') }).effects).toEqual([{ type: 'interruptTask', sessionId: 's1', taskId: 't1' }]);
    expect(reduce(opened(), { type: 'key', key: key('ctrl-r') }).effects.some((e) => e.type === 'interruptTask')).toBe(false);
  });

  it('takes no task keys once the session is gone', () => {
    const { effects } = reduce(opened({ sessionId: null }), { type: 'key', key: key('ctrl-x') });
    expect(effects.some((e) => e.type === 'interruptTask')).toBe(false);
  });
});

describe('the queue as the runner takes messages off it', () => {
  const twoQueued = () => opened({
    taskView: loaded({
      view: replayTaskLog([
        { type: 'turn_start', message: 'Do the task' },
        { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
        { type: 'message_queued', messageId: 'm2', text: 'also tests' },
      ]),
      queuedIndex: 1,
    }),
  });

  it('moves the selection back when the selected message is taken back', () => {
    const state = reduce(twoQueued(), {
      type: 'taskLog', taskId: 't1', attempt: 1, events: [{ type: 'message_removed', messageId: 'm2' }], sessionId: 's1',
    }).state;
    expect(state.taskView?.view.queued.map((m) => m.id)).toEqual(['m1']);
    expect(state.taskView?.queuedIndex).toBe(0);
    expect(plain(state)).not.toContain('also tests');
  });

  it('drops a message from the queue once a turn delivers it, and shows it as sent', () => {
    const state = reduce(twoQueued(), {
      type: 'taskLog', taskId: 't1', attempt: 1, sessionId: 's1',
      events: [{ type: 'turn_end', reason: 'completed' }, { type: 'turn_start', message: 'use Postgres', messageId: 'm1' }],
    }).state;
    expect(state.taskView?.view.queued.map((m) => m.id)).toEqual(['m2']);
    expect(state.taskView?.queuedIndex).toBe(0);
    const out = plain(state);
    expect(out).toContain('use Postgres');
    expect(out).toContain('also tests · queued');
  });
});

describe('following the live attempt', () => {
  it('starts a task with no saved log empty, and takes up its first attempt when it streams', () => {
    const none = reduce(opened({ taskView: notLoaded() }), {
      type: 'taskLogLoaded', taskId: 't1', attempts: [], attempt: 0, events: [], sessionId: 's1',
    }).state;
    expect(none.taskView).toMatchObject({ loaded: true, attempt: 0, attempts: [] });
    expect(none.taskView?.view.blocks).toEqual([]);

    const streaming = reduce(none, {
      type: 'taskLog', taskId: 't1', attempt: 1, events: [{ type: 'turn_start', message: 'Do the task' }], sessionId: 's1',
    }).state;
    expect(streaming.taskView).toMatchObject({ attempt: 1, attempts: [1] });
    expect(streaming.taskView?.view.working).toBe(true);
  });

  it('swaps to a retry\'s new attempt while following, and ignores what the old one still sends', () => {
    const retried = reduce(opened(), {
      type: 'taskLog', taskId: 't1', attempt: 2, events: [{ type: 'turn_start', message: 'again' }], sessionId: 's1',
    }).state;
    expect(retried.taskView).toMatchObject({ attempt: 2, attempts: [1, 2] });
    expect(retried.taskView?.view.blocks.filter((b) => b.type === 'tool')).toEqual([]);

    const late = reduce(retried, {
      type: 'taskLog', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: 'from before' }], sessionId: 's1',
    }).state;
    expect(late.taskView).toBe(retried.taskView);
  });
});

describe('esc back to the plan pane', () => {
  const two = [task({ id: 'a' }), task({ id: 'b', order: 2 })];

  it('focuses the plan with the cursor on the task that was open', () => {
    const state = opened({ tasks: two, taskView: loaded({ taskId: 'b' }), selectedTask: 0 });
    const back = reduce(state, { type: 'key', key: key('escape') }).state;
    expect(back.taskView).toBeNull();
    expect(back.focus).toBe('plan');
    expect(back.selectedTask).toBe(1);
  });

  it('reveals a collapsed parent and selects the subtask', () => {
    const tasks = [task({ id: 'p', subtasks: [task({ id: 'c' })] }), task({ id: 'q', order: 2 })];
    const state = opened({ tasks, taskView: loaded({ taskId: 'c' }), selectedTask: 1, expandedTaskId: null });
    const back = reduce(state, { type: 'key', key: key('escape') }).state;
    expect(back.expandedTaskId).toBe('p');
    expect(back.selectedTask).toBe(1);
  });

  it('only focuses the plan when the task is gone', () => {
    const state = opened({ tasks: two, taskView: loaded({ taskId: 'zzz' }), selectedTask: 1 });
    const back = reduce(state, { type: 'key', key: key('escape') }).state;
    expect(back.focus).toBe('plan');
    expect(back.selectedTask).toBe(1);
  });

  it('an open overlay takes the esc first', () => {
    const state = opened({ overlay: { kind: 'help', scroll: 0, sheet: 'keys' } });
    const back = reduce(state, { type: 'key', key: key('escape') }).state;
    expect(back.overlay).toBeNull();
    expect(back.taskView).not.toBeNull();
  });
});

describe('esc back from a task log, planner chat', () => {
  it('puts the planner conversation back in the pane, and the composer back on the planner', () => {
    const withPlanner = opened({ conversation: chatOf(['planner', 'Which database should the cache use?']) });
    expect(plain(withPlanner)).not.toContain('Which database should the cache use?');

    const back = reduce(withPlanner, { type: 'key', key: key('escape') }).state;
    expect(back.taskView).toBeNull();
    const out = plain(back);
    expect(out).toContain('Which database should the cache use?');
    expect(out).not.toContain('→ Task 1');

    const { effects } = run('Redis', back);
    expect(effects.some((e) => e.type === 'sendTaskMessage')).toBe(false);
  });
});


it('shows an undelivered message in the task log and removes it from the queue', () => {
  const before = opened({ taskView: loaded({ view: replayTaskLog([
    { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
  ]) }) });
  const { state } = reduce(before, {
    type: 'taskLog', taskId: 't1', attempt: 1, sessionId: 's1',
    events: [{ type: 'message_undelivered', messageId: 'm1', text: 'use Postgres' }],
  });
  expect(state.taskView?.view.queued).toEqual([]);
  expect(plain(state)).toContain('use Postgres · not delivered');
});

it('shows the completion reminder as Ordewell\'s line, not on the user\'s band', () => {
  const state = opened({ taskView: loaded({ view: replayTaskLog([
    { type: 'turn_start', message: 'Do the task' },
    { type: 'turn_end', reason: 'completed' },
    { type: 'turn_start', message: 'Call task_complete.', from: 'ordewell' },
  ]) }) });
  expect(state.taskView?.view.blocks.at(-1)).toMatchObject({ role: 'system' });
  expect(plain(state)).toContain('Ordewell: Call task_complete.');
});

describe('a message the runner reads mid-turn (ADR-0023)', () => {
  const handedOver = () => opened({
    taskView: loaded({
      view: replayTaskLog([
        { type: 'turn_start', message: 'Do the task' },
        { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"sleep 20"}' },
        { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
        { type: 'message_queued', messageId: 'm2', text: 'also tests' },
        { type: 'message_handed_over', messageId: 'm1' },
      ]),
      queuedIndex: 0,
    }),
  });

  it('shows a handed-over message as waiting for the current step, and ctrl-r leaves it with the runner', () => {
    const out = plain({ ...handedOver(), cols: 160 });
    expect(out).toContain('use Postgres · waiting for the current step');
    expect(out).not.toContain('use Postgres · queued');
    expect(out).toContain('also tests · queued');

    const { state, effects } = reduce(handedOver(), { type: 'key', key: key('ctrl-r') });
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)).toMatchObject({ role: 'system', text: 'The runner already has that message; it can no longer be taken back.' });
  });

  it('draws the message in the transcript after the step it followed, and takes it off the queue', () => {
    const state = reduce(handedOver(), {
      type: 'taskLog', taskId: 't1', attempt: 1, sessionId: 's1',
      events: [
        { type: 'tool_result', id: 'c1', output: '', success: true },
        { type: 'message_delivered', messageId: 'm1', text: 'use Postgres' },
        { type: 'text', text: 'Switching to Postgres.' },
      ],
    }).state;

    expect(state.taskView?.view.queued.map((m) => m.id)).toEqual(['m2']);
    const out = plain(state);
    expect(out).not.toContain('handed over');
    const lines = out.split('\n');
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(at('sleep 20')).toBeGreaterThanOrEqual(0);
    expect(at('use Postgres')).toBeGreaterThan(at('sleep 20'));
    expect(at('Switching to Postgres.')).toBeGreaterThan(at('use Postgres'));
    expect(state.taskView?.view.working).toBe(true);
  });
});

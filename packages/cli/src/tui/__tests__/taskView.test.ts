import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { width } from '../ansi';
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
  id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', ...over,
});

const structured = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', focus: 'plan', tasks: [task({ transport: { kind: 'structured' } })], ...over });

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
  initialState({ sessionId: 's1', focus: 'chat', tasks: [task({ transport: { kind: 'structured' } })], taskView: loaded(), ...over });

// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const accent = (state: TuiState): boolean => render(state).some((l) => l.includes('\x1b[94m'));
const key = (name: string, char?: string) => ({ name, ...(char ? { char } : {}) });

describe('opening and closing the task view', () => {
  it('t on a structured task opens it and reads the saved log', () => {
    const { state, effects } = reduce(structured(), { type: 'key', key: key('char', 't') });
    expect(state.taskView?.taskId).toBe('t1');
    expect(state.focus).toBe('chat');
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
  });

  it('/terminal on a structured task opens it too', () => {
    const { state, effects } = run('/terminal 1', structured({ focus: 'chat' }));
    expect(state.taskView?.taskId).toBe('t1');
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
  });

  it('a terminal task still opens its OS terminal', () => {
    const terminal = initialState({ sessionId: 's1', focus: 'plan', tasks: [task({ transport: { kind: 'terminal' } })] });
    expect(reduce(terminal, { type: 'key', key: key('char', 't') }).effects).toEqual([
      { type: 'openTaskTerminal', sessionId: 's1', taskId: 't1' },
    ]);
  });

  it('esc clears a draft first, then closes back to the planner chat', () => {
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

describe('loading the log', () => {
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
    const out = plain(opened());
    expect(out).toContain('→ Task 1');
    expect(out).toContain('Refactor PlanStore');
    expect(out).toContain('claude-code');
    expect(out).toContain('working');
    expect(out).toContain('ctrl-r remove queued');
    expect(out).toContain('ctrl-x interrupt');
  });

  it('says what an awaiting task waits on', () => {
    const waiting = opened({
      tasks: [task({ transport: { kind: 'structured' }, status: 'awaiting_user', awaitingReason: 'input' })],
      taskView: loaded({ view: replayTaskLog([]) }),
    });
    expect(plain(waiting)).toContain('waiting for your input');
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
    expect(plain(withUsage)).toContain('12.4k in');
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

describe('an unknown /name in the task view', () => {
  const unknown = (state: TuiState) => {
    const result = run('/retyr', state);
    expect(result.effects).toEqual([]);
    expect(messagesOf(result.state).at(-1)?.text).toContain('Unknown command: /retyr');
    return result;
  };

  it('does not continue a finished task', () => {
    unknown(opened({ focus: 'chat', tasks: [task({ status: 'completed', transport: { kind: 'structured' }, continuable: true })] }));
  });

  it('is not delivered to a running task', () => {
    unknown(opened({ focus: 'chat' }));
  });

  it('is still passed through in planner chat', () => {
    const { effects } = run('/retyr', initialState({ sessionId: 's1', focus: 'chat' }));
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: '/retyr' }]);
  });
});

describe('a skill name in the task view', () => {
  beforeEach(() => registerSkillCommands([{ name: 'tdd', description: 'Test first', appliesTo: 'task', userInvocable: true }]));
  afterEach(() => registerSkillCommands([]));

  it('is refused with where task skills are set, not as an unknown command', () => {
    const result = run('/tdd', opened({ focus: 'chat' }));
    const text = messagesOf(result.state).at(-1)?.text;
    expect(result.effects).toEqual([]);
    expect(text).toContain("skills aren't loaded in a task's chat");
    expect(text).toContain('/task-skills <id> <name>');
    expect(text).not.toContain('Unknown command');
  });
});

describe('continuing a finished task (ADR-0018, K1)', () => {
  const finished = (over: Partial<TaskView> = {}) =>
    opened({ focus: 'chat', tasks: [task({ status: 'completed', transport: { kind: 'structured' }, continuable: true, ...over })] });

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
    const planner = initialState({ sessionId: 's1', focus: 'chat', tasks: [task({ status: 'failed', transport: { kind: 'structured' }, continuable: true })] });
    const { state, effects } = run('/continue 1 the tests need Node 22', planner);

    expect(state.taskView?.taskId).toBe('t1');
    expect(effects).toEqual([
      { type: 'openTaskLog', sessionId: 's1', taskId: 't1' },
      { type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'the tests need Node 22', watch: true },
    ]);
  });

  it('/continue without a message says how to use it', () => {
    const { state, effects } = run('/continue 1', finished());
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)?.text).toBe('Usage: /continue <id> <message>');
  });

  it('keeps the continuable flag in step with the daemon\'s status', () => {
    const base = initialState({ sessionId: 's1', tasks: [task({ status: 'completed', transport: { kind: 'structured' } })] });
    const on = reduce(base, { type: 'tasksStatus', sessionId: 's1', updates: { t1: { status: 'completed', transport: { kind: 'structured' }, continuable: true } } }).state;
    expect(on.tasks[0].continuable).toBe(true);
    const off = reduce(on, { type: 'tasksStatus', sessionId: 's1', updates: { t1: { status: 'in_progress', transport: { kind: 'structured' } } } }).state;
    expect(off.tasks[0].continuable).toBe(false);
  });
});

describe('the task view header says what the task is doing', () => {
  const header = (state: TuiState): string => plain({ ...state, cols: 160 }).split('\n').find((line) => line.includes('→ Task 1 ·')) ?? '';

  it.each([
    ['input', 'waiting for your input'],
    ['checkpoint', 'checkpoint'],
    ['conflict', 'merge conflict'],
  ] as const)('an awaiting task waiting on %s reads "%s"', (awaitingReason, label) => {
    const waiting = opened({
      tasks: [task({ transport: { kind: 'structured' }, status: 'awaiting_user', awaitingReason })],
      taskView: loaded({ view: replayTaskLog([]) }),
    });
    expect(header(waiting)).toContain(`→ Task 1 · Refactor PlanStore · claude-code · ${label}`);
  });

  it('a live turn reads as working, whatever reason is still saved', () => {
    const live = opened({
      tasks: [task({ transport: { kind: 'structured' }, status: 'awaiting_user', awaitingReason: 'input' })],
      taskView: loaded({ view: replayTaskLog([{ type: 'turn_start', message: 'go on' }]) }),
    });
    expect(header(live)).toContain('· working');
    expect(header(live)).not.toContain('waiting for your input');
  });

  it('a runner request waiting for an answer beats the live turn it stopped', () => {
    const asking = opened({ tasks: [task({ transport: { kind: 'structured' }, awaitingApproval: 2 })] });
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

describe('esc back to the planner', () => {
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

  it('shows a handed-over message as handed over, and ctrl-r leaves it with the runner', () => {
    const out = plain(handedOver());
    expect(out).toContain('use Postgres · handed over');
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

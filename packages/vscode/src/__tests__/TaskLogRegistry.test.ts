import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createTask, type PendingApproval, type SessionMessage, type Task, type TaskLogEvent } from '@ordewell/core';
import { TaskLogRegistry } from '../providers/TaskLogRegistry';
import type { HostToTaskLog } from '../shared/taskLogProtocol';
import { __panels, __resetPanels } from '../test/vscode.mock';

const createWebviewPanel = vscode.window.createWebviewPanel as unknown as ReturnType<typeof vi.fn>;

const attemptOne: TaskLogEvent[] = [
  { type: 'turn_start', message: 'do it' },
  { type: 'text', text: 'working…' },
  { type: 'turn_end', reason: 'completed' },
];
const attemptTwo: TaskLogEvent[] = [
  { type: 'turn_start', message: 'again' },
  { type: 'text', text: 'second try' },
];

function harness(attempts: Record<number, TaskLogEvent[]> = { 1: attemptOne }) {
  const task = createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'claude-code', status: 'in_progress' });
  const session = {
    taskLogAttempts: vi.fn(() => Object.keys(attempts).map(Number).sort((a, b) => a - b)),
    taskLog: vi.fn((_taskId: string, attempt: number) => attempts[attempt] ?? []),
    sendTaskMessage: vi.fn(() => 'm1'),
    removeQueuedTaskMessage: vi.fn(() => true),
    forceSendTaskMessage: vi.fn(() => 'm2'),
    forceSendQueuedTaskMessage: vi.fn(() => true),
    interruptTask: vi.fn(async () => {}),
    continueTask: vi.fn(async () => {}),
    pending: [] as PendingApproval[],
    outstandingApprovals: vi.fn((): PendingApproval[] => session.pending),
    resolveApproval: vi.fn(() => true),
  };
  const registry = new TaskLogRegistry({
    extensionUri: vscode.Uri.file('/ext'),
    session: () => session,
    getTask: () => task as Task,
    log: vi.fn(),
  });
  return { registry, session, task };
}

/** The messages one panel's webview has been sent, oldest first. */
function posted(panel: (typeof __panels)[number]): HostToTaskLog[] {
  return panel.webview.postMessage.mock.calls.map((call) => call[0] as HostToTaskLog);
}

describe('the task-log registry (ADR-0018, V1)', () => {
  beforeEach(() => {
    __resetPanels();
    createWebviewPanel.mockClear();
  });

  it('never opens a tab by itself, and opens one titled for the task on demand', () => {
    const h = harness();
    expect(createWebviewPanel).not.toHaveBeenCalled();

    h.registry.open('t1');

    expect(createWebviewPanel).toHaveBeenCalledWith('ordewellTaskLog', 'Task 1 · Parse JSON', vscode.ViewColumn.Active, expect.anything());
    expect(__panels).toHaveLength(1);
  });

  it('focuses the open tab instead of opening a second', () => {
    const h = harness();
    h.registry.open('t1');
    h.registry.open('t1');

    expect(__panels).toHaveLength(1);
    expect(__panels[0].reveal).toHaveBeenCalled();
  });

  it('does nothing for a task that is not in the plan', () => {
    const registry = new TaskLogRegistry({
      extensionUri: vscode.Uri.file('/ext'),
      session: () => ({
        taskLogAttempts: () => [], taskLog: () => [], sendTaskMessage: () => 'm', removeQueuedTaskMessage: () => false, interruptTask: async () => {},
        forceSendTaskMessage: () => 'm', forceSendQueuedTaskMessage: () => false,
        continueTask: async () => {}, outstandingApprovals: () => [], resolveApproval: () => false,
      }),
      getTask: () => undefined,
      log: vi.fn(),
    });

    registry.open('missing');

    expect(createWebviewPanel).not.toHaveBeenCalled();
  });

  it('loads the newest saved attempt when the webview is ready', () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    const init = posted(__panels[0])[0];
    expect(init).toMatchObject({ type: 'init', status: { attempts: [1, 2], attempt: 2, title: 'Parse JSON', runner: 'claude-code' } });
    expect(init.type === 'init' && init.blocks.map((b) => b.type)).toEqual(['message', 'message']);
    expect(h.session.taskLog).toHaveBeenCalledWith('t1', 2);
  });

  it('folds a live batch in as a patch, and follows a new attempt', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: ' more' }] });
    expect(posted(__panels[0]).some((m) => m.type === 'patch')).toBe(true);

    // A retry's new attempt is followed while the user is on the live one.
    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 2, events: [{ type: 'turn_start', message: 'again' }] });
    const last = posted(__panels[0]).at(-1);
    expect(last).toMatchObject({ type: 'init', status: { attempt: 2 } });
  });

  it('switches to an earlier attempt on request', () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    __panels[0].__receive({ type: 'selectAttempt', attempt: 1 });

    expect(h.session.taskLog).toHaveBeenCalledWith('t1', 1);
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { attempt: 1 } });
  });

  it('routes a message, a removal and an interrupt to the Session', async () => {
    const h = harness();
    h.registry.open('t1');

    __panels[0].__receive({ type: 'sendTaskMessage', text: 'use Postgres' });
    __panels[0].__receive({ type: 'removeQueuedTaskMessage', id: 'q1' });
    __panels[0].__receive({ type: 'interruptTask' });

    expect(h.session.sendTaskMessage).toHaveBeenCalledWith('t1', 'use Postgres');
    expect(h.session.removeQueuedTaskMessage).toHaveBeenCalledWith('t1', 'q1');
    await vi.waitFor(() => expect(h.session.interruptTask).toHaveBeenCalledWith('t1'));
  });

  it('routes a force send, new or queued, to the Session (ADR-0023, F1)', () => {
    const h = harness();
    h.registry.open('t1');

    __panels[0].__receive({ type: 'sendTaskMessageNow', text: 'stop, use Postgres' });
    __panels[0].__receive({ type: 'sendQueuedTaskMessageNow', id: 'q1' });

    expect(h.session.forceSendTaskMessage).toHaveBeenCalledWith('t1', 'stop, use Postgres');
    expect(h.session.forceSendQueuedTaskMessage).toHaveBeenCalledWith('t1', 'q1');
  });

  it('says so when the runner already had the message it was asked to send now, and shows a refusal', () => {
    const h = harness();
    h.session.forceSendQueuedTaskMessage.mockReturnValue(false);
    h.session.forceSendTaskMessage.mockImplementation(() => { throw new Error('Task is not running, so there is no turn to send a message to.'); });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    __panels[0].__receive({ type: 'sendQueuedTaskMessageNow', id: 'q1' });
    __panels[0].__receive({ type: 'sendTaskMessageNow', text: 'now' });

    expect(posted(__panels[0])).toEqual([
      { type: 'showError', error: expect.stringMatching(/runner already has that message/) },
      { type: 'showError', error: expect.stringMatching(/no turn to send a message to/) },
    ]);
  });

  it('shows the Session\u2019s refusal of a task that cannot take a message', () => {
    const h = harness();
    h.session.sendTaskMessage.mockImplementation(() => { throw new Error('Task is not running.'); });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    __panels[0].__receive({ type: 'sendTaskMessage', text: 'hello' });

    expect(posted(__panels[0])).toContainEqual({ type: 'showError', error: 'Task is not running.' });
  });

  it('closing the tab never touches the task, and reopening loads it afresh', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__fireDispose();

    expect(h.session.sendTaskMessage).not.toHaveBeenCalled();
    expect(h.session.interruptTask).not.toHaveBeenCalled();

    h.registry.open('t1');
    expect(__panels).toHaveLength(2);
  });

  it('refreshes the header from the task when the plan changes', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    h.task.status = 'awaiting_user';
    h.task.awaitingReason = 'input';
    h.registry.receive({ type: 'status_update', tasks: [] });

    const status = posted(__panels[0]).find((m) => m.type === 'status');
    expect(status).toMatchObject({ type: 'status', status: { planStatus: 'awaiting_user', awaitingReason: 'input' } });
  });

  it('offers Continue only for a finished structured task with a saved session (ADR-0018, K1)', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { continuable: false } });
    __panels[0].webview.postMessage.mockClear();

    h.task.status = 'completed';
    h.task.runnerSessionId = 'sess-1';
    h.registry.receive({ type: 'status_update', tasks: [] });

    expect(posted(__panels[0]).find((m) => m.type === 'status')).toMatchObject({ status: { continuable: true } });
  });

  it('continues the task through the Session and follows the new attempt, even from an earlier one', async () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.task.status = 'completed';
    h.task.runnerSessionId = 'sess-1';
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].__receive({ type: 'selectAttempt', attempt: 1 });

    __panels[0].__receive({ type: 'continueTask', text: 'also handle arrays' });
    await vi.waitFor(() => expect(h.session.continueTask).toHaveBeenCalledWith('t1', 'also handle arrays'));

    __panels[0].webview.postMessage.mockClear();
    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 3, events: [{ type: 'turn_start', message: 'also handle arrays' }] });
    expect(posted(__panels[0]).at(-1)).toMatchObject({ type: 'init', status: { attempt: 3, attempts: [1, 2, 3] } });
  });

  it('shows the Session’s refusal of a continue', async () => {
    const h = harness();
    h.session.continueTask.mockImplementation(async () => { throw new Error('Task "Parse JSON" cannot be continued: its runner left no saved session to resume.'); });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    __panels[0].__receive({ type: 'continueTask', text: 'more' });

    await vi.waitFor(() => expect(posted(__panels[0])).toContainEqual({ type: 'showError', error: 'Task "Parse JSON" cannot be continued: its runner left no saved session to resume.' }));
  });

  it('says the task waits for approval while its runner has a request open, and counts only its own', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { awaitingApproval: 0 } });
    __panels[0].webview.postMessage.mockClear();

    const request = (id: string, taskId: string, kind: 'runner_tool' | 'shell_command' = 'runner_tool'): PendingApproval => ({
      id, createdAt: '', request: { kind, subject: 'Bash(npm test)', scope: 'Bash', taskId },
    });
    h.session.pending = [request('a', 't1'), request('b', 't2'), request('c', 't1', 'shell_command')];
    h.registry.receive({ type: 'status_update', tasks: [] });

    expect(posted(__panels[0]).find((m) => m.type === 'status')).toMatchObject({ status: { awaitingApproval: 1 } });
  });

  it('answers a request with the card\'s whole decision, and says when it no longer waits', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    __panels[0].__receive({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'deny', note: 'use notes/' } });
    expect(h.session.resolveApproval).toHaveBeenCalledWith('ap-1', { decision: 'deny', note: 'use notes/' });

    h.session.resolveApproval.mockReturnValue(false);
    __panels[0].__receive({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'allow' } });
    expect(posted(__panels[0])).toContainEqual({ type: 'showError', error: 'That request is no longer waiting for an answer.' });
  });
});

describe('task-log tabs over a whole run (ADR-0018, V1)', () => {
  beforeEach(() => {
    __resetPanels();
    createWebviewPanel.mockClear();
  });

  it('opens no tab for anything the session says, however much of it concerns the task', () => {
    const h = harness();
    const heard: SessionMessage[] = [
      { type: 'task_started', taskId: 't1', order: 1, title: 'Parse JSON', runner: 'claude-code' },
      { type: 'task_log', taskId: 't1', attempt: 1, events: [{ type: 'turn_start', message: 'do it' }] },
      { type: 'task_log', taskId: 't1', attempt: 1, events: [{ type: 'approval_requested', approvalId: 'ap-1', tool: 'Write', args: '{}', allowForTask: false }] },
      { type: 'status_update', tasks: [] },
      { type: 'task_updated', taskId: 't1', changes: { status: 'awaiting_user' } },
      { type: 'execution_complete', summary: { total: 1, completed: 0, failed: 1 } },
      { type: 'execution_stopped' },
    ];
    for (const msg of heard) h.registry.receive(msg);

    expect(createWebviewPanel).not.toHaveBeenCalled();
    expect(__panels).toHaveLength(0);
  });

  it('keeps one tab per task, each drawing only its own task\'s log', () => {
    const tasks: Record<string, Task> = {
      t1: createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'claude-code', status: 'in_progress' }) as Task,
      t2: createTask({ id: 't2', order: 2, title: 'Write tests', assignedRunner: 'claude-code', status: 'in_progress' }) as Task,
    };
    const session = harness().session;
    const registry = new TaskLogRegistry({ extensionUri: vscode.Uri.file('/ext'), session: () => session, getTask: (id) => tasks[id], log: vi.fn() });
    registry.open('t1');
    registry.open('t2');
    for (const panel of __panels) panel.__receive({ type: 'ready' });
    for (const panel of __panels) panel.webview.postMessage.mockClear();

    registry.receive({ type: 'task_log', taskId: 't2', attempt: 1, events: [{ type: 'text_delta', text: 'tests pass' }] });
    registry.open('t1');

    expect(__panels.map((p) => p.title)).toEqual(['Task 1 · Parse JSON', 'Task 2 · Write tests']);
    expect(posted(__panels[0])).toEqual([]);
    expect(posted(__panels[1]).some((m) => m.type === 'patch')).toBe(true);
    expect(__panels[0].reveal).toHaveBeenCalledTimes(1);
    expect(__panels[1].reveal).not.toHaveBeenCalled();
  });

  it('leaves an earlier attempt the user picked on screen when a retry starts, and lists the new one', () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].__receive({ type: 'selectAttempt', attempt: 1 });
    __panels[0].webview.postMessage.mockClear();

    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 3, events: [{ type: 'turn_start', message: 'again' }] });

    expect(posted(__panels[0]).some((m) => m.type === 'init' || m.type === 'patch')).toBe(false);
    expect(posted(__panels[0]).at(-1)).toMatchObject({ type: 'status', status: { attempt: 1, attempts: [1, 2, 3] } });
  });

  it('ignores a pick of an attempt it does not have', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();
    h.session.taskLog.mockClear();

    __panels[0].__receive({ type: 'selectAttempt', attempt: 7 });

    expect(h.session.taskLog).not.toHaveBeenCalled();
    expect(posted(__panels[0])).toEqual([]);
  });

  it('posts nothing before its webview is ready, then draws the file — which already holds what streamed', () => {
    const h = harness();
    h.registry.open('t1');
    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 1, events: attemptOne });
    expect(posted(__panels[0])).toEqual([]);

    __panels[0].__receive({ type: 'ready' });

    const sent = posted(__panels[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'init', status: { attempt: 1, attempts: [1] } });
    expect(sent[0].type === 'init' && sent[0].blocks.filter((b) => b.type === 'message')).toHaveLength(2);
  });

  it('says nothing when the header has not changed, and retitles the tab when the task is renamed', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    h.registry.receive({ type: 'status_update', tasks: [] });
    h.registry.receive({ type: 'task_started', taskId: 't1', order: 1, title: 'Parse JSON', runner: 'claude-code' });
    expect(posted(__panels[0])).toEqual([]);

    h.task.title = 'Parse JSON5';
    h.registry.receive({ type: 'task_updated', taskId: 't1', changes: { title: 'Parse JSON5' } });
    expect(posted(__panels[0])).toEqual([expect.objectContaining({ type: 'status', status: expect.objectContaining({ title: 'Parse JSON5' }) })]);
    expect(__panels[0].title).toBe('Task 1 · Parse JSON5');
  });

  it('shows the Session\'s refusal of an interrupt', async () => {
    const h = harness();
    h.session.interruptTask.mockImplementation(async () => { throw new Error('Task 1 has no turn running.'); });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    __panels[0].__receive({ type: 'interruptTask' });

    await vi.waitFor(() => expect(posted(__panels[0])).toContainEqual({ type: 'showError', error: 'Task 1 has no turn running.' }));
  });

  it('closes every tab on dispose, and a later event reaches none of them', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    h.registry.dispose();
    expect(__panels[0].dispose).toHaveBeenCalledTimes(1);
    __panels[0].webview.postMessage.mockClear();

    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: ' late' }] });
    expect(posted(__panels[0])).toEqual([]);
    h.registry.open('t1');
    expect(__panels).toHaveLength(2);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createTask, type AccountLimitSnapshot, type AttemptUsage, type CommandOutcome, type ExecutionActor, type ExecutionCommand, type PendingApproval, type SessionMessage, type Task, type TaskLogEvent } from '@ordewell/core';
import { TASK_LOG_VIEW_TYPE, TaskLogRegistry } from '../providers/TaskLogRegistry';
import type { HostToTaskLog } from '../shared/taskLogProtocol';
import { __panels, __resetPanels, createFakeWebviewPanel, window } from '../test/vscode.mock';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks } from '../shared/conversationPatch';

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

function harness(attempts: Record<number, TaskLogEvent[]> = { 1: attemptOne }, limits: { current: readonly AccountLimitSnapshot[] } = { current: [] }) {
  const task = createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'claude-code', status: 'in_progress', attempted: true });
  const session = {
    taskLogAttempts: vi.fn(() => Object.keys(attempts).map(Number).sort((a, b) => a - b)),
    taskLog: vi.fn((_taskId: string, attempt: number) => attempts[attempt] ?? []),
    invokeTaskCommand: vi.fn(() => 'c1'),
    execute: vi.fn(async (_command: ExecutionCommand, _actor: ExecutionActor): Promise<CommandOutcome> => ({ ok: true, message: 'done' })),
    pending: [] as PendingApproval[],
    isolationView: () => null, outstandingApprovals: vi.fn((): PendingApproval[] => session.pending),
  };
  const registry = new TaskLogRegistry({
    extensionUri: vscode.Uri.file('/ext'),
    session: () => session,
    getTask: () => task as Task,
    accountLimits: () => limits.current,
    openFile: vi.fn(),
    log: vi.fn(),
  });
  return { registry, session, task, limits };
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

  it('opens no chat for a task that never started, whatever its status or mark', () => {
    const h = harness({});
    delete h.task.attempted;
    h.task.status = 'completed';
    h.registry.open('t1');

    expect(createWebviewPanel).not.toHaveBeenCalled();
    expect(__panels).toHaveLength(0);
  });

  it('opens a chat as soon as an attempt started, with no output, usage or saved log yet', () => {
    const h = harness({});
    h.task.attemptUsage = undefined;
    h.registry.open('t1');

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(__panels).toHaveLength(1);
  });

  it('opens a script task\'s own chat once it started', () => {
    const h = harness({});
    Object.assign(h.task, { type: 'script', script: 'echo hi', attempted: true });
    h.registry.open('t1');

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it('takes a saved attempt log for the history of a plan written before the mark', () => {
    const h = harness({ 1: attemptOne });
    delete h.task.attempted;
    h.task.status = 'completed';
    h.registry.open('t1');

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it('does not take a manual task\'s saved handoff for an attempt chat', () => {
    const h = harness({ 1: [{ type: 'handoff', handoff: { summary: 'Steps done', findings: [], findingCount: 0 } }] });
    delete h.task.attempted;
    Object.assign(h.task, { type: 'user', status: 'completed' });
    h.registry.open('t1');

    expect(createWebviewPanel).not.toHaveBeenCalled();
  });

  it('round-trips full handoffs through init and live patches, keeping each attempt separate', () => {
    const handoff = {
      summary: 'Boundary checked', findingCount: 1,
      findings: [{ id: 'F1', severity: 'major' as const, title: 'Needs a fix', detail: 'Keep this detail', evidence: [{ kind: 'file' as const, path: 'a.ts', line: 7 }] }],
      artifacts: [{ kind: 'commit' as const, sha: 'abc123' }],
      report: Array.from({ length: 12 }, (_, i) => `Full report line ${i}`).join('\n'),
    };
    const h = harness({ 1: [{ type: 'handoff', handoff }], 2: attemptTwo });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].__receive({ type: 'selectAttempt', attempt: 1 });
    const initial = JSON.parse(JSON.stringify(posted(__panels[0]).at(-1))) as HostToTaskLog;
    if (initial.type !== 'init') throw new Error('Expected init');
    expect(initial.status.attempt).toBe(1);
    let view = applyConversationPatch(EMPTY_PATCHED_VIEW, { type: 'conversationPatch', order: initial.blocks.map((b) => b.id), changed: initial.blocks });
    expect(patchedBlocks(view).filter((b) => b.type === 'handoff')).toEqual([expect.objectContaining({ handoff })]);

    __panels[0].__receive({ type: 'selectAttempt', attempt: 2 });
    const next = posted(__panels[0]).at(-1);
    if (next?.type !== 'init') throw new Error('Expected attempt init');
    expect(next.blocks.some((b) => b.type === 'handoff')).toBe(false);
    view = applyConversationPatch(EMPTY_PATCHED_VIEW, { type: 'conversationPatch', order: next.blocks.map((b) => b.id), changed: next.blocks });
    __panels[0].webview.postMessage.mockClear();
    const latest = { ...handoff, summary: 'Fixed in attempt two', findings: [], findingCount: 0 };
    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 2, events: [{ type: 'handoff', handoff: latest }] });
    const patch = JSON.parse(JSON.stringify(posted(__panels[0])[0])) as HostToTaskLog;
    if (patch.type !== 'patch') throw new Error('Expected patch');
    view = applyConversationPatch(view, { ...patch, type: 'conversationPatch' });
    expect(patchedBlocks(view).filter((b) => b.type === 'handoff')).toEqual([expect.objectContaining({ handoff: latest })]);
  });

  it('discovers commands from the latest attempt and invokes them through the Session', () => {
    const h = harness({ 1: [{ type: 'runner_loaded', commands: [{ name: 'compact', description: 'Compact context', kind: 'builtin' }], mcpServers: [] }] });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { header: { commands: [{ name: 'compact', description: 'Compact context', kind: 'builtin' }] } } });
    __panels[0].__receive({ type: 'invokeTaskCommand', name: 'compact', args: 'retain tests' });
    expect(h.session.invokeTaskCommand).toHaveBeenCalledWith('t1', 'compact', 'retain tests');
  });

  it('carries the spend and meter of the attempt on screen, with the task total beneath an earlier one', () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init' });
    expect((posted(__panels[0])[0] as { status: { header: { usage?: unknown } } }).status.header.usage).toEqual([]);

    const spend = (attempt: number, inputTokens: number, usd: number, lastPromptTokens: number): AttemptUsage => ({
      attempt, runner: 'claude-code', startedAt: '', wallTimeMs: 1000,
      totals: { inputTokens, outputTokens: 10, reportedCost: { USD: usd } },
      lastPromptTokens, contextWindow: 200_000,
    });
    h.task.attemptUsage = [spend(1, 1000, 0.5, 10_000), spend(2, 500, 1, 50_000)];
    __panels[0].webview.postMessage.mockClear();
    h.registry.receive({ type: 'status_update', tasks: [] });

    // The latest attempt: the task's whole spend, with the meter it left.
    const latest = (posted(__panels[0])[0] as { status: { header: { usage: unknown } } }).status;
    expect(latest.header.usage).toEqual([
      { text: 'ctx 50k (25%) · $1.50', contextFill: { usedTokens: 50_000, windowTokens: 200_000 } },
    ]);

    // An earlier attempt: its own numbers, and the task total labelled below.
    __panels[0].webview.postMessage.mockClear();
    __panels[0].__receive({ type: 'selectAttempt', attempt: 1 });
    const earlier = posted(__panels[0]).at(-1);
    if (earlier?.type !== 'init') throw new Error('Expected an attempt init');
    expect(earlier.status.header.usage).toEqual([
      { text: 'attempt 1: ctx 10k (5%) · $0.50', contextFill: { usedTokens: 10_000, windowTokens: 200_000 } },
      { text: 'task total: ctx 50k (25%) · $1.50', contextFill: { usedTokens: 50_000, windowTokens: 200_000 } },
    ]);
  });

  it('draws an old log\'s own usage when the task kept no attempt ledger', () => {
    const h = harness({
      1: [
        { type: 'turn_start', message: 'x' },
        { type: 'usage', record: { source: 'claude-code', inputTokens: 500, outputTokens: 40, contextTokens: 540, contextWindow: 200_000 } },
        { type: 'turn_end', reason: 'completed' },
      ],
    });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    const init = posted(__panels[0])[0];
    expect((init as { status: { header: { usage?: unknown } } }).status.header.usage).toEqual([
      { text: 'ctx 540 (<1%)', contextFill: { usedTokens: 540, windowTokens: 200_000 } },
    ]);
  });

  it('never opens a tab by itself, and opens one titled for the task on demand', () => {
    const h = harness();
    expect(createWebviewPanel).not.toHaveBeenCalled();

    h.registry.open('t1');

    expect(createWebviewPanel).toHaveBeenCalledWith('ordewellTaskLog', 'Task 1 · Parse JSON', vscode.ViewColumn.Active, expect.anything());
    expect(__panels).toHaveLength(1);
  });

  it('titles a subtask tab with its dotted reference, not its own order', () => {
    const subtask = createTask({ id: 's1', order: 1, title: 'Subtask', assignedRunner: 'claude-code', status: 'in_progress', attempted: true }) as Task;
    const registry = new TaskLogRegistry({
      extensionUri: vscode.Uri.file('/ext'),
      session: () => harness().session,
      getTask: () => subtask,
      orderLabel: (taskId) => (taskId === 's1' ? '2.1' : undefined),
      openFile: vi.fn(),
      log: vi.fn(),
    });

    registry.open('s1');
    __panels[0].__receive({ type: 'ready' });

    expect(__panels[0].title).toBe('Task 2.1 · Subtask');
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { orderLabel: '2.1' } });
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
        invokeTaskCommand: () => 'c', taskLogAttempts: () => [], taskLog: () => [], execute: async () => ({ ok: true, message: '' }), isolationView: () => null, outstandingApprovals: () => [],
      }),
      getTask: () => undefined,
      openFile: vi.fn(),
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

  it('ignores a late batch from an older attempt while following the newest', () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();
    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 1, events: [{ type: 'text', text: 'late old reply' }] });
    expect(posted(__panels[0])).toEqual([]);
    expect(h.session.taskLog).not.toHaveBeenCalledWith('t1', 1);
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

  it.each([
    ['a message', { type: 'sendTaskMessage', text: 'use Postgres' }, { command: 'message_task', task: 't1', text: 'use Postgres' }],
    ['a removal of a queued message', { type: 'removeQueuedTaskMessage', id: 'q1' }, { command: 'remove_queued', task: 't1', id: 'q1' }],
    ['an interrupt', { type: 'interruptTask' }, { command: 'interrupt_task', task: 't1' }],
    ['a force send (ADR-0023, F1)', { type: 'sendTaskMessageNow', text: 'stop, use Postgres' }, { command: 'message_task', task: 't1', text: 'stop, use Postgres', force: true }],
    ['a force send of a queued message', { type: 'sendQueuedTaskMessageNow', id: 'q1' }, { command: 'force_send_queued', task: 't1', id: 'q1' }],
    ['a cancelled resume', { type: 'cancelResume' }, { command: 'cancel_resume', task: 't1' }],
    ['a Resume now', { type: 'resumeNow' }, { command: 'retry_task', task: 't1', from: 'session' }],
  ] as const)('sends %s through the command seam as the user (ADR-0029)', async (_name, msg, command) => {
    const h = harness();
    h.registry.open('t1');

    __panels[0].__receive(msg);

    await vi.waitFor(() => expect(h.session.execute).toHaveBeenCalledWith(command, { kind: 'user' }));
  });

  it.each([
    { type: 'removeQueuedTaskMessage', id: 'q1' },
    { type: 'sendQueuedTaskMessageNow', id: 'q1' },
    { type: 'sendTaskMessageNow', text: 'now' },
    { type: 'interruptTask' },
    { type: 'cancelResume' },
    { type: 'resumeNow' },
    { type: 'answerApproval', id: 'ap-1', decision: { decision: 'allow' } },
  ] as const)('shows the seam\'s refusal of %j', async (msg) => {
    const h = harness();
    h.session.execute.mockResolvedValue({ ok: false, outcome: 'refused', message: 'Task 1 has no such thing.' });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    __panels[0].__receive(msg);

    await vi.waitFor(() => expect(posted(__panels[0])).toContainEqual({ type: 'showError', error: 'Task 1 has no such thing.' }));
  });

  it('shows the seam\u2019s refusal of a task that cannot take a message', async () => {
    const h = harness();
    h.session.execute.mockResolvedValue({ ok: false, outcome: 'refused', message: 'Task is not running.' });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    __panels[0].__receive({ type: 'sendTaskMessage', text: 'hello' });

    await vi.waitFor(() => expect(posted(__panels[0])).toContainEqual({ type: 'showError', error: 'Task is not running.' }));
  });

  it('closing the tab never touches the task, and reopening loads it afresh', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__fireDispose();

    expect(h.session.execute).not.toHaveBeenCalled();

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
    expect(status).toMatchObject({ type: 'status', status: { header: { state: { kind: 'awaiting', label: 'Waiting for your input' } } } });
  });

  it('reads a runner gone quiet as Stalled, as the TUI does, and as Working again once it speaks', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    h.registry.receive({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null, idleSince: '2026-10-24T01:00:00.000Z' }] });
    expect(posted(__panels[0]).find((m) => m.type === 'status')).toMatchObject({ status: { header: { state: { kind: 'quiet', label: 'Stalled' } } } });

    __panels[0].webview.postMessage.mockClear();
    h.registry.receive({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null, idleSince: null }] });
    expect(posted(__panels[0]).find((m) => m.type === 'status')).toMatchObject({ status: { header: { state: { kind: 'running', label: 'Running' } } } });
  });

  it('offers Continue only for a finished structured task with a saved session (ADR-0018, K1)', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { header: { continuable: false } } });
    __panels[0].webview.postMessage.mockClear();

    h.task.status = 'completed';
    h.task.runnerSessionId = 'sess-1';
    h.registry.receive({ type: 'status_update', tasks: [] });

    expect(posted(__panels[0]).find((m) => m.type === 'status')).toMatchObject({ status: { header: { continuable: true } } });
  });

  it('continues the task through the command seam as the user and follows the new attempt, even from an earlier one', async () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.task.status = 'completed';
    h.task.runnerSessionId = 'sess-1';
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].__receive({ type: 'selectAttempt', attempt: 1 });

    __panels[0].__receive({ type: 'continueTask', text: 'also handle arrays' });
    await vi.waitFor(() => expect(h.session.execute).toHaveBeenCalledWith({ command: 'retry_task', task: 't1', from: 'session', message: 'also handle arrays' }, { kind: 'user' }));

    __panels[0].webview.postMessage.mockClear();
    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 3, events: [{ type: 'turn_start', message: 'also handle arrays' }] });
    expect(posted(__panels[0]).at(-1)).toMatchObject({ type: 'init', status: { attempt: 3, attempts: [1, 2, 3] } });
  });

  it('shows the seam’s refusal of a continue', async () => {
    const h = harness();
    h.session.execute.mockResolvedValue({ ok: false, outcome: 'refused', message: 'Task "Parse JSON" cannot be continued: its runner left no saved session to resume.' });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    __panels[0].__receive({ type: 'continueTask', text: 'more' });

    await vi.waitFor(() => expect(posted(__panels[0])).toContainEqual({ type: 'showError', error: 'Task "Parse JSON" cannot be continued: its runner left no saved session to resume.' }));
  });

  it('says the task waits for approval while its runner has a request open, and counts only its own', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { header: { state: { kind: 'running' } } } });
    __panels[0].webview.postMessage.mockClear();

    const request = (id: string, taskId: string, kind: 'runner_tool' | 'shell_command' = 'runner_tool'): PendingApproval => ({
      id, createdAt: '', request: { kind, subject: 'Bash(npm test)', scope: 'Bash', taskId },
    });
    h.session.pending = [request('a', 't1'), request('b', 't2'), request('c', 't1', 'shell_command')];
    h.registry.receive({ type: 'status_update', tasks: [] });

    expect(posted(__panels[0]).find((m) => m.type === 'status')).toMatchObject({ status: { header: { state: { kind: 'approval', label: 'Waiting for approval' } } } });
  });

  it('sends a request\'s answer through the seam as the user, so the timeline and the supervisor hear of it', async () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    __panels[0].__receive({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'deny', note: 'use notes/' } });
    __panels[0].__receive({ type: 'answerApproval', id: 'ap-2', decision: { decision: 'allowForTask' } });

    await vi.waitFor(() => expect(h.session.execute.mock.calls).toEqual([
      [{ command: 'answer_approval', task: 't1', approval: 'ap-1', answer: 'deny', note: 'use notes/' }, { kind: 'user' }],
      [{ command: 'answer_approval', task: 't1', approval: 'ap-2', answer: 'allowForTask' }, { kind: 'user' }],
    ]));
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
      { type: 'execution_complete', summary: { total: 1, completed: 0, failed: 1, blocked: 0, skipped: 0 } },
      { type: 'execution_stopped' },
    ];
    for (const msg of heard) h.registry.receive(msg);

    expect(createWebviewPanel).not.toHaveBeenCalled();
    expect(__panels).toHaveLength(0);
  });

  it('keeps one tab per task, each drawing only its own task\'s log', () => {
    const tasks: Record<string, Task> = {
      t1: createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'claude-code', status: 'in_progress', attempted: true }) as Task,
      t2: createTask({ id: 't2', order: 2, title: 'Write tests', assignedRunner: 'claude-code', status: 'in_progress', attempted: true }) as Task,
    };
    const session = harness().session;
    const registry = new TaskLogRegistry({ extensionUri: vscode.Uri.file('/ext'), session: () => session, getTask: (id) => tasks[id], openFile: vi.fn(), log: vi.fn() });
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

  it('says when a task paused on a usage limit resumes (#84)', () => {
    const h = harness();
    Object.assign(h.task, { status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { header: { resumes: expect.stringMatching(/^Resumes at /), state: { label: 'Paused on a usage limit' } } } });
  });

  it('offers Resume now for a task paused on a usage limit', () => {
    const h = harness();
    Object.assign(h.task, { status: 'awaiting_user', awaitingReason: 'usage-limit', runnerSessionId: 'native-1' });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { header: { continuable: true, resumable: true } } });
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

  it('reopens a tab a window reload restores, for the task it was showing', () => {
    const h = harness();
    const panel = createFakeWebviewPanel('ordewellTaskLog', 'Task log');

    h.registry.restore(panel as unknown as vscode.WebviewPanel, { taskId: 't1' });
    panel.__receive({ type: 'ready' });

    expect(posted(panel)[0]).toMatchObject({ type: 'init', status: { taskId: 't1' } });
    expect(panel.dispose).not.toHaveBeenCalled();
  });

  it('drops a restored tab whose task never started', () => {
    const h = harness({});
    delete h.task.attempted;
    const panel = createFakeWebviewPanel('ordewellTaskLog', 'Task chat');

    h.registry.restore(panel as unknown as vscode.WebviewPanel, { taskId: 't1' });

    expect(panel.dispose).toHaveBeenCalledTimes(1);
    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 1, events: attemptOne });
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('drops a restored tab whose task has left the plan', () => {
    const registry = new TaskLogRegistry({
      extensionUri: vscode.Uri.file('/ext'),
      session: () => harness().session,
      getTask: () => undefined,
      openFile: vi.fn(),
      log: vi.fn(),
    });
    const panel = createFakeWebviewPanel('ordewellTaskLog', 'Task log');

    registry.restore(panel as unknown as vscode.WebviewPanel, { taskId: 'gone' });

    expect(panel.dispose).toHaveBeenCalledTimes(1);
  });

  it('registers the serializer that restores task-log tabs', () => {
    const h = harness();

    h.registry.register();

    expect(window.registerWebviewPanelSerializer).toHaveBeenCalledWith('ordewellTaskLog', expect.anything());
  });

  it('declares the activation event VS Code fires to revive a restored tab', () => {
    // The restore path activates `onWebviewPanel:<viewType>` before asking for
    // the serializer, so onStartupFinished alone registers it too late.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { activationEvents?: string[] };

    expect(manifest.activationEvents).toContain(`onWebviewPanel:${TASK_LOG_VIEW_TYPE}`);
  });

  describe('account limits', () => {
    const snapshot = (harness: string, label: string, used: number): AccountLimitSnapshot => ({
      harness, label, status: 'fresh', buckets: [{ id: harness, windows: [{ slot: 'primary', usedPercent: used, durationMinutes: 300, resetsAt: null }] }], readAt: '2026-03-02T10:00:00.000Z',
    });
    const codex = snapshot('codex', 'Codex', 24);
    const claude = snapshot('claude-code', 'Claude Code', 40);
    const limitsSent = (panel: (typeof __panels)[number]) => posted(panel).flatMap((m) => (m.type === 'accountLimits' ? [m.limits] : []));

    it('sends a task only its assigned runner\'s account limits, once the panel is ready', () => {
      const h = harness(undefined, { current: [codex, claude] });
      h.registry.open('t1');
      expect(limitsSent(__panels[0])).toEqual([]);

      __panels[0].__receive({ type: 'ready' });

      expect(limitsSent(__panels[0])).toEqual([[claude]]);
    });

    it('sends the new limits when the monitor reads again, and nothing when its runner\'s are unchanged', () => {
      const h = harness(undefined, { current: [codex, claude] });
      h.registry.open('t1');
      __panels[0].__receive({ type: 'ready' });

      h.limits.current = [snapshot('codex', 'Codex', 30), claude];
      h.registry.accountLimitsChanged();
      expect(limitsSent(__panels[0])).toEqual([[claude]]);

      const later = snapshot('claude-code', 'Claude Code', 41);
      h.limits.current = [codex, later];
      h.registry.accountLimitsChanged();
      expect(limitsSent(__panels[0])).toEqual([[claude], [later]]);
    });

    it('follows the task to another runner when its assignment changes', () => {
      const h = harness(undefined, { current: [codex, claude] });
      h.registry.open('t1');
      __panels[0].__receive({ type: 'ready' });

      h.task.assignedRunner = 'codex';
      h.registry.receive({ type: 'task_updated', taskId: 't1', changes: { assignedRunner: 'codex' } });

      expect(limitsSent(__panels[0]).at(-1)).toEqual([codex]);
    });

    it('sends none for a runner with no monitored account, and clears them when the task moves to one', () => {
      const h = harness(undefined, { current: [codex] });
      h.registry.open('t1');
      __panels[0].__receive({ type: 'ready' });
      expect(limitsSent(__panels[0])).toEqual([]);

      h.task.assignedRunner = 'codex';
      h.registry.receive({ type: 'task_updated', taskId: 't1', changes: { assignedRunner: 'codex' } });
      h.task.assignedRunner = 'opencode';
      h.registry.receive({ type: 'task_updated', taskId: 't1', changes: { assignedRunner: 'opencode' } });

      expect(limitsSent(__panels[0])).toEqual([[codex], []]);
    });

    it('sends them again to a webview that reconnects, and to a tab a window reload restores', () => {
      const h = harness(undefined, { current: [claude] });
      h.registry.open('t1');
      __panels[0].__receive({ type: 'ready' });
      __panels[0].__receive({ type: 'ready' });
      expect(limitsSent(__panels[0])).toEqual([[claude], [claude]]);

      const restored = harness(undefined, { current: [claude] });
      const panel = createFakeWebviewPanel('ordewellTaskLog', 'Task log');
      restored.registry.restore(panel as unknown as vscode.WebviewPanel, { taskId: 't1' });
      panel.__receive({ type: 'ready' });
      expect(limitsSent(panel)).toEqual([[claude]]);
    });

    describe('of an account that meters one provider', () => {
      const go: AccountLimitSnapshot = { ...snapshot('opencode', 'OpenCode Go', 7), provider: 'opencode-go' };
      const served = (model: string, subagentId?: string): TaskLogEvent => ({ type: 'usage', record: { source: 'opencode', model, inputTokens: 1, ...(subagentId ? { subagentId } : {}) } });
      const onOpenCode = (h: ReturnType<typeof harness>, modelId: string) => {
        h.task.assignedRunner = 'opencode';
        h.task.assignedModel = { modelId, modelLabel: modelId };
      };

      it('shows Go only to a task assigned a Go model, never to one on Zen or a third party', () => {
        for (const [modelId, shown] of [['opencode-go/kimi-k2.6', [go]], ['opencode/kimi-k2.6', []], ['openrouter/moonshot/kimi', []]] as const) {
          __resetPanels();
          const h = harness(undefined, { current: [go] });
          onOpenCode(h, modelId);
          h.registry.open('t1');
          __panels[0].__receive({ type: 'ready' });
          expect(limitsSent(__panels[0]).at(-1) ?? []).toEqual(shown);
        }
      });

      it('shows none to a task with no model named: no provider known is no binding', () => {
        const h = harness(undefined, { current: [go] });
        h.task.assignedRunner = 'opencode';
        h.registry.open('t1');
        __panels[0].__receive({ type: 'ready' });

        expect(limitsSent(__panels[0])).toEqual([]);
      });

      it('follows the provider the latest attempt is served by, as its own usage says, not a subagent\'s', () => {
        const h = harness({ 1: [{ type: 'turn_start', message: 'go' }, served('openrouter/x/y')] }, { current: [go] });
        onOpenCode(h, 'opencode-go/kimi-k2.6');
        h.registry.open('t1');
        __panels[0].__receive({ type: 'ready' });
        // The saved attempt says it ran on another provider than planned.
        expect(limitsSent(__panels[0])).toEqual([]);

        h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 1, events: [served('opencode-go/glm-5')] });
        expect(limitsSent(__panels[0]).at(-1)).toEqual([go]);
        h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 1, events: [served('openrouter/x/y', 'sub-1')] });
        expect(limitsSent(__panels[0]).at(-1)).toEqual([go]);
        h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 1, events: [served('opencode/zen-model')] });
        expect(limitsSent(__panels[0]).at(-1)).toEqual([]);
      });

      it('learns what served the saved attempt from the one read that draws it, and reads nothing more when the webview reconnects', () => {
        const h = harness({ 1: [served('opencode-go/glm-5')] }, { current: [go] });
        onOpenCode(h, 'openrouter/x/y');
        h.registry.open('t1');
        __panels[0].__receive({ type: 'ready' });
        expect(limitsSent(__panels[0])).toEqual([[go]]);
        expect(h.session.taskLog).toHaveBeenCalledTimes(1);

        __panels[0].__receive({ type: 'ready' });
        expect(limitsSent(__panels[0])).toEqual([[go], [go]]);
        expect(h.session.taskLog).toHaveBeenCalledTimes(1);
      });

      it('forgets what an earlier attempt or an earlier assignment was served by', () => {
        const h = harness({ 1: [served('openrouter/x/y')] }, { current: [go] });
        onOpenCode(h, 'opencode-go/kimi-k2.6');
        h.registry.open('t1');
        __panels[0].__receive({ type: 'ready' });
        expect(limitsSent(__panels[0])).toEqual([]);

        // A new attempt starts on its assignment until its own usage says otherwise.
        h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 2, events: [{ type: 'turn_start', message: 'again' }] });
        expect(limitsSent(__panels[0]).at(-1)).toEqual([go]);
        h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 2, events: [served('openrouter/x/y')] });
        expect(limitsSent(__panels[0]).at(-1)).toEqual([]);

        // A reassigned model is a new binding: the old attempt's provider no longer speaks for it.
        h.task.assignedModel = { modelId: 'opencode-go/glm-5', modelLabel: 'glm-5' };
        h.registry.receive({ type: 'task_updated', taskId: 't1', changes: { assignedModel: h.task.assignedModel } });
        expect(limitsSent(__panels[0]).at(-1)).toEqual([go]);
      });
    });

    it('keeps showing the live limits while an earlier attempt is on screen', () => {
      const h = harness({ 1: attemptOne, 2: attemptTwo }, { current: [claude] });
      h.registry.open('t1');
      __panels[0].__receive({ type: 'ready' });
      __panels[0].__receive({ type: 'selectAttempt', attempt: 1 });

      const later = snapshot('claude-code', 'Claude Code', 55);
      h.limits.current = [later];
      h.registry.accountLimitsChanged();
      expect(limitsSent(__panels[0]).at(-1)).toEqual([later]);
    });
  });
});

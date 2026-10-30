import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator, TaskControlError } from '../TaskOrchestrator';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { IDLE_TIMEOUT_MS } from '../VerdictEngine';
import { serializeTaskStatus, type SessionMessage } from '../SessionMessage';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification, makeSession, saves, taskOf } from './sessionTestKit';
import type { IRunner, IRunnerSession, StructuredEvent } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import type { Session } from '../createSession';

/** A task message through the command seam as the user, answering its id as the per-verb control did. */
async function sendTaskMessage(session: Session, taskId: string, text: string): Promise<string> {
  const outcome = await session.execute({ command: 'message_task', task: taskId, text }, { kind: 'user' });
  if (!outcome.ok || outcome.payload?.kind !== 'message') throw new TaskControlError(outcome.message);
  return outcome.payload.id;
}

function setup() {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (opts: RunnerSpawnOptions): Promise<IRunnerSession> => {
      const id = `s${sessions.length + 1}`;
      const session = new FakeRunnerSession(id, opts.taskId);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  /** Every status the task passed through, as each `onTaskChanged` saw it. */
  const seen: string[] = [];
  const settled: string[] = [];
  orchestrator.subscribe({
    onTaskChanged: () => {
      const task = orchestrator.storeInstance.get('t1');
      if (task) seen.push(task.awaitingReason ? `${task.status}:${task.awaitingReason}` : task.status);
    },
    onTaskSettled: ({ taskId }) => settled.push(taskId),
  });
  return { orchestrator, sessions, seen, settled };
}

async function started(extra: Partial<Task> = {}) {
  const env = setup();
  env.orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', ...extra })]);
  await env.orchestrator.forceStartTask('t1');
  const session = env.sessions[0];
  return { ...env, session, structured: session };
}

const task = (orchestrator: TaskOrchestrator) => orchestrator.storeInstance.get('t1')!;

describe('a structured turn that ends without a task_complete call', () => {
  it('leaves the task waiting for input once the reminder\'s turn ends without one too, saved and announced, with no verdict', async () => {
    const { orchestrator, structured, seen, settled } = await started();

    structured.emitOutput('I need to know which database to use.\n');
    structured.waitForInput();

    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
    expect(task(orchestrator).verdict).toBeUndefined();
    expect(settled).toEqual(['t1']);
    expect(seen.at(-1)).toBe('awaiting_user:input');
    expect(serializeTaskStatus(task(orchestrator)).awaitingReason).toBe('input');
  });

  it('is not waiting when the turn called task_complete: the verdict stands', async () => {
    const { orchestrator, structured, seen } = await started();

    structured.emitOutput('Done.\n');
    structured.reportComplete({ status: 'done', summary: '' });
    structured.emitOutput('\n');
    structured.emitTurnEnd('completed');
    await vi.waitFor(() => expect(task(orchestrator).status).toBe('completed'));

    expect(seen).not.toContain('awaiting_user:input');
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('stays in progress, never passing through waiting, when a queued message goes out as the turn ends', async () => {
    const { orchestrator, structured, seen, settled } = await started();
    orchestrator.sendTaskMessage('t1', 'also add tests');
    seen.length = 0;

    structured.emitTurnEnd('completed');

    expect(task(orchestrator).status).toBe('in_progress');
    expect(structured.delivered).toEqual(['also add tests']);
    expect(seen.every((s) => s === 'in_progress')).toBe(true);
    expect(settled).toEqual([]);
    expect(orchestrator.getQueuedTaskMessages('t1')).toEqual([]);
  });

  it('pauses the idle flag while waiting, and resumes it with the next turn', async () => {
    vi.useFakeTimers();
    try {
      const { orchestrator, structured } = await started();
      structured.emitOutput('working\n');
      structured.waitForInput();

      vi.advanceTimersByTime(2 * IDLE_TIMEOUT_MS);
      expect(orchestrator.getIdleSince('t1')).toBeNull();

      orchestrator.sendTaskMessage('t1', 'go on');
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
      expect(orchestrator.getIdleSince('t1')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flag a task that waits for input before it printed anything', async () => {
    vi.useFakeTimers();
    try {
      const { orchestrator, structured } = await started();
      structured.waitForInput();

      vi.advanceTimersByTime(2 * IDLE_TIMEOUT_MS);
      expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
      expect(orchestrator.getIdleSince('t1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never flags a task that reported before it printed anything', async () => {
    vi.useFakeTimers();
    try {
      const { orchestrator, structured } = await started();
      structured.reportComplete({ status: 'done', summary: 'did it' });
      await vi.waitFor(() => expect(task(orchestrator).status).toBe('completed'));

      vi.advanceTimersByTime(2 * IDLE_TIMEOUT_MS);
      expect(orchestrator.getIdleSince('t1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is ignored once its attempt was cancelled', async () => {
    const { orchestrator, structured } = await started();
    await orchestrator.cancelTask('t1');

    structured.emitTurnEnd('completed');

    expect(task(orchestrator).status).toBe('pending');
  });
});

// A runner whose start never resolves — stuck launching, or waiting for its
// tools to attach — has no session to watch, and was never flagged quiet.
describe('a runner that never finishes starting', () => {
  it('is flagged quiet once it has been silent for the idle window, and no longer once the task is stopped', async () => {
    vi.useFakeTimers();
    try {
      const runner = {
        spawn: vi.fn((): Promise<IRunnerSession> => new Promise(() => {})),
        stop: vi.fn(),
        stopAll: vi.fn(),
        activeCount: 0,
      } satisfies IRunner;
      const orchestrator = TaskOrchestrator.compose({
        config: fakeConfig(),
        notifications: fakeNotification(),
        runner,
        output: new BufferedTaskOutputSource(),
        registry: new RunnerRegistry(),
        workspaceRoot: () => '/repo',
        workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
      });
      const quiet: string[] = [];
      orchestrator.subscribe({ onTaskIdle: ({ taskId }) => quiet.push(taskId) });
      orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
      void orchestrator.forceStartTask('t1');
      // Not vi.waitFor: under fake timers it moves the clock as it polls.
      for (let i = 0; i < 50 && runner.spawn.mock.calls.length === 0; i++) await flushMicrotasks();
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
      expect(orchestrator.getIdleSince('t1')).toBeNull();
      vi.advanceTimersByTime(1);
      expect(orchestrator.getIdleSince('t1')).not.toBeNull();
      expect(quiet).toEqual(['t1']);
      expect(task(orchestrator).status).toBe('in_progress');

      await orchestrator.cancelTask('t1');
      expect(orchestrator.getIdleSince('t1')).toBeNull();
      vi.advanceTimersByTime(2 * IDLE_TIMEOUT_MS);
      expect(quiet).toEqual(['t1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the completion reminder', () => {
  function turnStarts(session: FakeRunnerSession) {
    const starts: Array<Extract<StructuredEvent, { type: 'turn_start' }>> = [];
    session.onEvent((event) => { if (event.type === 'turn_start') starts.push(event); });
    return starts;
  }

  it('reminds the runner once, from Ordewell, and keeps the task in progress', async () => {
    const { orchestrator, structured, seen, settled } = await started();
    const starts = turnStarts(structured);
    seen.length = 0;

    structured.emitOutput('All checks pass. Report: …\n');
    structured.emitTurnEnd('completed');

    expect(task(orchestrator).status).toBe('in_progress');
    expect(seen.every((s) => s === 'in_progress')).toBe(true);
    expect(settled).toEqual([]);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ from: 'ordewell' });
    expect(starts[0]?.text).toMatch(/ended without calling `task_complete`/);
    expect(starts[0]?.text).toMatch(/status `done`/);
    expect(starts[0]?.text).toContain('summary of at most 1,500 characters');
    expect(starts[0]?.text).toContain('report');
    expect(starts[0]?.text).not.toContain('full report as the summary');
  });

  it('is sent once: the reminder\'s own turn ending without task_complete waits for input', async () => {
    const { orchestrator, structured, settled } = await started();

    structured.emitTurnEnd('completed');
    structured.emitTurnEnd('completed');

    expect(structured.fromOrdewell).toHaveLength(1);
    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
    expect(settled).toEqual(['t1']);
  });

  it('completes normally when the runner answers it with task_complete', async () => {
    const { orchestrator, structured } = await started();
    structured.emitTurnEnd('completed');

    structured.reportComplete({ status: 'done', summary: 'All done: report' });
    structured.emitTurnEnd('completed');

    await vi.waitFor(() => expect(task(orchestrator).status).toBe('completed'));
    expect(task(orchestrator).handoff?.summary).toBe('All done: report');
  });

  it('is not sent when a message of the user\'s goes out as the turn ends', async () => {
    const { structured, orchestrator } = await started();
    orchestrator.sendTaskMessage('t1', 'also add tests');

    structured.emitTurnEnd('completed');

    expect(structured.delivered).toEqual(['also add tests']);
    expect(structured.fromOrdewell).toEqual([]);
  });

  it.each(['failed', 'interrupted'] as const)('is not sent after a turn that %s', async (reason) => {
    const { orchestrator, structured } = await started();

    structured.emitTurnEnd(reason);

    expect(structured.fromOrdewell).toEqual([]);
    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
  });

  it('is not sent while a checkpoint has the task waiting, nor when the turn holding it is stopped', async () => {
    const { orchestrator, structured } = await started();
    void structured.callCheckpoint('ok?');
    expect(structured.fromOrdewell).toEqual([]);

    // The runner sits in the open call, so only a stop ends that turn.
    await orchestrator.interruptTask('t1');

    expect(structured.fromOrdewell).toEqual([]);
    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
  });

  it('is not sent when the turn stopped on a usage limit', async () => {
    const { orchestrator, structured } = await started();
    structured.emitEvent({ type: 'error', message: "You've hit your usage limit" });

    structured.emitTurnEnd('failed');

    await vi.waitFor(() => expect(task(orchestrator).awaitingReason).toBe('usage-limit'));
    expect(structured.fromOrdewell).toEqual([]);
  });

  it('is sent afresh on a retry, a new attempt', async () => {
    const { orchestrator, sessions } = await started();
    sessions[0]!.waitForInput();

    await orchestrator.retryTask('t1');
    await orchestrator.forceStartTask('t1');
    sessions[1]!.emitTurnEnd('completed');

    expect(sessions[1]!.fromOrdewell).toHaveLength(1);
    expect(task(orchestrator).status).toBe('in_progress');
  });
});

describe('sending a structured task a message', () => {
  it('queues it behind a running turn, lists it in status updates, and can take it back', async () => {
    const { orchestrator, structured } = await started();

    const id = orchestrator.sendTaskMessage('t1', '  use the existing helper  ');

    expect(structured.delivered).toEqual([]);
    expect(orchestrator.getQueuedTaskMessages('t1')).toEqual([{ id, text: 'use the existing helper' }]);
    expect(serializeTaskStatus(task(orchestrator), null, null, orchestrator.getQueuedTaskMessages('t1')).queued).toEqual([{ id, text: 'use the existing helper' }]);

    expect(orchestrator.removeQueuedTaskMessage('t1', id)).toBe(true);
    expect(orchestrator.removeQueuedTaskMessage('t1', id)).toBe(false);
    expect(serializeTaskStatus(task(orchestrator), null, null, orchestrator.getQueuedTaskMessages('t1'))).not.toHaveProperty('queued');
  });

  it('delivers it at once to a task waiting for input, which is back in progress', async () => {
    const { orchestrator, structured } = await started();
    structured.waitForInput();

    orchestrator.sendTaskMessage('t1', 'Postgres.');

    expect(structured.delivered.at(-1)).toBe('Postgres.');
    expect(task(orchestrator).status).toBe('in_progress');
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('refuses a message to a task at a checkpoint, which approve or reject answers', async () => {
    const { orchestrator, structured } = await started();
    const answer = structured.callCheckpoint('ok?');

    expect(() => orchestrator.sendTaskMessage('t1', 'yes')).toThrow(/checkpoint/);

    orchestrator.approveCheckpoint('t1');
    expect(task(orchestrator).status).toBe('in_progress');
    expect(task(orchestrator).awaitingReason).toBeUndefined();
    await expect(answer).resolves.toEqual({ kind: 'continue' });
    expect(structured.delivered).toEqual([]);
  });
  it('refuses an empty message', async () => {
    const { orchestrator } = await started();
    expect(() => orchestrator.sendTaskMessage('t1', '   ')).toThrow(TaskControlError);
  });
});

describe('interrupting a structured task', () => {
  it('ends the turn, and the task waits for input', async () => {
    const { orchestrator, structured, settled } = await started();

    await orchestrator.interruptTask('t1');

    expect(structured.interrupts).toBe(1);
    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
    expect(settled).toEqual(['t1']);
  });
});

describe('talking to a task without a live turn', () => {
  it('refuses all three calls, saying there is no turn', async () => {
    const { orchestrator, session } = await started();
    orchestrator.cancelTask('t1');

    for (const call of [
      () => orchestrator.sendTaskMessage('t1', 'hello'),
      () => orchestrator.removeQueuedTaskMessage('t1', 'msg-1'),
    ]) {
      expect(call).toThrow(TaskControlError);
      expect(call).toThrow(/no turn/);
    }
    await expect(orchestrator.interruptTask('t1')).rejects.toThrow(/no turn/);
    expect(session.written).toEqual([]);
    expect(orchestrator.getQueuedTaskMessages('t1')).toEqual([]);
  });

  it('refuses a task that is not running, and one not in the plan', async () => {
    const { orchestrator } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    expect(() => orchestrator.sendTaskMessage('t1', 'hello')).toThrow(/not running/);
    expect(() => orchestrator.sendTaskMessage('nope', 'hello')).toThrow(TaskControlError);
    await expect(orchestrator.interruptTask('t1')).rejects.toThrow(/not running/);
  });

  it('refuses a task whose verdict has arrived', async () => {
    const { orchestrator, structured } = await started();
    structured.reportComplete({ status: 'done', summary: '' });
    structured.emitOutput('\n');

    expect(() => orchestrator.sendTaskMessage('t1', 'one more thing')).toThrow(/not running/);
    await flushMicrotasks();
  });
});

describe('the saved reason, cleared on every way out of waiting', () => {
  it('is dropped by a retry', async () => {
    const { orchestrator, structured } = await started();
    structured.waitForInput();

    await orchestrator.retryTask('t1');

    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('is dropped by Mark complete', async () => {
    const { orchestrator, structured } = await started();
    structured.waitForInput();

    await orchestrator.markTaskComplete('t1');

    expect(task(orchestrator)).toMatchObject({ status: 'completed' });
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('is dropped by a cancel back to pending', async () => {
    const { orchestrator, structured } = await started();
    structured.waitForInput();

    await orchestrator.cancelTask('t1');

    expect(task(orchestrator)).toMatchObject({ status: 'pending' });
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('is dropped when a process that died while waiting fails its verdict', async () => {
    const { orchestrator, structured } = await started();
    structured.waitForInput();

    structured.emitExit(1);
    await vi.waitFor(() => expect(task(orchestrator).status).toBe('failed'));

    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });
});

describe('a checkpoint keeps its reason', () => {
  it('marks a checkpoint call as one, and approve clears it', async () => {
    const { orchestrator, structured } = await started();

    void structured.callCheckpoint('ok?');
    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });

    orchestrator.approveCheckpoint('t1');
    expect(task(orchestrator).status).toBe('in_progress');
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });
  it('does not answer a checkpoint no runner is left to hear', async () => {
    const { orchestrator } = setup();
    orchestrator.loadPlan([{ ...createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', status: 'awaiting_user' }), awaitingReason: 'checkpoint' }]);

    orchestrator.approveCheckpoint('t1');

    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });
  });

  it('does not answer a live task that is waiting for input as though it were a checkpoint', async () => {
    const { orchestrator, structured } = await started();
    structured.waitForInput();

    orchestrator.approveCheckpoint('t1');

    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
    expect(structured.delivered).toEqual(structured.fromOrdewell);
  });
});

describe('through the Session', () => {
  function sessionWith() {
    const sessions: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions): Promise<IRunnerSession> => {
        const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const session = makeSession({ runner, broadcast });
    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
    session.loadPlan(plan, 'Goal', '/repo');
    const lastStatus = () => broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'status_update').at(-1);
    return { session, sessions, broadcast, lastStatus };
  }

  it('saves the wait, and reports its reason and the queued messages on status updates', async () => {
    const { session, sessions, lastStatus } = sessionWith();
    await session.execute({ command: 'force_start', task: 't1' }, { kind: 'user' });

    const id = await sendTaskMessage(session, 't1', 'and the docs');
    expect(lastStatus()).toMatchObject({ tasks: [{ id: 't1', status: 'in_progress', queued: [{ id, text: 'and the docs' }] }] });
    expect(await session.execute({ command: 'remove_queued', task: 't1', id }, { kind: 'user' })).toMatchObject({ ok: true });

    sessions[0].waitForInput();
    await vi.waitFor(() => expect(saves(session).mock.lastCall?.[0].tasks[0]).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' }));
    expect(lastStatus()).toMatchObject({ tasks: [{ id: 't1', status: 'awaiting_user', awaitingReason: 'input' }] });
  });

  it('saves a task back in progress before any surface hears of the message that woke it', async () => {
    const { session, sessions, broadcast } = sessionWith();
    await session.execute({ command: 'force_start', task: 't1' }, { kind: 'user' });
    sessions[0].waitForInput();
    await flushMicrotasks();

    const savesBefore = saves(session).mock.calls.length;
    let savedWhenAnnounced: string | undefined;
    broadcast.mockImplementation((m) => {
      if (m.type === 'status_update') savedWhenAnnounced ??= saves(session).mock.lastCall?.[0].tasks[0].status;
    });
    await sendTaskMessage(session, 't1', 'go on');

    expect(saves(session).mock.calls.length).toBeGreaterThan(savesBefore);
    expect(savedWhenAnnounced).toBe('in_progress');
    expect(sessions[0].delivered.at(-1)).toBe('go on');
  });

  it('interrupts through the Session, and refuses a task that is not running', async () => {
    const { session } = sessionWith();
    await session.execute({ command: 'force_start', task: 't1' }, { kind: 'user' });

    await session.execute({ command: 'interrupt_task', task: 't1' }, { kind: 'user' });
    expect(taskOf(session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });

    const inactive = makeSession();
    inactive.loadPlan({
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    }, 'Goal', '/repo');
    await expect(sendTaskMessage(inactive, 't1', 'hi')).rejects.toThrow(TaskControlError);
  });
});

describe('a plan edit while a task waits on the user mid-attempt', () => {
  it('keeps a task at a checkpoint waiting there', async () => {
    const { orchestrator, structured } = await started({ autonomy: 'HITL' });
    void structured.callCheckpoint('ok?');
    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });

    orchestrator.reconcilePlan(orchestrator.storeInstance.planTasks.map((t) => ({ ...t, status: 'pending' as const, awaitingReason: undefined })));

    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });
  });

  it('keeps a task waiting for input waiting', async () => {
    const { orchestrator, structured } = await started();
    structured.waitForInput();

    orchestrator.reconcilePlan(orchestrator.storeInstance.planTasks.map((t) => ({ ...t })));

    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
  });

  it('keeps the count of the waits it ended since the snapshot was taken (ADR-0053)', async () => {
    const { orchestrator } = await started();
    const snapshot = orchestrator.storeInstance.planTasks.map((t) => ({ ...t }));
    orchestrator.storeInstance.endWait(task(orchestrator)!.id);

    orchestrator.reconcilePlan(snapshot);

    expect(task(orchestrator)?.waitsEnded).toBe(1);
  });
});

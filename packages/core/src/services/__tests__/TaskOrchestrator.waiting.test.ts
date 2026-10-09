import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator, TaskControlError } from '../TaskOrchestrator';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { serializeTaskStatus, type SessionMessage } from '../SessionMessage';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeStructuredSession, FakeTerminalSession, flushMicrotasks } from '../../testing';
import { fakeNotification, makeSession, saves, taskOf } from './sessionTestKit';
import type { ITerminalRunner, ITerminalSession } from '../../interfaces/ITerminalRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/** Structured sessions, or plain ones that only report through the marker — the fakes, driven by hand. */
type SessionKind = 'structured' | 'plain';

function setup(kind: SessionKind = 'structured') {
  const sessions: FakeTerminalSession[] = [];
  const runner = {
    spawn: vi.fn(async (opts: RunnerSpawnOptions): Promise<ITerminalSession> => {
      const id = `s${sessions.length + 1}`;
      const session = kind === 'structured' ? new FakeStructuredSession(id, opts.taskId) : new FakeTerminalSession(id, opts.taskId);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies ITerminalRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    terminalRunner: runner,
    output: new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } }),
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

async function started(kind: SessionKind = 'structured', extra: Partial<Task> = {}) {
  const env = setup(kind);
  env.orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1', ...extra })]);
  await env.orchestrator.forceStartTask('t1');
  const session = env.sessions[0];
  return { ...env, session, structured: session instanceof FakeStructuredSession ? session : null };
}

const task = (orchestrator: TaskOrchestrator) => orchestrator.storeInstance.get('t1')!;

describe('a structured turn that ends without the done marker', () => {
  it('leaves the task waiting for input, saved and announced, with no verdict', async () => {
    const { orchestrator, structured, seen, settled } = await started();

    structured!.emitOutput('I need to know which database to use.\n');
    structured!.emitTurnEnd('completed');

    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
    expect(task(orchestrator).verdict).toBeUndefined();
    expect(settled).toEqual(['t1']);
    expect(seen.at(-1)).toBe('awaiting_user:input');
    expect(serializeTaskStatus(task(orchestrator)).awaitingReason).toBe('input');
  });

  it('is not waiting when the turn carried the marker: the verdict stands', async () => {
    const { orchestrator, structured, seen } = await started();

    structured!.emitOutput('Done.\n<<<ORDEWELL_DONE_mk-1>>>\n');
    structured!.emitTurnEnd('completed');
    await vi.waitFor(() => expect(task(orchestrator).status).toBe('completed'));

    expect(seen).not.toContain('awaiting_user:input');
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('gives way to a checkpoint seen in the same turn', async () => {
    const { orchestrator, structured } = await started();

    structured!.emitOutput('<<<ORDEWELL_CHECKPOINT: use Postgres?>>>\n');
    structured!.emitTurnEnd('completed');

    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });
  });

  it('stays in progress, never passing through waiting, when a queued message goes out as the turn ends', async () => {
    const { orchestrator, structured, seen, settled } = await started();
    orchestrator.sendTaskMessage('t1', 'also add tests');
    seen.length = 0;

    structured!.emitTurnEnd('completed');

    expect(task(orchestrator).status).toBe('in_progress');
    expect(structured!.delivered).toEqual(['also add tests']);
    expect(seen.every((s) => s === 'in_progress')).toBe(true);
    expect(settled).toEqual([]);
    expect(orchestrator.getQueuedTaskMessages('t1')).toEqual([]);
  });

  it('pauses the idle flag while waiting, and resumes it with the next turn', async () => {
    vi.useFakeTimers();
    try {
      const { orchestrator, structured } = await started();
      structured!.emitOutput('working\n');
      structured!.emitTurnEnd('completed');

      vi.advanceTimersByTime(120_000);
      expect(orchestrator.getIdleSince('t1')).toBeNull();

      orchestrator.sendTaskMessage('t1', 'go on');
      vi.advanceTimersByTime(60_000);
      expect(orchestrator.getIdleSince('t1')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is ignored once its attempt was cancelled', async () => {
    const { orchestrator, structured } = await started();
    await orchestrator.cancelTask('t1');

    structured!.emitTurnEnd('completed');

    expect(task(orchestrator).status).toBe('pending');
  });
});

describe('sending a structured task a message', () => {
  it('queues it behind a running turn, lists it in status updates, and can take it back', async () => {
    const { orchestrator, structured } = await started();

    const id = orchestrator.sendTaskMessage('t1', '  use the existing helper  ');

    expect(structured!.delivered).toEqual([]);
    expect(orchestrator.getQueuedTaskMessages('t1')).toEqual([{ id, text: 'use the existing helper' }]);
    expect(serializeTaskStatus(task(orchestrator), null, null, orchestrator.getQueuedTaskMessages('t1')).queued).toEqual([{ id, text: 'use the existing helper' }]);

    expect(orchestrator.removeQueuedTaskMessage('t1', id)).toBe(true);
    expect(orchestrator.removeQueuedTaskMessage('t1', id)).toBe(false);
    expect(serializeTaskStatus(task(orchestrator), null, null, orchestrator.getQueuedTaskMessages('t1'))).not.toHaveProperty('queued');
  });

  it('delivers it at once to a task waiting for input, which is back in progress', async () => {
    const { orchestrator, structured } = await started();
    structured!.emitTurnEnd('completed');

    orchestrator.sendTaskMessage('t1', 'Postgres.');

    expect(structured!.delivered).toEqual(['Postgres.']);
    expect(task(orchestrator).status).toBe('in_progress');
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('refuses a message to a task at a checkpoint, which approve or reject answers', async () => {
    const { orchestrator, structured } = await started();
    structured!.emitOutput('<<<ORDEWELL_CHECKPOINT: ok?>>>\n');
    structured!.emitTurnEnd('completed');

    expect(() => orchestrator.sendTaskMessage('t1', 'yes')).toThrow(/checkpoint/);

    orchestrator.approveCheckpoint('t1');
    expect(task(orchestrator).status).toBe('in_progress');
    expect(task(orchestrator).awaitingReason).toBeUndefined();
    expect(structured!.delivered).toEqual(['ORDEWELL_CONTINUE']);
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

    expect(structured!.interrupts).toBe(1);
    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
    expect(settled).toEqual(['t1']);
  });
});

describe('talking to a task whose session is not structured', () => {
  it('refuses all three calls, saying there is no turn', async () => {
    const { orchestrator, session } = await started('plain');

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
    structured!.emitOutput('<<<ORDEWELL_DONE_mk-1>>>\n');

    expect(() => orchestrator.sendTaskMessage('t1', 'one more thing')).toThrow(/not running/);
    await flushMicrotasks();
  });
});

describe('the saved reason, cleared on every way out of waiting', () => {
  it('is dropped by a retry', async () => {
    const { orchestrator, structured } = await started();
    structured!.emitTurnEnd('completed');

    await orchestrator.retryTask('t1');

    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('is dropped by Mark complete', async () => {
    const { orchestrator, structured } = await started();
    structured!.emitTurnEnd('completed');

    await orchestrator.markTaskComplete('t1');

    expect(task(orchestrator)).toMatchObject({ status: 'completed' });
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('is dropped by a cancel back to pending', async () => {
    const { orchestrator, structured } = await started();
    structured!.emitTurnEnd('completed');

    await orchestrator.cancelTask('t1');

    expect(task(orchestrator)).toMatchObject({ status: 'pending' });
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('is dropped when a process that died while waiting fails its verdict', async () => {
    const { orchestrator, structured } = await started();
    structured!.emitTurnEnd('completed');

    structured!.emitExit(1);
    await vi.waitFor(() => expect(task(orchestrator).status).toBe('failed'));

    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });
});

describe('a marker checkpoint keeps its reason', () => {
  it('marks a marker checkpoint as one, and approve clears it', async () => {
    const { orchestrator, session } = await started('plain');

    session.emitOutput('<<<ORDEWELL_CHECKPOINT: ok?>>>');
    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });

    orchestrator.approveCheckpoint('t1');
    expect(task(orchestrator).status).toBe('in_progress');
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });

  it('does not answer a checkpoint no runner is left to hear', async () => {
    const { orchestrator } = setup('plain');
    orchestrator.loadPlan([{ ...createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', status: 'awaiting_user' }), awaitingReason: 'checkpoint' }]);

    orchestrator.approveCheckpoint('t1');

    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });
  });

  it('does not answer a live task that is waiting for input as though it were a checkpoint', async () => {
    const { orchestrator, structured } = await started();
    structured!.emitTurnEnd('completed');

    orchestrator.approveCheckpoint('t1');

    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
    expect(structured!.delivered).toEqual([]);
  });
});

describe('a structured checkpoint, answered as a terminal one is (VerdictEngine unchanged)', () => {
  it.each<[string, (o: TaskOrchestrator) => void, string]>([
    ['approve', (o) => o.approveCheckpoint('t1'), 'ORDEWELL_CONTINUE'],
    ['reject', (o) => o.rejectCheckpoint('t1', 'keep the README'), 'ORDEWELL_REJECT: keep the README'],
  ])('%s is written to the session and goes out as the next user turn', async (_how, answer, token) => {
    const { orchestrator, structured } = await started();
    structured!.emitOutput('<<<ORDEWELL_CHECKPOINT: about to delete README.md>>>\n');
    structured!.emitTurnEnd('completed');
    expect(task(orchestrator)).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });

    answer(orchestrator);

    expect(structured!.written).toEqual([`\n${token}\n`]);
    expect(structured!.delivered).toEqual([token]);
    expect(task(orchestrator).status).toBe('in_progress');
    expect(task(orchestrator).awaitingReason).toBeUndefined();
  });
});

describe('through the Session', () => {
  function sessionWith() {
    const sessions: FakeStructuredSession[] = [];
    const runner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions): Promise<ITerminalSession> => {
        const session = new FakeStructuredSession(`s${sessions.length + 1}`, opts.taskId);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies ITerminalRunner;
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const session = makeSession({ runner, broadcast });
    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })],
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
    await session.forceStartTask('t1');

    const id = session.sendTaskMessage('t1', 'and the docs');
    expect(lastStatus()).toMatchObject({ tasks: [{ id: 't1', status: 'in_progress', queued: [{ id, text: 'and the docs' }] }] });
    expect(session.removeQueuedTaskMessage('t1', id)).toBe(true);

    sessions[0].emitTurnEnd('completed');
    await vi.waitFor(() => expect(saves(session).mock.lastCall?.[0].tasks[0]).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' }));
    expect(lastStatus()).toMatchObject({ tasks: [{ id: 't1', status: 'awaiting_user', awaitingReason: 'input' }] });
  });

  it('saves a task back in progress before any surface hears of the message that woke it', async () => {
    const { session, sessions, broadcast } = sessionWith();
    await session.forceStartTask('t1');
    sessions[0].emitTurnEnd('completed');
    await flushMicrotasks();

    const savesBefore = saves(session).mock.calls.length;
    let savedWhenAnnounced: string | undefined;
    broadcast.mockImplementation((m) => {
      if (m.type === 'status_update') savedWhenAnnounced ??= saves(session).mock.lastCall?.[0].tasks[0].status;
    });
    session.sendTaskMessage('t1', 'go on');

    expect(saves(session).mock.calls.length).toBeGreaterThan(savesBefore);
    expect(savedWhenAnnounced).toBe('in_progress');
    expect(sessions[0].delivered).toEqual(['go on']);
  });

  it('interrupts through the Session, and refuses a terminal task', async () => {
    const { session } = sessionWith();
    await session.forceStartTask('t1');

    await session.interruptTask('t1');
    expect(taskOf(session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });

    const terminal = makeSession();
    terminal.loadPlan({
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    }, 'Goal', '/repo');
    await terminal.forceStartTask('t1');
    expect(() => terminal.sendTaskMessage('t1', 'hi')).toThrow(TaskControlError);
  });
});

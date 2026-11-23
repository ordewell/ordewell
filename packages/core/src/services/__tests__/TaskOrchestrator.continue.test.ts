import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator, TaskControlError } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { serializeTaskStatus } from '../SessionMessage';
import { continuability } from '../continuation';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification, makeSession, saves } from './sessionTestKit';
import type { LegacyPlanState } from '../../models/Task';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { RunnerStartupExit } from '../harness/ordewellBinding';

/**
 * Runner sessions with controllable resume behavior.
 * `resumes` says what a resumed spawn's runner announces — the session it
 * took up, or null for one it could not find.
 */
function routingRunner(opts: { resumes?: (id: string) => string | null } = {}) {
  const sessions: FakeRunnerSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      requests.push(o);
      const id = `s${sessions.length + 1}`;
      const native = o.resumeSessionId ? (opts.resumes ?? ((resumed) => resumed))(o.resumeSessionId) : `native-${o.taskId}-${sessions.length + 1}`;
      const session = new FakeRunnerSession(id, o.taskId, native);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  return { runner, sessions, requests };
}

function setup(opts: { runner?: IRunner; isolation?: IWorktreeIsolation; resumes?: (id: string) => string | null } = {}) {
  const routed = routingRunner({ resumes: opts.resumes });
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: opts.isolation !== undefined }),
    notifications,
    runner: opts.runner ?? routed.runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    isolation: opts.isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const task = (id: string) => orchestrator.storeInstance.get(id)!;
  return { orchestrator, notifications, task, ...routed };
}

// Spread over `createTask`, which drops the fields only a run sets (transport, awaiting reason).
const plan = (overrides: Partial<Task> = {}): Task => ({
  ...createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'ORIGINAL PROMPT BODY' }),
  ...overrides,
});

/** Run t1 to a pass on the structured transport, leaving its session id saved. */
async function completedStructured(h: ReturnType<typeof setup>): Promise<void> {
  await h.orchestrator.forceStartTask('t1');
  h.sessions[0].emitOutput('Parsed objects.\n');
  h.sessions[0].reportComplete({ status: 'done', summary: '' });
  h.sessions[0].emitOutput('\n');
  await vi.waitFor(() => expect(h.task('t1').status).toBe('completed'));
}

describe('which tasks can be continued (ADR-0018, K1)', () => {
  const savedSessionId = 'sess-1';

  it('a completed or failed task that ran structured and saved its session', () => {
    expect(continuability(plan({ status: 'completed', runnerSessionId: savedSessionId }))).toEqual({ ok: true, sessionId: 'sess-1' });
    expect(continuability(plan({ status: 'failed', runnerSessionId: savedSessionId }))).toEqual({ ok: true, sessionId: 'sess-1' });
  });

  it('a task paused on a usage limit that saved its session, with or without a resume time', () => {
    expect(continuability(plan({ status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2026-10-11T20:11:00.000Z', runnerSessionId: savedSessionId })))
      .toEqual({ ok: true, sessionId: 'sess-1' });
    expect(continuability(plan({ status: 'awaiting_user', awaitingReason: 'usage-limit', runnerSessionId: savedSessionId }))).toEqual({ ok: true, sessionId: 'sess-1' });
    expect(continuability(plan({ status: 'awaiting_user', awaitingReason: 'usage-limit' }))).toEqual({ ok: false, reason: expect.stringContaining('no saved session') });
  });

  it('not a task waiting for input or at a checkpoint', () => {
    for (const awaitingReason of ['input', 'checkpoint'] as const) {
      expect(continuability(plan({ status: 'awaiting_user', awaitingReason, runnerSessionId: savedSessionId })).ok).toBe(false);
    }
  });

  it('not a conflict, which its repair resolves', () => {
    const verdict = continuability(plan({ status: 'awaiting_user', awaitingReason: 'conflict', runnerSessionId: savedSessionId }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining('merge conflict') });
  });

  it('not a task with no saved session', () => {
    expect(continuability(plan({ status: 'completed' }))).toEqual({ ok: false, reason: expect.stringContaining('no saved session') });
    expect(continuability(plan({ status: 'failed', runnerSessionId: undefined }))).toEqual({ ok: false, reason: expect.stringContaining('no saved session') });
  });

  it('not a task whose saved session belongs to another runner than the one it is now assigned', () => {
    const moved = plan({ status: 'failed', runnerSessionId: savedSessionId, runnerSessionOwner: 'claude-code', assignedRunner: 'codex' });
    expect(continuability(moved)).toEqual({
      ok: false,
      reason: 'Task "Parse JSON" cannot be continued: its saved session belongs to claude-code; Retry starts fresh on codex and carries over its files.',
    });
    expect(continuability({ ...moved, status: 'completed' }).ok).toBe(false);
    expect(continuability({ ...moved, assignedRunner: 'claude-code' })).toEqual({ ok: true, sessionId: 'sess-1' });
  });

  it('reads the owner of a session saved before owners were recorded from the last attempt\'s runner', () => {
    const attemptUsage = [
      { attempt: 1, runner: 'opencode', startedAt: '2026-10-01T10:00:00.000Z', wallTimeMs: 0, totals: {}, byModel: [] },
      { attempt: 2, runner: 'claude-code', startedAt: '2026-10-01T11:00:00.000Z', wallTimeMs: 0, totals: {}, byModel: [] },
    ];
    const old = plan({ status: 'failed', runnerSessionId: savedSessionId, attemptUsage, assignedRunner: 'codex' });
    expect(continuability(old)).toEqual({ ok: false, reason: expect.stringContaining('belongs to claude-code') });
    expect(continuability({ ...old, assignedRunner: 'claude-code' }).ok).toBe(true);
  });

  it('a task stopped mid-attempt, which is back to not started with its session saved', () => {
    expect(continuability(plan({ status: 'pending', runnerSessionId: savedSessionId }))).toEqual({ ok: true, sessionId: 'sess-1' });
  });

  it('a task whose stopped attempt saved no session is refused for that, not for its status', () => {
    const stoppedAttempt = [{ attempt: 1, runner: 'claude-code', startedAt: '2026-10-01T10:00:00.000Z', wallTimeMs: 0, totals: {}, byModel: [], outcome: 'stopped' as const }];
    expect(continuability(plan({ status: 'pending', attemptUsage: stoppedAttempt }))).toEqual({
      ok: false,
      reason: 'Task "Parse JSON" cannot be continued: its stopped attempt left no saved session to resume. Use Retry instead.',
    });
    // Never run, or its last attempt ended otherwise: still not a task that can be continued at all.
    expect(continuability(plan({ status: 'pending' }))).toEqual({ ok: false, reason: expect.stringContaining('only a completed') });
  });

  it('not a task still running, waiting, or never run, nor a user task', () => {
    for (const status of ['in_progress', 'awaiting_user'] as const) {
      expect(continuability(plan({ status, runnerSessionId: savedSessionId })).ok).toBe(false);
    }
    expect(continuability(plan({ status: 'pending' }))).toEqual({
      ok: false,
      reason: 'Task "Parse JSON" cannot be continued: only a completed, failed, stopped or skipped task, or one paused on a usage limit, can be.',
    });
    expect(continuability(plan({ type: 'user', status: 'completed', runnerSessionId: savedSessionId })).ok).toBe(false);
  });

  it('is on the task\'s status for surfaces, without the session id itself', () => {
    const status = serializeTaskStatus(plan({ status: 'completed', runnerSessionId: savedSessionId }));
    expect(status.continuable).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sess-1');
    expect(serializeTaskStatus(plan({ status: 'completed' }))).not.toHaveProperty('continuable');
  });
});

describe('TaskOrchestrator.continueTask', () => {
  it('resumes the saved session with the message and a protocol reminder, not the original prompt', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await completedStructured(h);

    await h.orchestrator.continueTask('t1', '  also handle arrays  ');

    const request = h.requests.at(-1)!;
    expect(request).toMatchObject({ resumeSessionId: 'native-t1-1', runner: 'claude-code' });
    expect(request.prompt.startsWith('also handle arrays\n')).toBe(true);
    expect(request.prompt).toContain('continuing this task in the same session');
    expect(request.prompt).not.toContain('task_complete');
    expect(request.prompt).not.toContain('ORIGINAL PROMPT BODY');
    expect(h.task('t1').status).toBe('in_progress');
  });

  it('is verified by its own task_complete call and summarized from the continued attempt', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await completedStructured(h);

    await h.orchestrator.continueTask('t1', 'also handle arrays');
    expect(h.task('t1').verdict).toBeUndefined();
    h.sessions[1].emitOutput('Arrays handled too.\n');
    h.sessions[1].reportComplete({ status: 'done', summary: '' });
    h.sessions[1].emitOutput('\n');

    await vi.waitFor(() => expect(h.task('t1').status).toBe('completed'));
    expect(h.task('t1').verdict?.outcome).toBe('pass');
    expect(h.task('t1').outputSummary?.logTail).toContain('Arrays handled too.');
    expect(h.task('t1').outputSummary?.logTail).not.toContain('Parsed objects.');
    expect(h.task('t1').runnerSessionId).toBe('native-t1-1');
  });

  it('continues a failed task, which is reminded afresh and then waits for input when its turns end without a task_complete call', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.task('t1').status).toBe('failed'));

    await h.orchestrator.continueTask('t1', 'the tests need Node 22');
    const continued = h.sessions[1] as FakeRunnerSession;
    continued.emitTurnEnd('completed');
    expect(h.task('t1').status).toBe('in_progress');
    expect(continued.fromOrdewell).toHaveLength(1);
    continued.emitTurnEnd('completed');

    expect(h.task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
  });

  it('leaves dependents alone, as retry does', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan(), createTask({ id: 't2', order: 2, title: 'Use it', prompt: 'two', dependencies: ['t1'] })]);
    await h.orchestrator.approveReview();
    h.sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(h.sessions).toHaveLength(2));
    h.sessions[1].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(h.orchestrator.status).toBe('completed'));
    const t2Before = { ...h.task('t2') };

    await h.orchestrator.continueTask('t1', 'rename the parser');

    expect(h.sessions).toHaveLength(3);
    expect(h.requests.at(-1)!.taskId).toBe('t1');
    expect(h.task('t2')).toMatchObject({ status: 'completed', verdict: t2Before.verdict, outputSummary: t2Before.outputSummary });
  });

  it('recreates the worktree at the task\'s own path', async () => {
    const isolation = new FakeWorktreeIsolation();
    const h = setup({ isolation });
    h.orchestrator.loadPlan([plan(), createTask({ id: 't2', order: 2, title: 'Other', prompt: 'two' })]);
    await h.orchestrator.forceStartTask('t2');
    await h.orchestrator.forceStartTask('t1');
    h.sessions[1].emitExit(1);
    await vi.waitFor(() => expect(h.task('t1').status).toBe('failed'));

    await h.orchestrator.continueTask('t1', 'try again with the fixture');

    expect(isolation.taskIdsFor('prepare')).toEqual(['t2', 't1', 't1']);
    const cwds = h.requests.filter((r) => r.taskId === 't1').map((r) => r.cwd);
    expect(cwds).toHaveLength(2);
    expect(cwds[1]).toBe(cwds[0]);
  });

  it('refuses a conflict, a task with no saved session and an unfinished one with the reason', async () => {
    const h = setup();
    h.orchestrator.loadPlan([
      plan({ status: 'awaiting_user', awaitingReason: 'conflict', runnerSessionId: 'sess-1' }),
      createTask({ id: 't2', order: 2, title: 'Unsaved', prompt: 'two', status: 'completed' }),
      createTask({ id: 't3', order: 3, title: 'Pending', prompt: 'three' }),
    ]);

    await expect(h.orchestrator.continueTask('t1', 'go on')).rejects.toThrow(/merge conflict/);
    await expect(h.orchestrator.continueTask('t2', 'go on')).rejects.toThrow(/no saved session.*Retry/);
    await expect(h.orchestrator.continueTask('t3', 'go on')).rejects.toBeInstanceOf(TaskControlError);
    await expect(h.orchestrator.continueTask('t1', '   ')).rejects.toThrow(/cannot be empty/);
    expect(h.requests).toHaveLength(0);
  });

  it('fails a task whose runner now has no structured connector, without reaching the runner', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan({ status: 'completed', assignedRunner: 'my-plugin', runnerSessionId: 'sess-1' })], ['my-plugin']);

    await h.orchestrator.continueTask('t1', 'go on');

    expect(h.task('t1').status).toBe('failed');
    expect(h.notifications.error).toHaveBeenCalledWith(expect.stringContaining('could not start: my-plugin has no structured connector'));
    expect(h.requests).toHaveLength(0);
  });

  it('awaits the claimed start when continuing a run that ended on a failure throws, instead of leaving it unhandled', async () => {
    const sessions: FakeRunnerSession[] = [];
    let boom = false;
    const runner = {
      spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
        if (boom) throw new Error('spawn boom');
        const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${sessions.length + 1}`);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const orchestrator = TaskOrchestrator.compose({
        config: fakeConfig({ worktreeIsolation: false }),
        notifications: fakeNotification(),
        runner,
        output: new BufferedTaskOutputSource(),
        registry: new RunnerRegistry(),
        workspaceRoot: () => '/repo',
        workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
        // Throws only once the run has ended, so continuing it is what fails.
        runSettings: () => { if (boom) throw new Error('settings boom'); return { mergeAtGatesAutomatically: false }; },
      });
      orchestrator.loadPlan([
        createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'ORIGINAL PROMPT BODY' }),
        createTask({ id: 't2', order: 2, title: 'Other', prompt: 'two' }),
      ]);
      await orchestrator.forceStartTask('t1');
      sessions[0].reportComplete({ status: 'done', summary: '' });
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

      // A full-plan run that ends on a failure; continuing a task resumes it.
      await orchestrator.approveReview();
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t2')!.status).toBe('in_progress'));
      sessions.find((s) => s.taskId === 't2')!.emitExit(1);
      await vi.waitFor(() => expect(orchestrator.storeInstance.get('t2')!.status).toBe('failed'));
      expect(orchestrator.awaitsResume).toBe(true);

      boom = true;
      await expect(orchestrator.continueTask('t1', 'go on')).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('a continue whose session cannot be resumed', () => {
  it('fails with a message suggesting Retry, and never waits for input in a session that does not exist', async () => {
    const h = setup({ resumes: () => null });
    h.orchestrator.loadPlan([plan()]);
    await completedStructured(h);

    await h.orchestrator.continueTask('t1', 'also handle arrays');
    const resumed = h.sessions[1] as FakeRunnerSession;
    resumed.emitOutput('No conversation found with session ID: native-t1-1\n');
    resumed.emitTurnEnd('failed');

    expect(resumed.killed).toBe(true);
    expect(h.task('t1').status).toBe('in_progress');
    resumed.emitExit(-1);

    await vi.waitFor(() => expect(h.task('t1').status).toBe('failed'));
    expect(h.notifications.error).toHaveBeenCalledWith(expect.stringMatching(/Could not continue task "Parse JSON": claude-code could not find its saved session\. Retry starts it afresh\./));
    expect(h.task('t1').outputSummary?.reviewReason).toMatch(/Retry starts it afresh/);
    expect(h.task('t1').outputSummary?.logTail).toContain('No conversation found');
    // Nothing was taken up, so there is nothing left to offer a continue of.
    expect(continuability(h.task('t1')).ok).toBe(false);
    expect(h.requests).toHaveLength(2);
  });

  it('fails the attempt when the runner cannot be started at all', async () => {
    const failing = {
      spawn: vi.fn(async () => { throw new Error('claude: command not found'); }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const h = setup({ runner: failing });
    h.orchestrator.loadPlan([plan({ status: 'completed', runnerSessionId: 'sess-1' })]);

    await h.orchestrator.continueTask('t1', 'go on');

    expect(h.task('t1').status).toBe('failed');
    expect(h.task('t1').outputSummary?.reviewReason).toBe('Could not continue task "Parse JSON": could not start: claude: command not found. Retry starts it afresh.');
  });

  // What `claude --resume` does with a session it cannot find: says so on
  // stderr and exits before Ordewell's tools are even checked.
  it('fails in the runner\'s own words when it exits while starting on the saved session', async () => {
    const exiting = {
      spawn: vi.fn(async () => { throw new RunnerStartupExit('The claude-code task runner exited with code 1.\n\nNo conversation found with session ID: sess-1'); }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const h = setup({ runner: exiting });
    h.orchestrator.loadPlan([plan({ status: 'completed', runnerSessionId: 'sess-1' })]);

    await h.orchestrator.continueTask('t1', 'go on');

    expect(h.task('t1').status).toBe('failed');
    expect(h.task('t1').outputSummary?.reviewReason).toBe('Could not continue task "Parse JSON": claude-code could not find its saved session. Retry starts it afresh.');
    expect(h.task('t1').outputSummary?.logTail).toContain('No conversation found with session ID: sess-1');
    expect(exiting.spawn).toHaveBeenCalledTimes(1);
    // The runner refused the session, so it is no longer offered to continue.
    expect(continuability(h.task('t1')).ok).toBe(false);
  });
});

describe('a fresh start whose runner exits while starting', () => {
  it('fails the task in the runner\'s own words, rather than holding it as never started', async () => {
    const exiting = {
      spawn: vi.fn(async () => { throw new RunnerStartupExit('The claude-code task runner exited with code 1.\n\nInvalid API key'); }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const h = setup({ runner: exiting });
    h.orchestrator.loadPlan([plan()]);

    await h.orchestrator.forceStartTask('t1');

    expect(h.task('t1').status).toBe('failed');
    expect(h.task('t1').outputSummary?.logTail).toContain('Invalid API key');
    expect(h.notifications.error).toHaveBeenCalledWith(expect.stringContaining('Invalid API key'));
  });
});

describe('continuing a task in its saved session at the seam', () => {
  it('saves the continued attempt\'s start, so a reload does not show the old outcome', async () => {
    const { runner, sessions } = routingRunner();
    const session = makeSession({ runner });
    const saved: LegacyPlanState = {
      tasks: [plan()],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
    session.loadPlan(saved, 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(saves(session).mock.lastCall?.[0].tasks[0].status).toBe('completed'));

    await session.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'also handle arrays' }, { kind: 'user' });

    const last = saves(session).mock.lastCall?.[0].tasks[0];
    expect(last).toMatchObject({ status: 'in_progress', verdict: undefined });
    await expect(session.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'again' }, { kind: 'user' })).resolves.toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/is running: stop it first, or send it a message/) });
  });
});

describe('a session saved before its owner or its attempts were recorded', () => {
  // Its runner then is the only one it can belong to, and a move must not lose that.
  it('is not offered to the runner the task is moved to', async () => {
    const session = makeSession({ modelResolver: { modelsForRunners: vi.fn().mockResolvedValue({}) } });
    const saved: LegacyPlanState = {
      tasks: [plan({ status: 'completed', assignedRunner: 'claude-code', runnerSessionId: 'native-claude' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code', 'codex'],
      lastUpdated: new Date().toISOString(),
    };
    session.loadPlan(saved, 'Goal', '/repo', { persist: false });

    await session.setTaskRunner('t1', 'codex');

    const moved = session.planTasks[0];
    expect(continuability(moved)).toEqual({ ok: false, reason: expect.stringContaining('its saved session belongs to claude-code') });
    await expect(session.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'carry on' }, { kind: 'user' })).resolves.toMatchObject({ ok: false, outcome: 'refused', message: expect.stringContaining('its saved session belongs to claude-code') });
  });
});

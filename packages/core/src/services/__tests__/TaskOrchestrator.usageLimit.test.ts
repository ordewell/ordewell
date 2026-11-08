import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { serializeTaskStatus } from '../SessionMessage';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { RunnerStartupExit } from '../harness/ordewellBinding';

// Claude Code 2.1.296's wording (#84); the zone is UTC so the expected times
// do not depend on the machine's.
const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";
const NOW = new Date('2026-10-11T17:00:00Z');
const RESUME_AT = '2026-10-11T20:11:00.000Z';

function setup(opts: { maxParallelSessions?: number; isolation?: FakeWorktreeIsolation; mergeAutomatically?: boolean } = {}) {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${sessions.length + 1}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions: opts.maxParallelSessions ?? 3 }),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    ...(opts.isolation ? { isolation: opts.isolation } : {}),
    runSettings: () => ({ mergeAtGatesAutomatically: opts.mergeAutomatically ?? false }),
  });
  const waits: { taskId: string; runner: string; resumeAt: string | null; cancelled?: true }[] = [];
  orchestrator.subscribe({ onUsageLimitWait: (data) => waits.push(data) });
  const task = (id: string): Readonly<Task> => orchestrator.storeInstance.get(id)!;
  return { orchestrator, sessions, spawn: runner.spawn, notifications, waits, task };
}

/** The limit as the structured transport delivers it: the turn's error event, then a failed turn. */
function hitLimitInTurn(session: FakeRunnerSession, message = LIMIT): void {
  session.emitEvent({ type: 'error', message });
  session.emitOutput(`${message}\n`);
  session.emitTurnEnd('failed');
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) await flushMicrotasks();
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a task paused on a usage limit', () => {
  it('records the reason and the resume time, and says when it resumes', async () => {
    const { orchestrator, sessions, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT, runnerSessionId: 'native-1' });
    expect(waits).toEqual([{ taskId: 't1', runner: 'claude-code', resumeAt: RESUME_AT }]);
    expect(serializeTaskStatus(task('t1') as Task)).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
  });

  it('resumes at the reset, continuing its saved session, and releases the run it held', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();

    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    expect(orchestrator.status).toBe('approved');

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-1' });
    expect(spawn.mock.calls[1][0].prompt).toContain('usage limit has reset');
    expect(task('t1').status).toBe('in_progress');
    expect(task('t1').resumeAt).toBeUndefined();
    expect(orchestrator.status).toBe('running');

    sessions[1].reportComplete({ status: 'done', summary: '' });
    await until(() => spawn.mock.calls.length === 3);
    expect(spawn.mock.calls[2][0].taskId).toBe('t2');
  });

  it('resumes counting the paused session on from what its wind-down reported', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].cost = { sessionId: 'native-1', usd: 0.5, modelUsd: {} };
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    // The limit's own turn still ends with its cost after the pause was recorded.
    sessions[0].cost = { sessionId: 'native-1', usd: 0.75, modelUsd: {} };
    sessions[0].emitExit(1);
    await flushMicrotasks();
    expect(task('t1').attemptUsage?.at(-1)?.runnerSessionCost).toMatchObject({ usd: 0.75 });

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0]).toMatchObject({
      taskId: 't1',
      resumeSessionId: 'native-1',
      resumeCost: { sessionId: 'native-1', usd: 0.75, modelUsd: {} },
    });
    orchestrator.stop();
  });

  it('holds the run until the reset even past a failure, then resumes it (ADR-0034)', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 2 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 'f', order: 2, title: 'Fails', prompt: 'do it' }),
      createTask({ id: 't3', order: 3, title: 'Independent', prompt: 'do third' }),
    ]);
    await orchestrator.approveReview();

    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    sessions[1].reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await until(() => task('f').status === 'failed');
    expect(spawn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 4);
    expect(spawn.mock.calls.slice(2).map(([o]) => o.taskId)).toEqual(['t1', 't3']);
  });

  it('resumes at the reset the runner reported in a field, when its words name no time', async () => {
    const { orchestrator, sessions, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'codex' })], ['codex']);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitEvent({ type: 'error', message: "You've hit your usage limit. Try again later.", usageLimit: { resetsAt: '2026-10-11T20:42:55.000Z' } });
    sessions[0].emitTurnEnd('failed');
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: '2026-10-11T20:43:55.000Z' });
    expect(waits).toEqual([{ taskId: 't1', runner: 'codex', resumeAt: '2026-10-11T20:43:55.000Z' }]);
  });

  it('does not pause when the runner\'s field names another cause, though its words read like a limit', async () => {
    const { orchestrator, sessions, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'codex' })], ['codex']);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitEvent({ type: 'error', message: 'Rate limit reached for gpt-5.5.', usageLimit: false });
    sessions[0].emitTurnEnd('failed');
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1').awaitingReason).toBe('input');
    expect(waits).toEqual([]);
  });

  it('pauses the same way when the runner exits on the limit', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput(LIMIT);
    sessions[0].emitExit(1);
    await until(() => task('t1').status === 'awaiting_user');
    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT });

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);
  });

  it('waits for a manual retry when the runner gave no reset time, as before', async () => {
    const { orchestrator, sessions, spawn, notifications, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    hitLimitInTurn(sessions[0], 'Rate limit exceeded. Please try again later.');
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1').awaitingReason).toBe('usage-limit');
    expect(task('t1').resumeAt).toBeUndefined();
    expect(waits).toEqual([{ taskId: 't1', runner: 'claude-code', resumeAt: null }]);
    expect(notifications.warn).toHaveBeenCalledWith('Task "Only" stopped before it reported completion: claude-code hit its usage limit. Retry it once the limit resets.');
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('returns to the manual state when its resume is cancelled', async () => {
    const { orchestrator, sessions, spawn, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    expect(await orchestrator.cancelScheduledResume('t1')).toBe(true);

    expect(task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' });
    expect(task('t1').resumeAt).toBeUndefined();
    expect(waits.at(-1)).toEqual({ taskId: 't1', runner: 'claude-code', resumeAt: null, cancelled: true });
    expect(await orchestrator.cancelScheduledResume('t1')).toBe(false);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(1);

    await orchestrator.retryTask('t1');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('falls back to manual, and says so, when the resumed attempt hits the limit again at once', async () => {
    const { orchestrator, sessions, spawn, notifications, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);

    hitLimitInTurn(sessions[1], "You've hit your session limit · resets 1:10am (UTC)");
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1').awaitingReason).toBe('usage-limit');
    expect(task('t1').resumeAt).toBeUndefined();
    expect(notifications.warn).toHaveBeenCalledWith(expect.stringContaining('hit its usage limit again right after it was resumed'));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('resumes again when a resumed attempt worked a while before the next limit', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    hitLimitInTurn(sessions[1], "You've hit your session limit · resets 3:10am (UTC)");
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1').resumeAt).toBe('2026-10-12T03:11:00.000Z');
  });

  it('shares one wait per runner: tasks paused on it resume together, at the later reset', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    expect(spawn).toHaveBeenCalledTimes(2);

    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    hitLimitInTurn(sessions[1], "You've hit your weekly limit · resets 8:40pm (UTC)");
    await until(() => task('t2').status === 'awaiting_user');

    const shared = '2026-10-11T20:41:00.000Z';
    expect(task('t1').resumeAt).toBe(shared);
    expect(task('t2').resumeAt).toBe(shared);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    expect(spawn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(Date.parse(shared) - Date.now());
    await until(() => spawn.mock.calls.length === 4);
    expect(spawn.mock.calls.slice(2).map(([o]) => [o.taskId, o.resumeSessionId])).toEqual([['t1', 'native-1'], ['t2', 'native-2']]);
  });

  it('starts at the reset a start the user asked for under the rule, which the limit held back', async () => {
    const { orchestrator, sessions, spawn, notifications, task } = setup();
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').resumeAt === RESUME_AT);

    orchestrator.startWhenAllowed('t2');
    await orchestrator.tick();
    expect(vi.mocked(notifications.info).mock.calls.flat()).toContain('Task "Second" has not started: its runner is on a usage limit, so it starts after the reset.');
    expect(spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.some(([o]) => o.taskId === 't2'));
    expect(orchestrator.startQueuedFor('t2')).toBe(false);
  });

  it('a stop cancels the resume: the task waits for the user', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    orchestrator.stop();

    expect(task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' });
    expect(task('t1').resumeAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('awaits the resumed attempt\'s start when restarting the run throws, instead of leaving it unhandled', async () => {
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
        config: fakeConfig(),
        notifications: fakeNotification(),
        runner,
        output: new BufferedTaskOutputSource(),
        registry: new RunnerRegistry(),
        workspaceRoot: () => '/repo',
        workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
        runSettings: () => { if (boom) throw new Error('settings boom'); return { mergeAtGatesAutomatically: false }; },
      });
      orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
      await orchestrator.approveReview();
      hitLimitInTurn(sessions[0]);
      await until(() => orchestrator.storeInstance.get('t1')!.status === 'awaiting_user');
      expect(orchestrator.awaitsResume).toBe(true);

      boom = true;
      await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
      await flushMicrotasks(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not resume an ops task into a Merge all under way at its reset, and leaves it to the user (ADR-0020)', async () => {
    const isolation = new FakeWorktreeIsolation();
    const { orchestrator, sessions, spawn, notifications, task } = setup({ isolation });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Change', prompt: 'do change' }),
      createTask({ id: 'o2', order: 2, title: 'Deploy', prompt: 'deploy', ops: true }),
    ]);
    await orchestrator.approveReview();
    await until(() => spawn.mock.calls.length === 2);
    const opsSession = sessions.find((s) => s.taskId === 'o2')!;
    hitLimitInTurn(opsSession);
    await until(() => task('o2').status === 'awaiting_user');
    sessions.find((s) => s.taskId === 't1')!.reportComplete({ status: 'done', summary: '' });
    await until(() => task('t1').status === 'completed');
    let spawnedDuringMerge = -1;
    isolation.mergeIntoCheckedOut = async () => {
      await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
      await flushMicrotasks(20);
      spawnedDuringMerge = spawn.mock.calls.length;
      return { outcome: 'merged' };
    };

    await orchestrator.mergeRun();

    expect(spawnedDuringMerge).toBe(2);
    expect(task('o2')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' });
    expect(task('o2').resumeAt).toBeUndefined();
    expect(notifications.warn).toHaveBeenCalledWith('Task "Deploy" did not resume at its usage limit\'s reset: A Merge all is under way: ops task "Deploy" can start once it has finished. Resume it once it can start.');
  });
});

// ADR-0034: a task on a usage limit keeps the run open. Its end is terminal to
// every surface, and it would hand the run over, or merge it, mid-run.
describe('a usage-limit pause keeps the run open', () => {
  function runEvents(orchestrator: TaskOrchestrator): string[] {
    const events: string[] = [];
    orchestrator.subscribe({
      onRunStarted: ({ origin }) => events.push(`started:${origin}`),
      onAutoMerge: ({ trigger }) => events.push(`merge:${trigger.kind}`),
      onIsolationHandoff: () => events.push('handoff'),
      onExecutionComplete: () => events.push('complete'),
    });
    return events;
  }

  const stops: [string, { refuse?: true; hit?: (session: FakeRunnerSession) => void }][] = [
    ['its turn fails on the limit', { hit: (session) => hitLimitInTurn(session) }],
    ['its runner exits on the limit', { hit: (session) => { session.emitOutput(LIMIT); session.emitExit(1); } }],
    ['the limit refuses its start', { refuse: true }],
  ];

  it.each(stops)('when the last task at work pauses because %s, then goes on at the reset', async (_how, stop) => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1, isolation: new FakeWorktreeIsolation(), mergeAutomatically: true });
    const events = runEvents(orchestrator);
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    if (stop.refuse) spawn.mockRejectedValueOnce(new RunnerStartupExit(`The claude-code task runner exited with code 1.\n\n${LIMIT}`));
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await until(() => spawn.mock.calls.length === 2);
    stop.hit?.(sessions[1]);
    await until(() => task('t2').status === 'awaiting_user');
    await flushMicrotasks(20);

    expect(task('t2')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
    expect(events).toEqual(['started:user']);
    expect(orchestrator.runs.isOpen).toBe(true);
    expect(orchestrator.awaitsResume).toBe(true);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 3);
    expect(spawn.mock.calls[2][0].taskId).toBe('t2');
    expect(orchestrator.isScheduling).toBe(true);
    sessions.at(-1)!.reportComplete({ status: 'done', summary: '' });
    await until(() => events.includes('complete'));

    expect(events).toEqual(['started:user', 'merge:run_end', 'complete']);
    expect(orchestrator.status).toBe('completed');
  });

  // A pause is no verdict, however the limit arrived: a failed one would read
  // as a failure to the planner, the task's report and every surface.
  it.each(stops)('records no verdict and archives nothing when the task pauses because %s', async (_how, stop) => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    if (stop.refuse) spawn.mockRejectedValueOnce(new RunnerStartupExit(`The claude-code task runner exited with code 1.\n\n${LIMIT}`));
    await orchestrator.forceStartTask('t1');
    stop.hit?.(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await flushMicrotasks(20);

    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
    expect(task('t1').verdict).toBeUndefined();
    expect(task('t1').outputSummary?.reviewReason).toMatch(/usage limit|session limit/);
    expect(orchestrator.storeInstance.getExecutionLog()).toEqual([]);
  });

  // A refused start once only ticked, so a task started alone kept its run
  // without an end; every way in now settles as the attempt's verdict would.
  const untimed = "You've hit your session limit.";
  const untimedStops: [string, { refuse?: true; hit?: (session: FakeRunnerSession) => void }][] = [
    ['its turn fails on the limit', { hit: (session) => hitLimitInTurn(session, untimed) }],
    ['its runner exits on the limit', { hit: (session) => { session.emitOutput(untimed); session.emitExit(1); } }],
    ['the limit refuses its start', { refuse: true }],
  ];

  it.each(untimedStops)('ends the run of a task started alone that waits for the user because %s', async (_how, stop) => {
    const { orchestrator, sessions, spawn, task } = setup();
    const events = runEvents(orchestrator);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    if (stop.refuse) spawn.mockRejectedValueOnce(new RunnerStartupExit(`The claude-code task runner exited with code 1.\n\n${untimed}`));
    await orchestrator.forceStartTask('t1');
    stop.hit?.(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await flushMicrotasks(20);

    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit' });
    expect(task('t1').resumeAt).toBeUndefined();
    expect(orchestrator.awaitsResume).toBe(false);
    expect(events).toEqual(['started:user', 'complete']);
  });

  it('and an edit while it is held does not read as a running plan', async () => {
    const { orchestrator, sessions, task } = setup({ maxParallelSessions: 2 });
    const tasks = [
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ];
    orchestrator.loadPlan(tasks);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    orchestrator.reconcilePlan(orchestrator.storeInstance.snapshot());

    expect(orchestrator.status).toBe('approved');
    expect(orchestrator.isScheduling).toBe(false);
    expect(orchestrator.awaitsResume).toBe(true);
  });

  it('when the user cancels the last task at work while the run is held', async () => {
    const { orchestrator, sessions, task } = setup({ maxParallelSessions: 2, isolation: new FakeWorktreeIsolation() });
    const events = runEvents(orchestrator);
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    await orchestrator.cancelTask('t2');
    await flushMicrotasks(20);

    expect(events).toEqual(['started:user']);
    expect(orchestrator.runs.isOpen).toBe(true);
    expect(orchestrator.awaitsResume).toBe(true);
  });
});

describe('a limit is acted on only when it ended a turn Ordewell started', () => {
  it('pauses a start whose runner exits on the limit before its first turn, and resumes it at the reset', async () => {
    const { orchestrator, spawn, waits, task } = setup();
    spawn.mockRejectedValueOnce(new RunnerStartupExit(`The claude-code task runner exited with code 1.\n\n${LIMIT}`));
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
    expect(waits).toEqual([{ taskId: 't1', runner: 'claude-code', resumeAt: RESUME_AT }]);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0].taskId).toBe('t1');
  });

  it('pauses a continue the limit refuses at once, keeping the saved session for its resume', async () => {
    const { orchestrator, spawn, task } = setup();
    spawn.mockRejectedValueOnce(new RunnerStartupExit(`The claude-code task runner exited with code 1.\n\n${LIMIT}`));
    orchestrator.loadPlan([{ ...createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' }), status: 'completed', runnerSessionId: 'sess-1' }]);
    await orchestrator.continueTask('t1', 'go on');
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT, runnerSessionId: 'sess-1' });

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'sess-1' });
  });

  it('fails a runner that exits while the task waits for input, whatever an earlier turn said', async () => {
    const { orchestrator, sessions, waits, notifications, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput(`${LIMIT}\n`);
    sessions[0].waitForInput();
    await until(() => task('t1').status === 'awaiting_user');
    sessions[0].emitExit(1);
    await until(() => task('t1').status === 'failed');

    expect(task('t1').resumeAt).toBeUndefined();
    expect(waits).toEqual([]);
    expect(vi.mocked(notifications.warn).mock.calls.flat().join('\n')).not.toMatch(/usage limit/);
  });

  it('fails a runner that exits mid-turn when only an earlier turn named the limit', async () => {
    const { orchestrator, sessions, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput(`${LIMIT}\n`);
    sessions[0].waitForInput();
    await until(() => task('t1').status === 'awaiting_user');
    orchestrator.sendTaskMessage('t1', 'carry on');
    await until(() => task('t1').status === 'in_progress');
    sessions[0].emitOutput('Running the tests.\n');
    sessions[0].emitExit(1);
    await until(() => task('t1').status === 'failed');

    expect(waits).toEqual([]);
  });

  // The runner's field outranks its words on an exit too (ADR-0044).
  it('fails a runner that exits mid-turn on an error its field says is not the limit', async () => {
    const { orchestrator, sessions, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'codex' })], ['codex']);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitEvent({ type: 'error', message: 'Rate limit exceeded.', usageLimit: false });
    sessions[0].emitOutput('Rate limit exceeded.\n');
    sessions[0].emitExit(1);
    await until(() => task('t1').status === 'failed');

    expect(waits).toEqual([]);
  });

  it('pauses a runner that exits mid-turn on an error its field names the limit, at the reset in the field', async () => {
    const { orchestrator, sessions, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'codex' })], ['codex']);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitEvent({ type: 'error', message: 'The request failed.', usageLimit: { resetsAt: '2026-10-11T20:42:55.000Z' } });
    sessions[0].emitOutput('The request failed.\n');
    sessions[0].emitExit(1);
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: '2026-10-11T20:43:55.000Z' });
  });

  it('fails a task the runner reported failed, even when its words name a limit', async () => {
    const { orchestrator, sessions, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('The API answers HTTP 429: Too Many Requests on every call.\n');
    sessions[0].reportComplete({ status: 'failed', summary: '', reason: 'the API is rate-limited' });
    sessions[0].emitTurnEnd('completed');
    await until(() => task('t1').status === 'failed');

    expect(waits).toEqual([]);
  });
});

describe('a plan loaded with a task still waiting on a usage limit', () => {
  const waiting = (resumeAt: string): Task => ({
    ...createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' }),
    status: 'awaiting_user',
    awaitingReason: 'usage-limit',
    resumeAt,
    runnerSessionId: 'native-saved',
  });

  it('resumes at once when the reset passed while nothing was running', async () => {
    const { orchestrator, spawn, task } = setup();

    orchestrator.loadPlan([waiting('2026-10-11T09:00:00.000Z')]);
    await vi.advanceTimersByTimeAsync(0);
    await until(() => spawn.mock.calls.length === 1);

    expect(spawn.mock.calls[0][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-saved' });
    expect(task('t1').status).toBe('in_progress');
  });

  it('waits again for a reset still to come', async () => {
    const { orchestrator, spawn } = setup();

    orchestrator.loadPlan([waiting(RESUME_AT)]);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(spawn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await until(() => spawn.mock.calls.length === 1);
  });

  it('does not resume one whose resume was cancelled', async () => {
    const { orchestrator, spawn } = setup();
    const manual = waiting(RESUME_AT);
    delete manual.resumeAt;

    orchestrator.loadPlan([manual]);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('resuming a task paused on a usage limit now', () => {
  it('resumes every task waiting on that runner\'s reset in its saved session, disarms the wait and releases the held run', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 2 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
      createTask({ id: 't3', order: 3, title: 'Third', prompt: 'do third' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    hitLimitInTurn(sessions[1]);
    await until(() => task('t2').status === 'awaiting_user');
    expect(orchestrator.status).toBe('approved');

    await orchestrator.resumeNow('t1', 'user');

    await until(() => spawn.mock.calls.length === 4);
    expect(spawn.mock.calls.slice(2).map(([o]) => [o.taskId, o.resumeSessionId])).toEqual([['t1', 'native-1'], ['t2', 'native-2']]);
    expect(spawn.mock.calls[2][0].prompt).toContain('Your usage limit has reset.');
    expect(task('t1').status).toBe('in_progress');
    expect(task('t2').resumeAt).toBeUndefined();
    expect(orchestrator.status).toBe('running');

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(4);

    sessions[2].reportComplete({ status: 'done', summary: '' });
    await until(() => spawn.mock.calls.length === 5);
    expect(spawn.mock.calls[4][0].taskId).toBe('t3');
  });

  it('sends a message after the reset notice in the same continuation', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    await orchestrator.resumeNow('t1', 'user', 'Also run the tests.');

    expect(spawn).toHaveBeenCalledTimes(2);
    const { prompt, resumeSessionId } = spawn.mock.calls[1][0];
    expect(resumeSessionId).toBe('native-1');
    expect(prompt.indexOf('Your usage limit has reset.')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('Also run the tests.')).toBeGreaterThan(prompt.indexOf('Your usage limit has reset.'));
  });

  it('resumes a task waiting for the user, whose reset could not be read', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0], 'Rate limit exceeded. Please try again later.');
    await until(() => task('t1').status === 'awaiting_user');
    expect(task('t1').resumeAt).toBeUndefined();

    await orchestrator.resumeNow('t1', 'user');

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-1' });
    expect(orchestrator.status).toBe('running');
  });

  it('counts a retry', async () => {
    const { orchestrator, sessions, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    await orchestrator.resumeNow('t1', 'user');
    sessions[1].reportComplete({ status: 'done', summary: '' });
    await until(() => task('t1').status === 'completed');

    expect(orchestrator.storeInstance.getExecutionLog().find((s) => s.id === 't1')?.retryCount).toBe(1);
  });

  it('waits for the user when the resumed attempt hits the limit again at once', async () => {
    const { orchestrator, sessions, spawn, notifications, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await orchestrator.resumeNow('t1', 'user');

    hitLimitInTurn(sessions[1]);
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1').resumeAt).toBeUndefined();
    expect(notifications.warn).toHaveBeenCalledWith(expect.stringContaining('hit its usage limit again right after it was resumed'));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  describe('that cannot start', () => {
    const paused = (id: string, order: number): Task => ({
      ...createTask({ id, order, title: `Paused ${id}`, prompt: 'do it' }),
      status: 'awaiting_user',
      awaitingReason: 'usage-limit',
      resumeAt: RESUME_AT,
      runnerSessionId: `native-${id}`,
    });

    it('keeps every resume at the reset when the asked task is refused for want of a slot', async () => {
      const { orchestrator, sessions, spawn, notifications, waits, task } = setup({ maxParallelSessions: 1 });
      orchestrator.loadPlan([
        paused('t1', 1),
        paused('t2', 2),
        createTask({ id: 'busy', order: 3, title: 'Busy', prompt: 'do it', assignedRunner: 'codex' }),
      ], ['claude-code', 'codex']);
      await orchestrator.forceStartTask('busy');

      await expect(orchestrator.resumeNow('t1', 'user')).rejects.toThrow('already running');

      expect(task('t1').resumeAt).toBe(RESUME_AT);
      expect(task('t2').resumeAt).toBe(RESUME_AT);
      expect(waits.filter((w) => w.cancelled)).toEqual([]);
      expect(vi.mocked(notifications.warn).mock.calls.flat().join('\n')).not.toMatch(/did not resume/);
      sessions[0].reportComplete({ status: 'done', summary: '' });
      await until(() => task('busy').status === 'completed');
      await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
      await until(() => spawn.mock.calls.length === 2);
      expect(spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-t1' });
    });

    it('leaves a task swept along waiting for its reset, not for the user, when no slot is left for it', async () => {
      const { orchestrator, sessions, spawn, notifications, waits, task } = setup({ maxParallelSessions: 1 });
      orchestrator.loadPlan([paused('t1', 1), paused('t2', 2)]);

      await orchestrator.resumeNow('t1', 'user');

      expect(spawn.mock.calls.map(([o]) => o.taskId)).toEqual(['t1']);
      expect(task('t2')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
      expect(waits.filter((w) => w.cancelled)).toEqual([]);
      expect(vi.mocked(notifications.warn).mock.calls.flat().join('\n')).not.toMatch(/did not resume at its usage limit's reset/);
      sessions[0].reportComplete({ status: 'done', summary: '' });
      await until(() => task('t1').status === 'completed');
      await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
      await until(() => spawn.mock.calls.length === 2);
      expect(spawn.mock.calls[1][0]).toMatchObject({ taskId: 't2', resumeSessionId: 'native-t2' });
    });
  });

  it('refuses a task with no saved session, and one not paused on a limit', async () => {
    const { orchestrator, spawn } = setup();
    orchestrator.loadPlan([
      { ...createTask({ id: 't1', order: 1, title: 'Unsaved', prompt: 'do it' }), status: 'awaiting_user', awaitingReason: 'usage-limit' },
      { ...createTask({ id: 't2', order: 2, title: 'Asks', prompt: 'do it' }), status: 'awaiting_user', awaitingReason: 'input', runnerSessionId: 'native-2' },
    ]);

    await expect(orchestrator.resumeNow('t1', 'user')).rejects.toThrow('no saved session');
    await expect(orchestrator.resumeNow('t2', 'user')).rejects.toThrow('not paused on a usage limit');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('a task started on its own that pauses on a usage limit, once the pause ends', () => {
  function lone() {
    const events: string[] = [];
    const ctx = setup({ maxParallelSessions: 1 });
    ctx.orchestrator.subscribe({
      onReviewNeeded: () => events.push('review'),
      onExecutionComplete: () => events.push('complete'),
    });
    return { ...ctx, events };
  }

  it('ends its run when the resumed attempt passes, without asking for a review', async () => {
    const { orchestrator, sessions, spawn, task, events } = lone();
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Alone', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Other', prompt: 'do second' }),
    ]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);
    sessions[1].reportComplete({ status: 'done', summary: '' });
    await until(() => task('t1').status === 'completed');
    await flushMicrotasks();

    expect(events).toEqual(['complete']);
    expect(orchestrator.awaitsResume).toBe(false);
    expect(orchestrator.isScheduling).toBe(false);
    expect(spawn.mock.calls.map(([o]) => o.taskId)).toEqual(['t1', 't1']);
  });

  it('starts nothing else at the reset, even with the plan approved by an earlier run', async () => {
    const { orchestrator, sessions, spawn, task } = lone();
    orchestrator.loadPlan([
      createTask({ id: 't0', order: 1, title: 'Base', prompt: 'do base' }),
      createTask({ id: 't1', order: 2, title: 'Alone', prompt: 'do first' }),
      createTask({ id: 't2', order: 3, title: 'After base', prompt: 'do second', dependencies: ['t0'] }),
    ]);
    await orchestrator.approveReview();
    orchestrator.stop();
    await orchestrator.forceStartTask('t1');
    const lonely = sessions.find((s) => s.taskId === 't1')!;
    hitLimitInTurn(lonely);
    await until(() => task('t1').status === 'awaiting_user');

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => task('t1').status === 'in_progress');
    await flushMicrotasks();

    expect(orchestrator.isScheduling).toBe(false);
    expect(spawn.mock.calls.slice(-1).map(([o]) => o.taskId)).toEqual(['t1']);
    expect(task('t0').status).not.toBe('in_progress');
  });

  it('leaves no run scheduling once the paused task is marked complete', async () => {
    const { orchestrator, sessions, spawn, task } = lone();
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Alone', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Other', prompt: 'do second' }),
    ]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    await orchestrator.markTaskComplete('t1');
    await flushMicrotasks();

    expect(orchestrator.awaitsResume).toBe(false);
    expect(orchestrator.isScheduling).toBe(false);
    expect(orchestrator.status).not.toBe('running');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('starts it again alone, and nothing else, once it moves to another runner', async () => {
    const { orchestrator, sessions, spawn, task, events } = lone();
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Alone', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Other', prompt: 'do second' }),
    ], ['claude-code', 'codex']);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    // What a runner edit lands: the released changes written, then a tick.
    orchestrator.storeInstance.update('t1', orchestrator.releaseMovedResume('t1', { assignedRunner: 'codex' }));
    await orchestrator.tick();
    await until(() => spawn.mock.calls.length === 2);

    expect(spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
    expect(orchestrator.awaitsResume).toBe(false);
    expect(orchestrator.isScheduling).toBe(false);
    sessions[1].reportComplete({ status: 'done', summary: '' });
    await until(() => task('t1').status === 'completed');
    await flushMicrotasks();
    expect(events).toEqual(['complete']);
    expect(spawn.mock.calls.map(([o]) => o.taskId)).toEqual(['t1', 't1']);
  });
});

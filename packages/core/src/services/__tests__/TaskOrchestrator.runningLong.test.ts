import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { runningLongThreshold, type RunningLongEvent } from '../RunningLong';

const MINUTE = 60_000;

function setup(compactWindowTokens?: number, compactStartTokens?: number) {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${o.taskId}`);
      session.compactWindowTokens = compactWindowTokens;
      session.compactStartTokens = compactStartTokens;
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: false }),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  return { orchestrator, sessions, task: (id: string) => orchestrator.storeInstance.get(id)! };
}

const plan = (overrides: Partial<Task> = {}): Task => ({
  ...createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'Parse objects and arrays.' }),
  ...overrides,
});

describe('a passed attempt\'s running time (ADR-0018 W1)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('leaves out its wait for input, so a night\'s wait raises no later task\'s threshold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T08:00:00Z'));
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    vi.setSystemTime(new Date('2026-11-14T08:03:00Z'));
    h.sessions[0].waitForInput();
    expect(h.task('t1').status).toBe('awaiting_user');
    vi.setSystemTime(new Date('2026-11-14T18:00:00Z'));
    h.orchestrator.sendTaskMessage('t1', 'go on');
    vi.setSystemTime(new Date('2026-11-14T18:02:00Z'));
    h.sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(h.task('t1').status).toBe('completed'));

    const usage = h.task('t1').attemptUsage!.at(-1)!;
    // vi.waitFor's polling moves the faked clock on a few milliseconds.
    expect(usage.wallTimeMs).toBeGreaterThanOrEqual(10 * 60 * MINUTE + 2 * MINUTE);
    expect(usage.runningMs).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(usage.runningMs).toBeLessThan(6 * MINUTE);
    expect(runningLongThreshold([h.task('t1')])).toEqual({ ms: 30 * MINUTE });
  });
});

describe('an attempt\'s compaction window (ADR-0018 W1)', () => {
  it('is kept on its usage with where its runner starts compacting, for the context meter', async () => {
    const h = setup(150_000);
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    expect(h.task('t1').attemptUsage!.at(-1)!.compaction).toEqual({ windowTokens: 150_000, startsAtTokens: 118_000 });
  });

  it('reads against the start a runner reports, not the window less a CLI buffer (ADR-0018 C4)', async () => {
    const h = setup(100_000, 100_000);
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    expect(h.task('t1').attemptUsage!.at(-1)!.compaction).toEqual({ windowTokens: 100_000, startsAtTokens: 100_000 });
  });

  it('follows the start in force when the runner moves it as it runs: a shrink to fit, a window learned, a setting not applied (ADR-0018 C4)', async () => {
    const h = setup(100_000, 100_000);
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    const session = h.sessions[0];
    session.compactWindowTokens = 80_000;
    session.compactStartTokens = 80_000;
    session.emitEvent({ type: 'usage', record: { source: 'ordewell', model: 'm', inputTokens: 5, contextTokens: 5 } });
    expect(h.task('t1').attemptUsage!.at(-1)!.compaction).toEqual({ windowTokens: 80_000, startsAtTokens: 80_000 });
    session.compactWindowTokens = undefined;
    session.compactStartTokens = undefined;
    session.emitEvent({ type: 'compaction', trigger: 'auto' });
    expect(h.task('t1').attemptUsage!.at(-1)!).not.toHaveProperty('compaction');
  });

  it('is absent where Ordewell set none', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    expect(h.task('t1').attemptUsage!.at(-1)!).not.toHaveProperty('compaction');
  });
});

describe('a retry\'s running-long threshold (ADR-0018 W1)', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** Task t1 failed or was stopped after `minutes` running, then retried; what flagged the retry. */
  async function retriedAfter(minutes: number, how: 'failed' | 'stopped') {
    vi.useFakeTimers();
    const h = setup();
    // A 40-minute pass would put a first attempt's threshold at two hours.
    const done: Task = {
      ...createTask({ id: 'p', order: 2, title: 'Done', prompt: 'p' }),
      status: 'completed',
      attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: '2026-11-14T08:00:00.000Z', endedAt: '2026-11-14T08:40:00.000Z', wallTimeMs: 40 * MINUTE, runningMs: 40 * MINUTE, totals: {}, byModel: [] }],
    };
    h.orchestrator.loadPlan([plan(), done]);
    const flags: Array<Pick<RunningLongEvent, 'elapsedMs' | 'thresholdMs' | 'retryOf'>> = [];
    h.orchestrator.subscribe({ onTaskRunningLong: ({ runningLong: { elapsedMs, thresholdMs, retryOf } }) => flags.push({ elapsedMs, thresholdMs, ...(retryOf ? { retryOf } : {}) }) });
    await h.orchestrator.forceStartTask('t1');
    await vi.advanceTimersByTimeAsync(minutes * MINUTE);
    if (how === 'failed') {
      h.sessions[0].reportComplete({ status: 'failed', summary: '', reason: 'the rest needs what the repo lacks' });
      await vi.waitFor(() => expect(h.task('t1').status).toBe('failed'));
      await h.orchestrator.retryTask('t1');
    } else {
      await h.orchestrator.cancelTask('t1');
    }
    // With no run to hand it to, the start is the caller's, as retry_task's is.
    await h.orchestrator.forceStartTask('t1');
    expect(h.sessions).toHaveLength(2);
    return { h, flags };
  }

  it('flags a retry of a failed attempt at the running time that attempt failed after, not at 3× the plan\'s longest pass', async () => {
    const { flags } = await retriedAfter(42, 'failed');
    expect(flags).toEqual([]);

    await vi.advanceTimersByTimeAsync(42 * MINUTE - 1);
    expect(flags).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(flags).toEqual([{ elapsedMs: 42 * MINUTE, thresholdMs: 42 * MINUTE, retryOf: { attempt: 1, runningMs: 42 * MINUTE, outcome: 'failed' } }]);
    // Doubled after the flag, as a first attempt's is.
    await vi.advanceTimersByTimeAsync(42 * MINUTE);
    expect(flags.map((f) => f.thresholdMs / MINUTE)).toEqual([42, 84]);
  });

  it('flags a start after a stop at the running time the stopped attempt had', async () => {
    const { flags } = await retriedAfter(50, 'stopped');

    await vi.advanceTimersByTimeAsync(50 * MINUTE);

    expect(flags).toEqual([{ elapsedMs: 50 * MINUTE, thresholdMs: 50 * MINUTE, retryOf: { attempt: 1, runningMs: 50 * MINUTE, outcome: 'stopped' } }]);
  });

  it('times a start after a run Stop by the running time the stopped attempt had, not by its wait for input', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    const flags: Array<Pick<RunningLongEvent, 'elapsedMs' | 'thresholdMs' | 'retryOf'>> = [];
    h.orchestrator.subscribe({ onTaskRunningLong: ({ runningLong: { elapsedMs, thresholdMs, retryOf } }) => flags.push({ elapsedMs, thresholdMs, ...(retryOf ? { retryOf } : {}) }) });
    await h.orchestrator.forceStartTask('t1');
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    h.sessions[0].waitForInput();
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE);
    flags.length = 0;
    h.orchestrator.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.task('t1').attemptUsage!.at(-1)).toMatchObject({ runningMs: 40 * MINUTE, outcome: 'stopped' });

    await h.orchestrator.forceStartTask('t1');
    expect(h.sessions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(40 * MINUTE);

    expect(flags).toEqual([{ elapsedMs: 40 * MINUTE, thresholdMs: 40 * MINUTE, retryOf: { attempt: 1, runningMs: 40 * MINUTE, outcome: 'stopped' } }]);
  });

  it('keeps the 30-minute floor after an attempt that failed sooner', async () => {
    const { flags } = await retriedAfter(5, 'failed');

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
    expect(flags).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(flags).toEqual([{ elapsedMs: 30 * MINUTE, thresholdMs: 30 * MINUTE }]);
  });
});

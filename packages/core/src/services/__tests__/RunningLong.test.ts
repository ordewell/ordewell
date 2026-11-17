import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerdictEngine } from '../VerdictEngine';
import { RunningLongClock, runningLongThreshold, type RunningLongFacts } from '../RunningLong';
import { createTask, type Task } from '../../models/Task';
import { FakeRunnerSession } from '../../testing';

const MINUTE = 60_000;

const buildTask = (extra: Partial<Task> = {}): Task =>
  createTask({ id: 't1', title: 'do thing', taskMode: 'build', ...extra });

/** A task that passed, its one attempt having run `minutes` of wall time. */
const passed = (id: string, minutes: number, extra: Partial<Task> = {}): Task => buildTask({
  id,
  status: 'completed',
  attemptUsage: [{ attempt: 1, runner: 'claude', startedAt: '2026-11-14T10:00:00.000Z', endedAt: new Date(Date.parse('2026-11-14T10:00:00.000Z') + minutes * MINUTE).toISOString(), wallTimeMs: minutes * MINUTE, totals: {}, byModel: [] }],
  ...extra,
});

function watched(options: { task?: Task; plan?: () => readonly Task[] } = {}) {
  const plan = options.plan ?? (() => []);
  const engine = new VerdictEngine({ runningLongThreshold: () => runningLongThreshold(plan()) });
  const flags: Array<RunningLongFacts & { taskId: string }> = [];
  engine.onRunningLong((taskId, facts) => flags.push({ taskId, ...facts }));
  const session = new FakeRunnerSession();
  engine.watch(options.task ?? buildTask(), session);
  return { engine, session, flags };
}

describe('a running attempt that runs long (ADR-0018 W1)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is flagged once its running time passes the 30-minute floor, and not before, when no AI task has passed', () => {
    const { flags } = watched();

    vi.advanceTimersByTime(30 * MINUTE - 1);
    expect(flags).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(flags).toEqual([{ taskId: 't1', reason: 'duration', elapsedMs: 30 * MINUTE, thresholdMs: 30 * MINUTE, compactions: 0 }]);
  });

  it('waits three times the longest wall time of an AI task that passed, and names that task', () => {
    // 20 minutes passed: 60 to wait. The 25-minute script and the failed AI task count for nothing.
    const plan = [passed('a', 12), passed('b', 20), passed('s', 25, { type: 'script' }), passed('f', 40, { status: 'failed' })];
    const { flags } = watched({ task: buildTask({ id: 't9' }), plan: () => plan });

    vi.advanceTimersByTime(60 * MINUTE - 1);
    expect(flags).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(flags).toEqual([{ taskId: 't9', reason: 'duration', elapsedMs: 60 * MINUTE, thresholdMs: 60 * MINUTE, basis: { taskId: 'b', runningMs: 20 * MINUTE }, compactions: 0 }]);
  });

  it('reads a passed attempt\'s running time, not its wall time, which counts its waits on a person', () => {
    // 5 minutes running over a night's wait for input: the floor holds.
    const overnight = passed('a', 10 * 60);
    overnight.attemptUsage![0].runningMs = 5 * MINUTE;

    expect(runningLongThreshold([overnight])).toEqual({ ms: 30 * MINUTE });
    expect(runningLongThreshold([overnight, passed('b', 20)])).toEqual({ ms: 60 * MINUTE, basis: { taskId: 'b', runningMs: 20 * MINUTE } });
  });

  it('keeps the floor when three times the longest passed task is shorter', () => {
    const { flags } = watched({ plan: () => [passed('a', 9)] });

    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags.map((f) => [f.thresholdMs, f.basis])).toEqual([[30 * MINUTE, undefined]]);
  });

  it('doubles the running time the next flag needs after each one', () => {
    const { flags } = watched();

    vi.advanceTimersByTime(4 * 60 * MINUTE);

    expect(flags.map((f) => [f.elapsedMs / MINUTE, f.thresholdMs / MINUTE])).toEqual([[30, 30], [60, 60], [120, 120], [240, 240]]);
  });

  it('reads a task that passed while it ran, so a raised threshold puts the flag off', () => {
    const plan: Task[] = [];
    const { flags } = watched({ plan: () => plan });

    vi.advanceTimersByTime(20 * MINUTE);
    plan.push(passed('a', 15));
    vi.advanceTimersByTime(25 * MINUTE - 1);
    expect(flags).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(flags.map((f) => f.elapsedMs / MINUTE)).toEqual([45]);
  });

  it('does not count the time it waits for input, a checkpoint or an approval', () => {
    const { engine, session, flags } = watched();

    vi.advanceTimersByTime(10 * MINUTE);
    engine.pauseIdle('t1'); // the turn ended and the task waits for the user's input
    vi.advanceTimersByTime(60 * MINUTE);
    session.emitEvent({ type: 'turn_start', text: 'go on' });
    vi.advanceTimersByTime(5 * MINUTE);
    session.emitEvent({ type: 'permission_request', id: 'p1', name: 'Bash', detail: 'npm publish' });
    vi.advanceTimersByTime(60 * MINUTE);
    session.emitEvent({ type: 'permission_decided', id: 'p1', decision: { decision: 'allow' } });
    vi.advanceTimersByTime(15 * MINUTE - 1);
    expect(flags).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(flags.map((f) => f.elapsedMs / MINUTE)).toEqual([30]);
  });

  it('counts a tool call in flight: the runner is working, not waiting on anyone', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'tool_call', id: 'c1', name: 'Bash', args: { command: 'npm test' } });
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags.map((f) => f.elapsedMs / MINUTE)).toEqual([30]);
  });

  it('flags each automatic compaction of its own session once, whatever the time, and not a manual one or a subagent\'s usage', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 150_000, contextWindow: 200_000 } });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 190_000, contextWindow: 200_000 } });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 199_000, subagentId: 'sub-1' } });
    vi.advanceTimersByTime(5 * MINUTE);
    session.emitEvent({ type: 'compaction', trigger: 'auto', preTokens: 190_000, postTokens: 30_000 });
    session.emitEvent({ type: 'compaction', trigger: 'manual' });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 32_000, contextWindow: 200_000 } });
    vi.advanceTimersByTime(1);

    expect(flags).toEqual([{
      taskId: 't1', reason: 'compaction', elapsedMs: 5 * MINUTE, thresholdMs: 30 * MINUTE, compactions: 1,
      contextTokens: 30_000, contextWindow: 200_000, peakContextTokens: 190_000,
    }]);
  });

  describe('where Ordewell sets the window its runner compacts at (ADR-0057 R4)', () => {
    const compacting = () => {
      const watchedRun = watched();
      watchedRun.session.compactWindowTokens = 150_000;
      return watchedRun;
    };
    const compact = (session: FakeRunnerSession, times: number) => {
      for (let i = 0; i < times; i += 1) session.emitEvent({ type: 'compaction', trigger: 'auto', postTokens: 20_000 });
    };

    it('raises nothing for its first and second automatic compactions, and a flag for its third', () => {
      const { session, flags } = compacting();

      compact(session, 2);
      expect(flags).toEqual([]);
      compact(session, 1);

      expect(flags).toEqual([{
        taskId: 't1', reason: 'compaction', elapsedMs: 0, thresholdMs: 30 * MINUTE, compactions: 3,
        contextTokens: 20_000, compactionWindow: 150_000, peakContextTokens: 20_000,
      }]);
    });

    it('backs off by doubling after the third: the sixth, the twelfth, the twenty-fourth', () => {
      const { session, flags } = compacting();

      compact(session, 24);

      expect(flags.map((f) => f.compactions)).toEqual([3, 6, 12, 24]);
    });

    it('counts a manual compaction for nothing, and still flags by time', () => {
      const { session, flags } = compacting();

      compact(session, 2);
      session.emitEvent({ type: 'compaction', trigger: 'manual' });
      expect(flags).toEqual([]);
      vi.advanceTimersByTime(30 * MINUTE);

      expect(flags.map((f) => [f.reason, f.compactions, f.compactionWindow])).toEqual([['duration', 2, 150_000]]);
    });

    it('raises one at the first compaction where the window it sets is 200000 or more, naming that window', () => {
      const { session, flags } = watched();
      session.compactWindowTokens = 400_000;

      compact(session, 1);

      expect(flags.map((f) => [f.reason, f.compactions, f.compactionWindow])).toEqual([['compaction', 1, 400_000]]);
    });

    it('keeps a window just under 200000 routine', () => {
      const { session, flags } = watched();
      session.compactWindowTokens = 199_999;

      compact(session, 2);

      expect(flags).toEqual([]);
    });

    it('raises one at the first compaction where it sets no window', () => {
      const { session, flags } = watched();

      session.emitEvent({ type: 'compaction', trigger: 'auto' });

      expect(flags.map((f) => [f.reason, f.compactions])).toEqual([['compaction', 1]]);
      expect(flags[0].compactionWindow).toBeUndefined();
    });
  });

  it('carries the live context, its peak and the compactions so far on a later duration flag', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 180_000, contextWindow: 200_000 } });
    session.emitEvent({ type: 'compaction', trigger: 'auto' });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 40_000, contextWindow: 200_000 } });
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags[1]).toEqual({
      taskId: 't1', reason: 'duration', elapsedMs: 30 * MINUTE, thresholdMs: 30 * MINUTE, compactions: 1,
      contextTokens: 40_000, contextWindow: 200_000, peakContextTokens: 180_000,
    });
  });

  it('leaves the live context unknown after a compaction that states no size, as Codex and OpenCode report one', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'codex', model: 'gpt-5', contextTokens: 190_000, contextWindow: 200_000 } });
    session.emitEvent({ type: 'compaction', trigger: 'auto' });
    session.emitEvent({ type: 'usage', record: { source: 'codex', compacted: true } });
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags.map((f) => [f.reason, f.contextTokens, f.peakContextTokens])).toEqual([['compaction', undefined, 190_000], ['duration', undefined, 190_000]]);
  });

  it('does not measure a new model\'s context against the window of the model before it', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus-1m', contextTokens: 600_000, contextWindow: 1_000_000 } });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'sonnet', contextTokens: 150_000 } });
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags[0]).toMatchObject({ contextTokens: 150_000, peakContextTokens: 150_000 });
    expect(flags[0].contextWindow).toBeUndefined();
  });

  it('sets no peak against the window of a model it was not measured on', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 150_000, contextWindow: 200_000 } });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus-1m', contextWindow: 1_000_000 } });
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags[0]).toMatchObject({ contextWindow: 1_000_000, compactions: 0 });
    expect(flags[0].peakContextTokens).toBeUndefined();
  });

  it('flags nothing for a script task, which has its own time limit', () => {
    const { session, flags } = watched({ task: buildTask({ type: 'script', script: 'sleep 99999' }) });

    session.emitEvent({ type: 'compaction', trigger: 'auto' });
    vi.advanceTimersByTime(10 * 60 * MINUTE);

    expect(flags).toEqual([]);
  });

  it('flags nothing once the attempt has a verdict', () => {
    const { session, flags } = watched();

    vi.advanceTimersByTime(10 * MINUTE);
    session.emitExit(0);
    vi.advanceTimersByTime(10 * 60 * MINUTE);

    expect(flags).toEqual([]);
  });

  it('flags nothing again once a plan load drops the attempts, whatever the old one had been flagged', () => {
    const { engine, session, flags } = watched();

    vi.advanceTimersByTime(30 * MINUTE);
    engine.reset();
    session.emitEvent({ type: 'compaction', trigger: 'auto' });
    vi.advanceTimersByTime(10 * 60 * MINUTE);

    expect(flags.map((f) => f.elapsedMs / MINUTE)).toEqual([30]);
  });

  it('starts a new attempt\'s count from nothing', () => {
    const engine = new VerdictEngine();
    const flags: number[] = [];
    engine.onRunningLong((_taskId, facts) => flags.push(facts.elapsedMs / MINUTE));
    engine.watch(buildTask(), new FakeRunnerSession());
    vi.advanceTimersByTime(40 * MINUTE);
    engine.clear(buildTask());
    engine.watch(buildTask(), new FakeRunnerSession());
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags).toEqual([30, 30]);
  });
});

describe('a running-long flag further off than a timer holds', () => {
  it('waits without spinning: Node fires a timer longer than 2^31-1 ms at once', async () => {
    const armed = vi.spyOn(globalThis, 'setTimeout');
    const clock = new RunningLongClock(() => ({ ms: 30 * 24 * 60 * MINUTE }), () => {});
    try {
      clock.run();
      const before = armed.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The test's own timer is the one call expected.
      expect(armed.mock.calls.length - before).toBe(1);
      expect(armed.mock.calls[0][1]).toBe(2 ** 31 - 1);
    } finally {
      clock.stop();
      armed.mockRestore();
    }
  });
});

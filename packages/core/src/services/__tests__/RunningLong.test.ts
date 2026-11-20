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

  describe('once five AI tasks have passed', () => {
    // Passed in 6, 7, 8, 9 and 40 minutes: a median of 8, so 24 minutes, well before 3 × 40.
    const five = () => [passed('a', 6), passed('b', 7), passed('c', 8), passed('d', 9), passed('e', 40)];

    it('flags at three times the median running time of the AI tasks that passed, when that comes first', () => {
      const { flags } = watched({ plan: five });

      vi.advanceTimersByTime(24 * MINUTE - 1);
      expect(flags).toEqual([]);
      vi.advanceTimersByTime(1);

      expect(flags).toEqual([{ taskId: 't1', reason: 'duration', elapsedMs: 24 * MINUTE, thresholdMs: 24 * MINUTE, median: { passed: 5, runningMs: 8 * MINUTE }, compactions: 0 }]);
    });

    it('brings the flag forward when the fifth pass comes while it runs, then doubles from it', () => {
      const plan = five().slice(1);
      const { flags } = watched({ plan: () => plan });

      vi.advanceTimersByTime(12 * MINUTE);
      plan.push(passed('a', 6));
      vi.advanceTimersByTime(12 * MINUTE);
      expect(flags.map((f) => [f.elapsedMs / MINUTE, f.thresholdMs / MINUTE])).toEqual([[24, 24]]);
      vi.advanceTimersByTime(72 * MINUTE);

      expect(flags.map((f) => [f.elapsedMs / MINUTE, f.thresholdMs / MINUTE])).toEqual([[24, 24], [48, 48], [96, 96]]);
    });

    it('doubles from the flag it raised when a later pass lowers the threshold, never flagging again sooner', () => {
      // Four passes: the 30-minute floor, until the fifth puts the threshold at 19, under the flag already raised.
      const plan = [passed('b', 5), passed('c', 6), passed('d', 7), passed('e', 8)];
      const { flags } = watched({ plan: () => plan });

      vi.advanceTimersByTime(31 * MINUTE);
      plan.push(passed('a', 4));
      vi.advanceTimersByTime(29 * MINUTE - 1);
      expect(flags.map((f) => f.thresholdMs / MINUTE)).toEqual([30]);
      vi.advanceTimersByTime(1);

      expect(flags.map((f) => [f.elapsedMs / MINUTE, f.thresholdMs / MINUTE, f.median?.runningMs])).toEqual([[30, 30, undefined], [60, 60, 6 * MINUTE]]);
    });

    it('leaves a retry to its own rule: the running time of the attempt it follows', () => {
      const retried = buildTask({ id: 'r', status: 'in_progress' });
      retried.attemptUsage = [{ ...passed('r', 45).attemptUsage![0], outcome: 'failed' }];

      expect(runningLongThreshold([...five(), retried], 'r')).toEqual({ ms: 45 * MINUTE, retryOf: { attempt: 1, runningMs: 45 * MINUTE, outcome: 'failed' } });
    });

    it('does not read a median of four: one slow or quick pass would set it', () => {
      expect(runningLongThreshold(five().slice(1))).toEqual({ ms: 120 * MINUTE, basis: { taskId: 'e', runningMs: 40 * MINUTE } });
    });

    it('never flags under nineteen minutes, however quickly the others passed', () => {
      // A median of 2 minutes: 6, held up to 19.
      const quick = [passed('a', 1), passed('b', 2), passed('c', 2), passed('d', 3), passed('e', 3)];

      expect(runningLongThreshold(quick)).toEqual({ ms: 19 * MINUTE, median: { passed: 5, runningMs: 2 * MINUTE } });
    });

    it('takes the earlier of the two thresholds, past the 30-minute floor too', () => {
      // The median's 3 × 12 = 36 minutes comes before the longest's 3 × 13 = 39.
      const close = [passed('a', 11), passed('b', 12), passed('c', 12), passed('d', 12), passed('e', 13)];

      expect(runningLongThreshold(close)).toEqual({ ms: 36 * MINUTE, median: { passed: 5, runningMs: 12 * MINUTE } });
    });

    it('names the longest pass when the two thresholds fall together', () => {
      const even = ['a', 'b', 'c', 'd', 'e'].map((id) => passed(id, 12));

      expect(runningLongThreshold(even)).toEqual({ ms: 36 * MINUTE, basis: { taskId: 'a', runningMs: 12 * MINUTE } });
    });

    it('takes the middle two\'s mean for an even count', () => {
      const six = [...five(), passed('f', 10)];

      // 8 and 9 in the middle: 8.5, so 25.5 minutes.
      expect(runningLongThreshold(six)).toEqual({ ms: 25.5 * MINUTE, median: { passed: 6, runningMs: 8.5 * MINUTE } });
    });
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

    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 120_000, contextWindow: 200_000 } });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 140_000, contextWindow: 200_000 } });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 199_000, subagentId: 'sub-1' } });
    vi.advanceTimersByTime(5 * MINUTE);
    session.emitEvent({ type: 'compaction', trigger: 'auto', preTokens: 140_000, postTokens: 30_000 });
    session.emitEvent({ type: 'compaction', trigger: 'manual' });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 32_000, contextWindow: 200_000 } });
    vi.advanceTimersByTime(1);

    expect(flags).toEqual([{
      taskId: 't1', reason: 'compaction', elapsedMs: 5 * MINUTE, thresholdMs: 30 * MINUTE, compactions: 1,
      contextTokens: 30_000, contextWindow: 200_000, peakContextTokens: 140_000,
    }]);
  });

  it('says the window is assumed when the runner had to assume it', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'ordewell', model: 'openrouter:acme/m', contextTokens: 90_000, contextWindow: 128_000, contextWindowAssumed: true } });
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags[0]).toMatchObject({ contextTokens: 90_000, contextWindow: 128_000, contextWindowAssumed: true });
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

  describe('whose context grows large (ADR-0057 R4)', () => {
    const call = (session: FakeRunnerSession, contextTokens: number, contextWindow?: number) =>
      session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens, ...(contextWindow ? { contextWindow } : {}) } });

    it('on a 1M window raises one at 400k and one more at 800k, and none at 1600k, past the window', () => {
      const { session, flags } = watched();

      call(session, 399_999, 1_000_000);
      expect(flags).toEqual([]);
      call(session, 412_000, 1_000_000);
      call(session, 600_000, 1_000_000);
      call(session, 810_000, 1_000_000);
      call(session, 990_000, 1_000_000);

      expect(flags).toEqual([
        { taskId: 't1', reason: 'context', elapsedMs: 0, thresholdMs: 30 * MINUTE, contextThreshold: 400_000, compactions: 0, contextTokens: 412_000, contextWindow: 1_000_000, peakContextTokens: 412_000 },
        { taskId: 't1', reason: 'context', elapsedMs: 0, thresholdMs: 30 * MINUTE, contextThreshold: 800_000, compactions: 0, contextTokens: 810_000, contextWindow: 1_000_000, peakContextTokens: 810_000 },
      ]);
    });

    it('on a 200k window raises one at the 150k floor, not at 40% of it, and none after: 300k is past the window', () => {
      const { session, flags } = watched();

      call(session, 80_000, 200_000);
      call(session, 149_999, 200_000);
      expect(flags).toEqual([]);
      call(session, 150_000, 200_000);
      call(session, 199_000, 200_000);

      expect(flags.map((f) => [f.reason, f.contextThreshold, f.contextTokens])).toEqual([['context', 150_000, 150_000]]);
    });

    it('measures against a compaction window in force where it is smaller than the model\'s: 300k on a 1M model starts at 150k', () => {
      const { session, flags } = watched();
      session.compactWindowTokens = 300_000;

      call(session, 149_000, 1_000_000);
      expect(flags).toEqual([]);
      call(session, 160_000, 1_000_000);
      call(session, 290_000, 1_000_000);

      expect(flags.map((f) => [f.reason, f.contextThreshold, f.compactionWindow, f.contextWindow])).toEqual([['context', 150_000, 300_000, 1_000_000]]);
    });

    it('never raises one under a compaction window below the floor, as Haiku\'s', () => {
      const { session, flags } = watched();
      session.compactWindowTokens = 125_000;

      call(session, 120_000, 200_000);

      expect(flags).toEqual([]);
    });

    it('raises one per crossing: a call that jumps past two thresholds raises one, naming the higher', () => {
      const { session, flags } = watched();

      call(session, 850_000, 1_000_000);
      call(session, 900_000, 1_000_000);

      expect(flags.map((f) => f.contextThreshold)).toEqual([800_000]);
    });

    it('does not raise one again when the context falls under a threshold it passed and reaches it again', () => {
      const { session, flags } = watched();

      call(session, 450_000, 1_000_000);
      session.emitEvent({ type: 'compaction', trigger: 'manual', postTokens: 40_000 });
      call(session, 450_000, 1_000_000);

      expect(flags.map((f) => [f.reason, f.contextThreshold])).toEqual([['context', 400_000]]);
    });

    it('never raises one while the model\'s window is unknown, a compaction window or none; time still flags', () => {
      const { session, flags } = watched();
      session.compactWindowTokens = 300_000;

      call(session, 900_000);
      vi.advanceTimersByTime(30 * MINUTE);

      expect(flags.map((f) => f.reason)).toEqual(['duration']);
    });

    it('does not count a subagent\'s context', () => {
      const { session, flags } = watched();

      session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'haiku', contextTokens: 190_000, contextWindow: 200_000, subagentId: 'sub-1' } });

      expect(flags).toEqual([]);
    });

    it('raises none once the attempt has a verdict, whatever its runner reports as it winds down', () => {
      const { session, flags } = watched();

      session.emitExit(0);
      call(session, 900_000, 1_000_000);

      expect(flags).toEqual([]);
    });
  });

  it('carries the live context, its peak and the compactions so far on a later duration flag', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 140_000, contextWindow: 200_000 } });
    session.emitEvent({ type: 'compaction', trigger: 'auto' });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 40_000, contextWindow: 200_000 } });
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags[1]).toEqual({
      taskId: 't1', reason: 'duration', elapsedMs: 30 * MINUTE, thresholdMs: 30 * MINUTE, compactions: 1,
      contextTokens: 40_000, contextWindow: 200_000, peakContextTokens: 140_000,
    });
  });

  it('leaves the live context unknown after a compaction that states no size, as Codex and OpenCode report one', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'codex', model: 'gpt-5', contextTokens: 140_000, contextWindow: 200_000 } });
    session.emitEvent({ type: 'compaction', trigger: 'auto' });
    session.emitEvent({ type: 'usage', record: { source: 'codex', compacted: true } });
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags.map((f) => [f.reason, f.contextTokens, f.peakContextTokens])).toEqual([['compaction', undefined, 140_000], ['duration', undefined, 140_000]]);
  });

  it('does not measure a new model\'s context against the window of the model before it', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus-1m', contextTokens: 300_000, contextWindow: 1_000_000 } });
    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'sonnet', contextTokens: 150_000 } });
    vi.advanceTimersByTime(30 * MINUTE);

    expect(flags[0]).toMatchObject({ contextTokens: 150_000, peakContextTokens: 150_000 });
    expect(flags[0].contextWindow).toBeUndefined();
  });

  it('sets no peak against the window of a model it was not measured on', () => {
    const { session, flags } = watched();

    session.emitEvent({ type: 'usage', record: { source: 'claude', model: 'opus', contextTokens: 140_000, contextWindow: 200_000 } });
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
      // The test's own timer is the one call expected; the clock's waits a minute, then reads its threshold again.
      expect(armed.mock.calls.length - before).toBe(1);
      expect(armed.mock.calls[0][1]).toBe(MINUTE);
    } finally {
      clock.stop();
      armed.mockRestore();
    }
  });
});

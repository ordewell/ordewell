import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerdictEngine } from '../VerdictEngine';
import { runningLongThreshold, type RunningLongFacts } from '../RunningLong';
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

    expect(flags).toEqual([{ taskId: 't9', reason: 'duration', elapsedMs: 60 * MINUTE, thresholdMs: 60 * MINUTE, basis: { taskId: 'b', wallTimeMs: 20 * MINUTE }, compactions: 0 }]);
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

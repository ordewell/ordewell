import { flattenTasks, type Task } from '../models/Task';
import { addPlannerUsage, type AttemptOutcome, type PlannerUsage, type UsageRecord } from '../models/Usage';

/**
 * An attempt that has run this long is worth a look whatever its plan's
 * history: below it, a task that runs long is still within what a single
 * brief often takes.
 */
export const RUNNING_LONG_FLOOR_MS = 30 * 60_000;
/** How many times the longest passed AI task's running time an attempt may run before it is flagged. */
export const RUNNING_LONG_FACTOR = 3;

/**
 * How many AI tasks must have passed before their median says how long a task
 * of this plan takes: fewer, and one slow or quick pass would set it.
 */
export const RUNNING_LONG_MEDIAN_AFTER = 5;
/**
 * The median's own floor and factor. In a recorded run whose slices took a
 * median of under 6 minutes, two ran on near 40 and were flagged only by
 * their context, 41 minutes in. A floor of 10 flagged a fifth of another
 * run's ordinary passes, whose first passes were quick; 19 flags those two at
 * 19 minutes and at most one in ten ordinary passes of the runs replayed.
 */
export const RUNNING_LONG_MEDIAN_FLOOR_MS = 19 * 60_000;
export const RUNNING_LONG_MEDIAN_FACTOR = 3;

/** How long an attempt may run before it is flagged, and what set it, when the floor did not. */
export interface RunningLongThreshold {
  ms: number;
  basis?: RunningLongBasis;
  /** Set when the median rule came first: its floor or its multiple did. */
  median?: RunningLongMedian;
  retryOf?: RunningLongRetry;
}

/** The median running time of the AI tasks that have passed, and how many have. */
export interface RunningLongMedian {
  passed: number;
  runningMs: number;
}

/** The AI task that passed in the longest running time, which the threshold is a multiple of. */
export interface RunningLongBasis {
  taskId: string;
  runningMs: number;
}

/** The task's own attempt before this one, which failed or was stopped after running this long. */
export interface RunningLongRetry {
  attempt: number;
  runningMs: number;
  outcome: AttemptOutcome;
}

/**
 * The larger of the floor and {@link RUNNING_LONG_FACTOR} times the longest
 * running time an AI task of this plan passed in, read from the attempt that
 * passed it; once {@link RUNNING_LONG_MEDIAN_AFTER} have passed, the median
 * rule's threshold instead when it comes first. The longest alone let a task
 * run seven times the plan's median before it was flagged. A script task has
 * its own `timeoutMs`, and a failed attempt says
 * nothing of how long the work takes, so neither counts. Its waits on a person
 * are left out, as the live clock leaves them out: a task that waited overnight
 * says nothing of how long the work takes either. An attempt saved before its
 * running time was kept has only its wall time.
 *
 * An attempt of `taskId` that follows one of its own that failed or was
 * stopped is flagged at the larger of the floor and that attempt's running
 * time instead: it has already had that long, and more of the same rarely
 * ends differently.
 */
export function runningLongThreshold(tasks: readonly Task[], taskId?: string): RunningLongThreshold {
  const passes: RunningLongBasis[] = [];
  let retryOf: RunningLongRetry | undefined;
  for (const task of flattenTasks(tasks)) {
    if (task.id === taskId) retryOf = endedWithout(task);
    if (task.type !== 'ai' || task.status !== 'completed') continue;
    const attempts = task.attemptUsage ?? [];
    const last = attempts[attempts.length - 1];
    if (!last?.endedAt) continue;
    passes.push({ taskId: task.id, runningMs: last.runningMs ?? last.wallTimeMs });
  }
  if (retryOf) return retryOf.runningMs > RUNNING_LONG_FLOOR_MS ? { ms: retryOf.runningMs, retryOf } : { ms: RUNNING_LONG_FLOOR_MS };
  const basis = passes.reduce<RunningLongBasis | undefined>((longest, pass) => (!longest || pass.runningMs > longest.runningMs ? pass : longest), undefined);
  const scaled = basis ? basis.runningMs * RUNNING_LONG_FACTOR : 0;
  const byLongest: RunningLongThreshold = basis && scaled > RUNNING_LONG_FLOOR_MS ? { ms: scaled, basis } : { ms: RUNNING_LONG_FLOOR_MS };
  if (passes.length < RUNNING_LONG_MEDIAN_AFTER) return byLongest;
  const median = { passed: passes.length, runningMs: medianOf(passes.map((pass) => pass.runningMs)) };
  const ms = Math.max(RUNNING_LONG_MEDIAN_FLOOR_MS, median.runningMs * RUNNING_LONG_MEDIAN_FACTOR);
  return ms < byLongest.ms ? { ms, median } : byLongest;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The task's latest ended attempt, when it ended failed or stopped: the live one has not ended. */
function endedWithout(task: Task): RunningLongRetry | undefined {
  const last = task.attemptUsage?.filter((usage) => usage.endedAt !== undefined).at(-1);
  return last?.outcome ? { attempt: last.attempt, runningMs: last.runningMs ?? last.wallTimeMs, outcome: last.outcome } : undefined;
}

/**
 * What a running-long flag says of the attempt (ADR-0018 W1): advisory, it
 * stops and fails nothing.
 */
export interface RunningLongFacts {
  /** Its running time passed the threshold, its runner's session compacted on its own, or its context passed {@link contextThresholdOf}. */
  reason: 'duration' | 'compaction' | 'context';
  /** Time the attempt has spent running, waits on a person left out. */
  elapsedMs: number;
  /** The running time this flag was due at: the threshold, doubled for each duration flag before it, or twice {@link previousMs}. */
  thresholdMs: number;
  /**
   * The running time the last duration flag was due at, when twice it set
   * this one: a threshold lowered since, doubled, would have come sooner.
   */
  previousMs?: number;
  basis?: RunningLongBasis;
  median?: RunningLongMedian;
  retryOf?: RunningLongRetry;
  /** On a context flag, the size it was due at: the context threshold, doubled for each context flag before it. */
  contextThreshold?: number;
  /** What the main model's context holds now, from the last usage record or compaction. */
  contextTokens?: number;
  contextWindow?: number;
  /** No catalog or listing stated `contextWindow`: the built-in runner assumed it (ADR-0070). */
  contextWindowAssumed?: true;
  /** Where Ordewell set the runner to compact its context, when it did: under {@link ROUTINE_WINDOW_BELOW} a compaction there is routine. */
  compactionWindow?: number;
  /** The most the context has held this attempt: the saved usage keeps only the last. */
  peakContextTokens?: number;
  /** Automatic compactions of the attempt's own runner session so far. */
  compactions: number;
}

/** A flag as the supervisor and the surfaces read it: the facts, of the attempt they were counted for. */
export type RunningLongEvent = RunningLongFacts & { attempt: number };

/**
 * Compactions of a runner that Ordewell set a small window for are routine,
 * and flagged from the third, then each time their count doubles: the 3rd,
 * 6th, 12th (ADR-0057 R4). Under such a window a task compacts a few times in
 * the course of ordinary work.
 */
export const ROUTINE_COMPACTIONS = 3;

/**
 * The window from which a compaction is not routine but news, as one at the
 * model's own window is: an ordinarily sized task never fills it, so one that
 * did has outgrown its brief (ADR-0057 R4).
 */
export const ROUTINE_WINDOW_BELOW = 200_000;

/**
 * The share of its effective window a task's context may fill before it is
 * flagged, and the size below which it never is (ADR-0057 R4). Both are a
 * judgement, not a measurement: quality is reported to fall with context
 * length well before a window is full, but no published study gives a size
 * where it starts, so these say only when the supervisor should look.
 */
export const CONTEXT_SHARE = 0.4;
export const CONTEXT_FLOOR_TOKENS = 150_000;

/**
 * The context a task may hold before it is first flagged: {@link CONTEXT_SHARE}
 * of its effective window, the smaller of the model's and a compaction window
 * in force, and never under {@link CONTEXT_FLOOR_TOKENS}. None while the
 * model's window is unknown.
 */
export function contextThresholdOf(modelWindow: number | undefined, compactWindow: number | undefined): { tokens: number; window: number } | undefined {
  if (modelWindow === undefined) return undefined;
  const window = compactWindow === undefined ? modelWindow : Math.min(modelWindow, compactWindow);
  return { tokens: Math.max(CONTEXT_FLOOR_TOKENS, window * CONTEXT_SHARE), window };
}

/**
 * The longest a clock waits before reading its threshold again. A pass can
 * lower it as well as raise it, once the median rule applies, so a timer armed
 * for the old threshold would fire late.
 */
const RECHECK_MS = 60_000;

/**
 * One attempt's running time, and the flags it raises. Time counts only while
 * the attempt runs: {@link hold} while it waits on a person (input, a
 * checkpoint, an approval), {@link run} once it goes on. Each duration flag
 * doubles the running time the next needs, as a quiet task's flag does.
 */
export class RunningLongClock {
  private accrued = 0;
  private since: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flags = 0;
  /** The running time the last duration flag was due at: the next is due at twice it at least. */
  private flaggedAt = 0;
  private contextFlags = 0;
  private compactions = 0;
  /** The main model's context as the usage meter keeps it, by the same rules: a compaction or a model change clears it. */
  private meter: PlannerUsage = { totals: {} };
  private peak?: number;
  /** The context a continued attempt started with, once its first call measured it: flags at or under it are its session's past, not this attempt's. */
  private baseline?: number;
  private awaitsBaseline: boolean;
  private stopped = false;

  constructor(
    private readonly threshold: () => RunningLongThreshold,
    private readonly flag: (facts: RunningLongFacts) => void,
    /** The size Ordewell set the runner to compact at; none where the runner compacts near its model's own window. */
    private readonly compactWindow: () => number | undefined = () => undefined,
    /** The attempt resumes a saved runner session, whose context it starts with (ADR-0018 W1). */
    opts: { continues?: boolean } = {},
  ) {
    this.awaitsBaseline = opts.continues === true;
  }

  run(): void {
    if (this.stopped || this.since !== null) return;
    this.since = Date.now();
    this.arm();
  }

  hold(): void {
    if (this.since === null) return;
    this.accrued = this.runningMs();
    this.since = null;
    this.disarm();
  }

  stop(): void {
    this.hold();
    this.stopped = true;
  }

  usage(record: UsageRecord): void {
    // A subagent's context is not the attempt's, and an aggregate names no current context.
    if (this.stopped || record.subagentId || record.aggregate) return;
    const before = this.meter;
    this.meter = addPlannerUsage(this.meter, record);
    // A peak is measured against one model's window: another model's does not carry over.
    if (before.model !== this.meter.model || before.source !== this.meter.source) this.peak = undefined;
    this.measure();
    if (this.awaitsBaseline && this.meter.lastPromptTokens !== undefined) {
      this.awaitsBaseline = false;
      this.baseline = this.meter.lastPromptTokens;
    }
    this.sized();
  }

  /**
   * One flag as the context first reaches its threshold, then one at each
   * doubling of it that is still under the effective window: a single call
   * that jumps past two raises one. A continued attempt counts from its
   * baseline: the first flag is the next doubling above it, since what the
   * session carried in says nothing of how this attempt is going.
   */
  private sized(): void {
    const tokens = this.meter.lastPromptTokens;
    const threshold = contextThresholdOf(this.meter.contextWindow, this.compactWindow());
    if (tokens === undefined || !threshold) return;
    let crossed: number | undefined;
    for (let due = threshold.tokens * 2 ** this.contextFlags; due < threshold.window && tokens >= due; due *= 2) {
      this.contextFlags += 1;
      if (this.baseline === undefined || due > this.baseline) crossed = due;
    }
    if (crossed !== undefined) this.flag({ ...this.facts('context', this.due()), contextThreshold: crossed });
  }

  /** A compaction of the attempt's own session: only one the runner did by itself says the context ran out. */
  compaction(trigger: 'manual' | 'auto', postTokens?: number): void {
    if (this.stopped) return;
    // The size before it is gone: with no size after, the context is unknown until the next call measures it.
    this.meter = { ...this.meter, lastPromptTokens: postTokens };
    this.measure();
    if (trigger !== 'auto') return;
    this.compactions += 1;
    if (this.routine() && !this.beyondRoutine()) return;
    this.flag(this.facts('compaction', this.due()));
  }

  private routine(): boolean {
    const window = this.compactWindow();
    return window !== undefined && window < ROUTINE_WINDOW_BELOW;
  }

  /** The 3rd compaction, the 6th, the 12th: the first that is no longer routine, then each doubling. */
  private beyondRoutine(): boolean {
    const n = this.compactions / ROUTINE_COMPACTIONS;
    return Number.isInteger(n) && Number.isInteger(Math.log2(n));
  }

  private measure(): void {
    const tokens = this.meter.lastPromptTokens;
    if (tokens !== undefined) this.peak = Math.max(this.peak ?? 0, tokens);
  }

  /** Time spent running so far, waits on a person left out. */
  runningMs(): number {
    return this.accrued + (this.since === null ? 0 : Date.now() - this.since);
  }

  /**
   * The first flag follows the threshold as passes move it. Every later one is
   * due at twice the last, whatever passes did since: a threshold read again
   * rose with the median of the tasks that passed, and two slow tasks of a
   * recorded run were not flagged a second time in over an hour.
   */
  private due(): number {
    return this.flags === 0 ? this.threshold().ms : this.flaggedAt * 2;
  }

  private arm(): void {
    this.disarm();
    // A flag further off wakes early, and ripe() reads the threshold and arms again.
    this.timer = setTimeout(() => this.ripe(), Math.min(RECHECK_MS, Math.max(0, this.due() - this.runningMs())));
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Read again when the timer fires: a task that passed in the meantime may have moved the threshold. */
  private ripe(): void {
    this.timer = null;
    const due = this.due();
    if (this.runningMs() < due) {
      this.arm();
      return;
    }
    const previous = this.flags > 0 ? this.flaggedAt : undefined;
    this.flags += 1;
    this.flaggedAt = due;
    this.flag({ ...this.facts('duration', due), ...(previous !== undefined ? { previousMs: previous } : {}) });
    if (!this.stopped && this.since !== null) this.arm();
  }

  private facts(reason: RunningLongFacts['reason'], thresholdMs: number): RunningLongFacts {
    const { basis, median, retryOf } = this.threshold();
    return {
      reason,
      elapsedMs: this.runningMs(),
      thresholdMs,
      ...(basis ? { basis } : {}),
      ...(median ? { median } : {}),
      ...(retryOf ? { retryOf } : {}),
      ...(this.meter.lastPromptTokens !== undefined ? { contextTokens: this.meter.lastPromptTokens } : {}),
      ...(this.meter.contextWindow !== undefined ? { contextWindow: this.meter.contextWindow } : {}),
      ...(this.meter.contextWindow !== undefined && this.meter.contextWindowAssumed ? { contextWindowAssumed: true as const } : {}),
      ...(this.compactWindow() !== undefined ? { compactionWindow: this.compactWindow() } : {}),
      ...(this.peak !== undefined ? { peakContextTokens: this.peak } : {}),
      compactions: this.compactions,
    };
  }
}

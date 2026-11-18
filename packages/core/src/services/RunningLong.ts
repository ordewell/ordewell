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

/** How long an attempt may run before it is flagged, and what set it, when the floor did not. */
export interface RunningLongThreshold {
  ms: number;
  basis?: RunningLongBasis;
  retryOf?: RunningLongRetry;
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
 * passed it. A script task has its own `timeoutMs`, and a failed attempt says
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
  let basis: RunningLongBasis | undefined;
  let retryOf: RunningLongRetry | undefined;
  for (const task of flattenTasks(tasks)) {
    if (task.id === taskId) retryOf = endedWithout(task);
    if (task.type !== 'ai' || task.status !== 'completed') continue;
    const attempts = task.attemptUsage ?? [];
    const last = attempts[attempts.length - 1];
    if (!last?.endedAt) continue;
    const runningMs = last.runningMs ?? last.wallTimeMs;
    if (!basis || runningMs > basis.runningMs) basis = { taskId: task.id, runningMs };
  }
  if (retryOf) return retryOf.runningMs > RUNNING_LONG_FLOOR_MS ? { ms: retryOf.runningMs, retryOf } : { ms: RUNNING_LONG_FLOOR_MS };
  const scaled = basis ? basis.runningMs * RUNNING_LONG_FACTOR : 0;
  return basis && scaled > RUNNING_LONG_FLOOR_MS ? { ms: scaled, basis } : { ms: RUNNING_LONG_FLOOR_MS };
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
  /** The running time this flag was due at: the threshold, doubled for each duration flag before it. */
  thresholdMs: number;
  basis?: RunningLongBasis;
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

/** The longest delay a timer keeps: Node fires a longer one at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
  private contextFlags = 0;
  private compactions = 0;
  /** The main model's context as the usage meter keeps it, by the same rules: a compaction or a model change clears it. */
  private meter: PlannerUsage = { totals: {} };
  private peak?: number;
  private stopped = false;

  constructor(
    private readonly threshold: () => RunningLongThreshold,
    private readonly flag: (facts: RunningLongFacts) => void,
    /** The size Ordewell set the runner to compact at; none where the runner compacts near its model's own window. */
    private readonly compactWindow: () => number | undefined = () => undefined,
  ) {}

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
    this.sized();
  }

  /**
   * One flag as the context first reaches its threshold, then one at each
   * doubling of it that is still under the effective window: a single call
   * that jumps past two raises one.
   */
  private sized(): void {
    const tokens = this.meter.lastPromptTokens;
    const threshold = contextThresholdOf(this.meter.contextWindow, this.compactWindow());
    if (tokens === undefined || !threshold) return;
    let crossed: number | undefined;
    for (let due = threshold.tokens * 2 ** this.contextFlags; due < threshold.window && tokens >= due; due *= 2) {
      this.contextFlags += 1;
      crossed = due;
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

  private due(): number {
    return this.threshold().ms * 2 ** this.flags;
  }

  private arm(): void {
    this.disarm();
    // A flag further off than a timer holds wakes early, and ripe() arms again.
    this.timer = setTimeout(() => this.ripe(), Math.min(MAX_TIMER_MS, Math.max(0, this.due() - this.runningMs())));
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Read again when the timer fires: a task that passed in the meantime may have raised the threshold. */
  private ripe(): void {
    this.timer = null;
    const due = this.due();
    if (this.runningMs() < due) {
      this.arm();
      return;
    }
    this.flags += 1;
    this.flag(this.facts('duration', due));
    if (!this.stopped && this.since !== null) this.arm();
  }

  private facts(reason: RunningLongFacts['reason'], thresholdMs: number): RunningLongFacts {
    const { basis, retryOf } = this.threshold();
    return {
      reason,
      elapsedMs: this.runningMs(),
      thresholdMs,
      ...(basis ? { basis } : {}),
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

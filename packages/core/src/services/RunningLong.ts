import { flattenTasks, type Task } from '../models/Task';
import type { UsageRecord } from '../models/Usage';

/**
 * An attempt that has run this long is worth a look whatever its plan's
 * history: below it, a task that runs long is still within what a single
 * brief often takes.
 */
export const RUNNING_LONG_FLOOR_MS = 30 * 60_000;
/** How many times the longest passed AI task's wall time an attempt may run before it is flagged. */
export const RUNNING_LONG_FACTOR = 3;

/** How long an attempt may run before it is flagged, and the passed task that set it, when one did. */
export interface RunningLongThreshold {
  ms: number;
  basis?: RunningLongBasis;
}

/** The AI task that passed in the longest wall time, which the threshold is a multiple of. */
export interface RunningLongBasis {
  taskId: string;
  wallTimeMs: number;
}

/**
 * The larger of the floor and {@link RUNNING_LONG_FACTOR} times the longest
 * wall time an AI task of this plan passed in, read from the attempt that
 * passed it. A script task has its own `timeoutMs`, and a failed attempt says
 * nothing of how long the work takes, so neither counts.
 */
export function runningLongThreshold(tasks: readonly Task[]): RunningLongThreshold {
  let basis: RunningLongBasis | undefined;
  for (const task of flattenTasks(tasks)) {
    if (task.type !== 'ai' || task.status !== 'completed') continue;
    const attempts = task.attemptUsage ?? [];
    const last = attempts[attempts.length - 1];
    if (!last?.endedAt) continue;
    if (!basis || last.wallTimeMs > basis.wallTimeMs) basis = { taskId: task.id, wallTimeMs: last.wallTimeMs };
  }
  const scaled = basis ? basis.wallTimeMs * RUNNING_LONG_FACTOR : 0;
  return basis && scaled > RUNNING_LONG_FLOOR_MS ? { ms: scaled, basis } : { ms: RUNNING_LONG_FLOOR_MS };
}

/**
 * What a running-long flag says of the attempt (ADR-0018 W1): advisory, it
 * stops and fails nothing.
 */
export interface RunningLongFacts {
  /** Its running time passed the threshold, or its runner's session compacted on its own. */
  reason: 'duration' | 'compaction';
  /** Time the attempt has spent running, waits on a person left out. */
  elapsedMs: number;
  /** The running time this flag was due at: the threshold, doubled for each duration flag before it. */
  thresholdMs: number;
  basis?: RunningLongBasis;
  /** What the main model's context holds now, from the last usage record or compaction. */
  contextTokens?: number;
  contextWindow?: number;
  /** The most the context has held this attempt: the saved usage keeps only the last. */
  peakContextTokens?: number;
  /** Automatic compactions of the attempt's own runner session so far. */
  compactions: number;
}

/** A flag as the supervisor and the surfaces read it: the facts, of the attempt they were counted for. */
export type RunningLongEvent = RunningLongFacts & { attempt: number };

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
  private compactions = 0;
  private context?: number;
  private window?: number;
  private peak?: number;
  private stopped = false;

  constructor(
    private readonly threshold: () => RunningLongThreshold,
    private readonly flag: (facts: RunningLongFacts) => void,
  ) {}

  run(): void {
    if (this.stopped || this.since !== null) return;
    this.since = Date.now();
    this.arm();
  }

  hold(): void {
    if (this.since === null) return;
    this.accrued = this.elapsed();
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
    if (record.contextWindow && record.contextWindow > 0) this.window = record.contextWindow;
    this.measure(record.contextTokens ?? record.inputTokens);
  }

  /** A compaction of the attempt's own session: only one the runner did by itself says the context ran out. */
  compaction(trigger: 'manual' | 'auto', postTokens?: number): void {
    if (this.stopped) return;
    this.measure(postTokens);
    if (trigger !== 'auto') return;
    this.compactions += 1;
    this.flag(this.facts('compaction', this.due()));
  }

  private measure(tokens: number | undefined): void {
    if (tokens === undefined) return;
    this.context = tokens;
    this.peak = Math.max(this.peak ?? 0, tokens);
  }

  private elapsed(): number {
    return this.accrued + (this.since === null ? 0 : Date.now() - this.since);
  }

  private due(): number {
    return this.threshold().ms * 2 ** this.flags;
  }

  private arm(): void {
    this.disarm();
    this.timer = setTimeout(() => this.ripe(), Math.max(0, this.due() - this.elapsed()));
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Read again when the timer fires: a task that passed in the meantime may have raised the threshold. */
  private ripe(): void {
    this.timer = null;
    const due = this.due();
    if (this.elapsed() < due) {
      this.arm();
      return;
    }
    this.flags += 1;
    this.flag(this.facts('duration', due));
    if (!this.stopped && this.since !== null) this.arm();
  }

  private facts(reason: RunningLongFacts['reason'], thresholdMs: number): RunningLongFacts {
    const { basis } = this.threshold();
    return {
      reason,
      elapsedMs: this.elapsed(),
      thresholdMs,
      ...(basis ? { basis } : {}),
      ...(this.context !== undefined ? { contextTokens: this.context } : {}),
      ...(this.window !== undefined ? { contextWindow: this.window } : {}),
      ...(this.peak !== undefined ? { peakContextTokens: this.peak } : {}),
      compactions: this.compactions,
    };
  }
}

import { flattenTasks, type Task, type TurnAuthority } from '../models/Task';
import type { StartWait, StartWaitKind } from './readiness';

/**
 * When the supervisor wakes during a run (#27, ADR-0057 R4). The decision is
 * {@link wakeDue}, a pure function of the events held and what the plan says:
 * no model, and no clock of its own, since the host stamps each event and polls
 * on its own tick. A pass opens nothing and rides along as context. An event a
 * person or a planner is waiting on wakes at once, which is ADR-0029's merge
 * window. Anything else is held until the plan says it is time, or until the
 * planner's prompt cache would go cold.
 *
 * `task_report` is a task addressed to the planner ending: one whose result a
 * planner turn asked for and did not get before it answered (ADR-0037, R2).
 * It wakes the planner whatever the supervisor's level, since the planner
 * asked for it.
 */

export type RunEventKind =
  | 'task_passed'
  | 'task_failed'
  | 'waiting_input'
  | 'waiting_approval'
  | 'task_idle'
  | 'landing_conflict'
  | 'usage_limit'
  | 'auto_merge_stopped'
  | 'run_finished'
  | 'task_report';

export type RunEvent = {
  kind: RunEventKind;
  taskId?: string;
  /** Epoch ms, on the same clock the host passes to `poll`. */
  at: number;
  detail?: string;
  /** `usage_limit` only: the runner whose limit paused the task. */
  runner?: string;
  /** `usage_limit` only: when its tasks resume on their own (ISO time); null when they wait for a manual retry. */
  resumeAt?: string | null;
  /** `usage_limit` in a batch: every task the runner's limit paused in it, in arrival order. */
  taskIds?: string[];
  /** `task_report` only: the result the planner asked for. */
  report?: TaskReportEvent;
};

/** What a digest says between a task and its report, which a surface finds the report by to draw it apart from the update's other lines. */
export const REPORT_LEAD = ', whose result you asked for, has ended.';

export interface TaskReportEvent {
  /** Whose turn started the task: the turn the report opens acts with its authority (ADR-0037, R3). */
  authority: TurnAuthority;
  /** Its verdict and the tail of its output, as the planner reads them: never cut to a digest line. */
  text: string;
  /** It passed: a pass, as far as the wake-up rate is concerned. */
  passed: boolean;
}

export interface WakeBatch {
  /** What woke the supervisor and what was held for it, in arrival order; never empty. */
  attention: RunEvent[];
  /** The passes since the previous wake-up. */
  sinceLast: RunEvent[];
}

/** The events no one is waiting on: held until the plan or the cache says it is time (ADR-0057 R4). */
const HELD_KINDS: ReadonlySet<RunEventKind> = new Set<RunEventKind>(['task_failed', 'task_idle']);

/** Whether an event is held rather than waking at once. */
export function isHeldEvent(event: Pick<RunEvent, 'kind'>): boolean {
  return HELD_KINDS.has(event.kind);
}

/** The most a wake carries (ADR-0057 R5): overflow becomes counts and a pointer. A tuning value. */
export const WAKE_MAX_CHARS = 24_000;

/**
 * A turn's run updates within {@link WAKE_MAX_CHARS}, whole and oldest first,
 * then how many are left out. A turn takes every update that waited for it,
 * so each one's own cap does not bound what the planner is sent; the
 * transcript keeps them all.
 */
export function boundedWakeUps(digests: readonly string[]): string[] {
  let used = 0;
  let kept = 0;
  while (kept < digests.length && used + digests[kept].length <= WAKE_MAX_CHARS) used += digests[kept++].length;
  const more = digests.length - kept;
  return more > 0 ? [...digests.slice(0, kept), `+${more} more run update${more === 1 ? '' : 's'}; task_query reads the tasks they were about.`] : [...digests];
}

/** A planner's prompt cache whose connector does not state how long it lasts (ADR-0057 R4). */
export const UNKNOWN_CACHE_TTL_MS = 5 * 60_000;

/** How far into the cache's life a wake goes out, so it finds its prefix warm. */
const CACHE_TTL_SHARE = 0.8;

/** What the plan says of the held events, read as the decision is made (ADR-0057 R4). */
export interface WakePlanFacts {
  /** Nothing is under way, and nothing can start, without a decision. */
  nothingCanStart: boolean;
  /** The tasks every task that became ready with them has ended. */
  cohortDone: ReadonlySet<string>;
  /** The failed tasks holding back work that would otherwise be ready. */
  blocksWork: ReadonlySet<string>;
}

/** The planner's prompt cache, as its provider counts it: from the start of a request. */
export interface WakeCacheClock {
  /** How long the prefix lasts, as the connector states it; absent reads as {@link UNKNOWN_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** When the planner's last request started, on the events' clock; null when no live context holds a prefix. */
  requestAt: number | null;
}

export type WakeFacts = WakePlanFacts & WakeCacheClock;

export type WakeReason = 'run_ended' | 'at_once' | 'nothing_can_start' | 'cohort_done' | 'failure_blocks_work' | 'max_age';

export interface WakeDue {
  /** On the events' clock; a moment already past means now. */
  at: number;
  reason: WakeReason;
}

/**
 * When the held events are due, and why; null while nothing is held. A pass
 * is never held, so a plan that only passes opens no turn. `facts` is read
 * only for held events alone, since it walks the plan.
 */
export function wakeDue(held: readonly RunEvent[], facts: () => WakeFacts, debounceMs: number): WakeDue | null {
  const first = held[0];
  if (!first) return null;
  // Nothing later in the run can join the batch.
  if (held.some((e) => e.kind === 'run_finished')) return { at: first.at, reason: 'run_ended' };
  // A fixed window from the event: one that restarted on each event could be held off by tasks that keep settling.
  const waited = held.find((e) => !isHeldEvent(e));
  if (waited) return { at: waited.at + debounceMs, reason: 'at_once' };
  const { nothingCanStart, cohortDone, blocksWork, ttlMs = UNKNOWN_CACHE_TTL_MS, requestAt } = facts();
  const merged = first.at + debounceMs;
  if (nothingCanStart) return { at: merged, reason: 'nothing_can_start' };
  if (held.some((e) => e.taskId !== undefined && cohortDone.has(e.taskId))) return { at: merged, reason: 'cohort_done' };
  if (held.some((e) => e.kind === 'task_failed' && e.taskId !== undefined && blocksWork.has(e.taskId))) return { at: merged, reason: 'failure_blocks_work' };
  const life = ttlMs * CACHE_TTL_SHARE;
  const warmUntil = requestAt === null ? Number.NEGATIVE_INFINITY : requestAt + life;
  // A prefix warm as the event came is what the wake must reach; one already cold has nothing to save, and the event its full age.
  const aged = warmUntil > first.at ? Math.min(warmUntil, first.at + life) : first.at + life;
  return { at: Math.max(merged, aged), reason: 'max_age' };
}

/** What moves on its own: nothing about these waits needs a decision. */
const PASSING_WAITS: ReadonlySet<StartWaitKind> = new Set<StartWaitKind>(['completing', 'queued', 'merging', 'usage-limit', 'start-hold']);

/**
 * What the plan says for {@link wakeDue}. A cohort is the tasks with the same
 * dependencies: what one task's end made ready together, read from the plan
 * alone. Run one after another each task is a cohort of its own.
 * `running`: a scheduler is armed, so a ready task will start with nobody
 * asking; without one only what is under way moves.
 */
export function planWakeFacts(plan: readonly Task[], waits: ReadonlyMap<string, readonly StartWait[]>, running: boolean): WakePlanFacts {
  const tasks = flattenTasks(plan);
  const passes = (wait: StartWait) => PASSING_WAITS.has(wait.kind) || (wait.kind === 'repeating' && wait.waiting.length === 0);
  const moves = (task: Task): boolean => task.status === 'in_progress' || (running && (waits.get(task.id) ?? []).every(passes));

  const cohorts = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = JSON.stringify([...task.dependencies].sort());
    const cohort = cohorts.get(key);
    if (cohort) cohort.push(task);
    else cohorts.set(key, [task]);
  }
  const cohortDone = new Set<string>();
  for (const cohort of cohorts.values()) {
    if (!cohort.some(moves)) for (const { id } of cohort) cohortDone.add(id);
  }

  const blocked = new Set<string>();
  for (const [id, held] of waits) if (held.some((w) => w.kind === 'blocked')) blocked.add(id);
  const blocksWork = new Set<string>();
  for (const held of waits.values()) {
    const failed = held.flatMap((w) => (w.kind === 'blocked' ? w.failed : []));
    if (failed.length === 0) continue;
    // Otherwise ready: all it waits for is what failed, however far back.
    const otherwise = held.every((w) => w.kind === 'blocked' || passes(w) || (w.kind === 'dependencies' && w.waiting.every((id) => failed.includes(id) || blocked.has(id))));
    if (otherwise) for (const id of failed) blocksWork.add(id);
  }
  return { nothingCanStart: !tasks.some(moves), cohortDone, blocksWork };
}

export interface WakePolicyOptions {
  /** How long the first event due at once waits for others to join its wake-up: ADR-0029's merge window. */
  debounceMs: number;
  /** What the plan says now, read only when held events have nothing else to go by. */
  facts: () => WakeFacts;
}

/** What the policy holds before its next wake-up, for the plan (ADR-0029). */
export interface WakePolicySnapshot {
  /** The events waiting for a wake-up, in arrival order. */
  attention: RunEvent[];
  /** The passes since the previous wake-up. */
  sinceLast: RunEvent[];
}

export interface WakePolicy {
  push(event: RunEvent): void;
  poll(now: number): WakeBatch | null;
  /** When `poll` next answers a batch, on the events' clock; null while nothing would wake the supervisor. */
  dueAt(): number | null;
  /** What waits, so a daemon restart still delivers it. */
  snapshot(): WakePolicySnapshot;
  /** Put back a save's waiting events, replacing whatever this held. */
  restore(snapshot: WakePolicySnapshot | undefined): void;
}

export function createWakePolicy(options: WakePolicyOptions): WakePolicy {
  const { debounceMs, facts } = options;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError(`debounceMs must be a finite, non-negative number of milliseconds, got ${debounceMs}`);
  }

  let attention: RunEvent[] = [];
  let sinceLast: RunEvent[] = [];

  const dueAt = (): number | null => wakeDue(attention, facts, debounceMs)?.at ?? null;

  return {
    push(event) {
      if (event.kind === 'task_passed') {
        sinceLast.push(event);
        return;
      }
      // Only silence and the run's end collapse: a task flickering between
      // silence and output is one fact, while two waiting_input events are two
      // questions.
      if (event.kind === 'task_idle' && attention.some((e) => e.kind === 'task_idle' && e.taskId === event.taskId)) return;
      if (event.kind === 'run_finished' && attention.some((e) => e.kind === 'run_finished')) return;
      if (event.kind === 'usage_limit') {
        // One limit is one fact however many of its runner's tasks it pauses:
        // they all resume, or wait, together.
        const at = attention.findIndex((e) => e.kind === 'usage_limit' && e.runner === event.runner);
        const taskIds = event.taskId === undefined ? [] : [event.taskId];
        if (at < 0) {
          attention.push({ ...event, taskIds });
          return;
        }
        const joined = attention[at];
        attention = attention.map((e, i) => (i !== at ? e : {
          ...joined,
          taskIds: [...new Set([...(joined.taskIds ?? []), ...taskIds])],
          resumeAt: event.resumeAt ?? joined.resumeAt ?? null,
        }));
        return;
      }
      attention.push(event);
    },

    poll(now) {
      const due = dueAt();
      if (due === null || now < due) return null;
      const batch = { attention, sinceLast };
      attention = [];
      sinceLast = [];
      return batch;
    },

    dueAt,

    snapshot() {
      return { attention: [...attention], sinceLast: [...sinceLast] };
    },

    restore(snapshot) {
      attention = [...(snapshot?.attention ?? [])];
      sinceLast = [...(snapshot?.sinceLast ?? [])];
    },
  };
}

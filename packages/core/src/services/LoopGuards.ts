import { flattenTasks, flattenTasksWithParents, type Task } from '../models/Task';
import { DEFAULT_SCRIPT_TIMEOUT_MS } from '../models/ScriptTask';
import { betweenRounds, loopRoundOf } from '../models/Loop';
import { actorAuthority, type ExecutionCommandName, type ExecutionRecord } from '../models/Execution';
import { UPDATABLE_FIELDS } from './TaskOps';
import type { ExecutionCommand } from './ExecutionCommands';

/**
 * The loop guards of an Act supervisor (ADR-0029): pure checks that stop it
 * spinning. Each answers with the trip — the note the model is refused with,
 * and the message the user is told — or null to let the action through. The
 * session keeps what they remember of the run and calls them where the action
 * executes: the command seam for retries, the edit path for edits, the
 * supervisor for its wake-ups.
 */

/** Retries an Act supervisor may make of one task in a run when the plan sets none. */
export const DEFAULT_SUPERVISOR_RETRY_LIMIT = 2;

/**
 * More wake-ups than `max` within `windowMs`, with no task passing in
 * between, and the supervisor is spinning: woken, acting, and nothing
 * getting done.
 */
export const WAKE_UP_RATE: WakeUpRate = { max: 6, windowMs: 30 * 60_000 };

export interface WakeUpRate {
  max: number;
  windowMs: number;
}

/** A guard that tripped. */
export interface GuardTrip {
  /** The guard and what it caught, so the user is told of one trip once however often the model repeats the call. */
  key: string;
  /** The note the model is refused with: the guard, and what would be accepted. */
  refusal: string;
  /** What the user is told, as the supervisor's message. */
  escalation: string;
}

/** How a guard names a task: "task #3 "Build"". */
export interface GuardedTask {
  id: string;
  ref: string;
  title: string;
}

/** A task as the command seam located it: the task, and how the plan numbers it. */
export interface GuardTarget {
  task: Readonly<Task>;
  ref: string;
}

/** What an attempt was told and who ran it: a retry after a failure has to change one of them. */
export interface AttemptShape {
  prompt: string;
  skills: readonly string[];
  runner: string;
  model: string | null;
  effort: string | null;
  /**
   * A script task's body and time limit, read as a prompt is (ADR-0035):
   * what runs is all a script's retry could change. Absent for any other task,
   * and from a shape saved before script tasks.
   */
  script?: { commands: readonly (readonly string[])[] | null; script: string | null; timeoutMs: number };
}

export function attemptShape(task: Readonly<Task>): AttemptShape {
  return {
    prompt: task.prompt ?? '',
    skills: [...(task.skills ?? [])].sort(),
    runner: task.assignedRunner,
    model: task.assignedModel?.modelId ?? null,
    effort: task.assignedModel?.thinkingEffort ?? null,
    ...(task.type === 'script'
      ? { script: { commands: task.commands ?? null, script: task.script ?? null, timeoutMs: task.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS } }
      : {}),
  };
}

/**
 * What the loop guards remember as plain data, saved on the plan so a daemon
 * restart does not hand an Act supervisor a fresh retry budget or forget the
 * tasks it removed (ADR-0029). Maps become records and the reported-trip set an
 * array, so it round-trips through JSON.
 */
export interface SupervisionMemorySnapshot {
  /** Retries of one task this run, by task id. */
  retries: Record<string, number>;
  /** Skips of a task the supervisor had retried, by task id: each counts against the retry limit. Absent on saves before skip. */
  skips?: Record<string, number>;
  /** What each failed task's attempt ran with, by task id. */
  failedWith: Record<string, AttemptShape>;
  /** The supervisor's own edits this run. */
  edits: EditMemory;
  /** The keys of the guard trips the user was already told of. */
  told: string[];
  /** The tasks the user stopped and has not started again. Absent on saves before it. */
  stopped?: string[];
}

/** What starts one task: a task the user stopped is theirs to start, as a run they stopped is (ADR-0029). */
const STARTS_A_TASK: ReadonlySet<ExecutionCommandName> = new Set<ExecutionCommandName>(['run_task', 'retry_task', 'force_start']);

/**
 * Past `limit` retries of one task this run, a retry is refused and the task
 * is the user's. A skip of a task the supervisor retried spends the same
 * budget, so once the task is escalated the supervisor cannot skip it either:
 * retrying and then giving up are both its attempts at that task.
 */
export function retryLimit(task: GuardedTask, retried: number, limit: number, asked: 'retry' | 'skip' = 'retry', skipped = 0): GuardTrip | null {
  if (retried + skipped < limit) return null;
  const times = (n: number): string => (n === 1 ? 'once' : `${n} times`);
  const spent = `${times(retried)}${skipped > 0 ? ` and skipped it ${times(skipped)}` : ''}`;
  return {
    key: `retry-limit:${task.id}`,
    refusal: asked === 'skip'
      ? `Refused by the retry limit: you have retried ${named(task)} ${spent} this run, the most your settings allow, and a skip of a task you retried counts as one more. It is escalated to the user now: tell them what you tried, and leave skipping it to them.`
      : `Refused by the retry limit: you have retried ${named(task)} ${spent} this run, the most your settings allow. It is escalated to the user now: tell them what you tried, and do not retry it again.`,
    escalation: `Loop guard, retry limit: I retried ${named(task)} ${spent} this run, the most your settings allow, and stopped. It needs you: retry it, change it or skip it.`,
  };
}

/** A retry after a failure, with what the failed attempt was told and who ran it unchanged, is refused. */
export function identicalRetry(task: GuardedTask, failedWith: AttemptShape | undefined, now: AttemptShape): GuardTrip | null {
  if (!failedWith || stable(failedWith) !== stable(now)) return null;
  const refusal = now.script
    ? `Refused: ${named(task)} failed with this same body and time limit, and an unchanged retry would run the same commands. Change something or escalate: edit its "commands", "script" or "timeoutMs" with edit_plan, then retry; or tell the user.`
    : `Refused: ${named(task)} failed with this same prompt and model, and an unchanged retry would fail the same way. Change something or escalate: edit its prompt with edit_plan, or move it to another model or runner, then retry; or tell the user.`;
  return {
    key: `identical-retry:${task.id}`,
    refusal,
    escalation: `Loop guard, identical retry: I tried to retry ${named(task)} unchanged after it failed, and was stopped. If I cannot say what to change, it needs you.`,
  };
}

/** What the supervisor's own edits did this run: the tasks it removed, and each field it changed. */
export interface EditMemory {
  removed: readonly { title: string; prompt: string }[];
  changed: readonly { taskId: string; field: string; from: string }[];
}

export function noEdits(): EditMemory {
  return { removed: [], changed: [] };
}

/** The memory after one of the supervisor's edits landed, taking the plan from `before` to `after`. */
export function recordEdit(memory: EditMemory, before: readonly Task[], after: readonly Task[]): EditMemory {
  const kept = new Map(flattenTasks([...after]).map((t) => [t.id, t]));
  const removed = flattenTasks([...before]).filter((t) => !kept.has(t.id)).map((t) => ({ title: normalized(t.title), prompt: (t.prompt ?? '').trim() }));
  const changed = flattenTasks([...before]).flatMap((was) => {
    const now = kept.get(was.id);
    return now ? editedFields(was, now).map((field) => ({ taskId: was.id, field, from: stable(was[field]) })) : [];
  });
  return { removed: [...memory.removed, ...removed], changed: [...memory.changed, ...changed] };
}

/**
 * An edit taking the plan from `before` to `after` that re-adds a task the
 * supervisor removed this run, puts a field back to what it was before the
 * supervisor's own earlier edit of it, or re-arms a skipped task, is refused.
 */
export function oscillatingEdit(memory: EditMemory, before: readonly Task[], after: readonly Task[]): GuardTrip | null {
  const was = new Map(flattenTasks([...before]).map((t) => [t.id, t]));
  for (const task of flattenTasks([...after])) {
    const prior = was.get(task.id);
    if (!prior) {
      const prompt = (task.prompt ?? '').trim();
      const removed = memory.removed.find((r) => r.title === normalized(task.title) || (prompt !== '' && r.prompt === prompt));
      if (removed) return reAdded(removed.title);
      continue;
    }
    if (prior.status === 'skipped' && task.status !== 'skipped') return unSkipped(task);
    for (const field of editedFields(prior, task)) {
      const value = stable(task[field]);
      if (memory.changed.some((c) => c.taskId === task.id && c.field === field && c.from === value)) return reverted(task, field);
    }
  }
  return null;
}

/** The fields a planner may edit that differ between two versions of one task. */
export function editedFields(before: Readonly<Task>, after: Readonly<Task>): (keyof Task)[] {
  return UPDATABLE_FIELDS.filter((field) => stable(before[field]) !== stable(after[field]));
}

function reAdded(title: string): GuardTrip {
  return {
    key: `re-add:${title}`,
    refusal: `Edit refused: it re-adds "${title}", which you removed earlier this run. Re-adding what you removed is going round in circles; nothing was changed. Escalate to the user instead.`,
    escalation: `Loop guard, oscillating edits: I tried to re-add "${title}", which I removed earlier this run, and stopped. It needs you to decide whether that task belongs in the plan.`,
  };
}

/** A skip is a decision not to wait for the task; re-arming it undoes that, and is the user's to do, as a retry of it is. */
function unSkipped(task: Readonly<Task>): GuardTrip {
  return {
    key: `un-skip:${task.id}`,
    refusal: `Edit refused: it puts "${task.title}" back to run, which was skipped. Whether a skipped task runs again is the user's to decide; nothing was changed. Tell them if it should.`,
    escalation: `Loop guard: I tried to put "${task.title}" back to run after it was skipped, and stopped. Retry it yourself if it should run again.`,
  };
}

/** A task the user stopped stays stopped until they say otherwise: a start of it is refused, whatever woke the supervisor. */
export function stoppedByUser(task: GuardedTask): GuardTrip {
  return {
    key: `user-stopped:${task.id}`,
    refusal: `Refused: the user stopped ${named(task)}, so it is theirs to start again; nothing was changed. Tell them if you think it should run.`,
    escalation: `Loop guard: I tried to start ${named(task)} after you stopped it, and was refused. Retry it yourself if it should run again.`,
  };
}

function reverted(task: Readonly<Task>, field: string): GuardTrip {
  return {
    key: `revert:${task.id}:${field}`,
    refusal: `Edit refused: it changes the ${field} of "${task.title}" back to what it was before your own earlier edit. Undoing your own edits is going round in circles; nothing was changed. Escalate to the user instead.`,
    escalation: `Loop guard, oscillating edits: I tried to undo my own earlier change to the ${field} of "${task.title}", and stopped. It needs you to decide which way it should be.`,
  };
}

/** Whether `wakeUps` (times, oldest first, since the last pass) holds more than the rate allows within its window of `now`. */
export function wakeUpRateTripped(wakeUps: readonly number[], now: number, rate: WakeUpRate = WAKE_UP_RATE): boolean {
  return wakeUps.filter((at) => now - at < rate.windowMs).length > rate.max;
}

/**
 * What the loop guards remember while a supervisor acts, and the checks over
 * it. The session keeps one from the user's start of a run to their next: a
 * run the supervisor restarts itself, or a usage-limit reset resumes, is the
 * same stretch of supervision, or every restart would wipe the retries it
 * counts.
 */
export class SupervisionMemory {
  private retries = new Map<string, number>();
  private skips = new Map<string, number>();
  private failedWith = new Map<string, AttemptShape>();
  private edits = noEdits();
  private told = new Set<string>();
  private userStopped = new Set<string>();

  /**
   * The command seam's check of a supervisor's call. A start of a task that
   * failed in this stretch is a retry, however it is asked for — `run_plan`
   * included, which would start every failed task again.
   */
  check(command: ExecutionCommand, target: GuardTarget | undefined, tasks: readonly Task[], limit: number): GuardTrip | null {
    if (target && STARTS_A_TASK.has(command.command) && this.userStopped.has(target.task.id)) {
      return stoppedByUser({ id: target.task.id, ref: target.ref, title: target.task.title });
    }
    if (command.command === 'skip_task') {
      const retried = target ? this.retries.get(target.task.id) ?? 0 : 0;
      if (!target || retried === 0) return null;
      return retryLimit({ id: target.task.id, ref: target.ref, title: target.task.title }, retried, limit, 'skip', this.skips.get(target.task.id) ?? 0);
    }
    // Whatever command asks for it, a start of a check between rounds is its loop's next round (ADR-0045 L7).
    if (target && betweenRounds(target.task)) return null;
    const from = command.command === 'retry_task' ? command.from : undefined;
    for (const { task, ref, unchangedCounts } of this.retried(command.command, from, target, tasks)) {
      const guarded = { id: task.id, ref, title: task.title };
      const trip = retryLimit(guarded, this.retries.get(task.id) ?? 0, limit, 'retry', this.skips.get(task.id) ?? 0)
        ?? (unchangedCounts ? identicalRetry(guarded, this.failedWith.get(task.id), attemptShape(task)) : null);
      if (trip) return trip;
    }
    return null;
  }

  /** A call at the seam went through: a supervisor's retry is counted, and its skip of a task it retried. */
  done(record: ExecutionRecord, tasks: readonly Task[]): void {
    if (record.task && record.outcome === 'done' && actorAuthority(record.actor) === 'user' && STARTS_A_TASK.has(record.command)) this.userStopped.delete(record.task.id);
    if (record.actor !== 'supervisor' || record.outcome !== 'done') return;
    const { task: named } = record;
    if (record.command === 'skip_task') {
      if (named && this.retries.has(named.id)) this.skips.set(named.id, (this.skips.get(named.id) ?? 0) + 1);
      return;
    }
    const found = named ? flattenTasks([...tasks]).find((t) => t.id === named.id) : undefined;
    // A retry resets a check's round, so one past round 1 went on as its loop's next round (ADR-0045 L7).
    if (found?.loop && loopRoundOf(found) > 1) return;
    const target = found && named ? { task: found, ref: named.ref } : undefined;
    for (const { task } of this.retried(record.command, undefined, target, tasks)) {
      this.retries.set(task.id, (this.retries.get(task.id) ?? 0) + 1);
    }
  }

  /** A task's attempt settled: a failure is remembered as what it ran with, until the task passes. */
  settled(task: Readonly<Task>): void {
    if (task.status === 'failed') this.failedWith.set(task.id, attemptShape(task));
    else if (task.status === 'completed') this.failedWith.delete(task.id);
  }

  checkEdit(before: readonly Task[], after: readonly Task[]): GuardTrip | null {
    return oscillatingEdit(this.edits, before, after);
  }

  /** One of the supervisor's edits landed. */
  edited(before: readonly Task[], after: readonly Task[]): void {
    this.edits = recordEdit(this.edits, before, after);
  }

  /** The user stopped this task; it is theirs to start again. */
  stopped(taskId: string): void {
    this.userStopped.add(taskId);
  }

  /** Whether the user stopped every one of these tasks and has started none again. */
  allStopped(taskIds: readonly string[]): boolean {
    return taskIds.length > 0 && taskIds.every((id) => this.userStopped.has(id));
  }

  /** Whether the user is yet to hear of this trip; true once per trip, so a model repeating a refused call is not echoed. */
  firstReport(trip: GuardTrip): boolean {
    if (this.told.has(trip.key)) return false;
    this.told.add(trip.key);
    return true;
  }

  /** The memory as plain data for the plan; see {@link SupervisionMemorySnapshot}. */
  snapshot(): SupervisionMemorySnapshot {
    return {
      retries: Object.fromEntries(this.retries),
      skips: Object.fromEntries(this.skips),
      failedWith: Object.fromEntries(this.failedWith),
      edits: { removed: [...this.edits.removed], changed: [...this.edits.changed] },
      told: [...this.told],
      ...(this.userStopped.size > 0 ? { stopped: [...this.userStopped] } : {}),
    };
  }

  /** Put back a save's memory, replacing whatever this held; absent is a plan saved without any. */
  restore(snapshot: SupervisionMemorySnapshot | undefined): void {
    this.forget();
    if (!snapshot) return;
    for (const [id, count] of Object.entries(snapshot.retries ?? {})) this.retries.set(id, count);
    for (const [id, count] of Object.entries(snapshot.skips ?? {})) this.skips.set(id, count);
    for (const [id, shape] of Object.entries(snapshot.failedWith ?? {})) this.failedWith.set(id, shape);
    this.edits = {
      removed: [...(snapshot.edits?.removed ?? [])],
      changed: [...(snapshot.edits?.changed ?? [])],
    };
    this.told = new Set(snapshot.told ?? []);
    this.userStopped = new Set(snapshot.stopped ?? []);
  }

  forget(): void {
    this.retries.clear();
    this.skips.clear();
    this.failedWith.clear();
    this.edits = noEdits();
    this.told.clear();
    this.userStopped.clear();
  }

  /** The tasks a call would retry, and whether an unchanged retry of each is the identical retry the guard refuses. */
  private retried(command: ExecutionCommandName, from: 'fresh' | 'session' | undefined, target: GuardTarget | undefined, tasks: readonly Task[]): (GuardTarget & { unchangedCounts: boolean })[] {
    switch (command) {
      // A continue carries a new message, which is the change.
      case 'retry_task': return target ? [{ ...target, unchangedCounts: from !== 'session' }] : [];
      case 'run_task': return target && this.failedWith.has(target.task.id) ? [{ ...target, unchangedCounts: true }] : [];
      case 'run_plan': return flattenTasksWithParents([...tasks])
        .filter(({ task }) => this.failedWith.has(task.id) && task.status !== 'completed' && task.status !== 'skipped')
        .map(({ task, ref }) => ({ task, ref, unchangedCounts: true }));
      default: return [];
    }
  }
}

function named(task: GuardedTask): string {
  return `task ${task.ref} "${task.title}"`;
}

function normalized(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A value as one string, objects with their keys in order, so two equal values read the same however they were built. */
function stable(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

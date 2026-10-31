import { pausedOnLimit, waitsForReset, type Task } from '../models/Task';
import type { PlanStore } from './PlanStore';
import { summarizeOutput } from './promptAugment';
import { readUsageLimitReset, type TurnFailure } from './runnerExit';
import { resumeTime } from '../taskRow/status';
import { quotedList } from '../utils/quotedList';
import type { RunOrigin } from './TaskOrchestrator';
import type { HeldFrom } from './runState';

export type { HeldFrom } from './runState';

/** How long after a limit resets the work waiting on it goes again: the runner's clock and ours need not agree to the second. */
export const RESUME_MARGIN_MS = 60_000;

/** Work sent again after a reset that hits the limit within this did not get past it, so it is not sent again on its own. */
export const RELAPSE_MS = 5 * 60_000;

/** A task's pause, or its resume, changed: `resumeAt` is when it resumes on its own, null when it waits for the user. */
export interface LimitWait {
  taskId: string;
  runner: string;
  resumeAt: string | null;
  /** The resume was cancelled, which is no new pause. */
  cancelled?: true;
}

/**
 * A resume the user, planner or supervisor asked for before the reset; see
 * {@link LimitPauses.resumeNow}. It sweeps along every other task waiting on
 * the same runner's reset.
 */
export interface ResumeNow {
  taskId: string;
  origin: RunOrigin;
  message?: string;
}

/** The attempt the limit stopped, as far as its pause reads it. */
export interface LimitedAttempt {
  readonly runner: string;
  /** Whether it ran in a worktree of its own, which the pause keeps for the resume. */
  readonly worktree: boolean;
  /** Resumed after an earlier pause rather than started; see {@link RELAPSE_MS}. */
  readonly autoResumed: boolean;
  readonly startedAt: string;
}

/** The run's state is the orchestrator's (see `nextRunState`): a pause only holds it and lets it go. */
export interface HeldRun {
  /** Hold the run, however it stands — driven by the scheduler, a task started alone, or one ended on a failure; one already held stays as it is. */
  hold(): void;
  /** What the held run goes back to; null when nothing holds it. */
  heldFrom(): HeldFrom | null;
  /** Let a held run go back to what it was. */
  release(): void;
}

export interface LimitPausesHost {
  readonly store: Pick<PlanStore, 'get' | 'allTasks' | 'resolveTaskRunner' | 'markAwaitingUser' | 'setTaskResumeAt' | 'setTaskOutputSummary'>;
  readonly run: HeldRun;
  tell(level: 'info' | 'warn', message: string): void;
  waitChanged(wait: LimitWait): void;
  changed(): void;
  unawaited(work: Promise<unknown>, failure: string): void;
  /** Keep a paused attempt's worktree: the resume continues the work in it. */
  keepWorktree(taskId: string): Promise<void>;
  /** What follows an attempt that ended, here on a pause: the task has settled, and the run goes on or holds. */
  settled(taskId: string): Promise<void>;
  /** Start the next attempt of a task its reset, or `now`, resumes, as a continue of its saved session. */
  resume(taskId: string, now?: ResumeNow): Promise<void>;
}

/**
 * Tasks paused on their runner's usage limit, from the pause to its end
 * (ADR-0018, U1). However the limit arrived — the runner exited mid-turn on
 * it, a turn failed with it, or it refused the turn being started — the pause
 * is one rule: no verdict is recorded and nothing goes to the execution log,
 * since the attempt the limit cut short goes on at the resume, and a failure
 * would read as one everywhere it is shown. The task waits on the user with
 * reason `usage-limit`, and, when the runner said when its limit resets,
 * joins its runner's one wait and holds the run until then.
 *
 * The tasks, and when each resumes, stay on the plan; this keeps the wait per
 * runner and the hold on the run, and ends both however the last wait goes.
 */
export class LimitPauses {
  private readonly waits = new ResetWaits((runner) => this.host.unawaited(this.resumeRunner(runner), `Could not resume the tasks paused on the usage limit of ${runner}`));

  constructor(private readonly host: LimitPausesHost) {}

  /**
   * The attempt has ended on its runner's usage limit, which the runner
   * reported as `said`: its own words, or the failure of the turn it ran or
   * was refused. `output` is what the attempt printed. When the reset could
   * not be read, or the attempt was resumed a moment ago and hit the limit
   * again, the task waits for the user to retry it instead: resuming it
   * again would loop.
   */
  async pause(taskId: string, attempt: LimitedAttempt, said: string | TurnFailure, output: string): Promise<void> {
    const { store } = this.host;
    const task = store.get(taskId);
    if (!task) return;
    store.markAwaitingUser(taskId, 'usage-limit');
    // A task an edit made manual has no resume to wait for: `settled` releases it (ADR-0053), so it holds nothing and promises nothing.
    if (task.type === 'user') this.host.tell('info', `Task "${task.title}" stopped: ${attempt.runner} hit its usage limit. It is a manual task now, so it is yours to do.`);
    else this.waitForReset(task, attempt, said);
    // Words are the turn's whole output, too long to stand as the reason.
    const reason = typeof said === 'string' ? `${attempt.runner} hit its usage limit` : said.message;
    store.setTaskOutputSummary(taskId, summarizeOutput(reason, output));
    if (attempt.worktree) await this.host.keepWorktree(taskId);
    await this.host.settled(taskId);
  }

  /**
   * Keep a paused task from resuming on its own: it waits for a manual retry,
   * as one whose reset could not be read does. False when no resume was set.
   */
  cancel(taskId: string): boolean {
    const { store } = this.host;
    const task = store.get(taskId);
    if (!task || !waitsForReset(task)) return false;
    const runner = store.resolveTaskRunner(task);
    store.setTaskResumeAt(taskId, undefined);
    if (this.waitingOn(runner).length === 0) this.waits.disarm(runner);
    this.releaseHold();
    this.host.waitChanged({ taskId, runner, resumeAt: null, cancelled: true });
    this.host.changed();
    return true;
  }

  /** A stopped run does not start itself again: what waited on a reset waits for the user now. */
  cancelAll(): void {
    for (const task of this.host.store.allTasks.filter(waitsForReset)) this.cancel(task.id);
  }

  /**
   * Tasks stopped waiting some other way than through here: an edit took them
   * out of the plan or ended their pause, an attempt's end released one an edit
   * made manual, or Mark complete completed one. No
   * timer resumes a wait nothing owes, and the hold goes once nothing waits.
   */
  recount(): void {
    for (const runner of this.waits.armed()) if (this.waitingOn(runner).length === 0) this.waits.disarm(runner);
    this.releaseHold();
  }

  /**
   * A paused task moved to another runner: a session cannot cross runners,
   * so its resume goes, and since the move routes it around the limit, a run
   * the scheduler drove goes on as a retry would continue it. Returns what
   * the hold was from, null when nothing held the run; a task started alone
   * is the caller's to start again alone.
   */
  moved(taskId: string): HeldFrom | null {
    const from = this.host.run.heldFrom();
    this.cancel(taskId);
    if (from === 'scheduling') this.host.run.release();
    return from;
  }

  /**
   * The waits a loaded plan still owes. A resume time that passed while
   * nothing was running — the daemon was down, say — resumes at once.
   */
  rearm(): void {
    const { store } = this.host;
    this.waits.clear();
    for (const t of store.allTasks.filter(waitsForReset)) {
      if (Number.isNaN(Date.parse(t.resumeAt ?? ''))) store.setTaskResumeAt(t.id, undefined);
    }
    const runners = new Set(store.allTasks.filter(waitsForReset).map((t) => store.resolveTaskRunner(t)));
    for (const runner of runners) this.arm(runner);
  }

  /**
   * Resume a paused task now, the user having said its limit reset early. The
   * limit is the runner's account's, so every task waiting on that runner's
   * reset resumes with it, as at the reset itself. The caller refuses one that
   * cannot start before calling this, so a refusal changes no resume.
   */
  async resumeNow(now: ResumeNow): Promise<void> {
    const task = this.host.store.get(now.taskId);
    if (!task || !pausedOnLimit(task)) return;
    const runner = this.host.store.resolveTaskRunner(task);
    this.waits.disarm(runner);
    try {
      await this.resumeRunner(runner, now);
    } finally {
      // What did not resume — refused once its run opened, or swept along
      // with no slot left — still resumes at its reset.
      if (this.waitingOn(runner).length > 0) this.arm(runner);
    }
  }

  /**
   * A resumed task claimed its attempt. True when a run the scheduler drove
   * held for it and nothing else waits on a reset: the caller starts that run
   * again, which ends the hold. Otherwise the hold is released once nothing
   * waits, and a task started alone goes on alone.
   */
  resumed(): boolean {
    if (this.host.run.heldFrom() === 'scheduling' && !this.anyWaiting()) return true;
    this.releaseHold();
    return false;
  }

  private waitForReset(task: Readonly<Task>, attempt: LimitedAttempt, said: string | TurnFailure): void {
    const kept = attempt.worktree ? ': its worktree is kept' : '';
    const reset = readUsageLimitReset(attempt.runner, said);
    const relapsed = attempt.autoResumed && Date.now() - Date.parse(attempt.startedAt) < RELAPSE_MS;
    if (!reset || relapsed) {
      const why = relapsed
        ? 'hit its usage limit again right after it was resumed, so it is not resumed on its own again'
        : 'hit its usage limit';
      this.host.tell('warn', `Task "${task.title}" stopped before it reported completion: ${attempt.runner} ${why}. Retry it once the limit resets${kept}.`);
      this.host.waitChanged({ taskId: task.id, runner: attempt.runner, resumeAt: null });
      return;
    }
    this.host.store.setTaskResumeAt(task.id, new Date(reset.getTime() + RESUME_MARGIN_MS).toISOString());
    // Spawning more would spend the same exhausted limit, and the run stays
    // open — neither handed over nor merged at its end — however it was
    // started. A pause no reset resumes holds nothing: it keeps only its own
    // runner's tasks from starting (`readiness.usage-limit`).
    this.host.run.hold();
    const resumeAt = this.arm(attempt.runner);
    this.host.tell('info', `Task "${task.title}" paused: ${attempt.runner} hit its usage limit. It resumes on its own at ${resumeTime(resumeAt)}${kept}.`);
    this.host.waitChanged({ taskId: task.id, runner: attempt.runner, resumeAt: resumeAt.toISOString() });
  }

  private async resumeRunner(runner: string, now?: ResumeNow): Promise<void> {
    const asked = now ? this.host.store.get(now.taskId) : undefined;
    const due = [...(asked ? [asked] : []), ...this.waitingOn(runner).filter((t) => t.id !== asked?.id)];
    if (due.length === 0) return;
    this.host.tell('info', `The usage limit of ${runner} has reset: resuming ${quotedList(due.map((t) => t.title))}.`);
    await Promise.all(due.map((t) => this.host.resume(t.id, now)));
  }

  /** However the last wait went — the reset, a cancel, Mark complete or the task leaving the plan. */
  private releaseHold(): void {
    if (this.host.run.heldFrom() !== null && !this.anyWaiting()) this.host.run.release();
  }

  private anyWaiting(): boolean {
    return this.host.store.allTasks.some(waitsForReset);
  }

  /** The tasks waiting on `runner`'s reset to resume on their own. */
  private waitingOn(runner: string): Readonly<Task>[] {
    const { store } = this.host;
    return store.allTasks.filter((t) => waitsForReset(t) && store.resolveTaskRunner(t) === runner);
  }

  /**
   * Arm `runner`'s one wait for the latest resume time among its tasks, and
   * put that time on each of them, so they resume together.
   */
  private arm(runner: string): Date {
    const latest = Math.max(...this.waitingOn(runner).map((t) => Date.parse(t.resumeAt ?? '')));
    const at = this.waits.arm(runner, new Date(latest));
    for (const t of this.waitingOn(runner)) this.host.store.setTaskResumeAt(t.id, at.toISOString());
    return at;
  }
}

/**
 * Waits for usage limits to reset (#84): one per key, a runner for tasks or
 * the planner's one, however much work it paused, because a limit belongs to
 * the account a runner signs in with, not to one task. It only knows when to
 * wake its owner; what waits, and until when, is on the plan.
 */
export class ResetWaits {
  private waits = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly onDue: (key: string) => void) {}

  /**
   * Arm the wait for `at`, or keep the later of it and the one already armed:
   * a runner is usable only once every limit it hit has reset. Returns when
   * the wait ends.
   */
  arm(key: string, at: Date): Date {
    const current = this.waits.get(key);
    if (current && current.at >= at.getTime()) return new Date(current.at);
    this.disarm(key);
    this.schedule(key, at.getTime());
    return at;
  }

  disarm(key: string): void {
    const wait = this.waits.get(key);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.waits.delete(key);
  }

  clear(): void {
    for (const key of this.armed()) this.disarm(key);
  }

  armed(): string[] {
    return [...this.waits.keys()];
  }

  private schedule(key: string, at: number): void {
    // A timer cannot be set further out than this, so a longer wait re-arms itself.
    const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      if (this.waits.get(key)?.timer !== timer) return;
      if (Date.now() < at) {
        this.schedule(key, at);
        return;
      }
      this.waits.delete(key);
      this.onDue(key);
    }, delay);
    // A pending resume is no reason to keep a finished CLI process alive.
    timer.unref?.();
    this.waits.set(key, { at, timer });
  }
}

const MAX_TIMER_MS = 2 ** 31 - 1;

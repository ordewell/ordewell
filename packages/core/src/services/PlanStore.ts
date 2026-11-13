import {
  Task, TaskSnapshot, TaskStatus, RunnerId, AwaitingReason, DEFAULT_RUNNERS, flattenTasks,
  addTaskToPlan, removeTaskFromPlan, updateTaskInPlan,
  releaseMadeManual, runsAsOps,
} from '../models/Task';
import { startAttemptUsage, addAttemptUsage, endAttemptUsage, type RunnerSessionCost, type UsageRecord } from '../models/Usage';
import { sessionOwner } from './continuation';
import { betweenRounds, loopRoundOf } from '../models/Loop';
import type { SkipOrigin } from '../models/SkipOrigin';
import { handoffDigest, type StoredHandoff } from '../models/Handoff';
import { ATTEMPT_FIELDS, freshAttempt, type AttemptField } from '../models/TaskExecution';

/** See {@link PlanStore.ready}. */
const READY_KEEPS: readonly AttemptField[] = ['loopRound', 'reverted', 'carriedFrom'];

/**
 * Changes laid on a task the store owns. A field cleared stays as an
 * `undefined` key where the task held it, as a cleared field always has, and is
 * not added where it held none.
 */
function writeInto(task: Task, changes: Partial<Task>): void {
  const fields = task as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(changes)) {
    if (value !== undefined || field in fields) fields[field] = value;
  }
}

/**
 * Deep copy of a task tree, down to the arrays the store rewrites. A task's
 * usage is shared: the store replaces it and never writes into it, and it was
 * what a snapshot spent most of its time copying.
 */
function cloneTasks(tasks: ReadonlyArray<Readonly<Task>>): Task[] {
  return tasks.map((t) => ({
    ...t,
    dependencies: [...t.dependencies],
    ...(t.loop ? { loop: { ...t.loop, body: [...t.loop.body] } } : {}),
    subtasks: cloneTasks(t.subtasks ?? []),
  }));
}

/**
 * The deep module owning all plan-shaped state. Holds `planTasks` (the ordered
 * tree the user edits), the flattened `allTasks` view and the `taskMap` index.
 * The orchestrator calls `markCompleted`/`markFailed`/`markInProgress`/`retry`
 * to update task status — it never mutates task state directly.
 *
 * Completion and failure are read from `task.status` and nothing else, so
 * `isCompleted`, `completedCount`, `isAllComplete` and the scheduler's
 * dependency checks cannot disagree. The store owns its task objects: `load`
 * copies what it is given, the getters hand out readonly views, and
 * `snapshot` is the copy a caller may keep or write to disk.
 *
 * `rebuild` is the internal seam that keeps the flat views in sync with the
 * tree.
 *
 * `planRunners` lives here because it's part of the plan's identity (the runner
 * set, carried on the plan). `assertAssignedRunners` is pure store logic.
 */
export class PlanStore {
  private _planTasks: readonly Task[] = [];
  private _allTasks: readonly Task[] = [];
  private _taskMap = new Map<string, Task>();
  /** Task id → the top-level task it hangs under, itself for a top-level task. */
  private _rootMap = new Map<string, Task>();
  private _planRunners: RunnerId[] = [...DEFAULT_RUNNERS];
  private _onMutate: (() => void) | null = null;
  private _onTree: ((ids: ReadonlySet<string>) => void) | null = null;
  private _executionLog: TaskSnapshot[] = [];
  private _revision = 0;
  private _statusMark: { revision: number; mark: string } | null = null;

  /** Hook called after every structural mutation (add/remove/update/resetForRun). */
  set onMutate(cb: (() => void) | null) { this._onMutate = cb; }

  /**
   * Called with every task id, subtasks included, each time the tree is
   * rebuilt — on every route a task enters or leaves the plan, loads and
   * reconciled edits included, which `onMutate` does not hear.
   */
  set onTree(cb: ((ids: ReadonlySet<string>) => void) | null) { this._onTree = cb; }

  get planTasks(): ReadonlyArray<Readonly<Task>> { return this._planTasks; }
  get allTasks(): ReadonlyArray<Readonly<Task>> { return this._allTasks; }
  get planRunners(): RunnerId[] { return this._planRunners; }
  get completedCount(): number { return this.countStatus('completed'); }
  get failedCount(): number { return this.countStatus('failed'); }

  isAllComplete(): boolean { return this._allTasks.every((t) => t.status === 'completed'); }
  isAnyFailed(): boolean { return this._allTasks.some((t) => t.status === 'failed'); }
  isCompleted(id: string): boolean { return this._taskMap.get(id)?.status === 'completed'; }
  isSkipped(id: string): boolean { return this._taskMap.get(id)?.status === 'skipped'; }
  /** Nothing is left to do: every task completed or was skipped. */
  isFinished(): boolean { return this._allTasks.every((t) => t.status === 'completed' || t.status === 'skipped'); }
  isFailed(id: string): boolean { return this._taskMap.get(id)?.status === 'failed'; }

  get(taskId: string): Readonly<Task> | undefined { return this._taskMap.get(taskId); }

  /**
   * Moves with every write to the plan, so a reader that walks it can tell
   * whether its last walk still stands. Writers reach a task through
   * {@link edit}, so a write cannot leave this behind.
   */
  get revision(): number { return this._revision; }

  private edit(id: string): Task | undefined {
    this._revision++;
    return this._taskMap.get(id);
  }

  /**
   * Whether a task runs as an ops task (ADR-0020): a top-level AI task marked
   * so, or a script task, which is one by nature (ADR-0035). A subtask runs
   * with the top-level task it hangs under.
   */
  isOps(taskId: string): boolean {
    const root = this._rootMap.get(taskId);
    return !!root && runsAsOps(root);
  }

  /** Every task's status and what it waits for, to tell cheaply whether one has changed since this was read. */
  statusMark(): string {
    if (this._statusMark?.revision !== this._revision) {
      this._statusMark = { revision: this._revision, mark: this._allTasks.map((t) => `${t.status}:${t.awaitingReason ?? ''}:${t.resumeAt ?? ''}`).join() };
    }
    return this._statusMark.mark;
  }

  /** A copy of the task tree, detached from the store: later status changes do not reach it. */
  snapshot(): Task[] { return cloneTasks(this._planTasks); }

  getExecutionLog(): ReadonlyArray<TaskSnapshot> { return this._executionLog; }

  appendToLog(snapshot: TaskSnapshot): void {
    const idx = this._executionLog.findIndex((s) => s.id === snapshot.id);
    this._executionLog = idx >= 0
      ? this._executionLog.map((s, i) => (i === idx ? snapshot : s))
      : [...this._executionLog, snapshot];
  }

  /**
   * Drop a task's archived snapshot. Un-marking a completion has to erase the
   * "finished" record too — dependent tasks are prompted from the log, so a
   * left-behind snapshot would keep feeding them a result that no longer exists.
   */
  removeFromLog(taskId: string): void {
    this._executionLog = this._executionLog.filter((s) => s.id !== taskId);
  }

  clearLog(): void {
    this._executionLog = [];
  }

  private notifyMutate(): void { this._onMutate?.(); }

  private countStatus(status: TaskStatus): number {
    return this._allTasks.filter((t) => t.status === status).length;
  }

  load(tasks: ReadonlyArray<Readonly<Task>>, runners: readonly RunnerId[]): void {
    // Before anything is swapped: a refused plan leaves the one held in place.
    assertAssignedRunners(tasks, runners);
    this._planTasks = cloneTasks(tasks);
    this._planRunners = [...runners];
    this.rebuild();
    // A load changes no outcome. Completed tasks survive so a half-finished
    // plan resumes the remainder, and a failed task stays failed, with its
    // verdict and the tasks it blocks, until the user answers it: a retry, or
    // Execute (`resetForRun`) (ADR-0053). In-progress is left alone too: an
    // edit reconciled into a run loads over live attempts. A task saved in
    // progress is interrupted work, settled where it comes off disk
    // (`failInterruptedTasks`).
    for (const task of this._allTasks) {
      // Files from before ADR-0034 stored blocked tasks; the derived rule
      // decides that now, so an old one is the pending task it was.
      if ((task.status as string) === 'blocked') task.status = 'pending';
      // A session saved before owners or attempts were recorded belongs to the
      // runner the task is on as it loads: noted now, a move cannot lose it.
      if (task.runnerSessionId && !task.runnerSessionOwner) task.runnerSessionOwner = sessionOwner(task) ?? task.assignedRunner;
    }
  }

  add(partial: Partial<Task>): Task {
    const oldIds = new Set(this._taskMap.keys());
    this._planTasks = addTaskToPlan(this._planTasks, partial);
    this.rebuild();
    this.notifyMutate();
    return this._allTasks.find(t => !oldIds.has(t.id))!;
  }

  remove(taskId: string): void {
    if (!this._taskMap.has(taskId)) return;
    this._planTasks = removeTaskFromPlan(this._planTasks, taskId);
    this.rebuild();
    this.notifyMutate();
  }

  update(taskId: string, changes: Partial<Task>): Task | undefined {
    if (!this._taskMap.has(taskId)) return undefined;
    const safe: Partial<Task> = { ...changes };
    delete safe.id;
    delete safe.order;
    this._planTasks = updateTaskInPlan(this._planTasks, taskId, safe);
    this.rebuild();
    this.notifyMutate();
    return this._taskMap.get(taskId);
  }

  /**
   * Run preparation as one named op: flip every AI and script task to 'approved'. By
   * default completed tasks keep their status so a reloaded half-finished plan
   * resumes the remainder instead of re-running work that already succeeded,
   * and skipped ones stay skipped: a new run is not a retry of them. A failed
   * task gets its fresh chance here, not at a load (ADR-0053).
   * `preserveCompleted: false` is for a freshly committed plan, where
   * everything starts over. `edited` is an edit adopted between runs, which is
   * not the user starting over: a failed task stays failed, and a task waiting
   * on the user, whatever for, stays waiting. `keepFailed` is what failed in
   * the reply autorun's run follows: nobody asked for those to run again.
   */
  resetForRun(opts: { preserveCompleted?: boolean; edited?: boolean; keepFailed?: ReadonlySet<string> } = {}): void {
    const preserveCompleted = opts.preserveCompleted ?? true;
    this.releaseMadeManual();
    for (const t of this._allTasks) {
      // No run readies a manual task.
      if (t.type === 'user') continue;
      if (opts.edited && (t.status === 'failed' || t.status === 'awaiting_user')) continue;
      if (opts.keepFailed?.has(t.id)) continue;
      if (preserveCompleted && (t.status === 'completed' || t.status === 'skipped')) continue;
      // A check between rounds runs again once its body lands, not now (ADR-0045 L5).
      if (preserveCompleted && betweenRounds(t)) continue;
      // A failed check runs again as a retry would run it: its rounds start over (ADR-0045 L7).
      if (!preserveCompleted || t.status === 'failed') delete t.loopRound;
      this.ready(t);
    }
    this.notifyMutate();
  }

  /**
   * Execute's fresh chance with work already live (ADR-0053), which
   * `resetForRun` would take back: only what failed and is not at work is
   * readied, and a check between rounds still leaves its body to run first.
   */
  readyFailed(live: (taskId: string) => boolean): void {
    this.releaseMadeManual(live);
    for (const t of this._allTasks) {
      if (t.type === 'user' || t.status !== 'failed' || betweenRounds(t) || live(t.id)) continue;
      delete t.loopRound;
      this.ready(t);
    }
    this.notifyMutate();
  }

  /** See {@link releaseMadeManual}; `live` names what a runner still holds. */
  releaseMadeManual(live?: (taskId: string) => boolean): void {
    this._revision++;
    releaseMadeManual(this._planTasks, live);
  }

  /**
   * Execute's fresh chance: a fresh attempt, approved rather than pending, and
   * not yet started. So it keeps what that attempt is still owed: the round,
   * which its caller decides (ADR-0045 L5, L7), a revert's hold, which is the
   * user's to release by a retry or a force start and which the load after a
   * reset holds again (ADR-0054), and a carry-over, which the attempt it
   * readies is (ADR-0018 U1).
   */
  private ready(t: Task): void {
    this._revision++;
    const fields = t as unknown as Record<string, unknown>;
    for (const field of ATTEMPT_FIELDS) if (!READY_KEEPS.includes(field)) delete fields[field];
    t.status = 'approved';
  }

  /** A delegated task's checks; its scheduler, which knows what makes a task read-only, says which those are. */
  checksOf: (task: Readonly<Task>) => readonly Task[] = () => [];

  markCompleted(id: string): void {
    this.setStatus(id, 'completed');
  }

  markFailed(id: string): void {
    this.setStatus(id, 'failed');
  }

  /** The origin is the skip's own record of who ended the task; the reason is only what they said (ADR-0045 L7). */
  markSkipped(id: string, origin: SkipOrigin, reason?: string): void {
    this.setStatus(id, 'skipped');
    const task = this.edit(id);
    if (!task) return;
    task.skipOrigin = origin;
    if (reason) task.skipReason = reason;
  }

  markInProgress(id: string): void {
    this.setStatus(id, 'in_progress');
  }

  /** Its first attempt is starting: from now on its chat exists, whatever becomes of the attempt. */
  markAttempted(id: string): void {
    const task = this.edit(id);
    if (task) task.attempted = true;
  }

  /** Its attempt starts: the number now tells its waits from the last attempt's, so they count from nothing (ADR-0053). */
  markAttemptStarted(id: string): void {
    this.setStatus(id, 'in_progress');
    const task = this.edit(id);
    if (task) delete task.waitsEnded;
  }

  /** Saved beside the wait it explains: see {@link Task.parkedQuestion}. */
  parkQuestion(id: string, question: string): void {
    const task = this.edit(id);
    if (task) task.parkedQuestion = question;
  }

  markAwaitingUser(id: string, reason?: AwaitingReason): void {
    const task = this.edit(id);
    if (!task) return;
    this.leaveStatus(task, 'awaiting_user');
    task.status = 'awaiting_user';
    if (reason) task.awaitingReason = reason;
    else delete task.awaitingReason;
    delete task.resumeAt;
    delete task.skipReason;
    delete task.skipOrigin;
  }

  /** When a task paused on a usage limit resumes on its own; undefined leaves it to a manual retry. */
  setTaskResumeAt(id: string, resumeAt: string | undefined): void {
    const task = this.edit(id);
    if (!task || task.awaitingReason !== 'usage-limit') return;
    if (resumeAt) task.resumeAt = resumeAt;
    else delete task.resumeAt;
  }

  markPending(id: string): void {
    this.setStatus(id, 'pending');
  }

  /**
   * A new attempt of the task, from nothing it earned. A loop's check starts
   * its rounds over (ADR-0045 L7), unless `sameRound`: a resume after a usage
   * limit goes on with the attempt the limit cut short.
   */
  retry(id: string, opts: { sameRound?: boolean } = {}): void {
    const task = this.edit(id);
    if (!task) return;
    this.setStatus(id, 'pending');
    writeInto(task, freshAttempt({ sameRound: opts.sameRound }));
    if (!opts.sameRound) this.takeBackChecks(id);
  }

  /**
   * A pass judged one result, and a new attempt of a delegated task makes
   * another (ADR-0055 D8): its checks run again, whatever their status, their
   * rounds starting over. A check not started yet has nothing to take back. The
   * retries of every kind pass here; the claim asks for the starts that do not.
   */
  takeBackChecks(id: string): void {
    const task = this.edit(id);
    if (task?.type !== 'delegated') return;
    for (const check of this.checksOf(task)) {
      if (check.status !== 'pending' && check.status !== 'approved') this.retry(check.id);
    }
  }

  /** Its landed work was reverted (ADR-0054): as a retry leaves it, marked so until it starts. */
  markReverted(id: string): void {
    this.retry(id);
    const task = this.edit(id);
    if (task) task.reverted = true;
  }

  /** A loop's check counts its rounds afresh from its next run (ADR-0045 L7). */
  startRoundsOver(id: string): void {
    const task = this.edit(id);
    if (task) delete task.loopRound;
  }

  /**
   * The loop runs its check again, as its next round (ADR-0045 L5): a new
   * attempt, the round counted on, and nothing of the round before kept on
   * the task — its report went to the body, and stays in its attempt's log.
   */
  repeat(id: string): void {
    const task = this.edit(id);
    if (!task) return;
    const round = loopRoundOf(task) + 1;
    this.retry(id);
    task.loopRound = round;
  }

  /** Kept on the task: it was force-started past its merge gate, before these ancestors' work was merged (ADR-0020). */
  setForcedPastGate(id: string, dependencies: string[]): void {
    const task = this.edit(id);
    if (task) task.forcedPastGate = dependencies;
  }

  /** One of the task's waits is over, so what it waits on next is another (ADR-0053). */
  endWait(id: string): void {
    const task = this.edit(id);
    if (task) task.waitsEnded = (task.waitsEnded ?? 0) + 1;
  }

  /** Work under way is the one status nobody could be waiting on, so moving off any other ends a wait. */
  private leaveStatus(task: Task, status: TaskStatus): void {
    if (task.status !== status && task.status !== 'in_progress') this.endWait(task.id);
  }

  /** A reason outlives nothing: any status but `awaiting_user` drops it, and the resume time with it; any status drops a skip's reason and origin. */
  private setStatus(id: string, status: Exclude<TaskStatus, 'awaiting_user'>): void {
    const task = this.edit(id);
    if (!task) return;
    this.leaveStatus(task, status);
    task.status = status;
    delete task.awaitingReason;
    delete task.parkedQuestion;
    delete task.resumeAt;
    delete task.skipReason;
    delete task.skipOrigin;
    delete task.reverted;
  }

  setTaskVerdict(id: string, verdict: Task['verdict']): void {
    const task = this.edit(id);
    if (task) task.verdict = verdict;
  }

  /**
   * How the task's latest attempt ended, and the handoff it left (ADR-0047),
   * kept as its digest. An attempt that left no handoff clears the one before
   * it: the plan holds the latest attempt's, as it does the summary.
   */
  setTaskOutputSummary(id: string, summary: Task['outputSummary'], handoff?: StoredHandoff): void {
    const task = this.edit(id);
    if (!task) return;
    task.outputSummary = summary;
    if (handoff) task.handoff = handoffDigest(handoff);
    else delete task.handoff;
  }

  /** The owner is saved with the session it belongs to, and dropped with it. */
  setTaskRunnerSessionId(id: string, runnerSessionId: string | undefined, owner?: RunnerId): void {
    const task = this.edit(id);
    if (!task) return;
    task.runnerSessionId = runnerSessionId;
    if (runnerSessionId && owner) task.runnerSessionOwner = owner;
    else delete task.runnerSessionOwner;
  }

  setCarriedFrom(id: string, runner: RunnerId): void {
    const task = this.edit(id);
    if (task) task.carriedFrom = runner;
  }

  clearCarriedFrom(id: string): void {
    const task = this.edit(id);
    if (task) delete task.carriedFrom;
  }

  startAttemptUsage(id: string, attempt: number, runner: string, startedAt: string): void {
    const task = this.edit(id);
    if (task) task.attemptUsage = [...task.attemptUsage ?? [], startAttemptUsage(attempt, runner, startedAt)];
  }

  recordAttemptUsage(id: string, attempt: number, record: UsageRecord, now: string): void {
    const task = this.edit(id);
    if (task?.attemptUsage) task.attemptUsage = task.attemptUsage.map((usage) => usage.attempt === attempt ? addAttemptUsage(usage, record, now) : usage);
  }

  endAttemptUsage(id: string, attempt: number, now: string, runnerSessionCost?: RunnerSessionCost, sessionId?: string): void {
    const task = this.edit(id);
    if (task?.attemptUsage) task.attemptUsage = task.attemptUsage.map((usage) => usage.attempt === attempt ? endAttemptUsage(usage, now, runnerSessionCost, sessionId) : usage);
  }

  setTaskAttemptSkills(id: string, skills: Task['attemptSkills']): void {
    const task = this.edit(id);
    if (task) task.attemptSkills = skills && skills.length > 0 ? skills : undefined;
  }

  /**
   * Widen the plan's runner set. Retargeting a task onto a runner the plan has
   * not used before has to land here as well as on the plan state, or
   * {@link resolveTaskRunner} reads the new runner as foreign and spawns the
   * plan's first one instead.
   */
  admitRunner(runner: RunnerId): void {
    if (!this._planRunners.includes(runner)) this._planRunners = [...this._planRunners, runner];
  }

  resolveTaskRunner(task: Readonly<Task>): RunnerId {
    if (task.assignedRunner && this._planRunners.includes(task.assignedRunner)) return task.assignedRunner;
    const fallback = this._planRunners[0] ?? DEFAULT_RUNNERS[0];
    if (task.assignedRunner) {
      console.warn(
        `[PlanStore] Task "${task.title}" is assigned to "${task.assignedRunner}", which is not in this plan's ` +
        `runner set [${this._planRunners.join(', ')}]: spawning "${fallback}" instead.`,
      );
    }
    return fallback;
  }

  private rebuild(): void {
    this._revision++;
    // Frozen because the getters return these arrays as they are; a caller
    // that casts the readonly type away still cannot reshape the plan.
    Object.freeze(this._planTasks);
    this._allTasks = Object.freeze(flattenTasks(this._planTasks));
    this._taskMap.clear();
    for (const task of this._allTasks) {
      this._taskMap.set(task.id, task);
    }
    this._rootMap.clear();
    for (const root of this._planTasks) {
      for (const task of flattenTasks([root])) this._rootMap.set(task.id, root);
    }
    this._onTree?.(new Set(this._taskMap.keys()));
  }

}

/** Throws for an AI task, subtasks included, assigned to a runner outside `runners`. */
export function assertAssignedRunners(tasks: ReadonlyArray<Readonly<Task>>, runners: readonly RunnerId[]): void {
  for (const task of flattenTasks(tasks)) {
    if (task.type !== 'ai' && task.type !== 'delegated') continue;
    if (!runners.includes(task.assignedRunner)) {
      throw new Error(
        `Task "${task.title}" has assignedRunner "${task.assignedRunner}" ` +
        `which is not in the plan's runner set: [${runners.join(', ')}]`
      );
    }
  }
}

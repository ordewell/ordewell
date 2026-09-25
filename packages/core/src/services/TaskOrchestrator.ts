import { Task, TaskSnapshot, Verdict, QueuedMessage, RunnerId, flattenTasksWithParents, taskOrderLabel } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { INotification } from '../interfaces/INotification';
import { ITerminalRunner, ITerminalSession } from '../interfaces/ITerminalRunner';
import { composeAugmentedPrompt, summarizeOutput } from './promptAugment';
import { VerdictEngine } from './VerdictEngine';
import { BufferedTaskOutputSource } from './BufferedTaskOutputSource';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { PlanStore } from './PlanStore';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type {
  IsolationHandoff,
  IsolationInactiveReason,
  IsolationMergeResult,
  IsolationOutcome,
  IsolationRun,
  IsolationView,
  IWorktreeIsolation,
  PlanIsolation,
  RepoGroupLayout,
  TaskIsolation,
} from '../interfaces/IWorktreeIsolation';
import { createWorktreeIsolation } from './GitWorktreeIsolation';
import { describeMergeResult } from './mergeResultNotice';
import { handoffOf, integrationBranchNameOf, layoutOf, SELF_REPO, taskIsolationOf } from './isolationRecord';
import type { IsolatedExecution } from './plannerModes';

/**
 * The one notification channel out of the orchestrator. Everything that used
 * to travel over separate callbacks (onRefresh, onQueueReady) is an observer
 * event; the Session subscribes once and turns these into SessionMessages.
 */
export interface OrchestratorObserver {
  /** Any task-shaped state changed (store mutation, checkpoint, retry, …). */
  onTaskChanged?(): void;
  onTick?(): void;
  onExecutionComplete?(): void;
  /** Queued user messages are ready to be processed by the planner. */
  onQueueReady?(): void;
  onReviewNeeded?(data: { tasks: Task[]; planRunners: RunnerId[] }): void;
  onReviewApproved?(data: { tasks: Task[] }): void;
  onCheckpoint?(data: { taskId: string; taskTitle: string; summary: string }): void;
  /** The isolation run record changed and should be persisted with the plan. */
  onIsolationChanged?(): void;
  /** A run did not start: the tree is dirty, and the user picks stash or no isolation. `repos` names the dirty repos of a group. */
  onIsolationBlocked?(data: { reason: 'dirty'; repos: string[] }): void;
  /** An isolated run settled; emitted before `onExecutionComplete`, which surfaces treat as terminal. */
  onIsolationHandoff?(handoff: IsolationHandoff): void;
  /**
   * What a run says about how it isolates — the fallback to the workspace root,
   * shared paths, copies, a stash. Beside the notification channel, which a
   * daemon may leave unwired, so a surface without toasts can still show it.
   */
  onIsolationNotice?(data: { level: 'info' | 'warn'; message: string }): void;
}

type SharedRootReason = Exclude<IsolationInactiveReason, 'dirty'>;

type RunDecision =
  | { mode: 'isolated'; continuing: boolean; layout: RepoGroupLayout }
  | { mode: 'blocked'; repos: string[] }
  | { mode: 'shared'; reason: SharedRootReason; repos: string[] };

const SHARED_ROOT_TAIL = 'tasks run in the workspace root without worktree isolation.';

/** Why a run fell back to the shared workspace root, as the one line the user is told. */
function sharedRootNotice(reason: SharedRootReason, repos: string[]): string {
  switch (reason) {
    case 'disabled': return 'Worktree isolation is off — tasks run in the workspace root.';
    case 'git-missing': return `git was not found — ${SHARED_ROOT_TAIL}`;
    case 'no-commits':
      return repos.length > 0
        ? `No repository in this folder has commits yet (${repos.join(', ')}) — ${SHARED_ROOT_TAIL}`
        : `The repository has no commits yet — ${SHARED_ROOT_TAIL}`;
    case 'not-git': return `Not a git repository — ${SHARED_ROOT_TAIL}`;
    case 'nested-repos':
      return `This repository contains nested repositories that are not submodules (${repos.join(', ')}) — ${SHARED_ROOT_TAIL} Ignore them in git or make them submodules to isolate this repository.`;
  }
}

/** What a new run shares live instead of isolating, as one line; null when it shares nothing. */
function sharedPathsNotice(run: IsolationRun): string | null {
  const loose = run.shared.filter((p) => !run.sharedRepos.includes(p));
  if (run.sharedRepos.length === 0) {
    if (loose.length === 0) return null;
    const one = loose.length === 1;
    return `${loose.join(', ')} ${one ? 'is' : 'are'} shared live with every task, so edits to ${one ? 'it' : 'them'} are not isolated.`;
  }
  const one = run.sharedRepos.length === 1 && loose.length === 0;
  const subject = [run.sharedRepos.length === 1 ? 'It' : 'They', ...(loose.length > 0 ? [`and ${loose.join(', ')}`] : [])].join(' ');
  return `Could not isolate ${run.sharedRepos.join(', ')} (no commits, or git refused a worktree). `
    + `${subject} ${one ? 'is' : 'are'} shared live with every task, so edits to ${one ? 'it' : 'them'} are not isolated.`;
}

/**
 * One run of one task, from the moment the scheduler claims it until its
 * verdict, cancel, stop or plan load. Everything that has to die with the run
 * lives on this record, so {@link TaskOrchestrator.endAttempt} releases all of
 * it at once and nothing can be left behind for one exit path to forget.
 */
interface TaskAttempt {
  readonly taskId: string;
  /** 1-based count of spawns this task has had since the plan was loaded. */
  readonly attempt: number;
  /**
   * `starting` while the async spawn is in flight; `session` is null until
   * `running`. `integrating` once a passed verdict is merging the attempt's
   * worktree — still live, so the task neither completes nor frees its
   * dependents until the merge says so.
   */
  phase: AttemptPhase;
  session: ITerminalSession | null;
  readonly runner: string;
  /** Null until {@link TaskOrchestrator.resolveAttemptCwd} settles. */
  cwd: string | null;
  /** Whether `cwd` is a worktree prepared for this attempt rather than the workspace root. */
  worktree: boolean;
  /** The merge in flight, so a cancel waits for it before tearing the worktree down. */
  integration: Promise<IsolationOutcome> | null;
  readonly startedAt: string;
}

type AttemptPhase = 'starting' | 'running' | 'integrating';

/** Read-only view of a task's live attempt. */
export interface TaskAttemptSnapshot {
  taskId: string;
  attempt: number;
  phase: AttemptPhase;
  sessionId: string | null;
  runner: string;
  cwd: string | null;
  startedAt: string;
}

type AttemptEnd = 'verdict' | 'cancel' | 'release' | 'complete' | 'retry' | 'spawn-failed' | 'stop' | 'load';

/**
 * The pure scheduler. Owns execution state (`running`, `planStatus`,
 * `reviewApproved`, the live task attempts, `messageQueue`) and the verifier.
 * All task-shaped state — the plan tree, the flat index, the completed set
 * — lives in {@link PlanStore}, injected at construction. The orchestrator
 * calls `store.markCompleted(id)` / `store.markFailed(id)` instead of mutating
 * task state directly. A task completes only after the runner emits its
 * per-task completion marker; process exit without that evidence is a visible
 * failure and does not unblock dependent work.
 */
export class TaskOrchestrator {
  private store: PlanStore;
  private attempts = new Map<string, TaskAttempt>();
  private verifier = new VerdictEngine();
  private running = false;
  private planStatus: 'approved' | 'running' | 'completed' = 'approved';
  private messageQueue: QueuedMessage[] = [];
  private reviewApproved = false;
  /*
   * Retry counts, spawn counts and holds describe a task across attempts, so
   * they deliberately live outside the attempt record: ending an attempt must
   * not forget that the user held the task or how often it has run.
   */
  private retryCounts = new Map<string, number>();
  private spawnCounts = new Map<string, number>();
  /**
   * Tasks pulled out of auto-scheduling (user-cancelled or failed to spawn).
   * They stay 'pending' — "not executed" — but the scheduler skips them until
   * the user retries or force-starts, which would otherwise loop forever on a
   * task whose spawn always throws.
   */
  private onHold = new Set<string>();

  private isolation: IWorktreeIsolation;
  /** The plan's isolation run (ADR-0013). Outlives one run: a resumed plan continues it. */
  private isolationRun: IsolationRun | null = null;
  /** Copied paths already reported for the current run: every task gets the same copies. */
  private reportedCopies = new Set<string>();
  /**
   * How the open run executes; null while no run is open. A run is one
   * Execute-Plan or one manual task run, from its start until it settles or
   * is stopped.
   */
  private runMode: 'isolated' | 'shared' | null = null;
  /** Resolver task id → the conflicted task it resolves; see {@link linkConflictResolver}. */
  private resolvers: Record<string, string> = {};
  private opening: Promise<boolean> | null = null;
  /** The start a dirty tree turned away, replayed once the user chooses how to go on. */
  private blockedStart: (() => Promise<void>) | null = null;
  /** The dirty repos behind {@link blockedStart}, for the stash notice. */
  private blockedRepos: string[] = [];

  private registry: RunnerRegistry | null = null;
  private workspaceRootFn: () => string = () => process.cwd();
  private observers: OrchestratorObserver[] = [];
  private tddEnabled: () => boolean = () => false;

  constructor(
    private config: IConfig,
    private notifications: INotification,
    private terminalRunner: ITerminalRunner,
    store?: PlanStore,
    private output: TaskOutputSource = new BufferedTaskOutputSource(),
    isolation?: IWorktreeIsolation,
  ) {
    this.store = store ?? new PlanStore();
    this.isolation = isolation ?? createWorktreeIsolation({ config });
    this.store.onMutate = () => this.emit('onTaskChanged');
    this.verifier.onVerdict((taskId, verdict) => this.onVerdict(taskId, verdict));
    this.verifier.onCheckpoint((taskId, summary) => {
      const task = this.store.get(taskId);
      if (!task) return;
      this.store.markAwaitingUser(taskId);
      this.emit('onCheckpoint', { taskId, taskTitle: task.title, summary });
    });
    // idleSince is advisory UI state, not a store mutation — broadcast it
    // through the same onTaskChanged seam without touching PlanStore.
    this.verifier.onIdleChange(() => this.emit('onTaskChanged'));
  }

  /** Advisory silence timestamp for a task's live runner, or null if not idle. */
  getIdleSince(taskId: string): string | null {
    return this.verifier.getIdleSince(taskId);
  }

  /** Recent clean output of a task's latest attempt, running or ended; null if it never ran. */
  getLiveOutput(taskId: string, opts: LiveTailOptions): LiveTail | null {
    return this.output.liveTail(taskId, opts);
  }

  get storeInstance(): PlanStore { return this.store; }

  setWorkspaceRoot(fn: () => string): void {
    this.workspaceRootFn = fn;
  }

  setRegistry(registry: RunnerRegistry): void {
    this.registry = registry;
  }

  /**
   * A getter rather than a value where the caller has one: every task gets its
   * prompt composed at spawn time, but only a full-plan run passes through a
   * point where a snapshot could be refreshed — so "Run task", force-start and
   * retry would compose against whatever the last run happened to set.
   */
  setTddEnabled(enabled: boolean | (() => boolean)): void {
    this.tddEnabled = typeof enabled === 'function' ? enabled : () => enabled;
  }

  /*
   * A checkpoint only exists while its attempt runs. Without a live attempt the
   * task is awaiting the user for another reason — a merge conflict — and
   * putting it back to in_progress would strand it with no runner behind it.
   */
  approveCheckpoint(taskId: string): void {
    if (!this.attempts.has(taskId)) return;
    this.verifier.approveCheckpoint(taskId);
    this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
  }

  rejectCheckpoint(taskId: string, reason?: string): void {
    if (!this.attempts.has(taskId)) return;
    this.verifier.rejectCheckpoint(taskId, reason ?? 'Checkpoint rejected by user');
    this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
  }

  subscribe(observer: OrchestratorObserver): () => void {
    this.observers.push(observer);
    return () => {
      this.observers = this.observers.filter(o => o !== observer);
    };
  }

  private emit(event: keyof OrchestratorObserver, ...args: unknown[]): void {
    for (const o of this.observers) {
      const fn = o[event] as (...args: unknown[]) => void;
      if (fn) fn(...args);
    }
  }

  get isRunning(): boolean {
    return this.running || this.attempts.size > 0;
  }
  /**
   * A runner is executing *right now*. Narrower than {@link isRunning}, which
   * also covers the armed-but-idle scheduler `tick()` deliberately leaves
   * behind when a plan is paused on a user task, a checkpoint or a hold —
   * nothing is executing then, so nothing is reading the plan mid-mutation.
   */
  get hasLiveWork(): boolean {
    return this.attempts.size > 0;
  }
  get isReviewApproved(): boolean { return this.reviewApproved; }
  get status(): 'approved' | 'running' | 'completed' { return this.planStatus; }
  get activeTaskIds(): string[] { return [...this.activeSessionMap.keys()]; }
  /** Task id → session id of every attempt whose runner is up; a spawn in flight has no session yet. */
  get activeSessionMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, attempt] of this.attempts) {
      if (attempt.session) map.set(taskId, attempt.session.id);
    }
    return map;
  }

  getAttempt(taskId: string): TaskAttemptSnapshot | undefined {
    const attempt = this.attempts.get(taskId);
    if (!attempt) return undefined;
    const { taskId: id, attempt: n, phase, session, runner, cwd, startedAt } = attempt;
    return { taskId: id, attempt: n, phase, sessionId: session?.id ?? null, runner, cwd, startedAt };
  }

  /** Where a task's isolated work stands; null when the plan has no isolation run to speak of. */
  getTaskIsolation(taskId: string): TaskIsolation | null {
    if (!this.isolationRun) return null;
    const record = this.isolationRun.tasks[taskId];
    if (!record) return { state: 'none' };
    return taskIsolationOf(record);
  }

  /**
   * The plan's isolation as a surface shows it, for one with no stream to have
   * told it — a reconnected webview, a session just loaded. Null without a run.
   */
  isolationView(): IsolationView | null {
    const run = this.isolationRun;
    if (!run) return null;
    const tasks = Object.fromEntries(Object.values(run.tasks).map((r): [string, TaskIsolation] => [r.taskId, taskIsolationOf(r)]));
    return { tasks, handoff: handoffOf(run) };
  }

  getAttemptSession(taskId: string): ITerminalSession | undefined {
    return this.attempts.get(taskId)?.session ?? undefined;
  }
  get queuedCount(): number { return this.messageQueue.length; }

  /** A run is waiting on the user to stash or to go on without isolation. */
  get awaitingIsolationChoice(): boolean { return this.blockedStart !== null; }

  /**
   * Take over a plan's persisted isolation, or none for a plan that has not
   * isolated yet. Whatever a crashed process left behind for the run — a
   * worktree still marked active, a directory no record owns — is pruned,
   * while kept, failed and conflicted worktrees stay for the user.
   *
   * Deliberately silent on the observer: adopting is not a change to persist,
   * and a host that adopts without persisting (VS Code's restore) would
   * otherwise write a new session file on every reload.
   */
  async adoptIsolation(state: PlanIsolation | null): Promise<void> {
    this.isolationRun = state?.run ?? null;
    this.resolvers = { ...(state?.resolvers ?? {}) };
    if (!this.isolationRun) return;
    try {
      await this.isolation.pruneOrphans(this.isolationRun);
    } catch (err) {
      this.tell('warn', `Could not prune leftover worktrees: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async reviewRunDiff(): Promise<string> {
    return this.isolation.reviewDiff(this.requireRun());
  }

  /** "Merge all": the run's integration branches into whatever the user has checked out, in every repo or none. */
  async mergeRun(): Promise<IsolationMergeResult> {
    const run = this.requireRun();
    const result = await this.isolation.mergeIntoCheckedOut(run);
    const branch = integrationBranchNameOf(run);
    const group = run.repos.some((r) => r.path !== SELF_REPO);
    const { level, message } = describeMergeResult(result, branch, group);
    this.notifications[level](message);
    return result;
  }

  /** Worktrees and task branches go; the integration branch and the record stay for review and merge. */
  async cleanupRun(): Promise<void> {
    await this.isolation.discard(this.requireRun(), { keepIntegration: true });
    this.emit('onIsolationChanged');
  }

  /** The run and everything it made go, and the plan forgets it; the next run starts afresh. */
  async discardRun(): Promise<void> {
    await this.isolation.discard(this.requireRun(), { keepIntegration: false });
    this.isolationRun = null;
    this.resolvers = {};
    this.emit('onIsolationChanged');
  }

  private requireRun(): IsolationRun {
    if (!this.isolationRun) throw new Error('This plan has no isolated run');
    return this.isolationRun;
  }

  /** What the plan persists of isolated execution; null when no run ever isolated. */
  get isolationRecord(): PlanIsolation | null {
    return this.isolationRun ? { run: this.isolationRun, resolvers: this.resolvers } : null;
  }

  queueMessage(text: string): void {
    this.messageQueue.push({
      id: `q-${Date.now()}`,
      text,
      timestamp: new Date().toISOString(),
    });
    this.emit('onTaskChanged');
  }

  getQueuedMessages(): QueuedMessage[] {
    return [...this.messageQueue];
  }

  setQueuedMessages(messages: QueuedMessage[]): void {
    this.messageQueue = [...messages];
  }

  clearQueuedMessages(): void {
    this.messageQueue = [];
  }

  processNextQueuedMessage(): QueuedMessage | null {
    if (this.messageQueue.length === 0) return null;
    return this.messageQueue.shift() ?? null;
  }

  loadPlan(tasks: Task[], planRunners: RunnerId[] = ['claude-code']): void {
    this.store.load(tasks, planRunners);
    this.endAllAttempts('load');
    // A plan committed while the scheduler runs keeps that run, and its mode
    // with it; otherwise the next start decides afresh.
    if (!this.running) this.runMode = null;
    this.blockedStart = null;
    this.planStatus = 'approved';
    this.reviewApproved = false;
    this.retryCounts.clear();
    this.spawnCounts.clear();
    this.onHold.clear();
  }

  /**
   * Adopt an edited plan without letting go of the run in progress. Everything
   * the scheduler owns — live sessions, holds, retry counts, the verifier and
   * the review approval — survives, because `loadPlan` clears all of it and a
   * mid-run edit is not a new run. Only the tasks change.
   *
   * The ids with live sessions are defended: one dropped from the edited plan is
   * carried over (its verdict still has to land somewhere), and one whose status
   * the snapshot predates is put back to `in_progress` — adopting the snapshot's
   * "pending" would offer the scheduler work a runner is already doing.
   */
  reconcilePlan(newTasks: Task[], planRunners: RunnerId[] = ['claude-code']): void {
    const adopted = [...newTasks];
    for (const taskId of this.attempts.keys()) {
      const task = this.store.get(taskId);
      if (!task) continue;

      const at = adopted.findIndex((t) => t.id === taskId);
      if (at < 0) {
        adopted.push({ ...task });
      } else if (adopted[at].status !== 'in_progress') {
        console.warn(`[TaskOrchestrator] Running task "${task.title}" status changed to "${adopted[at].status}" in modified plan, using orchestrator truth`);
        adopted[at] = { ...adopted[at], status: 'in_progress' };
      }
    }

    this.store.load(adopted, planRunners);
    this.planStatus = 'running';
  }

  async start(): Promise<void> {
    if (this.blockedStart) return;
    if (this.running) {
      console.error('[TaskOrchestrator] start() called but already running — no-op');
      return;
    }
    if (!this.reviewApproved) {
      console.log('[TaskOrchestrator] start() blocked — plan review not yet approved. Emitting onReviewNeeded.');
      this.emit('onReviewNeeded', { tasks: this.store.planTasks, planRunners: this.store.planRunners });
      return;
    }
    if (!(await this.openRun(() => this.start())) || this.running) return;
    console.log(`[TaskOrchestrator] Starting with ${this.store.allTasks.length} tasks (${this.store.allTasks.filter(t => t.type === 'ai' && t.prompt).length} AI ready)`);
    this.running = true;
    this.planStatus = 'running';
    this.emit('onTaskChanged');
    await this.tick();
  }

  stop(): void {
    this.running = false;
    this.planStatus = 'approved';
    this.terminalRunner.stopAll();
    // Interrupted work is kept like a failed attempt's: inspectable, and off
    // `active` so a crash-recovery prune does not sweep it away.
    const interrupted = [...this.attempts.values()].filter((a) => a.worktree);
    this.endAllAttempts('stop');
    for (const a of interrupted) void this.releaseWorktree(a.taskId, { keep: true }, a.integration);
    this.runMode = null;
    this.blockedStart = null;
    this.onHold.clear();
    this.emit('onTaskChanged');
  }

  async onUserTaskComplete(taskId: string): Promise<void> {
    return this.markTaskComplete(taskId);
  }

  private async onVerdict(taskId: string, verdict: Verdict): Promise<void> {
    const task = this.store.get(taskId);
    const attempt = this.attempts.get(taskId);
    if (!task || !attempt) return;

    console.error(`[TaskOrchestrator] Task #${task.order} "${task.title}" verdict=${verdict.outcome}`);
    console.error(`[TaskOrchestrator] Runner: ${task.assignedRunner}, Model: ${task.assignedModel?.modelId ?? 'default'}`);
    console.error(`[TaskOrchestrator] Prompt preview: ${(task.prompt ?? '').slice(0, 200)}`);

    // The terminal stays the source of truth for the verdict itself; this only
    // changes what gets summarized for downstream consumers.
    const doneToken = `<<<ORDEWELL_DONE_${task.completionMarker}>>>`;
    const summary = await this.output.finalText({ ...attempt, completionMarker: task.completionMarker }, doneToken);
    // The attempt stays live across the read, so a cancel, retry, mark
    // complete, stop or plan load in that window ends it — and has decided the
    // task since. A stale verdict must not overwrite that decision.
    if (this.attempts.get(taskId) !== attempt) return;
    const landing = verdict.outcome === 'pass' && attempt.worktree ? await this.integrate(task, attempt) : 'merged';
    if (this.attempts.get(taskId) !== attempt) return;
    this.endAttempt(taskId, 'verdict');
    this.store.setTaskVerdict(taskId, verdict);
    console.error(`[TaskOrchestrator] Output summary:\n${summary || '(empty — no output captured)'}`);
    if (verdict.outcome === 'pass') {
      await this.landPassed(task, landing);
    } else {
      this.store.markFailed(taskId);
      // Missing completion evidence is a hard boundary: do not launch more
      // work from a full-plan run until the user retries/resumes explicitly.
      // Already-active parallel tasks may finish, but no new task is spawned.
      this.running = false;
      this.planStatus = 'approved';
      this.notifications.error(`Task "${task.title}" failed verification: ${verdict.reason}`);
      if (attempt.worktree) await this.releaseWorktree(taskId, { keep: true });
    }

    this.store.setTaskOutputSummary(taskId, summarizeOutput(verdict.reason, summary));

    this.logAndArchive(task, verdict);

    this.emit('onTaskChanged');
    if (!this.running) {
      if (this.attempts.size === 0) {
        if (this.store.isAllComplete()) this.planStatus = 'completed';
        this.emit('onTick');
        await this.closeRun();
        this.emit('onExecutionComplete');
      }
      return;
    }
    await this.tick();
  }

  /**
   * Merge a passed attempt's worktree. The attempt stays live while it waits on
   * the module's merge queue, so a cancel, retry or stop in that window still
   * wins, and nothing counts the task as done before its work is on the
   * integration branch.
   */
  private async integrate(task: Task, attempt: TaskAttempt): Promise<IsolationOutcome> {
    if (!this.hasUnlandedWork(task.id)) return 'failed';
    attempt.phase = 'integrating';
    attempt.integration = this.integrateWork(task);
    return attempt.integration;
  }

  /** A worktree whose work is not on the integration branch yet. */
  private hasUnlandedWork(taskId: string): boolean {
    const record = this.isolationRun?.tasks[taskId];
    return !!record && record.status !== 'merged';
  }

  private async integrateWork(task: Task): Promise<IsolationOutcome> {
    const run = this.isolationRun;
    if (!run) return 'failed';
    // Saved before the first merge, so a crash mid-landing leaves the tips to roll back to.
    const outcome = await this.isolation.integrate(task, run, () => this.emit('onIsolationChanged')).catch((): IsolationOutcome => 'failed');
    this.emit('onIsolationChanged');
    return outcome;
  }

  /** Settle a task whose work passed, by what its integration reported. */
  private async landPassed(task: Task, landing: IsolationOutcome): Promise<void> {
    if (landing !== 'merged') return this.landUnmerged(task, landing);
    this.store.markCompleted(task.id);
    this.notifications.info(`Task "${task.title}" completed.`);
    await this.landResolved(task.id);
  }

  private landUnmerged(task: Task, landing: Exclude<IsolationOutcome, 'merged'>): void {
    const branch = this.isolationRun ? integrationBranchNameOf(this.isolationRun) : 'the integration branch';
    // Named only where there is a repo to name: a group of one reads as it always has.
    const repo = this.isolationRun?.tasks[task.id]?.conflictRepo;
    const inRepo = repo && repo !== SELF_REPO ? repo : null;
    if (landing === 'conflict') {
      // Never resolved here, by a model or otherwise: the task waits on the
      // user, and its dependents wait on it.
      this.store.markAwaitingUser(task.id);
      this.notifications.warn(inRepo
        ? `Task "${task.title}" passed, but landing it on ${branch} conflicted in ${inRepo}, so none of it landed. Its worktrees are kept — resolve it by hand, retry it, or resolve it as a task.`
        : `Task "${task.title}" passed, but merging it into ${branch} conflicted. Its worktree is kept — resolve it by hand, retry it, or resolve it as a task.`);
    } else {
      this.store.markFailed(task.id);
      this.running = false;
      this.planStatus = 'approved';
      this.notifications.error(inRepo
        ? `Task "${task.title}" passed, but git could not integrate its work in ${inRepo}, so none of it landed. Its worktrees are kept for inspection.`
        : `Task "${task.title}" passed, but git could not integrate its work. Its worktree is kept for inspection.`);
    }
  }

  /**
   * Mark which added task resolves which conflict. The resolver merges the
   * conflicted task's branch by hand in its own worktree; once that lands, the
   * conflicted task's branch is already on the integration branch and it can
   * land in turn — through the same merge, so a resolver that did not really
   * bring it along conflicts again instead of being taken at its word.
   */
  linkConflictResolver(resolverId: string, conflictedId: string): void {
    this.resolvers[resolverId] = conflictedId;
    this.emit('onIsolationChanged');
  }

  private async landResolved(resolverId: string): Promise<void> {
    const conflictedId = this.resolvers[resolverId];
    if (!conflictedId) return;
    delete this.resolvers[resolverId];
    this.emit('onIsolationChanged');
    const conflicted = this.store.get(conflictedId);
    // Only the conflict it was added for: a task retried since has a new
    // attempt of its own, whose worktree it would merge half-done.
    if (!conflicted || this.isolationRun?.tasks[conflictedId]?.status !== 'conflict') return;
    const landing = await this.integrateWork(conflicted);
    if (landing !== 'merged') return this.landUnmerged(conflicted, landing);
    this.store.markCompleted(conflictedId);
    this.store.unblockDependents(conflictedId);
    if (conflicted.verdict) this.logAndArchive(conflicted, conflicted.verdict);
    this.notifications.info(`Task "${conflicted.title}" landed through its conflict resolution.`);
  }

  /**
   * Let go of a task's worktree. `keep` leaves it and its branch for
   * inspection; otherwise both go. A merge still in flight finishes first, so
   * the worktree is never torn down underneath it.
   */
  private async releaseWorktree(taskId: string, opts: { keep: boolean }, integration?: Promise<IsolationOutcome> | null): Promise<void> {
    await integration;
    const run = this.isolationRun;
    if (!run?.tasks[taskId]) return;
    try {
      await this.isolation.release(run, taskId, opts);
    } catch (err) {
      this.notifications.warn(`Could not clean up the worktree of task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.emit('onIsolationChanged');
  }

  getReadyTasks(): Task[] {
    if (!this.running) return [];
    const maxParallel = this.config.maxParallelSessions;
    const currentActive = this.attempts.size;
    if (currentActive >= maxParallel) return [];
    const availableSlots = maxParallel - currentActive;

    const candidates = this.store.allTasks.filter((t) => {
      if (t.status !== 'pending' && t.status !== 'approved') return false;
      if (t.type === 'user') return false;
      if (!t.prompt) return false;
      if (this.onHold.has(t.id)) return false;
      if (this.isBlocked(t)) return false;
      if (!t.dependencies.every((depId) => this.dependencyMet(depId))) return false;
      return true;
    });

    const excluded = this.store.allTasks.filter(t => t.type === 'ai' && t.prompt && !candidates.includes(t));
    if (excluded.length > 0) {
      for (const t of excluded) {
        const reasons: string[] = [];
        if (t.status !== 'pending' && t.status !== 'approved') reasons.push(`status=${t.status}`);
        if (this.onHold.has(t.id)) reasons.push('on-hold');
        if (this.isBlocked(t)) reasons.push('blocked');
        if (!t.dependencies.every((depId) => this.dependencyMet(depId))) reasons.push('deps');
        console.log(`[TaskOrchestrator] excluded: #${t.order} "${t.title}" — ${reasons.join(', ')}`);
      }
    }

    console.log(`[TaskOrchestrator] getReadyTasks: ${candidates.length} candidates, ${availableSlots} slots, maxParallel=${maxParallel}`);
    return candidates.sort((a, b) => a.order - b.order).slice(0, availableSlots);
  }

  /**
   * In an isolated run a dependency is met once its work is on the integration
   * branch, not merely once it passed: the dependent's worktree is cut from
   * that branch, so starting earlier would hand it a tree without the work it
   * depends on.
   */
  private dependencyMet(depId: string): boolean {
    if (!this.store.isCompleted(depId)) return false;
    const record = this.runMode === 'isolated' ? this.isolationRun?.tasks[depId] : undefined;
    return !record || record.status === 'merged';
  }

  isBlocked(task: Task): boolean {
    if (task.status === 'blocked') return true;
    if (task.dependencies.length > 0) return task.dependencies.some((depId) => this.store.isFailed(depId));
    return false;
  }

  /**
   * Cancel a running (or scheduled) task: kill its session and return it to
   * 'pending' — "not executed". The task is put on hold so the scheduler
   * doesn't immediately restart it; Retry / Force Start release the hold.
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    const ended = this.endAttempt(taskId, 'cancel');
    this.store.markPending(taskId);
    this.onHold.add(taskId);
    this.emit('onTaskChanged');
    await this.releaseWorktree(taskId, { keep: false }, ended?.integration);
    await this.tick();
  }

  /**
   * Let go of a task that is leaving the plan. A live runner is cancelled
   * through {@link cancelTask}; a spawn still in flight just loses its attempt,
   * which is what makes {@link startTask} kill the session it is about to
   * receive. The id's cross-attempt bookkeeping goes too — a hold or retry
   * count kept for a task that no longer exists would be inherited by nothing.
   */
  async releaseTask(taskId: string): Promise<void> {
    const phase = this.attempts.get(taskId)?.phase;
    if (phase === 'running' || phase === 'integrating') await this.cancelTask(taskId);
    else {
      this.endAttempt(taskId, 'release');
      await this.releaseWorktree(taskId, { keep: false });
    }
    this.onHold.delete(taskId);
    this.retryCounts.delete(taskId);
    this.spawnCounts.delete(taskId);
  }

  async markTaskComplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed') return;

    const ended = this.endAttempt(taskId, 'complete');
    const verdict = this.verifier.markComplete(task);
    // The user vouches for the work, so it lands the way a passed verdict's
    // would — including a merge a passed verdict already has in flight.
    const merging = ended?.integration ?? (this.hasUnlandedWork(taskId) ? this.integrateWork(task) : null);
    const landing = merging ? await merging : 'merged';

    if (landing === 'merged') this.store.markCompleted(taskId);
    else this.landUnmerged(task, landing);
    this.store.setTaskVerdict(taskId, verdict);
    this.store.setTaskOutputSummary(taskId, summarizeOutput(verdict.reason, ''));
    this.logAndArchive(task, verdict);
    if (landing === 'merged') {
      this.store.unblockDependents(taskId);
      this.onHold.delete(taskId);
      this.notifications.info(`Task "${task.title}" marked complete.`);
      await this.landResolved(taskId);
    }

    this.emit('onTaskChanged');
    await this.tick();
  }

  async markAiTaskComplete(taskId: string): Promise<void> {
    return this.markTaskComplete(taskId);
  }

  /**
   * Undo a completion: return the task to "not executed" — pending, verdict and
   * summary dropped, archive entry removed. It is put on hold like a cancel, so
   * a running plan does not immediately re-spawn the work the user just
   * un-marked; Retry / Force Start / Run release the hold. Dependents fall back
   * to waiting on their own, because the scheduler gates on `isCompleted`.
   */
  async markTaskIncomplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status !== 'completed') return;

    this.verifier.clear(task);
    this.store.retry(taskId);
    this.store.removeFromLog(taskId);
    this.onHold.add(taskId);
    // A finished plan is no longer finished — leaving 'completed' would tell
    // every surface the run is over while a task sits pending.
    if (this.planStatus === 'completed') this.planStatus = 'approved';

    this.notifications.info(`Task "${task.title}" marked not done.`);
    this.emit('onTaskChanged');
    await this.tick();
  }

  private logAndArchive(task: Task, verdict: Verdict): void {
    const snapshot: TaskSnapshot = {
      ...task,
      completedAt: Date.now(),
      verdict,
      retryCount: this.retryCounts.get(task.id) ?? 0,
      finalized: true,
    };
    this.store.appendToLog(snapshot);
    // Completed tasks remain in the active plan tree so the UI can keep
    // showing them alongside pending and running work.
  }

  async retryTask(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
    const ended = this.endAttempt(taskId, 'retry');
    this.store.retry(taskId);
    this.store.unblockDependents(taskId);
    this.onHold.delete(taskId);
    this.emit('onTaskChanged');
    // A retry starts over from the integration tip, which by now holds what its
    // predecessors landed; the old attempt's worktree has nothing to offer it.
    await this.releaseWorktree(taskId, { keep: false }, ended?.integration);
    await this.tick();
  }

  /**
   * Manually start a single AI task right now, bypassing dependency/readiness
   * gating (the "force start" affordance on a task card). Reuses the scheduler's
   * own startTask so a force-started task gets the same augmented prompt, session
   * tracking, and exit handling — callers must not re-spawn the runner themselves.
   * No-op if the task is unknown, not an AI task, or already running.
   */
  async forceStartTask(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.type !== 'ai') return;
    if (this.attempts.has(taskId)) return;
    if (!(await this.openRun(() => this.forceStartTask(taskId)))) return;
    this.onHold.delete(taskId);
    await this.startTask(task);
  }

  /**
   * Run exactly one task outside full-plan scheduling. The active/starting
   * session still contributes to isRunning so every surface exposes Stop and
   * disables Execute Plan, but onVerdict cannot auto-schedule other tasks
   * because the plan scheduler's `running` flag remains false.
   */
  async runTask(taskId: string): Promise<void> {
    if (this.isRunning) return;
    const task = this.store.get(taskId);
    if (!task || task.type !== 'ai') return;
    if (!(await this.openRun(() => this.runTask(taskId)))) return;
    this.onHold.delete(taskId);
    await this.startTask(task);
  }

  getCompletedCount(): number { return this.store.completedCount; }
  getTotalCount(): number { return this.store.allTasks.length; }
  isAllComplete(): boolean { return this.store.isAllComplete(); }
  isAnyFailed(): boolean { return this.store.isAnyFailed(); }

  async approveReview(): Promise<void> {
    if (this.reviewApproved) {
      console.log('[TaskOrchestrator] approveReview() called but already approved — no-op');
      return;
    }
    this.reviewApproved = true;
    this.planStatus = 'approved';
    this.emit('onTaskChanged');
    this.emit('onReviewApproved', { tasks: this.store.planTasks });
    await this.start();
  }

  getPlanVisualization() { return this.store.getPlanVisualization(); }

  async tick(): Promise<void> {
    if (!this.running) {
      // A run the scheduler is not driving — a manual task run, or a halted
      // plan's remaining attempts — is closed by a verdict only. Ended by
      // cancel, Mark complete or a failed spawn instead, it would stay open, and
      // the next run would inherit its mode rather than decide its own.
      if (this.attempts.size === 0 && this.runMode) await this.closeRun();
      return;
    }

    if (this.messageQueue.length > 0) {
      if (this.attempts.size === 0) {
        this.emit('onQueueReady');
      }
      return;
    }

    const ready = this.getReadyTasks();
    console.log(`[TaskOrchestrator] tick(): ${ready.length} ready, ${this.attempts.size} active, queue=${this.messageQueue.length}`);

    if (ready.length === 0 && this.attempts.size === 0) {
      const remaining = this.store.allTasks.filter(t => t.status !== 'completed');
      console.log(`[TaskOrchestrator] tick(): no work. remaining=${remaining.length}, completed=${this.store.isAllComplete()}`);
      const remainingById = new Map(remaining.map((t) => [t.id, t]));
      for (const { task, parent } of flattenTasksWithParents(this.store.planTasks)) {
        if (!remainingById.has(task.id)) continue;
        console.log(`  - ${taskOrderLabel(task, parent ?? undefined)}. ${task.title} [${task.type}/${task.status}] prompt=${!!task.prompt}`);
      }
      if (this.store.isAllComplete()) {
        // Genuinely done — stop the loop so a fresh Execute click can start it again.
        this.running = false;
        this.planStatus = 'completed';
        this.notifications.info('All tasks completed!');
        this.emit('onTaskChanged');
        this.emit('onTick');
        await this.closeRun();
        this.emit('onExecutionComplete');
      } else {
        // Not done — just waiting on a user task, checkpoint, or held task.
        // Keep `running` true: markTaskComplete/retryTask/forceStartTask/cancelTask
        // all re-tick() afterward, and that only ever schedules new work while
        // `running` is true. Flipping it false here would silently kill the
        // scheduler and leave dependents unblocked-but-never-started.
        // Do NOT emit onExecutionComplete here: a paused run is not a finished
        // one, and every surface treats that signal as terminal (the TUI closes
        // its execution stream on receipt, so a later fan-out from completing the
        // user task would arrive to a closed socket and be invisible).
        this.notifications.info('Remaining tasks require user action or are on hold.');
        this.emit('onTaskChanged');
        this.emit('onTick');
      }
      return;
    }

    for (const task of ready) await this.startTask(task);
    this.emit('onTick');
  }

  private async startTask(task: Task): Promise<void> {
    if (this.attempts.has(task.id)) return;
    const attempt: TaskAttempt = {
      taskId: task.id,
      attempt: (this.spawnCounts.get(task.id) ?? 0) + 1,
      phase: 'starting',
      session: null,
      runner: this.store.resolveTaskRunner(task),
      cwd: null,
      worktree: false,
      integration: null,
      startedAt: new Date().toISOString(),
    };
    this.spawnCounts.set(task.id, attempt.attempt);
    this.attempts.set(task.id, attempt);
    this.store.markInProgress(task.id);
    this.emit('onTaskChanged');
    try {
      const cwd = await this.resolveAttemptCwd(task, attempt);
      attempt.cwd = cwd;
      if (this.attempts.get(task.id) !== attempt) {
        // Ended while its worktree was being made, so whatever ended it could
        // not release it. A newer attempt's own prepare replaces it instead.
        if (attempt.worktree && !this.attempts.has(task.id)) await this.releaseWorktree(task.id, { keep: false });
        return this.abandonSpawn(task);
      }
      const finalPrompt = composeAugmentedPrompt(task, this.store.planTasks, {
        planMapEnabled: this.config.planMapEnabled,
        tddEnabled: this.tddEnabled(),
      });
      const session = await this.terminalRunner.spawn({
        taskId: task.id,
        runner: attempt.runner,
        prompt: finalPrompt,
        modelId: task.assignedModel?.modelId,
        thinkingEffort: task.assignedModel?.thinkingEffort,
        modelVariants: task.assignedModel?.availableVariants,
        mode: task.taskMode ?? 'build',
        cwd,
        registry: this.registry ?? undefined,
        order: task.order,
        title: task.title,
      });

      // Stop/load/cancel can end the attempt while the async adapter is
      // starting. Do not resurrect that execution after the surface already
      // went idle — and compare identity, not presence, because a newer
      // attempt of the same task may have been claimed in the meantime.
      if (this.attempts.get(task.id) !== attempt) return this.abandonSpawn(task, session);
      attempt.phase = 'running';
      attempt.session = session;

      // Attached before the verifier so the chunk that carries the marker is
      // captured before that chunk's verdict asks for the final text.
      this.output.attach(task.id, session);
      this.verifier.watch(task, session);

      this.emit('onTaskChanged');
      this.notifications.info(`Task "${task.title}" started (${attempt.runner})`);
    } catch (err) {
      if (this.attempts.get(task.id) !== attempt) return this.abandonSpawn(task);
      this.endAttempt(task.id, 'spawn-failed');
      await this.releaseWorktree(task.id, { keep: false });
      // Couldn't spawn — the task was never executed, so it stays "to do".
      // Held out of auto-scheduling to avoid a spawn-throw retry loop.
      this.store.markPending(task.id);
      this.onHold.add(task.id);
      this.notifications.error(`Failed to start task "${task.title}": ${err}`);
      this.emit('onTaskChanged');
      await this.tick();
    }
  }

  /**
   * A spawn whose attempt ended while it was in flight: kill what it produced
   * and take back the claim it made. Only the claim — whatever ended the
   * attempt may have decided the task since (mark complete, cancel, retry).
   */
  private abandonSpawn(task: Task, session?: ITerminalSession): void {
    session?.kill();
    if (this.attempts.has(task.id) || this.store.get(task.id)?.status !== 'in_progress') return;
    this.store.markPending(task.id);
    this.emit('onTaskChanged');
  }

  /**
   * The one place an attempt's working directory is decided. Async so a
   * per-attempt workspace (worktree isolation, #12) can be prepared here.
   */
  private async resolveAttemptCwd(task: Task, attempt: TaskAttempt): Promise<string> {
    if (this.runMode !== 'isolated' || !this.isolationRun) {
      // A worktree left by an earlier attempt describes work this attempt
      // replaces; left alone it could later be integrated as if it were this one's.
      await this.releaseWorktree(task.id, { keep: false });
      return this.workspaceRootFn();
    }
    const { cwd, copied } = await this.isolation.prepare(task, this.isolationRun);
    attempt.worktree = true;
    this.emit('onIsolationChanged');
    this.reportCopies(copied);
    return cwd;
  }

  private tell(level: 'info' | 'warn', message: string): void {
    this.notifications[level](message);
    this.emit('onIsolationNotice', { level, message });
  }

  private reportCopies(copied: string[]): void {
    const fresh = copied.filter((p) => !this.reportedCopies.has(p));
    if (fresh.length === 0) return;
    for (const p of fresh) this.reportedCopies.add(p);
    const one = fresh.length === 1;
    this.tell(
      'warn',
      `${fresh.join(', ')} could not be linked into task workspaces (a hard link is impossible there), so each task gets ${one ? 'a copy' : 'copies'}: edits to ${one ? 'it' : 'them'} stay in the task.`,
    );
  }

  /**
   * Open a run if none is: decide once, at its start, whether it executes in
   * worktrees. `resume` is what a dirty tree parks until the user chooses how
   * to go on. Resolves false when the run did not start.
   */
  private openRun(resume: () => Promise<void>): Promise<boolean> {
    if (this.runMode) return Promise.resolve(true);
    this.opening ??= this.activate(resume).finally(() => { this.opening = null; });
    return this.opening;
  }

  /**
   * Whether the run in force, or else the next one, gives each task its own
   * worktrees, and of which repo group — what the planner is told, since it
   * decides whether tasks on the same file have to be ordered and which shared
   * paths two tasks must not edit at once. A tree that would block counts as
   * not isolating: the user may yet run without isolation, and ordering is
   * the safe rule then.
   */
  async plannerIsolation(): Promise<IsolatedExecution> {
    if (this.runMode) return this.runMode === 'isolated' && this.isolationRun ? layoutOf(this.isolationRun) : false;
    const decision = await this.decideRun(this.workspaceRootFn());
    return decision.mode === 'isolated' ? decision.layout : false;
  }

  private async decideRun(root: string): Promise<RunDecision> {
    const availability = await this.isolation.isActive(root);
    const continued = this.continuableRun(root);
    const continuing = continued !== null;
    // A continued run keeps the group it started with.
    if (availability.active) {
      const layout = continued ? layoutOf(continued) : { repos: availability.repos ?? [SELF_REPO], shared: availability.shared ?? [] };
      return { mode: 'isolated', continuing, layout };
    }
    // A continued run's base is already fixed, so edits the user has made in
    // their own tree since cannot change what its tasks start from.
    if (availability.reason === 'dirty') {
      return continued ? { mode: 'isolated', continuing, layout: layoutOf(continued) } : { mode: 'blocked', repos: availability.repos ?? [] };
    }
    return { mode: 'shared', reason: availability.reason, repos: availability.repos ?? [] };
  }

  private async activate(resume: () => Promise<void>): Promise<boolean> {
    const root = this.workspaceRootFn();
    const decision = await this.decideRun(root);
    if (decision.mode === 'blocked') {
      this.blockedStart = resume;
      this.blockedRepos = decision.repos;
      this.emit('onIsolationBlocked', { reason: 'dirty', repos: decision.repos });
      return false;
    }
    if (decision.mode === 'shared') {
      this.tell('info', sharedRootNotice(decision.reason, decision.repos));
      this.runMode = 'shared';
      return true;
    }
    if (!decision.continuing) {
      try {
        await this.mintRun(root);
      } catch (err) {
        // Git can still refuse every repo of the group once a run is minted — the one check `isActive` cannot make.
        this.tell('info', `${err instanceof Error ? err.message : String(err)} — ${SHARED_ROOT_TAIL}`);
        this.emit('onIsolationChanged');
        this.runMode = 'shared';
        return true;
      }
    }
    this.runMode = 'isolated';
    return true;
  }

  /**
   * The plan's run carries on while anything has landed on its integration
   * branch: a resumed plan's dependents must start from a tip that holds their
   * predecessors' work, and a fresh branch from the checked-out commit does not.
   */
  private continuableRun(root: string): IsolationRun | null {
    const run = this.isolationRun;
    return run && run.workspaceRoot === root && Object.values(run.tasks).some((r) => r.status === 'merged') ? run : null;
  }

  /**
   * A run with nothing landed holds only superseded attempts, so it goes whole.
   * One that cannot be continued for another reason — it ran from a different
   * workspace path — keeps its integration branch: only the user gives landed
   * work up.
   */
  private async mintRun(root: string): Promise<void> {
    const previous = this.isolationRun;
    if (previous) {
      const landed = Object.values(previous.tasks).some((r) => r.status === 'merged');
      await this.isolation.discard(previous, { keepIntegration: landed }).catch(() => undefined);
      this.isolationRun = null;
    }
    this.isolationRun = await this.isolation.startRun(root);
    this.resolvers = {};
    this.reportedCopies.clear();
    this.emit('onIsolationChanged');
    const shared = sharedPathsNotice(this.isolationRun);
    if (shared) this.tell('info', shared);
  }

  /** Close the open run. An isolated one hands its integration branch over for review. */
  private async closeRun(): Promise<void> {
    const mode = this.runMode;
    this.runMode = null;
    if (mode !== 'isolated' || !this.isolationRun) return;
    try {
      this.emit('onIsolationHandoff', await this.isolation.handoff(this.isolationRun));
    } catch (err) {
      this.tell('warn', `Could not hand the run's integration branch over: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.emit('onIsolationChanged');
  }

  /**
   * Replay the start a dirty tree turned away. `stash` puts the user's tracked
   * changes on the git stash first, so the run isolates; `shared` runs this one
   * run in the workspace root, knowingly.
   */
  async continueBlockedRun(how: 'stash' | 'shared'): Promise<void> {
    const resume = this.blockedStart;
    if (!resume) return;
    this.blockedStart = null;
    if (how === 'stash') {
      await this.isolation.stash(this.workspaceRootFn());
      this.tell('info', this.blockedRepos.length > 0
        ? `Stashed your uncommitted changes in ${this.blockedRepos.join(', ')} — \`git stash pop\` in each brings them back.`
        : 'Stashed your uncommitted changes — `git stash pop` brings them back.');
    } else {
      this.runMode = 'shared';
      this.tell('info', 'Running without worktree isolation — tasks share the workspace root for this run.');
    }
    await resume();
  }

  /**
   * The one way an attempt ends. Dropping the record is itself what
   * invalidates a spawn still in flight ({@link startTask} kills the session
   * it receives for an attempt that is no longer current).
   *
   * A user interruption also bumps the verifier's generation *before* stopping
   * the runner: some runners (e.g. tmux) fire onExit synchronously from
   * stop(), and if that exit reaches VerdictEngine under the still-valid
   * generation it delivers a verdict that marks the task 'completed' for one
   * tick — long enough for the scheduler to start a dependent task. A verdict
   * leaves the runner up so its terminal stays readable, and stop/load reset
   * the whole verifier themselves.
   */
  private endAttempt(taskId: string, reason: AttemptEnd): TaskAttempt | undefined {
    const attempt = this.attempts.get(taskId);
    this.attempts.delete(taskId);
    if (attempt) this.output.detach(taskId);
    if (reason === 'cancel' || reason === 'release' || reason === 'complete' || reason === 'retry') {
      const task = this.store.get(taskId);
      if (task) this.verifier.clear(task);
      if (attempt?.session) this.terminalRunner.stop(attempt.session.id);
    }
    return attempt;
  }

  private endAllAttempts(reason: 'stop' | 'load'): void {
    for (const taskId of [...this.attempts.keys()]) this.endAttempt(taskId, reason);
    this.verifier.reset();
    if (reason === 'load') this.output.reset();
  }
}

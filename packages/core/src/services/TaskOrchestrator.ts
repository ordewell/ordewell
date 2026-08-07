import { Task, TaskSnapshot, Verdict, QueuedMessage, RunnerId } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { INotification } from '../interfaces/INotification';
import { ITerminalRunner } from '../interfaces/ITerminalRunner';
import { composeAugmentedPrompt, summarizeOutput } from './promptAugment';
import { VerdictEngine } from './VerdictEngine';
import { PlanStore } from './PlanStore';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';

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
}

/**
 * The pure scheduler. Owns execution state (`running`, `planStatus`,
 * `reviewApproved`, `activeTaskSessions`, `messageQueue`) and the verifier.
 * All task-shaped state — the plan tree, the flat index, the completed set
 * — lives in {@link PlanStore}, injected at construction. The orchestrator
 * calls `store.markCompleted(id)` / `store.markFailed(id)` instead of mutating
 * task state directly. A task completes only after the runner emits its
 * per-task completion marker; process exit without that evidence is a visible
 * failure and does not unblock dependent work.
 */
export class TaskOrchestrator {
  private store: PlanStore;
  private activeTaskSessions = new Map<string, string>();
  private startingTaskIds = new Set<string>();
  private verifier = new VerdictEngine();
  private running = false;
  private planStatus: 'approved' | 'running' | 'completed' = 'approved';
  private messageQueue: QueuedMessage[] = [];
  private reviewApproved = false;
  private retryCounts = new Map<string, number>();
  /**
   * Tasks pulled out of auto-scheduling (user-cancelled or failed to spawn).
   * They stay 'pending' — "not executed" — but the scheduler skips them until
   * the user retries or force-starts, which would otherwise loop forever on a
   * task whose spawn always throws.
   */
  private onHold = new Set<string>();

  private registry: RunnerRegistry | null = null;
  private workspaceRootFn: () => string = () => process.cwd();
  private observers: OrchestratorObserver[] = [];
  private tddEnabled: () => boolean = () => false;

  constructor(
    private config: IConfig,
    private notifications: INotification,
    private terminalRunner: ITerminalRunner,
    store?: PlanStore,
  ) {
    this.store = store ?? new PlanStore();
    this.store.onMutate = () => this.emit('onTaskChanged');
    this.verifier.onVerdict((taskId, verdict, output) => this.onVerdict(taskId, verdict, output));
    this.verifier.onCheckpoint((taskId, summary) => {
      const task = this.store.get(taskId);
      if (!task) return;
      this.store.markAwaitingUser(taskId);
      this.emit('onCheckpoint', { taskId, taskTitle: task.title, summary });
    });
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

  approveCheckpoint(taskId: string): void {
    this.verifier.approveCheckpoint(taskId);
    this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
  }

  rejectCheckpoint(taskId: string, reason?: string): void {
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
    return this.running || this.startingTaskIds.size > 0 || this.activeTaskSessions.size > 0;
  }
  /**
   * A runner is executing *right now*. Narrower than {@link isRunning}, which
   * also covers the armed-but-idle scheduler `tick()` deliberately leaves
   * behind when a plan is paused on a user task, a checkpoint or a hold —
   * nothing is executing then, so nothing is reading the plan mid-mutation.
   */
  get hasLiveWork(): boolean {
    return this.activeTaskSessions.size > 0 || this.startingTaskIds.size > 0;
  }
  get isReviewApproved(): boolean { return this.reviewApproved; }
  get status(): 'approved' | 'running' | 'completed' { return this.planStatus; }
  get activeTaskIds(): string[] { return [...this.activeTaskSessions.keys()]; }
  get activeSessionMap(): Map<string, string> { return new Map(this.activeTaskSessions); }
  get queuedCount(): number { return this.messageQueue.length; }

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
    this.activeTaskSessions.clear();
    this.startingTaskIds.clear();
    this.verifier.reset();
    this.planStatus = 'approved';
    this.reviewApproved = false;
    this.retryCounts.clear();
    this.onHold.clear();
  }

  reconcilePlan(newTasks: Task[], planRunners: RunnerId[] = ['claude-code']): void {
    for (const taskId of this.activeTaskSessions.keys()) {
      const task = this.store.get(taskId);
      if (!task) continue;

      const inNewPlan = newTasks.find((t) => t.id === taskId);
      if (!inNewPlan) {
        newTasks.push({ ...task });
      } else if (inNewPlan.status !== 'in_progress') {
        console.warn(`[TaskOrchestrator] Running task "${task.title}" status changed to "${inNewPlan.status}" in modified plan, using orchestrator truth`);
      }
    }

    this.store.load(newTasks, planRunners);
    this.planStatus = 'running';
  }

  async start(): Promise<void> {
    if (this.running) {
      console.error('[TaskOrchestrator] start() called but already running — no-op');
      return;
    }
    if (!this.reviewApproved) {
      console.log('[TaskOrchestrator] start() blocked — plan review not yet approved. Emitting onReviewNeeded.');
      this.emit('onReviewNeeded', { tasks: this.store.planTasks, planRunners: this.store.planRunners });
      return;
    }
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
    this.activeTaskSessions.clear();
    this.startingTaskIds.clear();
    this.verifier.reset();
    this.onHold.clear();
    this.emit('onTaskChanged');
  }

  async onUserTaskComplete(taskId: string): Promise<void> {
    return this.markTaskComplete(taskId);
  }

  private async onVerdict(taskId: string, verdict: Verdict, output: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    this.activeTaskSessions.delete(taskId);

    console.error(`[TaskOrchestrator] Task #${task.order} "${task.title}" verdict=${verdict.outcome}`);
    console.error(`[TaskOrchestrator] Runner: ${task.assignedRunner}, Model: ${task.assignedModel?.modelId ?? 'default'}`);
    console.error(`[TaskOrchestrator] Prompt preview: ${(task.prompt ?? '').slice(0, 200)}`);
    if (output && output.length > 0) {
      console.error(`[TaskOrchestrator] Output (last 3000 chars):\n${output.slice(-3000)}`);
    } else {
      console.error(`[TaskOrchestrator] Output: (empty — no stdout/stderr captured)`);
    }

    this.store.setTaskVerdict(taskId, verdict);

    if (verdict.outcome === 'pass') {
      this.store.markCompleted(taskId);
      this.notifications.info(`Task "${task.title}" completed.`);
    } else {
      this.store.markFailed(taskId);
      // Missing completion evidence is a hard boundary: do not launch more
      // work from a full-plan run until the user retries/resumes explicitly.
      // Already-active parallel tasks may finish, but no new task is spawned.
      this.running = false;
      this.planStatus = 'approved';
      this.notifications.error(`Task "${task.title}" failed verification: ${verdict.reason}`);
    }

    this.store.setTaskOutputSummary(taskId, summarizeOutput(verdict.reason, output));

    this.logAndArchive(task, verdict);

    this.emit('onTaskChanged');
    if (!this.running) {
      if (this.activeTaskSessions.size === 0 && this.startingTaskIds.size === 0) {
        if (this.store.isAllComplete()) this.planStatus = 'completed';
        this.emit('onTick');
        this.emit('onExecutionComplete');
      }
      return;
    }
    await this.tick();
  }

  getReadyTasks(): Task[] {
    if (!this.running) return [];
    const maxParallel = this.config.maxParallelSessions;
    const currentActive = this.activeTaskSessions.size;
    if (currentActive >= maxParallel) return [];
    const availableSlots = maxParallel - currentActive;

    const candidates = this.store.allTasks.filter((t) => {
      if (t.status !== 'pending' && t.status !== 'approved') return false;
      if (t.type === 'user') return false;
      if (!t.prompt) return false;
      if (this.onHold.has(t.id)) return false;
      if (this.isBlocked(t)) return false;
      if (t.dependencies.length > 0 && !t.dependencies.every((depId) => this.store.isCompleted(depId))) return false;
      return true;
    });

    const excluded = this.store.allTasks.filter(t => t.type === 'ai' && t.prompt && !candidates.includes(t));
    if (excluded.length > 0) {
      for (const t of excluded) {
        const reasons: string[] = [];
        if (t.status !== 'pending' && t.status !== 'approved') reasons.push(`status=${t.status}`);
        if (this.onHold.has(t.id)) reasons.push('on-hold');
        if (this.isBlocked(t)) reasons.push('blocked');
        if (t.dependencies.length > 0 && !t.dependencies.every((depId) => this.store.isCompleted(depId))) reasons.push('deps');
        console.log(`[TaskOrchestrator] excluded: #${t.order} "${t.title}" — ${reasons.join(', ')}`);
      }
    }

    console.log(`[TaskOrchestrator] getReadyTasks: ${candidates.length} candidates, ${availableSlots} slots, maxParallel=${maxParallel}`);
    return candidates.sort((a, b) => a.order - b.order).slice(0, availableSlots);
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
    // Bump the verifier's generation *before* stopping the runner: some
    // runners (e.g. tmux) fire onExit synchronously from stop(), and if that
    // exit reaches VerdictEngine under the still-valid generation it delivers
    // a verdict that marks this cancelled task 'completed' for one tick —
    // long enough for the scheduler to synchronously start a dependent task.
    this.verifier.clear(task);
    const sessionId = this.activeTaskSessions.get(taskId);
    if (sessionId) {
      this.terminalRunner.stop(sessionId);
      this.activeTaskSessions.delete(taskId);
    }
    this.store.markPending(taskId);
    this.onHold.add(taskId);
    this.emit('onTaskChanged');
    await this.tick();
  }

  async markTaskComplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed') return;

    const sessionId = this.activeTaskSessions.get(taskId);
    if (sessionId) {
      this.terminalRunner.stop(sessionId);
      this.activeTaskSessions.delete(taskId);
    }

    this.verifier.clear(task);
    const verdict = this.verifier.markComplete(task);

    this.store.markCompleted(taskId);
    this.store.setTaskVerdict(taskId, verdict);
    this.store.setTaskOutputSummary(taskId, summarizeOutput(verdict.reason, ''));
    this.logAndArchive(task, verdict);
    this.store.unblockDependents(taskId);
    this.onHold.delete(taskId);

    this.notifications.info(`Task "${task.title}" marked complete.`);
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
    this.store.retry(taskId);
    this.verifier.clear(task);
    this.store.unblockDependents(taskId);
    this.onHold.delete(taskId);
    this.emit('onTaskChanged');
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
    if (this.activeTaskSessions.has(taskId)) return;
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
    if (!this.running) return;

    if (this.messageQueue.length > 0) {
      if (this.activeTaskSessions.size === 0) {
        this.emit('onQueueReady');
      }
      return;
    }

    const ready = this.getReadyTasks();
    console.log(`[TaskOrchestrator] tick(): ${ready.length} ready, ${this.activeTaskSessions.size} active, queue=${this.messageQueue.length}`);

    if (ready.length === 0 && this.activeTaskSessions.size === 0) {
      const remaining = this.store.allTasks.filter(t => t.status !== 'completed');
      console.log(`[TaskOrchestrator] tick(): no work. remaining=${remaining.length}, completed=${this.store.isAllComplete()}`);
      for (const t of remaining) {
        console.log(`  - ${t.order}. ${t.title} [${t.type}/${t.status}] prompt=${!!t.prompt}`);
      }
      if (this.store.isAllComplete()) {
        // Genuinely done — stop the loop so a fresh Execute click can start it again.
        this.running = false;
        this.planStatus = 'completed';
        this.notifications.info('All tasks completed!');
        this.emit('onTaskChanged');
        this.emit('onTick');
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
    if (this.activeTaskSessions.has(task.id) || this.startingTaskIds.has(task.id)) return;
    this.startingTaskIds.add(task.id);
    this.store.markInProgress(task.id);
    this.emit('onTaskChanged');
    try {
      const cwd = this.workspaceRootFn();
      const runner = this.store.resolveTaskRunner(task);
      const finalPrompt = composeAugmentedPrompt(task, this.store.allTasks, {
        planMapEnabled: this.config.planMapEnabled,
        tddEnabled: this.tddEnabled(),
      });
      const session = await this.terminalRunner.spawn({
        taskId: task.id,
        runner,
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

      // Stop/load can invalidate a spawn while the async adapter is starting.
      // Do not resurrect that execution after the surface already went idle.
      if (!this.startingTaskIds.delete(task.id)) {
        session.kill();
        this.store.markPending(task.id);
        this.emit('onTaskChanged');
        return;
      }
      this.activeTaskSessions.set(task.id, session.id);

      this.verifier.watch(task, session);

      this.emit('onTaskChanged');
      this.notifications.info(`Task "${task.title}" started (${runner})`);
    } catch (err) {
      this.startingTaskIds.delete(task.id);
      // Couldn't spawn — the task was never executed, so it stays "to do".
      // Held out of auto-scheduling to avoid a spawn-throw retry loop.
      this.store.markPending(task.id);
      this.onHold.add(task.id);
      this.notifications.error(`Failed to start task "${task.title}": ${err}`);
      this.emit('onTaskChanged');
      await this.tick();
    }
  }
}

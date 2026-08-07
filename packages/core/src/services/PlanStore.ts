import {
  Task, TaskSnapshot, RunnerId, flattenTasks,
  addTaskToPlan, removeTaskFromPlan, updateTaskInPlan,
  createTask, renumberTasks,
} from '../models/Task';

/**
 * The deep module owning all plan-shaped state. Holds `planTasks` (the ordered
 * tree the user edits), the flattened `allTasks` view, the `taskMap` index, and
 * the `completedTasks`/`failedTasks` sets the scheduler reads. The orchestrator
 * calls `markCompleted`/`markFailed`/`markInProgress`/`retry` to update task
 * status — it never mutates task state directly.
 *
 * `rebuild` is the internal seam that keeps the flat views in sync with the
 * tree. Structural removals (remove/merge/split) additionally prune
 * `completedTasks`/`failedTasks` for ids that no longer exist; `removeFromActive`
 * deliberately does not, so a completed task that leaves the active list still
 * satisfies its dependents' dependency checks.
 *
 * `planRunners` lives here because it's part of the plan's identity (the runner
 * set, carried on the plan). `validateAssignedRunners` is pure store logic.
 */
export class PlanStore {
  private _planTasks: Task[] = [];
  private _allTasks: Task[] = [];
  private _taskMap = new Map<string, Task>();
  private _completedTasks = new Set<string>();
  private _failedTasks = new Set<string>();
  private _planRunners: RunnerId[] = ['claude-code'];
  private _onMutate: (() => void) | null = null;
  private _executionLog: TaskSnapshot[] = [];

  /** Hook called after every structural mutation (add/remove/update/merge/split/load). */
  set onMutate(cb: (() => void) | null) { this._onMutate = cb; }

  get planTasks(): Task[] { return this._planTasks; }
  get allTasks(): Task[] { return this._allTasks; }
  get planRunners(): RunnerId[] { return this._planRunners; }
  get completedCount(): number { return this._completedTasks.size; }
  get failedCount(): number { return this._failedTasks.size; }

  isAllComplete(): boolean { return this._allTasks.every((t) => t.status === 'completed'); }
  isAnyFailed(): boolean { return this._failedTasks.size > 0; }
  isCompleted(id: string): boolean { return this._completedTasks.has(id); }
  isFailed(id: string): boolean { return this._failedTasks.has(id); }

  get(taskId: string): Task | undefined { return this._taskMap.get(taskId); }

  getExecutionLog(): TaskSnapshot[] { return this._executionLog; }

  appendToLog(snapshot: TaskSnapshot): void {
    const idx = this._executionLog.findIndex((s) => s.id === snapshot.id);
    if (idx >= 0) {
      this._executionLog[idx] = snapshot;
    } else {
      this._executionLog.push(snapshot);
    }
  }

  /**
   * Drop a task's archived snapshot. Un-marking a completion has to erase the
   * "finished" record too — dependent tasks are prompted from the log, so a
   * left-behind snapshot would keep feeding them a result that no longer exists.
   */
  removeFromLog(taskId: string): void {
    this._executionLog = this._executionLog.filter((s) => s.id !== taskId);
  }

  removeFromActive(taskId: string): void {
    this._planTasks = this._planTasks.filter((t) => t.id !== taskId);
    this.rebuild();
    this.notifyMutate();
  }

  clearLog(): void {
    this._executionLog = [];
  }

  private notifyMutate(): void { this._onMutate?.(); }

  load(tasks: Task[], runners: RunnerId[]): void {
    this._planTasks = tasks;
    this._planRunners = runners;
    this._completedTasks.clear();
    this._failedTasks.clear();
    this.rebuild();
    // Completed tasks survive a reload so a half-finished plan resumes the
    // remainder (their output summaries still feed dependents). Failed tasks
    // get a fresh chance. In-progress is left alone — load() also runs while
    // a task's terminal session is live (forceStartTask); orphaned in_progress
    // from a saved session is normalized at the disk-load boundary instead.
    for (const task of this._allTasks) {
      if (task.status === 'completed') {
        this._completedTasks.add(task.id);
      } else if (task.status === 'failed') {
        task.status = 'pending';
      }
    }
    this.validateAssignedRunners();
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
    // `removeTaskFromPlan` detaches the dependency, but a dependent parked at
    // 'blocked' would keep that status with nothing left to release it —
    // `isBlocked` reads the status on its own, so the scheduler would skip the
    // task forever.
    this.unblockDependents(taskId);
    this._planTasks = removeTaskFromPlan(this._planTasks, taskId);
    this.rebuild();
    this.pruneTerminalSets();
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

  mergeMultiple(taskIds: string[]): Task {
    if (taskIds.length < 2) throw new Error('Must provide at least two task IDs to merge');
    const sorted = [...new Set(taskIds)]
      .map(id => ({ id, task: this._taskMap.get(id) }))
      .filter(x => x.task)
      .sort((a, b) => (a.task?.order ?? 0) - (b.task?.order ?? 0));

    if (sorted.length < 2) throw new Error('At least two valid tasks required for merge');

    let current = sorted[0].id;
    for (let i = 1; i < sorted.length; i++) {
      const merged = this.merge(current, sorted[i].id);
      current = merged.id;
    }
    return this._taskMap.get(current)!;
  }

  merge(taskIdA: string, taskIdB: string): Task {
    const taskA = this._taskMap.get(taskIdA);
    const taskB = this._taskMap.get(taskIdB);
    if (!taskA) throw new Error(`Task ${taskIdA} not found`);
    if (!taskB) throw new Error(`Task ${taskIdB} not found`);

    const mergedDeps = [...new Set([...taskA.dependencies, ...taskB.dependencies])]
      .filter(depId => depId !== taskIdA && depId !== taskIdB);

    const mergedStories = [...new Set([...(taskA.userStoriesCovered ?? []), ...(taskB.userStoriesCovered ?? [])])];

    const mergedPrompt = [taskA.prompt, taskB.prompt].filter(Boolean).join('\n\n---\n\n');

    const merged = createTask({
      title: `${taskA.title} + ${taskB.title}`,
      description: `${taskA.description}\n\n${taskB.description}`,
      type: taskA.type === 'user' || taskB.type === 'user' ? 'user' : 'ai',
      dependencies: mergedDeps,
      prompt: mergedPrompt || undefined,
      autonomy: taskA.autonomy ?? taskB.autonomy,
      sliceType: taskA.sliceType ?? taskB.sliceType,
      userStoriesCovered: mergedStories.length > 0 ? mergedStories : undefined,
      assignedRunner: taskA.assignedRunner,
      assignedModel: taskA.assignedModel,
      taskMode: taskA.taskMode,
      order: Math.min(taskA.order, taskB.order),
    });

    const mergedId = merged.id;
    const userIds = new Set([taskIdA, taskIdB]);
    // Deduped: a task that depended on both merged halves would otherwise list
    // the survivor twice.
    const sanitized = this._planTasks
      .filter(t => !userIds.has(t.id))
      .map(t => ({
        ...t,
        dependencies: [...new Set(t.dependencies.map(depId => (userIds.has(depId) ? mergedId : depId)))],
      }));

    this._planTasks = renumberTasks([...sanitized, merged]);
    this.rebuild();
    this.pruneTerminalSets();
    this.notifyMutate();
    return merged;
  }

  split(taskId: string, newTaskSpecs: Partial<Task>[]): Task[] {
    const original = this._taskMap.get(taskId);
    if (!original) throw new Error(`Task ${taskId} not found`);
    if (!newTaskSpecs.length) throw new Error('Must provide at least one new task spec');

    // Part 0 inherits the original's dependencies; every later part chains onto
    // the id of the part actually created before it. Deriving the chain from the
    // specs' own ids left a spec-less caller depending on a placeholder id that
    // matched nothing in the plan.
    const finalized: Task[] = [];
    newTaskSpecs.forEach((spec, i) => {
      finalized.push(createTask({
        ...spec,
        order: original.order + i,
        dependencies: i === 0 ? [...original.dependencies] : [finalized[i - 1].id],
        type: spec.type ?? original.type,
        assignedRunner: spec.assignedRunner ?? original.assignedRunner,
        assignedModel: spec.assignedModel ?? original.assignedModel,
        taskMode: spec.taskMode ?? original.taskMode,
        autonomy: spec.autonomy ?? original.autonomy,
        sliceType: spec.sliceType ?? original.sliceType,
        userStoriesCovered: spec.userStoriesCovered ?? original.userStoriesCovered,
      }));
    });

    const tailId = finalized[finalized.length - 1].id;

    const updatedOthers = this._planTasks
      .filter(t => t.id !== taskId)
      .map(t => ({
        ...t,
        dependencies: t.dependencies.map(depId => depId === taskId ? tailId : depId),
      }));

    this._planTasks = renumberTasks([...updatedOthers, ...finalized]);
    this.rebuild();
    this.pruneTerminalSets();
    this.notifyMutate();
    return finalized;
  }

  /**
   * Run preparation as one named op: flip every AI task to 'approved'. By
   * default completed tasks keep their status so a reloaded half-finished plan
   * resumes the remainder instead of re-running work that already succeeded;
   * `preserveCompleted: false` is for a freshly committed plan, where
   * everything starts over.
   */
  resetForRun(opts: { preserveCompleted?: boolean } = {}): void {
    const preserveCompleted = opts.preserveCompleted ?? true;
    for (const t of this._allTasks) {
      if (t.type !== 'ai') continue;
      if (preserveCompleted && t.status === 'completed') continue;
      t.status = 'approved';
    }
  }

  markCompleted(id: string): void {
    this._failedTasks.delete(id);
    this._completedTasks.add(id);
    const task = this._taskMap.get(id);
    if (task) task.status = 'completed';
  }

  markFailed(id: string): void {
    this._completedTasks.delete(id);
    this._failedTasks.add(id);
    const task = this._taskMap.get(id);
    if (task) task.status = 'failed';
  }

  markInProgress(id: string): void {
    this._completedTasks.delete(id);
    this._failedTasks.delete(id);
    const task = this._taskMap.get(id);
    if (task) task.status = 'in_progress';
  }

  markAwaitingUser(id: string): void {
    const task = this._taskMap.get(id);
    if (task) task.status = 'awaiting_user';
  }

  markPending(id: string): void {
    this._completedTasks.delete(id);
    this._failedTasks.delete(id);
    const task = this._taskMap.get(id);
    if (task) task.status = 'pending';
  }

  retry(id: string): void {
    this._failedTasks.delete(id);
    this._completedTasks.delete(id);
    const task = this._taskMap.get(id);
    if (task) {
      task.status = 'pending';
      task.verdict = undefined;
      task.outputSummary = undefined;
    }
  }

  blockDependents(id: string): void {
    for (const t of this._allTasks) {
      if (t.dependencies.includes(id) && t.status !== 'completed') {
        t.status = 'blocked';
      }
    }
  }

  unblockDependents(id: string): void {
    for (const t of this._allTasks) {
      if (t.status === 'blocked' && t.dependencies.includes(id)) {
        t.status = 'pending';
      }
    }
  }

  setTaskVerdict(id: string, verdict: Task['verdict']): void {
    const task = this._taskMap.get(id);
    if (task) task.verdict = verdict;
  }

  setTaskOutputSummary(id: string, summary: Task['outputSummary']): void {
    const task = this._taskMap.get(id);
    if (task) task.outputSummary = summary;
  }

  getPlanVisualization(): { tasks: { id: string; title: string; dependencies: string[]; parallelGroups: number[][] }[]; parallelGroups: number[][] } {
    const unscheduled = new Set(this._planTasks.map(t => t.id));
    const completed = new Set<string>();
    const parallelGroups: number[][] = [];

    while (unscheduled.size > 0) {
      const batch: string[] = [];
      for (const t of this._planTasks) {
        if (!unscheduled.has(t.id)) continue;
        if (t.dependencies.length > 0 && t.dependencies.some(depId => !completed.has(depId))) continue;
        batch.push(t.id);
      }
      if (batch.length === 0) break;
      for (const id of batch) {
        unscheduled.delete(id);
        completed.add(id);
      }
      parallelGroups.push(batch.map(id => this._taskMap.get(id)?.order ?? 0).sort((a, b) => a - b));
    }

    return {
      tasks: this._planTasks.map(t => ({ id: t.id, title: t.title, dependencies: t.dependencies, parallelGroups: [] })),
      parallelGroups,
    };
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

  resolveTaskRunner(task: Task): RunnerId {
    if (task.assignedRunner && this._planRunners.includes(task.assignedRunner)) return task.assignedRunner;
    const fallback = this._planRunners[0] ?? 'claude-code';
    if (task.assignedRunner) {
      console.warn(
        `[PlanStore] Task "${task.title}" is assigned to "${task.assignedRunner}", which is not in this plan's ` +
        `runner set [${this._planRunners.join(', ')}] — spawning "${fallback}" instead.`,
      );
    }
    return fallback;
  }

  private rebuild(): void {
    this._allTasks = flattenTasks(this._planTasks);
    this._taskMap.clear();
    for (const task of this._allTasks) {
      this._taskMap.set(task.id, task);
    }
  }

  /**
   * Drop completed/failed ids that no longer exist in the plan. Called by the
   * structural removals (remove/merge/split) — but NOT by removeFromActive,
   * where a completed task leaves the active list yet must still satisfy its
   * dependents' dependency checks.
   */
  private pruneTerminalSets(): void {
    for (const id of [...this._completedTasks]) {
      if (!this._taskMap.has(id)) this._completedTasks.delete(id);
    }
    for (const id of [...this._failedTasks]) {
      if (!this._taskMap.has(id)) this._failedTasks.delete(id);
    }
  }

  private validateAssignedRunners(): void {
    for (const task of this._allTasks) {
      if (task.type !== 'ai') continue;
      if (!this._planRunners.includes(task.assignedRunner)) {
        throw new Error(
          `Task "${task.title}" has assignedRunner "${task.assignedRunner}" ` +
          `which is not in the plan's runner set: [${this._planRunners.join(', ')}]`
        );
      }
    }
  }
}

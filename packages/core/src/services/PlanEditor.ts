import { canMergeTasks, canSplitTask } from './TaskOps';
import { validateTaskEdit } from './TaskEditValidator';
import { retargetTaskRunner, runnerAssignment, type RunnerCatalog } from './TaskRetarget';
import { effectiveAllowlist } from './ModelAllowlistResolver';
import { buildMergePrompt, buildSplitPrompt } from './PlanPrompts';
import { conflictResolverTask } from './Landing';
import { PlanEditError } from './PlanEditError';
import type { SessionCatalog } from './SessionCatalog';
import type { PlanStore } from './PlanStore';
import type { TaskOrchestrator } from './TaskOrchestrator';
import type { IsolationRunController } from './IsolationRunController';
import type { SessionBroadcaster, SessionNotice } from './SessionMessage';
import { checkPlanSkills, type SkillLookup } from './taskSkills';
import { opsFlag, skillNames, type DiscoveredModel, type LegacyPlanState, type RunnerId, type Task } from '../models/Task';

/** The catalogs an edit reads, as the session holds them at the moment of the edit. */
export type PlanEditCatalog = Pick<SessionCatalog, 'edit' | 'runner' | 'allowlistFor' | 'models' | 'admit'>;

export interface PlanEditorDeps {
  store: PlanStore;
  /** The plan edits land on; null while the session has none. */
  plan: () => LegacyPlanState | null;
  catalog: PlanEditCatalog;
  /**
   * The session's mutation seam: runs `op` and, only if it changed something,
   * saves the plan and announces it — with `notify` when given. Null when
   * there is no plan or `op` changed nothing.
   */
  mutate: (op: () => boolean, notify?: () => void) => LegacyPlanState | null;
  scheduler: Pick<TaskOrchestrator, 'tick' | 'releaseTask'>;
  runs: Pick<IsolationRunController, 'current' | 'linkResolver'>;
  broadcast: SessionBroadcaster;
  /** Whether the planner has Ordewell's tools, which changes how a merge or split is asked of it. */
  plannerTools: () => boolean;
  /** The workspace root's skill catalog, which a hand-set skill list is checked against. */
  taskSkills: () => SkillLookup;
  notice: (level: SessionNotice['level'], message: string) => void;
}

/**
 * The user's own edits to the plan: the direct side of a direct edit vs a
 * planner edit. Each one is checked by the same rules the planner's task ops
 * meet ({@link validateTaskEdit}, {@link canMergeTasks}, {@link canSplitTask}),
 * derives whatever a runner change or an added task leaves unset from that
 * runner's catalog, and lands through the session's mutation seam followed by
 * the reschedule a direct edit owes an armed scheduler. A merge or split is
 * the planner's to carry out; the editor only checks it and words the request.
 */
export class PlanEditor {
  private readonly store: PlanStore;
  private readonly plan: () => LegacyPlanState | null;
  private readonly catalog: PlanEditCatalog;
  private readonly mutate: PlanEditorDeps['mutate'];
  private readonly scheduler: PlanEditorDeps['scheduler'];
  private readonly runs: PlanEditorDeps['runs'];
  private readonly broadcast: SessionBroadcaster;
  private readonly plannerTools: () => boolean;
  private readonly taskSkills: () => SkillLookup;
  private readonly notice: PlanEditorDeps['notice'];

  constructor(deps: PlanEditorDeps) {
    this.store = deps.store;
    this.plan = deps.plan;
    this.catalog = deps.catalog;
    this.mutate = deps.mutate;
    this.scheduler = deps.scheduler;
    this.runs = deps.runs;
    this.broadcast = deps.broadcast;
    this.plannerTools = deps.plannerTools;
    this.taskSkills = deps.taskSkills;
    this.notice = deps.notice;
  }

  /**
   * Patch one task's fields. A hand-set dependency list, or a type flip
   * between AI and MAN, are the patches that can leave a task incoherent
   * (unschedulable, or carrying fields that mean nothing for its new type),
   * so both go through the same {@link validateTaskEdit} guard the planner's
   * task-ops applier uses (as the 'direct' actor, which skips the lock rule)
   * rather than a second copy of the rules — and throws, so the surface can
   * say why. Gated on the task existing so an edit to an unknown id still
   * falls through to the no-op `store.update` below instead of throwing.
   * Attached skills meet the rule a planner's do: a planner skill is refused,
   * a name not found yet only warns.
   */
  async updateTask(taskId: string, changes: Partial<Task>): Promise<LegacyPlanState | null> {
    if ('ops' in changes) changes = { ...changes, ops: opsFlag(changes.ops) };
    if ('skills' in changes) changes = { ...changes, skills: skillNames(changes.skills) };
    const target = this.store.get(taskId);
    const skills = changes.skills && target
      ? checkPlanSkills([{ ...target, skills: changes.skills, subtasks: [] }], this.taskSkills())
      : undefined;
    if (skills?.errors.length) throw new PlanEditError(skills.errors.map((e) => e.message).join(' '));
    if ((changes.dependencies || changes.type || changes.assignedModel || changes.taskMode || 'ops' in changes) && target) {
      const check = validateTaskEdit('direct', this.store.planTasks, taskId, changes, this.catalog.edit());
      if (!check.ok) throw new PlanEditError(check.error ?? 'Those changes are not valid');
      if (check.clear?.length) {
        changes = { ...changes, ...Object.fromEntries(check.clear.map((f) => [f, undefined])) };
      }
    }
    const plan = await this.commit(
      () => Boolean(this.store.update(taskId, changes)),
      () => this.broadcast({ type: 'task_updated', taskId, changes: changes as Record<string, unknown> }),
    );
    if (plan) for (const warning of skills?.warnings ?? []) this.notice('warn', warning);
    return plan;
  }

  /**
   * Replace one task's dependency list — the named entry point the surfaces'
   * dependency pickers call. The guard itself lives in {@link updateTask}, so
   * a dependency list arriving as a plain field patch is rejected by the same
   * rule instead of slipping past it.
   */
  async setTaskDependencies(taskId: string, dependencies: string[]): Promise<LegacyPlanState | null> {
    if (!this.plan()) return null;
    return this.updateTask(taskId, { dependencies });
  }

  /**
   * Move one task onto a different runner. Distinct from {@link updateTask}
   * because a runner change is never a single-field edit: the task's model,
   * thinking effort and mode are all scoped to its runner, so they are
   * re-derived from the new runner's catalog (see {@link retargetTaskRunner}).
   * That needs discovery, which is why it is not a branch inside `updateTask`.
   *
   * The runner is also admitted into `plan.runners` — see {@link admitRunner}.
   */
  async setTaskRunner(taskId: string, runner: RunnerId): Promise<LegacyPlanState | null> {
    const plan = this.plan();
    if (!plan) return null;
    const task = this.store.get(taskId);
    if (!task) return null;
    // Guard before discovery, not after: listing models spawns the runner's
    // own CLI, which is far too expensive for a no-op re-pick.
    if (task.assignedRunner === runner || task.type === 'user') return plan;

    const catalog = await this.catalog.runner(runner);
    const changes = retargetTaskRunner(task, runner, this.allowedCatalog(catalog, runner));
    if (Object.keys(changes).length === 0) return this.plan();

    return this.commit(() => {
      if (!this.store.update(taskId, changes)) return false;
      this.admitRunner(runner, catalog.models);
      return true;
    });
  }

  /**
   * Add one task, filling in whatever the caller left unset. A task with no
   * runnable assignment is not a lighter task but an unspawnable one, so the
   * runner falls back to the plan's first and the model, effort and mode are
   * derived from that runner's catalog — the same derivation a runner change
   * uses ({@link runnerAssignment}), which is why this is async like
   * {@link setTaskRunner}. Anything the caller did choose survives when the
   * runner offers it.
   *
   * Dependencies naming tasks that don't exist are dropped rather than rejected:
   * the caller is a picker over the current plan, so a stale id means the plan
   * moved on, not that the whole task should be refused.
   */
  async addTask(draft: Partial<Task>): Promise<LegacyPlanState | null> {
    const plan = this.plan();
    if (!plan) return null;
    const runner = draft.assignedRunner ?? plan.runners[0];
    const dependencies = (draft.dependencies ?? []).filter((id) => this.store.get(id));
    const catalog = draft.type === 'user' ? null : await this.catalog.runner(runner);

    return this.commit(() => {
      this.store.add({ ...draft, ...(catalog ? runnerAssignment(this.allowedCatalog(catalog, runner), draft) : {}), assignedRunner: runner, dependencies });
      if (catalog) this.admitRunner(runner, catalog.models);
      return true;
    });
  }

  /**
   * Delete one task. A running task is cancelled first: the plan can drop it
   * either way, but nothing can reach its runner afterwards — the tmux session
   * outlives the plan and the orchestrator keeps counting it as active. The
   * planner-driven path refuses instead (see `applyTaskOps`); a user
   * deleting their own task means it.
   */
  async removeTask(taskId: string): Promise<LegacyPlanState | null> {
    if (!this.plan() || !this.store.get(taskId)) return null;
    await this.scheduler.releaseTask(taskId);
    return this.commit(() => (this.store.remove(taskId), true));
  }

  /**
   * The opt-in way through a merge conflict: add an AI task, on the conflicted
   * task's own runner and model, that merges its branch by hand in a worktree
   * of its own. When that task lands, the conflicted one lands through it (see
   * {@link IsolationRunController.linkResolver}). The automatic answer to a
   * conflict is a repair, a new attempt of the same task (ADR-0015); a task is
   * only ever added to the plan by this call.
   */
  async addConflictResolver(taskId: string): Promise<LegacyPlanState | null> {
    if (!this.plan()) return null;
    const task = this.store.get(taskId);
    const draft = task ? conflictResolverTask(task, this.runs.current) : null;
    if (!draft) throw new PlanEditError('Only a task whose merge conflicted can be resolved as a task');
    return this.commit(() => {
      const resolver = this.store.add(draft);
      this.runs.linkResolver(resolver.id, taskId);
      return true;
    });
  }

  /**
   * What to ask the planner to merge `taskIds` into one task with (ADR-0002),
   * once they are compatible. Throws on a pre-flight failure, so the host
   * surfaces an inline error before any LLM call.
   */
  mergeRequest(taskIds: string[]): string {
    if (!this.plan()) throw new Error('No active plan state');
    const check = canMergeTasks(this.store.planTasks, taskIds);
    if (!check.ok) throw new Error(check.error ?? 'These tasks cannot be merged');
    return buildMergePrompt(taskIds, this.store.planTasks, this.plannerTools());
  }

  /** What to ask the planner to decompose one task with; the model generates the breakdown. Throws like {@link mergeRequest}. */
  splitRequest(taskId: string): string {
    if (!this.plan()) throw new Error('No active plan state');
    const check = canSplitTask(this.store.planTasks, taskId);
    if (!check.ok) throw new Error(check.error ?? 'This task cannot be split');
    return buildSplitPrompt(taskId, this.store.planTasks, this.plannerTools());
  }

  /**
   * Make a runner a first-class member of this plan. Without this, the next
   * planner turn's `coerceAssignments` would treat it as disallowed and snap
   * every task on it back, silently undoing the user's choice; and that same
   * pass clamps efforts against the remembered catalog, so a catalog missing
   * from there makes the effort we just derived read as unverifiable.
   */
  admitRunner(runner: RunnerId, models: DiscoveredModel[]): void {
    const plan = this.plan();
    if (!plan) return;
    if (!plan.runners.includes(runner)) plan.runners = [...plan.runners, runner];
    // The store is what the orchestrator resolves a spawn against, and nothing
    // reloads it between this edit and a single-task run.
    this.store.admitRunner(runner);
    this.catalog.admit(runner, models);
  }

  /**
   * The mutation seam plus the reschedule every structural edit owes an armed
   * scheduler. Nothing else wakes one after a hand edit — the queue-drain path
   * never runs, because a direct edit never queues — so a task the edit just
   * unblocked would sit ready and never start. `tick()` no-ops while the
   * scheduler is idle, so this costs nothing during plain planning. The
   * planner-driven path re-ticks in `PlannerConversation` instead
   * (`afterEdit`); it must not tick twice.
   */
  private async commit(op: () => boolean, notify?: () => void): Promise<LegacyPlanState | null> {
    const plan = this.mutate(op, notify);
    if (!plan) return null;
    await this.scheduler.tick();
    return plan;
  }

  /**
   * What a *derived* assignment may draw from: the runner's catalog narrowed to
   * the user's allowlist. Deriving from the full catalog would hand a task the
   * runner's first model regardless of a restriction the user set — the next
   * planner turn's `coerceAssignments` would snap it back anyway, so the user
   * would see their pick silently change instead of never being offered.
   *
   * The catalog itself stays unnarrowed because {@link admitRunner} remembers
   * it as what the runner really offers, which is what effort clamping needs.
   */
  private allowedCatalog(catalog: RunnerCatalog, runner: RunnerId): RunnerCatalog {
    // The other runners' catalogs are what lets `effectiveAllowlist` tell an id
    // this runner hasn't listed yet from one that belongs to a different runner.
    const allowed = effectiveAllowlist(
      this.catalog.allowlistFor(runner),
      runner,
      { ...this.catalog.models(), [runner]: catalog.models },
    );
    if (!allowed) return catalog;
    const models = catalog.models.filter((m) => allowed.includes(m.modelId));
    // Nothing left means the allowlist named only ids this runner hasn't
    // listed. An empty catalog reads as "discovery failed" to
    // `runnerAssignment`, which then leaves the task on the *old* runner's
    // model — a worse outcome than ignoring the restriction for this derivation.
    return models.length > 0 ? { ...catalog, models } : catalog;
  }
}

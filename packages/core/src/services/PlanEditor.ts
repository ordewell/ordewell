import { UPDATABLE_FIELDS } from './TaskOps';
import { subtreeIds } from './PlanTree';
import { startedEditRefusal, validateTaskEdit } from './TaskEditValidator';
import { NOT_STARTED } from '../taskRow/status';
import { liveRunnerRefusal, resolveAssignment, type AssignmentAdjustment, type AssignmentCatalog, type RunnerCatalog } from './TaskAssignment';
import { clampThinkingEffort } from './ModelAllowlistResolver';
import { conflictResolverTask } from './Landing';
import { checkPlanInvariants, type PlanTaskError } from './PlannedTask';
import { PlanEditError } from './PlanEditError';
import type { SessionCatalog } from './SessionCatalog';
import type { PlanStore } from './PlanStore';
import type { TaskOrchestrator } from './TaskOrchestrator';
import type { IsolationRunController } from './IsolationRunController';
import type { SessionBroadcaster, SessionNotice } from './SessionMessage';
import { checkTaskSkillsEdit, type SkillLookup } from './taskSkills';
import { createTask, opsFlag, skillNames, updateTaskInPlan, type DiscoveredModel, type LegacyPlanState, type RunnerId, type Task, type TaskModelAssignment } from '../models/Task';
import type { RunnerModelRef } from '../models/RunnerCommand';
import { clearedBodyFields } from '../models/ScriptTask';
import { loopRemovalRefusal, loopSpec } from '../models/Loop';
import { taggedReadOnlyMode } from './ModeResolver';

/** The fields that decide what a task runs on: an edit that touches none of them leaves the assignment as it stands. */
const ASSIGNMENT_FIELDS = ['assignedRunner', 'assignedModel', 'taskMode', 'type'] as const satisfies readonly (keyof Task)[];

/** The catalogs an edit reads, as the session holds them at the moment of the edit. */
export type PlanEditCatalog = Pick<SessionCatalog, 'edit' | 'runner' | 'admit'>;

/**
 * How a surface's direct edit is admitted. The task card offers its editors
 * only on a task that has not started, so its edit must not land on one the
 * scheduler claimed while discovery or the skill check was still running.
 * Other direct callers (the TUI, the API, the runner's own model switch) keep
 * the wider direct-edit contract and pass nothing.
 */
export interface TaskEditOptions {
  /** Refuse the edit once the task is live or its status has left the unstarted set. */
  requireUnstarted?: boolean;
}

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
  scheduler: Pick<TaskOrchestrator, 'tick' | 'releaseTask' | 'releaseMovedResume' | 'planEdited' | 'resolverRefusal' | 'startWhenAllowed'>;
  runs: Pick<IsolationRunController, 'current' | 'linkResolver'>;
  broadcast: SessionBroadcaster;
  /** The workspace's skill catalog under its repo group's layout, which a hand-set skill list is checked against. */
  taskSkills: () => SkillLookup;
  notice: (level: SessionNotice['level'], message: string) => void;
  /** A task the user adds themselves is theirs to run, as one they start is (ADR-0035). */
  approve: (taskIds: readonly string[]) => void;
  /** Whether a resolver's merge message ends with the Planned-with trailer; read as the task is added. */
  plannedWith?: () => boolean;
}

/**
 * The user's own edits to the plan: the direct side of a direct edit vs a
 * planner edit. Each one is checked by the same rules the planner's task ops
 * meet ({@link validateTaskEdit} and TaskOps' own refusals), derives whatever a
 * runner change or an added task leaves unset from that runner's catalog, and
 * lands through the session's mutation seam followed by the reschedule a direct
 * edit owes an armed scheduler. A merge or split is the planner's to carry out
 * when the user asks for one in its chat.
 */
export class PlanEditor {
  private readonly store: PlanStore;
  private readonly plan: () => LegacyPlanState | null;
  private readonly catalog: PlanEditCatalog;
  private readonly mutate: PlanEditorDeps['mutate'];
  private readonly scheduler: PlanEditorDeps['scheduler'];
  private readonly runs: PlanEditorDeps['runs'];
  private readonly broadcast: SessionBroadcaster;
  private readonly taskSkills: () => SkillLookup;
  private readonly notice: PlanEditorDeps['notice'];
  private readonly approve: PlanEditorDeps['approve'];
  private readonly plannedWith: () => boolean;
  /** Each task's latest {@link updateTask}, which the next edit to that task waits behind. */
  private readonly taskEdits = new Map<string, Promise<unknown>>();

  constructor(deps: PlanEditorDeps) {
    this.store = deps.store;
    this.plan = deps.plan;
    this.catalog = deps.catalog;
    this.mutate = deps.mutate;
    this.scheduler = deps.scheduler;
    this.runs = deps.runs;
    this.broadcast = deps.broadcast;
    this.taskSkills = deps.taskSkills;
    this.notice = deps.notice;
    this.approve = deps.approve;
    this.plannedWith = deps.plannedWith ?? (() => false);
  }

  /**
   * Patch one task's fields: the user's direct edit. Only the fields the
   * planner may change are taken ({@link directChanges}); a task's status,
   * verdict or subtasks are execution's and the plan tree's, never a patch's.
   * The edit meets the rules the planner's task ops meet — who may make it and
   * whether the task stays well-formed ({@link validateTaskEdit}, as the
   * 'direct' actor, which skips the lock rule), what its runner, model, effort
   * and mode end up as ({@link resolveAssignment}, as the user's), and the
   * rules the plan's tasks are held to together (`checkPlanInvariants`) — and
   * throws, so the surface can say why. Attached skills meet the rule a
   * planner's do: a planner skill is refused, a name not found yet only warns.
   *
   * A runner change is part of the same patch: the new runner's catalog is
   * discovered first, and the whole edit lands as one save, checked after the
   * last wait — the task may have started meanwhile, and a live runner holds
   * its runner and model. A model named beside the runner wins over one the
   * move would derive.
   *
   * Edits to one task commit in call order: the skill check waits on git, so
   * two quick chip edits (`[a]` then `[a, b]`) could otherwise land the first
   * one last. An empty patch changes nothing and answers whether the task exists.
   *
   * `options.requireUnstarted` is the task card's precondition: it is checked
   * again after the waits, so a task the scheduler claimed meanwhile is left
   * untouched and the edit is refused.
   */
  updateTask(taskId: string, changes: Partial<Task>, options?: TaskEditOptions): Promise<LegacyPlanState | null> {
    return this.inTaskOrder(taskId, () => this.applyTaskUpdate(taskId, changes, options));
  }

  /**
   * The plan follows a model switch the user made with the runner's own
   * command (#106), as a direct edit of theirs: saved and announced as
   * `task_updated`, so every surface shows it, and what a later retry or
   * continue spawns on. It is the one model edit a live runner allows, since
   * it says what that runner already runs, and the one that skips the
   * allowlist: the user picked it in the runner. The runner's own label is
   * used only for a model discovery does not list. Effort is the runner's
   * when it reported one, else the plan's, carried to the new model by the
   * one rule ({@link clampThinkingEffort}); none for a model discovery does
   * not list. `live` is asked as the edit lands, after the edits queued ahead
   * of it: by then the plan may be another one, whose task of the same id the
   * switch says nothing of.
   */
  followRunnerModel(taskId: string, model: RunnerModelRef, effort: string | undefined, live: () => boolean): Promise<LegacyPlanState | null> {
    return this.inTaskOrder(taskId, async () => {
      const task = this.store.get(taskId);
      if (!task || task.type !== 'ai' || !live()) return null;
      const catalog = this.catalog.edit();
      const listed = catalog.modelsByRunner[task.assignedRunner]?.find((m) => m.modelId === model.model);
      const thinkingEffort = clampThinkingEffort(effort ?? task.assignedModel?.thinkingEffort, listed?.variants ?? []);
      if (task.assignedModel?.modelId === model.model && task.assignedModel.thinkingEffort === thinkingEffort) return this.plan();
      const assignedModel: TaskModelAssignment = {
        modelId: model.model,
        modelLabel: listed?.modelLabel ?? model.label ?? model.model,
        ...(thinkingEffort ? { thinkingEffort } : {}),
      };
      const outcome = resolveAssignment({ writer: 'runner', task: { ...task, assignedModel }, before: task, catalog });
      return this.commitTaskUpdate(taskId, { assignedModel: outcome.ok ? outcome.task.assignedModel : assignedModel });
    });
  }

  /** Edits to one task commit in call order; see {@link updateTask}. */
  private inTaskOrder(taskId: string, apply: () => Promise<LegacyPlanState | null>): Promise<LegacyPlanState | null> {
    const edit = (this.taskEdits.get(taskId) ?? Promise.resolve()).then(apply);
    const settled = edit.catch(() => {});
    this.taskEdits.set(taskId, settled);
    void settled.then(() => {
      if (this.taskEdits.get(taskId) === settled) this.taskEdits.delete(taskId);
    });
    return edit;
  }

  private async applyTaskUpdate(taskId: string, patch: Partial<Task>, options: TaskEditOptions = {}): Promise<LegacyPlanState | null> {
    const target = this.store.get(taskId);
    if (!target) return null;
    const changes = directChanges(patch, target);
    if (Object.keys(changes).length === 0) return this.plan();
    // Asked before discovery too: listing a runner's models spawns its CLI
    // for an edit that could not land anyway.
    this.refuseStartedCardEdit(target, options);
    const skills = 'skills' in changes ? await checkTaskSkillsEdit(target, patch.skills, this.taskSkills()) : undefined;
    if (skills?.errors.length) throw new PlanEditError(skills.errors.map((e) => e.message).join(' '));
    const runner = changes.assignedRunner ?? target.assignedRunner;
    // Listing models spawns the runner's own CLI: a move that could not be made anyway is refused first.
    if (changes.assignedRunner) this.refuseLiveRetarget(target);
    const discovered = changes.assignedRunner || (changes.type === 'ai' && target.type !== 'ai') ? await this.discover(runner) : undefined;
    const landed = this.landedEdit(taskId, changes, discovered, options);
    if (!landed) return null;
    const { edit, adjustments } = landed;
    const moved = edit.assignedRunner !== undefined;
    const plan = await this.commit(
      () => {
        const released = this.scheduler.releaseMovedResume(taskId, edit);
        if (!this.store.update(taskId, released)) return false;
        Object.assign(edit, released);
        if (moved && discovered) this.admitRunner(runner, discovered.models);
        return true;
      },
      // A move can admit a runner to the plan, which only the whole plan's announcement carries.
      moved ? undefined : () => this.broadcast({ type: 'task_updated', taskId, changes: edit as Record<string, unknown> }),
    );
    if (plan) {
      this.tellAdjusted(adjustments);
      for (const warning of skills?.warnings ?? []) this.notice('warn', warning);
    }
    return plan;
  }

  /**
   * A direct edit as it lands: checked against the plan as it is now, after
   * every wait, with what its runner, model, effort and mode resolve to. Null
   * when the task is gone; throws on a refusal.
   */
  private landedEdit(taskId: string, changes: Partial<Task>, discovered: RunnerCatalog | undefined, options: TaskEditOptions): { edit: Partial<Task>; adjustments: AssignmentAdjustment[] } | null {
    const before = this.store.get(taskId);
    if (!before) return null;
    // Re-read after every wait: the scheduler may have claimed the task while
    // its runner's catalog or its skills were being checked.
    this.refuseStartedCardEdit(before, options);
    const check = validateTaskEdit('direct', this.store.planTasks, taskId, changes);
    if (!check.ok) throw new PlanEditError(check.error ?? 'Those changes are not valid');
    const edit: Partial<Task> = { ...changes, ...Object.fromEntries((check.clear ?? []).map((f) => [f, undefined])), ...check.set };
    const catalog = this.assignmentCatalog(edit.assignedRunner ?? before.assignedRunner, discovered);
    let adjustments: AssignmentAdjustment[] = [];
    if (ASSIGNMENT_FIELDS.some((f) => f in edit)) {
      const written = { ...before, ...edit };
      const outcome = resolveAssignment({ writer: 'user', task: written, before, catalog });
      if (!outcome.ok) throw new PlanEditError(outcome.error);
      if (outcome.task.assignedModel !== written.assignedModel) edit.assignedModel = outcome.task.assignedModel;
      if (outcome.task.taskMode !== written.taskMode) edit.taskMode = outcome.task.taskMode;
      adjustments = outcome.adjustments;
    }
    if (before.research && changes.research !== true && edit.taskMode !== undefined
      && edit.taskMode !== taggedReadOnlyMode(catalog.runnerModes?.[edit.assignedRunner ?? before.assignedRunner])) edit.research = false;
    this.refuseBreach(taskId, edit, catalog);
    return { edit, adjustments };
  }

  /**
   * The rules the plan's tasks are held to together hold for the user's edits
   * as for the planner's: one this edit would break is refused. One the plan
   * already broke — a rule written since it was saved, say — never blocks an
   * unrelated edit. A user may put a task on any runner.
   */
  private refuseBreach(taskId: string, edit: Partial<Task>, catalog: AssignmentCatalog): void {
    const broken = this.firstBreach(updateTaskInPlan(this.store.planTasks, taskId, edit), catalog);
    if (broken) throw new PlanEditError(broken.message);
  }

  /**
   * The same rules for the route that names no existing task: a hand-added
   * task the direct-edit path would refuse is refused here too (CONTEXT.md,
   * "Hand-added task").
   */
  private refuseAddedBreach(added: Task, catalog: AssignmentCatalog): void {
    const broken = this.firstBreach([...this.store.planTasks, added], catalog);
    if (broken) throw new PlanEditError(broken.message);
  }

  /** The first rule `tasks` breaks that the plan does not already break, or none. */
  private firstBreach(tasks: readonly Task[], catalog: AssignmentCatalog): PlanTaskError | undefined {
    const key = (e: PlanTaskError) => `${e.taskId ?? ''}\u0000${e.field}`;
    const standing = new Set(checkPlanInvariants(this.store.planTasks, undefined, catalog.runnerModes).map(key));
    return checkPlanInvariants(tasks, undefined, catalog.runnerModes).find((e) => !standing.has(key(e)));
  }

  private commitTaskUpdate(taskId: string, changes: Partial<Task>): Promise<LegacyPlanState | null> {
    return this.commit(
      () => {
        changes = this.scheduler.releaseMovedResume(taskId, changes);
        return Boolean(this.store.update(taskId, changes));
      },
      () => this.broadcast({ type: 'task_updated', taskId, changes: changes as Record<string, unknown> }),
    );
  }

  /**
   * Replace one task's dependency list — the named entry point the surfaces'
   * dependency pickers call. The guard itself lives in {@link updateTask}, so
   * a dependency list arriving as a plain field patch is rejected by the same
   * rule instead of slipping past it.
   */
  async setTaskDependencies(taskId: string, dependencies: string[], options?: TaskEditOptions): Promise<LegacyPlanState | null> {
    if (!this.plan()) return null;
    return this.updateTask(taskId, { dependencies }, options);
  }

  /**
   * Move one task onto a different runner: a field patch of its runner, which
   * {@link updateTask} lands with what the runner scopes — the task's model,
   * thinking effort and mode — resolved from the new runner's catalog, and
   * admits the runner into `plan.runners` (see {@link admitRunner}). A re-pick
   * of the same runner, or a runner for a manual task, changes nothing and
   * asks discovery nothing.
   */
  async setTaskRunner(taskId: string, runner: RunnerId, options?: TaskEditOptions): Promise<LegacyPlanState | null> {
    if (!this.plan()) return null;
    return this.updateTask(taskId, { assignedRunner: runner }, options);
  }

  /**
   * Add one task, filling in whatever the caller left unset. A task with no
   * runnable assignment is not a lighter task but an unspawnable one, so the
   * runner falls back to the plan's first and the model, effort and mode are
   * resolved from that runner's catalog as the user's added task
   * ({@link resolveAssignment}), which is why this is async like a runner
   * change. Anything the caller did choose survives when the runner offers it;
   * what was put in its place is named to them.
   *
   * Dependencies naming tasks that don't exist are dropped rather than rejected:
   * the caller is a picker over the current plan, so a stale id means the plan
   * moved on, not that the whole task should be refused.
   */
  async addTask(given: Partial<Task>): Promise<LegacyPlanState | null> {
    const plan = this.plan();
    if (!plan) return null;
    const draft = editableFields(given);
    const runner = draft.assignedRunner ?? plan.runners[0];
    const dependencies = (draft.dependencies ?? []).filter((id) => this.store.get(id));
    const discovered = (draft.type ?? 'ai') !== 'ai' ? undefined : await this.discover(runner);
    const written: Task = { ...createTask({ ...draft, assignedRunner: runner, dependencies }), taskMode: draft.taskMode };
    const catalog = this.assignmentCatalog(runner, discovered);
    const outcome = resolveAssignment({ writer: 'userAdd', task: written, catalog });
    if (!outcome.ok) throw new PlanEditError(outcome.error);
    const { assignedModel, taskMode } = outcome.task;
    // A task put in the plan by hand is held to the plan's rules as one the
    // direct-edit path patches: an ops task in its runner's read-only mode is
    // refused the same way (CONTEXT.md, "Hand-added task").
    this.refuseAddedBreach(outcome.task, catalog);

    const added = await this.commit(() => {
      this.approve([this.store.add({ ...draft, id: written.id, assignedModel, taskMode, assignedRunner: runner, dependencies }).id]);
      if (discovered) this.admitRunner(runner, discovered.models);
      return true;
    });
    if (added) this.tellAdjusted(outcome.adjustments);
    return added;
  }

  /** What `runner` offers. One no manifest declares is refused, as every planner route refuses it. */
  private async discover(runner: RunnerId): Promise<RunnerCatalog> {
    const found = await this.catalog.runner(runner);
    if (!found) throw new PlanEditError(`There is no runner "${runner}": no runner manifest declares it.`);
    return found;
  }

  private refuseLiveRetarget(task: Task): void {
    if (this.catalog.edit().liveRunner?.(task.id)) throw new PlanEditError(liveRunnerRefusal(task));
  }

  /**
   * The card's narrower precondition, not the direct path's: a task whose
   * runner is live or whose status has left the unstarted set was claimed
   * while the edit waited, so the edit is refused rather than retargeting,
   * rewriting or cancelling the attempt it raced.
   */
  private refuseStartedCardEdit(task: Task, options: TaskEditOptions): void {
    if (!options.requireUnstarted) return;
    if (NOT_STARTED.has(task.status) && !this.catalog.edit().liveRunner?.(task.id)) return;
    throw new PlanEditError(startedEditRefusal(task));
  }

  /**
   * Never silent (ADR-0001): what the user had that their edit replaced — a
   * model the allowlist excludes, or one the new runner does not offer, and
   * the effort that followed it. A model filled in where they named none
   * replaced nothing of theirs.
   */
  private tellAdjusted(adjustments: readonly AssignmentAdjustment[]): void {
    const byTask = new Map<string, AssignmentAdjustment[]>();
    for (const a of adjustments) if (a.from !== null) byTask.set(a.taskId, [...(byTask.get(a.taskId) ?? []), a]);
    for (const changes of byTask.values()) {
      const said = changes.map((a) => `${a.field === 'assignedModel' ? 'model' : 'effort'} ${a.from} → ${a.to ?? 'none'}`);
      this.notice('info', `Task "${changes[0].title}": ${said.join(', ')}.`);
    }
  }

  /**
   * Delete one task. A running task is cancelled first: the plan can drop it
   * either way, but nothing can reach its runner afterwards — the process
   * outlives the plan and the orchestrator keeps counting it as active. The
   * planner-driven path refuses instead (see `applyTaskOps`); a user
   * deleting their own task means it.
   */
  async removeTask(taskId: string): Promise<LegacyPlanState | null> {
    const task = this.store.get(taskId);
    if (!this.plan() || !task) return null;
    // Its body would be left to run on its own (ADR-0045 L8); a body task leaves its loop as it goes.
    const refused = loopRemovalRefusal(task);
    if (refused) throw new PlanEditError(refused);
    for (const id of subtreeIds(this.store.planTasks, taskId)) await this.scheduler.releaseTask(id);
    return this.commit(() => (this.store.remove(taskId), true));
  }

  /**
   * The opt-in way through a merge conflict: add an AI task, on the conflicted
   * task's own runner and model, that merges its branch by hand in a worktree
   * of its own. When that task lands, the conflicted one lands through it (see
   * {@link IsolationRunController.linkResolver}). The automatic answer to a
   * conflict is a repair, a new attempt of the same task (ADR-0015); a task is
   * only ever added to the plan by this call, and one worker at a time has a
   * conflict, so it is refused while a repair or another resolver has this one.
   */
  async addConflictResolver(taskId: string): Promise<LegacyPlanState | null> {
    if (!this.plan()) return null;
    const refused = this.scheduler.resolverRefusal(taskId);
    if (refused) throw new PlanEditError(refused);
    const task = this.store.get(taskId);
    const draft = task ? conflictResolverTask(task, this.runs.current, this.store.planTasks, this.plannedWith()) : null;
    if (!draft) throw new PlanEditError('Only a task whose merge conflicted can be resolved as a task');
    return this.commit(() => {
      const resolver = this.store.add(draft);
      this.approve([resolver.id]);
      this.runs.linkResolver(resolver.id, taskId);
      // The user asked for this conflict to be resolved, and outside a run nothing else would start it.
      this.scheduler.startWhenAllowed(resolver.id);
      return true;
    });
  }

  /**
   * Make a runner a first-class member of this plan: the plan names every
   * runner its tasks run on, and a planner edit may put a task on any of them.
   * The next coercion clamps efforts against the remembered catalog, so a
   * catalog missing from there makes the effort we just derived read as
   * unverifiable.
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
   * scheduler. Nothing else wakes one after a hand edit — no planner turn ends
   * to release a start hold — so a task the edit just unblocked would sit
   * ready and never start. `tick()` no-ops while the scheduler is idle, so this
   * costs nothing during plain planning. A planner edit is rescheduled by its
   * turn's end instead (`PlanTurns`); it must not tick twice.
   */
  private async commit(op: () => boolean, notify?: () => void): Promise<LegacyPlanState | null> {
    // The plan as it was, so the scheduler can see a loop this edit ends:
    // `updateTaskInPlan` copies every task, so this view stays what it read.
    const before = this.store.planTasks;
    const plan = this.mutate(op, notify);
    if (!plan) return null;
    this.scheduler.planEdited(before);
    await this.scheduler.tick();
    return plan;
  }

  /**
   * What a direct edit is resolved against: the session's catalog, with the
   * catalog just discovered for the runner the edit moves the task to or
   * fills it from. A discovery that found nothing leaves what is known.
   */
  private assignmentCatalog(runner: RunnerId, discovered: RunnerCatalog | undefined): AssignmentCatalog {
    const catalog = this.catalog.edit();
    if (!discovered) return catalog;
    return {
      ...catalog,
      modelsByRunner: discovered.models.length > 0 ? { ...catalog.modelsByRunner, [runner]: discovered.models } : catalog.modelsByRunner,
      runnerModes: { ...catalog.runnerModes, [runner]: discovered.modes },
    };
  }
}

/** The fields of `given` a user may write on a task, new or not: those the planner may change. */
function editableFields(given: Partial<Task>): Partial<Task> {
  const fields: Partial<Task> = {};
  for (const key of UPDATABLE_FIELDS) {
    if (key in given) (fields as Record<string, unknown>)[key] = (given as Record<string, unknown>)[key];
  }
  if ('ops' in fields) fields.ops = opsFlag(fields.ops);
  if ('loop' in fields) {
    // `null` drops the loop, and the round it was in with it (ADR-0045).
    const spec = loopSpec(fields.loop);
    if ('error' in spec) throw new PlanEditError(`This task ${spec.error}`);
    fields.loop = spec.loop;
    if (!spec.loop) fields.loopRound = undefined;
  }
  return clearedBodyFields(fields);
}

/**
 * The fields a direct edit may set: those the planner may change
 * (`UPDATABLE_FIELDS`), which is everything a surface sends — a task's
 * status, verdict or subtasks are execution's and the plan tree's, never a
 * patch's. The ops flag and skills are read as every entry point reads them,
 * and a runner that changes nothing — the same one, or one for a task that
 * stays manual or a script — is dropped, so it asks discovery nothing.
 */
function directChanges(patch: Partial<Task>, target: Task): Partial<Task> {
  const changes = editableFields(patch);
  if ('skills' in changes) changes.skills = skillNames(changes.skills);
  if (Array.isArray(changes.dependencies)) changes.dependencies = changes.dependencies.map(String);
  else delete changes.dependencies;
  const stays = changes.assignedRunner === target.assignedRunner || (changes.type ?? target.type) !== 'ai';
  if ('assignedRunner' in changes && (typeof changes.assignedRunner !== 'string' || !changes.assignedRunner || stays)) delete changes.assignedRunner;
  return changes;
}

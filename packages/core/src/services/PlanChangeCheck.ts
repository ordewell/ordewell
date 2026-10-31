import { flattenTasks, type RunnerId, type Task } from '../models/Task';
import type { RunnerModeInfo } from './ModeResolver';
import { validatePlanTasks, type PlanTasksResult } from './PlanValidator';
import { checkPlanInvariants } from './PlannedTask';
import { applyTaskOps, opRefusalText, type OpRef, type TaskOp } from './TaskOps';
import { resolveAssignments, type AssignmentAdjustment, type AssignmentCatalog } from './TaskAssignment';
import { checkOpSkills, checkPlanSkills, type SkillCheck, type SkillLookup } from './taskSkills';
import { missingGrant, type Grant, type NodeAuthority } from './Mandate';

/**
 * When a planner's change is checked: as the planner submits it, where a
 * whole plan is still its JSON, or as it commits — a tool's call as it
 * answers, a reply's envelope as the reply settles.
 */
export type CheckPhase = 'submit' | 'land';

/**
 * A change the planner makes to the plan: a whole plan, or a batch of task
 * ops. A plan is its JSON as the planner submits it, and the tasks it was
 * accepted as once it lands.
 */
export type PlannerChange<P extends CheckPhase = CheckPhase> =
  | { kind: 'plan'; tasks: P extends 'land' ? readonly Task[] : unknown }
  | { kind: 'ops'; ops: TaskOp[] };

/** One reason a change was refused: the task and field it is about, or the op. */
export interface PlanChangeError {
  taskId?: string;
  /** A task's field, `skills`, or `tasks` for the plan as a whole. */
  field?: string;
  op?: OpRef;
  message: string;
}

/** A refusal as the planner reads it in prose, its op named first. */
export function planChangeErrorText(error: PlanChangeError): string {
  return opRefusalText(error);
}

export type CheckedChange =
  | {
    ok: true;
    /**
     * The plan's tasks as the change leaves them, assignments resolved. A
     * plan's at submit are the tasks it was accepted as, which landing
     * resolves under the catalog of that moment.
     */
    tasks: Task[];
    /** What landing changes in what the planner wrote, named (ADR-0003): the same at submit as at landing while the catalog holds. */
    adjustments: AssignmentAdjustment[];
    /** What was accepted but not used, or may be missing when a task starts. */
    warnings: string[];
    /** What an edit changed, for the transcript; empty for a plan. */
    summary: string[];
    /** The id each of an edit's handles names. */
    handles: ReadonlyMap<string, string>;
  }
  | {
    ok: false;
    errors: PlanChangeError[];
    /** The runners the change was held to, for a refusal to name what would be accepted. */
    runners: RunnerId[];
  };

export type PassedChange = Extract<CheckedChange, { ok: true }>;

/** What a change is checked against, read as each check runs: a session's live state, or a one-shot planner's request. */
export interface PlanChangeScope {
  /** The plan's tasks as they stand. */
  tasks(): readonly Task[];
  /** The runners a change may put a task on (`assignableRunners`): those enabled now, for a whole plan and an edit alike. */
  runners(kind: PlannerChange['kind']): RunnerId[];
  /** What an assignment is resolved against, with the modes of `runners` and of any a task may be left on. */
  catalog(runners: RunnerId[]): AssignmentCatalog & { runnerModes?: Record<RunnerId, RunnerModeInfo[]> };
  /** Where attached skill names are looked up; absent, none are. */
  skills?(): SkillLookup;
  /** The handles the open turn's committed edits gave, each with its task's id, for a later batch to name them by (ADR-0022 P2). */
  handles?(): ReadonlyMap<string, string>;
  /** A further refusal of what the change leaves: the supervisor's oscillation guard (ADR-0029). */
  guard?(before: readonly Task[], after: readonly Task[]): string | undefined;
  /** The node, below the root: a child's change is held to its mandate, where a commit would otherwise approve with no command (ADR-0056 M6). Absent, or undefined, at the root. */
  child?(): NodeAuthority | undefined;
}

/** What a whole plan's JSON is held to as it is submitted. */
export interface PlanIntake {
  runners: RunnerId[];
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault?: boolean;
}

const NO_SKILLS: SkillCheck = { errors: [], warnings: [] };

/**
 * The one check a planner's change to the plan meets (ADR-0022, P2), on every
 * route: `submit_plan` and a plan envelope, an edit made through `edit_plan`
 * and a `taskOps` reply, each held to it as it commits, and a whole plan's
 * JSON as it is submitted too. Every rule reads one scope, so a plan accepted
 * at submit is refused as it commits only for something that moved in
 * between, and the adjustments the planner is told are the ones committing
 * made.
 */
export class PlanChangeCheck {
  constructor(private readonly scope: PlanChangeScope) {}

  /** What a whole plan's JSON is held to: what an envelope's parse must hold its candidates to, for both routes to agree. */
  intake(): PlanIntake {
    const runners = this.scope.runners('plan');
    const { runnerModes, autonomousDefault } = this.scope.catalog(runners);
    return { runners, ...(runnerModes ? { runnerModes } : {}), ...(autonomousDefault !== undefined ? { autonomousDefault } : {}) };
  }

  /**
   * Hold `change` to every rule at `phase`. Its one wait, the skill lookup,
   * comes before every rule that reads the plan, and `then` gets what passed
   * in the tick those rules ran in, so nothing can move the plan between the
   * check and what is done with it.
   */
  async check<P extends CheckPhase>(change: PlannerChange<P>, phase: P, then?: (passed: PassedChange) => void): Promise<CheckedChange> {
    const read = this.read(change, phase);
    if (read && !read.ok) return this.refused(change, read.errors);
    const lookup = this.scope.skills?.();
    const skills = !lookup ? NO_SKILLS : change.kind === 'ops' ? await checkOpSkills(change.ops, lookup) : await checkPlanSkills(read?.tasks ?? landing(change), lookup);
    const checked = this.rules(change, phase, skills, read);
    if (checked.ok) then?.(checked);
    return checked;
  }

  /** {@link check} without the skill lookup, for a change that attaches none or is only being shown. */
  checkNow<P extends CheckPhase>(change: PlannerChange<P>, phase: P): CheckedChange {
    const read = this.read(change, phase);
    if (read && !read.ok) return this.refused(change, read.errors);
    return this.rules(change, phase, NO_SKILLS, read);
  }

  /** A plan's JSON read into tasks as it is submitted; nothing in it reads the plan. */
  private read<P extends CheckPhase>(change: PlannerChange<P>, phase: P): PlanTasksResult | undefined {
    if (change.kind !== 'plan' || phase !== 'submit') return undefined;
    const { runners, runnerModes, autonomousDefault } = this.intake();
    return validatePlanTasks({ tasks: change.tasks }, runners, runnerModes, autonomousDefault);
  }

  private rules<P extends CheckPhase>(change: PlannerChange<P>, phase: P, skills: SkillCheck, read: PlanTasksResult | undefined): CheckedChange {
    const runners = this.scope.runners(change.kind);
    const catalog = this.scope.catalog(runners);
    const before = this.scope.tasks();
    const skillErrors: PlanChangeError[] = skills.errors.map((e) => ({ ...e, field: 'skills' }));

    if (change.kind === 'plan') {
      const tasks = read?.ok ? read.tasks : [...landing(change)];
      const ungranted = this.ungranted(before, tasks);
      if (ungranted.length > 0) return this.refused(change, ungranted);
      // A landing plan waited out the rest of its reply, so the runners it was accepted against may be gone (ADR-0003 V1).
      const broken = phase === 'land' ? checkPlanInvariants(tasks, runners, catalog.runnerModes) : [];
      if (broken.length > 0 || skillErrors.length > 0) return this.refused(change, [...broken, ...skillErrors]);
      const resolved = resolveAssignments(tasks, before, catalog);
      const warnings = [...(read?.ok ? read.warnings ?? [] : []), ...skills.warnings];
      return { ok: true, tasks: phase === 'land' ? resolved.tasks : tasks, adjustments: resolved.adjustments, warnings, summary: [], handles: new Map() };
    }

    if (skillErrors.length > 0) return this.refused(change, skillErrors);
    const applied = applyTaskOps(before, change.ops, runners, catalog, this.scope.handles?.());
    if (!applied.ok) return this.refused(change, applied.refusals);
    const ungranted = this.ungranted(before, applied.tasks);
    if (ungranted.length > 0) return this.refused(change, ungranted);
    const tripped = this.scope.guard?.(before, applied.tasks);
    if (tripped) return this.refused(change, [{ message: tripped }]);
    // Then what landing changes besides the edit's own ops: an untouched task's effort the catalog no longer offers, say.
    const resolved = resolveAssignments(applied.tasks, before, catalog);
    return {
      ok: true,
      tasks: resolved.tasks,
      adjustments: [...applied.adjustments ?? [], ...resolved.adjustments],
      warnings: skills.warnings,
      summary: applied.summary,
      handles: applied.handles ?? new Map(),
    };
  }

  /** What a child's mandate leaves out of this change: `replan` for any, and `research` for a research task it brings. */
  private ungranted(before: readonly Task[], after: readonly Task[]): PlanChangeError[] {
    const node = this.scope.child?.();
    if (!node) return [];
    const mandate = node.mandate('off');
    const was = new Map(flattenTasks(before).map((task) => [task.id, task]));
    const needs: Grant[] = ['replan', ...flattenTasks(after).some((task) => task.research && !was.get(task.id)?.research) ? ['research' as const] : []];
    return needs.filter((grant) => !mandate.grants.has(grant)).map((grant) => ({ field: 'tasks', message: missingGrant(node.depth, mandate, grant) }));
  }

  private refused(change: PlannerChange, errors: PlanChangeError[]): CheckedChange {
    return { ok: false, errors, runners: this.scope.runners(change.kind) };
  }
}

/** A landing plan's tasks: its phase's type says they are tasks, not JSON. */
function landing(change: Extract<PlannerChange, { kind: 'plan' }>): readonly Task[] {
  return change.tasks as readonly Task[];
}

/**
 * The scope of a planner with no session behind it: a one-shot plan, checked
 * against the request that asked for it and an empty plan.
 */
export function requestScope(request: {
  runners: RunnerId[];
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault?: boolean;
  modelsByRunner?: AssignmentCatalog['modelsByRunner'];
  perRunnerAllowlist?: AssignmentCatalog['perRunnerAllowlist'];
  taskSkills?: SkillLookup;
}): PlanChangeScope {
  const { taskSkills } = request;
  return {
    tasks: () => [],
    runners: () => request.runners,
    catalog: () => ({
      modelsByRunner: request.modelsByRunner ?? {},
      ...(request.runnerModes ? { runnerModes: request.runnerModes } : {}),
      ...(request.perRunnerAllowlist ? { perRunnerAllowlist: request.perRunnerAllowlist } : {}),
      ...(request.autonomousDefault !== undefined ? { autonomousDefault: request.autonomousDefault } : {}),
    }),
    ...(taskSkills ? { skills: () => taskSkills } : {}),
  };
}

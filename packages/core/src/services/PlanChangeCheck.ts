import { flattenTasks, type RunnerId, type Task } from '../models/Task';
import type { RunnerModeInfo } from './ModeResolver';
import { validatePlanTasks, type PlanTasksResult } from './PlanValidator';
import { checkPlanInvariants, type IntakeCatalog } from './PlannedTask';
import { applyTaskOps, opRefusalText, type OpRef, type TaskOp } from './TaskOps';
import { resolveAssignments, type AssignmentAdjustment, type AssignmentCatalog } from './TaskAssignment';
import { checkOpSkills, checkPlanSkills, type SkillCheck, type SkillLookup } from './taskSkills';
import { delegatedRequest, mandateRefusalText, missingGrant, narrow, type Grant, type Mandate, type NodeAuthority } from './Mandate';
import { planSize, scopeOverlaps } from '../models/Delegation';
import { scriptBodyOf } from '../models/ScriptTask';
import { effectRuleFor } from './effectAllowlist';

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
  /**
   * The node a change is made on, with what it holds now and how far below the
   * root it stands, read as each check runs (ADR-0056 M4). Absent or undefined,
   * nothing may delegate: a one-shot planner has no node, and a build that does
   * not offer delegation reads no mandate for it.
   */
  node?(): { mandate: Mandate; level: number } | undefined;
  /** Whether a script can run sealed here (ADR-0036 S6): a change that brings a read-only one waits on this, as an attached skill waits on its lookup. */
  canSeal?(): Promise<boolean>;
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
    const sealable = this.bringsSealedScript(change, read) ? await this.scope.canSeal?.() : undefined;
    const checked = this.rules(change, phase, skills, read, sealable);
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
    return validatePlanTasks({ tasks: change.tasks }, runners, runnerModes, autonomousDefault, this.delegation());
  }

  /** Whether this node may write a delegated task: read on every route, since a parse that took one anyway would only be refused later (ADR-0055 D21). */
  private delegation(): { delegationRefusal?: string | null; sealsScripts?: IntakeCatalog['sealsScripts'] } {
    const node = this.scope.node?.();
    if (!node) return {};
    return {
      delegationRefusal: node.mandate.grants.has('delegate') ? null : missingGrant(node.level, node.mandate, 'delegate'),
      ...(node.level > 0 ? { sealsScripts: (task) => runsSealed(node.mandate, task) } : {}),
    };
  }

  /** Only such a change waits on the probe, so a flat plan's check takes the turns it always took. */
  private bringsSealedScript<P extends CheckPhase>(change: PlannerChange<P>, read: PlanTasksResult | undefined): boolean {
    if (change.kind === 'ops') return change.ops.some((op) => op.op === 'add' && op.task?.readOnly === true && op.task.type === 'script');
    return (read?.ok ? read.tasks : read ? [] : landing(change)).some((task) => task.type === 'script' && task.readOnly === true);
  }

  private rules<P extends CheckPhase>(change: PlannerChange<P>, phase: P, skills: SkillCheck, read: PlanTasksResult | undefined, canSeal?: boolean): CheckedChange {
    const runners = this.scope.runners(change.kind);
    const catalog = this.scope.catalog(runners);
    const before = this.scope.tasks();
    const skillErrors: PlanChangeError[] = skills.errors.map((e) => ({ ...e, field: 'skills' }));

    if (change.kind === 'plan') {
      const tasks = read?.ok ? read.tasks : [...landing(change)];
      const ungranted = [...this.ungranted(before, tasks), ...this.pastMandate(before, tasks)];
      if (ungranted.length > 0) return this.refused(change, ungranted);
      // A landing plan waited out the rest of its reply, so the runners it was accepted against may be gone (ADR-0003 V1).
      const sealing = canSeal === false ? { canSeal } : {};
      const broken = phase === 'land' || canSeal === false ? checkPlanInvariants(tasks, runners, catalog.runnerModes, sealing) : [];
      if (broken.length > 0 || skillErrors.length > 0) return this.refused(change, [...broken, ...skillErrors]);
      const resolved = resolveAssignments(tasks, before, catalog);
      const warnings = [...(read?.ok ? read.warnings ?? [] : []), ...skills.warnings];
      return { ok: true, tasks: phase === 'land' ? resolved.tasks : tasks, adjustments: resolved.adjustments, warnings, summary: [], handles: new Map() };
    }

    if (skillErrors.length > 0) return this.refused(change, skillErrors);
    const applied = applyTaskOps(before, change.ops, runners, { ...catalog, ...this.delegation() }, this.scope.handles?.());
    if (!applied.ok) return this.refused(change, applied.refusals);
    const ungranted = [...this.ungranted(before, applied.tasks), ...this.pastMandate(before, applied.tasks)];
    if (ungranted.length > 0) return this.refused(change, ungranted);
    if (canSeal === false) {
      const unsealed = checkPlanInvariants(applied.tasks, runners, catalog.runnerModes, { canSeal }).filter((error) => error.field === 'readOnly');
      if (unsealed.length > 0) return this.refused(change, unsealed);
    }
    const tripped = this.scope.guard?.(before, applied.tasks);
    if (tripped) return this.refused(change, [{ message: tripped }]);
    // Then what landing changes besides the edit's own ops: an untouched task's effort the catalog no longer offers, say.
    const resolved = resolveAssignments(applied.tasks, before, catalog);
    return {
      ok: true,
      tasks: resolved.tasks,
      adjustments: [...applied.adjustments ?? [], ...resolved.adjustments],
      warnings: [...skills.warnings, ...broughtOverlaps(before, resolved.tasks)],
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

  /**
   * What a change leaves past this node's limits (ADR-0055 D2, D19): each
   * delegated task it wrote narrowed as it is written (ADR-0056 M4), so a plan
   * never holds what its carve would refuse, and a child held to what a child
   * plan may be. Only what this change wrote: what stands in the plan is not
   * this edit's to answer for. A root plan has no task limit, so a flat run
   * does not change.
   */
  private pastMandate(before: readonly Task[], after: readonly Task[]): PlanChangeError[] {
    const node = this.scope.node?.();
    if (!node) return [];
    const { mandate, level } = node;
    const said = ({ status: _status, ...task }: Task) => JSON.stringify(task);
    const was = new Map(flattenTasks(before).map((task) => [task.id, said(task)]));
    const written = flattenTasks(after).filter((task) => was.get(task.id) !== said(task));
    const errors: PlanChangeError[] = [];
    const past = (field: string, asked: number, there: number) => errors.push({ field: 'tasks', message: mandateRefusalText({ level, field, asked: String(asked), there: String(there) }) });
    const delegated = written.filter((task) => task.type === 'delegated');
    for (const task of delegated) {
      const narrowed = narrow(mandate, delegatedRequest(task, level));
      if (!narrowed.ok) errors.push({ taskId: task.id, field: 'budget', message: mandateRefusalText(narrowed.refusal) });
    }
    const count = after.filter((task) => task.type === 'delegated').length;
    if (delegated.length > 0 && count > mandate.limits.delegatedTasks) past('limits.delegatedTasks', count, mandate.limits.delegatedTasks);
    if (level === 0) return errors;
    const size = planSize(after);
    if (written.length > 0 && size > mandate.limits.tasksPerPlan) past('limits.tasksPerPlan', size, mandate.limits.tasksPerPlan);
    for (const task of written) {
      const refused = task.ops ? 'an ops task acts on the user\'s systems from their checkout, so none runs below the root'
        : task.type === 'user' ? 'a manual task waits on a person, and none is below the root'
          // An add lands sealed; an edit that moves a body past the rules keeps what it was.
          : task.type === 'script' && !task.readOnly && runsSealed(mandate, task) ? 'its body is not covered at every level of the effect rules, and it would run unsealed' : null;
      if (refused) errors.push({ taskId: task.id, field: 'type', message: `Level ${level} refused Task "${task.title}": ${refused}.` });
    }
    return errors;
  }

  private refused(change: PlannerChange, errors: PlanChangeError[]): CheckedChange {
    return { ok: false, errors, runners: this.scope.runners(change.kind) };
  }
}

/**
 * Whether a child's script runs sealed (ADR-0056 M9): capability is held at the
 * boundary, so all of them do but a body the rules of every level cover, in a
 * child that holds `effect`. A script body is covered by nothing (ADR-0035).
 */
/** The overlaps an edit brought (ADR-0057 R6): what stood before it was answered then. */
function broughtOverlaps(before: readonly Task[], after: readonly Task[]): string[] {
  const standing = new Set(scopeOverlaps(before));
  return scopeOverlaps(after).filter((said) => !standing.has(said));
}

function runsSealed({ grants, effectRules }: Mandate, task: Pick<Task, 'commands' | 'script' | 'timeoutMs'>): boolean {
  const body = scriptBodyOf({ ...task, type: 'script' });
  return !grants.has('effect') || !body || effectRules.length === 0 || !effectRules.every((rules) => effectRuleFor(rules, body));
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

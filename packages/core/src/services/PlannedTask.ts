import { presentForbiddenFields, TASK_KINDS, writtenForbiddenFields } from '../models/TaskKind';
import { dependencyTargetErrors, findDependencyCycle } from './PlanTree';
import { v4 as uuidv4 } from 'uuid';
import { Task, RunnerId, TaskModelAssignment, DEFAULT_RUNNERS, createTask, flattenTasksWithParents, inheritedSkills, skillNames } from '../models/Task';
import { taggedReadOnlyMode, type RunnerModeInfo } from './ModeResolver';
import { resolveAssignment, type AssignmentAdjustment, type AssignmentCatalog } from './TaskAssignment';
import { scriptBodyErrors } from '../models/ScriptTask';
import { loopErrors, loopSpec } from '../models/Loop';
import { DELEGATION_UNAVAILABLE, delegationErrors, notOnADelegatedMessage, type DelegatedBudget, type DelegationRules, type TaskScope } from '../models/Delegation';

/** One reason a planned task was refused, pinned to the task and field it is about. */
export interface PlanTaskError {
  /** Absent when the envelope itself is wrong rather than one of its tasks. */
  taskId?: string;
  field: string;
  message: string;
}

/** What a planned task may be given: the runners it may run on and their modes. */
export interface IntakeCatalog {
  runners: readonly RunnerId[];
  /** Absent when no runner's modes are known: the mode is then guessed (ADR-0031). */
  runnerModes?: Partial<Record<RunnerId, readonly RunnerModeInfo[]>>;
  autonomousDefault?: boolean;
  /**
   * An edit's assignments are resolved against the catalog as it is planned,
   * and a model it names that the runner does not offer is refused; a
   * submitted plan's models are resolved as it lands instead (ADR-0003).
   */
  models?: AssignmentCatalog;
  /**
   * Why this planner may not write a delegated task or a read-only script
   * (ADR-0055 D1, D8), or null when it may. Absent, there is no node to read:
   * a one-shot planner, or a route that holds no mandate.
   */
  delegationRefusal?: string | null;
  /** Which of a child's script tasks run sealed (ADR-0056 M9): each such lands read-only, on every route. */
  sealsScripts?: (task: Pick<Task, 'commands' | 'script' | 'timeoutMs'>) => boolean;
}

/** Where a planned task lands, which decides what it inherits. */
export interface Placement {
  /** The task it is a subtask of. */
  parent?: Pick<Task, 'title' | 'sliceType' | 'autonomy'> & { readOnly: boolean };
  /**
   * A task made from others — a merge, or a split part: what the planner
   * leaves out comes from these fields, and it stays read-only when they were.
   */
  from?: { fields: Partial<Task>; readOnly: boolean };
  /**
   * An edit's tasks get ids of their own, so a planner cannot name one after
   * a task already in the plan. A submitted plan keeps the planner's, which
   * its dependencies are written against; one it left out is made up.
   */
  freshIds?: boolean;
  /** Where a made-up id comes from: a new one each time, unless the caller keeps them. */
  newId?: () => string;
}

export interface PlannedTask {
  task: Task;
  /** Rules the task, or one of its subtasks, breaks on its own. */
  errors: PlanTaskError[];
  /**
   * What the planner asked for that is not its to set — a mode, or read-only
   * on a manual task (ADR-0031). A whole plan lands without it; an edit is
   * refused.
   */
  ignored: PlanTaskError[];
  /** The planner's id for each task of the tree that was given a fresh one. */
  renamed: Map<string, string>;
  /** What the tree's assignments were adjusted to beyond what the planner wrote, for the planner to be told. */
  adjustments: AssignmentAdjustment[];
}

/** The planner names no mode (ADR-0031): it says read-only, and the mode follows. */
export const MODE_NOT_THE_PLANNERS = '"taskMode" is the user\'s to choose: set "readOnly": true on a task that must not change files, and leave it out otherwise';

/** A manual task runs in no mode, so it cannot be read-only. */
export const MANUAL_NOT_READ_ONLY = '"readOnly" is for AI tasks: a manual task runs in no mode';

/** An ops task acts in the workspace (ADR-0020); a read-only task lands nothing (ADR-0046). */
export const OPS_NOT_READ_ONLY = '"readOnly" is not for an ops task: it acts in the workspace, while a read-only task lands nothing';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** A planner's fields, as untyped as the rest of its JSON; a rule refuses what is wrong with a value that reached the task. */
function delegatedFields(raw: Record<string, unknown>, base: Partial<Task>): Pick<Task, 'goal' | 'budget' | 'grants' | 'protectedPaths' | 'scope'> & { readOnly?: true } {
  const list = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.map(String) : undefined);
  const goal = text(raw.goal) ?? base.goal;
  const budget = (isRecord(raw.budget) ? raw.budget as unknown as DelegatedBudget : undefined) ?? base.budget;
  const grants = (list(raw.grants) ?? base.grants) as Task['grants'];
  const protectedPaths = list(raw.protectedPaths) ?? base.protectedPaths;
  const scope = (isRecord(raw.scope) ? raw.scope as TaskScope : undefined) ?? base.scope;
  return {
    ...(goal !== undefined ? { goal } : {}),
    ...(budget ? { budget } : {}),
    ...(grants ? { grants } : {}),
    ...(protectedPaths ? { protectedPaths } : {}),
    ...(scope ? { scope } : {}),
    ...(raw.readOnly === true || (raw.readOnly === undefined && base.readOnly) ? { readOnly: true as const } : {}),
  };
}

/** The refusal of those fields, worded for the planner. */
export function notOnAScriptMessage(fields: readonly string[]): string {
  return `is a script task, which runs its "commands" or "script" with no model: leave out ${fields.map((f) => `"${f}"`).join(', ')}`;
}

/**
 * Why a task may not be an ops task (ADR-0020), or null when it may: the flag
 * decides where the task runs, and a manual task runs nowhere, a subtask
 * where its parent does.
 */
export function opsPlacementRefusal(type: Task['type'], isSubtask: boolean): string | null {
  if (type === 'script') return 'is a script task, which is an ops task by nature: leave "ops" out';
  if (!TASK_KINDS[type].mayBeOps) return 'is a manual task: only an AI task can be an ops task';
  if (isSubtask) return 'is a subtask, which runs with its parent: only a top-level task can be an ops task';
  return null;
}

/** How an error names a task, so the planner can find the object it wrote. */
export function taskWhere(title: string, parentTitle?: string): string {
  return parentTitle !== undefined ? `subtask "${title}" of "${parentTitle}"` : `Task "${title}"`;
}

/**
 * What each planned task asked to attach, as the planner wrote it. Kept beside
 * the task rather than on it: {@link skillNames} drops a name no skill could
 * have, and the plan's skill check still owes a warning for it. A copy of the
 * task (assignment coercion) does not carry it, so check what was planned.
 */
const skillsAsked = new WeakMap<Task, unknown[]>();

/** The `skills` a planned task was submitted with, before normalization; undefined for a task not planned here. */
export function requestedSkills(task: Task): readonly unknown[] | undefined {
  return skillsAsked.get(task);
}

/** The model as a task stores it; a top-level `thinkingEffort` is the model's, as the effort has one home. */
function modelOf(raw: Record<string, unknown>, from: TaskModelAssignment | undefined): TaskModelAssignment | undefined {
  const effort = text(raw.thinkingEffort);
  if (isRecord(raw.assignedModel)) {
    const m = raw.assignedModel;
    return {
      modelId: text(m.modelId) ?? '',
      modelLabel: text(m.modelLabel) ?? '',
      thinkingEffort: text(m.thinkingEffort) ?? effort,
    };
  }
  return from && effort !== undefined ? { ...from, thinkingEffort: effort } : from;
}

/**
 * A planned task's body fields (ADR-0035): what the planner wrote, else what
 * the task it is made from had. Only a well-formed value is kept on the task;
 * `malformed` names the fields that were not, for their refusal, and `raw` is
 * what was judged.
 */
function bodyFields(raw: Record<string, unknown>, base: Partial<Task>): {
  fields: Pick<Task, 'commands' | 'script' | 'timeoutMs'>;
  raw: Record<'commands' | 'script' | 'timeoutMs', unknown>;
  malformed: Set<string>;
} {
  const pick = (field: 'commands' | 'script' | 'timeoutMs'): unknown => (raw[field] !== undefined && raw[field] !== null ? raw[field] : base[field]);
  const judged = { commands: pick('commands'), script: pick('script'), timeoutMs: pick('timeoutMs') };
  const malformed = new Set<string>();
  const commands = isCommands(judged.commands) ? judged.commands : undefined;
  if (judged.commands !== undefined && !commands) malformed.add('commands');
  const script = typeof judged.script === 'string' ? judged.script : undefined;
  if (judged.script !== undefined && script === undefined) malformed.add('script');
  const timeoutMs = typeof judged.timeoutMs === 'number' ? judged.timeoutMs : undefined;
  if (judged.timeoutMs !== undefined && timeoutMs === undefined) malformed.add('timeoutMs');
  return {
    fields: { ...(commands ? { commands } : {}), ...(script !== undefined ? { script } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    raw: judged,
    malformed,
  };
}

function isCommands(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((argv) => Array.isArray(argv) && argv.every((word) => typeof word === 'string'));
}

/**
 * Build a task from what a planner wrote, by whichever route it arrived: a
 * submitted plan, or an edit that adds, merges or splits. Every fallback a
 * planner's omission meets is here, so the routes cannot drift apart:
 *
 * - the runner is the one named, else the task's it is made from, else the
 *   first one allowed — never a substitute for one named but unknown, which
 *   {@link checkPlanInvariants} refuses;
 * - an AI task's prompt is its own, else its description, else its title, so
 *   it is never unschedulable;
 * - the assignment — model, effort, and the mode decided from read-only or
 *   not, never named (ADR-0031) — is the resolver's (`resolveAssignment`),
 *   as it is for every writer: a model a merge or split carries is read as
 *   what the task was made from, so a part moved to another runner gets that
 *   runner's;
 * - an AI subtask with no slice classification takes its parent's: an `ai`
 *   sub-step of an AFK slice is AFK. Not a blanket default, which would strip
 *   a human gate the planner intended; a manual subtask must still say HITL.
 */
export function plannedTask(spec: unknown, catalog: IntakeCatalog, at: Placement = {}): PlannedTask {
  const raw = isRecord(spec) ? spec : {};
  const { parent, from, freshIds, newId = uuidv4 } = at;
  const base = from?.fields ?? {};
  const errors: PlanTaskError[] = [];
  const ignored: PlanTaskError[] = [];
  const renamed = new Map<string, string>();
  const adjustments: AssignmentAdjustment[] = [];

  const title = text(raw.title) ?? '';
  const where = taskWhere(title, parent?.title);
  const plannerId = text(raw.id);
  const id = freshIds || !plannerId ? newId() : plannerId;
  if (freshIds && plannerId) renamed.set(plannerId, id);

  const delegating = catalog.delegationRefusal === null;
  const type: Task['type'] = raw.type === 'user' || raw.type === 'ai' || raw.type === 'script' || raw.type === 'delegated' ? raw.type : base.type ?? 'ai';
  const ai = type === 'ai';
  const script = type === 'script';
  const delegated = type === 'delegated';
  // A read-only script exists for a delegated task's check (ADR-0055 D8), so where nothing can delegate it reads as it always did.
  const sealedScript = script && (catalog.sealsScripts?.({ ...(Array.isArray(raw.commands) ? { commands: raw.commands as string[][] } : {}), ...(typeof raw.script === 'string' ? { script: raw.script } : {}), ...(typeof raw.timeoutMs === 'number' ? { timeoutMs: raw.timeoutMs } : {}) }) === true || (delegating && raw.readOnly === true));
  const assignedRunner = text(raw.assignedRunner) ?? base.assignedRunner ?? catalog.runners[0] ?? DEFAULT_RUNNERS[0];
  const description = text(raw.description) ?? base.description ?? title;

  // What it may not have is refused rather than dropped: a prompt left on a
  // script, or a runner named for it, says the planner meant something else.
  const notScripts = script ? writtenForbiddenFields('script', raw).filter((f) => !(sealedScript && f === 'readOnly')) : [];
  if (notScripts.length > 0) errors.push({ taskId: id, field: notScripts[0], message: `${where} ${notOnAScriptMessage(notScripts)}` });
  if (delegated) {
    if (!delegating) errors.push({ taskId: id, field: 'type', message: catalog.delegationRefusal ?? `${where} is a delegated task, and ${DELEGATION_UNAVAILABLE}.` });
    const extra = writtenForbiddenFields('delegated', raw);
    if (extra.length > 0) errors.push({ taskId: id, field: extra[0], message: `${where} ${notOnADelegatedMessage(extra)}` });
  }
  // A body's shape is judged here, where it is still what the planner wrote: a Task holds only a well-formed one.
  const body = bodyFields(raw, base);
  const shapeErrors = scriptBodyErrors({ type, ...body.raw }).filter((e) => body.malformed.has(e.field));
  for (const e of shapeErrors) errors.push({ taskId: id, field: e.field, message: `${where} ${e.message}` });
  // Its body's references are kept as written: an edit resolves them against the plan, a submitted plan names its own ids.
  const loop = loopSpec(raw.loop);
  if ('error' in loop) errors.push({ taskId: id, field: 'loop', message: `${where} ${loop.error}` });
  // A manual task stores no ops flag, so this is the one place it can still be seen.
  if (raw.ops === true && !ai && !script) errors.push({ taskId: id, field: 'ops', message: `${where} ${opsPlacementRefusal(type, !!parent)}` });
  if (raw.taskMode !== undefined && !script && !delegated) ignored.push({ taskId: id, field: 'taskMode', message: `${where}: ${MODE_NOT_THE_PLANNERS}` });
  if (type === 'user' && raw.readOnly === true) ignored.push({ taskId: id, field: 'readOnly', message: `${where}: ${MANUAL_NOT_READ_ONLY}` });
  const ops = raw.ops !== undefined ? raw.ops === true : base.ops;
  if (ai && ops && raw.readOnly === true) ignored.push({ taskId: id, field: 'readOnly', message: `${where}: ${OPS_NOT_READ_ONLY}` });
  // A read-only task's subtasks run as tasks of their own, so they would
  // otherwise get write access the planner said the work must not have.
  const asked = typeof raw.readOnly === 'boolean' ? raw.readOnly : undefined;
  const readOnly = ai && !ops && (asked ?? from?.readOnly ?? parent?.readOnly ?? false);
  if (raw.research !== undefined && typeof raw.research !== 'boolean') errors.push({ taskId: id, field: 'research', message: `${where}: "research" must be a boolean` });

  const assignedModel = ai || delegated ? modelOf(raw, base.assignedModel) : undefined;
  const slice = (value: unknown): 'AFK' | 'HITL' | undefined => (value === 'AFK' || value === 'HITL' ? value : undefined);
  // Explicit child values always win; inheritance only fills a gap, and only for `ai` tasks.
  const autonomy = ai ? slice(raw.autonomy) ?? base.autonomy ?? parent?.autonomy : undefined;
  const sliceType = slice(raw.sliceType) ?? base.sliceType ?? (ai ? parent?.sliceType : undefined);

  const subtasks: Task[] = [];
  if (Array.isArray(raw.subtasks)) {
    for (const s of raw.subtasks) {
      const child = plannedTask(s, catalog, { parent: { title, sliceType, autonomy, readOnly }, freshIds, newId });
      subtasks.push(child.task);
      errors.push(...child.errors);
      ignored.push(...child.ignored);
      adjustments.push(...child.adjustments);
      for (const [was, now] of child.renamed) renamed.set(was, now);
    }
  }

  const fields = {
    id,
    order: Number(raw.order ?? 0),
    title,
    description,
    type,
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : base.dependencies ?? [],
    // What a merge or split carries over for a runner is nothing a script runs.
    prompt: script || delegated ? undefined : text(raw.prompt) || base.prompt || (ai ? description || title || undefined : undefined),
    userSteps: Array.isArray(raw.userSteps)
      ? raw.userSteps.map((s) => (isRecord(s) ? s : {})).map((s) => ({ order: Number(s.order ?? 0), instruction: String(s.instruction ?? ''), completed: false }))
      : base.userSteps,
    subtasks,
    assignedModel,
    assignedRunner,
    autonomy,
    sliceType,
    userStoriesCovered: Array.isArray(raw.userStoriesCovered) ? raw.userStoriesCovered.map(String) : base.userStoriesCovered,
    ops: script || delegated ? undefined : ops,
    research: typeof raw.research === 'boolean' ? raw.research : base.research,
    skills: script || delegated ? undefined : from ? inheritedSkills(raw.skills, base.skills) : skillNames(raw.skills),
    ...body.fields,
    ...('loop' in loop && loop.loop ? { loop: loop.loop } : {}),
    ...(delegated ? delegatedFields(raw, base) : {}),
    ...(sealedScript ? { readOnly: true as const } : {}),
  };
  let taskMode = (TASK_KINDS[type].runsInMode || type === 'user') ? base.taskMode : undefined;
  let landedModel = assignedModel;
  if ((ai || delegated) && catalog.runners.includes(assignedRunner)) {
    const resolved = resolveAssignment({
      writer: catalog.models ? 'edit' : 'plan',
      task: { ...createTask(fields), taskMode },
      from: from ? { assignedRunner: base.assignedRunner ?? assignedRunner, assignedModel: base.assignedModel, taskMode: base.taskMode } : undefined,
      readOnly,
      catalog: { modelsByRunner: {}, ...catalog.models, runnerModes: catalog.runnerModes, autonomousDefault: catalog.autonomousDefault },
    });
    if (!resolved.ok) {
      // The planner names no mode: one it cannot have is about the read-only answer it gave (ADR-0031).
      errors.push({ taskId: id, field: resolved.field === 'taskMode' ? 'readOnly' : resolved.field, message: `${where}: ${resolved.error}` });
    } else {
      // A delegated task has no mode on the plan: a subplanner's is the planner's, and a repair's comes from its mandate (ADR-0055 D14).
      taskMode = delegated ? undefined : resolved.task.taskMode;
      landedModel = resolved.task.assignedModel;
      adjustments.push(...resolved.adjustments);
    }
  }
  // With no runner modes to read, `plan` is the guess that keeps a read-only task from writing.
  if (taskMode === undefined && readOnly && !catalog.runnerModes) taskMode = 'plan';

  const task = createTask({ ...fields, assignedModel: landedModel, taskMode });
  if (Array.isArray(raw.skills)) skillsAsked.set(task, raw.skills);
  return { task, errors, ignored, renamed, adjustments };
}

/** An AI task on a runner outside `runners`: what a plan accepted earlier is held to again where it lands, the runners enabled then being the ones that count. */
export function checkPlanRunners(tasks: readonly Task[], runners: readonly RunnerId[] | undefined): PlanTaskError[] {
  if (!runners) return [];
  return flattenTasksWithParents(tasks)
    .filter(({ task: t }) => TASK_KINDS[t.type].hasRunner && !runners.includes(t.assignedRunner))
    .map(({ task: t, parent }) => ({
      taskId: t.id,
      field: 'assignedRunner',
      message: `${taskWhere(t.title, parent?.title)} has invalid assignedRunner "${t.assignedRunner}". Expected one of: ${runners.join(', ')}`,
    }));
}

/**
 * The rules a plan's tasks are held to together, subtasks included, whichever
 * route they arrived by and whoever wrote them, the planner or the user.
 * `runners` are the ones the writer may put a task on (`assignableRunners`),
 * any when undefined; with `runnerModes`, an ops task is held off its
 * runner's read-only mode. A script task (ADR-0035) runs exactly one
 * well-formed body, at the top level, and carries nothing a runner would read.
 * A loop (ADR-0045) keeps its body for its check alone, on an acyclic graph.
 */
export function checkPlanInvariants(
  tasks: readonly Task[],
  runners: readonly RunnerId[] | undefined,
  runnerModes?: Partial<Record<RunnerId, readonly RunnerModeInfo[]>>,
  delegation: Pick<DelegationRules, 'canSeal'> = {},
): PlanTaskError[] {
  const rows = flattenTasksWithParents(tasks);
  const errors: PlanTaskError[] = [];
  const seen = new Set<string>();
  const body = new Set(tasks.flatMap((t) => t.loop?.body ?? []));
  for (const { task: t, parent } of rows) {
    const where = taskWhere(t.title, parent?.title);
    const fail = (field: string, message: string) => errors.push({ taskId: t.id, field, message });
    if (seen.has(t.id)) fail('id', `${where} has id "${t.id}", which another task in the plan has too: every task, subtasks included, needs an id of its own`);
    seen.add(t.id);
    if (t.research !== undefined && typeof t.research !== 'boolean') fail('research', `${where}: "research" must be a boolean`);
    // Research's approval exception is safe only under the shared read-only profile (ADR-0037 R1, R4).
    const readOnly = runnerModes ? taggedReadOnlyMode(runnerModes[t.assignedRunner]) : 'plan';
    if (t.research && (!TASK_KINDS[t.type].mayBeResearch || parent !== null || t.ops || body.has(t.id)
      || readOnly === undefined || t.taskMode !== readOnly)) {
      fail('research', `${where}: research is only for top-level read-only AI tasks, never a loop's body`);
    }
    if (t.autonomy === 'AFK' && t.userSteps && t.userSteps.length > 0) {
      fail('userSteps', `${where} has autonomy "AFK" but contains userSteps. AFK tasks must not have user touchpoints.`);
    }
    if (t.type === 'user' && t.sliceType && t.sliceType !== 'HITL') {
      fail('sliceType', `User ${where} has sliceType "${t.sliceType}". User tasks must have sliceType "HITL".`);
    }
    const opsRefused = t.ops && t.type !== 'script' ? opsPlacementRefusal(t.type, parent !== null) : null;
    if (opsRefused) fail('ops', `${where} ${opsRefused}`);
    if (t.type === 'script') {
      // It runs at the workspace root on its own (ADR-0035): nothing hangs under it, and it hangs under nothing.
      if (TASK_KINDS[t.type].topLevelOnly && parent !== null) fail('type', `${where} is a script task: only a top-level task can be one, as only a top-level task can be an ops task`);
      if (!TASK_KINDS[t.type].mayHaveSubtasks && t.subtasks?.length) fail('subtasks', `${where} is a script task, which has no subtasks: make each step a command of its own, or a task of its own`);
      const extra = presentForbiddenFields('script', t, ['assignedRunner', 'readOnly', 'subtasks']);
      if (extra.length > 0) fail(extra[0], `${where} ${notOnAScriptMessage(extra)}`);
    }
    if (t.type === 'delegated') {
      // Top-level like a script task, and its child plan's tasks are the child's own (ADR-0055 D1).
      if (TASK_KINDS[t.type].topLevelOnly && parent !== null) fail('type', `${where} is a delegated task: only a top-level task can be delegated`);
      if (!TASK_KINDS[t.type].mayHaveSubtasks && t.subtasks?.length) fail('subtasks', `${where} is a delegated task, which has no subtasks: its child plan's tasks are its child's own`);
    }
    for (const e of scriptBodyErrors(t)) fail(e.field, `${where} ${e.message}`);
    if (t.ops && t.taskMode !== undefined && t.taskMode === taggedReadOnlyMode(runnerModes?.[t.assignedRunner])) {
      fail('taskMode', `${where} is an ops task, which acts in the workspace, so it cannot use the read-only profile`);
    }
  }
  errors.push(...checkPlanRunners(tasks, runners));
  errors.push(...loopErrors(tasks));
  errors.push(...delegationErrors(tasks, { ...(runnerModes ? { runnerModes } : {}), ...delegation }));
  for (const { task: t, parent } of rows) {
    // Self-dependencies are reported with the cycle below, including its full path.
    for (const error of dependencyTargetErrors(tasks, t.id, t.dependencies.filter((id) => id !== t.id))) {
      errors.push({ taskId: t.id, field: 'dependencies', message: `${taskWhere(t.title, parent?.title)}: ${error}` });
    }
  }
  const cycle = findDependencyCycle(rows.map((r) => r.task));
  // Pinned to a task on the cycle: a plan whose only fault is a rule a task
  // breaks is worth naming back to the planner, not re-asking for as JSON.
  if (cycle) errors.push({ taskId: cycle[0].id, field: 'dependencies', message: `Dependency cycle detected: ${[...cycle, cycle[0]].map((t) => `"${t.title}"`).join(' → ')}` });
  return errors;
}

/** A rule `after` breaks, with what tells it apart from another breach. */
export interface PlanBreach {
  error: PlanTaskError;
  key: string;
}

/**
 * The rules `after` breaks that `before` did not, for either route of an edit:
 * what the plan already broke, a task on a runner switched off since, say,
 * never blocks an unrelated edit. A breach is told by its task and rule, not
 * its wording, which carries the title an edit may change; a runner's breach
 * by the runner too, as moving a task from one runner switched off to another
 * is the edit's own.
 */
export function newBreaches(
  before: readonly Task[],
  after: readonly Task[],
  runners: readonly RunnerId[] | undefined,
  runnerModes?: Partial<Record<RunnerId, readonly RunnerModeInfo[]>>,
): PlanBreach[] {
  const breaches = (tasks: readonly Task[]): PlanBreach[] => {
    const runnerOf = new Map(flattenTasksWithParents(tasks).map(({ task }) => [task.id, task.assignedRunner]));
    return checkPlanInvariants(tasks, runners, runnerModes).map((error) => {
      const runner = error.field === 'assignedRunner' ? `\u0000${runnerOf.get(error.taskId ?? '') ?? ''}` : '';
      return { error, key: `${error.taskId ?? ''}\u0000${error.field}${runner}` };
    });
  };
  const standing = new Set(breaches(before).map((b) => b.key));
  return breaches(after).filter((b) => !standing.has(b.key));
}

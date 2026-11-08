import { isTaskType, writtenForbiddenFields } from '../models/TaskKind';
import { opsFlag, skillNames, type RunnerId, type Task } from '../models/Task';
import { taskPlacement } from './PlanTree';
import { validateTaskEdit, type TaskEditActor } from './TaskEditValidator';
import { assignableRunners, resolveAssignment, type AssignmentAdjustment, type AssignmentCatalog } from './TaskAssignment';
import { DELEGATED_FIELDS, notOnADelegatedMessage } from '../models/Delegation';
import { notOnAScriptMessage, MODE_NOT_THE_PLANNERS, MANUAL_NOT_READ_ONLY, OPS_NOT_READ_ONLY } from './PlannedTask';
import { clearedBodyFields } from '../models/ScriptTask';
import { taggedReadOnlyMode } from './ModeResolver';

/**
 * A task as the planner writes it: its fields, less the mode, plus whether it
 * must not change files (ADR-0031), and `thinkingEffort` as a name for its
 * model's effort, so an effort can change without restating the model.
 */
export type PlannerTaskSpec = Partial<Task> & { readOnly?: boolean; thinkingEffort?: string | null };

/** Fields the planner may change on an existing task. Everything else (id, status, verdict…) is system-owned. */
export const UPDATABLE_FIELDS: (keyof Task)[] = [
  'title', 'description', 'prompt', 'dependencies', 'assignedRunner', 'assignedModel', 'taskMode', 'type', 'userSteps', 'autonomy', 'sliceType', 'ops', 'skills',
  'commands', 'script', 'timeoutMs', 'loop', 'research',
];

/** The fields that decide what a task runs on: the user's edit that touches none of them leaves the assignment as it stands. */
const ASSIGNMENT_FIELDS = ['assignedRunner', 'assignedModel', 'taskMode', 'type'] as const satisfies readonly (keyof Task)[];

/** The answer the planner gave to read-only or not, if it gave one (ADR-0031). */
export function askedReadOnly(spec: PlannerTaskSpec | undefined): boolean | undefined {
  return typeof spec?.readOnly === 'boolean' ? spec.readOnly : undefined;
}

export function isReadOnly(task: Task, catalog: Pick<AssignmentCatalog, 'runnerModes'> | undefined): boolean {
  return task.taskMode !== undefined && task.taskMode === taggedReadOnlyMode(catalog?.runnerModes?.[task.assignedRunner]);
}

/**
 * The fields of `raw` an edit may set, read as every entry point reads them.
 * A delegated task's goal, budget, grants, paths and scope are a list the
 * planner wrote for its child, and a raise of its budget the user grants by
 * approval (ADR-0056 M5): the direct route's are only `UPDATABLE_FIELDS`.
 */
function editableChanges(actor: TaskEditActor, raw: Partial<Task> | undefined): Partial<Task> {
  const changes: Partial<Task> = {};
  for (const key of actor === 'planner' ? [...UPDATABLE_FIELDS, ...DELEGATED_FIELDS] : UPDATABLE_FIELDS) {
    if (raw && key in raw) (changes as Record<string, unknown>)[key] = (raw as Record<string, unknown>)[key];
  }
  if ('ops' in changes) changes.ops = opsFlag(changes.ops);
  if ('skills' in changes) changes.skills = skillNames(changes.skills);
  return clearedBodyFields(changes);
}

/**
 * The fields an edit changed, as the planner names them: those it wrote, and
 * `readOnly` when that flipped, never the mode it landed on (ADR-0031) nor a
 * model the resolver put in, which is reported beside the edit instead.
 */
function changedFields(target: Task, written: Partial<Task>, landed: Partial<Task>, catalog: AssignmentCatalog): string[] {
  const fields = Object.keys(written).filter((f) => f !== 'taskMode');
  if (isReadOnly({ ...target, ...landed }, catalog) !== isReadOnly(target, catalog)) fields.push('readOnly');
  return fields;
}

/** What an edit is checked and resolved against. */
export interface TaskEditCatalog extends AssignmentCatalog {
  /** The runners enabled now, which only the planner's edit is held to (`assignableRunners`). */
  runners?: readonly RunnerId[];
}

export type PreparedTaskEdit =
  | {
    ok: true;
    target: Task;
    /** What lands. The planner's dependency and loop refs are still as it wrote them: resolving them is its route's. */
    changes: Partial<Task>;
    /** What the edit changed, as the planner's summary names it. */
    fields: string[];
    /** The fields a type flip or a new script body stripped, to be named wherever the edit is reported. */
    cleared: (keyof Task)[];
    adjustments: AssignmentAdjustment[];
  }
  | { ok: false; error: string };

/**
 * One task edit as it would land, for either route of CONTEXT.md's "Direct
 * edit vs planner edit": the fields it may set, the rules it meets, what its
 * runner, model, effort and mode resolve to, and the research it lifts. The
 * routes differ only by `actor`:
 *
 * - The planner's own vocabulary is refused or read here and nowhere else: a
 *   mode it never sets, a read-only answer or effort a script or delegated
 *   task cannot hold, `thinkingEffort` folded into the model, read-only on a
 *   manual or ops task (ADR-0031). Its edit is resolved as `edit`, on the
 *   runners enabled now; the user's as `user`, on any (ADR-0003).
 * - The lock is the planner's ({@link validateTaskEdit}), but for a rearm,
 *   its one sanctioned way into a task execution reached.
 * - A planner's dependency refs may name what a later op of its batch makes,
 *   so they are checked on the batch's final graph instead of here.
 *
 * The plan's rules over all its tasks, and whatever waits (skills, discovery,
 * the order edits to one task land in), are each route's.
 */
export function prepareTaskEdit(
  actor: TaskEditActor,
  tasks: readonly Task[],
  taskId: string,
  raw: PlannerTaskSpec | undefined,
  catalog: TaskEditCatalog,
  options: { rearm?: boolean } = {},
): PreparedTaskEdit {
  const target = taskPlacement(tasks, taskId)?.task;
  if (!target) return { ok: false, error: 'Task not found' };
  const planner = actor === 'planner';
  if (planner && raw) {
    // What only a runner would read, and that never lands on a task, is refused here for a script (ADR-0035).
    // A type no kind owns is refused with the rest of the type checks, in validateTaskEdit.
    const kind = isTaskType(raw.type) ? raw.type : target.type;
    const planners = writtenForbiddenFields(kind, raw, 'plannerEdit');
    if (kind === 'script' && planners.length > 0) return { ok: false, error: `"${target.title}" ${notOnAScriptMessage(planners)}` };
    if (target.type === 'delegated' && planners.length > 0) return { ok: false, error: `"${target.title}" ${notOnADelegatedMessage(planners)}` };
    if ('taskMode' in raw) return { ok: false, error: MODE_NOT_THE_PLANNERS };
  }
  const asked = editableChanges(actor, raw);
  if (planner && raw && 'thinkingEffort' in raw) {
    const model = asked.assignedModel ?? target.assignedModel;
    if (!model) return { ok: false, error: `"thinkingEffort" is the assigned model's — set "assignedModel" with it` };
    asked.assignedModel = { ...model, thinkingEffort: raw.thinkingEffort ?? undefined };
  }
  const checked: Partial<Task> = { ...asked };
  if (planner) delete checked.dependencies;
  const check = validateTaskEdit(planner && !options.rearm ? 'planner' : 'direct', tasks, taskId, checked);
  if (!check.ok) return { ok: false, error: check.error ?? 'Those changes are not valid' };
  const changes: Partial<Task> = { ...asked };
  for (const field of check.clear ?? []) (changes as Record<string, unknown>)[field] = undefined;
  Object.assign(changes, check.set);

  const readOnly = planner ? askedReadOnly(raw) : undefined;
  if (readOnly === true && (changes.type ?? target.type) === 'user') return { ok: false, error: MANUAL_NOT_READ_ONLY };
  if (planner && (changes.ops ?? target.ops) && (readOnly ?? isReadOnly(target, catalog))) return { ok: false, error: OPS_NOT_READ_ONLY };

  const landed: Partial<Task> = { ...changes };
  const adjustments: AssignmentAdjustment[] = [];
  // The planner's every edit is resolved as it is written (ADR-0003's `edit`), as it always was.
  if (planner || ASSIGNMENT_FIELDS.some((f) => f in changes)) {
    const writer = planner ? 'edit' : 'user';
    const written = { ...target, ...changes };
    // A runner the writer may not use has nothing to resolve against; the plan's rules refuse it once the edit lands.
    // One the task already had stands, switched off since or not, and is resolved as it is.
    const allowed = assignableRunners(writer, catalog.runners ?? []);
    const kept = target.type === 'ai' && written.assignedRunner === target.assignedRunner;
    if (!allowed || written.type !== 'ai' || kept || allowed.includes(written.assignedRunner)) {
      const resolved = resolveAssignment({ writer, task: written, before: target, readOnly, catalog });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      if (resolved.task.assignedModel !== written.assignedModel) landed.assignedModel = resolved.task.assignedModel;
      if (resolved.task.taskMode !== written.taskMode) landed.taskMode = resolved.task.taskMode;
      adjustments.push(...resolved.adjustments);
    }
  }
  // Research holds only under the read-only profile (ADR-0037): an edit that leaves it ends the research, unless it asks for research again.
  const runner = landed.assignedRunner ?? target.assignedRunner;
  if (target.research && asked.research !== true && (readOnly === false
    || (landed.taskMode !== undefined && landed.taskMode !== taggedReadOnlyMode(catalog.runnerModes?.[runner])))) landed.research = false;
  // `null` drops the loop, and the round it was in with it (ADR-0045).
  if ('loop' in changes && (changes.loop === null || changes.loop === undefined)) landed.loopRound = undefined;
  return { ok: true, target, changes: landed, fields: changedFields(target, changes, landed, catalog), cleared: check.clear ?? [], adjustments };
}

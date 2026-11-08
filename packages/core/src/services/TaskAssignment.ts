import type { DiscoveredModel, RunnerId, Task, TaskModelAssignment } from '../models/Task';
import { clampThinkingEffort, effectiveAllowlist } from './ModelAllowlistResolver';
import { plannedMode, readOnlyMode, readOnlyRunners, taggedReadOnlyMode, unavailableModeReason, type RunnerModeInfo } from './ModeResolver';

/**
 * Who writes a task's assignment. It decides what a model the writer names
 * meets where the task's runner does not offer it or the allowlist excludes it
 * (ADR-0003), which runners it may put a task on, and whether a live runner's
 * hold applies (ADR-0041):
 *
 * - `plan`: a whole plan the planner submitted, and every planner task as it
 *   lands. A stray model is replaced, and the planner is told what moved.
 * - `edit`: the planner's edit. A stray model is refused, which the planner
 *   answers in the same reply.
 * - `user`: a user's direct edit. A stray model is refused, with the reason.
 * - `userAdd`: a task the user adds. A stray model is replaced, and the user
 *   is told what moved.
 * - `runner`: a switch made with the runner's own `/model`, written as the
 *   user's edit. The runner already runs it, so neither the allowlist nor the
 *   live runner's hold applies.
 */
export type AssignmentWriter = 'plan' | 'edit' | 'user' | 'userAdd' | 'runner';

/**
 * What an assignment is resolved against: the discovered models, the manifest
 * modes and the allowlist, as the session holds them when the write lands —
 * the same catalog the planner's per-turn block shows, so nothing is refused
 * that the planner was never told about.
 */
export interface AssignmentCatalog {
  /** A runner absent, or listed with nothing, has models discovery could not find, not none. */
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>;
  /** Absent when no runner's modes are known: no mode is then derived. */
  runnerModes?: Partial<Record<RunnerId, readonly RunnerModeInfo[]>>;
  /** Raw (unfiltered) allowlist, keyed by runner; read through {@link effectiveAllowlist}. */
  perRunnerAllowlist?: Partial<Record<RunnerId, string[]>>;
  /** Full (true) or Guarded: the mode a derived task lands on unless it is read-only (ADR-0001). Full when absent. */
  autonomousDefault?: boolean;
  /**
   * Whether a task's runner is live: an attempt of it is claimed, running,
   * quiet or waiting on someone. Its model, effort and runner are then that
   * runner's (ADR-0041): the process was started on them, and only the
   * runner's own command moves them. Absent means none is.
   */
  liveRunner?: (taskId: string) => boolean;
}

/** What a runner offers a task, as discovery and its manifest have it. */
export interface RunnerCatalog {
  models: DiscoveredModel[];
  modes: RunnerModeInfo[];
}

/** A change the resolver made to what was written, named so it is never silent (ADR-0001). */
export interface AssignmentAdjustment {
  taskId: string;
  title: string;
  field: 'assignedModel' | 'thinkingEffort';
  from: string | null;
  to: string | null;
}

export interface AssignmentWrite {
  writer: AssignmentWriter;
  /** The task as written: the plan's task with the edit laid over it, or a new task. Its subtasks are not read. */
  task: Task;
  /** The task as the plan holds it; absent for a new task. */
  before?: Task;
  /**
   * What a new task is made from — the task a split part or merge starts
   * as. Its runner and model are read as `before`'s are: a part moved to
   * another runner carries a model chosen for the old one.
   */
  from?: Pick<Task, 'assignedRunner' | 'assignedModel' | 'taskMode'>;
  /** The planner's answer to read-only or not (ADR-0001). Absent, the task stays as it was. */
  readOnly?: boolean;
  catalog: AssignmentCatalog;
}

export type AssignmentOutcome =
  | { ok: true; task: Task; adjustments: AssignmentAdjustment[] }
  | { ok: false; field: 'assignedRunner' | 'assignedModel' | 'taskMode'; error: string };

/**
 * Why a task's model or effort cannot change while its runner is live, for
 * every writer but the runner itself. The plan follows a switch made with the
 * runner's own command instead (ADR-0041), so that is offered beside stopping it.
 */
export function liveModelRefusal(task: Pick<Task, 'title'>): string {
  return `"${task.title}" has a live runner, so its model and effort cannot change now: stop the task first, or use the runner's own /model`;
}

/**
 * Why a task cannot move to another runner while its runner is live: the move
 * re-derives the model from the new runner, under the same hold as
 * {@link liveModelRefusal}, and no runner's own command can make it.
 */
export function liveRunnerRefusal(task: Pick<Task, 'title'>): string {
  return `"${task.title}" has a live runner, so its runner cannot change now: stop the task first`;
}

/**
 * The runners a writer may put a task on (ADR-0003, V1): the planner's, a
 * submitted plan or an edit, the runners enabled now; a user any runner.
 * Undefined means any. A task an edit leaves on a runner switched off since is
 * not put there by the edit, so it stands (`applyTaskOps`, ADR-0043).
 */
export function assignableRunners(writer: AssignmentWriter, enabled: readonly RunnerId[]): RunnerId[] | undefined {
  if (writer === 'plan' || writer === 'edit') return [...enabled];
  return undefined;
}

function sameAssignment(a: TaskModelAssignment | undefined, b: TaskModelAssignment | undefined): boolean {
  return a?.modelId === b?.modelId && a?.thinkingEffort === b?.thinkingEffort;
}

/** Whether `mode` selects Ordewell's read-only profile on this runner (ADR-0046). */
function readOnlyOn(mode: string | undefined, runner: RunnerId, catalog: AssignmentCatalog): boolean {
  return mode !== undefined && mode === taggedReadOnlyMode(catalog.runnerModes?.[runner]);
}

/**
 * The task's mode as written. The writer's own pick stands where the runner
 * offers it; otherwise a task the writer creates, moves, turns into an AI task
 * or says read-only or not of gets the mode the planner path gives it
 * (ADR-0001's fill-in table): its read-only mode, else the mode it has when
 * the runner offers it, else the runner's mode for the level. Silence keeps
 * what is, so a mode the user picked by hand survives every other edit.
 */
function modeFor(write: AssignmentWrite, task: Task, moved: boolean): { ok: true; mode: string | undefined } | { ok: false; error: string } {
  const { writer, before, catalog } = write;
  const prior = before ?? write.from;
  const runner = task.assignedRunner;
  const modes = catalog.runnerModes?.[runner];
  const picked = (writer === 'user' || writer === 'userAdd') && task.taskMode !== undefined && task.taskMode !== prior?.taskMode;
  if (picked) {
    if (modes && modes.length > 0 && !modes.some((m) => m.id === task.taskMode)) {
      return { ok: false, error: `Runner "${runner}" has no task mode "${task.taskMode}": valid modes: ${modes.map((m) => m.id).join(', ')}` };
    }
    const unavailable = unavailableModeReason(modes, task.taskMode);
    if (unavailable) return { ok: false, error: `Mode "${task.taskMode}" of runner "${runner}" is unavailable on this host: ${unavailable}` };
    return { ok: true, mode: task.taskMode };
  }
  const becameAi = before !== undefined && before.type !== 'ai';
  if (writer === 'runner' || !catalog.runnerModes || (before && !moved && !becameAi && write.readOnly === undefined)) return { ok: true, mode: task.taskMode };
  // A move carries the old runner's mode id, which says read-only only on that runner.
  const carried = prior !== undefined && task.taskMode === prior.taskMode && readOnlyOn(prior.taskMode, prior.assignedRunner, catalog);
  const readOnly = write.readOnly ?? (carried || readOnlyOn(task.taskMode, runner, catalog));
  if (readOnly && !readOnlyMode(modes) && writer !== 'plan' && writer !== 'edit') {
    const reason = unavailableModeReason(modes, taggedReadOnlyMode(modes));
    const able = readOnlyRunners(catalog.runnerModes).filter((r) => r !== runner);
    return {
      ok: false,
      error: `"${task.title}" is read-only, and runner "${runner}" has no read-only mode${reason ? ' available on this host' : ''}: give it another mode first${able.length > 0 ? `, or move it to one of: ${able.join(', ')}` : ''}${reason ? `. ${reason}` : ''}`,
    };
  }
  const mode = plannedMode(runner, catalog.runnerModes, { readOnly, current: task.taskMode }, catalog.autonomousDefault ?? false);
  return mode.ok ? { ok: true, mode: mode.mode ?? task.taskMode } : mode;
}

/**
 * Resolve what one task runs on — its runner, model, thinking effort and mode
 * — for whichever writer wrote it. Every writer calls this, so they cannot
 * disagree. Returns the task with what it resolved, and each change made to
 * what was written, named; or a refusal.
 *
 * - **The live runner's hold.** While its runner is live a task's runner,
 *   model and effort are that runner's (ADR-0041): any other writer is
 *   refused a change, a model cleared as much as one replaced.
 * - **A model is its runner's.** A model the writer left alone stays, even off
 *   the allowlist: the allowlist shapes what is written, not a model the user
 *   switched to (ADR-0043). A model the task carries from another runner — a
 *   move, or a part made from a task on another one — stays only where its new
 *   runner lists it, or nothing is known against it, and the allowlist admits
 *   it. A model the writer names is held to the runner and the allowlist as
 *   its {@link AssignmentWriter} row says: the runner already runs it
 *   (`runner`), or it is refused (`edit`, `user`), or replaced (`plan`,
 *   `userAdd`) when only another runner lists it (it provably cannot run here)
 *   or the allowlist excludes it. A model listed by no runner is not one any
 *   runner disowns, so it stands, and the runner validates last.
 * - **Filling a model.** A missing, carried-off or replaced model is refilled
 *   from the runner: the allowlist's first model the runner lists, else the
 *   allowlist's first, else the runner's own first, else none, which the
 *   runner fills with its own default.
 * - **Effort follows its model.** Whenever the model is listed, its effort is
 *   held to what it offers ({@link clampThinkingEffort}, the one mapping rule:
 *   the nearest level the model has, none when it has none); a model put in
 *   here that discovery does not list gets none. A model discovery does not
 *   list keeps the effort written with it, which the runner validates.
 * - **The mode** is the writer's pick where it has one, else derived as
 *   {@link modeFor} says.
 *
 * Which runners a writer may use is the plan's rule ({@link assignableRunners},
 * `checkPlanInvariants`); this never moves a task to another runner.
 */
export function resolveAssignment(write: AssignmentWrite): AssignmentOutcome {
  const { writer, before, catalog } = write;
  const written = write.task;
  const prior = before ?? write.from;
  const moved = prior !== undefined && prior.assignedRunner !== written.assignedRunner;
  const title = (before ?? written).title;

  const live = writer !== 'runner' && !!before && !!catalog.liveRunner?.(before.id);
  if (live && moved) return { ok: false, field: 'assignedRunner', error: liveRunnerRefusal({ title }) };
  if (live && !sameAssignment(before?.assignedModel, written.assignedModel)) return { ok: false, field: 'assignedModel', error: liveModelRefusal({ title }) };
  // A manual task runs on nothing, and a script task on no runner (ADR-0035).
  if (written.type !== 'ai' && written.type !== 'delegated') return { ok: true, task: written, adjustments: [] };

  // A delegated task's runner runs a planner, in no mode the plan holds (ADR-0055 D14).
  const mode = written.type === 'delegated' ? { ok: true as const, mode: undefined } : modeFor(write, written, moved);
  if (!mode.ok) return { ok: false, field: 'taskMode', error: mode.error };

  // A live runner holds its model and effort as they are, even where its model's levels have changed since.
  const model: ModelResult = live ? { ok: true, assignment: written.assignedModel } : modelFor(write, moved);
  if (!model.ok) return { ok: false, field: 'assignedModel', error: model.error };

  const task = model.assignment === written.assignedModel && mode.mode === written.taskMode
    ? written
    : { ...written, assignedModel: model.assignment, taskMode: mode.mode };
  const adjustments: AssignmentAdjustment[] = [];
  const note = (field: AssignmentAdjustment['field'], from: string | undefined, to: string | undefined) => {
    if ((from ?? null) !== (to ?? null)) adjustments.push({ taskId: written.id, title: written.title, field, from: from ?? null, to: to ?? null });
  };
  note('assignedModel', written.assignedModel?.modelId, task.assignedModel?.modelId);
  note('thinkingEffort', written.assignedModel?.thinkingEffort, task.assignedModel?.thinkingEffort);
  return { ok: true, task, adjustments };
}

type ModelResult = { ok: true; assignment: TaskModelAssignment | undefined } | { ok: false; error: string };

/** The model half of {@link resolveAssignment}. */
function modelFor(write: AssignmentWrite, moved: boolean): ModelResult {
  const { writer, before, catalog } = write;
  const prior = before ?? write.from;
  const written = write.task.assignedModel;
  const runner = write.task.assignedRunner;
  const models = catalog.modelsByRunner;
  const own = models[runner] ?? [];
  const listing = (id: string) => own.find((m) => m.modelId === id);
  // A model the task ran with on another runner is evidence that runner lists it, which the allowlist is read with (R1).
  const carriedFrom = moved && written && prior?.assignedModel?.modelId === written.modelId ? prior.assignedRunner : undefined;
  const seen = carriedFrom && written && !models[carriedFrom]?.some((m) => m.modelId === written.modelId)
    ? { ...models, [carriedFrom]: [...(models[carriedFrom] ?? []), { modelId: written.modelId, modelLabel: written.modelLabel, variants: [] }] }
    : models;
  const allowed = effectiveAllowlist(catalog.perRunnerAllowlist?.[runner], runner, seen);
  const allows = (id: string) => !allowed || allowed.includes(id);

  // Held to what its model offers, unless that model is one discovery does not list.
  const settled = (assignment: TaskModelAssignment): TaskModelAssignment => {
    const known = listing(assignment.modelId);
    if (!known) return assignment;
    const thinkingEffort = clampThinkingEffort(assignment.thinkingEffort, known.variants);
    const availableVariants = known.variants.map((v) => v.id);
    if (thinkingEffort === assignment.thinkingEffort && assignment.availableVariants?.join() === availableVariants.join()) return assignment;
    const next: TaskModelAssignment = { ...assignment, availableVariants };
    if (thinkingEffort === undefined) delete next.thinkingEffort;
    else next.thinkingEffort = thinkingEffort;
    return next;
  };
  // The allowlist's order is its priority, among the models the runner lists
  // first; an allowlisted id discovery does not list still beats one the user excluded (R1).
  const refill = (effort: string | undefined): TaskModelAssignment | undefined => {
    const id = allowed?.find((a) => listing(a)) ?? allowed?.[0] ?? own[0]?.modelId;
    if (id === undefined) return undefined;
    const known = listing(id);
    const thinkingEffort = clampThinkingEffort(effort, known?.variants ?? []);
    return {
      modelId: id,
      modelLabel: known?.modelLabel ?? id,
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
      ...(known ? { availableVariants: known.variants.map((v) => v.id) } : {}),
    };
  };

  if (!written) return { ok: true, assignment: writer === 'runner' ? undefined : refill(undefined) };
  if (writer === 'runner') return { ok: true, assignment: settled(written) };

  const id = written.modelId;
  const same = prior?.assignedModel?.modelId === id;
  if (before && same && !moved) return { ok: true, assignment: settled(written) };

  const listedElsewhere = Object.entries(models).some(([other, list]) => other !== runner && list?.some((m) => m.modelId === id));
  if (same) {
    // Carried from a task on another runner, it was chosen for that one: it
    // needs this one's listing, or nothing known against it.
    const fits = !moved || !!listing(id) || (own.length === 0 && !listedElsewhere);
    return { ok: true, assignment: fits && allows(id) ? settled(written) : refill(written.thinkingEffort) };
  }

  if (writer === 'edit' || writer === 'user') {
    // Allowlisted ids are kept even unlisted (ADR-0003, R1); an empty list is discovery that found nothing.
    const offered = own.length === 0 || !!listing(id) || !!allowed?.includes(id);
    if (!offered) return { ok: false, error: `Runner "${runner}" does not offer model "${id}"` };
    if (!allows(id)) return { ok: false, error: `Model "${id}" is excluded by the allowlist for runner "${runner}"` };
    return { ok: true, assignment: settled(written) };
  }
  // Only another runner lists it: it provably cannot run here.
  const disowned = !listing(id) && listedElsewhere;
  return { ok: true, assignment: disowned || !allows(id) ? refill(written.thinkingEffort) : settled(written) };
}

/**
 * The planner's tasks as they land, subtasks included: each resolved as the
 * planner's ({@link resolveAssignment}, `plan`) against the catalog read now
 * and against the plan's task of the same id, so a model or allowlist that
 * changed since the write was checked is applied and named. A task the
 * planner left alone keeps its model; one whose runner is live keeps all of
 * its assignment. Modes were decided when the task was written, and are not
 * revisited. Nothing is refused here: a write the catalog no longer allows is
 * kept as it was written, and the runner validates last.
 */
export function resolveAssignments(
  tasks: readonly Task[],
  planned: readonly Task[],
  catalog: AssignmentCatalog,
): { tasks: Task[]; adjustments: AssignmentAdjustment[] } {
  const prior = new Map<string, Task>();
  const index = (list: readonly Task[]) => list.forEach((t) => { prior.set(t.id, t); index(t.subtasks ?? []); });
  index(planned);
  const models = { ...catalog, runnerModes: undefined };
  const adjustments: AssignmentAdjustment[] = [];
  const walk = (list: readonly Task[]): Task[] => list.map((task) => {
    const outcome = resolveAssignment({ writer: 'plan', task, before: prior.get(task.id), catalog: models });
    const resolved = outcome.ok ? outcome.task : task;
    if (outcome.ok) adjustments.push(...outcome.adjustments);
    return { ...resolved, subtasks: walk(task.subtasks ?? []) };
  });
  return { tasks: walk(tasks), adjustments };
}

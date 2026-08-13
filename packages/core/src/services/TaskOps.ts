import { v4 as uuidv4 } from 'uuid';
import {
  Task, RunnerId, flattenTasks,
  addTaskToPlan, removeTaskFromPlan, updateTaskInPlan, renumberTasks,
  createTask,
} from '../models/Task';
import { extractObjectsWithKey, stripTrailingCommas, escapeControlCharsInStrings, PlanParseError, TASK_OPS_ENVELOPE_KEY } from './JsonExtractor';
import { validateTaskEdit, checkModelAndModeValidity, type EditCatalog } from './TaskEditValidator';

/**
 * Targeted task edits emitted by the planner conversation (the 'task_ops'
 * ConversationTurn). Task references accept a task id, a "#<order>" ref, or a
 * bare order number — cheap models rarely echo UUIDs correctly.
 */
export type TaskOp =
  | { op: 'update'; taskId: string; changes: Partial<Task> }
  | { op: 'add'; task: Partial<Task>; handle?: string }
  | { op: 'remove'; taskId: string }
  | { op: 'reorder'; taskIds: string[] }
  | { op: 'merge'; taskIds: string[]; merged: Partial<Task>; handle?: string }
  | { op: 'split'; taskId: string; parts: Partial<Task>[]; handle?: string }
  | { op: 'rearm'; taskId: string; changes?: Partial<Task> };

/** Fields the planner may change on an existing task. Everything else (id, status, verdict…) is system-owned. */
export const UPDATABLE_FIELDS: (keyof Task)[] = [
  'title', 'description', 'prompt', 'dependencies', 'assignedRunner', 'assignedModel', 'taskMode', 'thinkingEffort', 'type', 'userSteps', 'autonomy', 'sliceType',
];

export function textHasTaskOps(text: string): boolean {
  return text.includes(`"${TASK_OPS_ENVELOPE_KEY}"`);
}

/** Parse a `{"taskOps":[...]}` reply. Throws PlanParseError when the JSON is unusable. */
export function parseTaskOpsJson(text: string): TaskOp[] {
  // Extract by the taskOps key specifically — a reply may also carry a
  // tasks-keyed object (schema echo, example), which must not shadow the ops.
  // Candidates are tried back to front: the last emission is the final answer.
  const { matches, fallback } = extractObjectsWithKey(text, TASK_OPS_ENVELOPE_KEY);
  const candidates = matches.length > 0 ? [...matches].reverse() : [fallback.json];

  let lastError: PlanParseError | null = null;
  for (const json of candidates) {
    try {
      return parseTaskOpsObject(json, text);
    } catch (err) {
      if (!(err instanceof PlanParseError)) throw err;
      if (!lastError) lastError = err;
    }
  }
  throw lastError ?? new PlanParseError('No JSON object found in task-ops reply', text);
}

function parseTaskOpsObject(json: string, text: string): TaskOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(escapeControlCharsInStrings(stripTrailingCommas(json)));
  } catch (err) {
    throw new PlanParseError(`Task-ops JSON is invalid: ${err instanceof Error ? err.message : String(err)}`, text);
  }
  const ops = (parsed as { taskOps?: unknown }).taskOps;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new PlanParseError('"taskOps" must be a non-empty array', text);
  }
  for (const op of ops) {
    if (typeof op !== 'object' || op === null || typeof (op as { op?: unknown }).op !== 'string') {
      throw new PlanParseError('Every task op needs an "op" field (update | add | remove | reorder | merge | split)', text);
    }
  }
  return ops as TaskOp[];
}

type RefResolution = { id: string } | { error: string };

/**
 * Resolve a task reference (id, "#3", "3", or a batch handle) to a task id.
 *
 * `#order` and title matches are pinned to `originalScope` — the plan as it
 * stood before the batch began — so an earlier op's renumbering can never
 * make a later op's "#4" land on a different task than the planner saw. A
 * literal id has no such drift (ids are stable across mutations), so id
 * matches check `liveScope` — the batch's current, mutated tasks — which is
 * also how a later op reaches a task created earlier in the same batch
 * without a handle (e.g. a split's own chained parts).
 */
function resolveRef(
  ref: unknown,
  originalScope: Task[],
  liveScope: Task[],
  handleOwner: Map<string, number>,
  handleId: Map<string, string>,
  opIndex: number,
): RefResolution {
  if (typeof ref !== 'string' && typeof ref !== 'number') return { error: `invalid reference "${String(ref)}"` };
  const s = String(ref).trim();

  const ownerIdx = handleOwner.get(s);
  if (ownerIdx !== undefined) {
    if (ownerIdx >= opIndex) {
      return { error: `handle "${s}" is defined later in this batch (op ${ownerIdx + 1}) and cannot be referenced yet` };
    }
    const id = handleId.get(s);
    if (!id) return { error: `handle "${s}" was never resolved` };
    return { id };
  }

  const byLiveId = liveScope.find((t) => t.id === s);
  if (byLiveId) return { id: byLiveId.id };
  const orderStr = s.startsWith('#') ? s.slice(1) : s;
  if (/^\d+$/.test(orderStr)) {
    const order = Number(orderStr);
    const byOrder = originalScope.filter((t) => t.order === order);
    if (byOrder.length === 1) return { id: byOrder[0].id };
  }
  const byTitle = originalScope.find((t) => t.title === s);
  if (byTitle) return { id: byTitle.id };
  return { error: `task "${s}" not found` };
}

/** Whether `name` already denotes an existing task by id, `#order`, or title. */
function refCollidesWithExisting(name: string, originalFlatAll: Task[]): boolean {
  if (originalFlatAll.some((t) => t.id === name)) return true;
  const orderStr = name.startsWith('#') ? name.slice(1) : name;
  if (/^\d+$/.test(orderStr) && originalFlatAll.some((t) => t.order === Number(orderStr))) return true;
  return originalFlatAll.some((t) => t.title === name);
}

function findInTasks(tasks: Task[], id: string): Task | undefined {
  return flattenTasks(tasks).find((t) => t.id === id);
}

function findTopLevel(tasks: Task[], id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

function detectCycle(tasks: Task[]): string | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): string | null => {
    if (done.has(id)) return null;
    if (visiting.has(id)) return id;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      const hit = visit(dep);
      if (hit) return hit;
    }
    visiting.delete(id);
    done.add(id);
    return null;
  };
  for (const t of tasks) {
    const hit = visit(t.id);
    if (hit) return byId.get(hit)?.title ?? hit;
  }
  return null;
}

/** A task the repair may not reposition: execution has already reached it. */
function isPinned(t: Task): boolean {
  return t.status === 'in_progress' || t.status === 'completed';
}

/**
 * Reorder top-level tasks so every dependency comes before its dependents,
 * moving as little as possible: pinned tasks keep the exact slot they are in,
 * and each free slot goes to the earliest-listed movable task whose
 * dependencies are already placed — so tasks the graph does not constrain keep
 * their relative order. Assumes an acyclic graph (the caller checks first).
 */
function repairOrder(tasks: Task[]): { tasks: Task[] } | { error: string } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const placed = new Set<string>();
  const movable = tasks.filter((t) => !isPinned(t));
  const result: Task[] = [];
  // Dependencies outside this list (a subtask id) constrain nothing here.
  const blockerOf = (t: Task): Task | undefined => {
    const id = t.dependencies.find((d) => byId.has(d) && !placed.has(d));
    return id ? byId.get(id) : undefined;
  };
  const place = (t: Task) => { result.push(t); placed.add(t.id); };

  for (const occupant of tasks) {
    if (isPinned(occupant)) {
      const blocker = blockerOf(occupant);
      if (blocker) return { error: pinnedRefusal(blocker, occupant, 'before') };
      place(occupant);
      continue;
    }
    const next = movable.findIndex((t) => !blockerOf(t));
    if (next < 0) {
      // Nothing is schedulable and the graph is acyclic, so every movable task
      // left waits — directly or through others — on a pinned task further down
      // that would have to come up to free this slot.
      const [stuck, pin] = trailToPin(movable[0], blockerOf);
      return { error: pinnedRefusal(stuck, pin, 'after') };
    }
    place(movable.splice(next, 1)[0]);
  }
  return { tasks: result };
}

/** Walk the waiting-on chain from `task` down to the pinned task holding it up. */
function trailToPin(task: Task, blockerOf: (t: Task) => Task | undefined): [Task, Task] {
  let at = task;
  for (;;) {
    const blocker = blockerOf(at);
    if (!blocker || isPinned(blocker)) return [at, blocker ?? at];
    at = blocker;
  }
}

/** `"B" #2→#1, "A" #1→#3` for every task the repair actually moved, or null. */
function describeMoves(before: Task[], after: Task[]): string | null {
  const wasAt = new Map(before.map((t, i) => [t.id, i + 1]));
  const moved = after
    .map((t, i) => ({ t, from: wasAt.get(t.id)!, to: i + 1 }))
    .filter((m) => m.from !== m.to);
  return moved.length ? moved.map((m) => `"${m.t.title}" #${m.from}→#${m.to}`).join(', ') : null;
}

function pinnedRefusal(other: Task, pin: Task, side: 'before' | 'after'): string {
  const word = pin.status === 'in_progress' ? 'running' : 'completed';
  return `"${other.title}" would have to run ${side} "${pin.title}", which is ${word} and cannot be moved`;
}

export interface ApplyTaskOpsResult {
  ok: boolean;
  tasks: Task[];
  errors: string[];
  /** Human-readable summary of what changed, for the chat transcript. */
  summary: string[];
}

/**
 * Pre-flight check for a merge: would collapsing the selected tasks into one
 * (rewiring every dependent of any selected task to the survivor) keep the
 * dependency graph valid? Rejects locked tasks and merges whose rewiring would
 * introduce a cycle. Display order is NOT checked here — neither
 * consecutiveness (a UI concern) nor a dependency the merge pulls out of order,
 * which {@link applyTaskOps} repairs; refusing on order would make this
 * pre-flight stricter than the applier it stands in for.
 */
export function canMergeTasks(tasks: Task[], selectedIds: string[]): { ok: boolean; error?: string } {
  if (selectedIds.length < 2) return { ok: false, error: 'Select at least two tasks to merge' };
  const idSet = new Set(selectedIds);
  const toMerge = tasks.filter((t) => idSet.has(t.id));
  if (toMerge.length < 2) return { ok: false, error: 'At least two valid tasks are required to merge' };
  for (const t of toMerge) {
    if (t.status === 'in_progress') return { ok: false, error: `"${t.title}" is running and cannot be merged` };
    if (t.status === 'completed') return { ok: false, error: `"${t.title}" is completed and cannot be merged` };
  }
  const ordered = [...toMerge].sort((a, b) => a.order - b.order);
  const survivorId = '__merge_sim__';
  const sim: Task[] = tasks
    .filter((t) => !idSet.has(t.id))
    .map((t) => ({ ...t, dependencies: t.dependencies.map((d) => (idSet.has(d) ? survivorId : d)).filter((d) => d !== t.id) }));
  const unionDeps = [...new Set(toMerge.flatMap((t) => t.dependencies))].filter((d) => !idSet.has(d));
  sim.push({ ...ordered[0], id: survivorId, title: '__merge_sim__', order: ordered[0].order, dependencies: unionDeps });
  const cycle = detectCycle(sim);
  if (cycle) return { ok: false, error: `Merging would create a dependency cycle involving "${cycle}"` };
  return { ok: true };
}

/**
 * The shape the dependency helpers below read. Structural rather than `Task`,
 * because the TUI projects tasks into its own `TaskView`: a surface's
 * dependency picker and the API's validation must agree on which dependencies
 * are legal, and a signature only core can satisfy would have forced the TUI
 * to keep a second copy of the rule.
 */
export interface TaskRef {
  id: string;
  order: number;
  title: string;
  dependencies: string[];
}

/** The tasks listing `taskId` as a dependency — exactly what removing it detaches. */
export function dependentsOf<T extends Pick<TaskRef, 'id' | 'dependencies'>>(tasks: T[], taskId: string): T[] {
  return tasks.filter((t) => t.id !== taskId && t.dependencies.includes(taskId));
}

/**
 * The tasks that may become dependencies of `taskId`: those displayed before it.
 *
 * Offering only earlier tasks is what keeps a hand-edited graph valid without a
 * cycle check — dependencies then only ever point backwards in display order,
 * the same invariant `applyTaskOps` enforces. Omit `taskId` for a task that does
 * not exist yet: it lands last, so every current task is a candidate.
 */
export function dependencyCandidates<T extends Pick<TaskRef, 'id' | 'order'>>(tasks: T[], taskId?: string): T[] {
  if (!taskId) return [...tasks];
  const target = tasks.find((t) => t.id === taskId);
  return target ? tasks.filter((t) => t.order < target.order) : [];
}

/** Pre-flight check for a hand-edited dependency list: every id exists and comes earlier. */
export function canSetDependencies<T extends TaskRef>(
  tasks: T[],
  taskId: string,
  dependencies: string[],
): { ok: boolean; error?: string } {
  const target = tasks.find((t) => t.id === taskId);
  if (!target) return { ok: false, error: 'Task not found' };
  const allowed = new Set(dependencyCandidates(tasks, taskId).map((t) => t.id));
  for (const dep of dependencies) {
    if (dep === taskId) return { ok: false, error: `"${target.title}" cannot depend on itself` };
    const found = tasks.find((t) => t.id === dep);
    if (!found) return { ok: false, error: `Unknown dependency "${dep}"` };
    if (!allowed.has(dep)) {
      return { ok: false, error: `"${target.title}" cannot depend on "${found.title}", which comes after it in the plan` };
    }
  }
  return { ok: true };
}

/** Pre-flight check for a split: the task exists and is not locked by execution. */
export function canSplitTask(tasks: Task[], taskId: string): { ok: boolean; error?: string } {
  const target = tasks.find((t) => t.id === taskId);
  if (!target) return { ok: false, error: 'Task not found' };
  if (target.status === 'in_progress') return { ok: false, error: `"${target.title}" is running and cannot be split` };
  if (target.status === 'completed') return { ok: false, error: `"${target.title}" is completed and cannot be split` };
  return { ok: true };
}

/**
 * Apply task ops to a snapshot of the plan, atomically: either every op
 * applies and the result validates (deps resolve, no cycles, running and
 * completed tasks untouched), or nothing is returned and `errors` explains
 * why. The caller commits `tasks` on ok.
 */
export function applyTaskOps(currentTasks: Task[], ops: TaskOp[], runners: RunnerId[], catalog?: EditCatalog): ApplyTaskOpsResult {
  let tasks: Task[] = JSON.parse(JSON.stringify(currentTasks));
  const errors: string[] = [];
  const summary: string[] = [];

  // Frozen snapshot every ref resolves `#order`/title matches against, so an
  // earlier op's renumbering can never shift what a later op's "#N" means.
  const originalFlatAll = flattenTasks(currentTasks);

  // Batch handles: planner-chosen names for a task an add/merge/split op is
  // about to create, so a later op in the same batch can reference it before
  // it has a real id. Pre-scanned up front — a bad handle refuses the whole
  // batch before anything mutates.
  const handleOwner = new Map<string, number>();
  const handleId = new Map<string, string>();
  for (const [i, op] of ops.entries()) {
    const handle = (op as { handle?: unknown }).handle;
    if (handle === undefined) continue;
    if (typeof handle !== 'string' || !handle.trim()) {
      errors.push(`op ${i + 1} (${op.op}): handle must be a non-empty string`);
      continue;
    }
    if (handleOwner.has(handle)) {
      errors.push(`op ${i + 1} (${op.op}): handle "${handle}" is already used earlier in this batch`);
      continue;
    }
    if (refCollidesWithExisting(handle, originalFlatAll)) {
      errors.push(`op ${i + 1} (${op.op}): handle "${handle}" collides with an existing task reference`);
      continue;
    }
    handleOwner.set(handle, i);
  }
  if (errors.length) return { ok: false, tasks: currentTasks, errors, summary: [] };

  const resolveDeps = (deps: unknown, opIndex: number): { ids: string[]; bad: string[] } => {
    const ids: string[] = [];
    const bad: string[] = [];
    const liveFlat = flattenTasks(tasks);
    for (const d of Array.isArray(deps) ? deps : []) {
      const r = resolveRef(d, originalFlatAll, liveFlat, handleOwner, handleId, opIndex);
      if ('error' in r) { bad.push(`${String(d)} (${r.error})`); continue; }
      if (!liveFlat.some((t) => t.id === r.id)) { bad.push(`${String(d)} (no longer exists in this batch)`); continue; }
      ids.push(r.id);
    }
    return { ids, bad };
  };

  for (const [i, op] of ops.entries()) {
    const label = `op ${i + 1} (${op.op})`;
    switch (op.op) {
      case 'update': {
        const ref = resolveRef(op.taskId, originalFlatAll, flattenTasks(tasks), handleOwner, handleId, i);
        if ('error' in ref) { errors.push(`${label}: ${ref.error}`); break; }
        const target = findInTasks(tasks, ref.id);
        if (!target) { errors.push(`${label}: task "${op.taskId}" no longer exists in this batch (removed, merged, or split by an earlier op)`); break; }
        const changes: Partial<Task> = {};
        for (const key of UPDATABLE_FIELDS) {
          if (op.changes && key in op.changes) (changes as Record<string, unknown>)[key] = (op.changes as Record<string, unknown>)[key];
        }
        if (changes.assignedRunner && !runners.includes(changes.assignedRunner)) {
          errors.push(`${label}: runner "${changes.assignedRunner}" is not in this plan's runner set [${runners.join(', ')}]`);
          break;
        }
        // Dependency refs are still unresolved (e.g. "#3") at this point, so
        // this check runs on everything but them; resolveDeps below handles
        // dependency well-formedness once they're real ids.
        const changesForCheck: Partial<Task> = { ...changes };
        delete changesForCheck.dependencies;
        const check = validateTaskEdit('planner', flattenTasks(tasks), target.id, changesForCheck, catalog);
        if (!check.ok) { errors.push(`${label}: ${check.error}`); break; }
        for (const field of check.clear ?? []) (changes as Record<string, unknown>)[field] = undefined;
        if ('dependencies' in changes) {
          const { ids, bad } = resolveDeps(changes.dependencies, i);
          if (bad.length) { errors.push(`${label}: unknown dependencies: ${bad.join(', ')}`); break; }
          changes.dependencies = ids.filter((id) => id !== target.id);
        }
        if (Object.keys(changes).length === 0) { errors.push(`${label}: no valid changes provided`); break; }
        tasks = updateTaskInPlan(tasks, target.id, changes);
        const clearedNote = check.clear?.length ? `; cleared ${check.clear.join(', ')}` : '';
        summary.push(`Updated "${target.title}" (${Object.keys(changes).join(', ')})${clearedNote}`);
        break;
      }
      case 'add': {
        const spec = op.task ?? {};
        if (!spec.title) { errors.push(`${label}: new task needs a title`); break; }
        const { ids, bad } = resolveDeps(spec.dependencies, i);
        if (bad.length) { errors.push(`${label}: unknown dependencies: ${bad.join(', ')}`); break; }
        const runner = spec.assignedRunner && runners.includes(spec.assignedRunner) ? spec.assignedRunner : runners[0];
        const validity = checkModelAndModeValidity(runner, spec.assignedModel, spec.taskMode, catalog);
        if (!validity.ok) { errors.push(`${label}: ${validity.error}`); break; }
        const newId = uuidv4();
        tasks = addTaskToPlan(tasks, {
          ...spec,
          id: newId,
          dependencies: ids,
          assignedRunner: runner,
          description: spec.description ?? spec.title,
          prompt: spec.prompt ?? spec.description ?? spec.title,
        });
        if (op.handle) handleId.set(op.handle, newId);
        summary.push(`Added "${spec.title}"`);
        break;
      }
      case 'remove': {
        const ref = resolveRef(op.taskId, originalFlatAll, flattenTasks(tasks), handleOwner, handleId, i);
        if ('error' in ref) { errors.push(`${label}: ${ref.error}`); break; }
        const target = findInTasks(tasks, ref.id);
        if (!target) { errors.push(`${label}: task "${op.taskId}" no longer exists in this batch (removed, merged, or split by an earlier op)`); break; }
        if (target.status === 'in_progress') { errors.push(`${label}: "${target.title}" is running and cannot be removed`); break; }
        if (target.status === 'completed') { errors.push(`${label}: "${target.title}" is completed and cannot be removed`); break; }
        tasks = removeTaskFromPlan(tasks, target.id);
        summary.push(`Removed "${target.title}"`);
        break;
      }
      case 'reorder': {
        const refs = (op.taskIds ?? []).map((r) => resolveRef(r, currentTasks, tasks, handleOwner, handleId, i));
        const badRef = refs.find((r): r is { error: string } => 'error' in r);
        if (badRef) { errors.push(`${label}: ${badRef.error}`); break; }
        const resolved = (refs as { id: string }[]).map((r) => findTopLevel(tasks, r.id));
        if (resolved.some((t) => !t)) { errors.push(`${label}: unknown task in reorder list`); break; }
        const orderIds = resolved.map((t) => t!.id);
        if (new Set(orderIds).size !== tasks.length) {
          errors.push(`${label}: reorder must list every top-level task exactly once (${tasks.length} tasks)`);
          break;
        }
        const byId = new Map(tasks.map((t) => [t.id, t]));
        tasks = renumberTasks(orderIds.map((id) => byId.get(id)!));
        summary.push('Reordered tasks');
        break;
      }
      case 'merge': {
        const refs = (op.taskIds ?? []).map((r) => resolveRef(r, currentTasks, tasks, handleOwner, handleId, i));
        const badRef = refs.find((r): r is { error: string } => 'error' in r);
        if (badRef) { errors.push(`${label}: ${badRef.error}`); break; }
        const resolved = (refs as { id: string }[]).map((r) => findTopLevel(tasks, r.id));
        if (resolved.some((t) => !t)) { errors.push(`${label}: unknown task in merge list (already removed, merged, or split by an earlier op)`); break; }
        const toMerge = resolved.map((t) => t!).sort((a, b) => a.order - b.order);
        if (toMerge.length < 2) { errors.push(`${label}: merge needs at least two tasks`); break; }
        const locked = toMerge.find((t) => t.status === 'in_progress' || t.status === 'completed');
        if (locked) {
          errors.push(`${label}: "${locked.title}" is ${locked.status === 'in_progress' ? 'running' : 'completed'} and cannot be merged`);
          break;
        }
        const idSet = new Set(toMerge.map((t) => t.id));
        const unionDepsRaw = [...new Set(toMerge.flatMap((t) => t.dependencies))].filter((d) => !idSet.has(d));
        const { ids, bad } = resolveDeps(unionDepsRaw, i);
        if (bad.length) { errors.push(`${label}: unknown dependencies: ${bad.join(', ')}`); break; }
        const spec = op.merged ?? {};
        if (!spec.title) { errors.push(`${label}: merged task needs a title`); break; }
        const runner = spec.assignedRunner && runners.includes(spec.assignedRunner) ? spec.assignedRunner : toMerge[0].assignedRunner;
        const mergedTask = createTask({
          title: spec.title,
          description: spec.description ?? toMerge.map((t) => t.description).filter(Boolean).join('\n\n'),
          prompt: spec.prompt ?? (toMerge.map((t) => t.prompt).filter(Boolean).join('\n\n---\n\n') || undefined),
          type: spec.type ?? (toMerge.some((t) => t.type === 'user') ? 'user' : 'ai'),
          dependencies: ids,
          assignedRunner: runner,
          assignedModel: spec.assignedModel ?? toMerge.find((t) => t.assignedModel)?.assignedModel,
          thinkingEffort: spec.thinkingEffort ?? toMerge.find((t) => t.thinkingEffort)?.thinkingEffort,
          taskMode: spec.taskMode ?? toMerge[0].taskMode,
          autonomy: spec.autonomy ?? toMerge.find((t) => t.autonomy)?.autonomy,
          sliceType: spec.sliceType ?? toMerge.find((t) => t.sliceType)?.sliceType,
          userStoriesCovered: spec.userStoriesCovered ?? (toMerge.flatMap((t) => t.userStoriesCovered ?? []).length
            ? [...new Set(toMerge.flatMap((t) => t.userStoriesCovered ?? []))]
            : undefined),
        });
        const mergedId = mergedTask.id;
        const firstId = toMerge[0].id;
        const result: Task[] = [];
        let inserted = false;
        for (const t of tasks) {
          if (idSet.has(t.id)) {
            if (!inserted && t.id === firstId) { result.push(mergedTask); inserted = true; }
            continue;
          }
          result.push({ ...t, dependencies: t.dependencies.map((d) => (idSet.has(d) ? mergedId : d)) });
        }
        if (!inserted) result.push(mergedTask);
        tasks = renumberTasks(result);
        if (op.handle) handleId.set(op.handle, mergedId);
        summary.push(`Merged ${toMerge.length} tasks into "${spec.title}"`);
        break;
      }
      case 'split': {
        const ref = resolveRef(op.taskId, currentTasks, tasks, handleOwner, handleId, i);
        if ('error' in ref) { errors.push(`${label}: ${ref.error}`); break; }
        const target = findTopLevel(tasks, ref.id);
        if (!target) { errors.push(`${label}: task "${op.taskId}" not found`); break; }
        if (target.status === 'in_progress') { errors.push(`${label}: "${target.title}" is running and cannot be split`); break; }
        if (target.status === 'completed') { errors.push(`${label}: "${target.title}" is completed and cannot be split`); break; }
        const parts = op.parts ?? [];
        if (parts.length < 2) { errors.push(`${label}: split needs at least two parts`); break; }
        const newTasks: Task[] = [];
        let prevId: string | undefined;
        let buildError = false;
        for (let p = 0; p < parts.length; p++) {
          const spec = parts[p];
          if (!spec || !spec.title) { errors.push(`${label}: split part ${p + 1} needs a title`); buildError = true; break; }
          // Part 0 inherits the original's (external) dependencies, resolved
          // against the current plan. Later parts chain onto the previous part
          // — a sibling id created in this same op, so it needs no resolution.
          let deps: string[];
          if (p === 0) {
            const { ids, bad } = resolveDeps(target.dependencies, i);
            if (bad.length) { errors.push(`${label}: split part 1 unknown dependencies: ${bad.join(', ')}`); buildError = true; break; }
            deps = ids;
          } else {
            deps = prevId ? [prevId] : [];
          }
          const runner = spec.assignedRunner && runners.includes(spec.assignedRunner) ? spec.assignedRunner : target.assignedRunner;
          const nt = createTask({
            title: spec.title,
            description: spec.description ?? spec.title,
            prompt: spec.prompt ?? spec.description ?? spec.title,
            type: spec.type ?? target.type,
            dependencies: deps,
            assignedRunner: runner,
            assignedModel: spec.assignedModel ?? target.assignedModel,
            taskMode: spec.taskMode ?? target.taskMode,
            autonomy: spec.autonomy ?? target.autonomy,
            sliceType: spec.sliceType ?? target.sliceType,
            userStoriesCovered: spec.userStoriesCovered ?? target.userStoriesCovered,
          });
          newTasks.push(nt);
          prevId = nt.id;
        }
        if (buildError) break;
        const tailId = newTasks[newTasks.length - 1].id;
        const result: Task[] = [];
        for (const t of tasks) {
          if (t.id === target.id) { result.push(...newTasks); continue; }
          result.push({ ...t, dependencies: t.dependencies.map((d) => (d === target.id ? tailId : d)) });
        }
        tasks = renumberTasks(result);
        if (op.handle) handleId.set(op.handle, tailId);
        summary.push(`Split "${target.title}" into ${newTasks.length} tasks`);
        break;
      }
      case 'rearm': {
        const ref = resolveRef(op.taskId, originalFlatAll, flattenTasks(tasks), handleOwner, handleId, i);
        if ('error' in ref) { errors.push(`${label}: ${ref.error}`); break; }
        const target = findInTasks(tasks, ref.id);
        if (!target) { errors.push(`${label}: task "${op.taskId}" no longer exists in this batch (removed, merged, or split by an earlier op)`); break; }
        if (target.status === 'in_progress') { errors.push(`${label}: "${target.title}" is running and cannot be re-armed`); break; }
        const changes: Partial<Task> = {};
        for (const key of UPDATABLE_FIELDS) {
          if (op.changes && key in op.changes) (changes as Record<string, unknown>)[key] = (op.changes as Record<string, unknown>)[key];
        }
        if (changes.assignedRunner && !runners.includes(changes.assignedRunner)) {
          errors.push(`${label}: runner "${changes.assignedRunner}" is not in this plan's runner set [${runners.join(', ')}]`);
          break;
        }
        // Validated as a direct edit (not 'planner'): re-arming is the sanctioned
        // exception to the planner lock — its whole point is to touch a task the
        // lock would otherwise refuse. Well-formedness (type coherence, model/mode
        // validity, dependency shape) still applies, same as every other edit.
        const changesForCheck: Partial<Task> = { ...changes };
        delete changesForCheck.dependencies;
        const check = validateTaskEdit('direct', flattenTasks(tasks), target.id, changesForCheck, catalog);
        if (!check.ok) { errors.push(`${label}: ${check.error}`); break; }
        for (const field of check.clear ?? []) (changes as Record<string, unknown>)[field] = undefined;
        if ('dependencies' in changes) {
          const { ids, bad } = resolveDeps(changes.dependencies, i);
          if (bad.length) { errors.push(`${label}: unknown dependencies: ${bad.join(', ')}`); break; }
          changes.dependencies = ids.filter((id) => id !== target.id);
        }
        tasks = updateTaskInPlan(tasks, target.id, { ...changes, status: 'pending', verdict: undefined, outputSummary: undefined });
        // Dependents parked at 'blocked' by this task's earlier failure have
        // nothing else to release them — the scheduler reads `status` directly,
        // not a live recomputation of the dependency graph.
        for (const dep of flattenTasks(tasks)) {
          if (dep.status === 'blocked' && dep.dependencies.includes(target.id)) {
            tasks = updateTaskInPlan(tasks, dep.id, { status: 'pending' });
          }
        }
        const clearedNote = check.clear?.length ? `; cleared ${check.clear.join(', ')}` : '';
        const changedNote = Object.keys(changes).length ? ` (${Object.keys(changes).join(', ')})` : '';
        summary.push(`Re-armed "${target.title}"${changedNote}${clearedNote}`);
        break;
      }
      default:
        errors.push(`${label}: unknown op "${(op as { op: string }).op}"`);
    }
    if (errors.length) break;
  }

  if (!errors.length) {
    const flat = flattenTasks(tasks);
    const idSet = new Set(flat.map((t) => t.id));
    for (const t of flat) {
      for (const dep of t.dependencies) {
        if (!idSet.has(dep)) errors.push(`"${t.title}" depends on a task that no longer exists (${dep})`);
      }
    }
    const cycleAt = detectCycle(flat);
    if (cycleAt) errors.push(`Dependency cycle detected involving "${cycleAt}"`);
    // Display order is maintained, not demanded: whatever the batch produced,
    // the plan comes back with dependencies ahead of their dependents. The
    // planner never has to re-declare the whole order to move one task.
    if (!errors.length) {
      const repaired = repairOrder(tasks);
      if ('error' in repaired) {
        errors.push(repaired.error);
      } else {
        const moves = describeMoves(tasks, repaired.tasks);
        if (moves) summary.push(`Reordered to keep dependencies first: ${moves}`);
        tasks = renumberTasks(repaired.tasks);
      }
    }
  }

  return errors.length
    ? { ok: false, tasks: currentTasks, errors, summary: [] }
    : { ok: true, tasks, errors: [], summary };
}

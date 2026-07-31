import {
  Task, RunnerId, flattenTasks,
  addTaskToPlan, removeTaskFromPlan, updateTaskInPlan, renumberTasks,
  createTask,
} from '../models/Task';
import { extractObjectsWithKey, stripTrailingCommas, escapeControlCharsInStrings, PlanParseError, TASK_OPS_ENVELOPE_KEY } from './JsonExtractor';

/**
 * Targeted task edits emitted by the planner conversation (the 'task_ops'
 * ConversationTurn). Task references accept a task id, a "#<order>" ref, or a
 * bare order number — cheap models rarely echo UUIDs correctly.
 */
export type TaskOp =
  | { op: 'update'; taskId: string; changes: Partial<Task> }
  | { op: 'add'; task: Partial<Task> }
  | { op: 'remove'; taskId: string }
  | { op: 'reorder'; taskIds: string[] }
  | { op: 'merge'; taskIds: string[]; merged: Partial<Task> }
  | { op: 'split'; taskId: string; parts: Partial<Task>[] };

/** Fields the planner may change on an existing task. Everything else (id, status, verdict…) is system-owned. */
const UPDATABLE_FIELDS: (keyof Task)[] = [
  'title', 'description', 'prompt', 'dependencies', 'assignedRunner', 'assignedModel', 'taskMode', 'thinkingEffort', 'type', 'userSteps', 'autonomy',
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

/** Resolve a task reference (id, "#3", or "3") against the current tasks. */
function resolveRef(ref: unknown, tasks: Task[]): Task | undefined {
  if (typeof ref !== 'string' && typeof ref !== 'number') return undefined;
  const s = String(ref).trim();
  const byId = tasks.find((t) => t.id === s);
  if (byId) return byId;
  const orderStr = s.startsWith('#') ? s.slice(1) : s;
  if (/^\d+$/.test(orderStr)) {
    const order = Number(orderStr);
    const byOrder = tasks.filter((t) => t.order === order);
    if (byOrder.length === 1) return byOrder[0];
  }
  return tasks.find((t) => t.title === s);
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
 * introduce a cycle or an order-violating dependency. Consecutiveness in
 * display order is NOT checked here — that is a UI concern; this validates the
 * structural compatibility the issue calls out.
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
  const orderById = new Map(sim.map((t) => [t.id, t.order]));
  for (const t of sim) {
    for (const dep of t.dependencies) {
      const depOrder = orderById.get(dep);
      if (depOrder !== undefined && depOrder >= t.order) {
        return { ok: false, error: 'Merging would break task ordering — a dependency of the merged set comes after it' };
      }
    }
  }
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
export function applyTaskOps(currentTasks: Task[], ops: TaskOp[], runners: RunnerId[]): ApplyTaskOpsResult {
  let tasks: Task[] = JSON.parse(JSON.stringify(currentTasks));
  const errors: string[] = [];
  const summary: string[] = [];

  const resolveDeps = (deps: unknown): { ids: string[]; bad: string[] } => {
    const ids: string[] = [];
    const bad: string[] = [];
    for (const d of Array.isArray(deps) ? deps : []) {
      const t = resolveRef(d, flattenTasks(tasks));
      if (t) ids.push(t.id);
      else bad.push(String(d));
    }
    return { ids, bad };
  };

  for (const [i, op] of ops.entries()) {
    const label = `op ${i + 1} (${op.op})`;
    switch (op.op) {
      case 'update': {
        const target = resolveRef(op.taskId, flattenTasks(tasks));
        if (!target) { errors.push(`${label}: task "${op.taskId}" not found`); break; }
        if (target.status === 'in_progress') { errors.push(`${label}: "${target.title}" is running and cannot be modified`); break; }
        if (target.status === 'completed') { errors.push(`${label}: "${target.title}" is completed and cannot be modified`); break; }
        const changes: Partial<Task> = {};
        for (const key of UPDATABLE_FIELDS) {
          if (op.changes && key in op.changes) (changes as Record<string, unknown>)[key] = (op.changes as Record<string, unknown>)[key];
        }
        if ('dependencies' in changes) {
          const { ids, bad } = resolveDeps(changes.dependencies);
          if (bad.length) { errors.push(`${label}: unknown dependencies: ${bad.join(', ')}`); break; }
          changes.dependencies = ids.filter((id) => id !== target.id);
        }
        if (changes.assignedRunner && !runners.includes(changes.assignedRunner)) {
          errors.push(`${label}: runner "${changes.assignedRunner}" is not in this plan's runner set [${runners.join(', ')}]`);
          break;
        }
        if (Object.keys(changes).length === 0) { errors.push(`${label}: no valid changes provided`); break; }
        tasks = updateTaskInPlan(tasks, target.id, changes);
        summary.push(`Updated "${target.title}" (${Object.keys(changes).join(', ')})`);
        break;
      }
      case 'add': {
        const spec = op.task ?? {};
        if (!spec.title) { errors.push(`${label}: new task needs a title`); break; }
        const { ids, bad } = resolveDeps(spec.dependencies);
        if (bad.length) { errors.push(`${label}: unknown dependencies: ${bad.join(', ')}`); break; }
        const runner = spec.assignedRunner && runners.includes(spec.assignedRunner) ? spec.assignedRunner : runners[0];
        tasks = addTaskToPlan(tasks, {
          ...spec,
          id: undefined,
          dependencies: ids,
          assignedRunner: runner,
          description: spec.description ?? spec.title,
          prompt: spec.prompt ?? spec.description ?? spec.title,
        });
        summary.push(`Added "${spec.title}"`);
        break;
      }
      case 'remove': {
        const target = resolveRef(op.taskId, flattenTasks(tasks));
        if (!target) { errors.push(`${label}: task "${op.taskId}" not found`); break; }
        if (target.status === 'in_progress') { errors.push(`${label}: "${target.title}" is running and cannot be removed`); break; }
        if (target.status === 'completed') { errors.push(`${label}: "${target.title}" is completed and cannot be removed`); break; }
        tasks = removeTaskFromPlan(tasks, target.id);
        summary.push(`Removed "${target.title}"`);
        break;
      }
      case 'reorder': {
        const resolved = (op.taskIds ?? []).map((r) => resolveRef(r, tasks));
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
        const resolved = (op.taskIds ?? []).map((r) => resolveRef(r, tasks));
        if (resolved.some((t) => !t)) { errors.push(`${label}: unknown task in merge list`); break; }
        const toMerge = resolved.map((t) => t!).sort((a, b) => a.order - b.order);
        if (toMerge.length < 2) { errors.push(`${label}: merge needs at least two tasks`); break; }
        const locked = toMerge.find((t) => t.status === 'in_progress' || t.status === 'completed');
        if (locked) {
          errors.push(`${label}: "${locked.title}" is ${locked.status === 'in_progress' ? 'running' : 'completed'} and cannot be merged`);
          break;
        }
        const idSet = new Set(toMerge.map((t) => t.id));
        const unionDepsRaw = [...new Set(toMerge.flatMap((t) => t.dependencies))].filter((d) => !idSet.has(d));
        const { ids, bad } = resolveDeps(unionDepsRaw);
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
        summary.push(`Merged ${toMerge.length} tasks into "${spec.title}"`);
        break;
      }
      case 'split': {
        const target = resolveRef(op.taskId, tasks);
        if (!target) { errors.push(`${label}: task "${op.taskId}" not found`); break; }
        if (target.status === 'in_progress') { errors.push(`${label}: "${target.title}" is running and cannot be split`); break; }
        if (target.status === 'completed') { errors.push(`${label}: "${target.title}" is completed and cannot be split`); break; }
        const parts = op.parts ?? [];
        if (parts.length < 2) { errors.push(`${label}: split needs at least two parts`); break; }
        const newTasks: Task[] = [];
        let prevId: string | undefined;
        let buildError = false;
        for (let i = 0; i < parts.length; i++) {
          const spec = parts[i];
          if (!spec || !spec.title) { errors.push(`${label}: split part ${i + 1} needs a title`); buildError = true; break; }
          // Part 0 inherits the original's (external) dependencies, resolved
          // against the current plan. Later parts chain onto the previous part
          // — a sibling id created in this same op, so it needs no resolution.
          let deps: string[];
          if (i === 0) {
            const { ids, bad } = resolveDeps(target.dependencies);
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
        summary.push(`Split "${target.title}" into ${newTasks.length} tasks`);
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
    // Order must respect dependencies. This is the only enforcer of that
    // invariant now that no surface can reposition a task by hand.
    const orderById = new Map(tasks.map((t) => [t.id, t.order]));
    for (const t of tasks) {
      for (const dep of t.dependencies) {
        const depOrder = orderById.get(dep);
        if (depOrder !== undefined && depOrder >= t.order) {
          errors.push(`"${t.title}" is ordered before its dependency; move the dependency earlier`);
        }
      }
    }
  }

  return errors.length
    ? { ok: false, tasks: currentTasks, errors, summary: [] }
    : { ok: true, tasks, errors: [], summary };
}

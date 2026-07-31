import { Task, createTask, TaskModelAssignment, RunnerId, type ValidationContext, type ValidationResult } from '../models/Task';
import { extractObjectsWithKey, stripTrailingCommas, escapeControlCharsInStrings, PlanParseError, PLAN_ENVELOPE_KEY } from './JsonExtractor';
import { resolveTaskMode, type RunnerModeInfo } from './ModeResolver';

export function parsePlanJson(
  raw: string,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = true,
): Task[] {
  const { matches, fallback, sawUnbalanced } = extractObjectsWithKey(raw, PLAN_ENVELOPE_KEY);

  // A reply can carry several tasks-keyed objects — a schema echo from the
  // prompt, an inline draft, then the real plan. The model's LAST emission is
  // its final answer, so candidates are tried back to front and the first one
  // that fully parses and validates wins.
  const candidates = matches.length > 0 ? [...matches].reverse() : [fallback.json];

  let lastError: PlanParseError | null = null;
  for (const json of candidates) {
    try {
      return parsePlanObject(json, raw, runners, runnerModes, autonomousDefault);
    } catch (err) {
      if (!(err instanceof PlanParseError)) throw err;
      // Prefer surfacing the error from the most plan-like candidate: the
      // last one carrying a tasks key (tried first).
      if (!lastError) lastError = err;
    }
  }

  // No usable tasks object anywhere, but an object ran off the end of the
  // text: the plan was almost certainly cut off mid-stream.
  if (matches.length === 0 && sawUnbalanced) {
    throw new PlanParseError(
      'Plan response appears truncated — the model likely hit its output length limit before finishing the JSON.',
      raw,
      { truncated: true },
    );
  }
  throw lastError ?? new PlanParseError('Invalid plan: missing tasks array', raw);
}

function parsePlanObject(
  json: string,
  raw: string,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = true,
): Task[] {
  const cleaned = stripTrailingCommas(escapeControlCharsInStrings(json));

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PlanParseError(`Plan response was not valid JSON: ${detail}`, raw);
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    throw new PlanParseError('Invalid plan: missing tasks array', raw);
  }

  const rawTasks = (parsed as { tasks: Record<string, unknown>[] }).tasks;
  if (rawTasks.length === 0) {
    throw new PlanParseError('Plan contained no tasks', raw);
  }

  const tasks = rawTasks.map((t) => parseTask(t, runners, runnerModes, autonomousDefault));

  validateVerticalSliceShape(tasks, raw);

  for (const t of tasks) {
    if (!runners.includes(t.assignedRunner)) {
      throw new PlanParseError(
        `Task "${t.title}" has invalid assignedRunner "${t.assignedRunner}". Expected one of: ${runners.join(', ')}`,
        raw,
        { semantic: true },
      );
    }
  }

  return tasks;
}

/**
 * Whether a reply that failed {@link parsePlanJson} actually LOOKED like a
 * plan attempt — a balanced tasks-keyed object, or JSON that got cut off.
 * Distinguishes "the model tried to emit a plan and botched it" (worth a
 * corrective retry) from prose that merely mentions `"tasks"` (leave alone).
 */
export function looksLikePlanAttempt(raw: string): boolean {
  const { matches, sawUnbalanced } = extractObjectsWithKey(raw, PLAN_ENVELOPE_KEY);
  if (matches.length > 0) return true;
  return sawUnbalanced && raw.includes(`"${PLAN_ENVELOPE_KEY}"`);
}

/**
 * The parent's slice classification, handed to `ai` subtasks that omit their
 * own. Budget models emit sub-steps as bare `{id, order, title, description,
 * type}` — neither prompt has ever shown a populated `subtasks` entry — and the
 * recursive slice contract then rejected the whole plan. Inheriting invents no
 * information: an `ai` sub-step of an AFK slice is AFK. Deliberately NOT a
 * blanket `'AFK'` default, which would silently strip a human gate the planner
 * intended (`sliceType` is what puts ORDEWELL_CHECKPOINT in the runner prompt,
 * and subtasks are schedulable — PlanStore.rebuild flattens them into
 * _allTasks). `type: 'user'` subtasks inherit nothing and must still declare
 * HITL themselves.
 */
type InheritedSlice = { sliceType?: Task['sliceType']; autonomy?: Task['autonomy'] };

function parseTask(
  raw: Record<string, unknown>,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = true,
  inherited?: InheritedSlice,
): Task {
  const assignedRunner = typeof raw.assignedRunner === 'string' ? raw.assignedRunner : (runners[0] ?? 'claude-code');
  const taskType = (raw.type === 'user' ? 'user' : 'ai') as Task['type'];
  const title = String(raw.title ?? '');
  const description = String(raw.description ?? '');
  // Explicit child values always win; inheritance only fills a gap, and only
  // for `ai` tasks.
  const autonomy = taskType === 'ai' && typeof raw.autonomy === 'string' && (raw.autonomy === 'AFK' || raw.autonomy === 'HITL')
    ? raw.autonomy
    : (taskType === 'ai' ? inherited?.autonomy : undefined);
  const sliceType = typeof raw.sliceType === 'string' && (raw.sliceType === 'HITL' || raw.sliceType === 'AFK')
    ? raw.sliceType
    : (taskType === 'ai' ? inherited?.sliceType : undefined);
  return createTask({
    id: String(raw.id ?? ''),
    order: Number(raw.order ?? 0),
    title,
    description,
    type: taskType,
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.map(String)
      : [],
    // The planner sometimes omits `prompt` on an AI task while still filling in
    // description/title — same fallback TaskOps.applyTaskOps uses for `add`, so
    // a task never silently ends up unschedulable (getReadyTasks requires prompt).
    prompt: raw.prompt ? String(raw.prompt) : (description || title || undefined),
    userSteps: Array.isArray(raw.userSteps)
      ? raw.userSteps.map((s: Record<string, unknown>) => ({
          order: Number(s.order ?? 0),
          instruction: String(s.instruction ?? ''),
          completed: false,
        }))
      : undefined,
    subtasks: Array.isArray(raw.subtasks)
      ? raw.subtasks.map((s: Record<string, unknown>) =>
          parseTask(s, runners, runnerModes, autonomousDefault, { sliceType, autonomy }))
      : [],
    assignedModel: raw.assignedModel
      ? {
          modelId: String((raw.assignedModel as Record<string, unknown>).modelId ?? ''),
          modelLabel: String((raw.assignedModel as Record<string, unknown>).modelLabel ?? ''),
          thinkingEffort: (raw.assignedModel as Record<string, unknown>).thinkingEffort as TaskModelAssignment['thinkingEffort'],
        }
      : undefined,
    assignedRunner,
    thinkingEffort: raw.thinkingEffort ? String(raw.thinkingEffort) : undefined,
    taskMode: resolveTaskMode(
      raw.taskMode !== undefined ? String(raw.taskMode) : undefined,
      assignedRunner,
      runnerModes,
      autonomousDefault,
    ),
    autonomy,
    sliceType,
    userStoriesCovered: Array.isArray(raw.userStoriesCovered)
      ? raw.userStoriesCovered.map(String)
      : undefined,
  });
}

function validateVerticalSliceShape(tasks: Task[], raw: string, parentTitle?: string): void {
  // Without this the message names a title that appears nowhere in the plan's
  // top-level `tasks` array, and neither the corrective nor a human can find
  // the offending object.
  const where = (t: Task) => (parentTitle ? `subtask "${t.title}" of "${parentTitle}"` : `Task "${t.title}"`);
  const semantic = { semantic: true };

  for (const t of tasks) {
    if (!t.sliceType) {
      throw new PlanParseError(
        `${where(t)} is missing sliceType. Every task must specify sliceType ("AFK" or "HITL").`,
        raw,
        semantic,
      );
    }

    if (t.type === 'ai' && !t.autonomy) {
      throw new PlanParseError(
        `AI ${where(t)} is missing autonomy. Every AI task must specify autonomy ("AFK" or "HITL").`,
        raw,
        semantic,
      );
    }

    if (t.autonomy === 'AFK' && t.userSteps && t.userSteps.length > 0) {
      throw new PlanParseError(
        `${where(t)} has autonomy "AFK" but contains userSteps. AFK tasks must not have user touchpoints.`,
        raw,
        semantic,
      );
    }

    if (t.type === 'user' && t.sliceType !== 'HITL') {
      throw new PlanParseError(
        `User ${where(t)} has sliceType "${t.sliceType}". User tasks must have sliceType "HITL".`,
        raw,
        semantic,
      );
    }

    if (t.subtasks.length > 0) {
      validateVerticalSliceShape(t.subtasks, raw, t.title);
    }
  }
}

export function checkUniqueIds(ctx: ValidationContext): ValidationResult {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const t of ctx.newPending) {
    if (seen.has(t.id)) {
      errors.push(`Duplicate task ID in modified plan: ${t.id}`);
    }
    seen.add(t.id);
  }
  return { valid: errors.length === 0, errors };
}

export function checkNoCycles(ctx: ValidationContext): ValidationResult {
  const ids = new Set(ctx.newPending.map((t) => t.id));
  const adj = new Map<string, string[]>();
  for (const t of ctx.newPending) {
    adj.set(t.id, t.dependencies.filter((d) => ids.has(d)));
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const errors: string[] = [];

  function dfs(node: string): boolean {
    if (inStack.has(node)) {
      errors.push(`Cycle detected in task dependencies involving task: ${node}`);
      return true;
    }
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of adj.get(node) ?? []) {
      if (dfs(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  for (const id of ids) {
    if (dfs(id)) break;
  }

  return { valid: errors.length === 0, errors };
}

export function checkDepsResolve(ctx: ValidationContext): ValidationResult {
  const existingIds = new Set<string>();
  for (const t of ctx.executionLog) existingIds.add(t.id);
  for (const t of ctx.newPending) existingIds.add(t.id);

  const errors: string[] = [];
  for (const t of ctx.newPending) {
    for (const dep of t.dependencies) {
      if (!existingIds.has(dep)) {
        errors.push(`Task "${t.title}" depends on "${dep}" which is not in the execution log or pending tasks`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function checkImmutableLog(ctx: ValidationContext): ValidationResult {
  const logIds = new Map(ctx.executionLog.map((t) => [t.id, t]));

  const errors: string[] = [];

  for (const t of ctx.newPending) {
    const logEntry = logIds.get(t.id);
    if (logEntry) {
      if (logEntry.status === 'completed' && logEntry.finalized) {
        errors.push(`Task "${t.id}" was already completed in the execution log and cannot be re-added`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function checkInProgress(ctx: ValidationContext): ValidationResult {
  const oldInProgress = new Map(
    ctx.oldPending.filter((t) => t.status === 'in_progress').map((t) => [t.id, t])
  );
  const newIds = new Set(ctx.newPending.map((t) => t.id));
  const errors: string[] = [];

  for (const [id, oldTask] of oldInProgress) {
    if (!newIds.has(id)) {
      errors.push(`In-progress task "${oldTask.title}" was removed from the modified plan`);
      continue;
    }
    const newTask = ctx.newPending.find((t) => t.id === id)!;
    if (newTask.prompt !== oldTask.prompt || newTask.assignedModel?.modelId !== oldTask.assignedModel?.modelId) {
      errors.push(`In-progress task "${oldTask.title}" was modified in the new plan`);
    }
    const oldDeps = new Set(oldTask.dependencies);
    const newDeps = new Set(newTask.dependencies);
    if (oldDeps.size !== newDeps.size || [...oldDeps].some((d) => !newDeps.has(d))) {
      errors.push(`In-progress task "${oldTask.title}" had dependencies modified`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validatePlanModification(ctx: ValidationContext): ValidationResult {
  const checks = [
    checkUniqueIds,
    checkNoCycles,
    checkDepsResolve,
    checkImmutableLog,
    checkInProgress,
  ];
  const allErrors: string[] = [];
  for (const check of checks) {
    const result = check(ctx);
    allErrors.push(...result.errors);
  }
  return { valid: allErrors.length === 0, errors: allErrors };
}

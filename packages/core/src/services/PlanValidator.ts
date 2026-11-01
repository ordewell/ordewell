import { Task, RunnerId, flattenTasksWithParents } from '../models/Task';
import { extractObjectsWithKey, stripTrailingCommas, escapeControlCharsInStrings, PlanParseError, PLAN_ENVELOPE_KEY } from './JsonExtractor';
import type { RunnerModeInfo } from './ModeResolver';
import { plannedTask, checkPlanInvariants, taskWhere, type IntakeCatalog, type PlanTaskError } from './PlannedTask';

export function parsePlanJson(
  raw: string,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = false,
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
      'Plan response appears truncated: the model likely hit its output length limit before finishing the JSON.',
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
  autonomousDefault = false,
): Task[] {
  const cleaned = stripTrailingCommas(escapeControlCharsInStrings(json));

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PlanParseError(`Plan response was not valid JSON: ${detail}`, raw);
  }

  const result = validatePlanTasks(parsed, runners, runnerModes, autonomousDefault);
  if (result.ok) return result.tasks;
  const [first] = result.errors;
  // An envelope problem (no tasks array, an empty one) keeps the generic
  // re-emit; only a rule broken by a task is worth naming in the corrective.
  throw new PlanParseError(first.message, raw, { semantic: first.taskId !== undefined });
}

export type { PlanTaskError } from './PlannedTask';
export { requestedSkills } from './PlannedTask';

/** `warnings` name what was accepted but not used, for a channel that can tell the planner. */
export type PlanTasksResult = { ok: true; tasks: Task[]; warnings?: string[] } | { ok: false; errors: PlanTaskError[] };

/**
 * Every check a plan's tasks must pass, on an already-parsed `{ tasks }`
 * object — what a plan is held to whichever channel it arrived on. All
 * problems are reported, the slice classification first, so the first is the
 * one the text path's corrective names.
 */
export function validatePlanTasks(
  obj: unknown,
  runners: RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
  autonomousDefault = false,
  delegation: Pick<IntakeCatalog, 'delegationRefusal' | 'sealsScripts'> = {},
): PlanTasksResult {
  const rawTasks = isRecord(obj) ? obj.tasks : undefined;
  if (!Array.isArray(rawTasks)) {
    return { ok: false, errors: [{ field: 'tasks', message: 'Invalid plan: missing tasks array' }] };
  }
  if (rawTasks.length === 0) {
    return { ok: false, errors: [{ field: 'tasks', message: 'Plan contained no tasks' }] };
  }

  const planned = rawTasks.map((t) => plannedTask(t, { runners, runnerModes, autonomousDefault, ...delegation }));
  const tasks = planned.map((p) => p.task);
  const errors = [
    ...sliceRequired(tasks),
    ...planned.flatMap((p) => p.errors),
    ...checkPlanInvariants(tasks, runners, runnerModes),
  ];

  if (errors.length > 0) return { ok: false, errors };
  const ignored = planned.flatMap((p) => p.ignored);
  const warnings = [
    ...(ignored.some((i) => i.field === 'taskMode')
      ? ['"taskMode" is not yours to set and was ignored: each task runs in its runner\'s mode for the user\'s autonomy level, or its read-only mode when you set "readOnly": true.']
      : []),
    ...ignored.filter((i) => i.field === 'readOnly').map((i) => `${i.message}: it was ignored.`),
  ];
  return warnings.length > 0 ? { ok: true, tasks, warnings } : { ok: true, tasks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * A whole plan says how each task is sliced: an edit may leave it to the
 * task's parent or the tasks it was made from, a submitted plan may not.
 */
function sliceRequired(tasks: readonly Task[]): PlanTaskError[] {
  return flattenTasksWithParents(tasks).flatMap(({ task: t, parent }) => {
    const where = taskWhere(t.title, parent?.title);
    const errors: PlanTaskError[] = [];
    if (!t.sliceType) errors.push({ taskId: t.id, field: 'sliceType', message: `${where} is missing sliceType. Every task must specify sliceType ("AFK" or "HITL").` });
    if (t.type === 'ai' && !t.autonomy) errors.push({ taskId: t.id, field: 'autonomy', message: `AI ${where} is missing autonomy. Every AI task must specify autonomy ("AFK" or "HITL").` });
    return errors;
  });
}

import type { DiscoveredModel, RunnerId, Task } from '../models/Task';

/**
 * The ids a runner may actually run: the user's allowlist with the ids that
 * provably belong to a *different* runner dropped. `undefined` means no
 * restriction.
 *
 * Model ids are scoped to the agent that lists them, so an OpenRouter slug
 * allowlisted for Claude Code does not limit it — it points it at something it
 * cannot spawn, and the plan only dies once a task is already running. But
 * "this runner didn't list it" is not enough to call an id wrong: discovery can
 * be stale, and a plugin runner may have no list at all. What settles it is
 * whether *another* runner listed the id. So:
 *
 * - listed for this runner → keep;
 * - listed for no runner → unknown, and the user said it explicitly, so keep it
 *   and let the runner validate last (the same call `coerceAssignments` and
 *   `TaskRetarget` make);
 * - listed only for other runners → provably not this runner's, so drop it.
 *
 * When that leaves nothing, the whole allowlist was about some other runner
 * (a settings file written before a surface scoped its picker to one). No
 * restriction is the only safe reading — the alternative is handing the planner
 * a list of models that cannot run.
 */
export function effectiveAllowlist(
  allowlist: string[] | undefined,
  runner: string,
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> | undefined,
): string[] | undefined {
  if (!allowlist || allowlist.length === 0) return undefined;
  if (!modelsByRunner) return allowlist;

  const own = new Set((modelsByRunner[runner] ?? []).map((m) => m.modelId));
  const elsewhere = new Set<string>();
  for (const [other, models] of Object.entries(modelsByRunner)) {
    if (other === runner) continue;
    for (const m of models ?? []) elsewhere.add(m.modelId);
  }

  const kept = allowlist.filter((id) => own.has(id) || !elsewhere.has(id));
  return kept.length > 0 ? kept : undefined;
}

export function filterModelsForPrompt(
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  perRunnerAllowlist: Partial<Record<RunnerId, string[]>>,
): Partial<Record<RunnerId, DiscoveredModel[]>> {
  const result: Partial<Record<RunnerId, DiscoveredModel[]>> = {};
  for (const [runner, models] of Object.entries(modelsByRunner)) {
    if (!models) continue;
    const allowed = effectiveAllowlist(perRunnerAllowlist[runner], runner, modelsByRunner);
    if (!allowed) {
      result[runner] = models;
      continue;
    }
    const allowedSet = new Set(allowed);
    const intersection = models.filter((m) => allowedSet.has(m.modelId));
    // A set allowlist is a hard constraint: the planner must never see models
    // outside it. An allowed id no runner has listed is one discovery doesn't
    // cover, so synthesize an entry rather than leaking the full list.
    const covered = new Set(intersection.map((m) => m.modelId));
    const missing = allowed
      .filter((id) => !covered.has(id))
      .map((id) => ({ modelId: id, modelLabel: id.split('/').pop() || id, variants: [] }));
    result[runner] = [...intersection, ...missing];
  }
  return result;
}

/** Canonical low→high ordering of the well-known effort ladder. */
const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** Runner-specific spellings mapped onto the ladder. */
const EFFORT_ALIASES: Record<string, string> = { disabled: 'none', adaptive: 'medium' };

/**
 * Clamp a planner/user-supplied thinking effort to what the model actually
 * offers. Invalid values map to the nearest rung the model supports (so a
 * Claude-style "xhigh" on a low/medium/high model becomes "high") and fall
 * back to undefined — the runner's own default — when no mapping exists.
 */
export function clampThinkingEffort(
  effort: string | undefined,
  variants: { id: string }[],
): string | undefined {
  if (!effort) return undefined;
  if (variants.length === 0) return undefined;
  const ids = new Set(variants.map((v) => v.id));
  if (ids.has(effort)) return effort;
  const canon = EFFORT_ALIASES[effort] ?? effort;
  if (ids.has(canon)) return canon;
  const idx = EFFORT_LADDER.indexOf(canon);
  if (idx < 0) return undefined;
  for (let d = 1; d < EFFORT_LADDER.length; d++) {
    const lower = EFFORT_LADDER[idx - d];
    if (lower && ids.has(lower)) return lower;
    const higher = EFFORT_LADDER[idx + d];
    if (higher && ids.has(higher)) return higher;
  }
  return undefined;
}

export function coerceAssignments(
  tasks: Task[],
  perRunnerAllowlist: Partial<Record<RunnerId, string[]>>,
  allowedRunners?: RunnerId[],
  modelsByRunner?: Partial<Record<RunnerId, DiscoveredModel[]>>,
): Task[] {
  // When the discovered catalog is available, snap each assignment's
  // thinkingEffort to a variant the model really has and stamp the model's
  // variant ids on the assignment (runners need them at spawn time); a model
  // we can't find in the catalog keeps its effort untouched (the runner
  // validates last).
  const clampVariant = (task: Task): Task => {
    if (!task.assignedModel || !modelsByRunner) return task;
    const model = modelsByRunner[task.assignedRunner]?.find(
      (m) => m.modelId === task.assignedModel!.modelId,
    );
    if (!model) return task;
    const clamped = clampThinkingEffort(task.assignedModel.thinkingEffort, model.variants);
    return {
      ...task,
      assignedModel: {
        ...task.assignedModel,
        thinkingEffort: clamped,
        availableVariants: model.variants.map((v) => v.id),
      },
    };
  };

  // One reading of the allowlist for the whole pass, so the models a task is
  // snapped to are the same ones the planner was shown (`filterModelsForPrompt`).
  const allowedFor = (runner: RunnerId): string[] | undefined =>
    effectiveAllowlist(perRunnerAllowlist[runner], runner, modelsByRunner);

  // A snapped-to model keeps the catalog's label and variant list where we have
  // one — an id alone reads as the model's name in every surface, and leaves the
  // effort picker with nothing to offer.
  const assignmentFor = (runner: RunnerId, modelId: string): NonNullable<Task['assignedModel']> => {
    const known = modelsByRunner?.[runner]?.find((m) => m.modelId === modelId);
    return {
      modelId,
      modelLabel: known?.modelLabel ?? modelId,
      thinkingEffort: undefined,
      ...(known ? { availableVariants: known.variants.map((v) => v.id) } : {}),
    };
  };

  return tasks.map((task) => {
    if (task.type === 'user') return task;

    if (allowedRunners && !allowedRunners.includes(task.assignedRunner)) {
      const fallbackRunner = allowedRunners[0];
      const fallbackModels = allowedFor(fallbackRunner);
      const fallbackModel = fallbackModels?.length
        ? assignmentFor(fallbackRunner, fallbackModels[0])
        : modelsByRunner?.[fallbackRunner]?.[0]
          ? assignmentFor(fallbackRunner, modelsByRunner[fallbackRunner]![0].modelId)
          : task.assignedModel;
      return clampVariant({
        ...task,
        assignedRunner: fallbackRunner,
        assignedModel: fallbackModel,
      });
    }

    const allowlist = allowedFor(task.assignedRunner);
    // No model assigned: fill in from the allowlist or discovered catalog so
    // merge/split/add outputs (which may omit assignedModel) always land with a
    // valid model for the task's runner.
    if (!task.assignedModel) {
      if (allowlist && allowlist.length > 0) {
        return clampVariant({ ...task, assignedModel: assignmentFor(task.assignedRunner, allowlist[0]) });
      }
      const discovered = modelsByRunner?.[task.assignedRunner]?.[0];
      if (discovered) {
        return clampVariant({ ...task, assignedModel: assignmentFor(task.assignedRunner, discovered.modelId) });
      }
      return task;
    }
    if (!allowlist || allowlist.length === 0) return clampVariant(task);
    if (allowlist.includes(task.assignedModel.modelId)) return clampVariant(task);
    return { ...task, assignedModel: assignmentFor(task.assignedRunner, allowlist[0]) };
  });
}

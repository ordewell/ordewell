import type { DiscoveredModel, RunnerId } from '../models/Task';

/**
 * The ids a runner may actually run: the user's allowlist with the ids that
 * provably belong to a *different* runner dropped. `undefined` means no
 * restriction.
 *
 * Model ids are scoped to the agent that lists them, so an OpenRouter slug
 * allowlisted for Claude Code does not limit it — it points it at something it
 * cannot spawn, and the plan only dies once a task is already running. But
 * "this runner didn't list it" is not enough to call an id wrong: discovery can
 * be stale or return no list at all. What settles it is
 * whether *another* runner listed the id. So:
 *
 * - listed for this runner → keep;
 * - listed for no runner → unknown, and the user said it explicitly, so keep it
 *   and let the runner validate last (the same call `resolveAssignment` makes);
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
 * The one rule for an effort and a model: the effort a task keeps on a model,
 * whether it was written with it or carried from the model before. Kept where
 * the model offers it; otherwise mapped to the nearest rung the model
 * supports (so a Claude-style "xhigh" on a low/medium/high model becomes
 * "high"); undefined — the runner's own default — when no mapping exists or
 * the model offers no levels, which is how a model discovery does not list
 * reads (`variants` empty). Core's resolver and every surface's model picker
 * call it, so a model change lands on the same effort wherever it is made.
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

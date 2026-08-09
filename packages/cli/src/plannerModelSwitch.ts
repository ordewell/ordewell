import type { AiProvider, PlannerModelRecall } from '@ordewell/core';

/**
 * What a planner-switch response settled on, for the surface to word.
 *
 * The daemon resolves a switch through `PlannerModelMemory` (remembered model,
 * that provider's catalog default, or nothing) but the `/api/settings` wire
 * body carries only the result, not which of the three produced it. Rebuilt
 * here from `plannerModels` — the same memory map the daemon read from — by
 * comparing it against what actually came back: a match is what the daemon's
 * own recall would have called 'remembered'; any other non-empty model is
 * 'catalog-default'; no model at all is 'none'.
 */
export function describePlannerSwitch(settings: Record<string, unknown>, provider: AiProvider): PlannerModelRecall {
  const model = typeof settings.orchestratorModel === 'string' ? settings.orchestratorModel : '';
  const effort = typeof settings.plannerThinkingEffort === 'string' ? settings.plannerThinkingEffort : '';
  if (!model) return { model: '', effort: '', source: 'none' };
  return rememberedModelFor(settings, provider) === model
    ? { model, effort, source: 'remembered' }
    : { model, effort, source: 'catalog-default' };
}

function rememberedModelFor(settings: Record<string, unknown>, provider: string): string | undefined {
  const map = settings.plannerModels;
  if (!map || typeof map !== 'object') return undefined;
  const entry = (map as Record<string, unknown>)[provider];
  if (!entry || typeof entry !== 'object') return undefined;
  const { model } = entry as { model?: unknown };
  return typeof model === 'string' ? model : undefined;
}

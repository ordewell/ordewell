import { PlannerModelMemory, type PlannerModelCandidate, type PlannerModelRecall, type AiProvider, type DiscoveredModel } from '@ordewell/core';

export interface VendorModelOption {
  id: string;
}

/**
 * What model and effort a switch to `provider` should land on. A harness
 * planner's catalog is that runner's own discovered models; a vendor's is the
 * API picker list (ADR-0009) — only one of the two ever applies for a given
 * provider. `applyPlanner` is the sole caller, so the DiscoveredModel/picker
 * shapes get normalized to `PlannerModelCandidate` in exactly one place.
 */
export function recallPlannerModel(
  memory: PlannerModelMemory,
  provider: AiProvider,
  harnessModels: DiscoveredModel[] | undefined,
  vendorOptions: VendorModelOption[] | undefined,
): PlannerModelRecall {
  const catalog: PlannerModelCandidate[] = harnessModels
    ? harnessModels.map((m) => ({ id: m.modelId, variants: m.variants }))
    : (vendorOptions ?? []).map((o) => ({ id: o.id }));
  return memory.recall(provider, catalog);
}

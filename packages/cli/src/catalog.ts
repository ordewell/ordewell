import type { AiProvider, ModelsResponse } from '@ordewell/core';
import type { ModeView, ModelView } from './tui/state';

/** The raw `/api/models` body, before any surface has looked at it: the daemon's contract with every field optional, as a surface must tolerate an older or partial daemon. */
export type RawCatalog = Partial<ModelsResponse>;

export interface Catalog {
  /** Every executor model, each tagged with the runners that offered it. */
  models: ModelView[];
  /** The planner catalog: one entry per vendor model, no runner scoping. */
  orchestratorModels: ModelView[];
  /** Providers with a working API key — the `key` command's checkmarks. */
  providers: AiProvider[];
  providerErrors: Record<string, string>;
  /** Why a runner with an empty catalog lists nothing, keyed by runner id, as the daemon words it. */
  runnerErrors: Record<string, string>;
  modesByRunner: Record<string, ModeView[]>;
}

/**
 * One owner for the `/api/models` shape.
 *
 * The runner tagging in particular is a rule, not a formatting choice: model ids
 * are scoped to the agent that lists them, and `runners` is what every scoping
 * check downstream (`runnerServes`, the allowlist guard, `task-model`) reads. A
 * second copy of this loop in the command layer would be a second answer to
 * "which runner can spawn this id", which is exactly the drift the single-owner
 * rule exists to prevent (AGENTS.md, "Deep modules").
 */
export function normalizeCatalog(result: RawCatalog): Catalog {
  const runnersByModel = new Map<string, string[]>();
  for (const [runner, entries] of Object.entries(result.modelsByRunner ?? {})) {
    for (const entry of entries ?? []) {
      const id = String(entry.modelId);
      runnersByModel.set(id, [...new Set([...(runnersByModel.get(id) ?? []), runner])]);
    }
  }

  const models: ModelView[] = (result.models ?? []).map((m) => {
    const id = String(m.modelId);
    return {
      id,
      label: String(m.modelLabel ?? id),
      provider: String(m.runnerProviderLabel ?? m.runnerProvider ?? ''),
      variants: Array.isArray(m.variants)
        ? m.variants.map((v) => ({ id: String(v.id), label: String(v.label ?? v.id) }))
        : [],
      runners: runnersByModel.get(id) ?? [],
    };
  });

  // The orchestrator/planner catalog spans every configured provider, each
  // option already carrying its human provider label (e.g. "OpenRouter").
  const orchestratorModels: ModelView[] = (result.orchestratorModels ?? []).map((m) => ({
    id: String(m.id),
    label: String(m.label ?? m.id),
    provider: String(m.provider ?? ''),
    pricing: m.pricing ? `$${m.pricing}/MTok` : undefined,
  }));

  return {
    models,
    orchestratorModels,
    providers: result.providers ?? [],
    providerErrors: result.providerErrors ?? {},
    runnerErrors: result.runnerErrors ?? {},
    modesByRunner: Object.fromEntries(
      Object.entries(result.modesByRunner ?? {}).map(([runner, modes]) => [
        runner,
        (modes ?? []).map((m) => ({
          id: String(m.id),
          label: String(m.label ?? m.id),
          description: m.description ? String(m.description) : undefined,
          autonomous: m.autonomous ? true : undefined,
          unavailable: m.unavailable ? String(m.unavailable) : undefined,
        })),
      ]),
    ),
  };
}

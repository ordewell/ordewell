import type { ModeView, ModelView } from './tui/state';

/** The raw `/api/models` body, before any surface has looked at it. */
export interface RawCatalog {
  models?: any[];
  modelsByRunner?: Record<string, any[]>;
  modesByRunner?: Record<string, any[]>;
  providers?: string[];
  orchestratorModels?: any[];
  providerErrors?: Record<string, string>;
}

export interface Catalog {
  /** Every executor model, each tagged with the runners that offered it. */
  models: ModelView[];
  /** The planner catalog: one entry per vendor model, no runner scoping. */
  orchestratorModels: ModelView[];
  /** Providers with a working API key — the `key` command's checkmarks. */
  providers: string[];
  providerErrors: Record<string, string>;
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
  for (const [runner, entries] of Object.entries(result.modelsByRunner ?? {}) as [string, any[]][]) {
    for (const entry of entries ?? []) {
      const id = String(entry.modelId ?? entry.id);
      runnersByModel.set(id, [...new Set([...(runnersByModel.get(id) ?? []), runner])]);
    }
  }

  const models: ModelView[] = (result.models ?? []).map((m: any) => {
    const id = String(m.modelId ?? m.id);
    return {
      id,
      label: String(m.modelLabel ?? m.label ?? id),
      provider: String(m.runnerProviderLabel ?? m.runnerProvider ?? m.provider ?? ''),
      pricing: m.pricing ? `$${m.pricing}/MTok` : undefined,
      variants: Array.isArray(m.variants)
        ? m.variants.map((v: any) => ({ id: String(v.id), label: String(v.label ?? v.id) }))
        : [],
      runners: runnersByModel.get(id) ?? [],
    };
  });

  // The orchestrator/planner catalog spans every configured provider, each
  // option already carrying its human provider label (e.g. "OpenRouter").
  const orchestratorModels: ModelView[] = (result.orchestratorModels ?? []).map((m: any) => ({
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
    modesByRunner: Object.fromEntries(
      Object.entries(result.modesByRunner ?? {}).map(([runner, modes]) => [
        runner,
        (modes ?? []).map((m: any) => ({
          id: String(m.id),
          label: String(m.label ?? m.id),
          description: m.description ? String(m.description) : undefined,
        })),
      ]),
    ),
  };
}

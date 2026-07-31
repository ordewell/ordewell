import type { AiProvider } from '../interfaces/IConfig';
import { PROVIDER_PRIORITY, getProviderMeta, prefixModelId } from './ProviderRegistry';

export type ProviderModelLists = Record<string, string[]>;

export interface OrchestratorOption {
  id: string;
  label: string;
  provider: string;
  apiProvider: AiProvider;
  description?: string;
  pricing?: string;
}

import type { CatalogModel } from './ModelCatalog';
import type { DiscoveredModel } from '../models/Task';
import type { ModelShortcut } from './ModelShortcuts';
import { extractProvider } from './ModelShortcuts';
import { ModelCatalog } from './ModelCatalog';
import { discoverGeminiModels } from './ModelDiscovery';

export interface FetchAllProviderModelsOptions {
  apiKeys: Record<string, string>;
  baseUrls: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export type AllProviderModels = Record<string, CatalogModel[]>;

/**
 * Result of a picker-catalog fetch fan-out: the per-provider model lists plus
 * the per-provider failures. `errors` is keyed by provider id and holds the
 * failure message for any provider whose catalog fetch rejected — the seam the
 * surfaces (CLI, VS Code) use to flag "this configured provider didn't work"
 * rather than silently showing a short list.
 */
export interface ProviderModelsResult {
  models: AllProviderModels;
  errors: Record<string, string>;
}

/** The provider config fields the discovery fan-out needs. */
export interface ProviderCredentialSource {
  getProviderApiKey(provider: AiProvider): string;
  getProviderBaseUrl(provider: AiProvider): string;
  openaiCompatibleBaseUrl: string;
}

/**
 * Collect the API keys and base URLs the picker fan-out should probe, applying
 * the single "configured" policy shared by every surface (CLI + VS Code):
 *  - a preset is discovered only when it has an API key (OpenRouter included —
 *    its public catalog is not probed keyless, matching the product rule that
 *    only key-configured providers appear);
 *  - `openai_compatible` is discovered only when an explicit endpoint is set
 *    (keyless local servers like ollama / LM Studio).
 * Base URLs are handed through only for providers that pass the gate, so the
 * fan-out never touches an unconfigured third-party endpoint.
 */
export function collectProviderCredentials(config: ProviderCredentialSource): {
  apiKeys: Record<string, string>;
  baseUrls: Record<string, string>;
} {
  const apiKeys: Record<string, string> = {};
  const baseUrls: Record<string, string> = {};
  for (const provider of PROVIDER_PRIORITY) {
    const key = config.getProviderApiKey(provider);
    if (key) apiKeys[provider] = key;
  }
  for (const provider of PROVIDER_PRIORITY) {
    const url = config.getProviderBaseUrl(provider);
    if (!url) continue;
    if (provider === 'openai_compatible') {
      if (config.openaiCompatibleBaseUrl) baseUrls[provider] = url;
    } else if (apiKeys[provider]) {
      baseUrls[provider] = url;
    }
  }
  return { apiKeys, baseUrls };
}

function discoveredToCatalog(m: DiscoveredModel): CatalogModel {
  return {
    id: m.modelId,
    name: m.modelLabel,
    description: '',
    pricing: { prompt: '?', completion: '?' },
    contextLength: 0,
  };
}

export async function fetchAllProviderModels(
  opts: FetchAllProviderModelsOptions,
): Promise<ProviderModelsResult> {
  const entries: [string, () => Promise<CatalogModel[]>][] = [];

  for (const provider of PROVIDER_PRIORITY) {
    const meta = getProviderMeta(provider);
    if (!meta || !meta.discoversModels) continue;

    if (provider === 'google') {
      if (!opts.apiKeys[provider]) continue;
      entries.push([
        provider,
        async () => {
          const models = await discoverGeminiModels(
            opts.apiKeys[provider],
            opts.baseUrls[provider] || undefined,
            opts.fetchImpl,
          );
          return models.map(discoveredToCatalog);
        },
      ]);
    } else if (provider === 'openrouter') {
      // OpenRouter's catalog is technically public, but the product rule is
      // "only providers with a key set are shown", so it needs a key like any
      // other preset.
      if (!opts.apiKeys[provider]) continue;
      entries.push([
        provider,
        async () =>
          ModelCatalog.fetchModels(
            opts.apiKeys[provider],
            opts.baseUrls[provider] || undefined,
            opts.fetchImpl,
          ),
      ]);
    } else {
      const baseUrl = opts.baseUrls[provider];
      const apiKey = opts.apiKeys[provider];
      if (!baseUrl) continue;
      entries.push([
        provider,
        async () =>
          ModelCatalog.fetchModels(
            apiKey ?? '',
            baseUrl,
            opts.fetchImpl,
          ),
      ]);
    }
  }

  const results = await Promise.allSettled(entries.map(([, fn]) => fn()));
  const models: AllProviderModels = {};
  const errors: Record<string, string> = {};

  for (let i = 0; i < entries.length; i++) {
    const [provider] = entries[i];
    const result = results[i];
    if (result.status === 'fulfilled') {
      models[provider] = result.value;
    } else {
      models[provider] = [];
      const reason = result.reason;
      errors[provider] = reason instanceof Error ? reason.message : String(reason);
    }
  }

  return { models, errors };
}

export function resolveProvider(
  modelId: string,
  providerModelLists: Record<string, string[]>,
): AiProvider | null {
  for (const provider of PROVIDER_PRIORITY) {
    const list = providerModelLists[provider];
    if (list && list.includes(modelId)) return provider;
  }
  return null;
}

function perMTok(prompt: string, completion: string): string | undefined {
  const p = parseFloat(prompt);
  const c = parseFloat(completion);
  if (!isFinite(p) || !isFinite(c)) return undefined;
  const fmt = (n: number) => String(+(n * 1_000_000).toFixed(2));
  return `${fmt(p)}/${fmt(c)}`;
}

export function toOrchestratorOptions(
  providerModels: AllProviderModels,
  shortcuts: ModelShortcut[],
): OrchestratorOption[] {
  const seen = new Set<string>();
  const options: OrchestratorOption[] = [];
  const shortcutById = new Map(shortcuts.map((s) => [s.id, s]));

  for (const provider of PROVIDER_PRIORITY) {
    const models = providerModels[provider];
    if (!models || models.length === 0) continue;

    for (const m of models) {
      const id = prefixModelId(provider, m.id);
      if (seen.has(id)) continue;
      seen.add(id);

      const s = shortcutById.get(id);
      let providerLabel: string;
      let pricing: string | undefined;

      if (provider === 'openrouter') {
        const rawProvider = extractProvider(m.id);
        providerLabel = s?.provider
          || (rawProvider ? rawProvider.charAt(0).toUpperCase() + rawProvider.slice(1) : 'OpenRouter');
        const livePricing = m.pricing?.prompt && m.pricing?.completion
          ? perMTok(m.pricing.prompt, m.pricing.completion)
          : undefined;
        pricing = livePricing ?? s?.pricing;
      } else {
        const meta = getProviderMeta(provider);
        providerLabel = s?.provider || meta?.shortLabel || provider;
        pricing = s?.pricing;
      }

      options.push({
        id,
        label: s?.label || m.name || m.id,
        provider: providerLabel,
        apiProvider: provider,
        description: s?.description || m.description || undefined,
        pricing,
      });
    }
  }

  const shortcutOrder = new Map(shortcuts.map((s, i) => [s.id, i]));
  return [
    ...options.filter((o) => shortcutOrder.has(o.id)).sort((a, b) => shortcutOrder.get(a.id)! - shortcutOrder.get(b.id)!),
    ...options.filter((o) => !shortcutOrder.has(o.id)),
  ];
}

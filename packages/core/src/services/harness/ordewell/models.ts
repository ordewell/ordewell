import type { AiProvider } from '../../../interfaces/IConfig';
import type { DiscoveredModel } from '../../../models/Task';
import type { RunnerEnv } from '../../../plugins/types';
import { VENDORS, vendorApiKeyIn, vendorBaseUrlIn, vendorConfiguredIn } from '../../apiProviders';
import type { CatalogModel } from '../../ModelCatalog';
import type { EffortLevel } from '../../model';

/**
 * What the loop and its later slices (compaction, caching, the step limit)
 * read about one model. Every field has a value, so a reader never branches on
 * absence; `known` says which values a catalog stated and which are the
 * conservative defaults below, so a later source (models.dev) can fill only
 * what is still defaulted.
 */
export interface ModelInfo {
  /** `<provider>:<model>`, as plans hold it. */
  id: string;
  provider: AiProvider;
  /** The provider's own id, which requests carry. */
  model: string;
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per million tokens; 0 where `known.pricing` is false. */
  pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
  supportsTools: boolean;
  supportsReasoning: boolean;
  /** The effort levels to offer: empty unless the model is known to reason. */
  efforts: EffortLevel[];
  known: Record<'contextWindow' | 'maxOutputTokens' | 'pricing' | 'supportsTools' | 'supportsReasoning', boolean>;
}

/**
 * Defaults that fail safe: a small window makes compaction start early rather
 * than overflow, a small reply cap is one every served model accepts, and
 * tools are assumed because a runner without them cannot work at all, so a
 * model that refuses them fails loudly on its first step.
 */
export const DEFAULT_MODEL_INFO: Readonly<Pick<ModelInfo, 'contextWindow' | 'maxOutputTokens' | 'supportsTools' | 'supportsReasoning'>> = {
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  supportsTools: true,
  supportsReasoning: false,
};

/** The provider part ends at the first `:`, since a model id may hold more (`openai_compatible:qwen3:8b`). */
export function parseModelId(id: string): { provider: AiProvider; model: string } | undefined {
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) return undefined;
  const provider = id.slice(0, at);
  if (!Object.hasOwn(VENDORS, provider)) return undefined;
  return { provider: provider as AiProvider, model: id.slice(at + 1) };
}

export function ordewellModelId(provider: AiProvider, model: string): string {
  return `${provider}:${model}`;
}

/** The info for a model no catalog described: every value defaulted and marked so. */
export function defaultModelInfo(provider: AiProvider, model: string): ModelInfo {
  return {
    id: ordewellModelId(provider, model),
    provider,
    model,
    label: model,
    ...DEFAULT_MODEL_INFO,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    efforts: [],
    known: { contextWindow: false, maxOutputTokens: false, pricing: false, supportsTools: false, supportsReasoning: false },
  };
}

/** A catalog price is USD per token as a string, or '?' when the listing did not say. */
function perMillion(price: string): number | undefined {
  const value = Number(price);
  return price.trim() !== '' && Number.isFinite(value) && value >= 0 ? value * 1_000_000 : undefined;
}

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * models.dev lists levels the adapters have no name for (`none`, `minimal`,
 * `default`), which are dropped. A model known to reason that lists none we
 * can offer still takes the three every adapter maps.
 */
function effortsFor(listed: string[] | undefined): EffortLevel[] {
  const offered = EFFORT_LEVELS.filter((level) => listed?.includes(level));
  return offered.length > 0 ? offered : ['low', 'medium', 'high'];
}

export function modelInfoFromCatalog(provider: AiProvider, entry: CatalogModel): ModelInfo {
  const info = defaultModelInfo(provider, entry.id);
  info.label = entry.name || entry.id;
  if (entry.contextLength > 0) {
    info.contextWindow = entry.contextLength;
    info.known.contextWindow = true;
  }
  if (entry.maxOutputTokens !== undefined && entry.maxOutputTokens > 0) {
    info.maxOutputTokens = entry.maxOutputTokens;
    info.known.maxOutputTokens = true;
  }
  const input = perMillion(entry.pricing.prompt);
  const output = perMillion(entry.pricing.completion);
  if (input !== undefined && output !== undefined) {
    info.pricing = { input, output, cacheRead: entry.cachePricing?.read ?? 0, cacheWrite: entry.cachePricing?.write ?? 0 };
    info.known.pricing = true;
  }
  if (entry.reasoning !== undefined) {
    info.supportsReasoning = entry.reasoning;
    info.known.supportsReasoning = true;
    if (entry.reasoning) info.efforts = effortsFor(entry.efforts);
  }
  if (entry.tools !== undefined) {
    info.supportsTools = entry.tools;
    info.known.supportsTools = true;
  }
  return info;
}

/**
 * How the runner reaches `provider` under `env`, or undefined where `env` does
 * not set it up: the same rule its listing uses (RunnerInstallation), so a
 * runner that is listed can start. The key is empty only for a local
 * `openai_compatible` endpoint, which is set up by its URL and takes none.
 */
export function providerCredentials(env: RunnerEnv, provider: AiProvider): { apiKey: string; baseUrl: string } | undefined {
  if (!vendorConfiguredIn(env, provider)) return undefined;
  return { apiKey: vendorApiKeyIn(env, provider), baseUrl: vendorBaseUrlIn(env, provider) };
}

/** One provider's catalog as model infos; empty where `env` does not set the provider up. */
export async function listProviderModels(env: RunnerEnv, provider: AiProvider, fetchImpl?: typeof fetch): Promise<ModelInfo[]> {
  const credentials = providerCredentials(env, provider);
  if (!credentials) return [];
  // Imported here: ProviderRouting reaches back into ModelDiscovery, which
  // imports this module for the runner's discovery branch.
  const { fetchAllProviderModels } = await import('../../ProviderRouting');
  // Only this provider's credentials go in, so no other catalog is fetched.
  const { models } = await fetchAllProviderModels({
    apiKeys: credentials.apiKey ? { [provider]: credentials.apiKey } : {},
    baseUrls: credentials.baseUrl ? { [provider]: credentials.baseUrl } : {},
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return (models[provider] ?? []).map((entry) => modelInfoFromCatalog(provider, entry));
}

/** The model list of the runner on `provider`, each model marked with it through `runnerProvider`. */
export async function discoverProviderModels(env: RunnerEnv, provider: AiProvider, fetchImpl?: typeof fetch): Promise<DiscoveredModel[]> {
  const infos = await listProviderModels(env, provider, fetchImpl);
  // A model the catalog knows takes no tools cannot run this runner at all, so
  // it is not offered; one the catalog is silent on stays (the default assumes tools).
  return infos.filter((info) => !(info.known.supportsTools && !info.supportsTools)).map((info) => ({
    modelId: info.id,
    modelLabel: info.label,
    runnerProvider: info.provider,
    runnerProviderLabel: VENDORS[info.provider].label,
    variants: info.efforts.map((level) => ({ id: level, label: level })),
    ...(info.known.contextWindow ? { contextWindow: info.contextWindow } : {}),
    ...(info.known.maxOutputTokens ? { maxOutputTokens: info.maxOutputTokens } : {}),
  }));
}

/**
 * One model's info for an attempt. A catalog that fails or is slow costs the
 * attempt nothing but defaults: the model id is the plan's, never something
 * a listing has to confirm (ADR-0040).
 */
export async function lookupModelInfo(
  id: string,
  env: RunnerEnv,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelInfo> {
  const parsed = parseModelId(id);
  if (!parsed) throw new Error(`"${id}" is not a built-in runner model: assign one as <provider>:<model>.`);
  const fallback = defaultModelInfo(parsed.provider, parsed.model);
  if (!providerCredentials(env, parsed.provider)) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listed = listProviderModels(env, parsed.provider, options.fetchImpl);
    const timeout = new Promise<ModelInfo[]>((resolve) => {
      timer = setTimeout(() => resolve([]), options.timeoutMs ?? 5_000);
      timer.unref?.();
    });
    const infos = await Promise.race([listed, timeout]);
    return infos.find((info) => info.model === parsed.model) ?? fallback;
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

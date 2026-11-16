import type { AiProvider } from '../interfaces/IConfig';
import { PROVIDER_PRIORITY, VENDORS, vendorConfiguredIn, type VendorEnv } from './apiProviders';

/**
 * The built-in runner's identity (ADR-0070): one runner per API provider, under
 * that provider's own id and label, so "OpenRouter" in the runner selector and
 * "OpenRouter" in the planner selector both mean Ordewell's own loop on
 * OpenRouter. One implementation stands behind them all; only the provider
 * differs. Browser-safe, so a surface can tell a provider runner from a coding
 * agent and name it without the manifests.
 */

/**
 * Every provider runner's id, in provider priority order, which is their picker
 * order after the coding agents. A provider whose models cannot be listed
 * (Perplexity) has none: a runner with no model to offer could take a task and
 * never start it. Its key still serves the API planner.
 */
export const PROVIDER_RUNNER_IDS: readonly AiProvider[] = PROVIDER_PRIORITY.filter((provider) => VENDORS[provider].discoversModels);

/** Whether a runner id is one of the built-in runner's, one per provider. */
export function isProviderRunner(runner: string): runner is AiProvider {
  return (PROVIDER_RUNNER_IDS as readonly string[]).includes(runner);
}

/** The name a provider runner is shown under, its provider's; undefined for any other runner. */
export function providerRunnerLabel(runner: string): string | undefined {
  return isProviderRunner(runner) ? VENDORS[runner].label : undefined;
}

/**
 * The provider runner `/login <name>` names, by its id or its provider's label
 * in any case, whether or not its key is set: either way it has no login.
 */
export function providerRunnerNamed(named: string): AiProvider | undefined {
  const wanted = named.trim().toLowerCase();
  return PROVIDER_RUNNER_IDS.find((id) => id === wanted || VENDORS[id].label.toLowerCase() === wanted);
}

/**
 * What `/login` answers for a provider runner, on every surface: it has none,
 * since what lists it is its provider's key, or for Custom the endpoint, which
 * may take no key at all, and `/key-set` is how either changes.
 */
export function providerRunnerLoginNote(provider: AiProvider): string {
  const { label, baseUrlEnvVar } = VENDORS[provider];
  if (provider === 'openai_compatible') return `${label} has no login: it runs on the endpoint ${baseUrlEnvVar} names, which /key-set ${provider} replaces.`;
  return `${label} has no login: it runs on its API key, which /key-set ${provider} replaces.`;
}

/**
 * The provider runners `env` sets up, in picker order: the ones a host lists,
 * since a provider runner is installed exactly when its provider is configured.
 */
export function configuredProviderRunners(env: VendorEnv): AiProvider[] {
  return PROVIDER_RUNNER_IDS.filter((provider) => vendorConfiguredIn(env, provider));
}

/**
 * The one id the built-in runner had before it was one runner per provider.
 * Nothing assigns it now; a saved plan or settings file that still names it is
 * moved onto the provider runners as it is read.
 */
export const LEGACY_BUILTIN_RUNNER = 'ordewell';

/** The provider runner an old built-in runner model id (`<provider>:<model>`) belongs to, or undefined. */
export function providerOfBuiltinModel(modelId: string | undefined): AiProvider | undefined {
  const at = modelId?.indexOf(':') ?? -1;
  if (!modelId || at <= 0) return undefined;
  const provider = modelId.slice(0, at);
  return isProviderRunner(provider) ? provider : undefined;
}

/** `runners` with the old built-in runner's id replaced by `replacements` where it stood, each runner once. */
export function replaceLegacyBuiltinRunner(runners: readonly string[], replacements: readonly string[]): string[] {
  if (!runners.includes(LEGACY_BUILTIN_RUNNER)) return [...runners];
  return [...new Set(runners.flatMap((runner): string[] => (runner === LEGACY_BUILTIN_RUNNER ? [...replacements] : [runner])))];
}

/**
 * Move a settings file's old built-in runner entries onto the provider runners
 * (ADR-0070), in place. Enabling the old runner meant every keyed provider, as
 * far as its allowlist let it: so its enabled entry becomes the runners of the
 * providers `configured` names, or, with an allowlist, of those it names too,
 * since a provider it named no model of would otherwise be enabled and
 * unrestricted. While that leaves none, both entries stay as they were, ignored
 * as an unknown runner is, and each later read tries again: an expansion made
 * then and saved would lose the entry for good.
 */
export function moveOffLegacyBuiltinSettings(
  settings: { enabledRunners?: string[]; modelAllowlist?: Record<string, string[]> },
  configured: () => readonly AiProvider[],
): void {
  const legacyAllowlist = settings.modelAllowlist?.[LEGACY_BUILTIN_RUNNER];
  const enabled = settings.enabledRunners;
  if (enabled?.includes(LEGACY_BUILTIN_RUNNER)) {
    const named = legacyAllowlist?.length ? new Set(legacyAllowlist.map(providerOfBuiltinModel)) : undefined;
    const providers = configured().filter((provider) => !named || named.has(provider));
    if (providers.length === 0) return;
    settings.enabledRunners = replaceLegacyBuiltinRunner(enabled, providers);
  }
  if (legacyAllowlist && settings.modelAllowlist) {
    const split = splitLegacyBuiltinAllowlist(settings.modelAllowlist);
    settings.modelAllowlist = Object.keys(split).length > 0 ? split : undefined;
  }
}

/**
 * A model allowlist whose old built-in runner entry is split into each
 * provider runner's own, by the provider each model id names: the models
 * allowed stay allowed, on the runner that now offers them.
 */
export function splitLegacyBuiltinAllowlist(allowlist: Readonly<Record<string, string[]>>): Record<string, string[]> {
  const legacy = allowlist[LEGACY_BUILTIN_RUNNER];
  if (!legacy) return { ...allowlist };
  const out: Record<string, string[]> = {};
  for (const [runner, ids] of Object.entries(allowlist)) if (runner !== LEGACY_BUILTIN_RUNNER) out[runner] = [...ids];
  for (const id of legacy) {
    const provider = providerOfBuiltinModel(id);
    if (!provider) continue;
    const ids = (out[provider] ??= []);
    if (!ids.includes(id)) ids.push(id);
  }
  return out;
}

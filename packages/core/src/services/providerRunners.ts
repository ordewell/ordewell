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

/** Every provider runner's id, in provider priority order, which is their picker order after the coding agents. */
export const PROVIDER_RUNNER_IDS: readonly AiProvider[] = PROVIDER_PRIORITY;

/** Whether a runner id is one of the built-in runner's, one per provider. */
export function isProviderRunner(runner: string): runner is AiProvider {
  return Object.hasOwn(VENDORS, runner);
}

/** The name a provider runner is shown under, its provider's; undefined for any other runner. */
export function providerRunnerLabel(runner: string): string | undefined {
  return isProviderRunner(runner) ? VENDORS[runner].label : undefined;
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

/** `runners` with the old built-in runner's id replaced by `providers` where it stood, each runner once. */
export function replaceLegacyBuiltinRunner(runners: readonly string[], providers: readonly AiProvider[]): string[] {
  if (!runners.includes(LEGACY_BUILTIN_RUNNER)) return [...runners];
  return [...new Set(runners.flatMap((runner): string[] => (runner === LEGACY_BUILTIN_RUNNER ? [...providers] : [runner])))];
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

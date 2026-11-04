import type { AiProvider, PlannerBackendId } from '../interfaces/IConfig';
import type { RunnerId } from '../models/Task';
import { BUILTIN_MANIFESTS } from '../plugins/builtin';
import { connectorFor } from './harness/connectors';
import { PROVIDER_PRIORITY, VENDORS, type ProviderRegistration } from './apiProviders';
import type { RunnerAuth } from './runnerAuth';

export { PROVIDER_DETECT_PRIORITY, PROVIDER_PRIORITY, type ProviderRegistration } from './apiProviders';

/**
 * Keyed by planner backend: every vendor has an entry, and a runner id has one
 * only when that runner can plan, which the type cannot know.
 */
export type ByPlannerBackend<T> = Readonly<Record<AiProvider, T>> & Readonly<Partial<Record<RunnerId, T>>>;

/**
 * The harness planners (ADR-0009): every built-in runner whose connector plans,
 * in manifest order and under its manifest's name. No key, no base URL,
 * no HTTP catalog: the binary is local, the credential is the user's existing
 * subscription, and the model list comes from the runner's own discovery.
 * `apiKeyEnvVar` is empty on purpose — anything that resolves keys must skip
 * these, which is what `isCliProvider` is for.
 */
const HARNESS_PLANNERS: readonly ProviderRegistration[] = BUILTIN_MANIFESTS
  .filter((manifest) => connectorFor(manifest.name)?.plans === true)
  .map((manifest) => ({
    id: manifest.name, label: manifest.displayName, shortLabel: manifest.displayName,
    serviceType: 'cli', runnerId: manifest.name,
    defaultBaseUrl: '',
    apiKeyEnvVar: '',
    detectEnvVars: [],
    discoversModels: false,
  }));

export const ALL_PROVIDERS: ByPlannerBackend<ProviderRegistration> = {
  ...VENDORS,
  ...Object.fromEntries(HARNESS_PLANNERS.map((registration) => [registration.id, registration])),
};

const labelsBy = (pick: (registration: ProviderRegistration) => string): ByPlannerBackend<string> => ({
  ...(Object.fromEntries(Object.entries(VENDORS).map(([id, registration]) => [id, pick(registration)])) as Record<AiProvider, string>),
  ...Object.fromEntries(HARNESS_PLANNERS.map((registration) => [registration.id, pick(registration)])),
});

export const PROVIDER_LABEL: ByPlannerBackend<string> = labelsBy((registration) => registration.label);
export const PROVIDER_SHORT_LABEL: ByPlannerBackend<string> = labelsBy((registration) => registration.shortLabel);

export function getProviderMeta(id: AiProvider): ProviderRegistration;
export function getProviderMeta(id: PlannerBackendId): ProviderRegistration | undefined;
export function getProviderMeta(id: PlannerBackendId): ProviderRegistration | undefined {
  return Object.hasOwn(ALL_PROVIDERS, id) ? ALL_PROVIDERS[id] : undefined;
}

/** Whether a planner backend id names an API vendor, the kind that takes a key and a base URL. */
export function isApiProvider(id: PlannerBackendId): id is AiProvider {
  return Object.hasOwn(VENDORS, id);
}

/** Whether an id names a planner backend at all: a vendor, or a runner that can plan. */
export function isPlannerBackend(id: string): id is PlannerBackendId {
  return getProviderMeta(id) !== undefined;
}

export function prefixModelId(provider: PlannerBackendId, modelId: string): string {
  const meta = getProviderMeta(provider);
  return meta?.modelPrefix ? `${meta.modelPrefix}${modelId}` : modelId;
}

export function stripModelPrefix(id: string, provider: PlannerBackendId): string {
  const meta = getProviderMeta(provider);
  if (meta?.modelPrefix && id.startsWith(meta.modelPrefix)) {
    return id.slice(meta.modelPrefix.length);
  }
  return id;
}

export function resolveProviderFromPrefix(id: string): AiProvider | null {
  for (const provider of PROVIDER_PRIORITY) {
    const meta = ALL_PROVIDERS[provider];
    if (meta.modelPrefix && id.startsWith(meta.modelPrefix)) return provider;
  }
  return null;
}

/**
 * The harness planners, in display order. Deliberately NOT part of
 * `PROVIDER_PRIORITY`: that list means "vendors that take an API key", and
 * every consumer of it — key prompts, catalog fetches, base-URL cache clearing
 * — would be asking a local binary for a credential it does not have. Surfaces
 * that offer a planner picker concatenate the two lists and gate these on
 * `RunnerInstallation.plannerUsability`.
 */
export const CLI_PROVIDERS: readonly RunnerId[] = HARNESS_PLANNERS.map((registration) => registration.id);

export function isOpenAiProvider(id: PlannerBackendId): boolean {
  return getProviderMeta(id)?.serviceType === 'openai';
}

/**
 * The one guard that separates a harness planner from an LLM vendor (ADR-0009).
 * Three places consult it: API-key resolution (skipped — the subscription is
 * the credential), provider routing (skipped — there is no HTTP endpoint), and
 * the planner-model picker (fed by per-runner discovery, not the vendor
 * catalog).
 */
export function isCliProvider(id: PlannerBackendId): boolean {
  return getProviderMeta(id)?.serviceType === 'cli';
}

/** The runner a harness planner drives, or null for a vendor provider or an unknown id. */
export function runnerForProvider(id: PlannerBackendId): RunnerId | null {
  return getProviderMeta(id)?.runnerId ?? null;
}

/** The harness planner that wraps a given runner, or null when none does. */
export function providerForRunner(runner: RunnerId): PlannerBackendId | null {
  return HARNESS_PLANNERS.find((registration) => registration.runnerId === runner)?.id ?? null;
}

/** One runner's planner usability, as `RunnerInstallation.plannerUsability` reports it. */
export interface PlannerUsability {
  usable: boolean;
  reason?: string;
  /** The runner's own login verdict, beside usability: a signed-out agent is still offered. */
  auth?: RunnerAuth;
}

/**
 * One entry of the planner backend list (ADR-0009). `id` is the
 * `PlannerBackendId` either way; `runner` is set only for a harness planner, whose model catalog
 * comes from that runner, and `reason` is the second line a surface renders —
 * the block detail for a harness planner, the API-key variable for a vendor.
 */
export interface PlannerBackendEntry {
  id: PlannerBackendId;
  label: string;
  kind: 'harness' | 'vendor';
  runner?: string;
  usable: boolean;
  reason?: string;
  /** Set for a harness planner whose login status was asked; never a gate on `usable`. */
  auth?: RunnerAuth;
}

/** The detail a usable harness planner is always shown with. */
export const HARNESS_PLANNER_REASON = 'coding agent · no API key needed';

/** Shown for a harness planner no host has reported a status for: it may not be installed. */
export const HARNESS_PLANNER_UNAVAILABLE_REASON = 'not available';

/**
 * The planner backends every surface offers, in order: the harness planners
 * first, always listed so a missing CLI is greyed with its reason rather than
 * hidden, then the configured vendors in `PROVIDER_PRIORITY` order. Pure: the
 * caller supplies what it knows of each runner (VS Code its `plannerUsability`
 * results, the TUI its installed set) and maps the entries to its own item
 * type, keeping surface-specific affordances — e.g. the CLI's empty-vendor
 * placeholder — to itself.
 */
export function plannerBackendEntries(
  usability: Readonly<Record<string, PlannerUsability>>,
  configured: readonly AiProvider[],
): PlannerBackendEntry[] {
  const harness: PlannerBackendEntry[] = HARNESS_PLANNERS.map(({ id, label, runnerId }) => {
    const runner = runnerId ?? id;
    const status = usability[runner];
    const signedOut = status?.auth?.state === 'signed-out';
    return {
      id,
      label,
      kind: 'harness' as const,
      runner,
      usable: status?.usable ?? false,
      reason: status
        ? (status.reason ?? (signedOut ? (status.auth?.detail ?? 'not logged in') : HARNESS_PLANNER_REASON))
        : HARNESS_PLANNER_UNAVAILABLE_REASON,
      ...(status?.auth ? { auth: status.auth } : {}),
    };
  });
  const vendors: PlannerBackendEntry[] = PROVIDER_PRIORITY
    .filter((id) => configured.includes(id))
    .map((id) => ({
      id,
      label: getProviderMeta(id).label,
      kind: 'vendor' as const,
      usable: true,
      reason: getProviderMeta(id).apiKeyEnvVar,
    }));
  return [...harness, ...vendors];
}

/**
 * The single definition of which providers count as "configured" — one API
 * key each, or (for `openai_compatible`) an explicit base URL. Every surface
 * (CLI listing, VS Code picker gating) derives its configured-provider set
 * from here so they can never diverge on what a user has set up. Order follows
 * PROVIDER_PRIORITY.
 */
export function configuredProviders(config: {
  getProviderApiKey(provider: AiProvider): string;
  openaiCompatibleBaseUrl: string;
}): AiProvider[] {
  const out: AiProvider[] = [];
  for (const provider of PROVIDER_PRIORITY) {
    if (provider === 'openai_compatible') {
      if (config.openaiCompatibleBaseUrl) out.push(provider);
    } else if (config.getProviderApiKey(provider)) {
      out.push(provider);
    }
  }
  return out;
}

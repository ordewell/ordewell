import type { AiProvider } from '../../interfaces/IConfig';
import { PROVIDER_PRIORITY, VENDORS, vendorApiKeyIn, vendorBaseUrlIn, type VendorEnv } from '../apiProviders';

/*
 * The provider key a person configured once in Ordewell (`/key`, or the
 * variable it writes), handed to an ACP agent's spawn so the agent needs no
 * login of its own (ADR-0060, R9). It is read from the spawn's own variables,
 * where `/key` put it, afresh for each spawn, and is returned to the hook that
 * asked and to nothing else: never logged, kept, written or put in an error
 * (ADR-0051).
 */

/** One of Ordewell's vendors, as an agent's variables need it. */
export interface OrdewellProvider {
  vendor: AiProvider;
  apiKey: string;
  baseUrl: string;
  /** Ordewell's planner model, only where the planner was named as this vendor: no other model of Ordewell's is that vendor's for certain. */
  model?: string;
}

/**
 * The vendor whose key an agent is handed: the one AI_PROVIDER names, else the
 * first configured in PROVIDER_PRIORITY. Only an OpenAI-compatible vendor
 * with a key qualifies, and only one the agent can reach at the endpoint
 * Ordewell reaches it at, which `reaches` judges per agent. Null when none
 * does.
 */
export function ordewellProvider(env: VendorEnv, reaches: (vendor: AiProvider, baseUrl: string) => boolean): OrdewellProvider | null {
  const named = env.AI_PROVIDER?.trim() ?? '';
  const explicit = Object.hasOwn(VENDORS, named) ? (named as AiProvider) : null;
  for (const vendor of explicit ? [explicit, ...PROVIDER_PRIORITY] : PROVIDER_PRIORITY) {
    const meta = VENDORS[vendor];
    if (meta.serviceType !== 'openai') continue;
    const apiKey = vendorApiKeyIn(env, vendor);
    if (!apiKey) continue;
    // A custom endpoint is configured only by naming it; its default is a guess at a local server.
    if (vendor === 'openai_compatible' && !(meta.baseUrlEnvVar && env[meta.baseUrlEnvVar]?.trim())) continue;
    const baseUrl = vendorBaseUrlIn(env, vendor);
    if (!reaches(vendor, baseUrl)) continue;
    const model = vendor === explicit ? plannerModel(env, vendor) : undefined;
    return { vendor, apiKey, baseUrl, ...(model ? { model } : {}) };
  }
  return null;
}

function plannerModel(env: VendorEnv, vendor: AiProvider): string | undefined {
  const model = env.ORCHESTRATOR_MODEL?.trim();
  if (!model) return undefined;
  const prefix = VENDORS[vendor].modelPrefix;
  return prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

import type { AiProvider } from '../../interfaces/IConfig';
import { VENDORS, vendorApiKeyIn, vendorBaseUrlIn, type VendorEnv } from '../apiProviders';

/**
 * The one variable that gives an OpenCode planner Ordewell's own research
 * agent (ADR-0066): `<provider>:<model>`, read from the environment a
 * workspace's planner runs with, so `.ordewell/env` (ADR-0016) can set it per
 * workspace. The provider's key is its own existing variable.
 */
export const RESEARCH_AGENT_MODEL_ENV = 'ORDEWELL_RESEARCH_AGENT_MODEL';

export type ResearchAgentSetting =
  | { kind: 'absent' }
  /** Set, but no agent can run on it; the reason is for the user. */
  | { kind: 'unavailable'; reason: string }
  | OfferedResearchAgent;

export interface OfferedResearchAgent { kind: 'offered'; vendor: AiProvider; model: string; apiKey: string; baseUrl: string }

const FORM = `${RESEARCH_AGENT_MODEL_ENV} must be <provider>:<model>, e.g. openrouter:deepseek/deepseek-v4.1-flash`;

export function researchAgentSetting(env: VendorEnv): ResearchAgentSetting {
  const value = env[RESEARCH_AGENT_MODEL_ENV]?.trim();
  if (!value) return { kind: 'absent' };
  const colon = value.indexOf(':');
  const provider = colon < 0 ? '' : value.slice(0, colon).trim();
  const model = colon < 0 ? '' : value.slice(colon + 1).trim();
  if (!provider || !model || !Object.hasOwn(VENDORS, provider)) return { kind: 'unavailable', reason: `${FORM}, with a provider Ordewell knows; it is "${value}".` };
  const vendor = provider as AiProvider;
  // The agent runs on the OpenAI-compatible chat service, which Gemini's own API is not.
  if (VENDORS[vendor].serviceType !== 'openai') return { kind: 'unavailable', reason: `${VENDORS[vendor].label} cannot serve the research agent: name an OpenAI-compatible provider, such as openrouter.` };
  const apiKey = vendorApiKeyIn(env, vendor);
  if (!apiKey) return { kind: 'unavailable', reason: `${RESEARCH_AGENT_MODEL_ENV} names ${VENDORS[vendor].label}, but ${VENDORS[vendor].apiKeyEnvVar} is not set.` };
  return { kind: 'offered', vendor, model, apiKey, baseUrl: vendorBaseUrlIn(env, vendor) };
}

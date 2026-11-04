import type { RunnerCredentials } from '../../plugins/types';
import { ordewellProvider } from './ordewellProvider';

/**
 * The hook a Qwen profile carries: the key of the OpenAI-compatible vendor
 * configured in Ordewell, as the `OPENAI_*` variables Qwen's `openai` auth
 * reads (ADR-0060, R9). Qwen reaches any OpenAI-compatible endpoint it is
 * given, so every such vendor of Ordewell's qualifies.
 */
export const qwenCredentials: RunnerCredentials = async ({ env }) => {
  // The user's own route: a key alone in OPENAI_API_KEY is also Ordewell's
  // `openai` vendor, but an endpoint of their own says the variables are Qwen's.
  if (env.OPENAI_BASE_URL) return null;
  const own = ordewellProvider(env, () => true);
  // Qwen reads its own settings and sign-in where Ordewell has none to hand it,
  // and says so itself when it has none either.
  if (!own) return null;
  const model = env.OPENAI_MODEL ? undefined : own.model;
  return { OPENAI_API_KEY: own.apiKey, OPENAI_BASE_URL: own.baseUrl, ...(model ? { OPENAI_MODEL: model } : {}) };
};

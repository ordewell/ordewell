import type { RunnerCredentials, RunnerEnv } from '../../plugins/types';
import { vendorApiKeyIn } from '../apiProviders';

/**
 * The switches that say the person already chose how Gemini CLI reaches
 * Google, so Ordewell's key is not this spawn's route (ADR-0060, R9). Gemini
 * 0.66 resolves a settings file's `security.auth.selectedType` first, then
 * these variables in this order: a Google account (`GOOGLE_GENAI_USE_GCA`), a
 * Vertex project, a gateway endpoint, then `GEMINI_API_KEY`. `GOOGLE_API_KEY`
 * belongs to its Vertex route rather than the API-key one. The hook adds no
 * `GEMINI_CLI_AUTH_OVERRIDE`, since that would replace a choice made in the
 * settings file, and reads no settings file: its auth type alone decides, and
 * a key there is never Ordewell's to read.
 */
const ON = ['GOOGLE_GENAI_USE_GCA', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_CLI_USE_COMPUTE_ADC', 'CLOUD_SHELL'] as const;

function ownRoute(env: RunnerEnv): boolean {
  if (env.GOOGLE_API_KEY?.trim()) return true;
  if (env.GEMINI_CLI_AUTH_OVERRIDE?.trim()) return true;
  if (env.GOOGLE_GEMINI_BASE_URL?.trim()) return true;
  if (env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) return true;
  if (env.GOOGLE_CLOUD_PROJECT?.trim() && env.GOOGLE_CLOUD_LOCATION?.trim()) return true;
  return ON.some((name) => env[name]?.trim().toLowerCase() === 'true');
}

/**
 * The hook a Gemini CLI profile carries: the Google key configured in
 * Ordewell (`/key set google`, or `GEMINI_API_KEY` in its environment), as the
 * `GEMINI_API_KEY` Gemini 0.66's API-key auth reads (ADR-0060, R9). It is the
 * only key Ordewell holds for this agent, so there is no vendor to choose.
 */
export const geminiCredentials: RunnerCredentials = async ({ env }) => {
  // The user's own route stays theirs: Gemini would prefer it over Ordewell's
  // key, and a hook that added one anyway would only hide which route ran.
  if (ownRoute(env)) return null;
  const key = vendorApiKeyIn(env, 'google');
  if (!key) return null;
  return { GEMINI_API_KEY: key };
};

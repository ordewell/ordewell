import type { AiProvider } from '../../interfaces/IConfig';
import type { RunnerCredentials } from '../../plugins/types';
import { ModelCatalog } from '../ModelCatalog';
import { ordewellProvider, type OrdewellProvider } from './ordewellProvider';

/**
 * Qwen's own default model for its openai auth, qwen3.7-max (DEFAULT_MODELS in
 * Qwen Code 0.26.6), as each vendor names it, and the prefix the vendor names
 * Qwen's family by. Only a vendor whose catalog was checked for it is listed: a
 * name the vendor does not serve signs Qwen in to a model that fails every turn.
 */
const QWEN_DEFAULT_MODEL: Partial<Record<AiProvider, { model: string; family: string }>> = {
  openrouter: { model: 'qwen/qwen3.7-max', family: 'qwen/' },
};

/**
 * The model Qwen is started on when neither the plan nor the planner names
 * one. A vendor that filters its catalog by the account, as OpenRouter does by
 * its privacy settings, may not serve Qwen's default to this key: the catalog
 * Ordewell last fetched with it says so, and a model of Qwen's family it does
 * list is handed instead. Read from what is held only, since a start must not
 * wait on the vendor; with nothing held, Qwen's default.
 */
function defaultModel(own: OrdewellProvider): string | undefined {
  const qwen = QWEN_DEFAULT_MODEL[own.vendor];
  if (!qwen) return undefined;
  const served = ModelCatalog.held(own.baseUrl);
  if (!served || served.some((m) => m.id === qwen.model)) return qwen.model;
  // Qwen works by calling tools, so a model the catalog says takes none is no
  // fit; one whose catalog does not say is given the benefit of the doubt.
  return served.find((m) => m.id.startsWith(qwen.family) && m.tools !== false)?.id ?? qwen.model;
}

/** `$runtime|<auth>|<id>(<auth>)`: how Qwen 0.26.6 lists a model its environment started it on. */
const RUNTIME_ID = /^\$runtime\|([^|]+)\|(.+)\(\1\)$/;

/**
 * The vendor's own id inside a model Qwen listed in its runtime form, which is
 * the id `--model` and OPENAI_MODEL take; undefined for any other form.
 */
export function qwenVendorModel(model: string): string | undefined {
  return RUNTIME_ID.exec(model)?.[2];
}

/**
 * The hook a Qwen profile carries: the key of the OpenAI-compatible vendor
 * configured in Ordewell, as the `OPENAI_*` variables Qwen's `openai` auth
 * reads (ADR-0060, R9). Qwen reaches any OpenAI-compatible endpoint it is
 * given, so every such vendor of Ordewell's qualifies.
 */
export const qwenCredentials: RunnerCredentials = async ({ env, model: planned }) => {
  // The user's own route: a key alone in OPENAI_API_KEY is also Ordewell's
  // `openai` vendor, but an endpoint of their own says the variables are Qwen's.
  if (env.OPENAI_BASE_URL) return null;
  const own = ordewellProvider(env, () => true);
  // Qwen reads its own settings and sign-in where Ordewell has none to hand it,
  // and says so itself when it has none either.
  if (!own) return null;
  // Qwen 0.26.6 takes its openai auth from the environment only with a model
  // there too: a key and an endpoint alone leave it signed out.
  const fromPlan = planned ? qwenVendorModel(planned) : undefined;
  const model = env.OPENAI_MODEL ? undefined : fromPlan ?? own.model ?? defaultModel(own);
  return { OPENAI_API_KEY: own.apiKey, OPENAI_BASE_URL: own.baseUrl, ...(model ? { OPENAI_MODEL: model } : {}) };
};

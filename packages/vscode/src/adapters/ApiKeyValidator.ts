import type { ApiProvider } from './SecretStore';
import { getProviderMeta } from '@ordewell/core';

export type ApiKeyValidation =
  | { status: 'valid' }
  | { status: 'invalid'; message: string }
  | { status: 'network'; message: string }
  /** The provider has no endpoint a key can be checked against, so it is saved as given. */
  | { status: 'unchecked' };

export interface ValidateOptions {
  /**
   * The provider's endpoint as the user configured it (`getProviderBaseUrl`):
   * a key for a gateway is the gateway's, and checking it at the provider's
   * public host would refuse it. Absent, the provider's default.
   */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** The provider's own words for a refusal, where it gives any. */
async function refusalOf(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    try { return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { return text; }
  } catch {
    return undefined;
  }
}

/**
 * Check a key with the request discovery will make with it: the provider's
 * model list, at the endpoint the provider is configured with. A provider
 * with no list (Perplexity) refuses that request whatever the key, so its
 * key is not checked at all.
 */
export async function validateApiKey(
  provider: ApiProvider,
  key: string,
  opts: ValidateOptions = {}
): Promise<ApiKeyValidation> {
  const meta = getProviderMeta(provider);
  if (meta && !meta.discoversModels) return { status: 'unchecked' };
  const doFetch = opts.fetchImpl ?? fetch;
  let response: { ok: boolean; status: number; body?: string };
  try {
    if (provider === 'google') {
      const base = (opts.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
      const res = await doFetch(`${base}/v1beta/models?key=${encodeURIComponent(key)}`);
      response = { ok: res.ok, status: res.status };
    } else if (provider === 'openrouter') {
      const base = (opts.baseUrl || meta?.defaultBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const res = await doFetch(`${base}/key`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      response = { ok: res.ok, status: res.status };
      if (!res.ok) response.body = await refusalOf(res);
    } else {
      const base = (opts.baseUrl || meta?.defaultBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      // A local endpoint may take no key, and is asked without one.
      const headers: Record<string, string> = {};
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await doFetch(`${base}/models`, { headers });
      response = { ok: res.ok, status: res.status };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'network', message };
  }
  if (response.ok) return { status: 'valid' };
  // Asked with no key, a refusal is the endpoint's own.
  return { status: 'invalid', message: response.body || (key ? `API rejected the key (HTTP ${response.status})` : `HTTP ${response.status}`) };
}

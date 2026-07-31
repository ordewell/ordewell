import type { ApiProvider } from './SecretStore';
import { getProviderMeta, isOpenAiProvider } from '@ordewell/core';

export type ApiKeyValidation =
  | { status: 'valid' }
  | { status: 'invalid'; message: string }
  | { status: 'network'; message: string };

export interface ValidateOptions {
  openrouterBaseUrl?: string;
  openaiCompatibleBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function validateApiKey(
  provider: ApiProvider,
  key: string,
  opts: ValidateOptions = {}
): Promise<ApiKeyValidation> {
  const doFetch = opts.fetchImpl ?? fetch;
  let response: { ok: boolean; status: number; body?: string };
  try {
    if (provider === 'google') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
      const res = await doFetch(url);
      response = { ok: res.ok, status: res.status };
    } else if (provider === 'openrouter') {
      const base = (opts.openrouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const res = await doFetch(`${base}/key`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      response = { ok: res.ok, status: res.status };
      if (!res.ok) {
        try { response.body = await res.text().then((t) => { try { return JSON.parse(t).error?.message ?? t; } catch { return t; } }); }
        catch { /* ignore body parse errors */ }
      }
    } else if (isOpenAiProvider(provider)) {
      const meta = getProviderMeta(provider);
      const baseUrl = provider === 'openai_compatible'
        ? (opts.openaiCompatibleBaseUrl || meta?.defaultBaseUrl || 'http://localhost:11434/v1')
        : (meta?.defaultBaseUrl || 'https://api.openai.com/v1');
      const cleanUrl = baseUrl.replace(/\/+$/, '');
      const headers: Record<string, string> = {};
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await doFetch(`${cleanUrl}/models`, { headers });
      response = { ok: res.ok, status: res.status };
    } else {
      const base = (opts.openrouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const res = await doFetch(`${base}/key`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      response = { ok: res.ok, status: res.status };
      if (!res.ok) {
        try { response.body = await res.text().then((t) => { try { return JSON.parse(t).error?.message ?? t; } catch { return t; } }); }
        catch { /* ignore body parse errors */ }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'network', message };
  }
  if (response.ok) return { status: 'valid' };
  return { status: 'invalid', message: response.body || `API rejected the key (HTTP ${response.status})` };
}

import { describe, it, expect } from 'vitest';
import { validateApiKey } from '../ApiKeyValidator';

/** A fetch stub that returns a fixed Response-like object. */
function fetchReturning(status: number, errorBody?: string): typeof fetch {
  const ok = status >= 200 && status < 300;
  return (async () => ({
    ok,
    status,
    text: async () => errorBody ?? (ok ? '' : `{"error":{"message":"Test error ${status}"}}`),
  })) as unknown as typeof fetch;
}

describe('validateApiKey — OpenRouter', () => {
  it('returns valid when the key endpoint responds 200', async () => {
    const result = await validateApiKey('openrouter', 'sk-or-good', { fetchImpl: fetchReturning(200) });
    expect(result.status).toBe('valid');
  });

  it('returns invalid with a message when the key is rejected (401)', async () => {
    const result = await validateApiKey('openrouter', 'sk-or-bad', { fetchImpl: fetchReturning(401) });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.message).toMatch(/error/i);
  });

  it('returns network (not invalid) when the request throws', async () => {
    const throwingFetch = (async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch;
    const result = await validateApiKey('openrouter', 'sk-or', { fetchImpl: throwingFetch });
    expect(result.status).toBe('network');
  });
});

describe('validateApiKey — Gemini', () => {
  it('calls the Gemini models endpoint with the key as a query param and validates on 200', async () => {
    let calledUrl = '';
    const spyFetch = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;

    const result = await validateApiKey('google', 'g-good', { fetchImpl: spyFetch });

    expect(result.status).toBe('valid');
    expect(calledUrl).toContain('generativelanguage.googleapis.com/v1beta/models');
    expect(calledUrl).toContain('key=g-good');
  });

  it('returns invalid when Gemini rejects the key (403)', async () => {
    const result = await validateApiKey('google', 'g-bad', { fetchImpl: fetchReturning(403) });
    expect(result.status).toBe('invalid');
  });
});

/** A fetch that answers 200 and keeps each URL it was asked for. */
function fetchRecording(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('validateApiKey — the configured endpoint', () => {
  // Bug: a key for a gateway was checked at the provider's public host, refused, and never saved.
  it.each([
    ['openai', 'https://gateway.example/v1/', 'https://gateway.example/v1/models'],
    ['anthropic', 'https://proxy.example/v1', 'https://proxy.example/v1/models'],
    ['openai_compatible', 'http://localhost:8000/v1', 'http://localhost:8000/v1/models'],
    ['openrouter', 'https://or-gateway.example/api/v1', 'https://or-gateway.example/api/v1/key'],
  ] as const)('checks a %s key at its configured base URL', async (provider, baseUrl, asked) => {
    const { fetchImpl, urls } = fetchRecording();
    expect((await validateApiKey(provider, 'k', { baseUrl, fetchImpl })).status).toBe('valid');
    expect(urls).toEqual([asked]);
  });

  it('falls back to the provider\'s default endpoint when none is configured', async () => {
    const { fetchImpl, urls } = fetchRecording();
    await validateApiKey('groq', 'k', { fetchImpl });
    expect(urls).toEqual(['https://api.groq.com/openai/v1/models']);
  });

  // Bug: a Custom endpoint that refused a request sent with no key read as "API rejected the key".
  it('words a refusal of a request with no key as the endpoint\'s, and sends no key', async () => {
    const asked: (RequestInit | undefined)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      asked.push(init);
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;
    expect(await validateApiKey('openai_compatible', '', { baseUrl: 'http://localhost:9/v1', fetchImpl })).toEqual({ status: 'invalid', message: 'HTTP 404' });
    expect(asked[0]?.headers).toEqual({});
    expect(await validateApiKey('openai_compatible', 'sk-local', { baseUrl: 'http://localhost:9/v1', fetchImpl })).toEqual({ status: 'invalid', message: 'API rejected the key (HTTP 404)' });
  });

  // Bug: Perplexity has no model list, so every key it was given read as invalid.
  it('does not check a key for a provider with no model list, and asks nothing', async () => {
    const { fetchImpl, urls } = fetchRecording();
    expect(await validateApiKey('perplexity', 'pplx-1', { fetchImpl })).toEqual({ status: 'unchecked' });
    expect(urls).toEqual([]);
  });
});

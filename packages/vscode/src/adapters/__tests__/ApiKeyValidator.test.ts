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

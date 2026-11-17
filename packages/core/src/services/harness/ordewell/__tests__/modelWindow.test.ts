import { describe, expect, it, beforeEach } from 'vitest';
import { ModelDetailsStore, type DetailsTable } from '../../../ModelDetails';
import { lookupModelInfo, resetModelListings } from '../models';

const ENV = { OPENROUTER_API_KEY: 'sk-test' };

/** A store that answers from `table` alone: no cache file, no models.dev. */
function details(table: DetailsTable = {}): ModelDetailsStore {
  return new ModelDetailsStore({ snapshot: table, cacheDir: () => '/nonexistent-ordewell-cache', env: { ORDEWELL_NO_MODELS_DEV: '1' } });
}

/** An OpenRouter `/models` answer listing `models`, counting each request. */
function listing(models: Array<Record<string, unknown>>): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: models }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const failing = (async () => { throw new Error('offline'); }) as typeof fetch;

beforeEach(() => resetModelListings());

describe('a model\'s context window', () => {
  it('is assumed at 128,000 tokens when nothing states it, and says so', async () => {
    const info = await lookupModelInfo('openrouter:acme/unknown', ENV, { fetchImpl: failing, details: details() });
    expect(info.contextWindow).toBe(128_000);
    expect(info.contextWindowSource).toBe('assumed');
  });

  it('is assumed at 128,000 for a provider with no credentials too', async () => {
    const info = await lookupModelInfo('openrouter:acme/unknown', {}, { fetchImpl: failing, details: details() });
    expect(info.contextWindow).toBe(128_000);
  });

  it('comes from the provider\'s listing when the catalog has none', async () => {
    const { fetchImpl } = listing([{ id: 'acme/listed', name: 'Listed', context_length: 200_000 }]);
    const info = await lookupModelInfo('openrouter:acme/listed', ENV, { fetchImpl, details: details() });
    expect(info.contextWindow).toBe(200_000);
    expect(info.contextWindowSource).toBe('listing');
  });

  it('comes from the catalog before the listing', async () => {
    const { fetchImpl } = listing([{ id: 'acme/both', name: 'Both', context_length: 200_000 }]);
    const info = await lookupModelInfo('openrouter:acme/both', ENV, {
      fetchImpl,
      details: details({ openrouter: { 'acme/both': { contextWindow: 300_000 } } }),
    });
    expect(info.contextWindow).toBe(300_000);
    expect(info.contextWindowSource).toBe('catalog');
  });

  it('comes from the catalog for a model the listing does not hold', async () => {
    const info = await lookupModelInfo('openrouter:acme/catalogued', ENV, {
      fetchImpl: failing,
      details: details({ openrouter: { 'acme/catalogued': { contextWindow: 64_000 } } }),
    });
    expect(info.contextWindow).toBe(64_000);
    expect(info.contextWindowSource).toBe('catalog');
  });

  it('takes the user\'s setting over both the catalog and the listing', async () => {
    const { fetchImpl } = listing([{ id: 'acme/both', name: 'Both', context_length: 200_000 }]);
    const info = await lookupModelInfo('openrouter:acme/both', ENV, {
      fetchImpl,
      details: details({ openrouter: { 'acme/both': { contextWindow: 300_000 } } }),
      windows: { 'openrouter:acme/both': 50_000 },
    });
    expect(info.contextWindow).toBe(50_000);
    expect(info.contextWindowSource).toBe('setting');
  });

  it('fetches a provider\'s listing once a session, and again after a failure', async () => {
    const { fetchImpl, calls } = listing([{ id: 'acme/listed', name: 'Listed', context_length: 200_000 }]);
    await lookupModelInfo('openrouter:acme/listed', ENV, { fetchImpl, details: details() });
    await lookupModelInfo('openrouter:acme/other', ENV, { fetchImpl, details: details() });
    expect(calls()).toBe(1);

    let attempts = 0;
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return fetchImpl(...args);
    }) as typeof fetch;
    const first = await lookupModelInfo('openrouter:acme/listed', { OPENROUTER_API_KEY: 'sk-other' }, { fetchImpl: flaky, details: details() });
    const second = await lookupModelInfo('openrouter:acme/listed', { OPENROUTER_API_KEY: 'sk-other' }, { fetchImpl: flaky, details: details() });
    expect(first.contextWindowSource).toBe('assumed');
    expect(second.contextWindow).toBe(200_000);
  });

  it.each([
    ['context_window', { context_window: 131_072 }],
    ['max_context_length', { max_context_length: 131_072 }],
    ['max_model_len', { max_model_len: 131_072 }],
  ])('reads a listing that states the window as %s', async (_field, stated) => {
    const { fetchImpl } = listing([{ id: 'acme/m', name: 'M', ...stated }]);
    const info = await lookupModelInfo('openrouter:acme/m', ENV, { fetchImpl, details: details() });
    expect(info.contextWindow).toBe(131_072);
  });
});

describe('a model\'s output limit', () => {
  it('comes from the catalog when the listing states none', async () => {
    const info = await lookupModelInfo('openrouter:acme/catalogued', ENV, {
      fetchImpl: failing,
      details: details({ openrouter: { 'acme/catalogued': { contextWindow: 1_048_576, maxOutputTokens: 943_718 } } }),
    });
    expect(info.maxOutputTokens).toBe(943_718);
    expect(info.known.maxOutputTokens).toBe(true);
  });

  it('is the lower of the catalog\'s and the listing\'s when both state one', async () => {
    const { fetchImpl } = listing([{ id: 'acme/both', name: 'Both', context_length: 200_000, top_provider: { max_completion_tokens: 32_000 } }]);
    const both = await lookupModelInfo('openrouter:acme/both', ENV, {
      fetchImpl,
      details: details({ openrouter: { 'acme/both': { contextWindow: 200_000, maxOutputTokens: 64_000 } } }),
    });
    expect(both.maxOutputTokens).toBe(32_000);
    resetModelListings();
    const lower = await lookupModelInfo('openrouter:acme/both', ENV, {
      fetchImpl,
      details: details({ openrouter: { 'acme/both': { contextWindow: 200_000, maxOutputTokens: 16_384 } } }),
    });
    expect(lower.maxOutputTokens).toBe(16_384);
  });

  it('keeps the 4,096-token default when nothing states it', async () => {
    const info = await lookupModelInfo('openrouter:acme/unknown', ENV, { fetchImpl: failing, details: details() });
    expect(info.maxOutputTokens).toBe(4_096);
    expect(info.known.maxOutputTokens).toBe(false);
  });
});

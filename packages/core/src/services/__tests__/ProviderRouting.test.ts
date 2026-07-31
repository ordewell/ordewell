import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../ModelCatalog', () => ({
  ModelCatalog: { fetchModels: vi.fn() },
}));

vi.mock('../ModelDiscovery', () => ({
  discoverGeminiModels: vi.fn(),
  pickBestGeminiModel: vi.fn(),
}));

import { resolveProvider, fetchAllProviderModels, toOrchestratorOptions } from '../ProviderRouting';
import { normalizeGeminiModel } from '../../interfaces/BaseConfig';
import { prefixModelId } from '../ProviderRegistry';
import { ModelCatalog } from '../ModelCatalog';
import { discoverGeminiModels } from '../ModelDiscovery';
import type { CatalogModel } from '../ModelCatalog';
import type { ModelShortcut } from '../ModelShortcuts';

const mockFetchModels = vi.mocked(ModelCatalog.fetchModels);
const mockDiscoverGemini = vi.mocked(discoverGeminiModels);

function makeCatalogModel(id: string): CatalogModel {
  return { id, name: id, description: '', pricing: { prompt: '0', completion: '0' }, contextLength: 0 };
}

const providerLists: Record<string, string[]> = {
  openrouter: ['openai/gpt-4o', 'opencode-go/deepseek-v4-pro', 'anthropic/claude-sonnet-4'],
  google: ['gemini:gemini-2.5-pro', 'gemini:gemini-2.5-flash'],
  openai_compatible: ['openai_compat:llama3', 'openai_compat:mistral'],
};

const emptyLists: Record<string, string[]> = {};

describe('resolveProvider', () => {
  it('returns openrouter when model is found in OpenRouter list', () => {
    expect(resolveProvider('openai/gpt-4o', providerLists)).toBe('openrouter');
  });

  it('returns google when model is found in Google list', () => {
    expect(resolveProvider('gemini:gemini-2.5-pro', providerLists)).toBe('google');
  });

  it('returns null when model is not found in any provider list', () => {
    expect(resolveProvider('unknown/model', providerLists)).toBeNull();
  });

  it('returns null when both lists are empty', () => {
    expect(resolveProvider('unknown-model', emptyLists)).toBeNull();
  });

  it('returns openrouter when model is in both lists (checks OpenRouter first)', () => {
    const overlapping = {
      openrouter: ['gemini:gemini-2.5-pro'],
      google: ['gemini:gemini-2.5-pro'],
    };
    expect(resolveProvider('gemini:gemini-2.5-pro', overlapping)).toBe('openrouter');
  });
});

describe('fetchAllProviderModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches models from both providers in parallel', async () => {
    mockFetchModels.mockResolvedValue([makeCatalogModel('openai/gpt-4o')]);
    mockDiscoverGemini.mockResolvedValue([{ modelId: 'gemini-2.5-pro', modelLabel: 'Gemini 2.5 Pro', variants: [] }]);

    const result = await fetchAllProviderModels({
      apiKeys: { openrouter: 'sk-or-test', google: 'sk-gem-test' },
      baseUrls: {},
    });

    expect(mockFetchModels).toHaveBeenCalledWith('sk-or-test', undefined, undefined);
    expect(mockDiscoverGemini).toHaveBeenCalledWith('sk-gem-test', undefined, undefined);
    expect(result.models.openrouter).toHaveLength(1);
    expect(result.models.openrouter![0].id).toBe('openai/gpt-4o');
    expect(result.models.google).toHaveLength(1);
    expect(result.models.google![0].id).toBe('gemini-2.5-pro');
    expect(result.models.google![0].name).toBe('Gemini 2.5 Pro');
    expect(result.errors).toEqual({});
  });

  it('does NOT fetch the OpenRouter catalog when no API key is provided', async () => {
    mockFetchModels.mockResolvedValue([makeCatalogModel('openai/gpt-4o')]);
    mockDiscoverGemini.mockResolvedValue([{ modelId: 'gemini-2.5-pro', modelLabel: 'Gemini 2.5 Pro', variants: [] }]);

    const result = await fetchAllProviderModels({
      apiKeys: { openrouter: '', google: 'sk-gem-test' },
      baseUrls: {},
    });

    // OpenRouter now needs a key like every other preset (product rule:
    // only key-configured providers are shown).
    expect(mockFetchModels).not.toHaveBeenCalled();
    expect(mockDiscoverGemini).toHaveBeenCalledWith('sk-gem-test', undefined, undefined);
    expect(result.models.openrouter).toBeUndefined();
    expect(result.models.google).toHaveLength(1);
  });

  it('skips Gemini fetch when no API key is provided', async () => {
    mockFetchModels.mockResolvedValue([makeCatalogModel('openai/gpt-4o')]);

    const result = await fetchAllProviderModels({
      apiKeys: { openrouter: 'sk-or-test' },
      baseUrls: {},
    });

    expect(mockFetchModels).toHaveBeenCalledWith('sk-or-test', undefined, undefined);
    expect(mockDiscoverGemini).not.toHaveBeenCalled();
    expect(result.models.openrouter).toHaveLength(1);
    expect(result.models.google).toBeUndefined();
  });

  it('returns partial results and records the failure when one provider fails', async () => {
    mockFetchModels.mockRejectedValue(new Error('Network error'));
    mockDiscoverGemini.mockResolvedValue([{ modelId: 'gemini-2.5-pro', modelLabel: 'Gemini 2.5 Pro', variants: [] }]);

    const result = await fetchAllProviderModels({
      apiKeys: { openrouter: 'sk-or-test', google: 'sk-gem-test' },
      baseUrls: {},
    });

    expect(result.models.openrouter).toEqual([]);
    expect(result.models.google).toHaveLength(1);
    expect(result.errors.openrouter).toBe('Network error');
    expect(result.errors.google).toBeUndefined();
  });

  it('passes baseUrl for openrouter', async () => {
    mockFetchModels.mockResolvedValue([]);

    await fetchAllProviderModels({
      apiKeys: { openrouter: 'sk-or-test' },
      baseUrls: { openrouter: 'https://custom.openrouter.ai/api/v1' },
    });

    expect(mockFetchModels).toHaveBeenCalledWith('sk-or-test', 'https://custom.openrouter.ai/api/v1', undefined);
  });

  it('passes the google base URL override through to Gemini discovery', async () => {
    mockFetchModels.mockResolvedValue([]);
    mockDiscoverGemini.mockResolvedValue([]);

    await fetchAllProviderModels({
      apiKeys: { google: 'sk-gem-test' },
      baseUrls: { google: 'https://custom.gemini.example/v1' },
    });

    expect(mockDiscoverGemini).toHaveBeenCalledWith('sk-gem-test', 'https://custom.gemini.example/v1', undefined);
  });

  it('never fetches a provider whose registry marks discoversModels: false (e.g. perplexity)', async () => {
    mockFetchModels.mockResolvedValue([]);

    const result = await fetchAllProviderModels({
      apiKeys: { perplexity: 'pplx-key', openrouter: 'sk-or' },
      baseUrls: { perplexity: 'https://api.perplexity.ai' },
    });

    // No catalog fetch fired for the perplexity endpoint, and it contributes no
    // list. (An openrouter key is supplied so its catalog still fetches — the
    // spy is not globally idle.)
    expect(mockFetchModels).not.toHaveBeenCalledWith('pplx-key', 'https://api.perplexity.ai', undefined);
    expect(result.models.perplexity).toBeUndefined();
  });
});

describe('toOrchestratorOptions', () => {
  const shortcuts: ModelShortcut[] = [
    { label: 'DeepSeek V4 Flash', id: 'deepseek/deepseek-v4-flash', provider: 'OpenRouter', description: 'Best all-around', pricing: '$0.09/$0.18' },
    { label: 'GPT-4o', id: 'openai/gpt-4o', provider: 'OpenRouter', description: 'General purpose', pricing: '$2.50/$10' },
  ];

  it('returns nothing when no API models are available', () => {
    const result = toOrchestratorOptions({}, shortcuts);
    expect(result).toEqual([]);
  });

  it('returns API models when no shortcuts provided', () => {
    const result = toOrchestratorOptions(
      {
        openrouter: [makeCatalogModel('deepseek/deepseek-v4-flash')],
        google: [makeCatalogModel('gemini-2.5-pro')],
      },
      [],
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'deepseek/deepseek-v4-flash', provider: 'Deepseek' });
    expect(result[1]).toMatchObject({ id: 'gemini:gemini-2.5-pro', provider: 'Gemini', apiProvider: 'google' });
  });

  it('overlays shortcut label/description onto matching catalog models; unmatched shortcuts are dropped', () => {
    const result = toOrchestratorOptions(
      { openrouter: [makeCatalogModel('deepseek/deepseek-v4-flash')] },
      shortcuts,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'Best all-around',
    });
  });

  it('puts shortcut-matched models first, in shortcut order, ahead of the rest of the catalog', () => {
    const result = toOrchestratorOptions(
      {
        openrouter: [
          makeCatalogModel('zzz/other-model'),
          makeCatalogModel('openai/gpt-4o'),
          makeCatalogModel('deepseek/deepseek-v4-flash'),
        ],
      },
      shortcuts,
    );
    expect(result.map((o) => o.id)).toEqual([
      'deepseek/deepseek-v4-flash',
      'openai/gpt-4o',
      'zzz/other-model',
    ]);
  });

  it('OpenRouter models appear before Gemini models', () => {
    const result = toOrchestratorOptions(
      {
        openrouter: [makeCatalogModel('some-org/some-model')],
        google: [makeCatalogModel('gemini-2.5-flash')],
      },
      [],
    );
    expect(result).toHaveLength(2);
    expect(result[0].provider).toBe('Some-org');
    expect(result[1].provider).toBe('Gemini');
  });

  it('native Gemini model IDs carry the gemini: API qualifier', () => {
    const result = toOrchestratorOptions(
      { google: [makeCatalogModel('gemini-2.5-pro')] },
      [],
    );
    expect(result[0].id).toBe('gemini:gemini-2.5-pro');
    expect(result[0].apiProvider).toBe('google');
  });

  it('a model offered by BOTH APIs appears twice — once per API — with distinct ids', () => {
    const result = toOrchestratorOptions(
      {
        openrouter: [makeCatalogModel('google/gemini-2.5-pro')],
        google: [makeCatalogModel('gemini-2.5-pro')],
      },
      [],
    );
    const viaOpenRouter = result.find((o) => o.id === 'google/gemini-2.5-pro');
    const viaGemini = result.find((o) => o.id === 'gemini:gemini-2.5-pro');
    expect(viaOpenRouter?.apiProvider).toBe('openrouter');
    expect(viaGemini?.apiProvider).toBe('google');
  });

  it('prefixModelId round-trips through normalizeGeminiModel to the bare id', () => {
    expect(prefixModelId('google', 'gemini-2.5-pro')).toBe('gemini:gemini-2.5-pro');
    expect(normalizeGeminiModel(prefixModelId('google', 'gemini-2.5-pro'))).toBe('gemini-2.5-pro');
  });

  it('provider extracted from model ID prefix for OpenRouter models', () => {
    const result = toOrchestratorOptions(
      { openrouter: [makeCatalogModel('openai/gpt-4.1')] },
      [],
    );
    expect(result[0].provider).toBe('Openai');
  });

  it('OpenRouter models carry description and pricing from catalog', () => {
    const model = makeCatalogModel('openai/gpt-4o');
    model.description = 'General purpose, strong multimodal';
    model.pricing = { prompt: '0.0000025', completion: '0.00001' };

    const result = toOrchestratorOptions(
      { openrouter: [model] },
      [],
    );
    expect(result[0].description).toBe('General purpose, strong multimodal');
    expect(result[0].pricing).toBe('2.5/10');
  });

  it('Gemini models use name as label', () => {
    const model = makeCatalogModel('gemini-2.5-pro');
    model.name = 'Gemini 2.5 Pro';
    const result = toOrchestratorOptions(
      { google: [model] },
      [],
    );
    expect(result[0].label).toBe('Gemini 2.5 Pro');
  });

  it('handles OpenRouter model with missing name — falls back to id', () => {
    const model = makeCatalogModel('some-org/some-model');
    model.name = '';

    const result = toOrchestratorOptions(
      { openrouter: [model] },
      [],
    );
    expect(result[0].label).toBe('some-org/some-model');
  });

  it('empty lists produce empty result', () => {
    const result = toOrchestratorOptions({}, []);
    expect(result).toHaveLength(0);
  });

  it('tags each option with the API provider it comes from', () => {
    const result = toOrchestratorOptions(
      {
        openrouter: [makeCatalogModel('openai/gpt-4o')],
        google: [makeCatalogModel('gemini-2.5-pro')],
      },
      shortcuts,
    );
    const byId = Object.fromEntries(result.map((o) => [o.id, o.apiProvider]));
    expect(byId['deepseek/deepseek-v4-flash']).toBeUndefined();
    expect(byId['openai/gpt-4o']).toBe('openrouter');
    expect(byId['gemini:gemini-2.5-pro']).toBe('google');
  });
});

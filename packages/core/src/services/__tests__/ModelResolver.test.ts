import { describe, it, expect, vi } from 'vitest';
import { ModelResolver } from '../ModelResolver';
import type { ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { RunnerPluginManifest } from '../../plugins/types';
import type { IConfig } from '../../interfaces/IConfig';
import { resolveProvider, type ProviderModelLists } from '../ProviderRouting';
import { getProviderMeta } from '../ProviderRegistry';

function configWith(over: Partial<IConfig> = {}): IConfig {
  const base = {
    // OpenRouter now needs a key like every preset, so the picker tests below
    // supply one by default to exercise catalog fetching.
    openrouterKey: 'sk-or',
    geminiKey: '',
    openAiBaseUrl: 'https://openrouter.ai/api/v1',
    openaiCompatibleBaseUrl: '',
    openaiCompatibleApiKey: '',
    ...over,
  };
  return {
    ...base,
    getProviderBaseUrl: (p: unknown) => p === 'openrouter' ? base.openAiBaseUrl : '',
    getProviderApiKey: (p: unknown) => {
      if (p === 'google') return base.geminiKey;
      if (p === 'openrouter') return base.openrouterKey;
      return '';
    },
  } as IConfig;
}

/** Routes injected-fetch calls by URL substring; unmatched URLs 404. */
function fakeFetch(routes: Array<[string, unknown]>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    for (const [match, body] of routes) {
      if (url.includes(match)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function manifest(name: string, over: Partial<RunnerPluginManifest['modelDiscovery']> = {}): RunnerPluginManifest {
  return {
    name,
    displayName: name,
    runner: { command: name, args: [] },
    modelDiscovery: {
      method: 'command',
      discoveryCommands: [{ command: name, args: ['models'], parser: 'line-by-line' }],
      fallbackModels: [{ modelId: `${name}/fallback`, modelLabel: 'Fallback' }],
      ...over,
    },
  } as unknown as RunnerPluginManifest;
}

function fakeRegistry(manifests: Record<string, RunnerPluginManifest>): RunnerRegistry {
  return {
    getManifest: (id: string) => manifests[id],
  } as unknown as RunnerRegistry;
}

const config = {} as IConfig;

describe('ModelResolver.modelsForRunners', () => {
  it('discovers models per runner via the manifest command + parser', async () => {
    const exec: ExecImpl = vi.fn().mockResolvedValue({ stdout: 'foo/one One\nfoo/two Two\n' });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), config, { execImpl: exec });

    const result = await resolver.modelsForRunners(['foo']);

    expect(result.foo?.map((m) => m.modelId)).toEqual(['foo/one', 'foo/two']);
  });

  it('falls back to manifest fallbackModels when discovery yields nothing', async () => {
    const exec: ExecImpl = vi.fn().mockResolvedValue({ stdout: '   \n' });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), config, { execImpl: exec });

    const result = await resolver.modelsForRunners(['foo']);

    expect(result.foo?.map((m) => m.modelId)).toEqual(['foo/fallback']);
  });

  it('caches discovery per runner within a resolver instance', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'foo/one One\n' });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), config, { execImpl: exec as ExecImpl });

    await resolver.modelsForRunners(['foo']);
    await resolver.modelsForRunners(['foo']);

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('refreshRunnerModels clears the runner cache so the next discovery re-runs', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'foo/one One\n' });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), config, { execImpl: exec as ExecImpl });

    await resolver.modelsForRunners(['foo']);
    resolver.refreshRunnerModels();
    await resolver.modelsForRunners(['foo']);

    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('ModelResolver.pickerOptions', () => {
  it('returns only fetched catalog models, shortcut-matched ones first with curated labels', async () => {
    const fetchImpl = fakeFetch([
      ['/models', { data: [
        { id: 'vendor/new-model', name: 'New Model' },
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek dup' }, // matches a shortcut
      ] }],
    ]);
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl });

    const opts = await resolver.pickerOptions();
    const ids = opts.map((o) => o.id);

    // Only what the catalog actually offers — no injected shortcut entries.
    expect(ids).toEqual(['deepseek/deepseek-v4-flash', 'vendor/new-model']);
    // The matched shortcut supplies the curated label.
    expect(opts[0].label).toBe('DeepSeek V4 Flash');
  });

  it('converts OpenRouter per-token pricing to per-MTok', async () => {
    const fetchImpl = fakeFetch([
      ['/models', { data: [
        { id: 'vendor/priced', name: 'Priced', pricing: { prompt: '0.00000089', completion: '0.00000089' } },
      ] }],
    ]);
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl });

    const opts = await resolver.pickerOptions();

    expect(opts.find((o) => o.id === 'vendor/priced')?.pricing).toBe('0.89/0.89');
  });

  it('tags apiProvider: google for native Gemini ids, openrouter for catalog ids', async () => {
    const fetchImpl = fakeFetch([
      ['/v1beta/models', { models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      ] }],
      ['/models', { data: [{ id: 'vendor/catalog', name: 'Catalog' }] }],
    ]);
    const resolver = new ModelResolver(
      fakeRegistry({}),
      configWith({ geminiKey: 'gem-key' }),
      { fetchImpl },
    );

    const opts = await resolver.pickerOptions();

    expect(opts.find((o) => o.id === 'gemini:gemini-2.5-pro')?.apiProvider).toBe('google');
    expect(opts.find((o) => o.id === 'vendor/catalog')?.apiProvider).toBe('openrouter');
  });

  it('caches the catalog so repeated reads do not re-fetch', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await resolver.pickerOptions();
    await resolver.pickerOptions();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('records a per-provider fetch failure in getDiscoveryErrors', async () => {
    // OpenRouter catalog 500s; Gemini succeeds. The picker still yields the
    // Gemini option, and the OpenRouter failure is flagged for the surfaces.
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/v1beta/models')) {
        return new Response(JSON.stringify({ models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
        ] }), { status: 200 });
      }
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }) as typeof fetch;
    const resolver = new ModelResolver(fakeRegistry({}), configWith({ geminiKey: 'gem-key' }), { fetchImpl });

    const opts = await resolver.pickerOptions();

    expect(opts.some((o) => o.id === 'gemini:gemini-2.5-pro')).toBe(true);
    expect(resolver.getDiscoveryErrors().openrouter).toMatch(/500|Internal Server Error/);
    expect(resolver.getDiscoveryErrors().google).toBeUndefined();
  });

  // --- discovery fan-out gating (regression) ---
  // The resolver must never probe preset provider endpoints that the user has
  // not configured. With registry-default base URLs (as real BaseConfig
  // supplies), only keyed presets (OpenRouter included) and an explicitly
  // pointed openai_compatible endpoint may be fetched.

  /** Mirrors BaseConfig: registry-default base URLs + keys from an override map. */
  function registryConfig(keys: Record<string, string> = {}, openaiCompatibleBaseUrl = ''): IConfig {
    return {
      openrouterKey: keys.openrouter ?? '',
      geminiKey: keys.google ?? '',
      openaiCompatibleBaseUrl,
      openaiCompatibleApiKey: '',
      getProviderApiKey: (p: string) => keys[p] ?? '',
      getProviderBaseUrl: (p: string) => {
        const meta = getProviderMeta(p as never);
        if (!meta) return '';
        if (p === 'openai_compatible' && openaiCompatibleBaseUrl) return openaiCompatibleBaseUrl;
        return meta.defaultBaseUrl;
      },
    } as unknown as IConfig;
  }

  function fetchedHosts(fetchImpl: ReturnType<typeof vi.fn>): string[] {
    return fetchImpl.mock.calls.map((c) => new URL(String(c[0])).host);
  }

  it('probes nothing when no provider is configured (OpenRouter now needs a key too)', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(fakeRegistry({}), registryConfig(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await resolver.pickerOptions();

    // No key anywhere → no catalog fetch at all, including OpenRouter.
    expect(fetchedHosts(fetchImpl)).toEqual([]);
  });

  it('discovers keyed presets but still skips unconfigured ones', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(fakeRegistry({}), registryConfig({ openrouter: 'sk-or', openai: 'sk-openai' }), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await resolver.pickerOptions();

    const hosts = fetchedHosts(fetchImpl);
    expect(hosts).toContain('openrouter.ai');
    expect(hosts).toContain('api.openai.com');
    expect(hosts).not.toContain('api.mistral.ai');
    expect(hosts).not.toContain('api.x.ai');
  });

  it('discovers openai_compatible only when an explicit endpoint is set', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(
      fakeRegistry({}),
      registryConfig({}, 'http://localhost:11434/v1'),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    await resolver.pickerOptions();

    expect(fetchedHosts(fetchImpl)).toContain('localhost:11434');
  });
});

/** Config that records the lists the resolver pushes in via setProviderModelLists. */
function capturingConfig(over: Partial<IConfig> = {}): IConfig & { pushed: ProviderModelLists | null } {
  const base = {
    openrouterKey: 'sk-or',
    geminiKey: '',
    openAiBaseUrl: 'https://openrouter.ai/api/v1',
    ...over,
  };
  const cfg = {
    ...base,
    getProviderBaseUrl: (p: unknown) => p === 'openrouter' ? base.openAiBaseUrl : '',
    getProviderApiKey: (p: unknown) => {
      if (p === 'google') return base.geminiKey;
      if (p === 'openrouter') return base.openrouterKey;
      return '';
    },
    pushed: null as ProviderModelLists | null,
    setProviderModelLists(lists: ProviderModelLists) { cfg.pushed = lists; },
  };
  return cfg as unknown as IConfig & { pushed: ProviderModelLists | null };
}

describe('ModelResolver.builtinOptions', () => {
  it('is empty before any catalog fetch — shortcuts never surface models that were not fetched', () => {
    expect(ModelResolver.builtinOptions()).toEqual([]);
  });
});

describe('ModelResolver.invalidate', () => {
  it('clears runner-discovery and the catalog/Gemini cache so the next read re-runs', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'foo/one One\n' });
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(
      fakeRegistry({ foo: manifest('foo') }),
      configWith(),
      { execImpl: exec as ExecImpl, fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    await resolver.modelsForRunners(['foo']);
    await resolver.pickerOptions();
    resolver.invalidate();
    await resolver.modelsForRunners(['foo']);
    await resolver.pickerOptions();

    expect(exec).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('ModelResolver.refresh', () => {
  it('mints native Gemini ids with the gemini: qualifier and pushes the lists into config', async () => {
    const fetchImpl = fakeFetch([
      ['/v1beta/models', { models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      ] }],
      ['/models', { data: [{ id: 'google/gemini-2.5-pro', name: 'Gemini via OpenRouter' }] }],
    ]);
    const config = capturingConfig({ geminiKey: 'gem-key' });
    const resolver = new ModelResolver(fakeRegistry({}), config, { fetchImpl });

    const lists = await resolver.refresh();

    expect(lists.google).toContain('gemini:gemini-2.5-pro');
    expect(lists.openrouter).toContain('google/gemini-2.5-pro');
    expect(config.pushed).toEqual(lists);
  });

  it('produces lists where a stored gemini:<id> routes to google and google/<id> to openrouter', async () => {
    const fetchImpl = fakeFetch([
      ['/v1beta/models', { models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      ] }],
      ['/models', { data: [{ id: 'google/gemini-2.5-pro', name: 'Gemini via OpenRouter' }] }],
    ]);
    const config = capturingConfig({ geminiKey: 'gem-key' });
    const resolver = new ModelResolver(fakeRegistry({}), config, { fetchImpl });

    const lists = await resolver.refresh();

    expect(resolveProvider('gemini:gemini-2.5-pro', lists)).toBe('google');
    expect(resolveProvider('google/gemini-2.5-pro', lists)).toBe('openrouter');
  });
});

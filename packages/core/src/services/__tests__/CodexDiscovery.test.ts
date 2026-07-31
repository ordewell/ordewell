import { describe, it, expect, vi } from 'vitest';
import {
  ModelDiscovery,
  parseAppServerModels,
  parseCodexModelsCache,
  type ExecImpl,
  type AppServerClientImpl,
  type AppServerModel,
} from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CODEX_MANIFEST } from '../../plugins/builtin/codex.manifest';

function registryWith(...manifests: Array<{ name: string }>): RunnerRegistry {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  return { getManifest: (id: string) => byName.get(id) } as unknown as RunnerRegistry;
}

const noExec: ExecImpl = vi.fn(async () => { throw new Error('exec should not be called'); });

const APP_SERVER_MODELS: AppServerModel[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    hidden: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' },
    ],
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' },
    ],
  },
  { id: 'codex-auto-review', displayName: 'Codex Auto Review', hidden: true, supportedReasoningEfforts: [] },
];

const CACHE_FILE = JSON.stringify({
  fetched_at: '2026-07-16T12:20:19Z',
  models: [
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }, { effort: 'ultra' }],
    },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', supported_reasoning_levels: [] },
  ],
});

describe('parseAppServerModels', () => {
  it('maps model/list entries to DiscoveredModels with effort variants', () => {
    const models = parseAppServerModels(APP_SERVER_MODELS);
    expect(models.map((m) => m.modelId)).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
    expect(models[0].modelLabel).toBe('GPT-5.6-Sol');
    expect(models[0].runnerProvider).toBe('openai');
    expect(models[0].variants.map((v) => v.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(models[0].variants[5].label).toBe('Ultra');
  });

  it('filters hidden models', () => {
    const models = parseAppServerModels(APP_SERVER_MODELS);
    expect(models.find((m) => m.modelId === 'codex-auto-review')).toBeUndefined();
  });
});

describe('parseCodexModelsCache', () => {
  it('maps the snake_case cache shape and filters visibility:hide', () => {
    const models = parseCodexModelsCache(CACHE_FILE);
    expect(models.map((m) => m.modelId)).toEqual(['gpt-5.6-terra']);
    expect(models[0].modelLabel).toBe('GPT-5.6-Terra');
    expect(models[0].variants.map((v) => v.id)).toEqual(['medium', 'high', 'ultra']);
  });

  it('returns empty on malformed JSON', () => {
    expect(parseCodexModelsCache('not json')).toEqual([]);
  });
});

describe('ModelDiscovery — Codex (app-server → cache file → fallback)', () => {
  it('uses the app-server catalog when the client succeeds', async () => {
    const client: AppServerClientImpl = vi.fn(async () => APP_SERVER_MODELS);
    const readFile = vi.fn(() => { throw new Error('cache should not be read'); });
    const discovery = new ModelDiscovery(registryWith(CODEX_MANIFEST), noExec, undefined, client, readFile as never);
    const models = await discovery.discover('codex');
    expect(models.map((m) => m.modelId)).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
    expect(client).toHaveBeenCalledWith('codex', ['app-server']);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('falls back to the on-disk cache file when the app-server call fails', async () => {
    const client: AppServerClientImpl = vi.fn(async () => null);
    const readFile = vi.fn(() => CACHE_FILE);
    const discovery = new ModelDiscovery(registryWith(CODEX_MANIFEST), noExec, undefined, client, readFile);
    const models = await discovery.discover('codex');
    expect(models.map((m) => m.modelId)).toEqual(['gpt-5.6-terra']);
    expect(readFile).toHaveBeenCalledWith('~/.codex/models_cache.json');
  });

  it('degrades to canonical aliases with static variants when both live sources fail', async () => {
    const client: AppServerClientImpl = vi.fn(async () => null);
    const readFile = vi.fn(() => null);
    const discovery = new ModelDiscovery(registryWith(CODEX_MANIFEST), noExec, undefined, client, readFile);
    const models = await discovery.discover('codex');
    expect(models.map((m) => m.modelId)).toContain('gpt-5.6-sol');
    expect(models[0].variants.map((v) => v.id)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('does not cache a fallback-only result — the next lookup retries the app-server', async () => {
    let calls = 0;
    const client: AppServerClientImpl = vi.fn(async () => (++calls === 1 ? null : APP_SERVER_MODELS));
    const readFile = vi.fn(() => null);
    const discovery = new ModelDiscovery(registryWith(CODEX_MANIFEST), noExec, undefined, client, readFile);
    await discovery.discover('codex');
    const second = await discovery.discover('codex');
    expect(second.map((m) => m.modelId)).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
    expect(client).toHaveBeenCalledTimes(2);
  });

  it('caches a successful app-server result', async () => {
    const client: AppServerClientImpl = vi.fn(async () => APP_SERVER_MODELS);
    const discovery = new ModelDiscovery(registryWith(CODEX_MANIFEST), noExec, undefined, client, () => null);
    await discovery.discover('codex');
    await discovery.discover('codex');
    expect(client).toHaveBeenCalledTimes(1);
  });
});

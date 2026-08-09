import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ModelResolver,
  SettingsService,
  type ExecImpl,
  type RunnerRegistry,
  type RunnerPluginManifest,
  type IConfig,
} from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

/** Routes injected-fetch calls by URL substring; unmatched URLs 404 — mirrors ModelResolver.test.ts. */
function fakeFetch(routes: Array<[string, unknown]>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    for (const [match, body] of routes) {
      if (url.includes(match)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function harnessManifest(name: string, variants: { id: string; label: string }[] = []): RunnerPluginManifest {
  return {
    name,
    displayName: name,
    runner: { command: name, args: [] },
    modelDiscovery: {
      method: 'command',
      discoveryCommands: [{ command: name, args: ['models'], parser: 'line-by-line' }],
      fallbackModels: [],
      variants,
    },
  } as unknown as RunnerPluginManifest;
}

function fakeRegistry(manifests: Record<string, RunnerPluginManifest>): RunnerRegistry {
  return { getManifest: (id: string) => manifests[id] } as unknown as RunnerRegistry;
}

function fakeConfig(over: Partial<IConfig> = {}): IConfig {
  const base = {
    openrouterKey: 'sk-or',
    geminiKey: '',
    openAiBaseUrl: 'https://openrouter.ai/api/v1',
    openaiCompatibleBaseUrl: '',
    openaiCompatibleApiKey: '',
    ...over,
  };
  return {
    ...base,
    getProviderBaseUrl: (p: unknown) => (p === 'openrouter' ? base.openAiBaseUrl : ''),
    getProviderApiKey: (p: unknown) => (p === 'openrouter' ? base.openrouterKey : ''),
    setProviderModelLists: () => {},
  } as unknown as IConfig;
}

/**
 * A resolver whose caches are pre-populated so `plannerCatalogFor` (a
 * synchronous read) sees a deterministic catalog without spawning a real CLI
 * or hitting the network: two harness planners (`claude-code`, `opencode` —
 * `opencode`'s models carry a `high` variant so effort-survival is testable)
 * plus a two-model vendor picker list.
 */
async function seededResolver(): Promise<ModelResolver> {
  const registry = fakeRegistry({
    'claude-code': harnessManifest('claude-code'),
    opencode: harnessManifest('opencode', [{ id: 'high', label: 'High effort' }]),
  });
  const exec: ExecImpl = (async (command: string) => {
    if (command.startsWith('claude-code')) return { stdout: 'claude-a Claude A\nclaude-b Claude B\n' };
    if (command.startsWith('opencode')) return { stdout: 'opencode/model-x Model X\nopencode/model-y Model Y\n' };
    return { stdout: '' };
  }) as ExecImpl;
  const fetchImpl = fakeFetch([
    ['/models', { data: [
      { id: 'vendor/model-a', name: 'Vendor A' },
      { id: 'vendor/model-b', name: 'Vendor B' },
    ] }],
  ]);
  const resolver = new ModelResolver(registry, fakeConfig(), { execImpl: exec, fetchImpl });
  await resolver.modelsForRunners(['claude-code', 'opencode']);
  await resolver.pickerOptions();
  return resolver;
}

describe('OrchestratorPool.updateSettings — planner model memory', () => {
  let dir: string;
  let pool: OrchestratorPool;
  let resolver: ModelResolver;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-planner-model-'));
    for (const key of ['ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT']) {
      savedEnv[key] = process.env[key];
    }
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    resolver = await seededResolver();
    pool = new OrchestratorPool({ modelResolver: resolver });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('restores the model remembered for a provider on switch', () => {
    process.env.AI_PROVIDER = 'opencode';
    pool.updateSettings({ orchestratorModel: 'opencode/model-y' });

    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'claude-a';

    const result = pool.updateSettings({
      env: { AI_PROVIDER: 'opencode', ORCHESTRATOR_MODEL: '', ORDEWELL_PLANNER_EFFORT: '' },
    });

    expect(result.orchestratorModel).toBe('opencode/model-y');
  });

  it('selects the first catalog model when nothing is remembered for the provider', () => {
    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'claude-a';

    const result = pool.updateSettings({
      env: { AI_PROVIDER: 'opencode', ORCHESTRATOR_MODEL: '', ORDEWELL_PLANNER_EFFORT: '' },
    });

    expect(result.orchestratorModel).toBe('opencode/model-x');
  });

  it('degrades a remembered id no longer in the catalog to the catalog default', () => {
    // Seed a stale memory entry directly — the id it names ('opencode/retired')
    // is not in the seeded catalog.
    new SettingsService().setPlannerModel('opencode', { model: 'opencode/retired' });
    process.env.AI_PROVIDER = 'claude-code';

    const result = pool.updateSettings({
      env: { AI_PROVIDER: 'opencode', ORCHESTRATOR_MODEL: '', ORDEWELL_PLANNER_EFFORT: '' },
    });

    expect(result.orchestratorModel).toBe('opencode/model-x');
  });

  it('leaves the model empty for a cold/empty catalog rather than inventing one', () => {
    process.env.AI_PROVIDER = 'claude-code';

    // 'codex' has no manifest in the seeded registry, so its cached catalog is empty.
    const result = pool.updateSettings({
      env: { AI_PROVIDER: 'codex', ORCHESTRATOR_MODEL: '', ORDEWELL_PLANNER_EFFORT: '' },
    });

    expect(result.orchestratorModel).toBe('');
  });

  it('carries the resolved model and a surviving effort in the response body', () => {
    process.env.AI_PROVIDER = 'opencode';
    pool.updateSettings({ orchestratorModel: 'opencode/model-x', plannerThinkingEffort: 'high' });

    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'claude-a';

    const result = pool.updateSettings({
      env: { AI_PROVIDER: 'opencode', ORCHESTRATOR_MODEL: '', ORDEWELL_PLANNER_EFFORT: '' },
    });

    expect(result.orchestratorModel).toBe('opencode/model-x');
    expect(result.plannerThinkingEffort).toBe('high');
  });

  it('records a harness planner pick under its own provider id', () => {
    process.env.AI_PROVIDER = 'claude-code';

    const result = pool.updateSettings({ orchestratorModel: 'claude-b' });

    expect(result.plannerModels?.['claude-code']).toEqual({ model: 'claude-b' });
  });

  it('records a vendor planner pick under its own provider id, not the harness one', () => {
    // No CLI provider is set, so `config.aiProvider` resolves via the
    // detect-provider fallback, which also reads AI_PROVIDER — set here to a
    // vendor id, exercising the "vendor, not harness" branch of the keying.
    process.env.AI_PROVIDER = 'openrouter';

    const result = pool.updateSettings({ orchestratorModel: 'vendor/model-a' });

    expect(result.plannerModels?.openrouter).toEqual({ model: 'vendor/model-a' });
    expect(result.plannerModels?.['claude-code']).toBeUndefined();
  });

  it('records an effort-only change sent via env, the shape the CLI and TUI actually send', () => {
    // `ordewell planner-effort <level>` and the TUI's effort picker both go
    // through `persistEnv`/`updateSettings({ env: { ORDEWELL_PLANNER_EFFORT } })`
    // — never the top-level `plannerThinkingEffort` field the other tests use.
    process.env.AI_PROVIDER = 'opencode';
    pool.updateSettings({ orchestratorModel: 'opencode/model-y' });

    const result = pool.updateSettings({ env: { ORDEWELL_PLANNER_EFFORT: 'high' } });

    expect(result.plannerModels?.opencode).toEqual({ model: 'opencode/model-y', effort: 'high' });
  });

  it('restores an env-only effort change after switching away and back', () => {
    process.env.AI_PROVIDER = 'opencode';
    pool.updateSettings({ orchestratorModel: 'opencode/model-y' });
    pool.updateSettings({ env: { ORDEWELL_PLANNER_EFFORT: 'high' } });

    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'claude-a';

    const result = pool.updateSettings({
      env: { AI_PROVIDER: 'opencode', ORCHESTRATOR_MODEL: '', ORDEWELL_PLANNER_EFFORT: '' },
    });

    expect(result.orchestratorModel).toBe('opencode/model-y');
    expect(result.plannerThinkingEffort).toBe('high');
  });

  it('does not invalidate the model catalog cache for a planner/model/effort-only env change', () => {
    pool.updateSettings({ env: { AI_PROVIDER: 'opencode' } });
    pool.updateSettings({ env: { ORCHESTRATOR_MODEL: 'opencode/model-x' } });
    pool.updateSettings({ env: { ORDEWELL_PLANNER_EFFORT: 'high' } });

    // Still cached from `seededResolver` — none of the above should have
    // cleared it, or the next switch would read an empty catalog.
    expect(resolver.getCachedRunnerModels('opencode').map((m) => m.modelId)).toEqual(['opencode/model-x', 'opencode/model-y']);
  });

  it('still invalidates the model catalog cache when a real provider credential changes', () => {
    pool.updateSettings({ env: { OPENROUTER_API_KEY: 'sk-new-key' } });

    expect(resolver.getCachedRunnerModels('opencode')).toEqual([]);
    expect(resolver.getCachedPickerOptions()).toEqual([]);
  });
});

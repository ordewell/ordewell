import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PROVIDER_PRIORITY, getProviderMeta, ModelResolver } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

describe('OrchestratorPool.getProviderModels — configured providers', () => {
  const providerEnv = [...new Set(PROVIDER_PRIORITY.map((id) => getProviderMeta(id)).flatMap((p) => [p.apiKeyEnvVar, ...p.detectEnvVars]))]
    .filter((v): v is string => Boolean(v));
  const watched = [...providerEnv, 'OPENAI_API_KEY', 'OPENAI_COMPATIBLE_BASE_URL', 'ORDEWELL_SETTINGS_PATH'];
  const savedEnv: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-providers-'));
    for (const key of watched) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    vi.spyOn(ModelResolver.prototype, 'modelsForRunners').mockResolvedValue({});
    vi.spyOn(ModelResolver.prototype, 'refresh').mockResolvedValue({});
    vi.spyOn(ModelResolver.prototype, 'pickerOptions').mockResolvedValue([]);
    vi.spyOn(ModelResolver.prototype, 'getDiscoveryErrors').mockReturnValue({});
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not count openrouter as configured when only OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai';

    const { providers } = await new OrchestratorPool().getProviderModels();

    expect(providers).toContain('openai');
    expect(providers).not.toContain('openrouter');
  });

  it('does not count a whitespace-only key as configured', async () => {
    process.env.OPENROUTER_API_KEY = '   ';

    const { providers } = await new OrchestratorPool().getProviderModels();

    expect(providers).not.toContain('openrouter');
  });

  it('tells the surface why a runner lists no models, as its resolver words it', async () => {
    const reason = 'Qwen Code is not signed in. Run `qwen`, or set the key of an OpenAI-compatible provider, such as OpenRouter, in Ordewell with `/key`.';
    vi.spyOn(ModelResolver.prototype, 'getRunnerDiscoveryErrors').mockReturnValue({ 'qwen-code': reason });

    const { runnerErrors } = await new OrchestratorPool().getProviderModels();

    expect(runnerErrors).toEqual({ 'qwen-code': reason });
  });

  // Qwen Code started on a saved OpenRouter key is handed the model that key's
  // catalog says the account is served (ADR-0060 R9): discovered alongside the
  // fetch, its first list after `/key` named a model the account is refused.
  it('loads the vendor catalogs before it discovers the runners, whose start can be chosen from them', async () => {
    const order: string[] = [];
    vi.spyOn(ModelResolver.prototype, 'refresh').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('vendor catalogs');
      return {};
    });
    vi.spyOn(ModelResolver.prototype, 'modelsForRunners').mockImplementation(async () => {
      order.push('runner discovery');
      return {};
    });

    await new OrchestratorPool().getProviderModels();

    expect(order).toEqual(['vendor catalogs', 'runner discovery']);
  });
});

describe('OrchestratorPool.getProviderModels — per workspace', () => {
  let dir: string;
  const savedSettingsPath = process.env.ORDEWELL_SETTINGS_PATH;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-workspace-models-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
  });

  afterEach(() => {
    if (savedSettingsPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedSettingsPath;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // One daemon serves several workspaces, and a workspace's tasks run under its
  // own `.ordewell/env`: the Claude catalog it is offered must come from the
  // account that env selects, not from the one the daemon was started in.
  it('discovers a named workspace\'s runner catalog under that workspace\'s env', async () => {
    const ws = path.join(dir, 'workspace-b');
    fs.mkdirSync(path.join(ws, '.ordewell'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.ordewell', 'env'), 'CLAUDE_CONFIG_DIR=/accounts/b\n');
    const withRunnerEnv = vi.spyOn(ModelResolver.prototype, 'withRunnerEnv');
    const askedOf: ModelResolver[] = [];
    vi.spyOn(ModelResolver.prototype, 'modelsForRunners').mockImplementation(async function (this: ModelResolver) {
      askedOf.push(this);
      return {};
    });
    vi.spyOn(ModelResolver.prototype, 'refresh').mockResolvedValue({});
    vi.spyOn(ModelResolver.prototype, 'pickerOptions').mockResolvedValue([]);
    vi.spyOn(ModelResolver.prototype, 'getDiscoveryErrors').mockReturnValue({});
    const pool = new OrchestratorPool({ codexSandbox: { ensure: async () => undefined, refresh: async () => undefined } });

    await pool.getProviderModels(ws);
    await pool.getProviderModels(ws);
    await pool.getProviderModels();

    // One view for the workspace, however often it is asked for.
    expect(new Set(withRunnerEnv.mock.calls.map(([key]) => key)).size).toBe(1);
    expect(new Set(withRunnerEnv.mock.results.map((result) => result.value)).size).toBe(1);
    expect(await withRunnerEnv.mock.calls[0][1]()).toMatchObject({ CLAUDE_CONFIG_DIR: '/accounts/b' });
    const view = withRunnerEnv.mock.results[0].value;
    expect(askedOf[0]).toBe(view);
    expect(askedOf[1]).toBe(view);
    expect(askedOf[2]).not.toBe(view);
    pool.destroyAll();
  });
});

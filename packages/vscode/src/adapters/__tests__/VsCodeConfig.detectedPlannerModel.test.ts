import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __setConfig, __resetConfig } from '../../test/vscode.mock';
import {
  CliAgentAiService, ModelResolver, PlannerModelMemory, RunnerRegistry, SettingsService, getProviderMeta, PROVIDER_DETECT_PRIORITY, recordInstalledPlanner, resetInstalledPlanner,
  type CliAgentAiServiceDeps, type SpawnFn,
} from '@ordewell/core';
import { fakeFileSystem } from '@ordewell/core/testing';
import { VsCodeConfig } from '../VsCodeConfig';
import { SecretStore } from '../SecretStore';
import { sendModelConfig } from '../../ModelDiscovery';
import { PlannerSelection } from '../../PlannerSelection';
import type { ChatViewProvider } from '../../providers/ChatViewProvider';

async function emptyStore(): Promise<SecretStore> {
  const store = new SecretStore({
    async get() { return undefined; },
    async store() {},
    async delete() {},
    onDidChange() { return { dispose() {} }; },
  } as never);
  await store.load();
  return store;
}

/**
 * The extension's half of a keyless first run with Claude Code installed and
 * an `ordewell.orchestratorModel` left from an old OpenRouter setup
 * (ADR-0009): the agent is never spawned with the vendor slug, and the model
 * the panel shows is the one it is spawned with.
 */
describe('VsCodeConfig never hands a detected coding agent a stale vendor model', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-vscode-detected-model-'));
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.ORDEWELL_PLANNER_EFFORT;
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
    __resetConfig();
    recordInstalledPlanner('claude-code');
  });

  afterEach(() => {
    resetInstalledPlanner();
    __resetConfig();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  /** The `--model` Claude Code is spawned with, blank when none is passed; the process itself is never started. */
  async function spawnedModel(config: VsCodeConfig): Promise<string> {
    return (await spawned(config)).model;
  }

  /** The `--model` and `--effort` Claude Code is spawned with, each blank when not passed. */
  async function spawned(config: VsCodeConfig): Promise<{ model: string; effort: string }> {
    let argv: string[] | undefined;
    const spawn: SpawnFn = (_command, args) => {
      argv = args;
      throw new Error('stopped at the process boundary');
    };
    const svc = new CliAgentAiService(config, {
      spawn,
      fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      resolvePath: async () => '/usr/bin',
      isDirectory: () => true,
      exists: () => true,
      workspaceRoot: () => dir,
      mcpServer: {
        issuePlannerToken: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok' }),
        revoke: () => {},
      } as unknown as CliAgentAiServiceDeps['mcpServer'],
    });
    await svc.startConversation({
      plannerTools: { sessionId: 's1', handler: {} },
      goal: 'Add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {},
    }).catch(() => {});
    if (!argv) throw new Error('claude was never spawned');
    const flag = (name: string) => {
      const at = argv!.indexOf(name);
      return at < 0 ? '' : argv![at + 1];
    };
    return { model: flag('--model'), effort: flag('--effort') };
  }

  /** What the panel is told the planner model is. */
  function shownModel(config: VsCodeConfig): string {
    let shown = '';
    const chat = { setModelConfig: (c: { orchestrator: string }) => { shown = c.orchestrator; } } as unknown as ChatViewProvider;
    sendModelConfig(config, chat, new ModelResolver(new RunnerRegistry(), config));
    return shown;
  }

  /** The planner switch the panel and `/planner` drive, over the shared settings file's memory. */
  function selection(config: VsCodeConfig): { selection: PlannerSelection; shownEffort: () => string | undefined } {
    let effort: string | undefined;
    const chatProvider = {
      setPlannerBackends: (_backends: unknown, _provider: string, _runner?: string, shown?: string) => { effort = shown; },
      setModelConfig: () => {},
    } as unknown as ChatViewProvider;
    const planner = new PlannerSelection({
      config,
      modelResolver: { getRunnerUnlisted: () => ({}), plannerCatalog: async () => [] } as never,
      plannerModelMemory: new PlannerModelMemory(new SettingsService()),
      runnerInstallation: { plannerUsability: async () => ({ usable: true }) } as never,
      chatProvider,
      sendModelConfig: () => {},
      log: () => {},
    });
    return { selection: planner, shownEffort: () => effort };
  }

  it('spawns Claude Code without the leftover model, and shows none', async () => {
    __setConfig({ orchestratorModel: 'openai/gpt-4o' });
    const config = new VsCodeConfig(await emptyStore());
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] });
    expect(config.aiProvider).toBe('claude-code');

    expect(await spawnedModel(config)).toBe('');
    expect(config.orchestratorModel).toBe('');
    expect(config.planningModel).toBe('');
    expect(shownModel(config)).toBe('');
  });

  it('spawns and shows the agent\'s remembered model in place of the leftover one', async () => {
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet' });
    __setConfig({ orchestratorModel: 'openai/gpt-4o', planningModel: 'openai/gpt-4o' });
    const config = new VsCodeConfig(await emptyStore());

    expect(await spawnedModel(config)).toBe('sonnet');
    expect(config.planningModel).toBe('sonnet');
    expect(shownModel(config)).toBe('sonnet');
  });

  it('spawns and shows the agent\'s remembered model and effort when no model is set', async () => {
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'high' });
    const config = new VsCodeConfig(await emptyStore());

    expect(await spawned(config)).toEqual({ model: 'sonnet', effort: 'high' });
    expect(shownModel(config)).toBe('sonnet');
    expect(config.plannerThinkingEffort).toBe('high');
  });

  it('shows the remembered model and effort it spawns, never the leftover effort', async () => {
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'high' });
    __setConfig({ orchestratorModel: 'openai/gpt-4o', plannerThinkingEffort: 'low' });
    const config = new VsCodeConfig(await emptyStore());
    const { selection: planner, shownEffort } = selection(config);

    await planner.sendState();

    expect(await spawned(config)).toEqual({ model: 'sonnet', effort: 'high' });
    expect(shownModel(config)).toBe('sonnet');
    expect(shownEffort()).toBe('high');
  });

  it('an effort picked for the remembered model is remembered, and the configured model is left for a later key', async () => {
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet' });
    __setConfig({ orchestratorModel: 'openai/gpt-4o' });
    const config = new VsCodeConfig(await emptyStore());

    await selection(config).selection.pick({ effort: 'high' });

    expect(await spawned(config)).toEqual({ model: 'sonnet', effort: 'high' });
    expect(config.rawOrchestratorModel).toBe('openai/gpt-4o');
    expect(new SettingsService().getPlannerModel('claude-code')).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('an effort picked for an inherited model of the agent\'s own applies without saving that model', async () => {
    __setConfig({ orchestratorModel: 'opus' });
    const config = new VsCodeConfig(await emptyStore());

    await selection(config).selection.pick({ effort: 'high' });

    expect(await spawned(config)).toEqual({ model: 'opus', effort: 'high' });
    expect(new SettingsService().getAll().plannerModels).toBeUndefined();
  });

  it('a model picked in this window stays its planner model; a later window reads that setting as inherited', async () => {
    const config = new VsCodeConfig(await emptyStore());
    await selection(config).selection.setModel('claude-opus-5-5', 'max');
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'low' });

    expect(await spawned(config)).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
    expect(await spawned(new VsCodeConfig(await emptyStore()))).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('a leftover ORCHESTRATOR_MODEL in the environment is not spawned either', async () => {
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
    const config = new VsCodeConfig(await emptyStore());

    expect(await spawnedModel(config)).toBe('');
  });

  it('keeps an explicit Claude Code choice\'s own model', async () => {
    __setConfig({ aiProvider: 'claude-code', orchestratorModel: 'opus' });
    const config = new VsCodeConfig(await emptyStore());

    expect(await spawnedModel(config)).toBe('opus');
    expect(shownModel(config)).toBe('opus');
  });

  it('keeps the model of a Claude Code choice made through AI_PROVIDER', async () => {
    process.env.AI_PROVIDER = 'claude-code';
    __setConfig({ orchestratorModel: 'claude-haiku-5-5' });

    expect(await spawnedModel(new VsCodeConfig(await emptyStore()))).toBe('claude-haiku-5-5');
  });

  it('a vendor with its key keeps its vendor model', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    __setConfig({ orchestratorModel: 'openai/gpt-4o' });
    const config = new VsCodeConfig(await emptyStore());
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] });

    expect(config.aiProvider).toBe('openrouter');
    expect(config.orchestratorModel).toBe('openai/gpt-4o');
    expect(config.planningModel).toBe('openai/gpt-4o');
  });
});

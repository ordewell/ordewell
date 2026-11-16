import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IConfig } from '../../interfaces/IConfig';
import { EnvConfig } from '../../interfaces/EnvConfig';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { createTask, migrateLoadedPlan, migrateLoadedTasks, type LegacyPlanState } from '../../models/Task';
import { removeDir, setEnv } from '../../testEnv';
import { fakeConfig } from '../../testing';
import { createAiService } from '../AiService';
import { OpenAiService } from '../OpenAiService';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { CONNECTORS } from '../harness/connectors';
import { ModelResolver } from '../ModelResolver';
import { RunnerInstallation } from '../RunnerInstallation';
import { SettingsService } from '../SettingsService';
import { defaultEnabledRunners, detectInstalledPlanner, resetInstalledPlanner } from '../InstalledPlanner';
import { PROVIDER_PRIORITY, VENDORS } from '../apiProviders';
import {
  ALL_PROVIDERS, CLI_PROVIDERS, configuredProviders, getProviderMeta, isCliProvider, plannerBackendEntries, providerForRunner, runnerForProvider,
} from '../ProviderRegistry';
import { PROVIDER_RUNNER_IDS, configuredProviderRunners, isProviderRunner, providerRunnerLabel } from '../providerRunners';
import { assertAssignedRunners } from '../PlanStore';

/*
 * The built-in runner is one runner per API provider, under the provider's id
 * and name (ADR-0070): "OpenRouter" in the runner selector is Ordewell's own
 * loop on OpenRouter, and "OpenRouter" in the planner selector is the API
 * planner on the same key. A provider with no key has no runner at all.
 */

const CREDENTIALS = PROVIDER_PRIORITY.flatMap((p) => [VENDORS[p].apiKeyEnvVar, ...VENDORS[p].detectEnvVars, ...(VENDORS[p].baseUrlEnvVar ? [VENDORS[p].baseUrlEnvVar] : [])]);

let restoreEnv: () => void = () => {};
const dirs: string[] = [];

beforeEach(() => {
  // No key from the machine running the tests reaches a case that did not set one.
  restoreEnv = setEnv({ ...Object.fromEntries(CREDENTIALS.map((name) => [name, undefined])), AI_PROVIDER: undefined, ORCHESTRATOR_MODEL: undefined });
});

afterEach(async () => {
  resetInstalledPlanner();
  restoreEnv();
  while (dirs.length) await removeDir(dirs.pop()!);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-provider-runners-'));
  dirs.push(dir);
  return dir;
}

const installation = () => new RunnerInstallation(new RunnerRegistry(), vi.fn(async () => ({ stdout: '' })));

describe('the provider runners', () => {
  it('are one per provider, named as the provider, after the coding agents, and none is called Ordewell', () => {
    const registry = new RunnerRegistry();
    const names = registry.list().map((entry) => entry.manifest.name);
    expect(names.slice(-PROVIDER_RUNNER_IDS.length)).toEqual(PROVIDER_RUNNER_IDS);
    expect(names).not.toContain('ordewell');
    for (const provider of PROVIDER_RUNNER_IDS) {
      const manifest = registry.getManifest(provider);
      expect(manifest?.displayName, provider).toBe(VENDORS[provider].label);
      expect(manifest?.runner, provider).toEqual({ inProcess: true, provider });
      expect(isProviderRunner(provider)).toBe(true);
      expect(providerRunnerLabel(provider)).toBe(VENDORS[provider].label);
    }
    expect(registry.list().some((entry) => entry.manifest.displayName === 'Ordewell')).toBe(false);
    expect(isProviderRunner('claude-code')).toBe(false);
    expect(isProviderRunner('toString')).toBe(false);
  });

  it('leave out a provider whose models cannot be listed: its key plans, and runs nothing', async () => {
    const undiscoverable = PROVIDER_PRIORITY.filter((provider) => !VENDORS[provider].discoversModels);
    expect(undiscoverable).toEqual(['perplexity']);
    expect(PROVIDER_RUNNER_IDS).toEqual(PROVIDER_PRIORITY.filter((provider) => provider !== 'perplexity'));
    expect(isProviderRunner('perplexity')).toBe(false);
    expect(new RunnerRegistry().getManifest('perplexity')).toBeUndefined();
    expect(CONNECTORS).not.toHaveProperty('perplexity');

    setEnv({ PERPLEXITY_API_KEY: 'pplx-test' });
    expect(configuredProviderRunners(process.env)).toEqual([]);
    expect(await installation().filterInstalled([...PROVIDER_PRIORITY])).toEqual([]);
    expect(defaultEnabledRunners()).toEqual(['claude-code']);
    // The API planner still plans on the key.
    expect(configuredProviders(new EnvConfig())).toEqual(['perplexity']);
  });

  it('leave a provider with no key out of the runner list: no row, so nothing to sign in', async () => {
    const all = new RunnerRegistry().list().map((entry) => entry.manifest.name).filter(isProviderRunner);
    expect(await installation().filterInstalled(all)).toEqual([]);
  });

  it('list a keyed provider as signed in, with no way in attached and no planner of its own', async () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test' });
    const probe = installation();
    expect(await probe.filterInstalled([...PROVIDER_PRIORITY])).toEqual(['openrouter']);
    expect(await probe.runnerUsability('openrouter')).toEqual({ usable: true, auth: { state: 'signed-in' } });
    expect(CONNECTORS.openrouter.plans).toBe(false);
    expect(await probe.plannerUsability('openrouter')).toEqual({
      usable: false, reason: 'The built-in runner does not plan: plan with the OpenRouter API planner instead.',
    });
  });

  it('see a key set into the running process at the next look, and lose it the same way', async () => {
    const probe = installation();
    expect(await probe.isInstalled('anthropic')).toBe(false);
    const restore = setEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(await probe.isInstalled('anthropic')).toBe(true);
    restore();
    expect(await probe.isInstalled('anthropic')).toBe(false);
  });

  it('configure a custom endpoint by its URL alone, as the planner does, and never by a key with no URL', async () => {
    setEnv({ OPENAI_COMPATIBLE_API_KEY: 'local-key' });
    expect(await installation().isInstalled('openai_compatible')).toBe(false);
    expect(configuredProviders(new EnvConfig())).not.toContain('openai_compatible');
    setEnv({ OPENAI_COMPATIBLE_API_KEY: undefined, OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:11434/v1' });
    expect(await installation().isInstalled('openai_compatible')).toBe(true);
    expect(configuredProviders(new EnvConfig())).toContain('openai_compatible');
  });

  it('are the planner\'s configured vendors exactly, so the same names are in both selectors', () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test', GEMINI_API_KEY: 'g-test', DEEPSEEK_API_KEY: 'd-test', OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1/v1' });
    const runners = configuredProviderRunners(process.env);
    expect(runners).toEqual(['openrouter', 'google', 'deepseek', 'openai_compatible']);
    expect(runners).toEqual(configuredProviders(new EnvConfig()));
  });

  it('give two keyed providers two runners, each offering only its own provider\'s models', async () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: 'sk-ant-test' });
    const asked: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      const ids = url.startsWith('https://openrouter.ai/') ? ['openai/gpt-4o-mini'] : url.startsWith('https://api.anthropic.com/') ? ['claude-haiku-test'] : [];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id, name: id })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const resolver = new ModelResolver(new RunnerRegistry(), {} as IConfig, { fetchImpl, execImpl: vi.fn(async () => ({ stdout: '' })) });

    const { openrouter, anthropic, google } = await resolver.modelsForRunners(['openrouter', 'anthropic', 'google']);

    expect(openrouter?.map((m) => [m.modelId, m.runnerId, m.runnerLabel, m.runnerProvider])).toEqual([['openrouter:openai/gpt-4o-mini', 'openrouter', 'OpenRouter', 'openrouter']]);
    expect(anthropic?.map((m) => [m.modelId, m.runnerId, m.runnerLabel, m.runnerProvider])).toEqual([['anthropic:claude-haiku-test', 'anthropic', 'Anthropic', 'anthropic']]);
    expect(google ?? []).toEqual([]);
    // One catalog per runner: neither asked the other's endpoint, and the keyless one asked none.
    expect(asked.filter((url) => url.startsWith('https://openrouter.ai/'))).toHaveLength(1);
    expect(asked.filter((url) => url.startsWith('https://api.anthropic.com/'))).toHaveLength(1);
    expect(asked).toHaveLength(2);
  });
});

describe('a planner under a provider\'s id', () => {
  it('is the API planner on that provider, never the runner of the same name', () => {
    for (const provider of PROVIDER_PRIORITY) {
      expect(ALL_PROVIDERS[provider], provider).toBe(VENDORS[provider]);
      expect(getProviderMeta(provider)?.runnerId, provider).toBeUndefined();
      expect(isCliProvider(provider), provider).toBe(false);
      expect(runnerForProvider(provider), provider).toBeNull();
      expect(providerForRunner(provider), provider).toBeNull();
      expect(CLI_PROVIDERS, provider).not.toContain(provider);
    }
  });

  it('is listed once, as the vendor, though a runner of that id is usable', () => {
    const entries = plannerBackendEntries({ openrouter: { usable: true }, 'claude-code': { usable: true } }, ['openrouter']);
    expect(entries.filter((entry) => entry.id === 'openrouter')).toEqual([
      { id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true, reason: 'OPENROUTER_API_KEY' },
    ]);
  });

  it.each(['openrouter', 'anthropic'] as const)('AI_PROVIDER=%s plans with the API planner on the key', (provider) => {
    setEnv({ AI_PROVIDER: provider, [VENDORS[provider].apiKeyEnvVar]: 'sk-test', ORCHESTRATOR_MODEL: 'some-model' });
    const config = new EnvConfig();
    expect(config.aiProvider).toBe(provider);
    const service = createAiService(config);
    expect(service).toBeInstanceOf(OpenAiService);
    expect(service).not.toBeInstanceOf(CliAgentAiService);
    expect(createAiService(fakeConfig({ aiProvider: provider }))).toBeInstanceOf(OpenAiService);
  });
});

describe('the default enabled runners', () => {
  it('add every keyed provider\'s runner after the agents found installed', async () => {
    expect(defaultEnabledRunners()).toEqual(['claude-code']);
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test' });
    expect(defaultEnabledRunners()).toEqual(['openrouter']);
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(defaultEnabledRunners()).toEqual(['openrouter', 'anthropic']);
    await detectInstalledPlanner({ plannerUsability: async (runner) => ({ usable: runner === 'codex' }) });
    expect(defaultEnabledRunners()).toEqual(['codex', 'openrouter', 'anthropic']);
  });

  it('read the host\'s own keys, not a workspace\'s: a key only there lists its runner, and leaves it for the user to enable', async () => {
    const workspaceKeyed = new RunnerInstallation(new RunnerRegistry(), vi.fn(async () => ({ stdout: '' })), Date.now, {
      env: async () => ({ OPENROUTER_API_KEY: 'sk-or-workspace' }),
      workspace: () => '/repo',
    });
    expect(await workspaceKeyed.isInstalled('openrouter')).toBe(true);
    expect(defaultEnabledRunners()).toEqual(['claude-code']);
  });

  it('never rewrite a list the user saved', () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test' });
    const file = join(tempDir(), 'settings.json');
    new SettingsService(file).setEnabledRunners(['claude-code']);
    expect(new SettingsService(file).getEnabledRunners()).toEqual(['claude-code']);
  });
});

describe('what still names the built-in runner by its one old id', () => {
  const legacyTask = (modelId: string, overrides: Parameters<typeof createTask>[0] = {}) =>
    createTask({ assignedRunner: 'ordewell', assignedModel: { modelId, modelLabel: modelId }, ...overrides });

  it('moves a loaded task, its session with it, onto the runner of the provider its model names', () => {
    const subtask = legacyTask('google:gemini-2.5-flash');
    const task = { ...legacyTask('anthropic:claude-haiku-test', { subtasks: [subtask] }), runnerSessionId: 'transcript-1', runnerSessionOwner: 'ordewell' };
    const unnamed = legacyTask('no-provider');
    migrateLoadedTasks([task, unnamed]);
    expect([task.assignedRunner, task.runnerSessionOwner, task.runnerSessionId, task.assignedModel?.modelId]).toEqual(['anthropic', 'anthropic', 'transcript-1', 'anthropic:claude-haiku-test']);
    expect(subtask.assignedRunner).toBe('google');
    // Nothing says which provider it was: it stays, and the runner list ignores an id it does not know.
    expect(unnamed.assignedRunner).toBe('ordewell');
  });

  it('replaces it in an adopted plan\'s runner set with the provider runners its tasks were moved to', () => {
    const plan = {
      tasks: [legacyTask('openrouter:openai/gpt-4o-mini'), createTask({ assignedRunner: 'claude-code' })],
      runners: ['claude-code', 'ordewell'], status: 'draft', generatedAt: '2026-11-16T00:00:00.000Z', lastUpdated: '2026-11-16T00:00:00.000Z',
    } as LegacyPlanState;
    migrateLoadedPlan(plan);
    expect(plan.tasks[0].assignedRunner).toBe('openrouter');
    expect(plan.runners).toEqual(['claude-code', 'openrouter']);

    const idle = { tasks: [], runners: ['ordewell', 'codex'], status: 'draft', generatedAt: '', lastUpdated: '' } as unknown as LegacyPlanState;
    migrateLoadedPlan(idle);
    expect(idle.runners).toEqual(['codex']);
  });

  // Bug: the set dropped the old id while a task still named it, and the plan was refused at load, every task with it.
  it('keeps it in the runner set while a task it cannot move still names it, so the plan loads', () => {
    const unmodelled = createTask({ id: 'unmodelled', title: 'No model', assignedRunner: 'ordewell' });
    const unprefixed = legacyTask('gpt-4o-mini', { id: 'unprefixed', title: 'No provider' });
    const plan = {
      tasks: [legacyTask('anthropic:claude-haiku-test', { id: 'moved', subtasks: [unprefixed] }), unmodelled],
      runners: ['claude-code', 'ordewell'], status: 'draft', generatedAt: '', lastUpdated: '',
    } as unknown as LegacyPlanState;

    migrateLoadedPlan(plan);

    expect(plan.tasks.map((task) => task.assignedRunner)).toEqual(['anthropic', 'ordewell']);
    expect(unprefixed.assignedRunner).toBe('ordewell');
    expect(plan.runners).toEqual(['claude-code', 'anthropic', 'ordewell']);
    expect(() => assertAssignedRunners(plan.tasks, plan.runners)).not.toThrow();
  });

  it('reads a settings file\'s enabled entry as every keyed provider\'s runner, and splits its allowlist by provider', () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test', GEMINI_API_KEY: 'g-test' });
    const file = join(tempDir(), 'settings.json');
    writeFileSync(file, JSON.stringify({
      enabledRunners: ['claude-code', 'ordewell'],
      modelAllowlist: { ordewell: ['openrouter:openai/gpt-4o-mini', 'google:gemini-2.5-flash', 'not-a-provider-model'], codex: ['gpt-5'] },
    }));
    const settings = new SettingsService(file);
    expect(settings.getEnabledRunners()).toEqual(['claude-code', 'openrouter', 'google']);
    expect(settings.getAll().modelAllowlist).toEqual({ codex: ['gpt-5'], openrouter: ['openrouter:openai/gpt-4o-mini'], google: ['google:gemini-2.5-flash'] });
  });

  // Bug: read with no key set, the entry became no runner at all, and the next save made that permanent.
  it('keeps a settings file\'s enabled entry while no provider is configured, and moves it once one is', () => {
    const file = join(tempDir(), 'settings.json');
    writeFileSync(file, JSON.stringify({ enabledRunners: ['claude-code', 'ordewell'] }));
    const settings = new SettingsService(file);
    expect(settings.getEnabledRunners()).toEqual(['claude-code', 'ordewell']);
    settings.setAutonomousMode(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).enabledRunners).toEqual(['claude-code', 'ordewell']);

    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(settings.getEnabledRunners()).toEqual(['claude-code', 'anthropic']);
    settings.setAutonomousMode(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).enabledRunners).toEqual(['claude-code', 'anthropic']);
    expect(new SettingsService(file).getEnabledRunners()).toEqual(['claude-code', 'anthropic']);
  });

  // Bug: a provider the old allowlist named no model of came out enabled with no allowlist, so any of its models could be assigned.
  it('enables only the providers an old allowlist names, so none comes out enabled and unrestricted', () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: 'sk-ant-test' });
    const file = join(tempDir(), 'settings.json');
    writeFileSync(file, JSON.stringify({ enabledRunners: ['ordewell'], modelAllowlist: { ordewell: ['openrouter:cheap/model'] } }));
    const settings = new SettingsService(file);
    expect(settings.getEnabledRunners()).toEqual(['openrouter']);
    expect(settings.getAll().modelAllowlist).toEqual({ openrouter: ['openrouter:cheap/model'] });
  });

  it('keeps both entries while the providers an old allowlist names have no key', () => {
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    const file = join(tempDir(), 'settings.json');
    writeFileSync(file, JSON.stringify({ enabledRunners: ['ordewell'], modelAllowlist: { ordewell: ['openrouter:cheap/model'] } }));
    const settings = new SettingsService(file);
    expect(settings.getEnabledRunners()).toEqual(['ordewell']);
    expect(settings.getAll().modelAllowlist).toEqual({ ordewell: ['openrouter:cheap/model'] });
  });

  it('splits an old allowlist whose runner was not enabled, whatever is configured', () => {
    const file = join(tempDir(), 'settings.json');
    writeFileSync(file, JSON.stringify({ enabledRunners: ['codex'], modelAllowlist: { ordewell: ['openrouter:cheap/model', 'no-provider'] } }));
    const settings = new SettingsService(file);
    expect(settings.getEnabledRunners()).toEqual(['codex']);
    expect(settings.getAll().modelAllowlist).toEqual({ openrouter: ['openrouter:cheap/model'] });

    writeFileSync(file, JSON.stringify({ modelAllowlist: { ordewell: ['no-provider'] } }));
    expect(new SettingsService(file).getAll().modelAllowlist).toBeUndefined();
  });
});

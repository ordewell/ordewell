import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GeminiService, ModelResolver, OpenAiService, Session, getProviderMeta, PROVIDER_DETECT_PRIORITY, recordInstalledPlanner, resetInstalledPlanner,
  type ConversationTurn, type LegacyPlanState, type RunnerRegistry,
} from '@ordewell/core';
import { OrchestratorPool, type OrchestratorPoolDeps } from '../orchestratorPool';
import { WebConfig } from '../../adapters/WebConfig';

/** OpenRouter's catalog lists `openai/gpt-4o`; every other vendor's discovery fails. No network. */
const catalogs = (async (input: Parameters<typeof fetch>[0]) =>
  String(input).includes('openrouter')
    ? new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }] }), { status: 200 })
    : new Response('not found', { status: 404 })) as typeof fetch;

const turn: ConversationTurn = { kind: 'message', text: 'hi', researchLog: [] };

/**
 * Credentials change mid-session, through the settings route. What the
 * settings response names as the planner and what the next real turn plans
 * with must be the same provider: nothing may route on provider lists
 * discovered while a removed key was still set.
 */
describe('OrchestratorPool routing after a credential change', () => {
  const saved = { ...process.env };
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-credential-routing-'));
    workspace = join(dir, 'ws');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORCHESTRATOR_MODEL;
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetInstalledPlanner();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  function pool(): OrchestratorPool {
    const registry = { getManifest: () => undefined } as unknown as RunnerRegistry;
    return new OrchestratorPool({
      modelResolver: new ModelResolver(registry, new WebConfig(), { fetchImpl: catalogs }),
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined } as unknown as OrchestratorPoolDeps['codexSandbox'],
      runnerInstallation: {
        plannerUsability: async () => ({ usable: false, reason: 'not installed' }),
        runnerUsability: async () => ({ usable: false, reason: 'not installed' }),
        filterInstalled: async () => [],
      },
    });
  }

  /** Which vendor transport each turn reached. */
  function transports() {
    const reached: string[] = [];
    vi.spyOn(OpenAiService.prototype, 'startConversation').mockImplementation(async () => { reached.push('openrouter'); return turn; });
    vi.spyOn(OpenAiService.prototype, 'continueConversation').mockImplementation(async () => { reached.push('openrouter'); return turn; });
    vi.spyOn(GeminiService.prototype, 'startConversation').mockImplementation(async () => { reached.push('google'); return turn; });
    vi.spyOn(GeminiService.prototype, 'continueConversation').mockImplementation(async () => { reached.push('google'); return turn; });
    return reached;
  }

  it('with the agent detected, the settings response and the next turn agree once the last key is removed', async () => {
    recordInstalledPlanner('claude-code');
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
    const p = pool();
    await p.getProviderModels();
    expect(p.getSettings().aiProvider).toBe('openrouter');

    const settings = p.updateSettings({ env: { OPENROUTER_API_KEY: '' } });
    expect(settings.aiProvider).toBe('claude-code');

    const start = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);
    await p.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    expect(start).toHaveBeenCalledTimes(1);
    p.destroyAll();
  });

  it('a new session plans with the vendor the settings response names once a key is removed', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.GEMINI_API_KEY = 'sk-gem-test';
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
    const p = pool();
    await p.getProviderModels();
    const reached = transports();

    const settings = p.updateSettings({ env: { OPENROUTER_API_KEY: '' } });
    await p.startPlanning('s1', 'ship it', ['claude-code'], workspace);

    expect(settings.aiProvider).toBe('google');
    expect(reached).toEqual([settings.aiProvider]);
    p.destroyAll();
  });

  it('a live session\'s next reply plans with the vendor the settings response names once a key is removed', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.GEMINI_API_KEY = 'sk-gem-test';
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
    const p = pool();
    await p.getProviderModels();
    const reached = transports();
    await p.startPlanning('s1', 'ship it', ['claude-code'], workspace);

    const settings = p.updateSettings({ env: { OPENROUTER_API_KEY: '' } });
    await p.continuePlanning('s1', 'go on');

    expect(settings.aiProvider).toBe('google');
    expect(reached).toEqual(['openrouter', settings.aiProvider]);
    p.destroyAll();
  });

  it('adding a second key keeps the planner on the vendor that still holds its key', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
    const p = pool();
    await p.getProviderModels();
    const reached = transports();

    const settings = p.updateSettings({ env: { GEMINI_API_KEY: 'sk-gem-test' } });
    await p.startPlanning('s1', 'ship it', ['claude-code'], workspace);

    expect(settings.aiProvider).toBe('openrouter');
    expect(reached).toEqual(['openrouter']);
    p.destroyAll();
  });

  it('the settings response names the vendor a new session plans with', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.GEMINI_API_KEY = 'sk-gem-test';
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
    const p = pool();
    await p.getProviderModels();
    const reached = transports();

    await p.startPlanning('s1', 'ship it', ['claude-code'], workspace);

    expect(reached).toEqual([p.getSettings().aiProvider]);
    p.destroyAll();
  });
});

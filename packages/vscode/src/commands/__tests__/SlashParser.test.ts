import { describe, it, expect, vi } from 'vitest';
import { window } from '../../test/vscode.mock';
import { handleSlashCommand, isKnownSlashCommand, type SlashDeps } from '../SlashParser';
import type { DiscoveredModel } from '@ordewell/core';

function harnessModel(modelId: string, variantIds: string[] = []): DiscoveredModel {
  return { modelId, modelLabel: modelId, variants: variantIds.map((id) => ({ id, label: id })) };
}

/** Every SlashDeps field the parser can reach, defaulted to a no-op so each test only overrides what it exercises. */
function makeDeps(overrides: Partial<SlashDeps> = {}): SlashDeps {
  return {
    config: {
      orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '',
      openAiBaseUrl: '', configuredProviders: [], aiProvider: 'claude-code', plannerThinkingEffort: '',
    },
    modelResolver: {
      pickerOptions: async () => [],
      refresh: async () => undefined,
      invalidate: () => {},
      refreshRunnerModels: () => {},
      modelsForRunners: async () => ({}),
    },
    plannerBackends: async () => [],
    refreshPlannerState: async () => {},
    pluginRegistry: { list: () => [], get: () => undefined, getManifest: () => undefined },
    chatProvider: {} as SlashDeps['chatProvider'],
    settingsService: { getModelAllowlist: () => undefined, setModelAllowlist: () => {} },
    sendRunnerAndModels: async () => {},
    runApiKeyWizard: async () => {},
    discoverOrchestratorModelOptions: async () => [],
    pickModelWithProvider: async () => undefined,
    updateConfig: async () => {},
    recordPlannerModel: () => {},
    log: () => {},
    ...overrides,
  };
}

describe('/model set records the pick against the current provider', () => {
  it('records a harness planner model chosen by exact id', async () => {
    const recordPlannerModel = vi.fn();
    const deps = makeDeps({
      config: { orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'claude-code', plannerThinkingEffort: '' },
      modelResolver: {
        pickerOptions: async () => [],
        refresh: async () => undefined,
        invalidate: () => {},
        refreshRunnerModels: () => {},
        modelsForRunners: async () => ({ 'claude-code': [harnessModel('claude-sonnet-4-5', ['low', 'high'])] }),
      },
      recordPlannerModel,
    });

    await handleSlashCommand('/model set claude-sonnet-4-5', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('claude-sonnet-4-5', undefined);
  });

  it('drops a stale effort and records the model without it', async () => {
    const recordPlannerModel = vi.fn();
    const deps = makeDeps({
      config: { orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'claude-code', plannerThinkingEffort: 'xhigh' },
      modelResolver: {
        pickerOptions: async () => [],
        refresh: async () => undefined,
        invalidate: () => {},
        refreshRunnerModels: () => {},
        modelsForRunners: async () => ({ 'claude-code': [harnessModel('claude-haiku-4-5', ['low'])] }),
      },
      recordPlannerModel,
    });

    await handleSlashCommand('/model set claude-haiku-4-5', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('claude-haiku-4-5', undefined);
  });

  it('records a vendor model chosen by a known shortcut', async () => {
    const recordPlannerModel = vi.fn();
    const deps = makeDeps({
      config: { orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'openrouter', plannerThinkingEffort: '' },
      discoverOrchestratorModelOptions: async () => [{ id: 'z-ai/glm-4.6', label: 'GLM 4.6', provider: 'openrouter' }],
      recordPlannerModel,
    });

    await handleSlashCommand('/model set z-ai/glm-4.6', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('z-ai/glm-4.6');
  });

  it('records a vendor model picked from the quick pick when no shortcut matches', async () => {
    const recordPlannerModel = vi.fn();
    window.showQuickPick = vi.fn() as never;
    const deps = makeDeps({
      config: { orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'openrouter', plannerThinkingEffort: '' },
      discoverOrchestratorModelOptions: async () => [{ id: 'z-ai/glm-4.6', label: 'GLM 4.6', provider: 'openrouter' }],
      pickModelWithProvider: async () => 'z-ai/glm-4.6',
      recordPlannerModel,
    });

    await handleSlashCommand('/model set nonsense', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('z-ai/glm-4.6');
  });
});

describe('/planner-effort records the effort against the current model', () => {
  it('records the model with the newly chosen effort by exact id', async () => {
    const recordPlannerModel = vi.fn();
    const deps = makeDeps({
      config: { orchestratorModel: 'claude-sonnet-4-5', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'claude-code', plannerThinkingEffort: '' },
      modelResolver: {
        pickerOptions: async () => [],
        refresh: async () => undefined,
        invalidate: () => {},
        refreshRunnerModels: () => {},
        modelsForRunners: async () => ({ 'claude-code': [harnessModel('claude-sonnet-4-5', ['low', 'high'])] }),
      },
      recordPlannerModel,
    });

    await handleSlashCommand('/planner-effort high', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('claude-sonnet-4-5', 'high');
  });
});

describe('isKnownSlashCommand', () => {
  it('recognizes every extension slash command regardless of case', () => {
    expect(isKnownSlashCommand('/model set foo')).toBe(true);
    expect(isKnownSlashCommand('/PLANNER')).toBe(true);
    expect(isKnownSlashCommand('/refresh')).toBe(true);
  });

  it('rejects a discovered-skill invocation so it falls through to the message path', () => {
    expect(isKnownSlashCommand('/grilling')).toBe(false);
    expect(isKnownSlashCommand('/to-spec')).toBe(false);
  });
});

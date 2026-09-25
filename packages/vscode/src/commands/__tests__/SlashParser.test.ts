import { describe, it, expect, vi } from 'vitest';
import { window, commands } from '../../test/vscode.mock';
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

  it('recognizes the conversation-editing commands', () => {
    expect(isKnownSlashCommand('/fork')).toBe(true);
    expect(isKnownSlashCommand('/rewind')).toBe(true);
    expect(isKnownSlashCommand('/rewind 3')).toBe(true);
    expect(isKnownSlashCommand('/COMPACT')).toBe(true);
  });

  it('rejects a discovered-skill invocation so it falls through to the message path', () => {
    expect(isKnownSlashCommand('/grilling')).toBe(false);
    expect(isKnownSlashCommand('/to-spec')).toBe(false);
  });
});

describe('conversation-editing slash commands', () => {
  const executeCommand = commands.executeCommand as unknown as ReturnType<typeof vi.fn>;

  it('/fork runs the fork command', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/fork', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.forkConversation');
  });

  it('/rewind with no argument leaves the choice to the picker', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/rewind', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.rewindConversation', undefined);
  });

  it('/rewind <n> hands the message number on', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/rewind 3', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.rewindConversation', '3');
  });

  it('/compact runs the compact command', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/compact', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.compactConversation');
  });

  it('/help lists them', async () => {
    const info = window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    info.mockClear();
    await handleSlashCommand('/help', makeDeps());
    const text = info.mock.calls[0][0] as string;
    expect(text).toContain('/fork');
    expect(text).toContain('/rewind');
    expect(text).toContain('/compact');
  });
});

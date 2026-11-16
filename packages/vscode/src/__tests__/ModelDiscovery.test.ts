import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInstalledPlanner, RunnerRegistry, type DiscoveredModel } from '@ordewell/core';
import { ModelDiscovery, type ModelDiscoveryDeps } from '../ModelDiscovery';
import type { ApiKeyValidation } from '../adapters/ApiKeyValidator';

const validateApiKey = vi.hoisted(() => vi.fn<(provider: string, key: string, opts?: { baseUrl?: string }) => Promise<ApiKeyValidation>>());
vi.mock('../adapters/ApiKeyValidator', () => ({ validateApiKey }));

/** Any method a test does not name answers nothing, so only what a case is about needs a fake. */
function anything<T>(named: Partial<Record<keyof T, unknown>> = {}): T {
  return new Proxy(named as object, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : (key === 'then' ? undefined : vi.fn())),
  }) as T;
}

function harness(options: { inputs?: (string | undefined)[]; baseUrls?: Record<string, string>; customUrl?: string } = {}) {
  const inputs = [...(options.inputs ?? [])];
  const window = {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(async () => inputs.shift()),
    withProgress: vi.fn(async (_opts: unknown, task: () => Promise<unknown>) => task()),
    showErrorMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  };
  const config = {
    getProviderBaseUrl: vi.fn((provider: string) => options.baseUrls?.[provider] ?? ''),
    openaiCompatibleBaseUrl: options.customUrl ?? '',
    update: vi.fn(async () => {}),
  };
  const secretStore = { set: vi.fn(async () => {}) };
  const onApiKeySaved = vi.fn(async () => {});
  const discovery = new ModelDiscovery(anything<ModelDiscoveryDeps>({
    vscodeApi: { window, ProgressLocation: { Notification: 15 } },
    config,
    secretStore,
    onApiKeySaved,
  }));
  vi.spyOn(discovery, 'refresh').mockResolvedValue();
  return { discovery, window, config, secretStore, onApiKeySaved };
}

afterEach(() => {
  validateApiKey.mockReset();
  resetInstalledPlanner();
});

describe('the key wizard', () => {
  // Bug: every OpenAI-style key was checked at the provider's public host, so a gateway's key was refused and never saved.
  it('checks a key at the endpoint the provider is configured with', async () => {
    validateApiKey.mockResolvedValue({ status: 'valid' });
    const h = harness({ inputs: ['sk-gw'], baseUrls: { openai: 'https://gateway.example/v1' } });

    await h.discovery.runApiKeyWizard('openai');

    expect(validateApiKey).toHaveBeenCalledWith('openai', 'sk-gw', { baseUrl: 'https://gateway.example/v1' });
    expect(h.secretStore.set).toHaveBeenCalledWith('openaiKey', 'sk-gw');
    expect(h.window.showInformationMessage).toHaveBeenCalledWith('API key configured for OpenAI.');
  });

  // Bug: Perplexity has no model list to check a key against, so every key read as invalid and the wizard asked again until Escape.
  it('saves a key it has no way to check, and says it was not checked', async () => {
    validateApiKey.mockResolvedValue({ status: 'unchecked' });
    const h = harness({ inputs: ['pplx-1'] });

    await h.discovery.runApiKeyWizard('perplexity');

    expect(h.window.showInputBox).toHaveBeenCalledTimes(1);
    expect(h.secretStore.set).toHaveBeenCalledWith('perplexityKey', 'pplx-1');
    expect(h.window.showWarningMessage).toHaveBeenCalledWith('Perplexity lists no models to check a key against: saved the key without checking it.');
  });

  // Bug: Custom's key was stored alone, and Custom is configured by its endpoint, so no Custom planner or runner appeared.
  it('asks Custom for its endpoint first, checks the key there, and saves both', async () => {
    validateApiKey.mockResolvedValue({ status: 'valid' });
    const h = harness({ inputs: ['http://localhost:8000/v1', 'sk-local'], customUrl: 'http://localhost:11434/v1' });

    await h.discovery.runApiKeyWizard('openai_compatible');

    const endpointBox = h.window.showInputBox.mock.calls[0] as unknown as [{ value?: string; validateInput: (value: string) => string | undefined }];
    expect(endpointBox[0].value).toBe('http://localhost:11434/v1');
    expect(endpointBox[0].validateInput('localhost:8000')).toBe('Enter the endpoint URL, starting with http:// or https://.');
    expect(endpointBox[0].validateInput('http://localhost:8000/v1')).toBeUndefined();
    expect(validateApiKey).toHaveBeenCalledWith('openai_compatible', 'sk-local', { baseUrl: 'http://localhost:8000/v1' });
    expect(h.config.update).toHaveBeenCalledWith('openaiCompatibleBaseUrl', 'http://localhost:8000/v1');
    expect(h.secretStore.set).toHaveBeenCalledWith('openaiCompatibleKey', 'sk-local');
    expect(h.onApiKeySaved).toHaveBeenCalled();
    expect(h.window.showInformationMessage).toHaveBeenCalledWith('Endpoint and API key configured for Custom.');
  });

  it('saves Custom\'s endpoint alone when it takes no key', async () => {
    validateApiKey.mockResolvedValue({ status: 'valid' });
    const h = harness({ inputs: ['http://localhost:11434/v1', ''] });

    await h.discovery.runApiKeyWizard('openai_compatible');

    expect(validateApiKey).toHaveBeenCalledWith('openai_compatible', '', { baseUrl: 'http://localhost:11434/v1' });
    expect(h.config.update).toHaveBeenCalledWith('openaiCompatibleBaseUrl', 'http://localhost:11434/v1');
    expect(h.secretStore.set).not.toHaveBeenCalled();
    expect(h.window.showInformationMessage).toHaveBeenCalledWith('Endpoint configured for Custom.');
  });

  it('saves nothing of Custom when the key step is cancelled', async () => {
    const h = harness({ inputs: ['http://localhost:11434/v1', undefined] });

    await h.discovery.runApiKeyWizard('openai_compatible');

    expect(validateApiKey).not.toHaveBeenCalled();
    expect(h.config.update).not.toHaveBeenCalled();
    expect(h.secretStore.set).not.toHaveBeenCalled();
  });
});

describe('the empty-catalog warning', () => {
  function discoveryOver(empty: string[]) {
    const registry = new RunnerRegistry();
    const showWarningMessage = vi.fn();
    const models: DiscoveredModel[] = [{ modelId: 'm', modelLabel: 'M', variants: [] }];
    const discovery = new ModelDiscovery(anything<ModelDiscoveryDeps>({
      vscodeApi: { window: { showWarningMessage } },
      codexSandbox: undefined,
      config: anything({ enabledRunners: [], configuredProviders: [], orchestratorModel: '', rawOrchestratorModel: '', aiProvider: 'claude-code' }),
      runnerRegistry: registry,
      runnerInstallation: anything({
        plannerUsability: async () => ({ usable: false }),
        filterInstalled: async () => ['claude-code', 'codex', 'openrouter'],
      }),
      modelResolver: anything({
        modelsForRunners: async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, empty.includes(r) ? [] : models])),
        pickerOptions: async () => [],
        refresh: async () => {},
        getDiscoveryErrors: () => ({}),
        getRunnerDiscoveryErrors: () => ({}),
        getCachedPickerOptions: () => [],
      }),
      chatProvider: anything(),
      modelAllowlist: () => ({}),
      refreshPlannerState: async () => {},
    }));
    return { discovery, showWarningMessage };
  }

  // Bug: a provider runner whose catalog came back empty was told its CLI might be cold, and to rebuild core.
  it('words an empty provider runner catalog as a key or endpoint failure, not a cold CLI', async () => {
    const { discovery, showWarningMessage } = discoveryOver(['openrouter']);

    await discovery.refresh();

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [said] = showWarningMessage.mock.calls[0] as [string];
    expect(said).toContain('Ordewell could not list the models of the built-in runner on OpenRouter: check the API key and base URL.');
    expect(said).not.toContain('CLI');
    expect(said).not.toContain('build:core');
  });

  it('keeps the cold-CLI wording for a coding agent', async () => {
    const { discovery, showWarningMessage } = discoveryOver(['codex']);

    await discovery.refresh();

    const [said] = showWarningMessage.mock.calls[0] as [string];
    expect(said).toContain('Ordewell discovered no models for installed runner: codex.');
    expect(said).toContain('The CLI may be cold');
    expect(said).not.toContain('built-in runner');
  });
});

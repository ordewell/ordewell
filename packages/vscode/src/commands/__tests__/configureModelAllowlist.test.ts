import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureModelAllowlist } from '../configureModelAllowlist';
import { RunnerRegistry, ModelResolver, SettingsService } from '@ordewell/core';

describe('configureModelAllowlist', () => {
  let registry: RunnerRegistry;
  let modelResolver: ModelResolver;
  let settingsService: SettingsService;
  let mockWin: {
    showQuickPick: ReturnType<typeof vi.fn>;
    withProgress: ReturnType<typeof vi.fn>;
    showWarningMessage: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    registry = new RunnerRegistry();
    modelResolver = { modelsForRunners: vi.fn() } as unknown as ModelResolver;
    settingsService = {
      getModelAllowlist: vi.fn(),
      setModelAllowlist: vi.fn(),
    } as unknown as SettingsService;
    mockWin = {
      showQuickPick: vi.fn(),
      withProgress: vi.fn(),
      showWarningMessage: vi.fn(),
    };
  });

  it('shows a QuickPick with all runners from the registry', async () => {
    mockWin.showQuickPick.mockResolvedValue(undefined);

    await configureModelAllowlist(registry, modelResolver, settingsService, mockWin);

    expect(mockWin.showQuickPick).toHaveBeenCalledTimes(1);
    const [items, options] = mockWin.showQuickPick.mock.calls[0];
    expect(items).toHaveLength(registry.list().length);
    expect(items[0].label).toBe(registry.list()[0].manifest.displayName);
    expect(items[0].runner).toBe(registry.list()[0].manifest.name);
    expect(items[0].description).toBe(registry.list()[0].manifest.name);
    expect(options.placeHolder).toContain('runner');
  });

  it('shows progress notification while discovering models for the picked runner', async () => {
    const runnerName = registry.list()[0].manifest.name;
    const runnerDisplay = registry.list()[0].manifest.displayName;
    mockWin.showQuickPick.mockResolvedValue({ runner: runnerName, displayName: runnerDisplay });
    mockWin.withProgress.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    (modelResolver.modelsForRunners as import('vitest').Mock).mockResolvedValue({});

    await configureModelAllowlist(registry, modelResolver, settingsService, mockWin);

    expect(mockWin.withProgress).toHaveBeenCalledTimes(1);
    const [progressOpts] = mockWin.withProgress.mock.calls[0];
    expect(progressOpts.title).toContain(runnerDisplay);
    expect(modelResolver.modelsForRunners).toHaveBeenCalledWith([runnerName]);
  });

  it('when discovery returns empty list, shows warning and does not show multi-select', async () => {
    const runnerName = registry.list()[0].manifest.name;
    const runnerDisplay = registry.list()[0].manifest.displayName;
    mockWin.showQuickPick.mockResolvedValue({ runner: runnerName, displayName: runnerDisplay });
    mockWin.withProgress.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    (modelResolver.modelsForRunners as import('vitest').Mock).mockResolvedValue({ [runnerName]: [] });

    await configureModelAllowlist(registry, modelResolver, settingsService, mockWin);

    expect(mockWin.showWarningMessage).toHaveBeenCalledWith(
      `No models discovered for ${runnerDisplay}. Is it installed and configured?`,
    );
    expect(mockWin.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it('when discovery returns models, shows multi-select with pre-checked items from current allowlist', async () => {
    const runnerName = registry.list()[0].manifest.name;
    const runnerDisplay = registry.list()[0].manifest.displayName;
    const discoveredModels = [
      { modelId: 'model-a', modelLabel: 'Model A', variants: [] },
      { modelId: 'model-b', modelLabel: 'Model B', variants: [] },
    ];
    const allowlist = ['model-a'];

    mockWin.showQuickPick
      .mockResolvedValueOnce({ runner: runnerName, displayName: runnerDisplay })
      .mockResolvedValueOnce(undefined);
    mockWin.withProgress.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    (modelResolver.modelsForRunners as import('vitest').Mock).mockResolvedValue({ [runnerName]: discoveredModels });
    (settingsService.getModelAllowlist as import('vitest').Mock).mockReturnValue(allowlist);

    await configureModelAllowlist(registry, modelResolver, settingsService, mockWin);

    expect(mockWin.showQuickPick).toHaveBeenCalledTimes(2);
    const [modelItems, modelOpts] = mockWin.showQuickPick.mock.calls[1];
    expect(modelOpts.canPickMany).toBe(true);
    expect(modelOpts.placeHolder).toContain(runnerDisplay);
    expect(modelItems).toHaveLength(3);
    expect(modelItems[0].kind).toBe(1);
    expect(modelItems[1].label).toBe('Model A');
    expect(modelItems[1].description).toBe('model-a');
    expect(modelItems[1].picked).toBe(true);
    expect(modelItems[2].label).toBe('Model B');
    expect(modelItems[2].description).toBe('model-b');
    expect(modelItems[2].picked).toBe(false);
    expect(mockWin.showWarningMessage).not.toHaveBeenCalled();
  });

  it('on accept, saves selected model IDs via settingsService', async () => {
    const runnerName = registry.list()[0].manifest.name;
    const runnerDisplay = registry.list()[0].manifest.displayName;
    const discoveredModels = [
      { modelId: 'model-a', modelLabel: 'Model A', variants: [] },
      { modelId: 'model-b', modelLabel: 'Model B', variants: [] },
    ];
    const selected = [{ modelId: 'model-a' }, { modelId: 'model-b' }];

    mockWin.showQuickPick
      .mockResolvedValueOnce({ runner: runnerName, displayName: runnerDisplay })
      .mockResolvedValueOnce(selected);
    mockWin.withProgress.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    (modelResolver.modelsForRunners as import('vitest').Mock).mockResolvedValue({ [runnerName]: discoveredModels });

    await configureModelAllowlist(registry, modelResolver, settingsService, mockWin);

    expect(settingsService.setModelAllowlist).toHaveBeenCalledWith(runnerName, ['model-a', 'model-b']);
  });

  it('on accept with empty selection, saves empty array', async () => {
    const runnerName = registry.list()[0].manifest.name;
    const runnerDisplay = registry.list()[0].manifest.displayName;
    const discoveredModels = [
      { modelId: 'model-a', modelLabel: 'Model A', variants: [] },
    ];

    mockWin.showQuickPick
      .mockResolvedValueOnce({ runner: runnerName, displayName: runnerDisplay })
      .mockResolvedValueOnce([]);
    mockWin.withProgress.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    (modelResolver.modelsForRunners as import('vitest').Mock).mockResolvedValue({ [runnerName]: discoveredModels });

    await configureModelAllowlist(registry, modelResolver, settingsService, mockWin);

    expect(settingsService.setModelAllowlist).toHaveBeenCalledWith(runnerName, []);
  });

  it('when user cancels multi-select, does not change settings', async () => {
    const runnerName = registry.list()[0].manifest.name;
    const runnerDisplay = registry.list()[0].manifest.displayName;
    const discoveredModels = [
      { modelId: 'model-a', modelLabel: 'Model A', variants: [] },
    ];

    mockWin.showQuickPick
      .mockResolvedValueOnce({ runner: runnerName, displayName: runnerDisplay })
      .mockResolvedValueOnce(undefined);
    mockWin.withProgress.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    (modelResolver.modelsForRunners as import('vitest').Mock).mockResolvedValue({ [runnerName]: discoveredModels });

    await configureModelAllowlist(registry, modelResolver, settingsService, mockWin);

    expect(settingsService.setModelAllowlist).not.toHaveBeenCalled();
  });
});

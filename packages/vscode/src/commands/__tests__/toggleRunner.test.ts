import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { detectInstalledPlanner, resetInstalledPlanner, RunnerRegistry, type RunnerInstallation } from '@ordewell/core';
import { registerCommands, type CommandDeps } from '../CommandRegistry';
import { setRunnerEnabled, type EnableRunnerDeps } from '../enabledRunners';

const registerCommand = vscode.commands.registerCommand as unknown as ReturnType<typeof vi.fn>;

/** The command, registered over a settings service that applies the change to a saved list the test holds. */
function toggleOver(saved: string[] | undefined, defaults: string[]) {
  registerCommand.mockClear();
  const settingsService = {
    updateEnabledRunners: vi.fn((change: (saved: string[] | undefined) => string[]) => change(saved)),
  };
  const config = { enabledRunners: defaults, update: vi.fn() };
  const sendRunnerAndModels = vi.fn(async () => {});
  registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, { settingsService, config, sendRunnerAndModels } as unknown as CommandDeps);
  const toggle = registerCommand.mock.calls.find(([id]) => id === 'ordewell.toggleRunner')![1] as (runner?: string) => Promise<void>;
  return { toggle, settingsService, config, sendRunnerAndModels };
}

describe('ordewell.toggleRunner', () => {
  afterEach(() => resetInstalledPlanner());

  it('saves the enabled runners in the settings file every surface shares, not in a VS Code setting', async () => {
    const { toggle, settingsService, config, sendRunnerAndModels } = toggleOver(['claude-code'], ['claude-code']);

    await toggle('codex');

    expect(settingsService.updateEnabledRunners).toHaveBeenCalledTimes(1);
    expect(settingsService.updateEnabledRunners.mock.results[0]!.value).toEqual(['claude-code', 'codex']);
    expect(config.update).not.toHaveBeenCalled();
    expect(sendRunnerAndModels).toHaveBeenCalled();
  });

  // An empty saved list leaves every surface with no runner to assign, as the chat header's switch knows.
  it('keeps the last enabled runner on, and says why', async () => {
    const showInformationMessage = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    showInformationMessage.mockClear();
    const { toggle, settingsService } = toggleOver(['codex'], ['claude-code']);

    await toggle('codex');

    expect(settingsService.updateEnabledRunners.mock.results[0]!.value).toEqual(['codex']);
    expect(showInformationMessage).toHaveBeenCalledWith('codex is the only enabled runner, so it stays on: enable another runner first.');
  });

  it('starts from the defaults only while the file holds no choice', async () => {
    const { toggle, settingsService } = toggleOver(undefined, ['codex', 'opencode']);

    await toggle('codex');

    expect(settingsService.updateEnabledRunners.mock.results[0]!.value).toEqual(['opencode']);
  });

  // Bug: it offered every coding agent, installed or not, and missed a provider runner whose key only the workspace env held.
  it('offers exactly the runners the chat\'s pills offer: what the install check lists', async () => {
    registerCommand.mockClear();
    const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
    showQuickPick.mockReset();
    showQuickPick.mockResolvedValue(undefined);
    const config = { enabledRunners: ['claude-code', 'openrouter'] };
    const runnerRegistry = new RunnerRegistry();
    const filterInstalled = vi.fn(async () => ['claude-code', 'codex', 'openrouter']);
    registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      settingsService: { updateEnabledRunners: vi.fn() }, config, sendRunnerAndModels: vi.fn(), runnerRegistry, runnerInstallation: { filterInstalled },
    } as unknown as CommandDeps);
    const toggle = registerCommand.mock.calls.find(([id]) => id === 'ordewell.toggleRunner')![1] as (runner?: string) => Promise<void>;

    await toggle();

    expect(filterInstalled).toHaveBeenCalledWith(runnerRegistry.list().map((entry) => entry.manifest.name));
    const labels = (showQuickPick.mock.calls[0]![0] as { label: string }[]).map((item) => item.label);
    expect(labels).toEqual(['Claude Code: ON', 'Codex: OFF', 'OpenRouter: ON']);
  });

  it('waits for the installed-planner probe before pinning defaults', async () => {
    let answer!: (usable: boolean) => void;
    const probe = new Promise<{ usable: boolean }>((resolve) => { answer = (usable) => resolve({ usable }); });
    void detectInstalledPlanner({ plannerUsability: () => probe } as unknown as Pick<RunnerInstallation, 'plannerUsability'>);
    const { toggle, settingsService } = toggleOver(undefined, ['claude-code']);

    const toggled = toggle('codex');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settingsService.updateEnabledRunners).not.toHaveBeenCalled();

    answer(false);
    await toggled;
    expect(settingsService.updateEnabledRunners).toHaveBeenCalledTimes(1);
  });
});

/** The host's enable path over a settings service that applies the change to a list the test holds. */
function enableOver(saved: string[] | undefined, defaults: string[]) {
  const settingsService = {
    updateEnabledRunners: vi.fn((change: (saved: string[] | undefined) => string[]) => change(saved)),
  };
  const sendRunnerAndModels = vi.fn(async () => {});
  const deps: EnableRunnerDeps = {
    runnerRegistry: new RunnerRegistry(),
    settingsService,
    config: { enabledRunners: defaults },
    sendRunnerAndModels,
  };
  return {
    enable: (runnerId: string) => setRunnerEnabled(deps, runnerId, true),
    disable: (runnerId: string) => setRunnerEnabled(deps, runnerId, false),
    settingsService,
    sendRunnerAndModels,
  };
}

describe('enabling an installed runner from the chat header', () => {
  afterEach(() => resetInstalledPlanner());

  it('adds it to the saved enabled runners and re-sends the list', async () => {
    const { enable, settingsService, sendRunnerAndModels } = enableOver(['claude-code'], ['claude-code']);

    const saved = await enable('codex');

    expect(saved).toEqual(['claude-code', 'codex']);
    expect(settingsService.updateEnabledRunners.mock.results[0]!.value).toEqual(['claude-code', 'codex']);
    expect(sendRunnerAndModels).toHaveBeenCalled();
  });

  it('never turns one off: a repeated or stale click leaves the saved list as it is', async () => {
    const { enable, settingsService } = enableOver(['claude-code', 'codex'], ['claude-code']);

    const saved = await enable('codex');

    expect(saved).toEqual(['claude-code', 'codex']);
    expect(settingsService.updateEnabledRunners.mock.results[0]!.value).toEqual(['claude-code', 'codex']);
  });

  it('refuses an id no manifest names, saving and sending nothing', async () => {
    const { enable, settingsService, sendRunnerAndModels } = enableOver(['claude-code'], ['claude-code']);

    const saved = await enable('no-such-agent');

    expect(saved).toBeNull();
    expect(settingsService.updateEnabledRunners).not.toHaveBeenCalled();
    expect(sendRunnerAndModels).not.toHaveBeenCalled();
  });
});

describe('switching a runner off from the chat header', () => {
  afterEach(() => resetInstalledPlanner());

  it('takes it out of the saved enabled runners', async () => {
    const { disable } = enableOver(['claude-code', 'codex', 'opencode'], ['claude-code']);

    expect(await disable('codex')).toEqual(['claude-code', 'opencode']);
  });

  it('never turns one on: a repeated or stale click leaves the saved list as it is', async () => {
    const { disable } = enableOver(['claude-code', 'opencode'], ['claude-code']);

    expect(await disable('codex')).toEqual(['claude-code', 'opencode']);
  });

  it('keeps the last runner the saved list holds, whatever the clicker thought it held', async () => {
    const { disable } = enableOver(['opencode'], ['claude-code', 'opencode']);

    expect(await disable('opencode')).toEqual(['opencode']);
  });

  it('refuses an id no manifest names, saving and sending nothing', async () => {
    const { disable, settingsService, sendRunnerAndModels } = enableOver(['claude-code'], ['claude-code']);

    expect(await disable('no-such-agent')).toBeNull();
    expect(settingsService.updateEnabledRunners).not.toHaveBeenCalled();
    expect(sendRunnerAndModels).not.toHaveBeenCalled();
  });
});

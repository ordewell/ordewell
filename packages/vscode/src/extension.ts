import * as vscode from 'vscode';
import { spawn as nodeSpawn } from 'child_process';
import { createIsolationPreview, AccountLimitMonitor, claudeAccountLimitCollector, codexAccountLimitCollector, openCodeGoAccountLimitCollector, createSession, CodexSandboxAvailability, RunnerRegistry, removedPluginNotice, ModelResolver, RunnerInstallation, SettingsService, PlannerModelMemory, StructuredRunner, runnerForProvider, processLeaseHost, setHostCredentials, workspaceEnvOf } from '@ordewell/core';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { VsCodeConfig, moveAutonomyFromVsCodeSetting, moveEnabledRunnersFromVsCodeSetting } from './adapters/VsCodeConfig';
import { VsCodeFileSystem } from './adapters/VsCodeFileSystem';
import { SecretStore } from './adapters/SecretStore';
import { VsCodeNotification } from './adapters/VsCodeNotification';
import { startExtensionVersionCheck } from './versionCheck';
import { revealOnFirstActivation } from './firstRun';

const UPDATE_POPUP_KEY = 'ordewell.updatePopupShownAt';
import { createExtension, type ExtensionHost } from './ExtensionHost';

let activeHost: ExtensionHost | undefined;
let versionCheck: { dispose(): void } | undefined;

function logTo(outputChannel: vscode.OutputChannel, msg: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  console.log(`[Ordewell] ${msg}`);
}

/**
 * The composition root for real: build every adapter and service, then hand
 * them to the host, which owns the wiring and the lifecycle.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Ordewell');
  logTo(outputChannel, 'Ordewell extension activating...');
  const pluginNotice = removedPluginNotice();
  if (pluginNotice) logTo(outputChannel, pluginNotice);

  try {
    // What another host's refusal names this window as (ADR-0049).
    processLeaseHost().describe({ kind: 'vscode' });
    const secretStore = new SecretStore(context.secrets);
    await secretStore.load();
    // Bound once the resolver exists, which is itself built from this config.
    // eslint-disable-next-line prefer-const
    let modelResolver: ModelResolver | undefined;
    const config = new VsCodeConfig(secretStore, (provider) => {
      const runner = runnerForProvider(provider);
      return runner && modelResolver ? modelResolver.getCachedRunnerModels(runner).map((model) => model.modelId) : [];
    });
    // The keys stay out of this process's environment, which every child and
    // every other extension here inherits: the built-in runner is lent them (ADR-0070).
    setHostCredentials(() => config.heldProviderEnv());
    const runnerRegistry = new RunnerRegistry();
    const fsAdapter = new VsCodeFileSystem();
    // Read from the account the runners use, as the login probe below is: a
    // workspace's CLAUDE_CONFIG_DIR moves Claude's picker lineup with it.
    modelResolver = new ModelResolver(runnerRegistry, config, {
      env: async () => ({ ...process.env, ...(await workspaceEnvOf(fsAdapter.getWorkspaceRoot())) }),
    });
    const settingsService = new SettingsService();
    await moveAutonomyFromVsCodeSetting(settingsService);
    await moveEnabledRunnersFromVsCodeSetting(settingsService);

    // The login probe must ask the same account the planner will use, so it
    // reads the workspace's .envrc/.ordewell/env exactly as a spawn does (ADR-0016).
    const runnerInstallation = new RunnerInstallation(runnerRegistry, undefined, undefined, {
      env: (workspace) => workspaceEnvOf(workspace ?? fsAdapter.getWorkspaceRoot()),
      // The extension's session gates on this workspace's account, so the
      // verdict is recorded under it (ADR-0009).
      workspace: () => fsAdapter.getWorkspaceRoot(),
    });
    const codexServer = runnerRegistry.getManifest('codex')?.modelDiscovery.appServer;

    activeHost = createExtension({
      context,
      outputChannel,
      secretStore,
      config,
      runnerRegistry,
      runnerInstallation,
      codexSandbox: new CodexSandboxAvailability(
        runnerRegistry,
        { spawn: nodeSpawn, fetch: globalThis.fetch },
        { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(), env: process.env },
      ),
      fsAdapter,
      notifications: new VsCodeNotification(),
      // Tasks run on the structured transport (ADR-0018) as plain child processes.
      runner: new StructuredRunner(),
      settingsService,
      plannerModelMemory: new PlannerModelMemory(settingsService),
      modelResolver,
      chatProvider: new ChatViewProvider(context.extensionUri),
      isolationPreview: createIsolationPreview({ config }),
      sessionFactory: createSession,
      // Codex's account is read over the same app-server its model discovery
      // uses (ADR-0004); Claude Code's on a control-only process of its own;
      // OpenCode Go's from OpenCode's selected login, with no process at all
      // (ADR-0051). All under the planner's workspace, whose environment picks
      // the account.
      accountLimits: new AccountLimitMonitor({
        collectors: [
          claudeAccountLimitCollector({
            isInstalled: () => runnerInstallation.isInstalled('claude-code'),
            workspaceRoot: () => fsAdapter.getWorkspaceRoot(),
          }),
          codexAccountLimitCollector({
            command: codexServer?.command,
            args: codexServer?.args,
            isInstalled: () => runnerInstallation.isInstalled('codex'),
            workspaceRoot: () => fsAdapter.getWorkspaceRoot(),
          }),
          openCodeGoAccountLimitCollector({
            isInstalled: () => runnerInstallation.isInstalled('opencode'),
            workspaceRoot: () => fsAdapter.getWorkspaceRoot(),
          }),
        ],
      }),
    }, vscode);

    await activeHost.start();
    void revealOnFirstActivation(vscode.commands, context.globalState);
    // After start, and not awaited: the check reads one small file and never
    // waits on the network, so it cannot hold the extension back.
    versionCheck = startExtensionVersionCheck(vscode, String(context.extension?.packageJSON?.version ?? 'unknown'), {
      extensionId: context.extension?.id,
      // globalState is one for every window, so the popup comes once a day, not once a window.
      popupStore: {
        get: () => context.globalState.get<number>(UPDATE_POPUP_KEY),
        set: (at) => { void context.globalState.update(UPDATE_POPUP_KEY, at); },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logTo(outputChannel, `ACTIVATION ERROR: ${message}`);
    vscode.window.showErrorMessage(`Ordewell failed to activate: ${message}`);
  }
}

export function deactivate(): void {
  versionCheck?.dispose();
  versionCheck = undefined;
  activeHost?.dispose();
  setHostCredentials(undefined);
}

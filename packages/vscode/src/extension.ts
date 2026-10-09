import * as vscode from 'vscode';
import { createSession, RunnerRegistry, ModelResolver, RunnerInstallation, SettingsService, PlannerModelMemory, StructuredRunner } from '@ordewell/core';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { VsCodeConfig } from './adapters/VsCodeConfig';
import { VsCodeFileSystem } from './adapters/VsCodeFileSystem';
import { SecretStore } from './adapters/SecretStore';
import { VsCodeNotification } from './adapters/VsCodeNotification';
import { createExtension, type ExtensionHost } from './ExtensionHost';

let activeHost: ExtensionHost | undefined;

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

  try {
    const secretStore = new SecretStore(context.secrets);
    await secretStore.load();
    const config = new VsCodeConfig(secretStore);
    const pluginRegistry = new RunnerRegistry();
    pluginRegistry.loadUserPlugins();
    const settingsService = new SettingsService();

    activeHost = createExtension({
      context,
      outputChannel,
      secretStore,
      config,
      pluginRegistry,
      runnerInstallation: new RunnerInstallation(pluginRegistry),
      fsAdapter: new VsCodeFileSystem(),
      notifications: new VsCodeNotification(),
      // Tasks run on the structured transport (ADR-0018) as plain child processes.
      terminalRunner: new StructuredRunner(),
      settingsService,
      plannerModelMemory: new PlannerModelMemory(settingsService),
      modelResolver: new ModelResolver(pluginRegistry, config),
      chatProvider: new ChatViewProvider(context.extensionUri),
      sessionFactory: createSession,
    }, vscode);

    await activeHost.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logTo(outputChannel, `ACTIVATION ERROR: ${message}`);
    vscode.window.showErrorMessage(`Ordewell failed to activate: ${message}`);
  }
}

export function deactivate(): void {
  activeHost?.dispose();
}

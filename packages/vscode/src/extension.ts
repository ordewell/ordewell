import * as vscode from 'vscode';
import { createSession, RunnerRegistry, removedPluginNotice, ModelResolver, RunnerInstallation, SettingsService, PlannerModelMemory, StructuredRunner, TransportRouter } from '@ordewell/core';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { VsCodeConfig } from './adapters/VsCodeConfig';
import { VsCodeFileSystem } from './adapters/VsCodeFileSystem';
import { SecretStore } from './adapters/SecretStore';
import { VsCodeNotification } from './adapters/VsCodeNotification';
import { VsCodeTerminalRunner } from './adapters/VsCodeTerminalRunner';
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
  const pluginNotice = removedPluginNotice();
  if (pluginNotice) logTo(outputChannel, pluginNotice);

  try {
    const secretStore = new SecretStore(context.secrets);
    await secretStore.load();
    const config = new VsCodeConfig(secretStore);
    const runnerRegistry = new RunnerRegistry();
    const settingsService = new SettingsService();

    activeHost = createExtension({
      context,
      outputChannel,
      secretStore,
      config,
      runnerRegistry,
      runnerInstallation: new RunnerInstallation(runnerRegistry),
      fsAdapter: new VsCodeFileSystem(),
      notifications: new VsCodeNotification(),
      // A plan on the structured transport (ADR-0018) runs its Claude Code
      // tasks as plain child processes; every other task keeps its terminal.
      terminalRunner: new TransportRouter({ terminal: new VsCodeTerminalRunner(), structured: new StructuredRunner() }),
      settingsService,
      plannerModelMemory: new PlannerModelMemory(settingsService),
      modelResolver: new ModelResolver(runnerRegistry, config),
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

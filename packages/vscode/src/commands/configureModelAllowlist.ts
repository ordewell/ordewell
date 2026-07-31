import * as vscode from 'vscode';
import type { RunnerRegistry, ModelResolver, SettingsService, DiscoveredModel } from '@ordewell/core';

// Show the provider exactly as the runner CLI lists it (the prefix before
// the first `/`) — no renaming, no title-casing.
function providerLabel(key: string | undefined, reported?: string): string {
  return reported || key || 'Unknown';
}

function groupModels(models: DiscoveredModel[]): Map<string, DiscoveredModel[]> {
  const grouped = new Map<string, DiscoveredModel[]>();
  for (const m of models) {
    const provider = m.runnerProvider || (m.modelId.includes('/') ? m.modelId.split('/')[0] : 'Other');
    if (!grouped.has(provider)) grouped.set(provider, []);
    grouped.get(provider)!.push(m);
  }
  return grouped;
}

export async function configureModelAllowlist(
  pluginRegistry: RunnerRegistry,
  modelResolver: ModelResolver,
  settingsService: SettingsService,
  win: Pick<typeof vscode.window, 'showQuickPick' | 'withProgress' | 'showWarningMessage'> = vscode.window,
): Promise<void> {
  const runners = pluginRegistry.list();
  const runnerItems = runners.map((r) => ({
    label: r.manifest.displayName,
    description: r.manifest.name,
    runner: r.manifest.name,
    displayName: r.manifest.displayName,
  }));
  const picked = await win.showQuickPick(runnerItems, { placeHolder: 'Select a runner to configure model allowlist' });
  if (!picked) return;

  const runnerDisplay = picked.displayName;
  const runnerName = picked.runner;
  const byRunner = await win.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Discovering models for ${runnerDisplay}…` },
    () => {
      // Always re-discover when the picker opens: a cached list from a cold
      // activation-time discovery may be degraded (runner CLI not warm yet),
      // and this is exactly the moment the user needs the real list.
      modelResolver.refreshRunnerModels?.();
      return modelResolver.modelsForRunners([runnerName]);
    },
  );
  const discovered = byRunner?.[runnerName] || [];

  if (discovered.length === 0) {
    await win.showWarningMessage(
      `No models discovered for ${runnerDisplay}. Is it installed and configured?`,
    );
    return;
  }

  const currentAllowlist = settingsService.getModelAllowlist(runnerName) || [];
  const grouped = groupModels(discovered);

  const items: (vscode.QuickPickItem & { modelId?: string })[] = [];
  for (const [provider, providerModels] of grouped) {
    const first = providerModels[0];
    const header = providerLabel(provider, first?.runnerProviderLabel);
    items.push({
      label: header,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const m of providerModels) {
      items.push({
        label: m.modelLabel,
        description: m.modelId,
        detail: header,
        picked: currentAllowlist.includes(m.modelId),
        modelId: m.modelId,
      });
    }
  }

  const selected = await win.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `Select models to allow for ${runnerDisplay}`,
  });
  if (!selected) return;

  settingsService.setModelAllowlist(runnerName, selected.map((s) => (s as typeof items[0]).modelId!));
}

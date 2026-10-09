import type * as vscode from 'vscode';
import {
  getProviderMeta, ModelResolver, PROVIDER_LABEL, PROVIDER_PRIORITY, PROVIDER_SHORT_LABEL,
  type AiProvider, type DiscoveredModel, type RunnerInstallation, type RunnerRegistry,
} from '@ordewell/core';
import type { ChatViewProvider } from './providers/ChatViewProvider';
import type { VsCodeConfig } from './adapters/VsCodeConfig';
import { SecretStore, type ApiProvider, type SecretKey } from './adapters/SecretStore';

export interface ModelDiscoveryDeps {
  vscodeApi: typeof vscode;
  config: VsCodeConfig;
  runnerRegistry: RunnerRegistry;
  runnerInstallation: RunnerInstallation;
  modelResolver: ModelResolver;
  chatProvider: ChatViewProvider;
  secretStore: SecretStore;
  log: (msg: string) => void;
  /** Re-push who-plans state after discovery, so the planner pills match the fresh catalog. */
  refreshPlannerState: () => Promise<void>;
  /** Reset the AI service and every resolver cache once a key is saved, before re-discovery. */
  onApiKeySaved: () => Promise<void>;
}

export type PickerOption = { id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string };
type ExtraPick = { label: string; detail?: string; modelId: string };

// Throttle the degraded-discovery toast so a repeated refresh (each ready
// message, each runner toggle) can't spam it. One warning per ~2 minutes.
const DEGRADED_WARN_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * Keeps the webview's runner and model state current: one shared discovery run
 * for concurrent refreshes, the two throttled degradation warnings, the model
 * options the pickers read, and the API-key wizard that feeds discovery.
 */
export class ModelDiscovery {
  private refreshInFlight: Promise<void> | null = null;
  private lastDegradedWarnAt = 0;
  // Keyed separately from the runner-discovery warning so neither throttles
  // the other.
  private lastProviderErrorWarnAt = 0;

  constructor(private readonly deps: ModelDiscoveryDeps) {}

  /** Re-discover runner models and push them to the webview. Concurrent calls share one discovery run. */
  refresh(): Promise<void> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.push().finally(() => { this.refreshInFlight = null; });
    }
    return this.refreshInFlight;
  }

  private async push(): Promise<void> {
    const d = this.deps;
    d.modelResolver.refreshRunnerModels();
    const enabled = d.config.enabledRunners;
    // Resolve installed runners up front so a discovery that returns nothing for
    // an *installed* runner can be surfaced as a real failure (see below).
    const allRunners = d.runnerRegistry.list();
    const installedIds = new Set(
      await d.runnerInstallation.filterInstalled(allRunners.map((p) => p.manifest.name)),
    );

    // Discovery must cover every runner the UI lets the user pick for a task or
    // as planner — the per-task runner dropdown and the planner backend pills
    // both offer every *installed* runner, not just the "enabled" (auto-assign)
    // subset. Scoping discovery to `enabled` alone left an installed-but-not-
    // enabled runner's catalog empty, and the model picker's degraded-runner
    // fallback then silently substituted another runner's models —
    // indistinguishable from that runner's own catalog to the user.
    const discoverable = [...new Set([...enabled, ...installedIds])];

    const allModels: DiscoveredModel[] = [];
    const byRunner = await d.modelResolver.modelsForRunners(discoverable);
    const degraded: string[] = [];
    for (const r of discoverable) {
      const models = byRunner[r] ?? [];
      for (const m of models) {
        if (!allModels.find((x) => x.modelId === m.modelId)) allModels.push(m);
      }
      // Provider breakdown in the output channel — a shrunken list here (e.g.
      // only the runner's free tier) means the runner CLI couldn't see its own
      // auth/config from this process, not a Ordewell-side filter.
      const byProvider: Record<string, number> = {};
      for (const m of models) {
        const p = m.runnerProvider ?? m.modelId.split('/')[0];
        byProvider[p] = (byProvider[p] ?? 0) + 1;
      }
      d.log(`Model discovery [${r}]: ${models.length} models (${Object.entries(byProvider).map(([p, n]) => `${p}: ${n}`).join(', ') || 'none'})`);
      // An installed runner that discovers zero models means discovery degraded
      // (cold CLI timeout, or a stale `@ordewell/core` build the extension
      // requires at runtime) — NOT an empty catalog. Left silent, the model
      // picker just looks short. Surface it so the user knows to retry/rebuild.
      if (models.length === 0 && installedIds.has(r)) degraded.push(r);
    }
    d.chatProvider.setModels(allModels);
    d.chatProvider.setModelsByRunner(byRunner);
    this.warnDegradedDiscovery(degraded);

    const installedRunners = allRunners.filter((p) => installedIds.has(p.manifest.name));
    const runnerList = installedRunners.map((p) => ({
      id: p.manifest.name,
      displayName: p.manifest.displayName,
    }));
    d.chatProvider.setRunnerList(runnerList);
    d.chatProvider.setEnabledRunnerIds(enabled.filter((r) => installedIds.has(r)));

    const modesByRunner: Record<string, { id: string; label: string; description: string; cliValue?: string; autonomous?: boolean }[]> = {};
    for (const entry of installedRunners) {
      modesByRunner[entry.manifest.name] = (entry.manifest.modes ?? []).map((m) => ({
        id: m.id, label: m.label, description: m.description, cliValue: m.cliValue, autonomous: m.autonomous,
      }));
    }
    d.chatProvider.setModesByRunner(modesByRunner);
    d.chatProvider.sendConfiguredProviders(d.config.configuredProviders);
    this.sendModelConfig();
    void d.refreshPlannerState().catch((err) => d.log(`Planner state refresh failed: ${err}`));
    d.chatProvider.setModelOptions(ModelResolver.builtinOptions());

    this.options().then((opts) => {
      d.chatProvider.setModelOptions(opts);
      // Flag any configured provider whose catalog fetch failed — both in the
      // webview (persistent banner) and as a one-shot toast.
      const errors = d.modelResolver.getDiscoveryErrors();
      d.chatProvider.setModelDiscoveryErrors(errors);
      this.warnProviderDiscoveryErrors(errors);
    }).catch((err) => d.log(`Model options discovery error: ${err}`));
  }

  private warnDegradedDiscovery(degradedRunners: string[]): void {
    const { vscodeApi } = this.deps;
    if (degradedRunners.length === 0) return;
    if (Date.now() - this.lastDegradedWarnAt < DEGRADED_WARN_COOLDOWN_MS) return;
    this.lastDegradedWarnAt = Date.now();
    const names = degradedRunners.join(', ');
    vscodeApi.window.showWarningMessage(
      `Ordewell discovered no models for installed runner${degradedRunners.length > 1 ? 's' : ''}: ${names}. ` +
      `The CLI may be cold (try again in a moment) or the core build may be stale (run "npm run build:core"). ` +
      `The model picker will be incomplete until discovery succeeds.`,
    );
  }

  private warnProviderDiscoveryErrors(errors: Record<string, string>): void {
    const { vscodeApi } = this.deps;
    const failed = Object.keys(errors);
    if (failed.length === 0) return;
    if (Date.now() - this.lastProviderErrorWarnAt < DEGRADED_WARN_COOLDOWN_MS) return;
    this.lastProviderErrorWarnAt = Date.now();
    const detail = failed
      .map((p) => `${PROVIDER_SHORT_LABEL[p as ApiProvider] ?? p} (${errors[p]})`)
      .join('; ');
    vscodeApi.window.showWarningMessage(
      `Ordewell could not load the model catalog for ${failed.length > 1 ? 'these providers' : 'this provider'}: ${detail}. ` +
      `Check the API key and base URL. Their models are omitted from the picker.`,
    );
  }

  sendModelConfig(): void {
    sendModelConfig(this.deps.config, this.deps.chatProvider);
  }

  async options(): Promise<PickerOption[]> {
    const options = await this.deps.modelResolver.pickerOptions();
    await this.deps.modelResolver.refresh();
    return options;
  }

  pickModelWithProvider(
    options: PickerOption[],
    configuredProviders: ApiProvider[],
    placeHolder: string,
    extraItems: ExtraPick[] = [],
  ): Promise<string | undefined> {
    const { vscodeApi } = this.deps;
    return new Promise((resolve) => {
      if (configuredProviders.length === 0) {
        vscodeApi.window.showWarningMessage('No API keys configured. Run "Ordewell: Configure API Key" first.');
        resolve(undefined);
        return;
      }
      type Item = vscode.QuickPickItem & { modelId?: string; providerId?: ApiProvider };
      const qp = vscodeApi.window.createQuickPick<Item>();
      qp.ignoreFocusOut = true;
      let settled = false;
      const finish = (val?: string) => { settled = true; resolve(val); qp.hide(); };
      const extras: Item[] = extraItems.map((e) => ({ label: e.label, detail: e.detail, modelId: e.modelId }));

      const showProviderStep = () => {
        qp.title = 'Select a provider';
        qp.placeholder = "Which provider's models?";
        qp.buttons = [];
        qp.items = [
          ...extras,
          ...configuredProviders.map<Item>((p) => ({
            label: `Use ${PROVIDER_SHORT_LABEL[p] ?? p} models`,
            detail: p === 'openrouter' ? '200+ models via OpenRouter' : p === 'google' ? 'Native Gemini models' : `${PROVIDER_LABEL[p] ?? p} models`,
            providerId: p,
          })),
        ];
      };

      const showModelStep = (provider: ApiProvider, withExtras = false) => {
        qp.title = `Select a model — ${PROVIDER_SHORT_LABEL[provider] ?? provider}`;
        qp.placeholder = placeHolder;
        qp.buttons = configuredProviders.length >= 2 ? [vscodeApi.QuickInputButtons.Back] : [];
        qp.items = [
          ...(withExtras ? extras : []),
          ...options.filter((o) => o.apiProvider === provider).map(modelQuickPickItem),
        ];
      };

      qp.onDidTriggerButton((btn) => {
        if (btn === vscodeApi.QuickInputButtons.Back) showProviderStep();
      });
      qp.onDidAccept(() => {
        const sel = qp.selectedItems[0];
        if (!sel) return;
        if (sel.providerId) { showModelStep(sel.providerId); return; }
        if (sel.modelId) finish(sel.modelId);
      });
      qp.onDidHide(() => { if (!settled) resolve(undefined); qp.dispose(); });

      if (configuredProviders.length === 1) showModelStep(configuredProviders[0], true);
      else showProviderStep();
      qp.show();
    });
  }

  async runApiKeyWizard(preselected?: ApiProvider): Promise<void> {
    const { vscodeApi } = this.deps;
    const { validateApiKey } = await import('./adapters/ApiKeyValidator');
    let provider = preselected;
    if (!provider) {
      const items = PROVIDER_PRIORITY.map((p) => {
        const meta = getProviderMeta(p);
        return { label: meta?.shortLabel ?? p, value: p as ApiProvider, detail: meta?.label ?? p };
      });
      const picked = await vscodeApi.window.showQuickPick(items, { placeHolder: 'Which AI provider are you configuring?' });
      if (!picked) return;
      provider = picked.value;
    }

    const meta = getProviderMeta(provider);
    const providerLabel = meta?.shortLabel ?? 'OpenRouter';
    const secretKey: SecretKey = (meta?.secretStoreKey as SecretKey) || 'openrouterKey';
    const placeHolder = provider === 'google' ? 'AIza…' : 'sk-…';

    for (;;) {
      const key = await vscodeApi.window.showInputBox({
        password: true, placeHolder,
        prompt: `Enter your ${providerLabel} API key`,
        ignoreFocusOut: true,
      });
      if (!key) return;

      const validation = await vscodeApi.window.withProgress(
        { location: vscodeApi.ProgressLocation.Notification, title: `Validating ${providerLabel} key…` },
        () => validateApiKey(provider!, key, {
          openrouterBaseUrl: this.deps.config.openAiBaseUrl,
          openaiCompatibleBaseUrl: this.deps.config.openaiCompatibleBaseUrl,
        }),
      );

      if (validation.status === 'invalid') {
        await vscodeApi.window.showErrorMessage(`Invalid API key: ${validation.message}`);
        continue;
      }
      if (validation.status === 'network') {
        vscodeApi.window.showWarningMessage('Could not reach the API — saved the key anyway.');
      }

      await this.deps.secretStore.set(secretKey, key);
      await this.deps.onApiKeySaved();
      await this.refresh();
      vscodeApi.window.showInformationMessage(`API key configured for ${providerLabel}.`);
      return;
    }
  }
}

export function sendModelConfig(config: VsCodeConfig, chatProvider: ChatViewProvider): void {
  chatProvider.setModelConfig({
    orchestrator: config.orchestratorModel,
    orchestratorProvider: providerLabelForId(config.rawOrchestratorModel),
  });
}

function providerLabelForId(id: string): string {
  if (!id) return '';
  for (const provider of PROVIDER_PRIORITY) {
    const meta = getProviderMeta(provider);
    if (meta?.modelPrefix && id.startsWith(meta.modelPrefix)) return meta.shortLabel;
  }
  return 'OpenRouter';
}

function modelQuickPickItem(o: PickerOption): vscode.QuickPickItem & { modelId: string } {
  const via = o.apiProvider ? ` · via ${PROVIDER_SHORT_LABEL[o.apiProvider] ?? o.apiProvider}` : '';
  return {
    label: o.label,
    description: o.id,
    detail: `${o.description ?? ''}${o.pricing ? ' · $' + o.pricing + '/MTok' : ''}${via}`.trim(),
    modelId: o.id,
  };
}

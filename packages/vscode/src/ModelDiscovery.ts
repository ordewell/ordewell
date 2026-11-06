import type * as vscode from 'vscode';
import {
  codexSandboxNotice, detectInstalledPlanner, getProviderMeta, ModelResolver, PROVIDER_PRIORITY, PROVIDER_SHORT_LABEL, runnerForProvider,
  type AiProvider, type PlannerBackendId, type CodexSandboxAvailability, type DiscoveredModel, type RunnerInstallation, type RunnerRegistry,
} from '@ordewell/core';
import type { ChatViewProvider } from './providers/ChatViewProvider';
import type { VsCodeConfig } from './adapters/VsCodeConfig';
import { SecretStore, type ApiProvider, type SecretKey } from './adapters/SecretStore';

export interface ModelDiscoveryDeps {
  vscodeApi: typeof vscode;
  config: VsCodeConfig;
  runnerRegistry: RunnerRegistry;
  runnerInstallation: RunnerInstallation;
  /** Asked again on each refresh; absent in a host that does not probe. */
  codexSandbox?: Pick<CodexSandboxAvailability, 'refresh'>;
  modelResolver: ModelResolver;
  chatProvider: ChatViewProvider;
  /** The user's model allowlist as of now, sent with the runner list so task cards flag a model that is off it. */
  modelAllowlist: () => Record<string, string[]>;
  secretStore: SecretStore;
  log: (msg: string) => void;
  /** Re-push who-plans state after discovery, so the planner pills match the fresh catalog. */
  refreshPlannerState: () => Promise<void>;
  /** Reset the AI service and every resolver cache once a key is saved, before re-discovery. */
  onApiKeySaved: () => Promise<void>;
}

export type PickerOption = { id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string };

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
    // The runner list is being refreshed, so the host is asked again: a user
    // who fixed it while the window was open sees the modes come back.
    await d.codexSandbox?.refresh();
    // Same refresh, same reason: a CLI installed since the last look is
    // otherwise left out by the cached "not installed" verdict.
    d.runnerInstallation.refresh();
    // With no saved choice the enabled runners and the planner are the installed
    // agents, so the host is asked again here and not only at activation: an
    // agent installed while the window was open otherwise never becomes the
    // default until the window is reloaded.
    await detectInstalledPlanner(d.runnerInstallation);
    // The planner pills read the config and the install probe alone, so push
    // them before model discovery: a cold runner CLI can take tens of seconds,
    // and the picker must not sit empty behind a catalog it does not need.
    void d.refreshPlannerState().catch((err) => d.log(`Planner state refresh failed: ${err}`));
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
    // Read again rather than reusing `enabled`: a runner switched on or off
    // while the CLIs answered is saved already, and a list from before it would
    // undo the pill the user just clicked.
    d.chatProvider.setEnabledRunnerIds(d.config.enabledRunners.filter((r) => installedIds.has(r)));
    d.chatProvider.setModelAllowlist(d.modelAllowlist());

    const modesByRunner: Record<string, { id: string; label: string; description: string; cliValue?: string; autonomous?: boolean; unavailable?: string }[]> = {};
    for (const entry of installedRunners) {
      modesByRunner[entry.manifest.name] = (entry.manifest.modes ?? []).map((m) => ({
        id: m.id, label: m.label, description: m.description, cliValue: m.cliValue, autonomous: m.autonomous, unavailable: m.unavailable,
      }));
    }
    d.chatProvider.setModesByRunner(modesByRunner, codexSandboxNotice(modesByRunner));
    d.chatProvider.sendConfiguredProviders(d.config.configuredProviders);
    this.sendModelConfig();
    d.chatProvider.setModelOptions(ModelResolver.builtinOptions());

    this.options().then((opts) => {
      d.chatProvider.setModelOptions(opts);
      // The vendor label reads the catalog, which only now has the options.
      this.sendModelConfig();
      // Flag any configured provider whose catalog fetch failed — both in the
      // webview (persistent banner) and as a one-shot toast.
      const errors = d.modelResolver.getDiscoveryErrors();
      d.chatProvider.setModelDiscoveryErrors(errors, d.modelResolver.getRunnerDiscoveryErrors());
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
    sendModelConfig(this.deps.config, this.deps.chatProvider, this.deps.modelResolver);
  }

  async options(): Promise<PickerOption[]> {
    const options = await this.deps.modelResolver.pickerOptions();
    await this.deps.modelResolver.refresh();
    return options;
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
        vscodeApi.window.showWarningMessage('Could not reach the API: saved the key anyway.');
      }

      await this.deps.secretStore.set(secretKey, key);
      await this.deps.onApiKeySaved();
      await this.refresh();
      vscodeApi.window.showInformationMessage(`API key configured for ${providerLabel}.`);
      return;
    }
  }
}

export function sendModelConfig(config: VsCodeConfig, chatProvider: ChatViewProvider, modelResolver: ModelResolver): void {
  chatProvider.setModelConfig({
    orchestrator: config.orchestratorModel,
    orchestratorProvider: plannerProviderLabel(
      config.aiProvider, config.rawOrchestratorModel, modelResolver.getCachedPickerOptions(),
    ),
  });
}

/**
 * Names who serves the planner model, or '' when that can't be known. A harness
 * planner is its own backend; a vendor planner's provider is whatever the
 * discovered option says, never a guess from the id string.
 */
export function plannerProviderLabel(
  provider: PlannerBackendId,
  modelId: string,
  options: readonly { id: string; apiProvider?: AiProvider }[],
): string {
  if (runnerForProvider(provider)) return PROVIDER_SHORT_LABEL[provider] ?? '';
  if (!modelId) return '';
  const apiProvider = options.find((o) => o.id === modelId)?.apiProvider;
  return apiProvider ? PROVIDER_SHORT_LABEL[apiProvider] ?? '' : '';
}

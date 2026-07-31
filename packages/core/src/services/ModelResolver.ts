import { ModelDiscovery, clearGeminiCache, type ExecImpl } from './ModelDiscovery';
import { ModelCatalog } from './ModelCatalog';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { IConfig } from '../interfaces/IConfig';
import type { DiscoveredModel, RunnerId } from '../models/Task';
import { fetchAllProviderModels, collectProviderCredentials, toOrchestratorOptions, type OrchestratorOption, type ProviderModelLists } from './ProviderRouting';
import { ORCHESTRATOR_SHORTCUTS } from './ModelShortcuts';
import { PROVIDER_PRIORITY } from './ProviderRegistry';

export interface ModelResolverDeps {
  fetchImpl?: typeof fetch;
  execImpl?: ExecImpl;
}

export class ModelResolver {
  private discovery: ModelDiscovery;
  private fetchImpl?: typeof fetch;
  private cachedPickerOptions: OrchestratorOption[] | null = null;
  private lastDiscoveryErrors: Record<string, string> = {};

  constructor(
    private registry: RunnerRegistry,
    private config: IConfig,
    deps: ModelResolverDeps = {}
  ) {
    this.discovery = new ModelDiscovery(registry, deps.execImpl, deps.fetchImpl);
    this.fetchImpl = deps.fetchImpl;
  }

  static builtinOptions(): OrchestratorOption[] {
    return toOrchestratorOptions({}, ORCHESTRATOR_SHORTCUTS);
  }

  async modelsForRunners(runners: RunnerId[]): Promise<Partial<Record<RunnerId, DiscoveredModel[]>>> {
    const out: Partial<Record<RunnerId, DiscoveredModel[]>> = {};
    for (const runner of runners) {
      try {
        out[runner] = await this.discovery.discover(runner);
      } catch {
        out[runner] = [];
      }
    }
    return out;
  }

  async pickerOptions(): Promise<OrchestratorOption[]> {
    if (this.cachedPickerOptions) return this.cachedPickerOptions;

    // Which endpoints to probe is one policy shared with every other surface —
    // see collectProviderCredentials (only key-configured providers, plus an
    // explicitly-pointed openai_compatible endpoint).
    const { apiKeys, baseUrls } = collectProviderCredentials(this.config);

    const { models, errors } = await fetchAllProviderModels({
      apiKeys,
      baseUrls,
      fetchImpl: this.fetchImpl,
    });
    this.lastDiscoveryErrors = errors;
    this.cachedPickerOptions = toOrchestratorOptions(models, ORCHESTRATOR_SHORTCUTS);
    return this.cachedPickerOptions;
  }

  /**
   * Per-provider failures from the most recent `pickerOptions()` fetch, keyed
   * by provider id. Empty when every configured provider's catalog loaded (or
   * before the first fetch). Surfaces consume this to flag a provider whose
   * key/endpoint is set but whose catalog could not be reached.
   */
  getDiscoveryErrors(): Record<string, string> {
    return this.lastDiscoveryErrors;
  }

  async refresh(): Promise<ProviderModelLists> {
    const options = await this.pickerOptions();
    const lists: ProviderModelLists = {};
    for (const provider of PROVIDER_PRIORITY) {
      lists[provider] = options.filter((o) => o.apiProvider === provider).map((o) => o.id);
    }
    this.config.setProviderModelLists(lists);
    return lists;
  }

  refreshRunnerModels(): void {
    this.discovery.clear();
  }

  invalidate(): void {
    this.discovery.clear();
    this.cachedPickerOptions = null;
    this.lastDiscoveryErrors = {};
    if (!this.fetchImpl) {
      for (const provider of PROVIDER_PRIORITY) {
        const baseUrl = this.config.getProviderBaseUrl(provider);
        if (baseUrl) ModelCatalog.clearCache(baseUrl);
      }
      clearGeminiCache(this.config.geminiKey);
    }
  }
}

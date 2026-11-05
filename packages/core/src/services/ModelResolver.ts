import { ModelDiscovery, clearGeminiCache, type AcpClientImpl, type ExecImpl } from './ModelDiscovery';
import { ModelCatalog } from './ModelCatalog';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { RunnerEnv } from '../plugins/types';
import type { IConfig, PlannerBackendId } from '../interfaces/IConfig';
import type { DiscoveredModel, RunnerId } from '../models/Task';
import type { PlannerModelCandidate } from './PlannerModelMemory';
import { fetchAllProviderModels, collectProviderCredentials, toOrchestratorOptions, type OrchestratorOption, type ProviderModelLists } from './ProviderRouting';
import { ORCHESTRATOR_SHORTCUTS } from './ModelShortcuts';
import { PROVIDER_PRIORITY, isApiProvider, prefixModelId, runnerForProvider, stripModelPrefix } from './ProviderRegistry';
import { connectorFor } from './harness/connectors';

export interface ModelResolverDeps {
  fetchImpl?: typeof fetch;
  execImpl?: ExecImpl;
  /** The environment runners are launched with, which can move a runner's own files (`CLAUDE_CONFIG_DIR`). Defaults to this process's. */
  env?: () => Promise<RunnerEnv>;
  acpClient?: AcpClientImpl;
}

/** The vendor catalogs, which no runner environment changes. */
interface VendorCatalog {
  options: OrchestratorOption[] | null;
  /** A catalog load under way: a second ask, or a warm-up, shares it rather than fetching again. */
  load: Promise<OrchestratorOption[]> | null;
  errors: Record<string, string>;
  /** Bumped by every invalidate: a load begun before one answers its own askers but fills no cache. */
  generation: number;
}

/**
 * What a resolver and its {@link ModelResolver.withRunnerEnv} views hold in
 * common: one copy of the vendor catalogs, and the views themselves, so a
 * refresh of any of them reaches the runner catalogs of every environment.
 */
interface SharedCatalogs {
  vendor: VendorCatalog;
  root: ModelResolver;
  views: Map<string, ModelResolver>;
}

export class ModelResolver {
  private discovery: ModelDiscovery;
  private fetchImpl?: typeof fetch;
  private execImpl?: ExecImpl;
  private acpClient?: AcpClientImpl;
  private shared: SharedCatalogs;

  constructor(
    private registry: RunnerRegistry,
    private config: IConfig,
    deps: ModelResolverDeps = {}
  ) {
    this.discovery = new ModelDiscovery(registry, deps.execImpl, deps.fetchImpl, undefined, undefined, undefined, deps.env, deps.acpClient);
    this.fetchImpl = deps.fetchImpl;
    this.execImpl = deps.execImpl;
    this.acpClient = deps.acpClient;
    this.shared = { vendor: { options: null, load: null, errors: {}, generation: 0 }, root: this, views: new Map() };
  }

  private get vendor(): VendorCatalog {
    return this.shared.vendor;
  }

  /**
   * This resolver for runners launched with another environment, a
   * workspace's own: their catalogs are discovered and cached under `env`, as
   * `CLAUDE_CONFIG_DIR` there can name another account, while the vendor
   * catalogs stay this resolver's, fetched once. One view per `key`, made on
   * its first ask: a later ask with the same key gets that view, whatever
   * `env` it passes.
   */
  withRunnerEnv(key: string, env: () => Promise<RunnerEnv>): ModelResolver {
    let view = this.shared.views.get(key);
    if (!view) {
      view = new ModelResolver(this.registry, this.config, { fetchImpl: this.fetchImpl, execImpl: this.execImpl, acpClient: this.acpClient, env });
      view.shared = this.shared;
      this.shared.views.set(key, view);
    }
    return view;
  }

  /** Every runner-environment catalog this resolver's family holds: its root's and each view's. */
  private runnerCatalogs(): ModelDiscovery[] {
    return [this.shared.root, ...this.shared.views.values()].map((resolver) => resolver.discovery);
  }

  static builtinOptions(): OrchestratorOption[] {
    return toOrchestratorOptions({}, ORCHESTRATOR_SHORTCUTS);
  }

  async modelsForRunners(runners: RunnerId[]): Promise<Partial<Record<RunnerId, DiscoveredModel[]>>> {
    // Each runner's discovery can spawn a slow CLI, so they run together rather
    // than in series: one cold backend must not hold up the others' catalogs.
    // Deduped, because two concurrent discoveries of one runner would spawn it
    // twice with no shared in-flight guard.
    const unique = [...new Set(runners)];
    const discovered = await Promise.all(unique.map(async (runner) => {
      try {
        return [runner, await this.discovery.discover(runner)] as const;
      } catch {
        return [runner, [] as DiscoveredModel[]] as const;
      }
    }));
    return Object.fromEntries(discovered) as Partial<Record<RunnerId, DiscoveredModel[]>>;
  }

  async pickerOptions(): Promise<OrchestratorOption[]> {
    if (this.vendor.options) return this.vendor.options;
    if (!this.vendor.load) {
      const load = this.loadPickerOptions();
      this.vendor.load = load;
      void load.finally(() => { if (this.vendor.load === load) this.vendor.load = null; }).catch(() => {});
    }
    return this.vendor.load;
  }

  /**
   * Start loading the vendor catalogs without waiting for them, unless they
   * are held or loading already: an API planner whose model's window is not
   * known yet reads it from them on a later call, never waiting on the fetch.
   */
  warmPickerOptions(): void {
    if (this.vendor.options || this.vendor.load) return;
    this.pickerOptions().catch(() => {});
  }

  private async loadPickerOptions(): Promise<OrchestratorOption[]> {
    const vendor = this.vendor;
    const generation = vendor.generation;
    // Which endpoints to probe is one policy shared with every other surface —
    // see collectProviderCredentials (only key-configured providers, plus an
    // explicitly-pointed openai_compatible endpoint).
    const { apiKeys, baseUrls } = collectProviderCredentials(this.config);

    const { models, errors } = await fetchAllProviderModels({
      apiKeys,
      baseUrls,
      fetchImpl: this.fetchImpl,
    });
    const options = toOrchestratorOptions(models, ORCHESTRATOR_SHORTCUTS);
    // Begun before an invalidate, so asked with what may be old credentials:
    // its askers get it, and the cache waits for the load asked after.
    if (vendor.generation === generation) {
      vendor.errors = errors;
      vendor.options = options;
    }
    return options;
  }

  /**
   * Per-provider failures from the most recent `pickerOptions()` fetch, keyed
   * by provider id. Empty when every configured provider's catalog loaded (or
   * before the first fetch). Surfaces consume this to flag a provider whose
   * key/endpoint is set but whose catalog could not be reached.
   */
  getDiscoveryErrors(): Record<string, string> {
    return this.vendor.errors;
  }

  /**
   * Why each runner whose catalog the last `modelsForRunners` found empty
   * offers nothing, keyed by runner id, in this resolver's environment: a
   * signed-out runner is told with the ways to sign it in, since a refresh
   * alone cannot fill its list. Empty when no runner said why.
   */
  getRunnerDiscoveryErrors(): Record<string, string> {
    return Object.fromEntries(Object.keys(this.discovery.whyUnlisted()).map((runner) => {
      const manifest = this.registry.getManifest(runner);
      return [runner, connectorFor(runner)?.signedOut ?? `${manifest?.displayName ?? runner} is not signed in.`];
    }));
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

  /** Forget every runner catalog, each workspace's included; the vendor catalogs stay. */
  refreshRunnerModels(): void {
    for (const discovery of this.runnerCatalogs()) discovery.clear();
  }

  /**
   * The models a pick for `provider` is judged against: a harness planner's
   * own runner catalog, or the vendor picker catalog (ADR-0009). Discovered
   * if not held. Never throws: a catalog that cannot be had is empty.
   */
  async plannerCatalog(provider: PlannerBackendId): Promise<PlannerModelCandidate[]> {
    const runner = runnerForProvider(provider);
    if (runner) return candidatesOf((await this.modelsForRunners([runner]))[runner] ?? []);
    return (await this.pickerOptions().catch(() => [])).map((o) => ({ id: o.id }));
  }

  /** {@link plannerCatalog} from what is already held, so a cold catalog is empty; never discovers. */
  cachedPlannerCatalog(provider: PlannerBackendId): PlannerModelCandidate[] {
    const runner = runnerForProvider(provider);
    if (runner) return candidatesOf(this.getCachedRunnerModels(runner));
    return this.getCachedPickerOptions().map((o) => ({ id: o.id }));
  }

  /**
   * Synchronous reads of whatever the last `modelsForRunners`/`pickerOptions`
   * call already cached — never trigger discovery or a fetch. For callers
   * (e.g. a settings write) that need a catalog without going async.
   */
  getCachedRunnerModels(runner: string): DiscoveredModel[] {
    return this.discovery.getCached(runner) ?? [];
  }

  getCachedPickerOptions(): OrchestratorOption[] {
    return this.vendor.options ?? [];
  }

  /**
   * A model's context window from whatever catalog is already cached (#49),
   * for a usage record whose reporter stated none: a vendor's model from the
   * picker catalog (its own `/models` endpoint), a runner's model from that
   * runner's own discovered listing. `source` is the record's reporter, and
   * `model` the id it named. Reads only — never triggers a fetch or discovery
   * of its own, so an unknown window stays unknown and context fill is
   * omitted rather than guessed.
   */
  contextWindowFor(source: string, model: string): number | undefined {
    if (!model) return undefined;
    const window = isApiProvider(source)
      ? this.vendor.options?.find((o) => o.apiProvider === source && o.id === prefixModelId(source, stripModelPrefix(model, source)))?.contextWindow
      : this.discovery.getCached(source)?.find((m) => m.modelId === model)?.contextWindow;
    return window && window > 0 ? window : undefined;
  }

  /**
   * The longest reply a vendor's model is served with, from the picker
   * catalog already held, when that catalog states one. Reads only, like
   * {@link contextWindowFor}.
   */
  maxOutputTokensFor(source: string, model: string): number | undefined {
    if (!model || !isApiProvider(source)) return undefined;
    const cap = this.vendor.options?.find((o) => o.apiProvider === source && o.id === prefixModelId(source, stripModelPrefix(model, source)))?.maxOutputTokens;
    return cap && cap > 0 ? cap : undefined;
  }

  /** Forget every catalog: the vendor ones, and each runner environment's. */
  invalidate(): void {
    this.refreshRunnerModels();
    this.vendor.generation++;
    this.vendor.options = null;
    this.vendor.load = null;
    this.vendor.errors = {};
    if (!this.fetchImpl) {
      for (const provider of PROVIDER_PRIORITY) {
        const baseUrl = this.config.getProviderBaseUrl(provider);
        if (baseUrl) ModelCatalog.clearCache(baseUrl);
      }
      clearGeminiCache(this.config.geminiKey);
    }
  }
}

function candidatesOf(models: DiscoveredModel[]): PlannerModelCandidate[] {
  return models.map((m) => ({ id: m.modelId, variants: m.variants }));
}

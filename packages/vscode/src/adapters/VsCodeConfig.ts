import * as vscode from 'vscode';
import { type AiProvider, type PlannerBackendId, BaseConfig, DEFAULT_MAX_PARALLEL, DEFAULT_RUNNERS, defaultEnabledRunners, parseMaxParallel, normalizeGeminiModel, isApiProvider, getProviderMeta, configuredProviders, parseApprovalModeSetting, DEFAULT_WEB_READ_BUDGET, SettingsService, notifyCommandOf } from '@ordewell/core';
import type { ConfiguredPlanner, ProviderModelLists, ResolvedPlanner } from '@ordewell/core';
import { SecretStore, type ApiProvider, type SecretKey } from './SecretStore';

export class VsCodeConfig extends BaseConfig {
  private get config() { return vscode.workspace.getConfiguration('ordewell'); }

  private _providerModelLists: ProviderModelLists | null = null;
  private _pick: { model: string; provider: PlannerBackendId } | undefined;

  /**
   * `readAgentCatalog` reads the model ids a coding agent's discovery last
   * listed, live; the resolver that holds them is built from this config, so
   * it is passed as a reader rather than a catalog.
   */
  constructor(
    private readonly secretStore?: SecretStore,
    private readonly readAgentCatalog: (provider: PlannerBackendId) => readonly string[] = () => [],
  ) {
    super();
  }

  protected agentCatalog(provider: PlannerBackendId): readonly string[] {
    return this.readAgentCatalog(provider);
  }

  // --- Legacy getters ---

  get openrouterKey(): string {
    return (
      this.secretStore?.get('openrouterKey') ||
      this.config.get<string>('openAiApiKey', '') ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      ''
    );
  }

  get geminiKey(): string {
    return (
      this.secretStore?.get('geminiKey') ||
      this.config.get<string>('apiKey', '') ||
      process.env.GEMINI_API_KEY ||
      ''
    );
  }

  get openAiBaseUrl() { return this.config.get<string>('openAiBaseUrl', '') || super.openAiBaseUrl; }
  get openAiApiKey() { return this.secretStore?.get('openrouterKey') || this.config.get<string>('openAiApiKey', '') || super.openAiApiKey; }
  get openaiCompatibleBaseUrl() { return this.config.get<string>('openaiCompatibleBaseUrl', '') || super.openaiCompatibleBaseUrl; }
  get openaiCompatibleApiKey() { return this.secretStore?.get('openaiCompatibleKey') || this.config.get<string>('openaiCompatibleApiKey', '') || super.openaiCompatibleApiKey; }

  // --- Registry-driven provider config ---

  /** SecretStore slot lookup by provider. */
  private secretForKey(provider: AiProvider): string | undefined {
    const meta = getProviderMeta(provider);
    if (!meta?.secretStoreKey) return undefined;
    return this.secretStore?.get(meta.secretStoreKey as SecretKey);
  }

  /** VS Code setting lookup by provider's config key. */
  private configForKey(key: string | undefined): string {
    if (!key) return '';
    return this.config.get<string>(key, '');
  }

  getProviderBaseUrl(provider: AiProvider): string {
    const meta = getProviderMeta(provider);
    if (meta?.vscodeBaseUrlKey) {
      const v = this.config.get<string>(meta.vscodeBaseUrlKey, '');
      if (v) return v;
    }
    return super.getProviderBaseUrl(provider);
  }

  getProviderApiKey(provider: AiProvider): string {
    const meta = getProviderMeta(provider);
    if (meta?.secretStoreKey) {
      const v = this.secretStore?.get(meta.secretStoreKey as SecretKey);
      if (v) return v;
    }
    if (meta?.vscodeApiKeyKey) {
      const v = this.config.get<string>(meta.vscodeApiKeyKey, '');
      if (v) return v;
    }
    return super.getProviderApiKey(provider);
  }

  // --- New preset config getters ---

  get openaiBaseUrl() { return this.config.get<string>('openaiBaseUrl', '') || super.openaiBaseUrl; }
  get openaiApiKey() { return this.secretStore?.get('openaiKey') || this.config.get<string>('openaiApiKey', '') || super.openaiApiKey; }

  get xaiBaseUrl() { return this.config.get<string>('xaiBaseUrl', '') || super.xaiBaseUrl; }
  get xaiApiKey() { return this.secretStore?.get('xaiKey') || this.config.get<string>('xaiApiKey', '') || super.xaiApiKey; }

  get groqBaseUrl() { return this.config.get<string>('groqBaseUrl', '') || super.groqBaseUrl; }
  get groqApiKey() { return this.secretStore?.get('groqKey') || this.config.get<string>('groqApiKey', '') || super.groqApiKey; }

  get deepseekBaseUrl() { return this.config.get<string>('deepseekBaseUrl', '') || super.deepseekBaseUrl; }
  get deepseekApiKey() { return this.secretStore?.get('deepseekKey') || this.config.get<string>('deepseekApiKey', '') || super.deepseekApiKey; }

  get togetherBaseUrl() { return this.config.get<string>('togetherBaseUrl', '') || super.togetherBaseUrl; }
  get togetherApiKey() { return this.secretStore?.get('togetherKey') || this.config.get<string>('togetherApiKey', '') || super.togetherApiKey; }
  get mistralBaseUrl() { return this.config.get<string>('mistralBaseUrl', '') || super.mistralBaseUrl; }
  get mistralApiKey() { return this.secretStore?.get('mistralKey') || this.config.get<string>('mistralApiKey', '') || super.mistralApiKey; }
  get anthropicBaseUrl() { return this.config.get<string>('anthropicBaseUrl', '') || super.anthropicBaseUrl; }
  get anthropicApiKey() { return this.secretStore?.get('anthropicKey') || this.config.get<string>('anthropicApiKey', '') || super.anthropicApiKey; }
  get fireworksBaseUrl() { return this.config.get<string>('fireworksBaseUrl', '') || super.fireworksBaseUrl; }
  get fireworksApiKey() { return this.secretStore?.get('fireworksKey') || this.config.get<string>('fireworksApiKey', '') || super.fireworksApiKey; }
  get perplexityBaseUrl() { return this.config.get<string>('perplexityBaseUrl', '') || super.perplexityBaseUrl; }
  get perplexityApiKey() { return this.secretStore?.get('perplexityKey') || this.config.get<string>('perplexityApiKey', '') || super.perplexityApiKey; }
  get zhipuBaseUrl() { return this.config.get<string>('zhipuBaseUrl', '') || super.zhipuBaseUrl; }
  get zhipuApiKey() { return this.secretStore?.get('zhipuKey') || this.config.get<string>('zhipuApiKey', '') || super.zhipuApiKey; }
  get kimiBaseUrl() { return this.config.get<string>('kimiBaseUrl', '') || super.kimiBaseUrl; }
  get kimiApiKey() { return this.secretStore?.get('kimiKey') || this.config.get<string>('kimiApiKey', '') || super.kimiApiKey; }
  get cerebrasBaseUrl() { return this.config.get<string>('cerebrasBaseUrl', '') || super.cerebrasBaseUrl; }
  get cerebrasApiKey() { return this.secretStore?.get('cerebrasKey') || this.config.get<string>('cerebrasApiKey', '') || super.cerebrasApiKey; }
  get deepinfraBaseUrl() { return this.config.get<string>('deepinfraBaseUrl', '') || super.deepinfraBaseUrl; }
  get deepinfraApiKey() { return this.secretStore?.get('deepinfraKey') || this.config.get<string>('deepinfraApiKey', '') || super.deepinfraApiKey; }
  get doubaoBaseUrl() { return this.config.get<string>('doubaoBaseUrl', '') || super.doubaoBaseUrl; }
  get doubaoApiKey() { return this.secretStore?.get('doubaoKey') || this.config.get<string>('doubaoApiKey', '') || super.doubaoApiKey; }
  get qwenBaseUrl() { return this.config.get<string>('qwenBaseUrl', '') || super.qwenBaseUrl; }
  get qwenApiKey() { return this.secretStore?.get('qwenKey') || this.config.get<string>('qwenApiKey', '') || super.qwenApiKey; }
  get hunyuanBaseUrl() { return this.config.get<string>('hunyuanBaseUrl', '') || super.hunyuanBaseUrl; }
  get hunyuanApiKey() { return this.secretStore?.get('hunyuanKey') || this.config.get<string>('hunyuanApiKey', '') || super.hunyuanApiKey; }
  get baichuanBaseUrl() { return this.config.get<string>('baichuanBaseUrl', '') || super.baichuanBaseUrl; }
  get baichuanApiKey() { return this.secretStore?.get('baichuanKey') || this.config.get<string>('baichuanApiKey', '') || super.baichuanApiKey; }
  get minimaxBaseUrl() { return this.config.get<string>('minimaxBaseUrl', '') || super.minimaxBaseUrl; }
  get minimaxApiKey() { return this.secretStore?.get('minimaxKey') || this.config.get<string>('minimaxApiKey', '') || super.minimaxApiKey; }
  get yiBaseUrl() { return this.config.get<string>('yiBaseUrl', '') || super.yiBaseUrl; }
  get yiApiKey() { return this.secretStore?.get('yiKey') || this.config.get<string>('yiApiKey', '') || super.yiApiKey; }
  get stepfunBaseUrl() { return this.config.get<string>('stepfunBaseUrl', '') || super.stepfunBaseUrl; }
  get stepfunApiKey() { return this.secretStore?.get('stepfunKey') || this.config.get<string>('stepfunApiKey', '') || super.stepfunApiKey; }
  get siliconflowBaseUrl() { return this.config.get<string>('siliconflowBaseUrl', '') || super.siliconflowBaseUrl; }
  get siliconflowApiKey() { return this.secretStore?.get('siliconflowKey') || this.config.get<string>('siliconflowApiKey', '') || super.siliconflowApiKey; }
  get cohereBaseUrl() { return this.config.get<string>('cohereBaseUrl', '') || super.cohereBaseUrl; }
  get cohereApiKey() { return this.secretStore?.get('cohereKey') || this.config.get<string>('cohereApiKey', '') || super.cohereApiKey; }
  get novitaBaseUrl() { return this.config.get<string>('novitaBaseUrl', '') || super.novitaBaseUrl; }
  get novitaApiKey() { return this.secretStore?.get('novitaKey') || this.config.get<string>('novitaApiKey', '') || super.novitaApiKey; }

  /**
   * Providers with a non-empty key (or, for openai_compatible, a base URL)
   * from any resolution tier. Delegates to the shared core policy so the CLI
   * listing and this picker agree on what "configured" means; `this` supplies
   * the secret-store-aware `getProviderApiKey`/`openaiCompatibleBaseUrl`.
   */
  get configuredProviders(): ApiProvider[] {
    return configuredProviders(this) as ApiProvider[];
  }

  setProviderModelLists(lists: ProviderModelLists): void {
    this._providerModelLists = lists;
  }

  /** The setting as written, valid or not; `aiProvider` is what the extension acts on. */
  get rawAiProvider(): string { return this.config.get<string>('aiProvider', '') || ''; }

  get planner(): ResolvedPlanner {
    return this.resolvePlanner(this.configuredPlanner(this.config.get<string>('orchestratorModel', '')), this._providerModelLists);
  }

  /**
   * A planner pick in this window set `model` for `provider`. Held here, not
   * in the settings: the setting outlives the window, and the next one reads
   * it as inherited.
   */
  notePlannerPick(model: string, provider: PlannerBackendId): void {
    this._pick = { model, provider };
  }

  private configuredPlanner(model: string): ConfiguredPlanner {
    const configured = model || process.env.ORCHESTRATOR_MODEL || '';
    return {
      model: configured,
      effort: this.config.get<string>('plannerThinkingEffort', '') || process.env.ORDEWELL_PLANNER_EFFORT || '',
      setting: this.rawAiProvider,
      pickedFor: this._pick?.model === configured ? this._pick.provider : undefined,
    };
  }

  get aiProvider(): PlannerBackendId {
    return this.planner.provider;
  }

  get apiKey() {
    const provider = this.aiProvider;
    // A vendor planner gets its own key or none: the Gemini transport reads
    // this, and an OpenRouter key handed to Google fails as a bad credential
    // rather than as the missing key the preflight would have named.
    if (isApiProvider(provider)) return this.getProviderApiKey(provider);
    return this.openrouterKey || this.geminiKey || '';
  }

  /**
   * Gemini's model, from the first of these settings that holds one.
   * `orchestratorModel` is every planner's, so a model picked there for
   * another planner is not Gemini's and gives way to what Gemini remembers.
   */
  private geminiModelFrom(...keys: string[]): string {
    for (const key of keys) {
      const value = this.config.get<string>(key, '');
      const own = key === 'orchestratorModel' && value ? this.plannerChoiceFor('google', this.configuredPlanner(value)).model : value;
      if (own) return normalizeGeminiModel(own);
    }
    return super.geminiModel;
  }

  get planningModel() {
    if (this.aiProvider === 'google') return this.geminiModelFrom('planningModel', 'geminiModel', 'orchestratorModel');
    const raw = this.config.get<string>('planningModel', '') || this.config.get<string>('orchestratorModel', '');
    return this.plannerChoiceFor(this.aiProvider, this.configuredPlanner(raw)).model;
  }

  get rawOrchestratorModel() { return this.config.get<string>('orchestratorModel', '') || ''; }

  get plannerThinkingEffort(): string | undefined {
    return this.planner.effort || undefined;
  }


  get orchestratorModel() {
    if (this.aiProvider === 'google') return this.geminiModelFrom('orchestratorModel', 'geminiModel', 'planningModel');
    return this.planner.model;
  }

  get geminiModel() { return this.config.get<string>('geminiModel', '') || this.config.get<string>('orchestratorModel', '') || this.config.get<string>('planningModel', '') || super.geminiModel; }

  /**
   * The list every surface shares (the settings file). Until the user has
   * chosen, the answer is what the retired per-runner toggles said, or the
   * installed agents.
   */
  get enabledRunners(): string[] {
    const saved = new SettingsService().getEnabledRunners();
    if (saved !== undefined) return saved;

    // Migration from the per-runner toggles that predate `enabledRunners`: a
    // fixed set of three settings that were never extended, so they name their
    // runners by id on purpose and a runner added since has no toggle to read.
    // Only a value the user set is a choice: `get` also answers the manifest's
    // defaults, which would enable all three on a host that has one installed.
    const userSet = <T>(key: string): T | undefined => {
      const inspected = this.config.inspect<T>(key);
      return inspected?.globalValue ?? inspected?.workspaceValue;
    };
    const legacyCc = userSet<boolean>('claudeCode.enabled');
    const legacyCodex = userSet<boolean>('codex.enabled');
    const legacyOc = userSet<boolean>('opencode.enabled');
    const legacyRunner = userSet<string>('runner');
    if ([legacyCc, legacyCodex, legacyOc, legacyRunner].every((value) => value === undefined)) return defaultEnabledRunners();

    const enabled: string[] = [];
    if (legacyCc !== undefined) {
      if (legacyCc) enabled.push('claude-code');
    } else if (legacyRunner === 'opencode') {
      enabled.push('opencode');
    } else {
      enabled.push('claude-code');
    }
    if (legacyCodex !== undefined && legacyCodex) enabled.push('codex');
    if (legacyOc !== undefined && legacyOc) enabled.push('opencode');
    return enabled.length > 0 ? enabled : [...DEFAULT_RUNNERS];
  }

  get maxParallelSessions() { return parseMaxParallel(this.config.get<number>('maxParallelSessions', DEFAULT_MAX_PARALLEL)) ?? DEFAULT_MAX_PARALLEL; }
  get researchMaxSteps() { return this.config.get<number>('researchMaxSteps', 48); }
  get researchMaxFileSize() { return this.config.get<number>('researchMaxFileSize', 10); }
  get approvalMode() {
    if (process.env.ORDEWELL_APPROVAL_MODE !== undefined) return super.approvalMode;
    return parseApprovalModeSetting(this.config.get<string>('plannerApprovals', 'auto'));
  }
  get approvalPreApproved() { return [...(this.stringList('plannerAllowlist') ?? []), ...super.approvalPreApproved]; }
  get effectAllowlist() { return [...(this.stringList('effectAllowlist') ?? []), ...super.effectAllowlist]; }
  /** The user's value alone, whatever a manifest scope allows: a workspace's would let a repository run a command (ADR-0053). */
  get notifyCommand() {
    const own = notifyCommandOf(this.config.inspect<unknown>('notifyCommand')?.globalValue);
    return own.length > 0 ? own : super.notifyCommand;
  }
  get approvalDefaults() {
    if (process.env.ORDEWELL_APPROVAL_DEFAULTS !== undefined) return super.approvalDefaults;
    return this.config.get<boolean>('plannerAllowlistDefaults', true);
  }
  get webReadBudget() {
    if (process.env.ORDEWELL_WEB_READ_BUDGET !== undefined) return super.webReadBudget;
    const configured = this.config.get<number>('plannerWebReadBudget', DEFAULT_WEB_READ_BUDGET);
    return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_WEB_READ_BUDGET;
  }
  get plannerNativeShell() {
    if (process.env.ORDEWELL_PLANNER_NATIVE_SHELL !== undefined) return super.plannerNativeShell;
    return this.config.get<boolean>('plannerNativeShell', false);
  }
  get worktreeIsolation() {
    if (process.env.ORDEWELL_WORKTREE_ISOLATION !== undefined) return super.worktreeIsolation;
    return this.config.get<boolean>('worktreeIsolation', true);
  }
  get worktreeSetupCommand() { return this.config.get<string>('worktreeSetupCommand', '').trim() || super.worktreeSetupCommand; }
  get workspaceRepos() { return this.stringList('workspaceRepos') ?? super.workspaceRepos; }
  get worktreeLinks() { return this.stringList('worktreeLinks') ?? super.worktreeLinks; }
  get conflictRepairAttempts() {
    if (process.env.ORDEWELL_CONFLICT_REPAIR_ATTEMPTS !== undefined) return super.conflictRepairAttempts;
    const configured = this.config.get<number>('conflictRepairAttempts', 2);
    return Number.isInteger(configured) && configured >= 0 ? configured : 2;
  }

  private stringList(key: string): string[] | undefined {
    const list = this.config.get<string[]>(key, []).map((s) => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.config.update(key, value, true);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ordewell')) listener();
    });
  }
}

/**
 * Full/Guarded moved from VS Code's `ordewell.autonomousMode` to the user's
 * settings file, which every surface shares (ADR-0030). A level set there is
 * copied once, unless the file already has one, and the old setting cleared;
 * a VS Code that refuses to clear a setting it no longer declares leaves it
 * unread, which is harmless.
 */
export async function moveAutonomyFromVsCodeSetting(settings: SettingsService): Promise<void> {
  const config = vscode.workspace.getConfiguration('ordewell');
  const seen = config.inspect<boolean>('autonomousMode');
  const value = seen?.globalValue ?? seen?.workspaceValue;
  if (typeof value !== 'boolean') return;
  if (settings.getAll().autonomousMode === undefined) settings.setAutonomousMode(value);
  try {
    if (seen?.globalValue !== undefined) await config.update('autonomousMode', undefined, true);
    if (seen?.workspaceValue !== undefined) await config.update('autonomousMode', undefined, false);
  } catch {
    // Not declared any more, so VS Code may refuse the write; the value is already copied.
  }
}

/**
 * The enabled runners moved from VS Code's `ordewell.enabledRunners` to the
 * settings file, so a toggle in one surface is the list every other one plans
 * with. A list set there is copied once, unless the file already has a choice,
 * and the old setting cleared. The workspace's value wins over the user's, as
 * it did when VS Code read it. An empty list is not copied: it was one window's
 * "none", and as the file's choice it would silence the runner catalog on
 * every surface of the machine.
 */
export async function moveEnabledRunnersFromVsCodeSetting(settings: SettingsService): Promise<void> {
  const config = vscode.workspace.getConfiguration('ordewell');
  const seen = config.inspect<string[]>('enabledRunners');
  const set = [seen?.workspaceValue, seen?.globalValue].filter((v): v is string[] => Array.isArray(v));
  if (set.length === 0) return;
  const choice = set.find((v) => v.length > 0);
  if (choice) settings.setEnabledRunnersIfUnset(choice.map(String));
  try {
    if (seen?.globalValue !== undefined) await config.update('enabledRunners', undefined, true);
    if (seen?.workspaceValue !== undefined) await config.update('enabledRunners', undefined, false);
  } catch {
    // Still declared (deprecated), so this should not refuse; if it does the value is already copied and no longer read.
  }
}

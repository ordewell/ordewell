import * as vscode from 'vscode';
import { AiProvider, BaseConfig, normalizeGeminiModel, resolveProvider, ALL_PROVIDERS, getProviderMeta, configuredProviders } from '@ordewell/core';
import type { ProviderModelLists } from '@ordewell/core';
import { SecretStore, type ApiProvider, type SecretKey } from './SecretStore';

export class VsCodeConfig extends BaseConfig {
  private get config() { return vscode.workspace.getConfiguration('ordewell'); }

  private _provider: AiProvider | null = null;
  private _providerModelLists: ProviderModelLists | null = null;

  constructor(private readonly secretStore?: SecretStore) {
    super();
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
    this._provider = null;
  }

  get aiProvider(): AiProvider {
    if (this._provider) return this._provider;
    const env = this.config.get<string>('aiProvider', '');
    if (env && ALL_PROVIDERS[env as AiProvider]) {
      this._provider = env as AiProvider;
      return this._provider;
    }
    const model = this.config.get<string>('orchestratorModel', '') || process.env.ORCHESTRATOR_MODEL;
    if (model && this._providerModelLists) {
      const resolved = resolveProvider(model, this._providerModelLists);
      if (resolved) {
        this._provider = resolved;
        return this._provider;
      }
    }
    this._provider = BaseConfig.detectProvider('openrouter');
    return this._provider;
  }

  get apiKey() {
    return this.getProviderApiKey(this.aiProvider) || this.openrouterKey || this.geminiKey || '';
  }

  private resolveConfigModel(...keys: string[]): string {
    for (const key of keys) {
      const val = this.config.get<string>(key, '');
      if (val) return val;
    }
    return '';
  }

  get planningModel() {
    if (this.aiProvider === 'google') {
      const raw = this.resolveConfigModel('planningModel', 'geminiModel', 'orchestratorModel');
      return raw ? normalizeGeminiModel(raw) : super.geminiModel;
    }
    return this.config.get<string>('planningModel', '') || this.config.get<string>('orchestratorModel', '') || process.env.ORCHESTRATOR_MODEL || '';
  }

  get rawOrchestratorModel() { return this.config.get<string>('orchestratorModel', '') || ''; }

  get plannerThinkingEffort(): string | undefined {
    return this.config.get<string>('plannerThinkingEffort', '') || super.plannerThinkingEffort;
  }


  get orchestratorModel() {
    if (this.aiProvider === 'google') {
      const raw = this.resolveConfigModel('orchestratorModel', 'geminiModel', 'planningModel');
      return raw ? normalizeGeminiModel(raw) : super.geminiModel;
    }
    return this.config.get<string>('orchestratorModel', '') || super.orchestratorModel;
  }

  get geminiModel() { return this.config.get<string>('geminiModel', '') || this.config.get<string>('orchestratorModel', '') || this.config.get<string>('planningModel', '') || super.geminiModel; }

  get enabledRunners(): string[] {
    const configured = this.config.inspect<string[]>('enabledRunners');
    const userValue = configured?.globalValue ?? configured?.workspaceValue;
    if (userValue !== undefined) return userValue;

    const legacyCc = this.config.get<boolean>('claudeCode.enabled');
    const legacyCodex = this.config.get<boolean>('codex.enabled');
    const legacyOc = this.config.get<boolean>('opencode.enabled');
    const legacyRunner = this.config.get<string>('runner');

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
    return enabled.length > 0 ? enabled : ['claude-code'];
  }

  get maxParallelSessions() { return this.config.get<number>('maxParallelSessions', 3); }
  get researchEnabled() { return this.config.get<boolean>('researchEnabled', true); }
  get researchMaxSteps() { return this.config.get<number>('researchMaxSteps', 48); }
  get researchMaxFileSize() { return this.config.get<number>('researchMaxFileSize', 10); }
  get autonomousMode() { return this.config.get<boolean>('autonomousMode', true); }

  async update(key: string, value: unknown): Promise<void> {
    await this.config.update(key, value, true);
    // `aiProvider` is memoized, and `orchestratorModel` is what resolves it
    // when no provider is set explicitly. Writing either without dropping the
    // memo leaves every later read on the pre-change answer until reload —
    // which is how a switched planner keeps planning on the old backend.
    if (key === 'aiProvider' || key === 'orchestratorModel') this._provider = null;
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ordewell')) listener();
    });
  }
}

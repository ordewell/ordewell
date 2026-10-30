import type { IConfig, AiProvider, PlannerBackendId } from './IConfig';
import { parseApprovalModeSetting, type ApprovalModeSetting } from '../services/ApprovalPolicy';
import { DEFAULT_WEB_READ_BUDGET } from '../services/webReadPolicy';
import { resolveProvider, type ProviderModelLists } from '../services/ProviderRouting';
import { configuredProviders, getProviderMeta, isApiProvider, isPlannerBackend, PROVIDER_DETECT_PRIORITY, resolveProviderFromPrefix, runnerForProvider } from '../services/ProviderRegistry';
import { BUILTIN_MANIFESTS } from '../plugins/builtin';
import type { RunnerModelDiscovery } from '../plugins/types';
import type { PlannerModelChoice } from '../services/PlannerModelMemory';
import { DEFAULT_MAX_PARALLEL, parseMaxParallel } from '../utils/maxParallel';
import { SettingsService } from '../services/SettingsService';
import { parseNotifyCommand } from '../services/escalationNotifier';
import { recordedInstalledPlanner } from '../services/InstalledPlanner';

export function normalizeGeminiModel(id: string): string {
  return id.replace(/^gemini:/, '').replace(/^google\//, '');
}

function commaList(raw: string | undefined): string[] {
  return (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The first vendor whose credential is in the environment, in detection
 * order. An endpoint alone names only a vendor that needs no credential (a
 * local openai_compatible server): a base URL left behind by a removed key
 * would otherwise route a keyless first run to a vendor that refuses to plan.
 */
function envDetectedProvider(): AiProvider | null {
  for (const provider of PROVIDER_DETECT_PRIORITY) {
    const meta = getProviderMeta(provider);
    if (meta.detectEnvVars.some((v) => process.env[v]?.trim())) return provider;
    if (meta.detectEnvVars.length === 0 && meta.baseUrlEnvVar && process.env[meta.baseUrlEnvVar]?.trim()) return provider;
  }
  return null;
}

/** A model and the effort it was chosen with; blank is the planner's own default. */
export interface PlannerChoice {
  model: string;
  effort: string;
}

/**
 * Where a resolved model and effort came from. `configured` is a planner the
 * user named, or a vendor, as configured; for an agent detection found,
 * `inherited` is a configured model it can run. A planner whose configured
 * model is not its own gets `remembered`, its last pick, or `none`, its own
 * default; `request` is one request's model. Only `configured` and
 * `remembered` are the user's own choice for that planner.
 */
export type PlannerModelSource = 'configured' | 'inherited' | 'remembered' | 'request' | 'none';

export interface ResolvedChoice extends PlannerChoice {
  source: PlannerModelSource;
}

/** Who plans, and the model and effort it is spawned with. */
export interface ResolvedPlanner extends ResolvedChoice {
  provider: PlannerBackendId;
}

/**
 * What a host is configured to plan with. The model and effort are inherited
 * (the environment or `.env` at startup, an editor setting) unless the planner
 * was named — `setting` (VS Code's `aiProvider`) or AI_PROVIDER — or the
 * model was picked in this session.
 */
export interface ConfiguredPlanner extends PlannerChoice {
  setting?: string;
  /**
   * The planner a `/planner` pick in this session made the model for. A pick
   * belongs to that planner alone: once routing moves (its key
   * removed), the model is configuration left for when it comes back, not a
   * choice the planner now in effect made.
   */
  pickedFor?: PlannerBackendId;
  /** One request's own model: it wins for that request and is never saved. */
  override?: string;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? '').trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : fallback;
}

/** A setting that is off unless it says on: only the spellings a person writes for yes turn it on. */
function isOn(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

export abstract class BaseConfig implements IConfig {
  private _routed: { basis: string; lists: ProviderModelLists | null | undefined; provider: PlannerBackendId } | null = null;

  abstract aiProvider: PlannerBackendId;
  abstract apiKey: string;
  abstract planningModel: string;
  abstract enabledRunners: string[];

  abstract setProviderModelLists(lists: ProviderModelLists): void;

  // --- Legacy named getters (backward compat) ---

  get openAiBaseUrl(): string { return process.env.OPENROUTER_BASE_URL || process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1'; }
  get openAiApiKey(): string { return process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || ''; }
  get openrouterKey(): string { return process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || ''; }
  get geminiKey(): string { return process.env.GEMINI_API_KEY || ''; }
  get geminiBaseUrl(): string | undefined { return process.env.GEMINI_BASE_URL || undefined; }
  get openaiCompatibleBaseUrl(): string { return process.env.OPENAI_COMPATIBLE_BASE_URL || ''; }
  get openaiCompatibleApiKey(): string { return process.env.OPENAI_COMPATIBLE_API_KEY || ''; }
  // Every planner backend spawns with this, so even a host with no settings of
  // its own reads the environment through the planner rule: a named coding
  // agent is never handed a vendor slug left in ORCHESTRATOR_MODEL.
  get orchestratorModel(): string { return this.environmentPlannerChoice().model; }
  // Grunt reading must never cost strong-model prices: subagents follow the
  // (cheap) planner model unless explicitly pinned elsewhere.
  get researchSubagentModel(): string { return process.env.ORDEWELL_SUBAGENT_MODEL || this.orchestratorModel; }
  get geminiModel(): string { return normalizeGeminiModel(process.env.GEMINI_MODEL || ''); }
  get plannerThinkingEffort(): string | undefined { return this.environmentPlannerChoice().effort || undefined; }

  private environmentPlannerChoice(): ResolvedChoice {
    return this.plannerChoiceFor(this.aiProvider, { model: process.env.ORCHESTRATOR_MODEL || '', effort: process.env.ORDEWELL_PLANNER_EFFORT || '' });
  }

  // --- New preset getters ---

  get openaiBaseUrl(): string { return process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'; }
  get openaiApiKey(): string { return process.env.OPENAI_API_KEY || ''; }
  get xaiBaseUrl(): string { return process.env.XAI_BASE_URL || 'https://api.x.ai/v1'; }
  get xaiApiKey(): string { return process.env.XAI_API_KEY || ''; }
  get groqBaseUrl(): string { return process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'; }
  get groqApiKey(): string { return process.env.GROQ_API_KEY || ''; }
  get deepseekBaseUrl(): string { return process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'; }
  get deepseekApiKey(): string { return process.env.DEEPSEEK_API_KEY || ''; }

  get togetherBaseUrl(): string { return process.env.TOGETHER_BASE_URL || 'https://api.together.xyz/v1'; }
  get togetherApiKey(): string { return process.env.TOGETHER_API_KEY || ''; }
  get mistralBaseUrl(): string { return process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1'; }
  get mistralApiKey(): string { return process.env.MISTRAL_API_KEY || ''; }
  get anthropicBaseUrl(): string { return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1'; }
  get anthropicApiKey(): string { return process.env.ANTHROPIC_API_KEY || ''; }
  get fireworksBaseUrl(): string { return process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1'; }
  get fireworksApiKey(): string { return process.env.FIREWORKS_API_KEY || ''; }
  get perplexityBaseUrl(): string { return process.env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai'; }
  get perplexityApiKey(): string { return process.env.PERPLEXITY_API_KEY || ''; }
  get zhipuBaseUrl(): string { return process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4'; }
  get zhipuApiKey(): string { return process.env.ZHIPU_API_KEY || ''; }
  get kimiBaseUrl(): string { return process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1'; }
  get kimiApiKey(): string { return process.env.MOONSHOT_API_KEY || ''; }
  get cerebrasBaseUrl(): string { return process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1'; }
  get cerebrasApiKey(): string { return process.env.CEREBRAS_API_KEY || ''; }
  get deepinfraBaseUrl(): string { return process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai'; }
  get deepinfraApiKey(): string { return process.env.DEEPINFRA_API_KEY || ''; }
  get doubaoBaseUrl(): string { return process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'; }
  get doubaoApiKey(): string { return process.env.ARK_API_KEY || ''; }
  get qwenBaseUrl(): string { return process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'; }
  get qwenApiKey(): string { return process.env.DASHSCOPE_API_KEY || ''; }
  get hunyuanBaseUrl(): string { return process.env.HUNYUAN_BASE_URL || 'https://api.hunyuan.cloud.tencent.com/v1'; }
  get hunyuanApiKey(): string { return process.env.HUNYUAN_API_KEY || ''; }
  get baichuanBaseUrl(): string { return process.env.BAICHUAN_BASE_URL || 'https://api.baichuan-ai.com/v1'; }
  get baichuanApiKey(): string { return process.env.BAICHUAN_API_KEY || ''; }
  get minimaxBaseUrl(): string { return process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1'; }
  get minimaxApiKey(): string { return process.env.MINIMAX_API_KEY || ''; }
  get yiBaseUrl(): string { return process.env.YI_BASE_URL || 'https://api.lingyiwanwu.com/v1'; }
  get yiApiKey(): string { return process.env.YI_API_KEY || ''; }
  get stepfunBaseUrl(): string { return process.env.STEPFUN_BASE_URL || 'https://api.stepfun.com/v1'; }
  get stepfunApiKey(): string { return process.env.STEPFUN_API_KEY || ''; }
  get siliconflowBaseUrl(): string { return process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1'; }
  get siliconflowApiKey(): string { return process.env.SILICONFLOW_API_KEY || ''; }
  get cohereBaseUrl(): string { return process.env.COHERE_BASE_URL || 'https://api.cohere.com/v1'; }
  get cohereApiKey(): string { return process.env.COHERE_API_KEY || ''; }
  get novitaBaseUrl(): string { return process.env.NOVITA_BASE_URL || 'https://api.novita.ai/v3/openai'; }
  get novitaApiKey(): string { return process.env.NOVITA_API_KEY || ''; }

  // --- Registry-driven generic getters ---

  getProviderBaseUrl(provider: AiProvider): string {
    const meta = getProviderMeta(provider);
    if (!meta) return '';
    const custom = meta.baseUrlEnvVar ? process.env[meta.baseUrlEnvVar]?.trim() : undefined;
    return custom || meta.defaultBaseUrl;
  }

  getProviderApiKey(provider: AiProvider): string {
    const meta = getProviderMeta(provider);
    if (!meta) return '';
    for (const envVar of [meta.apiKeyEnvVar, ...meta.detectEnvVars]) {
      // A hand-edited .env leaves stray whitespace on a key, and the provider
      // rejects that as an unknown credential rather than a malformed one.
      const val = process.env[envVar]?.trim();
      if (val) return val;
    }
    return '';
  }

  get maxParallelSessions(): number { return parseMaxParallel(process.env.ORDEWELL_MAX_PARALLEL) ?? DEFAULT_MAX_PARALLEL; }
  get researchEnabled(): boolean { return process.env.ORDEWELL_RESEARCH_ENABLED !== 'false'; }
  get researchMaxSteps(): number { return parseInt(process.env.ORDEWELL_RESEARCH_MAX_STEPS || '48', 10); }
  get researchMaxFileSize(): number { return parseInt(process.env.ORDEWELL_RESEARCH_MAX_FILE_SIZE || '50', 10); }

  get planMapEnabled(): boolean { return process.env.ORDEWELL_PLAN_MAP_ENABLED !== 'false' && process.env.ORDEWELL_PLAN_MAP_ENABLED !== '0'; }

  /** The user's saved level (ADR-0030), read each time so a change from any surface reaches the next plan. */
  get autonomousMode(): boolean { return new SettingsService().autonomousMode(); }

  get worktreeIsolation(): boolean { return process.env.ORDEWELL_WORKTREE_ISOLATION !== 'false' && process.env.ORDEWELL_WORKTREE_ISOLATION !== '0'; }
  get worktreeSetupCommand(): string | undefined { return process.env.ORDEWELL_WORKTREE_SETUP?.trim() || undefined; }
  get workspaceRepos(): string[] { return commaList(process.env.ORDEWELL_WORKSPACE_REPOS); }
  get worktreeLinks(): string[] { return commaList(process.env.ORDEWELL_WORKTREE_LINKS); }
  get conflictRepairAttempts(): number { return nonNegativeInt(process.env.ORDEWELL_CONFLICT_REPAIR_ATTEMPTS, 2); }

  get approvalMode(): ApprovalModeSetting { return parseApprovalModeSetting(process.env.ORDEWELL_APPROVAL_MODE); }

  get webReadBudget(): number { return nonNegativeInt(process.env.ORDEWELL_WEB_READ_BUDGET, DEFAULT_WEB_READ_BUDGET); }

  /** The native-shell opt-in (ADR-0036 N1): off unless the launching environment says on. Never a workspace variable. */
  get plannerNativeShell(): boolean { return isOn(process.env.ORDEWELL_PLANNER_NATIVE_SHELL); }

  get approvalDefaults(): boolean { return process.env.ORDEWELL_APPROVAL_DEFAULTS !== 'false' && process.env.ORDEWELL_APPROVAL_DEFAULTS !== '0'; }

  get approvalPreApproved(): string[] {
    // Comma- or newline-separated so a CI env var and a shell export both read naturally.
    return (process.env.ORDEWELL_APPROVAL_ALLOW || '')
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  get effectAllowlist(): string[] {
    return (process.env.ORDEWELL_EFFECT_ALLOW || '')
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  get notifyCommand(): string[] { return parseNotifyCommand(process.env.ORDEWELL_NOTIFY_COMMAND); }

  /**
   * Who plans when no surface setting names a planner: an explicit
   * AI_PROVIDER, then a vendor whose key is in the environment,
   * then an installed coding agent (ADR-0009), and openrouter only when there
   * is none of those. One answer for every host, so they cannot drift apart.
   */
  protected detectProvider(): PlannerBackendId {
    const env = process.env.AI_PROVIDER;
    if (env && isPlannerBackend(env)) return env;

    const fromEnv = envDetectedProvider();
    if (fromEnv) return fromEnv;

    // A key a host keeps outside the environment (VS Code's secret store) is a
    // vendor key all the same, and wins over an installed agent as one in the
    // environment does. It names its own vendor: any other would be refused
    // for a key nobody set.
    const configured = configuredProviders(this);
    const keyed = PROVIDER_DETECT_PRIORITY.find((provider) => configured.includes(provider));
    if (keyed) return keyed;
    return recordedInstalledPlanner() ?? 'openrouter';
  }

  /**
   * Who plans when no surface setting names a planner: an explicit
   * AI_PROVIDER, then the vendor whose catalog lists the model, else
   * `detectProvider`. The explicit choice comes first because a model id can
   * sit in another vendor's catalog (`openai/gpt-4o` is on OpenRouter too),
   * and the user named the planner, not the catalog. A vendor without a
   * credential yields to an installed coding agent, because the TUI and
   * `ordewell planner` persist ORCHESTRATOR_MODEL, and a model left over from
   * a removed key would otherwise route a keyless first run to a planner that
   * cannot plan. Without an agent the vendor still answers, so the preflight
   * names it.
   */
  protected providerForModel(model: string | undefined, lists: ProviderModelLists | null | undefined): PlannerBackendId {
    const explicit = process.env.AI_PROVIDER;
    if (explicit && isPlannerBackend(explicit)) return explicit;
    const inferred = model && lists ? resolveProvider(model, lists) : null;
    if (inferred && (configuredProviders(this).includes(inferred) || !recordedInstalledPlanner())) return inferred;
    return this.detectProvider();
  }

  /**
   * `providerForModel`, memoized against everything it reads rather than a
   * flag each writer must remember to reset. A host keeps one config for a
   * whole session or extension lifetime while keys, AI_PROVIDER, the model and
   * the installed agent all change underneath it, from writers (a secret-store
   * event, a settings route, the startup probe) that never see this instance;
   * the memo must answer what a fresh config would. The lists are compared by
   * identity because a host swaps the whole object on discovery.
   */
  protected routedProvider(model: string | undefined, lists: ProviderModelLists | null | undefined): PlannerBackendId {
    const basis = [
      process.env.AI_PROVIDER ?? '',
      model ?? '',
      recordedInstalledPlanner() ?? '',
      envDetectedProvider() ?? '',
      configuredProviders(this).join(','),
    ].join('|');
    if (this._routed && this._routed.basis === basis && this._routed.lists === lists) return this._routed.provider;
    const provider = this.providerForModel(model, lists);
    this._routed = { basis, lists, provider };
    return provider;
  }

  /**
   * Who plans, with which model and effort: the one rule every host's
   * provider, model and effort getters read, so what a settings response
   * shows is what is spawned. Resolved on each read and never saved: a key or
   * a `/planner` pick added later must find the configured values as they were.
   */
  protected resolvePlanner(configured: ConfiguredPlanner, lists: ProviderModelLists | null | undefined): ResolvedPlanner {
    const setting = configured.setting ?? '';
    const provider = isPlannerBackend(setting) ? setting : this.routedProvider(configured.override || configured.model, lists);
    return { provider, ...this.plannerChoiceFor(provider, configured) };
  }

  /**
   * `resolvePlanner`'s model and effort, for a getter that reads its model
   * from other settings than the one `provider` was routed on
   * (`planningModel`): judged against the planner in effect rather than
   * routed again. A model picked in this session for this planner and a
   * vendor's configured model are kept; a model picked for another planner
   * is not this one's. A coding agent the user named keeps what is
   * configured unless it is plainly a vendor's: naming the agent did not
   * choose a slug left from an old setup. A request's own model wins.
   */
  protected plannerChoiceFor(provider: PlannerBackendId, configured: ConfiguredPlanner): ResolvedChoice {
    const { model, effort, override = '' } = configured;
    const named = isPlannerBackend(configured.setting ?? '') || isPlannerBackend(process.env.AI_PROVIDER ?? '');
    const pickedElsewhere = configured.pickedFor !== undefined && configured.pickedFor !== provider;
    const kept = configured.pickedFor === provider || (!pickedElsewhere && (isApiProvider(provider)
      || (named && !isForeignModel(provider, model, () => this.agentCatalog(provider)))));
    if (kept) return { model: override || model, effort, source: override ? 'request' : 'configured' };
    const own = pickedElsewhere || named ? rememberedOrDefault(provider) : detectedAgentChoice(provider, configured);
    // No effort was chosen for a model only this request names.
    return !override || override === own.model ? own : { model: override, effort: '', source: 'request' };
  }

  /**
   * The model ids a coding agent was last discovered serving, empty while
   * discovery is cold. A host that holds a runner catalog supplies it: it is
   * the only evidence that tells OpenCode's `provider/model` ids from an
   * OpenRouter slug. Asked only when a named agent's configured model is
   * neither its alias nor its remembered pick.
   */
  protected agentCatalog(_provider: PlannerBackendId): readonly string[] {
    return [];
  }
}

/**
 * What an agent that plans only because detection found it (ADR-0009) is
 * spawned with. It never chose the configured model: the TUI and `ordewell
 * planner` persist ORCHESTRATOR_MODEL, so a slug left from an old OpenRouter
 * setup would otherwise reach `--model` and fail the turn. That model is kept,
 * with the effort configured beside it, only when it is one of the agent's
 * stable aliases: the one evidence it is the agent's own found without
 * spawning the agent for a catalog. Otherwise the agent gets its remembered
 * pick (every pick is remembered, PlannerModelMemory) with the effort it was
 * picked with, the same model configured included; with neither, its own
 * default. An effort is a level of one model, so it never moves to another.
 */
function detectedAgentChoice(provider: PlannerBackendId, configured: PlannerChoice): ResolvedChoice {
  const remembered = rememberedChoice(provider);
  if (configured.model !== remembered?.model && isStableAlias(provider, configured.model)) {
    return { model: configured.model, effort: configured.effort, source: 'inherited' };
  }
  return rememberedOrDefault(provider);
}

function discoveryOf(provider: PlannerBackendId): RunnerModelDiscovery | undefined {
  return BUILTIN_MANIFESTS.find((m) => m.name === runnerForProvider(provider))?.modelDiscovery;
}

function isStableAlias(provider: PlannerBackendId, model: string): boolean {
  return discoveryOf(provider)?.canonicalAliases?.some((alias) => alias.modelId === model) ?? false;
}

const SLUG_SHAPE = /^[\w.-]+\//;

/**
 * Plainly a vendor's model, which coding agent `agent` cannot run: every
 * vendor catalog id carries Ordewell's prefix (`openai:`) or is an OpenRouter
 * `org/model` slug, a shape an agent that names its own models that way
 * cannot rule out.
 */
export function isVendorModelFor(agent: PlannerBackendId, model: string): boolean {
  if (resolveProviderFromPrefix(model)) return true;
  return !discoveryOf(agent)?.providerQualifiedIds && SLUG_SHAPE.test(model);
}

/**
 * A configured model a named coding agent is not spawned with: plainly a
 * vendor's or, for an agent whose own ids share the slug shape, one its
 * discovered catalog does not list. Its stable aliases, its catalog and its
 * remembered pick are its own whatever their shape.
 */
function isForeignModel(agent: PlannerBackendId, model: string, catalog: () => readonly string[]): boolean {
  if (!model || isStableAlias(agent, model) || rememberedChoice(agent)?.model === model) return false;
  // Asked last, and only here: a host whose catalog is cold waits for it only
  // when it is what decides (ADR-0040).
  const listed = catalog();
  if (listed.includes(model)) return false;
  return isVendorModelFor(agent, model) || (listed.length > 0 && SLUG_SHAPE.test(model));
}

/**
 * The planner's remembered pick, unless it is plainly a vendor's model handed
 * to an agent: before the planner's inherited settings were told apart from
 * picks, `ordewell plan` saved a leftover OpenRouter slug as the detected
 * agent's own. Read past, never deleted, since the settings file is the user's.
 */
function rememberedChoice(provider: PlannerBackendId): PlannerModelChoice | undefined {
  const entry = new SettingsService().getPlannerModel(provider);
  return entry && (isApiProvider(provider) || !isVendorModelFor(provider, entry.model)) ? entry : undefined;
}

/** A planner whose configured model is not its own plans with its remembered pick and that pick's effort, else its own default. */
function rememberedOrDefault(provider: PlannerBackendId): ResolvedChoice {
  const remembered = rememberedChoice(provider);
  return remembered ? { model: remembered.model, effort: remembered.effort ?? '', source: 'remembered' } : { model: '', effort: '', source: 'none' };
}

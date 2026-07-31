import { IConfig, AiProvider } from './IConfig';
import type { ApprovalMode } from '../services/ApprovalPolicy';
import type { ProviderModelLists } from '../services/ProviderRouting';
import { ALL_PROVIDERS, getProviderMeta, PROVIDER_DETECT_PRIORITY } from '../services/ProviderRegistry';

export function normalizeGeminiModel(id: string): string {
  return id.replace(/^gemini:/, '').replace(/^google\//, '');
}

export abstract class BaseConfig implements IConfig {
  abstract aiProvider: AiProvider;
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
  get orchestratorModel(): string { return process.env.ORCHESTRATOR_MODEL || ''; }
  // Grunt reading must never cost strong-model prices: subagents follow the
  // (cheap) planner model unless explicitly pinned elsewhere.
  get researchSubagentModel(): string { return process.env.ORDEWELL_SUBAGENT_MODEL || this.orchestratorModel; }
  get geminiModel(): string { return normalizeGeminiModel(process.env.GEMINI_MODEL || ''); }
  get plannerThinkingEffort(): string | undefined { return process.env.ORDEWELL_PLANNER_EFFORT || undefined; }

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
    if (meta.baseUrlEnvVar && process.env[meta.baseUrlEnvVar]) return process.env[meta.baseUrlEnvVar]!;
    return meta.defaultBaseUrl;
  }

  getProviderApiKey(provider: AiProvider): string {
    const meta = getProviderMeta(provider);
    if (!meta) return '';
    for (const envVar of [meta.apiKeyEnvVar, ...meta.detectEnvVars]) {
      const val = process.env[envVar];
      if (val) return val;
    }
    return '';
  }

  get maxParallelSessions(): number { return parseInt(process.env.ORDEWELL_MAX_PARALLEL || '3', 10); }
  get researchEnabled(): boolean { return process.env.ORDEWELL_RESEARCH_ENABLED !== 'false'; }
  get researchMaxSteps(): number { return parseInt(process.env.ORDEWELL_RESEARCH_MAX_STEPS || '48', 10); }
  get researchMaxFileSize(): number { return parseInt(process.env.ORDEWELL_RESEARCH_MAX_FILE_SIZE || '50', 10); }

  get planMapEnabled(): boolean { return process.env.ORDEWELL_PLAN_MAP_ENABLED !== 'false' && process.env.ORDEWELL_PLAN_MAP_ENABLED !== '0'; }

  get autonomousMode(): boolean { return process.env.ORDEWELL_AUTONOMOUS_MODE !== 'false' && process.env.ORDEWELL_AUTONOMOUS_MODE !== '0'; }

  get approvalMode(): ApprovalMode {
    const raw = (process.env.ORDEWELL_APPROVAL_MODE || '').trim().toLowerCase();
    return raw === 'allow' || raw === 'deny' ? raw : 'ask';
  }

  get approvalPreApproved(): string[] {
    // Comma- or newline-separated so a CI env var and a shell export both read naturally.
    return (process.env.ORDEWELL_APPROVAL_ALLOW || '')
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  protected static detectProvider(fallback: AiProvider): AiProvider {
    const env = process.env.AI_PROVIDER;
    if (env && ALL_PROVIDERS[env as AiProvider]) return env as AiProvider;

    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = ALL_PROVIDERS[provider];
      if (!meta) continue;
      if (meta.detectEnvVars.some((v) => process.env[v])) return provider as AiProvider;
      if (meta.baseUrlEnvVar && process.env[meta.baseUrlEnvVar]) return provider as AiProvider;
    }

    return fallback;
  }
}

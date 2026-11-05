import type { AiProvider, PlannerBackendId } from '../interfaces/IConfig';
import type { RunnerId } from '../models/Task';

// The API vendors alone. `ProviderRegistry` adds the harness planners from the
// runner connectors, so a module the connectors load themselves
// (settingsEnvAllowlist) reads vendors here, or the import would be a cycle.

export interface ProviderRegistration {
  id: PlannerBackendId;
  label: string;
  shortLabel: string;
  /** `cli` is a harness planner (ADR-0009): a local coding agent, not an HTTP vendor. */
  serviceType: 'openai' | 'google' | 'cli';
  /** Harness planners only: the runner id whose manifest, models and binary this provider drives. */
  runnerId?: RunnerId;
  defaultBaseUrl: string;
  apiKeyEnvVar: string;
  detectEnvVars: string[];
  baseUrlEnvVar?: string;
  secretStoreKey?: string;
  vscodeBaseUrlKey?: string;
  vscodeApiKeyKey?: string;
  discoversModels: boolean;
  modelPrefix?: string;
}

/** Every API vendor's registration. */
export const VENDORS: Readonly<Record<AiProvider, ProviderRegistration>> = {
  openrouter: {
    id: 'openrouter', label: 'OpenRouter', shortLabel: 'OpenRouter',
    serviceType: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    // Intentionally NOT OPENAI_API_KEY: that belongs to the dedicated `openai`
    // provider (api.openai.com). Sharing it made a bare OPENAI_API_KEY resolve
    // to OpenRouter and marked both providers configured. The legacy
    // openrouterKey/openAiApiKey getters still fall back to OPENAI_API_KEY for
    // pre-existing setups; only provider detection/routing is de-coupled here.
    detectEnvVars: ['OPENROUTER_API_KEY'],
    baseUrlEnvVar: 'OPENROUTER_BASE_URL',
    secretStoreKey: 'openrouterKey',
    vscodeBaseUrlKey: 'openAiBaseUrl', vscodeApiKeyKey: 'openAiApiKey',
    discoversModels: true,
  },
  google: {
    id: 'google', label: 'Google Gemini', shortLabel: 'Gemini',
    serviceType: 'google',
    defaultBaseUrl: '',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    detectEnvVars: ['GEMINI_API_KEY'],
    baseUrlEnvVar: 'GEMINI_BASE_URL',
    secretStoreKey: 'geminiKey',
    vscodeApiKeyKey: 'apiKey',
    discoversModels: true,
    modelPrefix: 'gemini:',
  },
  openai_compatible: {
    id: 'openai_compatible', label: 'Custom', shortLabel: 'Custom',
    serviceType: 'openai',
    defaultBaseUrl: 'http://localhost:11434/v1',
    apiKeyEnvVar: 'OPENAI_COMPATIBLE_API_KEY',
    detectEnvVars: [],
    baseUrlEnvVar: 'OPENAI_COMPATIBLE_BASE_URL',
    secretStoreKey: 'openaiCompatibleKey',
    vscodeBaseUrlKey: 'openaiCompatibleBaseUrl', vscodeApiKeyKey: 'openaiCompatibleApiKey',
    discoversModels: true,
    modelPrefix: 'openai_compat:',
  },
  openai: {
    id: 'openai', label: 'OpenAI', shortLabel: 'OpenAI',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    detectEnvVars: ['OPENAI_API_KEY'],
    secretStoreKey: 'openaiKey',
    vscodeBaseUrlKey: 'openaiBaseUrl', vscodeApiKeyKey: 'openaiApiKey',
    discoversModels: true,
    modelPrefix: 'openai:',
  },
  xai: {
    id: 'xai', label: 'xAI', shortLabel: 'xAI',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1',
    apiKeyEnvVar: 'XAI_API_KEY',
    detectEnvVars: ['XAI_API_KEY'],
    secretStoreKey: 'xaiKey',
    vscodeBaseUrlKey: 'xaiBaseUrl', vscodeApiKeyKey: 'xaiApiKey',
    discoversModels: true,
    modelPrefix: 'xai:',
  },
  groq: {
    id: 'groq', label: 'Groq', shortLabel: 'Groq',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvVar: 'GROQ_API_KEY',
    detectEnvVars: ['GROQ_API_KEY'],
    secretStoreKey: 'groqKey',
    vscodeBaseUrlKey: 'groqBaseUrl', vscodeApiKeyKey: 'groqApiKey',
    discoversModels: true,
    modelPrefix: 'groq:',
  },
  deepseek: {
    id: 'deepseek', label: 'DeepSeek', shortLabel: 'DeepSeek',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    detectEnvVars: ['DEEPSEEK_API_KEY'],
    secretStoreKey: 'deepseekKey',
    vscodeBaseUrlKey: 'deepseekBaseUrl', vscodeApiKeyKey: 'deepseekApiKey',
    discoversModels: true,
    modelPrefix: 'deepseek:',
  },
  together: {
    id: 'together', label: 'Together AI', shortLabel: 'Together',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    apiKeyEnvVar: 'TOGETHER_API_KEY',
    detectEnvVars: ['TOGETHER_API_KEY'],
    secretStoreKey: 'togetherKey',
    vscodeBaseUrlKey: 'togetherBaseUrl', vscodeApiKeyKey: 'togetherApiKey',
    discoversModels: true,
    modelPrefix: 'together:',
  },
  mistral: {
    id: 'mistral', label: 'Mistral', shortLabel: 'Mistral',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    detectEnvVars: ['MISTRAL_API_KEY'],
    secretStoreKey: 'mistralKey',
    vscodeBaseUrlKey: 'mistralBaseUrl', vscodeApiKeyKey: 'mistralApiKey',
    discoversModels: true,
    modelPrefix: 'mistral:',
  },
  anthropic: {
    id: 'anthropic', label: 'Anthropic', shortLabel: 'Anthropic',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    detectEnvVars: ['ANTHROPIC_API_KEY'],
    secretStoreKey: 'anthropicKey',
    vscodeBaseUrlKey: 'anthropicBaseUrl', vscodeApiKeyKey: 'anthropicApiKey',
    discoversModels: true,
    modelPrefix: 'anthropic:',
  },
  fireworks: {
    id: 'fireworks', label: 'Fireworks AI', shortLabel: 'Fireworks',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnvVar: 'FIREWORKS_API_KEY',
    detectEnvVars: ['FIREWORKS_API_KEY'],
    secretStoreKey: 'fireworksKey',
    vscodeBaseUrlKey: 'fireworksBaseUrl', vscodeApiKeyKey: 'fireworksApiKey',
    discoversModels: true,
    modelPrefix: 'fireworks:',
  },
  perplexity: {
    id: 'perplexity', label: 'Perplexity', shortLabel: 'Perplexity',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.perplexity.ai',
    apiKeyEnvVar: 'PERPLEXITY_API_KEY',
    detectEnvVars: ['PERPLEXITY_API_KEY'],
    secretStoreKey: 'perplexityKey',
    vscodeBaseUrlKey: 'perplexityBaseUrl', vscodeApiKeyKey: 'perplexityApiKey',
    // Perplexity exposes no OpenAI-style GET /models list endpoint, so catalog
    // discovery always fails. Users set a perplexity model id explicitly
    // (AI_PROVIDER=perplexity + orchestratorModel=sonar-…) instead.
    discoversModels: false,
    modelPrefix: 'perplexity:',
  },
  zhipu: {
    id: 'zhipu', label: 'Zhipu / GLM', shortLabel: 'Zhipu',
    serviceType: 'openai',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnvVar: 'ZHIPU_API_KEY',
    detectEnvVars: ['ZHIPU_API_KEY'],
    secretStoreKey: 'zhipuKey',
    vscodeBaseUrlKey: 'zhipuBaseUrl', vscodeApiKeyKey: 'zhipuApiKey',
    discoversModels: true,
    modelPrefix: 'zhipu:',
  },
  kimi: {
    id: 'kimi', label: 'Moonshot / Kimi', shortLabel: 'Kimi',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    detectEnvVars: ['MOONSHOT_API_KEY'],
    secretStoreKey: 'kimiKey',
    vscodeBaseUrlKey: 'kimiBaseUrl', vscodeApiKeyKey: 'kimiApiKey',
    discoversModels: true,
    modelPrefix: 'kimi:',
  },
  cerebras: {
    id: 'cerebras', label: 'Cerebras', shortLabel: 'Cerebras',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    detectEnvVars: ['CEREBRAS_API_KEY'],
    secretStoreKey: 'cerebrasKey',
    vscodeBaseUrlKey: 'cerebrasBaseUrl', vscodeApiKeyKey: 'cerebrasApiKey',
    discoversModels: true,
    modelPrefix: 'cerebras:',
  },
  deepinfra: {
    id: 'deepinfra', label: 'DeepInfra', shortLabel: 'DeepInfra',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnvVar: 'DEEPINFRA_API_KEY',
    detectEnvVars: ['DEEPINFRA_API_KEY'],
    secretStoreKey: 'deepinfraKey',
    vscodeBaseUrlKey: 'deepinfraBaseUrl', vscodeApiKeyKey: 'deepinfraApiKey',
    discoversModels: true,
    modelPrefix: 'deepinfra:',
  },
  doubao: {
    id: 'doubao', label: 'ByteDance / Doubao', shortLabel: 'Doubao',
    serviceType: 'openai',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnvVar: 'ARK_API_KEY',
    detectEnvVars: ['ARK_API_KEY'],
    secretStoreKey: 'doubaoKey',
    vscodeBaseUrlKey: 'doubaoBaseUrl', vscodeApiKeyKey: 'doubaoApiKey',
    discoversModels: true,
    modelPrefix: 'doubao:',
  },
  qwen: {
    id: 'qwen', label: 'Alibaba / Qwen', shortLabel: 'Qwen',
    serviceType: 'openai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    detectEnvVars: ['DASHSCOPE_API_KEY'],
    secretStoreKey: 'qwenKey',
    vscodeBaseUrlKey: 'qwenBaseUrl', vscodeApiKeyKey: 'qwenApiKey',
    discoversModels: true,
    modelPrefix: 'qwen:',
  },
  hunyuan: {
    id: 'hunyuan', label: 'Tencent Hunyuan', shortLabel: 'Hunyuan',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    apiKeyEnvVar: 'HUNYUAN_API_KEY',
    detectEnvVars: ['HUNYUAN_API_KEY'],
    secretStoreKey: 'hunyuanKey',
    vscodeBaseUrlKey: 'hunyuanBaseUrl', vscodeApiKeyKey: 'hunyuanApiKey',
    discoversModels: true,
    modelPrefix: 'hunyuan:',
  },
  baichuan: {
    id: 'baichuan', label: 'Baichuan', shortLabel: 'Baichuan',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.baichuan-ai.com/v1',
    apiKeyEnvVar: 'BAICHUAN_API_KEY',
    detectEnvVars: ['BAICHUAN_API_KEY'],
    secretStoreKey: 'baichuanKey',
    vscodeBaseUrlKey: 'baichuanBaseUrl', vscodeApiKeyKey: 'baichuanApiKey',
    discoversModels: true,
    modelPrefix: 'baichuan:',
  },
  minimax: {
    id: 'minimax', label: 'MiniMax', shortLabel: 'MiniMax',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.minimax.chat/v1',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    detectEnvVars: ['MINIMAX_API_KEY'],
    secretStoreKey: 'minimaxKey',
    vscodeBaseUrlKey: 'minimaxBaseUrl', vscodeApiKeyKey: 'minimaxApiKey',
    discoversModels: true,
    modelPrefix: 'minimax:',
  },
  yi: {
    id: 'yi', label: '01.AI / Yi', shortLabel: 'Yi',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.lingyiwanwu.com/v1',
    apiKeyEnvVar: 'YI_API_KEY',
    detectEnvVars: ['YI_API_KEY'],
    secretStoreKey: 'yiKey',
    vscodeBaseUrlKey: 'yiBaseUrl', vscodeApiKeyKey: 'yiApiKey',
    discoversModels: true,
    modelPrefix: 'yi:',
  },
  stepfun: {
    id: 'stepfun', label: 'StepFun', shortLabel: 'StepFun',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.stepfun.com/v1',
    apiKeyEnvVar: 'STEPFUN_API_KEY',
    detectEnvVars: ['STEPFUN_API_KEY'],
    secretStoreKey: 'stepfunKey',
    vscodeBaseUrlKey: 'stepfunBaseUrl', vscodeApiKeyKey: 'stepfunApiKey',
    discoversModels: true,
    modelPrefix: 'stepfun:',
  },
  siliconflow: {
    id: 'siliconflow', label: 'SiliconFlow', shortLabel: 'SiliconFlow',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnvVar: 'SILICONFLOW_API_KEY',
    detectEnvVars: ['SILICONFLOW_API_KEY'],
    secretStoreKey: 'siliconflowKey',
    vscodeBaseUrlKey: 'siliconflowBaseUrl', vscodeApiKeyKey: 'siliconflowApiKey',
    discoversModels: true,
    modelPrefix: 'siliconflow:',
  },
  cohere: {
    id: 'cohere', label: 'Cohere', shortLabel: 'Cohere',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.cohere.com/v1',
    apiKeyEnvVar: 'COHERE_API_KEY',
    detectEnvVars: ['COHERE_API_KEY'],
    secretStoreKey: 'cohereKey',
    vscodeBaseUrlKey: 'cohereBaseUrl', vscodeApiKeyKey: 'cohereApiKey',
    discoversModels: true,
    modelPrefix: 'cohere:',
  },
  novita: {
    id: 'novita', label: 'Novita AI', shortLabel: 'Novita',
    serviceType: 'openai',
    defaultBaseUrl: 'https://api.novita.ai/v3/openai',
    apiKeyEnvVar: 'NOVITA_API_KEY',
    detectEnvVars: ['NOVITA_API_KEY'],
    secretStoreKey: 'novitaKey',
    vscodeBaseUrlKey: 'novitaBaseUrl', vscodeApiKeyKey: 'novitaApiKey',
    discoversModels: true,
    modelPrefix: 'novita:',
  },

};

export const PROVIDER_PRIORITY: AiProvider[] = [
  'openrouter', 'google',
  'openai', 'anthropic', 'mistral', 'xai', 'groq', 'deepseek',
  'together', 'fireworks', 'perplexity', 'cerebras', 'deepinfra', 'cohere', 'novita',
  'zhipu', 'kimi', 'doubao', 'qwen', 'hunyuan', 'baichuan', 'minimax', 'yi', 'stepfun', 'siliconflow',
  'openai_compatible',
];

export const PROVIDER_DETECT_PRIORITY: AiProvider[] = [
  'google', 'openrouter',
  'openai', 'anthropic', 'mistral', 'xai', 'groq', 'deepseek',
  'together', 'fireworks', 'perplexity', 'cerebras', 'deepinfra', 'cohere', 'novita',
  'zhipu', 'kimi', 'doubao', 'qwen', 'hunyuan', 'baichuan', 'minimax', 'yi', 'stepfun', 'siliconflow',
  'openai_compatible',
];

/** The variables a vendor's key and endpoint are read from: the host's environment, or the one a spawn would start under. */
export type VendorEnv = Readonly<Record<string, string | undefined>>;

/** A vendor's key as `env` holds it, empty when it holds none. */
export function vendorApiKeyIn(env: VendorEnv, provider: AiProvider): string {
  if (!Object.hasOwn(VENDORS, provider)) return '';
  const meta = VENDORS[provider];
  for (const envVar of [meta.apiKeyEnvVar, ...meta.detectEnvVars]) {
    // A hand-edited .env leaves stray whitespace on a key, and the provider
    // rejects that as an unknown credential rather than a malformed one.
    const val = env[envVar]?.trim();
    if (val) return val;
  }
  return '';
}

/** The endpoint a vendor is reached at under `env`: its own variable's, else its default. */
export function vendorBaseUrlIn(env: VendorEnv, provider: AiProvider): string {
  if (!Object.hasOwn(VENDORS, provider)) return '';
  const meta = VENDORS[provider];
  const custom = meta.baseUrlEnvVar ? env[meta.baseUrlEnvVar]?.trim() : undefined;
  return custom || meta.defaultBaseUrl;
}

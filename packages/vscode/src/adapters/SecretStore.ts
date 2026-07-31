import type * as vscode from 'vscode';

export type SecretKey =
  | 'openrouterKey' | 'geminiKey' | 'openaiCompatibleKey'
  | 'openaiKey' | 'xaiKey' | 'groqKey' | 'deepseekKey'
  | 'togetherKey' | 'mistralKey' | 'anthropicKey' | 'fireworksKey'
  | 'perplexityKey' | 'zhipuKey' | 'kimiKey' | 'cerebrasKey'
  | 'deepinfraKey' | 'doubaoKey' | 'qwenKey' | 'hunyuanKey'
  | 'baichuanKey' | 'minimaxKey' | 'yiKey' | 'stepfunKey'
  | 'siliconflowKey' | 'cohereKey' | 'novitaKey';

/**
 * The providers that hold an API key — a strict subset of core's `AiProvider`.
 * The harness planners (ADR-0009) are deliberately absent: their credential is
 * the user's coding-agent subscription, so there is nothing for this store to
 * keep.
 */
export type ApiProvider =
  | 'openrouter' | 'google' | 'openai_compatible'
  | 'openai' | 'xai' | 'groq' | 'deepseek'
  | 'together' | 'mistral' | 'anthropic' | 'fireworks'
  | 'perplexity' | 'zhipu' | 'kimi' | 'cerebras'
  | 'deepinfra' | 'doubao' | 'qwen' | 'hunyuan'
  | 'baichuan' | 'minimax' | 'yi' | 'stepfun'
  | 'siliconflow' | 'cohere' | 'novita';

const SECRET_KEYS: SecretKey[] = [
  'openrouterKey', 'geminiKey', 'openaiCompatibleKey',
  'openaiKey', 'xaiKey', 'groqKey', 'deepseekKey',
  'togetherKey', 'mistralKey', 'anthropicKey', 'fireworksKey',
  'perplexityKey', 'zhipuKey', 'kimiKey', 'cerebrasKey',
  'deepinfraKey', 'doubaoKey', 'qwenKey', 'hunyuanKey',
  'baichuanKey', 'minimaxKey', 'yiKey', 'stepfunKey',
  'siliconflowKey', 'cohereKey', 'novitaKey',
];

const KEY_TO_PROVIDER: Record<SecretKey, ApiProvider> = {
  openrouterKey: 'openrouter', geminiKey: 'google', openaiCompatibleKey: 'openai_compatible',
  openaiKey: 'openai', xaiKey: 'xai', groqKey: 'groq', deepseekKey: 'deepseek',
  togetherKey: 'together', mistralKey: 'mistral', anthropicKey: 'anthropic', fireworksKey: 'fireworks',
  perplexityKey: 'perplexity', zhipuKey: 'zhipu', kimiKey: 'kimi', cerebrasKey: 'cerebras',
  deepinfraKey: 'deepinfra', doubaoKey: 'doubao', qwenKey: 'qwen', hunyuanKey: 'hunyuan',
  baichuanKey: 'baichuan', minimaxKey: 'minimax', yiKey: 'yi', stepfunKey: 'stepfun',
  siliconflowKey: 'siliconflow', cohereKey: 'cohere', novitaKey: 'novita',
};

export class SecretStore {
  private readonly cache = new Map<SecretKey, string>();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async load(): Promise<void> {
    for (const key of SECRET_KEYS) {
      const value = await this.secrets.get(key);
      if (value) this.cache.set(key, value);
      else this.cache.delete(key);
    }
  }

  get(key: SecretKey): string | undefined {
    return this.cache.get(key);
  }

  async set(key: SecretKey, value: string): Promise<void> {
    this.cache.set(key, value);
    await this.secrets.store(key, value);
  }

  configuredProviders(): ApiProvider[] {
    return SECRET_KEYS.filter((k) => !!this.cache.get(k)).map((k) => KEY_TO_PROVIDER[k]);
  }
}

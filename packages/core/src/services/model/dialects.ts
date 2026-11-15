import type { AiProvider } from '../../interfaces/IConfig';

/** The wire protocols the built-in runner speaks, one adapter each. */
export type Dialect = 'chat-completions' | 'responses' | 'anthropic-messages' | 'gemini';

// Kept apart from `ProviderRegistration.serviceType`, which the API planner
// still routes on: moving a provider here changes how the runner reaches it and
// nothing else. A total record, so a vendor added to `AiProvider` fails the
// typecheck until it is given a dialect.
const DIALECTS: Readonly<Record<AiProvider, Dialect>> = {
  anthropic: 'anthropic-messages',
  openai: 'responses',
  google: 'gemini',
  openrouter: 'chat-completions',
  openai_compatible: 'chat-completions',
  xai: 'chat-completions',
  groq: 'chat-completions',
  deepseek: 'chat-completions',
  together: 'chat-completions',
  mistral: 'chat-completions',
  fireworks: 'chat-completions',
  perplexity: 'chat-completions',
  zhipu: 'chat-completions',
  kimi: 'chat-completions',
  cerebras: 'chat-completions',
  deepinfra: 'chat-completions',
  doubao: 'chat-completions',
  qwen: 'chat-completions',
  hunyuan: 'chat-completions',
  baichuan: 'chat-completions',
  minimax: 'chat-completions',
  yi: 'chat-completions',
  stepfun: 'chat-completions',
  siliconflow: 'chat-completions',
  cohere: 'chat-completions',
  novita: 'chat-completions',
};

export function dialectOf(provider: AiProvider): Dialect {
  return DIALECTS[provider];
}

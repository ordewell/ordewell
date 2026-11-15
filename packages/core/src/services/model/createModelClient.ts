import type { AiProvider } from '../../interfaces/IConfig';
import { VENDORS } from '../apiProviders';
import { createAnthropicMessagesClient } from './adapters/anthropicMessages';
import { createChatCompletionsClient } from './adapters/chatCompletions';
import { createGeminiClient } from './adapters/gemini';
import { createResponsesClient } from './adapters/responses';
import { dialectOf, type Dialect } from './dialects';
import { DEFAULT_STREAM_TIMEOUTS, withStreamTimeouts, type StreamTimeouts } from './streamTimeouts';
import type { AdapterFactory, ModelClient } from './types';

// Each dialect's adapter owns one file and exports one factory; this table is
// the only place they meet, so filling an adapter never touches another's file.
const ADAPTERS: Readonly<Record<Dialect, AdapterFactory>> = {
  'chat-completions': createChatCompletionsClient,
  responses: createResponsesClient,
  'anthropic-messages': createAnthropicMessagesClient,
  gemini: createGeminiClient,
};

export interface ModelClientOptions {
  provider: AiProvider;
  /** Empty for a keyless local endpoint. */
  apiKey: string;
  /** The provider's default endpoint when absent. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** How long its streams may go quiet; the defaults when absent. */
  timeouts?: StreamTimeouts;
}

/**
 * A client for the provider, in its dialect, whose streams fail once they go
 * quiet: here, over every adapter alike, rather than in each. It does not
 * retry: wrap it in `withRetry`.
 */
export function createModelClient(options: ModelClientOptions): ModelClient {
  const { provider } = options;
  const client = ADAPTERS[dialectOf(provider)]({
    provider,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl || VENDORS[provider].defaultBaseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return withStreamTimeouts(client, options.timeouts ?? DEFAULT_STREAM_TIMEOUTS);
}

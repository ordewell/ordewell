import { ModelError } from '../ModelError';
import type { AdapterOptions, ModelClient } from '../types';

// The anthropic-messages dialect, on the official @anthropic-ai/sdk SDK, with its
// own retries off (maxRetries: 0): `withRetry` is the one policy. Not built yet:
// the task that fills it replaces this file alone, since `createModelClient`
// already routes the dialect here.

export function createAnthropicMessagesClient(_options: AdapterOptions): ModelClient {
  throw new ModelError({ kind: 'fatal', message: 'The anthropic-messages model dialect is not implemented yet.' });
}

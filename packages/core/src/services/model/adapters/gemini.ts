import { ModelError } from '../ModelError';
import type { AdapterOptions, ModelClient } from '../types';

// The gemini dialect, on the official @google/genai SDK, with its
// own retries off: `withRetry` is the one policy. Not built yet:
// the task that fills it replaces this file alone, since `createModelClient`
// already routes the dialect here.

export function createGeminiClient(_options: AdapterOptions): ModelClient {
  throw new ModelError({ kind: 'fatal', message: 'The gemini model dialect is not implemented yet.' });
}

import { isModelError, type ModelError } from './ModelError';
import type { ModelClient, ModelEvent, ModelRequest } from './types';

// The one retry policy every model request goes through, after opencode v2's
// model-retry: each SDK's own retries are off (maxRetries: 0 in every adapter),
// so a request is never retried twice over by layers that cannot see each other.

export interface RetryPolicy {
  /** The first gap; each later one doubles. */
  initialDelayMs: number;
  /** No gap the policy chooses itself grows past this. */
  maxDelayMs: number;
  /** A provider's Retry-After is honoured as a floor up to here. */
  maxRetryAfterMs: number;
  /** Spread of each gap, as a fraction either side, so parallel tasks do not retry in step. */
  jitter: number;
  /** Attempts in all, the first included, for a failure the provider answered. */
  maxAttempts: number;
  /** How long an unreachable provider is retried for, counted from the first attempt. */
  networkWindowMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
  initialDelayMs: 2_000,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 15 * 60_000,
  jitter: 0.2,
  maxAttempts: 6,
  networkWindowMs: 5 * 60_000,
};

export interface RetryNotice {
  /** The attempt that failed, from 1. */
  attempt: number;
  delayMs: number;
  error: ModelError;
}

export interface RetryOptions {
  policy?: Partial<RetryPolicy>;
  onRetry?: (notice: RetryNotice) => void;
  /** Injected so a test can fix the jitter. */
  random?: () => number;
  now?: () => number;
}

/**
 * The gap before the next attempt, or `undefined` to give up. Only a
 * `transient` or `rate-limited` failure is retried: a `usage-limit` waits for
 * its reset elsewhere, and the rest would fail the same way again.
 */
export function retryDelay(
  error: ModelError,
  attempt: number,
  elapsedMs: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number | undefined {
  if (error.kind !== 'transient' && error.kind !== 'rate-limited') return undefined;
  if (error.network) {
    if (elapsedMs >= policy.networkWindowMs) return undefined;
  } else if (attempt >= Math.min(policy.maxAttempts, error.maxAttempts ?? Infinity)) {
    return undefined;
  }
  const backoff = Math.min(policy.initialDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const jittered = Math.min(backoff * (1 + policy.jitter * (2 * random() - 1)), policy.maxDelayMs);
  const floor = error.retryAfterMs ?? 0;
  return Math.round(Math.min(Math.max(jittered, floor), policy.maxRetryAfterMs));
}

/**
 * The client, retrying a failed request under the policy. Only a request that
 * failed before streaming anything is retried: once an event has reached the
 * caller, a second attempt would stream it twice.
 */
export function withRetry(client: ModelClient, options: RetryOptions = {}): ModelClient {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  return {
    provider: client.provider,
    dialect: client.dialect,
    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
      const started = now();
      for (let attempt = 1; ; attempt++) {
        let streamed = false;
        try {
          for await (const event of client.stream(request, signal)) {
            streamed = true;
            yield event;
          }
          return;
        } catch (err) {
          if (streamed || !isModelError(err) || signal?.aborted) throw err;
          const delayMs = retryDelay(err, attempt, now() - started, policy, random);
          if (delayMs === undefined) throw err;
          options.onRetry?.({ attempt, delayMs, error: err });
          await sleep(delayMs, signal);
        }
      }
    },
  };
}

/** A pause the signal cuts short, rejecting with its reason. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

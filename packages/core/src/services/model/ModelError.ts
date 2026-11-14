/**
 * What went wrong with a model request, in the terms a caller acts on:
 * `transient` and `rate-limited` are worth retrying, `usage-limit` waits for a
 * quota to reset (ADR-0044's wait), and the rest end the attempt.
 */
export type ModelErrorKind =
  | 'transient'
  | 'rate-limited'
  | 'usage-limit'
  | 'context-overflow'
  | 'auth'
  | 'bad-request'
  | 'fatal';

export interface ModelErrorInit {
  kind: ModelErrorKind;
  message: string;
  status?: number;
  /** The provider's own error code, as its body or SDK reported it. */
  code?: string;
  /** The request parameter the provider blamed, where it named one. */
  param?: string;
  /** `rate-limited`: how long the provider asked to wait, from Retry-After or its reset headers. */
  retryAfterMs?: number;
  /** `usage-limit`: when the quota resets (epoch ms), where the provider said. */
  resetsAt?: number;
  /** `transient`: the provider could not be reached at all, which earns a longer retry window. */
  network?: boolean;
  cause?: unknown;
}

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly param?: string;
  readonly retryAfterMs?: number;
  readonly resetsAt?: number;
  readonly network?: boolean;

  constructor(init: ModelErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ModelError';
    this.kind = init.kind;
    if (init.status !== undefined) this.status = init.status;
    if (init.code !== undefined) this.code = init.code;
    if (init.param !== undefined) this.param = init.param;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.resetsAt !== undefined) this.resetsAt = init.resetsAt;
    if (init.network) this.network = true;
  }
}

export function isModelError(err: unknown): err is ModelError {
  return err instanceof ModelError;
}

/** A failed HTTP exchange, as an adapter reads it off its SDK's error. */
export interface HttpFailure {
  message: string;
  status?: number;
  /** A `Headers`, or a plain record of header names to values. */
  headers?: unknown;
  code?: string | number | null;
  type?: string | null;
  param?: string | null;
  /** The request never reached the provider: refused, unresolved, reset. */
  network?: boolean;
  timeout?: boolean;
  /** Overrides what the headers say, for a provider that puts the delay in its body (Gemini's RetryInfo). */
  retryAfterMs?: number;
  cause?: unknown;
}

// Provider error codes and types that mean an exhausted balance or quota, not
// a per-minute limit: OpenAI's, Moonshot's and Zhipu's (1113: account in arrears).
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'exceeded_current_quota_error',
  'insufficient_balance',
  'insufficient_balance_error',
  '1113',
]);

// A failure reported inside a stream has no status; these types say the server's side broke.
const SERVER_TYPES = new Set(['server_error', 'api_error', 'overloaded_error', 'internal_error']);

const OVERFLOW_CODES = new Set(['context_length_exceeded', 'context_window_exceeded', 'model_context_window_exceeded']);

// Only for a refusal with no code at all: many compatible servers answer an
// overflow with a bare 400 whose message alone says so, OpenAI's wording echoed.
const OVERFLOW_WORDING = /maximum context length|context length exceeded|context window|prompt is too long/i;

/**
 * Classify a failed exchange from its status, its provider code and its
 * headers. A message is read only where no code exists to read instead.
 */
export function classifyHttpFailure(failure: HttpFailure, now: number = Date.now()): ModelError {
  const base = {
    message: failure.message,
    cause: failure.cause,
    ...(failure.code !== undefined && failure.code !== null ? { code: String(failure.code) } : {}),
    ...(failure.param ? { param: failure.param } : {}),
  };
  const code = base.code;
  const type = failure.type ?? undefined;
  // A mid-stream error carries no status, but OpenRouter puts the HTTP one in its code.
  const status = failure.status ?? (typeof failure.code === 'number' && failure.code >= 400 && failure.code < 600 ? failure.code : undefined);
  const withStatus = status === undefined ? base : { ...base, status };

  if (status === undefined) {
    if (failure.network) return new ModelError({ ...withStatus, kind: 'transient', network: true });
    if (failure.timeout || (failure.type && SERVER_TYPES.has(failure.type))) return new ModelError({ ...withStatus, kind: 'transient' });
    return new ModelError({ ...withStatus, kind: 'fatal' });
  }
  const headers = headerReader(failure.headers);
  if (isQuota(code, type)) return usageLimit(withStatus, headers, now);
  if (OVERFLOW_CODES.has(code ?? '') || (status === 400 && code === undefined && OVERFLOW_WORDING.test(failure.message))) {
    return new ModelError({ ...withStatus, kind: 'context-overflow' });
  }
  if (status === 413) return new ModelError({ ...withStatus, kind: 'context-overflow' });
  if (status === 401 || status === 403) return new ModelError({ ...withStatus, kind: 'auth' });
  if (status === 402) return usageLimit(withStatus, headers, now);
  if (status === 429) {
    const retryAfterMs = failure.retryAfterMs ?? retryAfterFromHeaders(headers, now);
    return new ModelError({ ...withStatus, kind: 'rate-limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  if (status === 408 || status === 409 || status >= 500) {
    const retryAfterMs = failure.retryAfterMs ?? retryAfterFromHeaders(headers, now);
    return new ModelError({ ...withStatus, kind: 'transient', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  if (status >= 400) return new ModelError({ ...withStatus, kind: 'bad-request' });
  return new ModelError({ ...withStatus, kind: 'fatal' });
}

function isQuota(code: string | undefined, type: string | undefined): boolean {
  return (code !== undefined && QUOTA_CODES.has(code)) || (type !== undefined && QUOTA_CODES.has(type));
}

function usageLimit(init: Omit<ModelErrorInit, 'kind'>, headers: HeaderReader, now: number): ModelError {
  const wait = retryAfterFromHeaders(headers, now);
  return new ModelError({ ...init, kind: 'usage-limit', ...(wait !== undefined ? { resetsAt: now + wait } : {}) });
}

export type HeaderReader = (name: string) => string | undefined;

/** Reads a header by name off a `Headers` or a plain record, case-insensitively. */
export function headerReader(headers: unknown): HeaderReader {
  if (!headers || typeof headers !== 'object') return () => undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    return (name) => {
      const value: unknown = get.call(headers, name);
      return typeof value === 'string' ? value : undefined;
    };
  }
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') lowered.set(key.toLowerCase(), value);
  }
  return (name) => lowered.get(name.toLowerCase());
}

const RESET_PAIRS: ReadonlyArray<readonly [reset: string, remaining: string]> = [
  ['x-ratelimit-reset-requests', 'x-ratelimit-remaining-requests'],
  ['x-ratelimit-reset-tokens', 'x-ratelimit-remaining-tokens'],
  ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-requests-remaining'],
  ['anthropic-ratelimit-tokens-reset', 'anthropic-ratelimit-tokens-remaining'],
  ['anthropic-ratelimit-input-tokens-reset', 'anthropic-ratelimit-input-tokens-remaining'],
  ['anthropic-ratelimit-output-tokens-reset', 'anthropic-ratelimit-output-tokens-remaining'],
];

/**
 * How long the headers ask a caller to wait, in ms: `retry-after-ms`, then
 * `retry-after` (seconds or an HTTP date), then the per-limit reset headers
 * (the exhausted limit's, else the longest), then `x-ratelimit-reset`.
 */
export function retryAfterFromHeaders(headers: HeaderReader, now: number = Date.now()): number | undefined {
  const ms = finiteNonNegative(Number(headers('retry-after-ms')));
  if (ms !== undefined) return ms;
  const after = headers('retry-after');
  if (after !== undefined) {
    const seconds = finiteNonNegative(Number(after));
    if (seconds !== undefined) return seconds * 1000;
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const resets: number[] = [];
  const exhausted: number[] = [];
  for (const [resetName, remainingName] of RESET_PAIRS) {
    const value = headers(resetName);
    if (value === undefined) continue;
    const wait = resetValue(value, now);
    if (wait === undefined) continue;
    resets.push(wait);
    if (headers(remainingName) === '0') exhausted.push(wait);
  }
  const pick = exhausted.length > 0 ? exhausted : resets;
  if (pick.length > 0) return Math.max(...pick);
  const reset = headers('x-ratelimit-reset');
  if (reset !== undefined) {
    const n = Number(reset);
    // OpenRouter sends epoch ms; others epoch seconds or a delay in seconds.
    if (Number.isFinite(n)) return n > 1e12 ? Math.max(0, n - now) : n > 1e9 ? Math.max(0, n * 1000 - now) : finiteNonNegative(n * 1000);
  }
  return undefined;
}

/** A reset header: OpenAI's duration (`1m30s`, `250ms`) or Anthropic's RFC 3339 instant. */
function resetValue(value: string, now: number): number | undefined {
  const duration = parseDuration(value);
  if (duration !== undefined) return duration;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

const UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

function parseDuration(value: string): number | undefined {
  const parts = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(value.trim());
  if (!parts || parts.slice(1).every((p) => p === undefined)) return undefined;
  const [, h, m, s, ms] = parts;
  return Math.round(Number(h ?? 0) * UNIT_MS.h + Number(m ?? 0) * UNIT_MS.m + Number(s ?? 0) * UNIT_MS.s + Number(ms ?? 0));
}

function finiteNonNegative(n: number): number | undefined {
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

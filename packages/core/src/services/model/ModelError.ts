import { redactAgentText } from '../../utils/redactSecrets';

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
  /** `transient`: fewer attempts in all than the retry policy's, for a failure only possibly transient. */
  maxAttempts?: number;
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
  readonly maxAttempts?: number;

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
    if (init.maxAttempts !== undefined) this.maxAttempts = init.maxAttempts;
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
  /**
   * An aggregator's error `metadata` (OpenRouter's): the upstream provider it
   * wrapped, by `provider_name`, its verbatim body in `raw`, and the canonical
   * `error_type` and upstream `provider_code`.
   */
  metadata?: unknown;
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
// overflow with a bare 400 whose message alone says so: OpenAI's wording echoed,
// and xAI's, LM Studio's and llama.cpp's own, and Google's as an aggregator relays it.
const OVERFLOW_WORDING = /maximum context length|context length exceeded|context window|prompt is too long|maximum prompt length|greater than the context length|exceeds the available context size|input token count.*exceeds/i;

/**
 * Classify a failed exchange from its status, its provider code and its
 * headers. A message is read only where no code exists to read instead.
 *
 * An aggregator's refusal that wraps an upstream provider's failure is classed
 * by what the upstream said (ADR-0070): a bare "Provider returned error"
 * 400 is as often the upstream's outage as a fault in the request.
 */
export function classifyHttpFailure(failure: HttpFailure, now: number = Date.now()): ModelError {
  const upstream = readUpstream(failure.metadata);
  const base = {
    message: upstream ? withUpstream(failure.message, upstream) : failure.message,
    cause: failure.cause,
    ...(failure.code !== undefined && failure.code !== null ? { code: String(failure.code) } : {}),
    ...(failure.param ? { param: failure.param } : {}),
  };
  // A mid-stream error carries no status, but OpenRouter puts the HTTP one in its code.
  const status = failure.status ?? (typeof failure.code === 'number' && isHttpError(failure.code) ? failure.code : undefined);
  const init = status === undefined ? base : { ...base, status };
  const headers = headerReader(failure.headers);
  const outer: Reading = { status, code: base.code, type: failure.type ?? undefined, message: failure.message };

  // The aggregator's own verdicts (a key, credits, moderation, its rate limit) stand as it gave them.
  if (upstream && (status === undefined || status === 400 || status >= 500)) {
    const reading = upstreamReading(upstream, status);
    if (reading) return classify(reading, init, failure, headers, now);
    // Nothing to class it by: likely the upstream's fault, so worth a few tries, not a full retry budget.
    if (status === undefined || status === 400) return new ModelError({ ...init, kind: 'transient', maxAttempts: UNEXPLAINED_WRAPPER_ATTEMPTS });
  }
  if (status === undefined) {
    if (failure.network) return new ModelError({ ...init, kind: 'transient', network: true });
    if (failure.timeout || (outer.type && SERVER_TYPES.has(outer.type))) return new ModelError({ ...init, kind: 'transient' });
    return new ModelError({ ...init, kind: 'fatal' });
  }
  return classify(outer, init, failure, headers, now);
}

/** The fields a failure is classed by: the exchange's own, or the upstream's an aggregator wrapped. */
interface Reading {
  status: number | undefined;
  code?: string;
  type?: string;
  message: string;
}

function classify(reading: Reading, init: Omit<ModelErrorInit, 'kind'>, failure: HttpFailure, headers: HeaderReader, now: number): ModelError {
  const { status, code, type } = reading;
  if (isQuota(code, type)) return usageLimit(init, headers, now);
  if (readsAsOverflow(reading)) return new ModelError({ ...init, kind: 'context-overflow' });
  if (status === undefined) return new ModelError({ ...init, kind: 'fatal' });
  if (status === 413) return new ModelError({ ...init, kind: 'context-overflow' });
  if (status === 401 || status === 403) return new ModelError({ ...init, kind: 'auth' });
  if (status === 402) return usageLimit(init, headers, now);
  if (status === 429) {
    const retryAfterMs = failure.retryAfterMs ?? retryAfterFromHeaders(headers, now);
    return new ModelError({ ...init, kind: 'rate-limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  if (status === 408 || status === 409 || status >= 500) {
    const retryAfterMs = failure.retryAfterMs ?? retryAfterFromHeaders(headers, now);
    return new ModelError({ ...init, kind: 'transient', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  if (status >= 400) return new ModelError({ ...init, kind: 'bad-request' });
  return new ModelError({ ...init, kind: 'fatal' });
}

// Codes that name only the class of a refusal, or repeat its status (OpenRouter's
// numeric code), and so say less than the message does.
const GENERIC_CODES = new Set(['invalid_request_error', 'invalid_request', 'bad_request']);

function readsAsOverflow({ status, code, message }: Reading): boolean {
  if (code !== undefined && OVERFLOW_CODES.has(code)) return true;
  const saysNothing = code === undefined || code === String(status) || GENERIC_CODES.has(code);
  return status === 400 && saysNothing && OVERFLOW_WORDING.test(message);
}

function isHttpError(n: number): boolean {
  return Number.isInteger(n) && n >= 400 && n < 600;
}

/** Retries of an aggregator's refusal that gave no upstream reason: attempts in all, the first included. */
const UNEXPLAINED_WRAPPER_ATTEMPTS = 3;

/** What an aggregator's body says of the upstream provider's own failure. */
interface Upstream {
  provider?: string;
  message?: string;
  status?: number;
  code?: string;
  type?: string;
  /** OpenRouter's canonical `error_type`. */
  errorType?: string;
}

// OpenRouter's canonical error types, by the status its documentation gives
// each. `unmapped` (an upstream error it could not place) is left out: it says
// nothing to class by.
const ERROR_TYPE_STATUS: Readonly<Record<string, number>> = {
  context_length_exceeded: 400,
  max_tokens_exceeded: 400,
  token_limit_exceeded: 400,
  string_too_long: 400,
  invalid_request: 400,
  invalid_prompt: 400,
  invalid_image: 400,
  image_too_large: 400,
  image_too_small: 400,
  unsupported_image_format: 400,
  image_download_failed: 400,
  authentication: 401,
  payment_required: 402,
  permission_denied: 403,
  content_policy_violation: 403,
  refusal: 403,
  not_found: 404,
  image_not_found: 404,
  precondition_failed: 412,
  payload_too_large: 413,
  unprocessable: 422,
  rate_limit_exceeded: 429,
  server: 500,
  provider_unavailable: 502,
  provider_overloaded: 503,
  timeout: 504,
};

// Upstream error types and codes that carry no status but say which way it failed.
const RATE_TYPES = new Set(['rate_limit_error', 'rate_limit_exceeded', 'rate_limited', 'RESOURCE_EXHAUSTED']);
const UPSTREAM_SERVER_TYPES = new Set([...SERVER_TYPES, 'UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED']);

/**
 * The upstream's failure as a reading to class by, or `undefined` when it gave
 * no status, code, type or overflow wording. A reason the upstream gave without
 * a status takes the wrapper's.
 */
function upstreamReading(upstream: Upstream, wrapperStatus: number | undefined): Reading | undefined {
  const message = upstream.message ?? '';
  // Either may name the class: OpenAI's rate limit puts it in the code, beside a type of "requests" or "tokens".
  const named = [upstream.type, upstream.code].filter((n): n is string => n !== undefined);
  const status = upstream.status
    ?? (upstream.errorType !== undefined ? ERROR_TYPE_STATUS[upstream.errorType] : undefined)
    ?? (named.some((n) => UPSTREAM_SERVER_TYPES.has(n)) ? 503 : undefined)
    ?? (named.some((n) => RATE_TYPES.has(n)) ? 429 : undefined);
  const code = upstream.errorType === 'context_length_exceeded' ? upstream.errorType : upstream.code;
  const reading: Reading = { status: status ?? wrapperStatus, message, ...(code !== undefined ? { code } : {}), ...(upstream.type !== undefined ? { type: upstream.type } : {}) };
  const explained = status !== undefined || code !== undefined || upstream.type !== undefined || readsAsOverflow({ ...reading, status: 400 });
  return explained ? reading : undefined;
}

function readUpstream(metadata: unknown): Upstream | undefined {
  if (!isRecord(metadata)) return undefined;
  const upstream: Upstream = {};
  const provider = text(metadata.provider_name);
  if (provider) upstream.provider = provider;
  const errorType = text(metadata.error_type);
  if (errorType) upstream.errorType = errorType;
  readCode(upstream, metadata.provider_code);
  const raw = parseRaw(metadata.raw);
  // OpenAI's and Google's bodies nest the error under `error`; Anthropic's too, beside a `type` of "error".
  const error = isRecord(raw) && isRecord(raw.error) ? raw.error : raw;
  if (typeof error === 'string') {
    upstream.message = error;
  } else if (isRecord(error)) {
    upstream.message = text(error.message) ?? text(error.detail) ?? JSON.stringify(error);
    readCode(upstream, error.code);
    // Google's `status` is a name ("UNAVAILABLE"); some servers give the HTTP one there.
    if (typeof error.status === 'number' && isHttpError(error.status)) upstream.status ??= error.status;
    const type = text(error.type) ?? text(error.status);
    if (type) upstream.type = type;
  }
  if (upstream.message !== undefined) upstream.message = upstream.message.trim() || undefined;
  if (upstream.message === undefined) delete upstream.message;
  return Object.keys(upstream).length > 0 ? upstream : undefined;
}

function readCode(upstream: Upstream, code: unknown): void {
  if (typeof code === 'number') {
    if (isHttpError(code)) upstream.status ??= code;
  } else if (typeof code === 'string' && code) {
    upstream.code ??= code;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** `raw` is the upstream's body, usually as the JSON text it sent, sometimes parsed already. */
function parseRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

// Enough of an upstream's message to tell what it refused, not its whole echo of the request.
const UPSTREAM_DETAIL_CHARS = 400;

/**
 * The aggregator's own words, then the upstream's: "Provider returned error"
 * alone tells a reader nothing. The upstream's message may echo the request,
 * so it is redacted whole before it is cut, as a runner's error text is.
 */
function withUpstream(message: string, upstream: Upstream): string {
  if (upstream.provider === undefined && upstream.message === undefined) return message;
  const detail = upstream.message === undefined ? undefined : bounded(redactAgentText(upstream.message.replace(/\s+/g, ' ')));
  const from = upstream.provider ?? 'upstream';
  return detail === undefined ? `${message} (from ${from})` : `${message} (${from}: ${detail})`;
}

function bounded(value: string): string {
  return value.length <= UPSTREAM_DETAIL_CHARS ? value : `${value.slice(0, UPSTREAM_DETAIL_CHARS)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

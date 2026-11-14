import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionCallingConfig,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  type ThinkingConfig,
} from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import { classifyHttpFailure, ModelError } from '../ModelError';
import type {
  AdapterOptions,
  EffortLevel,
  FinishReason,
  ModelClient,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelToolCall,
  ModelUsage,
  ToolChoice,
} from '../types';

// The gemini dialect, on the official @google/genai SDK, with its own retries
// off (`retryOptions.attempts: 1`): `withRetry` is the one policy. Gemini
// caches implicitly, so the request's cache hints are ignored.

/**
 * A model turn as Gemini streamed it. Thought signatures ride on the parts
 * that carry them (a function call's most of all), and the API rejects a
 * Gemini 3 function-calling step whose signatures did not come back in
 * place, so the parts are replayed as recorded, never rebuilt from the text.
 */
interface GeminiState {
  parts: Part[];
}

// The Gemini API's documented stand-in for a signature the history lacks, as
// when the turn came from another provider. Gemini 3 and later check them.
const SIGNATURE_PLACEHOLDER = 'skip_thought_signature_validator';

/** Gemini 2.5 sets a thinking budget in tokens. */
const BUDGET: Readonly<Record<EffortLevel, number>> = {
  low: 1024,
  medium: 8192,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
};
// Flash and Flash-Lite stop at 24576; Pro goes to 32768.
const FLASH_BUDGET_CAP = 24_576;

export function createGeminiClient(options: AdapterOptions): ModelClient {
  const { provider } = options;
  // A model that refused a thinking setting is sent none again, for this client's life.
  const refusesThinking = new Set<string>();
  const sdk = options.apiKey
    ? new GoogleGenAI({
      apiKey: options.apiKey,
      // The SDK defaults to the stable v1, which lacks thinking levels and thought signatures.
      apiVersion: 'v1beta',
      httpOptions: {
        retryOptions: { attempts: 1 },
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      },
    })
    : undefined;

  const open = async (request: ModelRequest, withThinking: boolean, signal?: AbortSignal) => {
    if (!sdk) throw new ModelError({ kind: 'auth', message: 'No Google API key is configured.' });
    try {
      return await sdk.models.generateContentStream({
        model: request.model,
        contents: wireContents(request),
        config: wireConfig(request, withThinking, signal),
      });
    } catch (err) {
      throw toModelError(err, signal);
    }
  };

  return {
    provider,
    dialect: 'gemini',
    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
      signal?.throwIfAborted();
      const wantsThinking = request.effort !== undefined && !refusesThinking.has(request.model);
      let chunks: AsyncIterable<GenerateContentResponse>;
      try {
        chunks = await open(request, wantsThinking, signal);
      } catch (err) {
        if (!wantsThinking || !(err instanceof ModelError) || !refusedThinking(err)) throw err;
        refusesThinking.add(request.model);
        chunks = await open(request, false, signal);
      }
      yield* readStream(chunks, signal);
    },
  };
}

/** A 400 that blames the thinking setting; a missing-signature refusal names a signature, not a setting. */
function refusedThinking(err: ModelError): boolean {
  return err.kind === 'bad-request'
    && /thinking|include_?thoughts/i.test(err.message)
    && !/signature/i.test(err.message);
}

// --- Requests -------------------------------------------------------------

function wireConfig(request: ModelRequest, withThinking: boolean, signal?: AbortSignal): GenerateContentConfig {
  const config: GenerateContentConfig = {};
  if (signal) config.abortSignal = signal;
  if (request.system.length > 0) config.systemInstruction = request.system.map((p) => p.text).join('\n\n');
  if (request.maxOutputTokens !== undefined) config.maxOutputTokens = request.maxOutputTokens;
  if (request.tools.length > 0) {
    config.tools = [{
      functionDeclarations: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Raw JSON Schema: `parameters` takes only Gemini's own OpenAPI subset.
        parametersJsonSchema: t.parameters,
      })),
    }];
    config.toolConfig = { functionCallingConfig: wireToolChoice(request.toolChoice ?? 'auto') };
  }
  const thinking = withThinking && request.effort ? thinkingConfig(request.model, request.effort) : undefined;
  if (thinking) config.thinkingConfig = thinking;
  return config;
}

function wireToolChoice(choice: ToolChoice): FunctionCallingConfig {
  if (choice === 'auto') return { mode: FunctionCallingConfigMode.AUTO };
  if (choice === 'none') return { mode: FunctionCallingConfigMode.NONE };
  if (choice === 'required') return { mode: FunctionCallingConfigMode.ANY };
  // Every declaration stays in the request; ANY limited to one name forces that tool.
  return { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [choice.name] };
}

/**
 * Ordewell's effort onto the model's own knob. Gemini 2.5 takes a token
 * budget and Gemini 3 and later a level; sending both is a 400. A model that
 * does not think (older Gemini, Gemma) gets nothing, and an unknown id is
 * treated as a current Gemini, since a refusal is retried without.
 */
export function thinkingConfig(model: string, effort: EffortLevel): ThinkingConfig | undefined {
  const id = model.toLowerCase().replace(/^models\//, '');
  if (!id.startsWith('gemini-') || /^gemini-(1\.|2\.0)/.test(id)) return undefined;
  // Thought summaries are what the runner streams as thinking deltas.
  if (id.startsWith('gemini-2.5')) {
    const cap = id.includes('pro') ? BUDGET.max : FLASH_BUDGET_CAP;
    return { includeThoughts: true, thinkingBudget: Math.min(BUDGET[effort], cap) };
  }
  return { includeThoughts: true, thinkingLevel: thinkingLevel(id, effort) };
}

function thinkingLevel(id: string, effort: EffortLevel): ThinkingLevel {
  switch (effort) {
    case 'low':
      return ThinkingLevel.LOW;
    case 'medium':
      // Gemini 3 Pro takes only low and high, and high is its default.
      return /^gemini-3-pro/.test(id) ? ThinkingLevel.HIGH : ThinkingLevel.MEDIUM;
    case 'high':
      return ThinkingLevel.HIGH;
    default:
      // XHIGH is for models that list it; the rest top out at high.
      return id.includes('hydrogen') ? ThinkingLevel.XHIGH : ThinkingLevel.HIGH;
  }
}

function wireContents(request: ModelRequest): Content[] {
  const placeholderSignatures = requiresSignatures(request.model);
  // A result is keyed by the id the API gave the call, which it may not have given.
  const apiIds = new Map<string, string>();
  const out: Content[] = [];
  for (const message of request.messages) {
    const content = wireMessage(message, placeholderSignatures, apiIds);
    if (content) out.push(content);
  }
  return out;
}

/** Gemini 3 and later reject a function call whose signature is missing; 2.5 and older ignore them. */
function requiresSignatures(model: string): boolean {
  const major = /^(?:models\/)?gemini-(\d+)/i.exec(model)?.[1];
  return major !== undefined ? Number(major) >= 3 : /^(?:models\/)?gemini-(?:flash|pro)/i.test(model);
}

function wireMessage(message: ModelMessage, placeholderSignatures: boolean, apiIds: Map<string, string>): Content | undefined {
  switch (message.role) {
    case 'user':
      return { role: 'user', parts: [{ text: message.text }] };
    case 'tool':
      return {
        role: 'user',
        parts: message.results.map((r) => {
          const id = apiIds.get(r.callId);
          return {
            functionResponse: {
              ...(id !== undefined ? { id } : {}),
              name: r.name,
              // Google's convention for a function's result: `output`, or `error` on failure.
              response: r.isError ? { error: r.output } : { output: r.output },
            },
          };
        }),
      };
    case 'assistant': {
      const calls = message.toolCalls ?? [];
      const state = message.providerState?.dialect === 'gemini' ? readState(message.providerState.data) : undefined;
      const recorded = state?.parts.filter((p) => p.functionCall) ?? [];
      const parts = state && recorded.length === calls.length ? state.parts : rebuiltParts(message.text, calls, placeholderSignatures);
      parts.filter((p) => p.functionCall).forEach((p, i) => {
        // The API's own id for a call; one generated here is never sent back.
        if (p.functionCall?.id !== undefined && calls[i]) apiIds.set(calls[i].id, p.functionCall.id);
      });
      return parts.length > 0 ? { role: 'model', parts } : undefined;
    }
  }
}

/** A turn with no usable record, as when it came from another provider. */
function rebuiltParts(text: string, calls: ModelToolCall[], placeholderSignature: boolean): Part[] {
  const parts: Part[] = [];
  if (text) parts.push({ text });
  calls.forEach((c, i) => {
    parts.push({
      functionCall: { name: c.name, args: c.arguments },
      // Only the first call of a step is checked.
      ...(placeholderSignature && i === 0 ? { thoughtSignature: SIGNATURE_PLACEHOLDER } : {}),
    });
  });
  return parts;
}

function readState(data: unknown): GeminiState | undefined {
  if (!isRecord(data) || !Array.isArray(data.parts)) return undefined;
  return { parts: data.parts.filter(isRecord) as Part[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- Streams --------------------------------------------------------------

async function* readStream(chunks: AsyncIterable<GenerateContentResponse>, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  const recorded: Part[] = [];
  let calls = 0;
  let anyContent = false;
  let finishReason: string | undefined;
  let blocked = false;
  let usage: GenerateContentResponse['usageMetadata'];

  try {
    for await (const chunk of chunks) {
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      if (chunk.promptFeedback?.blockReason) blocked = true;
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) finishReason = candidate.finishReason;
      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall?.name) {
          anyContent = true;
          calls++;
          const call = toolCall(part);
          recorded.push(recordedCall(part));
          yield { type: 'tool-call-start', id: call.id, name: call.name };
          if (call.rawArguments !== '{}') yield { type: 'tool-call-delta', id: call.id, argumentsDelta: call.rawArguments };
          yield { type: 'tool-call-complete', call };
          continue;
        }
        record(recorded, part);
        if (part.text) {
          anyContent = true;
          yield { type: part.thought ? 'thinking-delta' : 'text-delta', text: part.text };
        }
      }
    }
  } catch (err) {
    throw toModelError(err, signal);
  }

  if (finishReason === undefined && !blocked) {
    throw new ModelError({ kind: 'transient', message: 'The stream ended before the model finished its reply.' });
  }
  const reported = usage && modelUsage(usage);
  if (reported) yield { type: 'usage', usage: reported };
  if (recorded.some((p) => p.thoughtSignature)) {
    yield { type: 'provider-state', state: { dialect: 'gemini', data: { parts: recorded } satisfies GeminiState } };
  }
  yield { type: 'finish', reason: finish(finishReason, blocked, calls > 0, anyContent) };
}

function toolCall(part: Part): ModelToolCall {
  const args = part.functionCall?.args ?? {};
  return {
    // Gemini does not always name a call; the result still has to.
    id: part.functionCall?.id || `call_${uuidv4()}`,
    name: part.functionCall?.name ?? '',
    arguments: args,
    rawArguments: JSON.stringify(args),
  };
}

function recordedCall(part: Part): Part {
  return { functionCall: part.functionCall, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
}

/**
 * Adds a streamed text part to the recorded turn. Fragments of one run of
 * thought or answer text join into one part, and a signature that arrives on
 * a later fragment, or on an empty part of its own, stays with that run.
 */
function record(recorded: Part[], part: Part): void {
  if (part.text === undefined && !part.thoughtSignature) return;
  const thought = part.thought === true;
  const prior = recorded[recorded.length - 1];
  if (prior && prior.text !== undefined && (prior.thought === true) === thought) {
    prior.text += part.text ?? '';
    if (part.thoughtSignature) prior.thoughtSignature = part.thoughtSignature;
    return;
  }
  recorded.push({
    text: part.text ?? '',
    ...(thought ? { thought: true } : {}),
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
  });
}

const CONTENT_FILTERED = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

function finish(reason: string | undefined, blocked: boolean, hasCalls: boolean, anyContent: boolean): FinishReason {
  if (blocked && reason === undefined) return 'content-filter';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason !== undefined && CONTENT_FILTERED.has(reason)) return 'content-filter';
  if (reason === 'STOP' || hasCalls) return hasCalls ? 'tool-calls' : 'stop';
  // The model produced a call the API could not parse: worth another go.
  if (reason === 'MALFORMED_FUNCTION_CALL') {
    throw new ModelError({ kind: 'transient', message: 'The model produced a malformed function call.', code: reason });
  }
  if (anyContent) return 'stop';
  throw new ModelError({ kind: 'fatal', message: `The model stopped without a reply (${reason ?? 'no reason'}).`, ...(reason ? { code: reason } : {}) });
}

/** Gemini's `candidatesTokenCount` leaves the thoughts out; the neutral output count holds them. */
function modelUsage(u: NonNullable<GenerateContentResponse['usageMetadata']>): ModelUsage | undefined {
  const usage: ModelUsage = {};
  if (u.promptTokenCount !== undefined) usage.inputTokens = u.promptTokenCount;
  if (u.candidatesTokenCount !== undefined || u.thoughtsTokenCount !== undefined) {
    usage.outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  }
  if (u.cachedContentTokenCount !== undefined) usage.cacheReadTokens = u.cachedContentTokenCount;
  if (u.thoughtsTokenCount !== undefined) usage.reasoningTokens = u.thoughtsTokenCount;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

// --- Errors ---------------------------------------------------------------

interface GoogleErrorBody {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown[];
}

// "The input token count (1200000) exceeds the maximum number of tokens allowed (1048575)."
const OVERFLOW = /input token count.*exceeds|exceeds the maximum number of tokens|token limit|context (?:window|length)/i;

/** The SDK's failure as a `ModelError`; a stop keeps the signal's own reason. */
function toModelError(err: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason;
  if (err instanceof ModelError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError) return fromApiError(err);
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return classifyHttpFailure({ message, timeout: true, cause: err });
    // fetch rejects with a TypeError, its cause the socket error; a body cut off mid-stream does the same.
    if (err.name === 'TypeError' || isRecord(err.cause)) return classifyHttpFailure({ message, network: true, cause: err });
    // A stream that ended inside an event, or one the SDK could not parse.
    if (/^Incomplete JSON segment|^exception parsing stream chunk/.test(message)) {
      return new ModelError({ kind: 'transient', message, cause: err });
    }
  }
  return new ModelError({ kind: 'fatal', message, cause: err });
}

function fromApiError(err: ApiError): ModelError {
  const body = errorBody(err.message);
  const message = body?.message ?? err.message;
  const code = body?.status;
  const details = (body?.details ?? []).filter(isRecord);
  const retryAfterMs = retryDelayOf(details);
  const base = { message, status: err.status, ...(code ? { code } : {}), cause: err };

  if (err.status === 429 || code === 'RESOURCE_EXHAUSTED') {
    // A per-day quota will not clear by waiting a minute; a per-minute one will.
    if (isDailyQuota(details)) {
      return new ModelError({ ...base, kind: 'usage-limit', ...(retryAfterMs !== undefined ? { resetsAt: Date.now() + retryAfterMs } : {}) });
    }
    return new ModelError({ ...base, kind: 'rate-limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  if (err.status === 400 && OVERFLOW.test(message)) return new ModelError({ ...base, kind: 'context-overflow' });
  // Google answers a bad key with 400 INVALID_ARGUMENT, not 401.
  if (err.status === 400 && (details.some((d) => d.reason === 'API_KEY_INVALID') || /api key not valid|api key expired/i.test(message))) {
    return new ModelError({ ...base, kind: 'auth' });
  }
  return classifyHttpFailure({
    message,
    status: err.status,
    ...(code ? { code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    cause: err,
  });
}

/** The error object off the SDK's message: the response body as JSON, after a `got status: …` lead-in for a mid-stream failure. */
function errorBody(message: string): GoogleErrorBody | undefined {
  const start = message.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(message.slice(start));
    return isRecord(parsed) && isRecord(parsed.error) ? parsed.error as GoogleErrorBody : undefined;
  } catch {
    return undefined;
  }
}

/** RetryInfo's `retryDelay`, a protobuf duration such as `34s` or `0.5s`. */
function retryDelayOf(details: Array<Record<string, unknown>>): number | undefined {
  const info = details.find((d) => typeof d['@type'] === 'string' && d['@type'].endsWith('RetryInfo'));
  const delay = info?.retryDelay;
  if (typeof delay !== 'string') return undefined;
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(delay)?.[1];
  return seconds !== undefined ? Math.round(Number(seconds) * 1000) : undefined;
}

function isDailyQuota(details: Array<Record<string, unknown>>): boolean {
  return details.some((d) => {
    if (typeof d['@type'] !== 'string' || !d['@type'].endsWith('QuotaFailure') || !Array.isArray(d.violations)) return false;
    return d.violations.some((v) => isRecord(v) && /PerDay|Daily/i.test(`${String(v.quotaId ?? '')} ${String(v.quotaMetric ?? '')}`));
  });
}

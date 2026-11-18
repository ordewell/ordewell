import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type { AiProvider } from '../../../interfaces/IConfig';
import { classifyHttpFailure, ModelError } from '../ModelError';
import { cameThroughWhole } from './cutShort';
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

// The chat-completions dialect: OpenRouter and every OpenAI-compatible vendor,
// on the `openai` SDK. Its own retries are off: `withRetry` is the one policy.

type Chat = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type TextPart = OpenAI.Chat.Completions.ChatCompletionContentPartText & { cache_control?: typeof EPHEMERAL };
type AssistantWire = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
  reasoning_details?: unknown[];
};
type Body = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
  reasoning?: { effort: string };
  provider?: { order: readonly string[]; allow_fallbacks?: boolean };
};

const KEYLESS_PLACEHOLDER = 'not-needed';
const EPHEMERAL = { type: 'ephemeral' } as const;
// Anthropic takes four breakpoints a request; the last message holds one.
const MAX_SYSTEM_BREAKPOINTS = 3;
// OpenRouter serves Claude from several upstreams, and its usual pick, Vertex's
// global endpoint, spreads successive requests over caches that share no
// entries: a step read the step before it only by chance, and paid a write
// every time. Bedrock read it on every step, and Anthropic's own API keeps one
// cache per workspace, so they go first. Fallbacks stay on: an outage, an
// account that excludes both, or reasoning another upstream signed still
// routes elsewhere, uncached. A set order turns OpenRouter's sticky routing
// off, which only ever kept a request on that same scattering endpoint (ADR-0070).
const CACHE_ROUTING = { order: ['anthropic', 'amazon-bedrock'] } as const;

// OpenRouter balances a model's calls over its upstreams, each with a cache of
// its own, and its sticky routing holds a conversation only once it has seen a
// cache hit. So a conversation's later calls name the upstream that served the
// one before first, fallbacks on, so an outage or a rate limit there still
// routes elsewhere. The name rides on the assistant turn's provider state, which
// makes it the conversation's own: no other session, attempt or model sees it
// (ADR-0070).
const PREFER_UPSTREAM = (name: string) => ({ order: [name], allow_fallbacks: true });
// Routing metadata, the upstream's name among it, comes back only when asked for.
const ROUTING_METADATA = { 'X-OpenRouter-Metadata': 'enabled' } as const;
// A model id's routing shortcut is the user's own choice of upstream, which wins.
const USER_ROUTED = /:(nitro|floor)$/;

// Vendors whose models take a top-level `reasoning_effort`; OpenRouter takes
// its own `reasoning` object and drops it for a model without reasoning.
// The rest steer thinking by switches of their own, which this dialect leaves alone.
const EFFORT_FIELD: Partial<Record<AiProvider, 'reasoning_effort' | 'reasoning'>> = {
  openrouter: 'reasoning',
  openai_compatible: 'reasoning_effort',
  xai: 'reasoning_effort',
  groq: 'reasoning_effort',
  cerebras: 'reasoning_effort',
  fireworks: 'reasoning_effort',
  together: 'reasoning_effort',
  deepinfra: 'reasoning_effort',
  perplexity: 'reasoning_effort',
};

// Mistral validates its body strictly and reports usage on the last chunk unasked.
const NO_STREAM_OPTIONS: ReadonlySet<AiProvider> = new Set(['mistral']);

/** Ordewell's effort ids onto the three levels this dialect's vendors take. */
const EFFORT: Readonly<Record<EffortLevel, 'low' | 'medium' | 'high'>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

/** What the next request needs to continue a reasoning model's turn. */
interface ChatState {
  reasoning?: string;
  /** Which delta field carried the reasoning, since only `reasoning_content` vendors want it back. */
  field?: 'reasoning' | 'reasoning_content';
  /** OpenRouter's `reasoning_details`, which carry the signatures an Anthropic or Gemini model checks. */
  details?: Array<Record<string, unknown>>;
  /** The upstream OpenRouter served this turn from, and for which model: another model's upstream is no preference. */
  upstream?: { model: string; name: string };
}

export function createChatCompletionsClient(options: AdapterOptions): ModelClient {
  const { provider } = options;
  const client = new OpenAI({
    apiKey: options.apiKey || KEYLESS_PLACEHOLDER,
    baseURL: options.baseUrl,
    maxRetries: 0,
    // Left unset, the v4 SDK falls back on its bundled node-fetch, which no
    // proxy variable (HTTPS_PROXY, NODE_USE_ENV_PROXY) reaches: the global fetch
    // the built-in runner uses does, and a proxied host resolves no provider without it.
    fetch: options.fetch ?? globalThis.fetch,
  });
  // A model that refused an effort once is sent none again, for this client's life.
  const refusesEffort = new Set<string>();

  const open = async (body: Body, signal?: AbortSignal) => {
    try {
      return await client.chat.completions.create(body, {
        ...(signal ? { signal } : {}),
        ...(provider === 'openrouter' ? { headers: ROUTING_METADATA } : {}),
      });
    } catch (err) {
      throw toModelError(err, signal);
    }
  };

  return {
    provider,
    dialect: 'chat-completions',
    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
      let body = requestBody(provider, request, refusesEffort.has(request.model));
      let chunks: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      try {
        chunks = await open(body, signal);
      } catch (err) {
        if (!(err instanceof ModelError) || !refusedEffort(err, body)) throw err;
        refusesEffort.add(request.model);
        body = requestBody(provider, request, true);
        chunks = await open(body, signal);
      }
      yield* readStream(provider, request.model, chunks, signal);
    },
  };
}

/** A refusal that blames the effort field this request carried, by the provider's own `param`. */
function refusedEffort(err: ModelError, body: Body): boolean {
  if (err.kind !== 'bad-request') return false;
  return (err.param === 'reasoning_effort' && body.reasoning_effort !== undefined)
    || (err.param?.startsWith('reasoning') === true && body.reasoning !== undefined);
}

export function requestBody(provider: AiProvider, request: ModelRequest, withoutEffort = false): Body {
  // OpenRouter passes `cache_control` through to Anthropic, which caches only
  // where told; every other model here caches implicitly or not at all.
  const explicitCache = provider === 'openrouter' && request.model.startsWith('anthropic/');
  const body: Body = {
    model: request.model,
    messages: wireMessages(provider, request, explicitCache),
    stream: true,
    ...(NO_STREAM_OPTIONS.has(provider) ? {} : { stream_options: { include_usage: true } }),
    ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
  };
  const routing = routingFor(provider, request, explicitCache);
  if (routing) body.provider = routing;
  if (request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = wireToolChoice(request.toolChoice ?? 'auto');
  }
  const field = EFFORT_FIELD[provider];
  if (request.effort && field && !withoutEffort) {
    if (field === 'reasoning') body.reasoning = { effort: EFFORT[request.effort] };
    else body.reasoning_effort = EFFORT[request.effort];
  }
  return body;
}

function routingFor(provider: AiProvider, request: ModelRequest, explicitCache: boolean): Body['provider'] {
  if (provider !== 'openrouter') return undefined;
  if (explicitCache) return asksForCache(request) ? CACHE_ROUTING : undefined;
  if (USER_ROUTED.test(request.model)) return undefined;
  const name = lastUpstream(request);
  return name ? PREFER_UPSTREAM(name) : undefined;
}

/** The upstream the conversation's latest routed turn came from, unless that turn was another model's: a switch starts over. */
function lastUpstream(request: ModelRequest): string | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message.role !== 'assistant' || message.providerState?.dialect !== 'chat-completions') continue;
    const upstream = readState(message.providerState.data)?.upstream;
    if (upstream) return upstream.model === request.model ? upstream.name : undefined;
  }
  return undefined;
}

function asksForCache(request: ModelRequest): boolean {
  return request.cache?.atLastMessage === true || request.cache?.afterTools === true || request.system.some((p) => p.cacheBreakpoint);
}

function wireToolChoice(choice: ToolChoice): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
  return typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } };
}

function wireMessages(provider: AiProvider, request: ModelRequest, explicitCache: boolean): Chat[] {
  const out: Chat[] = [];
  if (request.system.length > 0) {
    if (explicitCache) {
      const marked = request.system.map((p, i) => (p.cacheBreakpoint ? i : -1)).filter((i) => i >= 0).slice(-MAX_SYSTEM_BREAKPOINTS);
      const content: TextPart[] = request.system.map((p, i) => ({
        type: 'text',
        text: p.text,
        ...(marked.includes(i) ? { cache_control: EPHEMERAL } : {}),
      }));
      out.push({ role: 'system', content });
    } else {
      out.push({ role: 'system', content: request.system.map((p) => p.text).join('\n\n') });
    }
  }
  const last = request.messages.length - 1;
  request.messages.forEach((message, i) => {
    out.push(...wireMessage(provider, message, explicitCache && request.cache?.atLastMessage === true && i === last));
  });
  return out;
}

function wireMessage(provider: AiProvider, message: ModelMessage, cacheHere: boolean): Chat[] {
  const text = (value: string): string | TextPart[] => (cacheHere ? [{ type: 'text', text: value, cache_control: EPHEMERAL }] : value);
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: text(message.text) }];
    case 'tool':
      return message.results.map((r, i) => ({
        role: 'tool',
        tool_call_id: r.callId,
        content: i === message.results.length - 1 ? text(r.output) : r.output,
      }));
    case 'assistant': {
      const calls = message.toolCalls ?? [];
      const wire: AssistantWire = { role: 'assistant', content: message.text || (calls.length > 0 ? null : '') };
      if (calls.length > 0) {
        wire.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.rawArguments || JSON.stringify(c.arguments) },
        }));
      }
      const state = message.providerState?.dialect === 'chat-completions' ? readState(message.providerState.data) : undefined;
      if (state?.details && provider === 'openrouter') wire.reasoning_details = state.details;
      // DeepSeek and Kimi check a tool-calling turn's reasoning comes back with
      // it, and refuse it on a turn without calls, so only that turn carries it.
      if (state?.field === 'reasoning_content' && state.reasoning && calls.length > 0) wire.reasoning_content = state.reasoning;
      return [wire];
    }
  }
}

function readState(data: unknown): ChatState | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const { reasoning, field, details, upstream } = data as Record<string, unknown>;
  const state: ChatState = {};
  if (typeof reasoning === 'string') state.reasoning = reasoning;
  if (field === 'reasoning' || field === 'reasoning_content') state.field = field;
  if (Array.isArray(details)) state.details = details.filter(isRecord);
  if (isRecord(upstream) && typeof upstream.model === 'string' && typeof upstream.name === 'string') state.upstream = { model: upstream.model, name: upstream.name };
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fields of a streamed chunk this dialect reads beyond the SDK's types: vendors' reasoning and usage extensions. */
interface ChunkDelta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: unknown;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface ChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  /** DeepSeek's cache hits, outside the details block. */
  prompt_cache_hit_tokens?: number;
  /** Moonshot's, likewise. */
  cached_tokens?: number;
  /** OpenRouter's, in USD credits. */
  cost?: number;
}

/**
 * Where OpenRouter names the upstream that served a call, beyond the SDK's
 * types: its documented `openrouter_metadata`, sent when asked for, and the
 * top-level `provider` its streams carry, which that schema leaves out.
 */
interface Routed {
  provider?: unknown;
  openrouter_metadata?: unknown;
}

function servedBy(chunk: Routed): string | undefined {
  const meta = chunk.openrouter_metadata;
  if (isRecord(meta)) {
    const endpoints = isRecord(meta.endpoints) && Array.isArray(meta.endpoints.available) ? meta.endpoints.available.filter(isRecord) : [];
    const selected = endpoints.find((e) => e.selected === true)?.provider;
    if (typeof selected === 'string' && selected) return selected;
    const attempts = Array.isArray(meta.attempts) ? meta.attempts.filter(isRecord) : [];
    const answered = attempts.filter((a) => typeof a.status === 'number' && a.status >= 200 && a.status < 300).at(-1)?.provider;
    if (typeof answered === 'string' && answered) return answered;
  }
  return typeof chunk.provider === 'string' && chunk.provider ? chunk.provider : undefined;
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

async function* readStream(
  provider: AiProvider,
  model: string,
  chunks: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  signal?: AbortSignal,
): AsyncIterable<ModelEvent> {
  const calls = new Map<number, PendingCall>();
  const state: ChatState = {};
  let finishReason: string | undefined;
  let usage: ChunkUsage | undefined;
  const routed = provider === 'openrouter';
  let generationId: string | undefined;
  let upstream: string | undefined;

  try {
    for await (const chunk of chunks) {
      if (chunk.usage) usage = chunk.usage as ChunkUsage;
      if (routed) {
        if (chunk.id) generationId = chunk.id;
        upstream = servedBy(chunk as Routed) ?? upstream;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta as ChunkDelta | undefined;
      if (!delta) continue;
      const thinking = delta.reasoning_content ? 'reasoning_content' : delta.reasoning ? 'reasoning' : undefined;
      if (thinking) {
        const piece = delta[thinking] as string;
        state.field ??= thinking;
        state.reasoning = (state.reasoning ?? '') + piece;
        yield { type: 'thinking-delta', text: piece };
      }
      if (Array.isArray(delta.reasoning_details)) mergeDetails(state, delta.reasoning_details);
      if (delta.content) yield { type: 'text-delta', text: delta.content };
      for (const [position, tc] of (delta.tool_calls ?? []).entries()) {
        const index = tc.index ?? position;
        const call = calls.get(index) ?? { id: '', name: '', args: '', started: false };
        calls.set(index, call);
        if (tc.id && !call.started) call.id = tc.id;
        if (tc.function?.name && !call.started) call.name = tc.function.name;
        const piece = tc.function?.arguments ?? '';
        call.args += piece;
        if (!call.started && call.name) {
          // Some local servers stream a call with no id; the result still has to name one.
          call.id ||= `call_${uuidv4()}`;
          call.started = true;
          yield { type: 'tool-call-start', id: call.id, name: call.name };
          if (call.args) yield { type: 'tool-call-delta', id: call.id, argumentsDelta: call.args };
        } else if (call.started && piece) {
          yield { type: 'tool-call-delta', id: call.id, argumentsDelta: piece };
        }
      }
    }
  } catch (err) {
    throw toModelError(err, signal);
  }

  if (finishReason === 'error') {
    throw new ModelError({ kind: 'transient', message: 'The provider ended the stream with an error.' });
  }
  if (finishReason === undefined) {
    throw new ModelError({ kind: 'transient', message: 'The stream ended before the model finished its reply.' });
  }

  const started = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c).filter((c) => c.started).map(toolCall);
  const completed = finishReason === 'length' ? started.filter(cameThroughWhole) : started;
  for (const call of completed) yield { type: 'tool-call-complete', call };
  const reported = usage && modelUsage(provider, usage);
  if (reported) {
    if (upstream) reported.provider = upstream;
    if (generationId) reported.generationId = generationId;
    yield { type: 'usage', usage: reported };
  }
  if (upstream) state.upstream = { model, name: upstream };
  if (state.reasoning !== undefined || state.details || state.upstream) yield { type: 'provider-state', state: { dialect: 'chat-completions', data: state } };
  yield { type: 'finish', reason: finish(finishReason, completed.length > 0) };
}

/**
 * OpenRouter streams each reasoning detail in pieces sharing an `index`: the
 * text arrives in fragments and the signature last, so a piece joins the
 * detail before it instead of standing as a detail of its own.
 */
function mergeDetails(state: ChatState, pieces: unknown[]): void {
  const details = (state.details ??= []);
  for (const piece of pieces) {
    if (!isRecord(piece)) continue;
    const prior = details[details.length - 1];
    if (!prior || piece.index === undefined || prior.index !== piece.index || prior.type !== piece.type) {
      details.push({ ...piece });
      continue;
    }
    for (const [key, value] of Object.entries(piece)) {
      if ((key === 'text' || key === 'summary') && typeof value === 'string' && typeof prior[key] === 'string') prior[key] = (prior[key] as string) + value;
      else if (value !== null && value !== undefined) prior[key] = value;
    }
  }
}

function toolCall(call: PendingCall): ModelToolCall {
  const out: ModelToolCall = { id: call.id, name: call.name, arguments: {}, rawArguments: call.args };
  if (call.args.trim() === '') return out;
  try {
    const parsed: unknown = JSON.parse(call.args);
    if (isRecord(parsed)) out.arguments = parsed;
    else out.argumentsError = 'The arguments are not a JSON object.';
  } catch (err) {
    out.argumentsError = err instanceof Error ? err.message : String(err);
  }
  return out;
}

function finish(reason: string, hasCalls: boolean): FinishReason {
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'content-filter';
  // Some compatible servers report `stop` on a turn that called tools.
  return hasCalls || reason === 'tool_calls' || reason === 'function_call' ? 'tool-calls' : 'stop';
}

function modelUsage(provider: AiProvider, u: ChunkUsage): ModelUsage | undefined {
  const usage: ModelUsage = {};
  if (u.prompt_tokens !== undefined) usage.inputTokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) usage.outputTokens = u.completion_tokens;
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens;
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  const cacheWrite = u.prompt_tokens_details?.cache_write_tokens;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  if (provider === 'openrouter' && typeof u.cost === 'number') usage.cost = { amount: u.cost, currency: 'USD' };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The SDK's failure as a `ModelError`; a stop keeps the signal's own reason. */
function toModelError(err: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason;
  if (err instanceof ModelError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof OpenAI.APIConnectionTimeoutError) return classifyHttpFailure({ message, timeout: true, cause: err });
  if (err instanceof OpenAI.APIConnectionError) return classifyHttpFailure({ message, network: true, cause: err });
  if (err instanceof OpenAI.APIError) {
    return classifyHttpFailure({
      message,
      status: err.status,
      headers: err.headers,
      code: providerCode(err),
      type: err.type ?? null,
      param: err.param ?? null,
      metadata: isRecord(err.error) ? err.error.metadata : undefined,
      cause: err,
    });
  }
  return new ModelError({ kind: 'fatal', message, cause: err });
}

/** The SDK keeps a string code; OpenRouter's numeric one, the HTTP status of a mid-stream failure, stays in the body. */
function providerCode(err: InstanceType<typeof OpenAI.APIError>): string | number | null {
  if (err.code !== undefined && err.code !== null) return err.code;
  const body: unknown = err.error;
  const code = isRecord(body) ? body.code : undefined;
  return typeof code === 'number' || typeof code === 'string' ? code : null;
}

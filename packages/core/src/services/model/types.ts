import type { AiProvider } from '../../interfaces/IConfig';
import type { Dialect } from './dialects';

// The one shape every provider is reached through by the built-in runner. Each
// dialect's adapter maps it onto that provider's official SDK; nothing here
// names a provider's wire format, so the runner never learns one.

/** Ordewell's effort ids. An adapter maps them onto what its provider takes and drops what a model cannot. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * One piece of the system prompt. Parts are kept apart so a cache breakpoint
 * can sit between the stable prefix and what changes per run; an adapter that
 * must flatten them joins them with a blank line.
 */
export interface SystemPart {
  text: string;
  /** Cache everything up to and including this part, where the provider takes explicit breakpoints. */
  cacheBreakpoint?: boolean;
}

/**
 * Where explicit-cache providers place breakpoints beyond the system parts' own.
 * Adapters for providers that cache implicitly ignore these.
 */
export interface CacheHints {
  /** A breakpoint right after the tool definitions. */
  afterTools?: boolean;
  /** A breakpoint on the last message, so the next request's prefix reads from cache. */
  atLastMessage?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** A JSON Schema object for the tool's arguments. */
  parameters: Record<string, unknown>;
}

/**
 * `{ name }` forces that one tool while every definition stays in the request,
 * so the cached prefix holds on the step the runner forces `task_complete`.
 */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

/**
 * What an adapter needs back to continue its own assistant turn: reasoning
 * items, thought signatures, encrypted reasoning. Opaque to everything but the
 * adapter that emitted it, and JSON-serialisable so a session can persist it.
 * Tagged with its dialect, so state from another provider is dropped rather
 * than sent where it means nothing.
 */
export interface ProviderState {
  dialect: Dialect;
  data: unknown;
}

export interface ModelToolCall {
  id: string;
  name: string;
  /** The parsed arguments; `{}` when they did not parse as an object, with `argumentsError` saying why. */
  arguments: Record<string, unknown>;
  /**
   * The arguments exactly as the model streamed them. Replayed verbatim, since
   * a re-serialised object can differ by a byte and break the cached prefix.
   */
  rawArguments: string;
  argumentsError?: string;
}

export interface ToolResult {
  callId: string;
  /** The called tool's name, which some dialects key a result by. */
  name: string;
  output: string;
  /** Sent where the dialect has a field for it; elsewhere the output's own words carry it. */
  isError?: boolean;
}

export type ModelMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ModelToolCall[]; providerState?: ProviderState }
  | { role: 'tool'; results: ToolResult[] };

/**
 * Which earlier reasoning a request may leave out. Only an adapter knows
 * whether its provider takes a conversation missing some (provider state is
 * opaque outside it), so each honours this where that is known to be safe and
 * otherwise sends every turn's reasoning, as with no hint.
 */
export interface ReasoningHint {
  /** Assistant messages before this index of `messages` may go without their reasoning; every one from it on keeps it. */
  keepFrom: number;
}

export interface ModelRequest {
  /** The provider's own model id, with no Ordewell provider prefix. */
  model: string;
  system: SystemPart[];
  messages: ModelMessage[];
  tools: ToolDefinition[];
  toolChoice?: ToolChoice;
  effort?: EffortLevel;
  maxOutputTokens?: number;
  cache?: CacheHints;
  reasoning?: ReasoningHint;
}

/**
 * What one request consumed, as the provider reported it. An absent field was
 * not reported, never zero. `inputTokens` counts the whole prompt, cache reads
 * and writes included, and `outputTokens` the reasoning: the cache and
 * reasoning counts are shares of them, as `UsageRecord` reads them.
 */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Only a provider's own figure (OpenRouter's); never a price-table estimate. */
  cost?: { amount: number; currency: string };
  /** The upstream an aggregator (OpenRouter) routed the call to, by the name it reports. */
  provider?: string;
  /** The aggregator's id for the call, which its own generation lookup takes. */
  generationId?: string;
}

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter';

/**
 * The effort a request asking for one actually carried, in the provider's own
 * word: an adapter maps a level its provider lacks onto one it has, and leaves
 * one out where the provider or the model takes none. Without it the planned
 * effort and the sent one differ silently.
 */
export interface EffortSent {
  type: 'effort';
  /** Absent: the request went without one. */
  sent?: string;
  /** The provider refused the effort for this model, so this request, and every later one to it, goes without. */
  refused?: true;
}

/**
 * A request's stream. Tool calls start, stream their arguments and complete by
 * id; `usage` and `provider-state` come at most once each, after every tool
 * call completes; `finish` is always last, exactly once. A stream that ends
 * without one throws a `ModelError` instead. On `length`, a call the limit cut
 * short never completes: only one whose arguments came through whole does.
 * `effort` comes once, first, on a request that asked for one.
 */
export type ModelEvent =
  | EffortSent
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-delta'; id: string; argumentsDelta: string }
  | { type: 'tool-call-complete'; call: ModelToolCall }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'provider-state'; state: ProviderState }
  | { type: 'finish'; reason: FinishReason };

/**
 * One streaming call per model request. A failure throws a `ModelError`; an
 * aborted signal throws the signal's own reason, so a stop is never mistaken
 * for a provider failure.
 */
export interface ModelClient {
  readonly provider: AiProvider;
  readonly dialect: Dialect;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

/** What every adapter is built from. */
export interface AdapterOptions {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string;
  /** Replaces the transport; tests replay recorded streams through it. */
  fetch?: typeof globalThis.fetch;
}

export type AdapterFactory = (options: AdapterOptions) => ModelClient;

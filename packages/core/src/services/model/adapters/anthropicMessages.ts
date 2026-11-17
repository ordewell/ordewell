import Anthropic from '@anthropic-ai/sdk';
import { classifyHttpFailure, headerReader, ModelError, retryAfterFromHeaders } from '../ModelError';
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
} from '../types';

// The anthropic-messages dialect, on the official @anthropic-ai/sdk SDK, with its
// own retries off (maxRetries: 0): `withRetry` is the one policy.

type Body = Anthropic.Messages.MessageCreateParamsStreaming;
type Wire = Anthropic.Messages.MessageParam;
type WireBlock = Anthropic.Messages.ContentBlockParam;
type WireText = Anthropic.Messages.TextBlockParam;
type Thinking = Anthropic.Messages.ThinkingConfigParam;
type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;

const KEYLESS_PLACEHOLDER = 'not-needed';
const EPHEMERAL = { type: 'ephemeral' } as const;
// The API takes four breakpoints a request; tools and the last message each keep one.
const MAX_BREAKPOINTS = 4;
// `max_tokens` is required on the wire; a streamed request has no timeout to trip by asking for much.
const DEFAULT_MAX_TOKENS = 32_000;
const MIN_THINKING_BUDGET = 1024;
// The API rejects empty and whitespace-only text blocks, so an empty turn is sent as a stand-in.
const EMPTY_USER = '(empty message)';
const EMPTY_ASSISTANT = '(empty reply)';

const LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// What a model that takes only a thinking budget gets per Ordewell level.
const BUDGETS: Readonly<Record<EffortLevel, number>> = { low: 1024, medium: 4096, high: 10_000, xhigh: 20_000, max: 32_000 };

/**
 * What a model family accepts, from Anthropic's model docs. Parsed from the id
 * because the API has no capability listing; the `quirks` below catch the id
 * this table has never heard of.
 */
interface Capabilities {
  /** `adaptive`: `thinking: adaptive` plus `output_config.effort`. `budget`: `budget_tokens` only. */
  thinking: 'none' | 'adaptive' | 'budget';
  efforts: readonly EffortLevel[];
  /**
   * How thinking is turned off for a step: `disabled`, `between_tools` (Sonnet
   * 5.5 refuses `disabled`), or `never` (Fable, Mythos and Opus 5.5 always think).
   */
  off: 'disabled' | 'between_tools' | 'never';
}

const NO_THINKING: Capabilities = { thinking: 'none', efforts: [], off: 'disabled' };
const BUDGET: Capabilities = { thinking: 'budget', efforts: [], off: 'disabled' };
const adaptive = (off: Capabilities['off'], efforts: readonly EffortLevel[] = LEVELS): Capabilities => ({ thinking: 'adaptive', efforts, off });

const MODEL_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/;

function capabilities(model: string): Capabilities {
  const match = MODEL_ID.exec(model);
  if (!match) return /^claude-3-7-sonnet/.test(model) ? BUDGET : NO_THINKING;
  const family = match[1];
  const version = Number(match[2]) * 100 + Number(match[3] ?? 0);
  switch (family) {
    case 'fable':
    case 'mythos':
      return adaptive('never');
    case 'opus':
      if (version >= 505) return adaptive('never');
      if (version >= 407) return adaptive('disabled');
      if (version === 406) return adaptive('disabled', ['low', 'medium', 'high', 'max']);
      return BUDGET;
    case 'sonnet':
      if (version >= 505) return adaptive('between_tools');
      if (version >= 500) return adaptive('disabled');
      if (version === 406) return adaptive('disabled', ['low', 'medium', 'high']);
      return BUDGET;
    default:
      return version >= 500 ? adaptive('disabled') : BUDGET;
  }
}

/**
 * Things a model refused that the table above promised it takes. Learnt from
 * the API's own refusal, remembered per model for this client's life, and
 * answered by one retry without the offending field.
 */
type Quirk = 'noForcedTool' | 'noEffort' | 'noThinking';
const NO_QUIRKS: ReadonlySet<Quirk> = new Set();

/** What the next request needs to continue an assistant turn that thought: its blocks, signed, in order. */
type StateBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string };

export function createAnthropicMessagesClient(options: AdapterOptions): ModelClient {
  const client = new Anthropic({
    apiKey: options.apiKey || KEYLESS_PLACEHOLDER,
    baseURL: sdkBaseUrl(options.baseUrl),
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const learnt = new Map<string, Set<Quirk>>();

  const open = async (body: Body, signal?: AbortSignal) => {
    try {
      return await client.messages.create(body, signal ? { signal } : undefined);
    } catch (err) {
      throw toModelError(err, signal);
    }
  };

  return {
    provider: options.provider,
    dialect: 'anthropic-messages',
    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
      let quirks = learnt.get(request.model);
      if (!quirks) learnt.set(request.model, (quirks = new Set()));
      for (;;) {
        let events: AsyncIterable<StreamEvent>;
        try {
          events = await open(requestBody(request, quirks), signal);
        } catch (err) {
          const quirk = err instanceof ModelError ? refusedQuirk(err) : undefined;
          if (!quirk || quirks.has(quirk)) throw err;
          quirks.add(quirk);
          continue;
        }
        yield* readStream(events, signal);
        return;
      }
    },
  };
}

// `apiProviders` registers `https://api.anthropic.com/v1`, the form every other
// dialect appends its path to; this SDK adds `/v1/messages` itself.
function sdkBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function refusedQuirk(err: ModelError): Quirk | undefined {
  if (err.kind !== 'bad-request') return undefined;
  if (/tool_choice|"tool" and "any"/i.test(err.message)) return 'noForcedTool';
  if (/effort|output_config/i.test(err.message)) return 'noEffort';
  if (/thinking|budget_tokens|signature/i.test(err.message)) return 'noThinking';
  return undefined;
}

export function requestBody(request: ModelRequest, quirks: ReadonlySet<Quirk> = NO_QUIRKS): Body {
  const caps = quirks.has('noThinking') ? NO_THINKING : capabilities(request.model);
  const maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const hasTools = request.tools.length > 0;
  const choice = request.toolChoice ?? 'auto';
  const forced = hasTools && (choice === 'required' || typeof choice === 'object');

  // A forced tool cannot be combined with thinking. Where thinking can be
  // switched off, this step switches it off and forces the tool natively;
  // where it cannot (and forcing 400s), the choice stays `auto` and the last
  // message asks for the tool in words, so the runner has to check the call.
  const nativeForce = forced && !quirks.has('noForcedTool') && (caps.thinking === 'none' || caps.off === 'disabled');
  const nudge = forced && !nativeForce ? nudgeText(choice) : undefined;

  const body: Body = {
    model: request.model,
    max_tokens: maxTokens,
    stream: true,
    messages: wireMessages(request, caps.thinking !== 'none', nudge),
  };
  const system = wireSystem(request);
  if (system.length > 0) body.system = system;

  if (hasTools) {
    body.tools = request.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.parameters, type: 'object' as const },
      ...(request.cache?.afterTools && i === request.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }));
    if (choice === 'none') body.tool_choice = { type: 'none' };
    else if (nativeForce) body.tool_choice = choice === 'required' ? { type: 'any' } : { type: 'tool', name: choice.name };
    else body.tool_choice = { type: 'auto' };
  }

  if (nativeForce && caps.thinking !== 'none') {
    body.thinking = { type: 'disabled' };
  } else {
    const { thinking, effort } = thinkingConfig(caps, request.effort, maxTokens, quirks.has('noEffort'));
    if (thinking) body.thinking = thinking;
    if (effort) body.output_config = { effort };
  }
  return body;
}

function nudgeText(choice: ModelRequest['toolChoice']): string {
  return typeof choice === 'object' ? `Call the \`${choice.name}\` tool now.` : 'Call a tool now.';
}

/** The nearest level the model takes at or below the one asked for. */
function supportedEffort(caps: Capabilities, effort: EffortLevel): EffortLevel | undefined {
  for (let i = LEVELS.indexOf(effort); i >= 0; i--) {
    if (caps.efforts.includes(LEVELS[i])) return LEVELS[i];
  }
  return undefined;
}

/**
 * No effort leaves the model to its own default. Adaptive models get thinking
 * on, summarized (their default can be to omit it) and `effort`; budget models
 * get a budget that leaves room under `max_tokens`.
 */
function thinkingConfig(
  caps: Capabilities,
  effort: EffortLevel | undefined,
  maxTokens: number,
  withoutEffort: boolean,
): { thinking?: Thinking; effort?: EffortLevel } {
  if (!effort || caps.thinking === 'none') return {};
  if (caps.thinking === 'adaptive') {
    const level = withoutEffort ? undefined : supportedEffort(caps, effort);
    return { thinking: { type: 'adaptive', display: 'summarized' }, ...(level ? { effort: level } : {}) };
  }
  const budget = Math.min(BUDGETS[effort], maxTokens - MIN_THINKING_BUDGET);
  return budget >= MIN_THINKING_BUDGET ? { thinking: { type: 'enabled', budget_tokens: budget } } : {};
}

function wireSystem(request: ModelRequest): WireText[] {
  const parts = request.system.filter((p) => p.text.trim() !== '');
  const reserved = (request.cache?.afterTools && request.tools.length > 0 ? 1 : 0) + (request.cache?.atLastMessage && request.messages.length > 0 ? 1 : 0);
  const marked = new Set(
    parts
      .map((p, i) => (p.cacheBreakpoint ? i : -1))
      .filter((i) => i >= 0)
      .slice(-Math.max(0, MAX_BREAKPOINTS - reserved)),
  );
  return parts.map((p, i) => ({ type: 'text', text: p.text, ...(marked.has(i) ? { cache_control: EPHEMERAL } : {}) }));
}

function wireMessages(request: ModelRequest, keepThinking: boolean, nudge: string | undefined): Wire[] {
  const out = request.messages.map((m) => wireMessage(m, keepThinking));
  const last = out[out.length - 1];
  // Thinking blocks cannot carry `cache_control`, so a turn that ends in one
  // (a truncated reply) has no breakpoint.
  if (request.cache?.atLastMessage && last && Array.isArray(last.content)) {
    const tail = last.content[last.content.length - 1];
    if (tail && tail.type !== 'thinking' && tail.type !== 'redacted_thinking') tail.cache_control = EPHEMERAL;
  }
  if (nudge) {
    // After the breakpoint, so a nudge that differs per step never costs the cached prefix.
    if (last?.role === 'user' && Array.isArray(last.content)) last.content.push({ type: 'text', text: nudge });
    else out.push({ role: 'user', content: [{ type: 'text', text: nudge }] });
  }
  return out;
}

function wireMessage(message: ModelMessage, keepThinking: boolean): Wire {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: [{ type: 'text', text: message.text.trim() === '' ? EMPTY_USER : message.text }] };
    case 'tool':
      return {
        role: 'user',
        content: message.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.callId,
          ...(r.output === '' ? {} : { content: r.output }),
          ...(r.isError ? { is_error: true } : {}),
        })),
      };
    case 'assistant': {
      const blocks = assistantBlocks(message, keepThinking);
      return { role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: EMPTY_ASSISTANT }] };
    }
  }
}

function toolUse(call: ModelToolCall): WireBlock {
  return { type: 'tool_use', id: call.id, name: call.name, input: call.argumentsError ? {} : call.arguments };
}

function assistantBlocks(message: Extract<ModelMessage, { role: 'assistant' }>, keepThinking: boolean): WireBlock[] {
  const calls = message.toolCalls ?? [];
  const stored = message.providerState?.dialect === 'anthropic-messages' ? readState(message.providerState.data) : undefined;
  const thinking = keepThinking ? (stored ?? []).filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking') : [];
  const callById = new Map(calls.map((c) => [c.id, c]));

  // The stored order is replayed when it still describes this message; the
  // signature covers the thinking block, not what follows it, so a message the
  // runner has since changed falls back to the plain order.
  const consistent = stored !== undefined
    && stored.filter((b) => b.type === 'text').map((b) => b.text).join('') === message.text
    && stored.filter((b) => b.type === 'tool_use').map((b) => b.id).join('\n') === calls.map((c) => c.id).join('\n');
  const ordered: WireBlock[] = [];
  if (consistent && stored) {
    for (const b of stored) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        if (keepThinking) ordered.push(b);
      } else if (b.type === 'text') {
        if (b.text.trim() !== '') ordered.push({ type: 'text', text: b.text });
      } else {
        const call = callById.get(b.id);
        if (call) ordered.push(toolUse(call));
      }
    }
    return ordered;
  }
  ordered.push(...thinking);
  if (message.text.trim() !== '') ordered.push({ type: 'text', text: message.text });
  ordered.push(...calls.map(toolUse));
  return ordered;
}

function readState(data: unknown): StateBlock[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.content)) return undefined;
  const blocks: StateBlock[] = [];
  for (const b of data.content) {
    if (!isRecord(b)) continue;
    if (b.type === 'thinking' && typeof b.thinking === 'string' && typeof b.signature === 'string') {
      blocks.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
    } else if (b.type === 'redacted_thinking' && typeof b.data === 'string') {
      blocks.push({ type: 'redacted_thinking', data: b.data });
    } else if (b.type === 'text' && typeof b.text === 'string') {
      blocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use' && typeof b.id === 'string') {
      blocks.push({ type: 'tool_use', id: b.id });
    }
  }
  return blocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PendingBlock {
  kind: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'other';
  text: string;
  signature: string;
  data: string;
  id: string;
  name: string;
  args: string;
}

interface RunningUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  thinking_tokens?: number;
}

/** Folds a usage block in: `message_delta` repeats the cumulative counts, and may carry null for what it does not report. */
function foldUsage(into: RunningUsage, usage: unknown): void {
  if (!isRecord(usage)) return;
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    const value = usage[key];
    if (typeof value === 'number') into[key] = value;
  }
  const details = usage.output_tokens_details;
  if (isRecord(details) && typeof details.thinking_tokens === 'number') into.thinking_tokens = details.thinking_tokens;
}

async function* readStream(events: AsyncIterable<StreamEvent>, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  const blocks = new Map<number, PendingBlock>();
  const usage: RunningUsage = {};
  let stopReason: string | undefined;

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'message_start':
          foldUsage(usage, event.message.usage);
          break;
        case 'content_block_start': {
          const start = event.content_block;
          const block: PendingBlock = { kind: 'other', text: '', signature: '', data: '', id: '', name: '', args: '' };
          blocks.set(event.index, block);
          if (start.type === 'text') {
            block.kind = 'text';
            if (start.text) {
              block.text = start.text;
              yield { type: 'text-delta', text: start.text };
            }
          } else if (start.type === 'thinking') {
            block.kind = 'thinking';
            block.text = start.thinking;
            block.signature = start.signature;
            if (start.thinking) yield { type: 'thinking-delta', text: start.thinking };
          } else if (start.type === 'redacted_thinking') {
            block.kind = 'redacted_thinking';
            block.data = start.data;
          } else if (start.type === 'tool_use') {
            block.kind = 'tool_use';
            block.id = start.id;
            block.name = start.name;
            yield { type: 'tool-call-start', id: block.id, name: block.name };
          }
          break;
        }
        case 'content_block_delta': {
          const block = blocks.get(event.index);
          if (!block) break;
          const delta = event.delta;
          if (delta.type === 'text_delta' && block.kind === 'text') {
            block.text += delta.text;
            if (delta.text) yield { type: 'text-delta', text: delta.text };
          } else if (delta.type === 'thinking_delta' && block.kind === 'thinking') {
            block.text += delta.thinking;
            if (delta.thinking) yield { type: 'thinking-delta', text: delta.thinking };
          } else if (delta.type === 'signature_delta' && block.kind === 'thinking') {
            block.signature += delta.signature;
          } else if (delta.type === 'input_json_delta' && block.kind === 'tool_use') {
            block.args += delta.partial_json;
            if (delta.partial_json) yield { type: 'tool-call-delta', id: block.id, argumentsDelta: delta.partial_json };
          }
          break;
        }
        case 'message_delta':
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
          foldUsage(usage, event.usage);
          break;
        default:
          break;
      }
    }
  } catch (err) {
    throw toModelError(err, signal);
  }

  if (stopReason === undefined) {
    throw new ModelError({ kind: 'transient', message: 'The stream ended before the model finished its reply.' });
  }

  const cutOff = finish(stopReason, false) === 'length';
  // A call the limit cut short leaves the blocks too, so the replayed turn never names one that has no result.
  const ordered = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => b)
    .filter((b) => !cutOff || b.kind !== 'tool_use' || cameThroughWhole(toolCall(b)));
  const calls = ordered.filter((b) => b.kind === 'tool_use');
  for (const call of calls) yield { type: 'tool-call-complete', call: toolCall(call) };
  const reported = modelUsage(usage);
  if (reported) yield { type: 'usage', usage: reported };
  const state = providerState(ordered);
  if (state) yield { type: 'provider-state', state: { dialect: 'anthropic-messages', data: { content: state } } };
  yield { type: 'finish', reason: finish(stopReason, calls.length > 0) };
}

/**
 * The turn's blocks, kept only when it thought: a turn without thinking
 * replays from the message's own text and calls. A thinking block cut short
 * before its signature arrived cannot be sent back, so it is not kept.
 */
function providerState(ordered: PendingBlock[]): StateBlock[] | undefined {
  const kept: StateBlock[] = [];
  for (const b of ordered) {
    if (b.kind === 'thinking' && b.signature) kept.push({ type: 'thinking', thinking: b.text, signature: b.signature });
    else if (b.kind === 'redacted_thinking') kept.push({ type: 'redacted_thinking', data: b.data });
    else if (b.kind === 'text' && b.text.trim() !== '') kept.push({ type: 'text', text: b.text });
    else if (b.kind === 'tool_use') kept.push({ type: 'tool_use', id: b.id });
  }
  return kept.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking') ? kept : undefined;
}

function toolCall(block: PendingBlock): ModelToolCall {
  const out: ModelToolCall = { id: block.id, name: block.name, arguments: {}, rawArguments: block.args };
  if (block.args.trim() === '') return out;
  try {
    const parsed: unknown = JSON.parse(block.args);
    if (isRecord(parsed)) out.arguments = parsed;
    else out.argumentsError = 'The arguments are not a JSON object.';
  } catch (err) {
    out.argumentsError = err instanceof Error ? err.message : String(err);
  }
  return out;
}

function finish(reason: string, hasCalls: boolean): FinishReason {
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length';
  if (reason === 'refusal') return 'content-filter';
  return hasCalls || reason === 'tool_use' ? 'tool-calls' : 'stop';
}

/** Anthropic reports the uncached input apart from cache reads and writes; `ModelUsage.inputTokens` is all three. */
function modelUsage(u: RunningUsage): ModelUsage | undefined {
  const usage: ModelUsage = {};
  if (u.input_tokens !== undefined || u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
    usage.inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  if (u.output_tokens !== undefined) usage.outputTokens = u.output_tokens;
  if (u.cache_read_input_tokens !== undefined) usage.cacheReadTokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens !== undefined) usage.cacheWriteTokens = u.cache_creation_input_tokens;
  if (u.thinking_tokens !== undefined) usage.reasoningTokens = u.thinking_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

// A failure reported inside a stream has no HTTP status; its type says what a status would have.
const STATUS_OF_TYPE: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

const OUT_OF_CREDIT = /credit balance is too low|reached your specified (?:workspace )?API usage limit/i;
const PROMPT_TOO_LONG = /prompt is too long|exceed(?:s|ed)? (?:the )?context (?:limit|window)|input is too long|maximum context length/i;
const REGAIN_ACCESS = /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{2}:\d{2}) UTC)?/i;

/** The SDK's failure as a `ModelError`; a stop keeps the signal's own reason. */
function toModelError(err: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason;
  if (err instanceof ModelError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return classifyHttpFailure({ message, timeout: true, cause: err });
  if (err instanceof Anthropic.APIConnectionError) return classifyHttpFailure({ message, network: true, cause: err });
  if (err instanceof Anthropic.APIError) return apiFailure(err, message);
  return new ModelError({ kind: 'fatal', message, cause: err });
}

function apiFailure(err: InstanceType<typeof Anthropic.APIError>, message: string): ModelError {
  const status = err.status ?? (err.type ? STATUS_OF_TYPE[err.type] : undefined);
  const code = err.errorCode ?? undefined;
  const detail = { message, ...(status !== undefined ? { status } : {}), ...(code ? { code } : {}), cause: err };

  // Anthropic reports an empty balance as `billing_error` or an organization
  // spend limit as a code, neither of which the shared classifier knows.
  if (err.type === 'billing_error' || code === 'enforced_spend_limit_reached' || OUT_OF_CREDIT.test(message)) {
    const wait = retryAfterFromHeaders(headerReader(err.headers));
    const regain = REGAIN_ACCESS.exec(message);
    const resetsAt = wait !== undefined ? Date.now() + wait : regain ? Date.parse(`${regain[1]}T${regain[2] ?? '00:00'}:00Z`) : undefined;
    return new ModelError({ ...detail, kind: 'usage-limit', ...(resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {}) });
  }
  // The API puts its own error code on an overflow only sometimes, so the wording
  // is read here, on a 400, rather than through the shared classifier's no-code rule.
  if (status === 400 && PROMPT_TOO_LONG.test(message)) return new ModelError({ ...detail, kind: 'context-overflow' });
  return classifyHttpFailure({ message, status, headers: err.headers, code: code ?? null, type: err.type, cause: err });
}

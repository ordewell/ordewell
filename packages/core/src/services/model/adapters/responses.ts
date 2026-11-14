import { createHash } from 'node:crypto';
import OpenAI from 'openai';
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

// The responses dialect: OpenAI's own models, on the `openai` SDK's Responses
// API. Its own retries are off: `withRetry` is the one policy.
//
// Requests are stateless (`store: false`) and ask for the reasoning items'
// encrypted content, so each step can hand the previous step's reasoning back.
// That is the reason to use this API over Chat Completions: a reasoning model
// that loses its reasoning between tool calls reasons the task out again.

type Input = OpenAI.Responses.ResponseInputItem;
type StreamEvent = OpenAI.Responses.ResponseStreamEvent;

/** A reasoning item as the next request needs it: only what a stateless replay accepts. */
interface ReasoningItem {
  id: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
  encrypted_content: string;
}

interface ResponsesState {
  items: ReasoningItem[];
}

// The SDK's types predate `xhigh` and `prompt_cache_key`; the API accepts both.
type WireEffort = 'low' | 'medium' | 'high' | 'xhigh';
type Body = Omit<OpenAI.Responses.ResponseCreateParamsStreaming, 'reasoning'> & {
  reasoning?: { summary: 'auto'; effort?: WireEffort };
  prompt_cache_key?: string;
};

const LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * What a model accepts as `reasoning.effort`, or undefined for a model that
 * does not reason (the API refuses the whole `reasoning` object there). Read
 * off the model id, since the API lists no capabilities; a wrong guess is
 * caught by the refusal fallback in `stream`.
 */
export function acceptedEfforts(model: string): readonly WireEffort[] | undefined {
  const id = model.toLowerCase();
  if (/^o\d/.test(id)) return ['low', 'medium', 'high'];
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  if (!gpt) return undefined;
  const major = Number(gpt[1]);
  const minor = Number(gpt[2] ?? 0);
  if (major < 5 || /^gpt-5-chat/.test(id)) return undefined;
  const xhigh = major > 5 || minor >= 2 || id.includes('codex-max');
  // The pro models think at their top settings only.
  if (id.includes('-pro')) return xhigh ? ['high', 'xhigh'] : ['high'];
  return xhigh ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'];
}

/** The level itself where the model takes it, else the nearest one it takes, searching up first. */
export function clampEffort(effort: EffortLevel, accepted: readonly WireEffort[]): WireEffort {
  const wanted = LEVELS.indexOf(effort);
  const fits = (level: WireEffort) => accepted.includes(level);
  for (let i = Math.min(wanted, 3); i >= 0; i--) if (fits(LEVELS[i] as WireEffort)) return LEVELS[i] as WireEffort;
  for (let i = Math.min(wanted, 3) + 1; i <= 3; i++) if (fits(LEVELS[i] as WireEffort)) return LEVELS[i] as WireEffort;
  return accepted[accepted.length - 1] as WireEffort;
}

export function createResponsesClient(options: AdapterOptions): ModelClient {
  const { provider } = options;
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  // A model that refused the reasoning settings once is sent none again, for this client's life.
  const refusesReasoning = new Set<string>();

  const open = async (body: Body, signal?: AbortSignal) => {
    try {
      return await client.responses.create(body as OpenAI.Responses.ResponseCreateParamsStreaming, signal ? { signal } : undefined);
    } catch (err) {
      throw toModelError(err, signal);
    }
  };

  return {
    provider,
    dialect: 'responses',
    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
      let body = requestBody(request, refusesReasoning.has(request.model));
      let events: AsyncIterable<StreamEvent>;
      try {
        events = await open(body, signal);
      } catch (err) {
        if (!(err instanceof ModelError) || !refusedReasoning(err, body)) throw err;
        refusesReasoning.add(request.model);
        body = requestBody(request, true);
        events = await open(body, signal);
      }
      yield* readStream(events, signal);
    },
  };
}

/** A refusal that blames the reasoning settings this request carried, by the API's own `param`. */
function refusedReasoning(err: ModelError, body: Body): boolean {
  return err.kind === 'bad-request' && body.reasoning !== undefined && err.param?.startsWith('reasoning') === true;
}

export function requestBody(request: ModelRequest, withoutReasoning = false): Body {
  const instructions = request.system.map((p) => p.text).join('\n\n');
  const body: Body = {
    model: request.model,
    input: wireInput(request.messages),
    stream: true,
    store: false,
    ...(instructions ? { instructions } : {}),
    ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      // Strict mode demands every property required and no extras, which the runner's tool schemas do not promise.
      strict: false,
    }));
    body.tool_choice = wireToolChoice(request.toolChoice ?? 'auto');
    body.parallel_tool_calls = true;
  }
  const accepted = acceptedEfforts(request.model);
  if (accepted && !withoutReasoning) {
    // `summary: auto` is what makes the model offer reasoning summaries to stream as thinking.
    body.reasoning = {
      summary: 'auto',
      ...(request.effort ? { effort: clampEffort(request.effort, accepted) } : {}),
    };
    body.include = ['reasoning.encrypted_content'];
  }
  const cacheKey = promptCacheKey(instructions, request);
  if (cacheKey) body.prompt_cache_key = cacheKey;
  return body;
}

/**
 * Requests that share a prefix are routed to one cache only when they share a
 * key. The prefix itself (instructions and tools) names it, so one attempt's
 * steps land together, and so does the same attempt resumed in a new process.
 */
function promptCacheKey(instructions: string, request: ModelRequest): string | undefined {
  if (!instructions && request.tools.length === 0) return undefined;
  const digest = createHash('sha256').update(JSON.stringify([instructions, request.tools])).digest('hex');
  return `ordewell-${digest.slice(0, 32)}`;
}

function wireToolChoice(choice: ToolChoice): OpenAI.Responses.ResponseCreateParams['tool_choice'] {
  return typeof choice === 'string' ? choice : { type: 'function', name: choice.name };
}

function wireInput(messages: ModelMessage[]): Input[] {
  const out: Input[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        out.push({ role: 'user', content: message.text });
        break;
      case 'tool':
        for (const r of message.results) out.push({ type: 'function_call_output', call_id: r.callId, output: r.output });
        break;
      case 'assistant': {
        const calls = message.toolCalls ?? [];
        // A reasoning item must be followed by the output it produced, or the API refuses it.
        if (message.text || calls.length > 0) {
          const state = message.providerState?.dialect === 'responses' ? readState(message.providerState.data) : undefined;
          for (const item of state?.items ?? []) out.push({ type: 'reasoning', ...item });
        }
        if (message.text) out.push({ role: 'assistant', content: message.text });
        for (const c of calls) {
          out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.rawArguments || JSON.stringify(c.arguments) });
        }
        break;
      }
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads back what `reasoningItem` wrote; a state that does not parse is dropped, since a half-formed item is refused. */
function readState(data: unknown): ResponsesState | undefined {
  if (!isRecord(data) || !Array.isArray(data.items)) return undefined;
  const items: ReasoningItem[] = [];
  for (const raw of data.items) {
    const item = reasoningItem(raw);
    if (item) items.push(item);
  }
  return items.length > 0 ? { items } : undefined;
}

function reasoningItem(raw: unknown): ReasoningItem | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.encrypted_content !== 'string' || !raw.encrypted_content) return undefined;
  const summary = Array.isArray(raw.summary)
    ? raw.summary.filter(isRecord).flatMap((s) => (typeof s.text === 'string' ? [{ type: 'summary_text' as const, text: s.text }] : []))
    : [];
  return { id: raw.id, summary, encrypted_content: raw.encrypted_content };
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

async function* readStream(events: AsyncIterable<StreamEvent>, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  // Keyed by the output item's id; the model's own `call_id` is what the runner sees.
  const calls = new Map<string, PendingCall>();
  const order: string[] = [];
  const reasoning: ReasoningItem[] = [];
  let usage: OpenAI.Responses.ResponseUsage | undefined;
  let ended: { status: 'completed' | 'incomplete'; reason?: string } | undefined;

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          if (event.delta) yield { type: 'text-delta', text: event.delta };
          break;
        case 'response.reasoning_summary_part.added':
          // Parts are separate paragraphs of one summary.
          if (event.summary_index > 0) yield { type: 'thinking-delta', text: '\n\n' };
          break;
        case 'response.reasoning_summary_text.delta':
          if (event.delta) yield { type: 'thinking-delta', text: event.delta };
          break;
        case 'response.output_item.added':
          if (event.item.type === 'function_call') {
            const key = event.item.id ?? event.item.call_id;
            calls.set(key, { id: event.item.call_id, name: event.item.name, args: '' });
            order.push(key);
            yield { type: 'tool-call-start', id: event.item.call_id, name: event.item.name };
            if (event.item.arguments) {
              (calls.get(key) as PendingCall).args = event.item.arguments;
              yield { type: 'tool-call-delta', id: event.item.call_id, argumentsDelta: event.item.arguments };
            }
          }
          break;
        case 'response.function_call_arguments.delta': {
          const call = calls.get(event.item_id);
          if (call && event.delta) {
            call.args += event.delta;
            yield { type: 'tool-call-delta', id: call.id, argumentsDelta: event.delta };
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          // The finished string is the authority over the deltas that built it.
          const call = calls.get(event.item_id);
          if (call) call.args = event.arguments;
          break;
        }
        case 'response.output_item.done':
          if (event.item.type === 'reasoning') {
            const item = reasoningItem(event.item);
            if (item) reasoning.push(item);
          }
          break;
        case 'response.completed':
          usage = event.response.usage;
          ended = { status: 'completed' };
          break;
        case 'response.incomplete':
          usage = event.response.usage;
          ended = { status: 'incomplete', ...(event.response.incomplete_details?.reason ? { reason: event.response.incomplete_details.reason } : {}) };
          break;
        case 'response.failed': {
          const error: { code?: string; message?: string } | null | undefined = event.response.error;
          throw streamFailure(error?.code, error?.message ?? 'The response failed.');
        }
        case 'error':
          throw streamFailure(event.code ?? undefined, event.message, event.param ?? undefined);
        default:
          break;
      }
    }
  } catch (err) {
    throw toModelError(err, signal);
  }

  if (!ended) {
    throw new ModelError({ kind: 'transient', message: 'The stream ended before the model finished its reply.' });
  }

  const completed = order.map((key) => calls.get(key) as PendingCall);
  for (const call of completed) yield { type: 'tool-call-complete', call: toolCall(call) };
  const reported = usage && modelUsage(usage);
  if (reported) yield { type: 'usage', usage: reported };
  if (reasoning.length > 0) {
    yield { type: 'provider-state', state: { dialect: 'responses', data: { items: reasoning } satisfies ResponsesState } };
  }
  yield { type: 'finish', reason: finish(ended, completed.length > 0) };
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

function finish(ended: { status: 'completed' | 'incomplete'; reason?: string }, hasCalls: boolean): FinishReason {
  if (ended.status === 'incomplete') return ended.reason === 'content_filter' ? 'content-filter' : 'length';
  return hasCalls ? 'tool-calls' : 'stop';
}

function modelUsage(u: OpenAI.Responses.ResponseUsage): ModelUsage | undefined {
  const usage: ModelUsage = {};
  if (u.input_tokens !== undefined) usage.inputTokens = u.input_tokens;
  if (u.output_tokens !== undefined) usage.outputTokens = u.output_tokens;
  const cached = u.input_tokens_details?.cached_tokens;
  if (cached !== undefined) usage.cacheReadTokens = cached;
  const thought = u.output_tokens_details?.reasoning_tokens;
  if (thought !== undefined) usage.reasoningTokens = thought;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

// What a failure reported inside the stream, which has no HTTP status, would
// have been answered with as a response. The codes are OpenAI's.
const STREAM_STATUS: Readonly<Record<string, number>> = {
  rate_limit_exceeded: 429,
  insufficient_quota: 429,
  context_length_exceeded: 400,
  server_error: 500,
  vector_store_timeout: 504,
};

/** "Please try again in 1.5s" / "in 20ms": the only place a stream-borne rate limit says how long. */
function waitInMessage(message: string): number | undefined {
  const m = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message);
  if (!m) return undefined;
  const amount = Number(m[1]);
  return Number.isFinite(amount) ? Math.ceil(m[2]?.toLowerCase() === 'ms' ? amount : amount * 1000) : undefined;
}

function streamFailure(code: string | undefined, message: string, param?: string): ModelError {
  const retryAfterMs = waitInMessage(message);
  const inferred = code === undefined ? fromWording(message) : { status: STREAM_STATUS[code], code };
  return classifyHttpFailure({
    message,
    ...(inferred.status !== undefined ? { status: inferred.status } : {}),
    ...(inferred.code !== undefined ? { code: inferred.code } : {}),
    ...(param ? { param } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

/**
 * The SDK drops the body of an `event: error` frame, keeping only its message,
 * so the code has to be read back from the wording. A failure that says
 * nothing recognisable is the server's, as OpenAI's own sample of one is.
 */
function fromWording(message: string): { status: number; code?: string } {
  if (/exceeded your current quota/i.test(message)) return { status: 429, code: 'insufficient_quota' };
  if (/rate limit/i.test(message)) return { status: 429, code: 'rate_limit_exceeded' };
  if (/context (?:window|length)/i.test(message)) return { status: 400, code: 'context_length_exceeded' };
  return { status: 500 };
}

/** The SDK's failure as a `ModelError`; a stop keeps the signal's own reason. */
function toModelError(err: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason;
  if (err instanceof ModelError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof OpenAI.APIConnectionTimeoutError) return classifyHttpFailure({ message, timeout: true, cause: err });
  if (err instanceof OpenAI.APIConnectionError) return classifyHttpFailure({ message, network: true, cause: err });
  if (err instanceof OpenAI.APIError) {
    // The SDK throws an error event from the stream as an APIError with no status.
    if (err.status === undefined) {
      const code = typeof err.code === 'string' ? err.code : undefined;
      const wire = err.error;
      return streamFailure(code, message, err.param ?? (isRecord(wire) && typeof wire.param === 'string' ? wire.param : undefined));
    }
    return classifyHttpFailure({
      message,
      status: err.status,
      headers: err.headers,
      code: err.code ?? null,
      type: err.type ?? null,
      param: err.param ?? null,
      cause: err,
    });
  }
  return new ModelError({ kind: 'fatal', message, cause: err });
}

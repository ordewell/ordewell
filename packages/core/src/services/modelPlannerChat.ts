import { v4 as uuidv4 } from 'uuid';
import type { ConversationMessage } from '../models/Task';
import type { UsageRecord } from '../models/Usage';
import type { AiProvider } from '../interfaces/IConfig';
import type { AbandonedPlanText, ResearchTurn, ToolResult } from './BaseAiService';
import { BudgetedChat, type CallInput, type ChatCompaction } from './budgetedChat';
import { messageChars, type CompactableMessage } from './contextCompaction';
import type { SummaryCall } from './contextSummary';
import type { ChatBudget, ModelLimits } from './plannerContextBudget';
import {
  createModelClient,
  isModelError,
  ModelError,
  retryDelay,
  sleep,
  withRetry,
  type EffortLevel,
  type FinishReason,
  type ModelClient,
  type ModelClientOptions,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
  type ModelToolCall,
  type ModelUsage,
  type ProviderState,
  type SystemPart,
  type ToolDefinition,
} from './model';

/*
 * The API planner's one way to a model (ADR-0002): its chats, its summaries
 * and its plan emission all go through a `ModelClient`, by the dialect the
 * provider speaks. What the planner sends and how it budgets stay its own;
 * this module only maps its message list onto a model request and the
 * request's events back onto a research turn.
 */

/** A planner chat's message, kept in the shape compaction reads (`CompactableMessage`). */
export interface PlannerMessage extends CompactableMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  /** A tool result's tool: Gemini keys a function response by it. */
  name?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  /** What the adapter needs back to continue its own turn: reasoning, thought signatures. */
  providerState?: ProviderState;
}

/** How a planner reaches its provider: a client made per credentials, replaceable in tests. */
export type ModelClientFactory = (options: ModelClientOptions) => ModelClient;

/**
 * The client a planner calls through. Transient failures and rate limits are
 * retried here, on the provider's own Retry-After where it sent one; a usage
 * limit is not, since it waits for a reset (ADR-0044) rather than seconds.
 */
export const defaultModelClient: ModelClientFactory = (options) => withRetry(createModelClient(options));

/**
 * One client per provider, endpoint and key: rebuilt when either changes. A
 * Session outlives `/key-set` and endpoint edits, so a client cached for good kept
 * sending the previous key, which the provider refused though the user had
 * already replaced it.
 */
export class PlannerClients {
  private client: ModelClient | null = null;
  private credentials = '';

  constructor(private readonly factory: ModelClientFactory = defaultModelClient) {}

  get(provider: AiProvider, apiKey: string, baseUrl: string): ModelClient {
    const credentials = `${provider}\n${baseUrl}\n${apiKey}`;
    if (!this.client || credentials !== this.credentials) {
      this.client = this.factory({ provider, apiKey, ...(baseUrl ? { baseUrl } : {}) });
      this.credentials = credentials;
    }
    return this.client;
  }

  reset(): void {
    this.client = null;
    this.credentials = '';
  }
}

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The planner's effort setting as a model request takes it; a value no adapter knows leaves the model's default. */
export function plannerEffort(value: string | undefined): EffortLevel | undefined {
  const effort = value?.trim().toLowerCase();
  return EFFORTS.find((e) => e === effort);
}

export interface RequestShape {
  model: string;
  tools: ToolDefinition[];
  maxOutputTokens: number;
  effort?: EffortLevel;
  /**
   * Join consecutive user turns, and consecutive text-only assistant turns,
   * into one: what the Gemini planner always sent, since its API takes a
   * conversation as alternating turns.
   */
  mergeSameRole?: boolean;
}

function textOf(m: CompactableMessage): string {
  return typeof m.content === 'string' ? m.content : m.content === undefined || m.content === null ? '' : JSON.stringify(m.content);
}

function parsedArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A planner message list as one model request. A system message is a system
 * part, a breakpoint after it, and the request asks for one after the tools
 * and at the last message too: the explicit-cache providers (Anthropic) read
 * the next call's unchanged prefix from cache; the rest ignore the hints.
 */
export function plannerRequest(messages: readonly PlannerMessage[], shape: RequestShape): ModelRequest {
  const system: SystemPart[] = [];
  const out: ModelMessage[] = [];
  const callNames = new Map<string, string>();
  for (const m of messages) {
    const text = textOf(m);
    const last = out[out.length - 1];
    switch (m.role) {
      case 'system':
        system.push({ text, cacheBreakpoint: true });
        break;
      case 'user':
        if (shape.mergeSameRole && last?.role === 'user') last.text = `${last.text}\n\n${text}`;
        else out.push({ role: 'user', text });
        break;
      case 'assistant': {
        const toolCalls: ModelToolCall[] = (m.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: parsedArguments(c.function.arguments),
          rawArguments: c.function.arguments,
        }));
        for (const c of toolCalls) callNames.set(c.id, c.name);
        if (shape.mergeSameRole && last?.role === 'assistant' && !last.toolCalls?.length && !last.providerState && toolCalls.length === 0 && !m.providerState) {
          last.text = `${last.text}\n\n${text}`;
          break;
        }
        out.push({
          role: 'assistant',
          text,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(m.providerState ? { providerState: m.providerState } : {}),
        });
        break;
      }
      case 'tool': {
        const callId = m.tool_call_id ?? '';
        const result = { callId, name: m.name ?? callNames.get(callId) ?? '', output: text };
        // The results of one round are one turn, as every dialect answers a round of calls.
        if (last?.role === 'tool') last.results.push(result);
        else out.push({ role: 'tool', results: [result] });
        break;
      }
    }
  }
  if (system.length > 1) system.forEach((p, i) => { p.cacheBreakpoint = i === system.length - 1; });
  return {
    model: shape.model,
    system,
    messages: out,
    tools: shape.tools,
    ...(shape.tools.length > 0 ? { toolChoice: 'auto' as const } : {}),
    maxOutputTokens: shape.maxOutputTokens,
    ...(shape.effort ? { effort: shape.effort } : {}),
    cache: { afterTools: shape.tools.length > 0, atLastMessage: true },
  };
}

/** What the context a call leaves holds, counted as that planner's meter always counted it. */
export type ContextTokens = (usage: ModelUsage) => number | undefined;

/** The prompt and the whole reply: what the next call's prompt carries, as OpenAI's `total_tokens` counts it. */
export const promptAndReply: ContextTokens = (u) => (u.inputTokens === undefined ? undefined : u.inputTokens + (u.outputTokens ?? 0));

/** The prompt and the reply less its thoughts, which a thinking model does not carry into the next prompt. */
export const promptAndAnswer: ContextTokens = (u) =>
  u.inputTokens === undefined ? undefined : u.inputTokens + Math.max(0, (u.outputTokens ?? 0) - (u.reasoningTokens ?? 0));

/**
 * The one record for a call, built only from what the provider reported: a
 * field it left out stays absent. The prompt counts cache reads and writes,
 * and the cached share is the reads alone, since a write is billed as fresh
 * input. A cost is the provider's own figure (OpenRouter's), never estimated.
 */
export function usageRecordOf(source: string, model: string, usage: ModelUsage | undefined, contextTokens: ContextTokens = promptAndReply): UsageRecord | undefined {
  if (!usage) return undefined;
  const record: UsageRecord = { source, model };
  let measured = false;
  if (usage.inputTokens !== undefined) { record.inputTokens = usage.inputTokens; measured = true; }
  if (usage.outputTokens !== undefined) { record.outputTokens = usage.outputTokens; measured = true; }
  if (usage.cacheReadTokens !== undefined) { record.cachedInputTokens = usage.cacheReadTokens; measured = true; }
  if (usage.cost) {
    record.reportedCost = { amount: usage.cost.amount, currency: usage.cost.currency, ...(source === 'openrouter' ? { kind: 'billed' as const } : {}) };
    measured = true;
  }
  const context = contextTokens(usage);
  if (context !== undefined) record.contextTokens = context;
  if (usage.provider) record.provider = usage.provider;
  if (usage.generationId) record.generationId = usage.generationId;
  return measured ? record : undefined;
}

/** What one streamed request returned. */
export interface StreamedReply {
  text: string;
  reasoning: string;
  calls: ModelToolCall[];
  finish?: FinishReason;
  usage?: ModelUsage;
  state?: ProviderState;
}

/** A reply that failed after it began streaming, which the planner drops whole. */
export interface AbandonedReply {
  /** What it streamed. Nothing of it is used; its usage is still the provider's bill. */
  reply: StreamedReply;
  error: ModelError;
  /** The times the call has been sent, this one included. */
  sends: number;
  /** The pause before the call is sent again; absent when it is not, and the failure is thrown. */
  resendInMs?: number;
}

export interface ReplyHooks {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /** Takes each abandoned reply before the call is sent again or fails: what it showed is the caller's to take back. */
  onAbandoned?: (abandoned: AbandonedReply) => void;
}

/**
 * Stream one request to its end, handing text and thinking out as they
 * arrive. This is where every planner call decides what a stream that broke
 * off part way means (a stall `withStreamTimeouts` cut, a dropped
 * connection). A planner reply takes effect only once whole: its text is
 * parsed and its tool calls run after it ends. So a reply that failed part way
 * has done nothing yet, and the same request is sent again with it dropped,
 * under the retry policy and limits the built-in runner's loop sends a cut
 * step again under (ADR-0070). A failure before any event is `withRetry`'s,
 * which has already retried it.
 */
export async function streamReply(
  client: ModelClient,
  request: ModelRequest,
  signal: AbortSignal | undefined,
  hooks: ReplyHooks = {},
): Promise<StreamedReply> {
  let firstCut = 0;
  for (let sends = 1; ; sends++) {
    const reply: StreamedReply = { text: '', reasoning: '', calls: [] };
    let streamed = false;
    try {
      for await (const event of client.stream(request, signal)) {
        streamed = true;
        absorb(reply, event, hooks);
      }
      return reply;
    } catch (err) {
      if (!streamed || !isModelError(err) || signal?.aborted) throw err;
      if (sends === 1) firstCut = Date.now();
      const delayMs = retryDelay(err, sends, Date.now() - firstCut);
      hooks.onAbandoned?.({ reply, error: err, sends, ...(delayMs !== undefined ? { resendInMs: delayMs } : {}) });
      if (delayMs === undefined) throw sends > 1 ? gaveUp(err, sends) : err;
      await sleep(delayMs, signal);
    }
  }
}

function gaveUp(err: ModelError, sends: number): ModelError {
  return new ModelError({
    kind: err.kind,
    message: `${err.message} The planner sent the call ${sends} times, and each reply broke off part way.`,
    ...(err.status !== undefined ? { status: err.status } : {}),
    cause: err,
  });
}

/** The research log's line for a call sent again after its reply broke off; none for one that is not. */
export function resendLine(abandoned: AbandonedReply): string | undefined {
  if (abandoned.resendInMs === undefined) return undefined;
  const wait = `${(abandoned.resendInMs / 1000).toFixed(1)} s`;
  return `[Ordewell] The model request failed part way: ${abandoned.error.message} Its partial reply is dropped and the call is sent again in ${wait} (retry ${abandoned.sends}).`;
}

/** A plan-text call's account of an abandoned reply: what it cost, and its re-send's line. */
export function abandonedPlanText(usage: UsageRecord | undefined, abandoned: AbandonedReply): AbandonedPlanText {
  const line = resendLine(abandoned);
  return { ...(usage ? { usage } : {}), ...(line ? { line } : {}) };
}

function absorb(reply: StreamedReply, event: ModelEvent, hooks: ReplyHooks): void {
  switch (event.type) {
    case 'text-delta':
      reply.text += event.text;
      hooks.onText?.(event.text);
      break;
    case 'thinking-delta':
      reply.reasoning += event.text;
      hooks.onThinking?.(event.text);
      break;
    case 'tool-call-complete':
      reply.calls.push(event.call);
      break;
    case 'usage':
      reply.usage = event.usage;
      break;
    case 'provider-state':
      reply.state = event.state;
      break;
    case 'finish':
      reply.finish = event.reason;
      break;
    default:
      break;
  }
}

/** A finish reason in the words the planner's loop and summaries read: `length` is a cut-off reply. */
export function finishReasonOf(finish: FinishReason | undefined): string | undefined {
  switch (finish) {
    case 'length': return 'length';
    case 'tool-calls': return 'tool_calls';
    case 'content-filter': return 'content_filter';
    case 'stop': return 'stop';
    default: return undefined;
  }
}

/**
 * A summary call (`contextSummary`) on the planner's client: its instructions
 * and the input, no tools. Only the reply's text is the summary; its thinking
 * is not. `asSystem` sends the instructions as the system prompt, as the
 * OpenAI-compatible planner did; the Gemini planner sent one user message.
 */
export function modelSummaryCall(client: () => ModelClient, source: () => string, asSystem: boolean, contextTokens?: ContextTokens): SummaryCall {
  return async ({ model, instructions, input, maxOutputTokens, signal }, onUsage) => {
    const messages: PlannerMessage[] = asSystem
      ? [{ role: 'system', content: instructions }, { role: 'user', content: input }]
      : [{ role: 'user', content: `${instructions}\n\n${input}` }];
    const record = (usage: ModelUsage | undefined): void => {
      const measured = usageRecordOf(source(), model, usage, contextTokens);
      if (measured) onUsage(measured);
    };
    const reply = await streamReply(client(), plannerRequest(messages, { model, tools: [], maxOutputTokens }), signal, {
      onAbandoned: (abandoned) => record(abandoned.reply.usage),
    });
    record(reply.usage);
    const finishReason = finishReasonOf(reply.finish);
    return { text: reply.text, ...(finishReason ? { finishReason } : {}) };
  };
}

// The refusal wordings that state a window: OpenAI's (which compatible servers
// echo), Anthropic's, and Gemini's. A refusal is recognised by its error kind;
// these only read the number it states.
const STATED_WINDOW: ReadonlyArray<{ pattern: RegExp; as: keyof ModelLimits }> = [
  { pattern: /maximum context length is ([\d,]+) tokens/i, as: 'contextWindow' },
  { pattern: /prompt is too long: [\d,]+ tokens > ([\d,]+) maximum/i, as: 'contextWindow' },
  { pattern: /maximum number of tokens allowed \(([\d,]+)\)/i, as: 'inputTokenLimit' },
];

/** The window a refusal as too long states; undefined when it states none. */
export function statedLimits(err: unknown): ModelLimits | undefined {
  const message = err instanceof Error ? err.message : '';
  for (const { pattern, as } of STATED_WINDOW) {
    const stated = pattern.exec(message)?.[1];
    const n = stated ? Number(stated.replace(/,/g, '')) : NaN;
    if (Number.isSafeInteger(n) && n > 0) return { [as]: n };
  }
  return undefined;
}

export interface ModelPlannerChatOptions {
  /** Resolved per call, never captured: a key or endpoint changed mid-conversation must reach the next call. */
  client: () => ModelClient;
  /** Resolved per call like the client: a model picked mid-conversation must reach the next call. */
  model: () => string;
  tools: ToolDefinition[];
  /** Read per call, as the model is. */
  effort?: () => EffortLevel | undefined;
  /** The reply a call asks for when nothing smaller is known. */
  wantedReply: number;
  /** Live thinking, so the UI is not frozen while a reasoning model thinks before its first tool call or word. */
  onReasoning?: (delta: string, segmentId: string) => void;
  /** Live answer text, so a planner message streams into the chat as it is written. */
  onContent?: (delta: string, segmentId: string) => void;
  /** Takes back a segment `onContent` streamed for a reply that broke off and is sent again. */
  onRetracted?: (segmentId: string) => void;
  /** A call's thinking streams as a segment of its own, apart from its text: the Gemini planner's display. */
  thinkingSegment?: boolean;
  mergeSameRole?: boolean;
  contextTokens?: ContextTokens;
  /** The serving provider id, stamped on usage records. */
  source: () => string;
  onUsage?: (record: UsageRecord) => void;
  budget?: ChatBudget;
  compaction?: ChatCompaction;
}

/** An API planner's chat over a `ModelClient`: one streamed request per call. */
export class ModelPlannerChat extends BudgetedChat<PlannerMessage> {
  constructor(seed: PlannerMessage[], private readonly opts: ModelPlannerChatOptions) {
    super(seed, JSON.stringify(opts.tools).length, opts.wantedReply, {
      model: opts.model,
      source: opts.source,
      onUsage: opts.onUsage,
      budget: opts.budget,
      compaction: opts.compaction,
    });
  }

  protected userMessage(text: string): PlannerMessage {
    return { role: 'user', content: text };
  }

  offeredTools(): ReadonlySet<string> {
    return new Set(this.opts.tools.map((tool) => tool.name));
  }

  /** Each result answers the open call of its id, or failing that the one in its place. */
  protected resultMessages(results: ToolResult[]): PlannerMessage[] {
    const calls = this.history.last()?.tool_calls ?? [];
    return results.map((r, i) => ({
      role: 'tool',
      tool_call_id: calls.find((c) => c.id === r.id)?.id ?? r.id ?? calls[i]?.id ?? '',
      name: r.name,
      content: r.output,
    }));
  }

  protected notExecuted(callId: string, name: string, text: string): PlannerMessage {
    return { role: 'tool', tool_call_id: callId, name, content: text };
  }

  protected replayed(messages: ReadonlyArray<Pick<ConversationMessage, 'role' | 'content'>>): PlannerMessage[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * A turn's provider state (reasoning items, thought signatures) goes back
   * with it, so it counts toward the prompt as its text and calls do.
   */
  protected messageSize(m: PlannerMessage): number {
    return messageChars(m) + (m.providerState ? (JSON.stringify(m.providerState.data) ?? '').length : 0);
  }

  protected isContextOverflow(err: unknown): boolean {
    return isModelError(err) && err.kind === 'context-overflow';
  }

  protected statedLimits(err: unknown): ModelLimits | undefined {
    return statedLimits(err);
  }

  protected async callApi(input: CallInput<PlannerMessage>, model: string, maxTokens: number, signal?: AbortSignal): Promise<ResearchTurn> {
    const messages = [...this.history.view(), ...input.messages];
    const sentChars = this.history.chars + this.toolsChars + this.history.charsOf(input.messages);
    const effort = this.opts.effort?.();
    const request = plannerRequest(messages, {
      model,
      tools: this.opts.tools,
      maxOutputTokens: maxTokens,
      ...(effort ? { effort } : {}),
      ...(this.opts.mergeSameRole ? { mergeSameRole: true } : {}),
    });
    // One call is one segment: the text a call streams ends where its tool
    // calls begin, and the next call's text starts a segment of its own.
    let segmentId = uuidv4();
    let thinkingId = this.opts.thinkingSegment ? uuidv4() : segmentId;
    const resends: string[] = [];
    const reply = await streamReply(this.opts.client(), request, signal, {
      onText: (delta) => this.opts.onContent?.(delta, segmentId),
      onThinking: (delta) => this.opts.onReasoning?.(delta, thinkingId),
      onAbandoned: (abandoned) => {
        this.recordUsage(model, abandoned.reply.usage);
        if (abandoned.reply.text) this.opts.onRetracted?.(segmentId);
        const line = resendLine(abandoned);
        if (line) resends.push(line);
        // The next send streams under ids of its own, so none of it runs on from what was taken back.
        segmentId = uuidv4();
        thinkingId = this.opts.thinkingSegment ? uuidv4() : segmentId;
      },
    });

    this.recordUsage(model, reply.usage);
    const promptTokens = reply.usage?.inputTokens;
    this.opts.budget?.gauge.record(model, sentChars, promptTokens);

    const calls = reply.calls.filter((c) => c.name);
    const assistant: PlannerMessage = {
      role: 'assistant',
      content: calls.length > 0 ? reply.text || null : reply.text,
      ...(calls.length > 0 ? { tool_calls: calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.rawArguments } })) } : {}),
      ...(reply.state ? { providerState: reply.state } : {}),
    };
    this.history.append(...input.messages, assistant);

    const toolCalls: ResearchTurn['toolCalls'] = calls.map((c) => ({ name: c.name, args: c.arguments, id: c.id }));
    return {
      text: reply.text,
      toolCalls,
      hasToolCalls: toolCalls.length > 0,
      reasoning: reply.reasoning || undefined,
      finishReason: finishReasonOf(reply.finish),
      promptTokens,
      segmentId,
      ...(resends.length > 0 ? { resends } : {}),
    };
  }

  private recordUsage(model: string, usage: ModelUsage | undefined): void {
    const record = usageRecordOf(this.opts.source(), model, usage, this.opts.contextTokens);
    if (record) this.opts.onUsage?.(record);
  }
}

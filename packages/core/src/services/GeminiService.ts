import { v4 as uuidv4 } from 'uuid';
import {
  GoogleGenerativeAI,
  GenerativeModel,
  Part,
  type Content,
  type Tool,
} from '@google/generative-ai';
import { Task, ConversationMessage, DiscoveredModel, ResearchLogEntry, ResearchProgress, RunnerId, DEFAULT_RUNNERS } from '../models/Task';
import type { UsageRecord } from '../models/Usage';
import { IConfig } from '../interfaces/IConfig';
import { normalizeGeminiModel } from '../interfaces/BaseConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import {
  buildResearchPrompt,
  buildPlanWithResults,
  buildResearchToolsPrompt,
  buildConversationSystemPrompt,
} from './PlanPrompts';
import { generatePlanWithRepair } from './PlanRepair';
import { PLANNER_ESCAPE_HINT } from './plannerReadiness';
import type { RunnerModeInfo } from './ModeResolver';
import { ContextCollector } from './ContextCollector';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from './plannerModes';
import { IAiService, ConversationRequest, ConversationTurn, type ContextCondenseRequest } from './AiService';
import type { TurnBudgets } from './PlannerBudgets';
import { BaseAiService, ResearchChat, ResearchTurn, ToolResult, ConversationTurnContext } from './BaseAiService';
import { listsPost, toGeminiToolDeclarations } from './researchTools';
import { messageChars, type CompactableMessage } from './contextCompaction';
import { BudgetedChat, condenseConversation, type CallInput, type ChatCompaction, type ContextSummarizer } from './budgetedChat';
import type { SummaryCall } from './contextSummary';
import { TokenGauge, callBudget, replyTokens, type ChatBudget, type ModelLimits, type PlannerContextDeps, type PlannerContextStatus } from './plannerContextBudget';

/** No spawn tool (ADR-0005): this service has no `createSubagentChat`, so a spawn would fail on every call. */
const TOOL_DEFINITIONS = toGeminiToolDeclarations(false, false);
/** With the task reads and execution tools a session offers its conversation (ADR-0029). */
const CONVERSATION_TOOL_DEFINITIONS = toGeminiToolDeclarations(true, false);
const BOARD_TOOL_DEFINITIONS = toGeminiToolDeclarations(true, false, true);

interface GeminiPart {
  text?: string;
  thought?: boolean;
  /** The model's reasoning state, which a thinking model needs back with the turn it came on. Untyped in the 0.21 SDK. */
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiTurn {
  role: string;
  parts: GeminiPart[];
}

interface GeminiStreamChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: Record<string, unknown>;
}

/**
 * Narrow one usage counter off the wire. The 0.21 typings predate several of
 * the API's later counters (`thoughtsTokenCount` reaches this service at
 * runtime but is untyped there), so the metadata is read as a raw record and
 * every value is narrowed individually.
 */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * One model call's bill, straight from the stream's final usageMetadata —
 * Gemini never prices calls, so no reportedCost is ever fabricated here.
 *
 * Thought tokens count as output: Gemini reports them separately from
 * candidatesTokenCount (totalTokenCount sums both), and they are tokens the
 * model ran and the invoice charges — leaving them out would understate every
 * thinking-model call. The context the call leaves is its prompt and its
 * completion, `candidatesTokenCount`: the thoughts are not part of the history
 * the next call's prompt carries.
 */
function usageRecordFrom(usage: Record<string, unknown> | undefined, model: string): UsageRecord | undefined {
  if (!usage) return undefined;
  const inputTokens = tokenCount(usage.promptTokenCount);
  const answerTokens = tokenCount(usage.candidatesTokenCount);
  const thoughtTokens = tokenCount(usage.thoughtsTokenCount);
  const reportedOutput = [answerTokens, thoughtTokens].filter((t) => t !== undefined) as number[];
  const record: UsageRecord = {
    source: 'google',
    model,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(reportedOutput.length > 0 ? { outputTokens: reportedOutput.reduce((a, b) => a + b, 0) } : {}),
    ...(tokenCount(usage.cachedContentTokenCount) !== undefined ? { cachedInputTokens: tokenCount(usage.cachedContentTokenCount) } : {}),
    ...(inputTokens !== undefined ? { contextTokens: inputTokens + (answerTokens ?? 0) } : {}),
  };
  const anyReported = record.inputTokens !== undefined || record.outputTokens !== undefined || record.cachedInputTokens !== undefined;
  return anyReported ? record : undefined;
}

/** The reply a Gemini call asks for when its model states no lower cap. */
const GEMINI_REPLY_TOKENS = 16_384;
const GENERATION = { temperature: 0.3, topP: 0.95 };

/**
 * One entry of the history a Gemini chat owns, in the shape compaction reads
 * and rewrites: a turn of function calls is an assistant message whose calls
 * carry ids minted here, and each function response a tool message answering
 * one of them, so pruning and pairing work as they do for every API planner.
 */
interface GeminiMessage extends CompactableMessage {
  content?: string | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  /** A model turn as it streamed, thought signatures included: sent back as it came. */
  turn?: GeminiTurn;
  /** The fields a function response carries beside its output. */
  response?: { name: string; truncated: boolean; totalChars: number };
}

/**
 * Gemini's refusal of a prompt past the model's input limit. The wording is
 * the API's (not checked live against every model); any other refusal is not
 * an overflow, and fails the turn as it always did.
 */
function isContextOverflow(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { status, message } = err as { status?: unknown; message?: unknown };
  return status === 400 && typeof message === 'string' && /input token count.*exceeds the maximum number of tokens/i.test(message);
}

/** The input limit an overflow refusal states, in Gemini's wording: the prompt's alone. */
function statedLimits(err: unknown): ModelLimits | undefined {
  const message = err && typeof err === 'object' ? (err as { message?: unknown }).message : undefined;
  const stated = typeof message === 'string' ? /maximum number of tokens allowed \((\d+)\)/i.exec(message)?.[1] : undefined;
  const limit = stated ? Number(stated) : NaN;
  return Number.isSafeInteger(limit) && limit > 0 ? { inputTokenLimit: limit } : undefined;
}

/**
 * The turns Gemini is sent for `messages`. A tool message's run becomes one
 * `function` turn, as the API wants every call of a turn answered in the next;
 * a user message after another — the goal after the system prompt's turn, or
 * the note a condensed turn adds after the user's — joins its turn as a part
 * of its own, so no two user turns follow each other; a model turn goes back
 * as it streamed, or, swapped in by a reseed, as its text and calls.
 */
function toContents(messages: readonly GeminiMessage[]): GeminiTurn[] {
  const contents: GeminiTurn[] = [];
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool') {
      const part: GeminiPart = {
        functionResponse: {
          name: m.response?.name ?? names.get(m.tool_call_id ?? '') ?? '',
          response: { output: m.content ?? '', ...(m.response ? { truncated: m.response.truncated, totalChars: m.response.totalChars } : {}) },
        },
      };
      const last = contents[contents.length - 1];
      if (last?.role === 'function') last.parts.push(part);
      else contents.push({ role: 'function', parts: [part] });
      continue;
    }
    if (m.role !== 'assistant') {
      const last = contents[contents.length - 1];
      if (last?.role === 'user') last.parts.push({ text: m.content ?? '' });
      else contents.push({ role: 'user', parts: [{ text: m.content ?? '' }] });
      continue;
    }
    for (const call of m.tool_calls ?? []) names.set(call.id, call.function.name);
    contents.push(m.turn ?? {
      role: 'model',
      parts: [
        ...(m.content ? [{ text: m.content }] : []),
        ...(m.tool_calls ?? []).map((call) => ({ functionCall: { name: call.function.name, args: parseArgs(call.function.arguments) } })),
      ],
    });
  }
  return contents;
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const args: unknown = JSON.parse(json);
    return args && typeof args === 'object' ? args as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

interface GeminiChatOptions {
  /** Resolved per call: a model picked mid-conversation must reach the next call, even within a tool loop. */
  model: () => string;
  /** The SDK's model for one call. */
  client: (model: string) => GenerativeModel;
  tools: Tool[];
  /** Hooks absent = the call is assembled silently (one-shot research loop): nothing streams, the turn still forms. */
  onReasoning?: (text: string, segmentId: string) => void;
  onContent?: (text: string, segmentId: string) => void;
  onUsage?: (record: UsageRecord) => void;
  budget?: ChatBudget;
  compaction?: ChatCompaction;
}

/**
 * A Gemini planner's chat. It owns its history rather than the SDK's chat
 * session, which keeps a turn only when the call succeeded: a failed call lost
 * the function responses it carried, and the next request broke Gemini's rule
 * that a call is answered in the very next turn. Here a call's input joins the
 * history once, whatever became of the call, unless it is held to be sent
 * again; and each call is budgeted on its model's input limit as the OpenAI
 * chat budgets on its window (`BudgetedChat`).
 */
class GeminiResearchChat extends BudgetedChat<GeminiMessage> {
  constructor(seed: GeminiMessage[], private readonly opts: GeminiChatOptions) {
    super(seed, JSON.stringify(opts.tools).length, GEMINI_REPLY_TOKENS, {
      model: opts.model,
      source: () => 'google',
      onUsage: opts.onUsage,
      budget: opts.budget,
      compaction: opts.compaction,
    });
  }

  protected userMessage(text: string): GeminiMessage {
    return { role: 'user', content: text };
  }

  /** Each result answers the open call of its id, or failing that the one in its place. */
  protected resultMessages(results: ToolResult[]): GeminiMessage[] {
    const calls = this.history.last()?.tool_calls ?? [];
    return results.map((r, i) => ({
      role: 'tool',
      tool_call_id: calls.find((c) => c.id === r.id)?.id ?? calls[i]?.id,
      content: r.output,
      response: { name: r.name, truncated: r.truncated, totalChars: r.totalChars },
    }));
  }

  protected notExecuted(callId: string, name: string, text: string): GeminiMessage {
    return { role: 'tool', tool_call_id: callId, content: text, response: { name, truncated: false, totalChars: 0 } };
  }

  /** As the conversation is seeded from a replay: consecutive entries of one role become one turn. */
  protected replayed(messages: ReadonlyArray<Pick<ConversationMessage, 'role' | 'content'>>): GeminiMessage[] {
    const turns: GeminiMessage[] = [];
    for (const m of messages) {
      const last = turns[turns.length - 1];
      if (last?.role === m.role) turns[turns.length - 1] = { ...last, content: `${last.content}\n\n${m.content}` };
      else turns.push({ role: m.role, content: m.content });
    }
    return turns;
  }

  /**
   * A model turn goes back as it streamed — the thoughts kept for their
   * signatures, and the signatures — so that, not its text and calls, is
   * what it adds to a prompt.
   */
  protected messageSize(m: GeminiMessage): number {
    return m.turn ? messageChars({ role: m.role }) + JSON.stringify(m.turn.parts).length : messageChars(m);
  }

  protected isContextOverflow(err: unknown): boolean {
    return isContextOverflow(err);
  }

  protected statedLimits(err: unknown): ModelLimits | undefined {
    return statedLimits(err);
  }

  protected async callApi(input: CallInput<GeminiMessage>, model: string, maxOutputTokens: number, signal?: AbortSignal): Promise<ResearchTurn> {
    const contents = toContents([...this.history.view(), ...input.messages]);
    const sentChars = this.history.chars + this.toolsChars + this.history.charsOf(input.messages);
    // The SDK's request options carry the signal onto the HTTP call, which is
    // the only way a Stop (or a reset) ends a stream already under way.
    const result = await this.opts.client(model).generateContentStream({
      contents: contents as Content[],
      tools: this.opts.tools,
      generationConfig: { ...GENERATION, maxOutputTokens },
    }, { signal });
    const { turn, reply } = await this.consume(result.stream, model);
    this.opts.budget?.gauge.record(model, sentChars, reply.promptTokens);
    this.history.append(...input.messages, ...(turn ? [turn] : []));
    return reply;
  }

  /**
   * Drain one streaming call: thought parts answer on the reasoning channel,
   * plain text on the reply channel, function calls accumulate into the turn.
   * Each channel mints one fresh segmentId per call — thinking and reply never
   * share, since a segment is one continuous run of model text — and the call
   * produces exactly one usage record, from the final chunk: Gemini's
   * streaming chunks each carry a running total, so the last one is the whole
   * call's bill. The model turn kept for the history is what streamed, less
   * thought text no signature rides on.
   */
  private async consume(stream: AsyncIterable<unknown>, model: string): Promise<{ turn: GeminiMessage | null; reply: ResearchTurn }> {
    const textSegmentId = uuidv4();
    const thinkingSegmentId = uuidv4();
    let text = '';
    let reasoning = '';
    let finishReason: string | undefined;
    let usage: GeminiStreamChunk['usageMetadata'];
    const parts: GeminiPart[] = [];
    const toolCalls: ResearchTurn['toolCalls'] = [];

    for await (const chunkRaw of stream) {
      const chunk = chunkRaw as GeminiStreamChunk;
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text !== undefined) {
          if (part.thought) { reasoning += part.text; this.opts.onReasoning?.(part.text, thinkingSegmentId); }
          else { text += part.text; this.opts.onContent?.(part.text, textSegmentId); }
        }
        if (part.functionCall) {
          toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {}, id: uuidv4() });
        }
        keepPart(parts, part);
      }
    }

    const usageRecord = usageRecordFrom(usage, model);
    if (usageRecord) this.opts.onUsage?.(usageRecord);

    const turn: GeminiMessage | null = parts.length > 0
      ? {
        role: 'assistant',
        content: text,
        tool_calls: toolCalls.length > 0 ? toolCalls.map((c) => ({ id: c.id!, function: { name: c.name, arguments: JSON.stringify(c.args) } })) : undefined,
        turn: { role: 'model', parts },
      }
      : null;
    // Normalize Gemini's MAX_TOKENS to the OpenAI-style 'length' the
    // conversation loop keys its truncation recovery on.
    return {
      turn,
      reply: {
        text,
        toolCalls,
        hasToolCalls: toolCalls.length > 0,
        reasoning: reasoning || undefined,
        finishReason: finishReason === 'MAX_TOKENS' ? 'length' : undefined,
        promptTokens: usageRecord?.inputTokens,
        segmentId: textSegmentId,
      },
    };
  }
}

/** Add one streamed part to a model turn: text runs join, and thought text goes unless a signature rides on it. */
function keepPart(parts: GeminiPart[], part: GeminiPart): void {
  if (part.thought && !part.thoughtSignature) return;
  const plainText = part.text !== undefined && !part.thought && !part.thoughtSignature && !part.functionCall;
  if (plainText && !part.text) return;
  const last = parts[parts.length - 1];
  if (plainText && last?.text !== undefined && !last.thought && !last.thoughtSignature && !last.functionCall) {
    parts[parts.length - 1] = { text: last.text + part.text };
    return;
  }
  parts.push({ ...part });
}

/** What a Gemini planner is built with beyond its config. */
export interface GeminiServiceDeps extends PlannerContextDeps {
  turnBudgets?: TurnBudgets;
}

export class GeminiService extends BaseAiService implements IAiService {
  private genAI: GoogleGenerativeAI | null = null;
  private genAIKey = '';
  private model: GenerativeModel | null = null;
  /** The id `model` was made for; the SDK's own `model.model` is its `models/…` resource path. */
  private modelId = '';
  /** Outlives a conversation: what a model's provider measured still holds for the next one on it. */
  private readonly gauge = new TokenGauge();

  constructor(config: IConfig, private readonly deps: GeminiServiceDeps = {}) { super(config, deps.turnBudgets); }

  private init(): boolean {
    const apiKey = this.config.apiKey;
    if (!apiKey) return false;
    // A replaced key must not keep serving from the client built with the old one.
    if (!this.genAI || apiKey !== this.genAIKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.genAIKey = apiKey;
      this.model = null;
    }
    return true;
  }

  /** The planner model picked for this session, as the API names it. */
  private plannerModel(): string {
    return normalizeGeminiModel(this.config.orchestratorModel || this.config.planningModel);
  }

  private getPlanningModel(model = this.plannerModel()): GenerativeModel {
    this.init();
    if (!this.model || this.modelId !== model) {
      this.model = this.genAI!.getGenerativeModel({ model, generationConfig: { ...GENERATION, maxOutputTokens: GEMINI_REPLY_TOKENS } });
      this.modelId = model;
    }
    return this.model;
  }

  /**
   * Gemini's catalog states a model's prompt limit (`inputTokenLimit`, which
   * the catalog carries as the model's window) apart from its reply limit
   * (`outputTokenLimit`): the reply is never taken out of the prompt's room.
   */
  private limitsOf(model: string): ModelLimits | undefined {
    const limits = this.deps.modelLimits?.('google', model);
    if (!limits) return undefined;
    return { inputTokenLimit: limits.inputTokenLimit ?? limits.contextWindow, maxOutputTokens: limits.maxOutputTokens };
  }

  private autoCompaction(): boolean {
    return this.deps.autoCompaction?.() ?? true;
  }

  /** Read at each call, so a model or setting changed mid-turn applies from its next call. */
  private plannerBudget(): ChatBudget {
    return {
      limits: (model) => this.limitsOf(model),
      autoCompaction: () => this.autoCompaction(),
      gauge: this.gauge,
      onCompacted: () => this.countCompaction(),
    };
  }

  /** What automatic compaction does for the planner model configured now. */
  plannerContextStatus(): PlannerContextStatus {
    if (!this.autoCompaction()) return { auto: 'off' };
    const model = this.plannerModel();
    const budget = callBudget(this.limitsOf(model), GEMINI_REPLY_TOKENS);
    return budget
      ? { auto: 'on', model, contextWindow: budget.contextWindow, maxOutputTokens: budget.maxOutputTokens }
      : { auto: 'unknown_window', model };
  }

  /** A chat on the planner model, whichever it is at each call. */
  private chat(seed: GeminiMessage[], tools: Tool[], hooks: Pick<GeminiChatOptions, 'onReasoning' | 'onContent' | 'onUsage' | 'compaction'>): GeminiResearchChat {
    return new GeminiResearchChat(seed, {
      model: () => this.plannerModel(),
      client: (model) => this.getPlanningModel(model),
      tools,
      ...hooks,
      budget: this.plannerBudget(),
    });
  }

  /**
   * One call on the planner's own model and key that declares no functions:
   * what a summary of its context is written by. Its usage is reported like
   * any call's, for the caller to mark as measuring no context.
   */
  private readonly summaryCall: SummaryCall = async ({ model, instructions, input, maxOutputTokens, signal }, onUsage) => {
    const result = await this.getPlanningModel(model).generateContentStream({
      contents: [{ role: 'user', parts: [{ text: `${instructions}\n\n${input}` }] }],
      generationConfig: { ...GENERATION, maxOutputTokens },
    }, { signal });
    let text = '';
    let finishReason: string | undefined;
    let usage: GeminiStreamChunk['usageMetadata'];
    for await (const chunkRaw of result.stream) {
      const chunk = chunkRaw as GeminiStreamChunk;
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      // A thought is not the summary: only the reply's text is.
      for (const part of candidate?.content?.parts ?? []) if (part.text && !part.thought) text += part.text;
    }
    const record = usageRecordFrom(usage, model);
    if (record) onUsage(record);
    return { text, finishReason: finishReason === 'MAX_TOKENS' ? 'length' : finishReason };
  };

  private summarizer(): ContextSummarizer {
    const model = this.plannerModel();
    return { model, limits: this.limitsOf(model), wantedReply: GEMINI_REPLY_TOKENS, charsPerToken: this.gauge.charsPerToken(model), call: this.summaryCall };
  }

  async condenseContext(request: ContextCondenseRequest): Promise<string> {
    this.ensureInit();
    return condenseConversation(this.conversation?.ctx.chat, request, () => this.summarizer());
  }

  ensureInit(): void {
    if (!this.init()) throw new Error(`Gemini API key not configured. Set GEMINI_API_KEY or ordewell.apiKey, ${PLANNER_ESCAPE_HINT}.`);
  }

  reset(): void {
    this.activeAbort?.abort();
    this.genAI = null;
    this.model = null;
    this.conversation = null;
  }

  async startConversation(req: ConversationRequest): Promise<ConversationTurn> {
    this.ensureInit();

    const contextStr = await BaseAiService.collectResearchContext(req.fs, req.runners);
    const systemPrompt = buildConversationSystemPrompt(
      req.goal,
      contextStr,
      req.modelsByRunner,
      req.runners,
      req.runnerModes,
      { isolatedExecution: req.isolatedExecution, skills: req.skills, execution: req.plannerTools !== undefined, autorun: req.autorun, subagents: false },
    );

    // Gemini requires strict user/model alternation, so consecutive same-role
    // persisted turns are merged. A leading assistant turn is also absorbed by
    // the system-prompt user message never being followed by a model reply —
    // hence history seeding starts with a synthetic model ack when needed.
    const seed: GeminiMessage[] = [{ role: 'user', content: `${systemPrompt}\n\n${buildResearchToolsPrompt(false)}` }];
    for (const m of req.priorHistory ?? []) {
      const last = seed[seed.length - 1];
      if (last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
      else seed.push({ role: m.role, content: m.content });
    }
    // A seeded history must end on a model turn so the next sendMessage is a
    // user turn of its own (on a fresh start the goal joins the head's turn).
    if ((req.priorHistory?.length ?? 0) > 0 && seed[seed.length - 1].role === 'user') {
      seed.push({ role: 'assistant', content: 'Understood.' });
    }

    let currentProgress = req.onProgress;
    const host = req.compaction;
    const researchChat = this.chat(seed, [{ functionDeclarations: listsPost(req.plannerTools) ? BOARD_TOOL_DEFINITIONS : req.plannerTools ? CONVERSATION_TOOL_DEFINITIONS : TOOL_DEFINITIONS }], {
      onReasoning: (text, segmentId) => currentProgress({ type: 'thinking', text, segmentId }),
      onContent: (text, segmentId) => currentProgress({ type: 'text_delta', text, segmentId }),
      onUsage: (record) => currentProgress({ type: 'usage', record }),
      compaction: host && { host, summarize: this.summaryCall, onCompaction: (compaction) => currentProgress({ type: 'compaction', compaction }) },
    });

    const ctx: ConversationTurnContext = {
      chat: researchChat,
      fs: req.fs,
      runners: req.runners,
      runnerModes: req.runnerModes,
      liveScope: req.liveScope,
      autonomousDefault: req.autonomousDefault,
      fetcher: req.fetcher,
      plannerTools: req.plannerTools?.handler,
      readLimit: req.readLimit,
    };

    this.conversation = { ctx, setProgress: (onProgress) => { currentProgress = onProgress; } };

    const combinedSignal = this.startAbortScope(req.signal);
    try {
      const result = await this.runConversationTurn(ctx, req.initialMessage ?? req.goal, req.onProgress, combinedSignal);
      if (result.kind === 'plan') this.conversation = null;
      return result;
    } finally {
      this.stopAbortScope();
    }
  }


  // --- BaseAiService abstract methods ---

  protected async streamPlanText(
    prompt: string,
    repairHint: string | undefined,
    onToken: (token: string) => void,
    onReasoning?: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const finalParts: Part[] = repairHint
      ? [{ text: prompt }, { text: `\n\n${repairHint}` }]
      : [{ text: prompt }];
    return this.consumePlanStream(await this.emitPlan(finalParts, signal), onToken, onReasoning);
  }

  /**
   * Drain a Gemini content stream, routing "thought" parts to the reasoning channel
   * and answer text to the parser. `chunk.text()` throws when a chunk is reasoning-only,
   * so parts are inspected directly.
   */
  private async consumePlanStream(
    result: Awaited<ReturnType<GenerativeModel['generateContentStream']>>,
    onToken: (token: string) => void,
    onReasoning?: (token: string) => void,
  ): Promise<string> {
    let fullResponse = '';
    for await (const chunk of result.stream) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const text = (part as { text?: string }).text;
        if (!text) continue;
        if ((part as { thought?: boolean }).thought) onReasoning?.(text);
        else { fullResponse += text; onToken(text); }
      }
    }
    return fullResponse;
  }

  /** Gemini-specific stream over raw Parts for generatePlanDirect. */
  private async streamPlanTextWithParts(parts: Part[], repairHint: string | undefined, onToken: (token: string) => void, signal?: AbortSignal): Promise<string> {
    const finalParts: Part[] = repairHint ? [...parts, { text: `\n\n${repairHint}` }] : parts;
    return this.consumePlanStream(await this.emitPlan(finalParts, signal), onToken);
  }

  /** One plan emission, asking for no longer a reply than the model states it serves. */
  private emitPlan(parts: Part[], signal?: AbortSignal): ReturnType<GenerativeModel['generateContentStream']> {
    const model = this.plannerModel();
    return this.getPlanningModel(model).generateContentStream({
      contents: [{ role: 'user', parts }],
      generationConfig: { ...GENERATION, maxOutputTokens: replyTokens(this.limitsOf(model), GEMINI_REPLY_TOKENS) },
    }, { signal });
  }

  // --- IAiService implementation ---

  async researchAndPlan(
    userDescription: string,
    runners: RunnerId[],
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    fs: IFileSystem,
    onProgress: (progress: ResearchProgress) => void,
    fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes: PlannerModes = DEFAULT_PLANNER_MODES,
    signal?: AbortSignal,
  ): Promise<{ tasks: Task[]; researchLog: ResearchLogEntry[]; researchResults: string }> {
    this.ensureInit();
    const { autonomousDefault } = modes;

    const contextStr = await BaseAiService.collectResearchContext(fs, runners);
    const systemPrompt = buildResearchPrompt(userDescription, contextStr, modelsByRunner, runners, runnerModes, modes);
    const firstMessage = `${buildResearchToolsPrompt(false)}\n\nExplore the workspace to understand the codebase, then generate the plan.`;

    // A chat built without streaming hooks: the one-shot loop's replies are
    // never planner chat prose, so they must not stream as text deltas — only
    // the bill flows, one record per call.
    const researchChat: ResearchChat = this.chat([{ role: 'user', content: systemPrompt }], [{ functionDeclarations: TOOL_DEFINITIONS }], {
      onUsage: (record) => onProgress({ type: 'usage', record }),
    });

    const result = await this.runResearchLoop(researchChat, firstMessage, fs, onProgress, runners, undefined, fetcher, userDescription, runnerModes, autonomousDefault, signal);
    if (result.tasks) return { tasks: result.tasks, researchLog: result.researchLog, researchResults: result.researchResults };
    const fallback = await this.generatePlanFallback(userDescription, contextStr, result.researchResults, modelsByRunner, runners, onProgress, result.researchLog, runnerModes, autonomousDefault, signal, modes);
    return { tasks: fallback.tasks, researchLog: fallback.researchLog, researchResults: result.researchResults };
  }

  async generatePlanDirect(
    userDescription: string,
    runners: RunnerId[] = [...DEFAULT_RUNNERS],
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> = {},
    onToken?: (token: string) => void,
    fs?: IFileSystem,
    _fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes: PlannerModes = DEFAULT_PLANNER_MODES,
    signal?: AbortSignal,
  ): Promise<Task[]> {
    this.ensureInit();
    const { autonomousDefault } = modes;
    let ctx = '';
    if (fs) {
      const collected = await new ContextCollector(fs).collect(runners[0] ?? DEFAULT_RUNNERS[0]);
      if (collected.aiflowContext) ctx = `\n<aiflow_context>\n${collected.aiflowContext}\n</aiflow_context>\n`;
    }
    const prompt = buildPlanWithResults(userDescription, ctx, '', modelsByRunner, runners, runnerModes, modes);
    return generatePlanWithRepair((repairHint) =>
      this.streamPlanTextWithParts([{ text: prompt }], repairHint, (token) => onToken?.(token), signal),
      runners,
      2,
      runnerModes,
      autonomousDefault,
    );
  }

}

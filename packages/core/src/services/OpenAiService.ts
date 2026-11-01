import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  ConversationMessage,
  DiscoveredModel,
  ResearchLogEntry,
  ResearchProgress,
  RunnerId,
  DEFAULT_RUNNERS,
} from '../models/Task';
import type { AiProvider, IConfig } from '../interfaces/IConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import {
  buildResearchPrompt,
  buildPlanWithResults,
  buildResearchToolsPrompt,
  buildConversationSystemPrompt,
  buildSubagentSystemPrompt,
} from './PlanPrompts';
import { generatePlanWithRepair } from './PlanRepair';
import type { RunnerModeInfo } from './ModeResolver';
import { ContextCollector } from './ContextCollector';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from './plannerModes';
import { IAiService, ConversationRequest, ConversationTurn, type ContextCondenseRequest } from './AiService';
import type { TurnBudgets } from './PlannerBudgets';
import { BaseAiService, ResearchChat, ResearchTurn, ToolResult, ConversationTurnContext } from './BaseAiService';
import { listsPost, toOpenAiTools, toOpenAiSubagentTools } from './researchTools';
import { getProviderMeta, isApiProvider, stripModelPrefix } from './ProviderRegistry';
import { PLANNER_ESCAPE_HINT } from './plannerReadiness';
import { BudgetedChat, condenseConversation, type CallInput, type ChatCompaction, type ContextSummarizer } from './budgetedChat';
import type { SummaryCall } from './contextSummary';
import { CONTEXT_BUDGET, TokenGauge, callBudget, replyTokens, type ChatBudget, type ModelLimits, type PlannerContextDeps, type PlannerContextStatus } from './plannerContextBudget';
import type { UsageRecord } from '../models/Usage';

/** The subset of an OpenAI-compatible `usage` block this service reads. OpenRouter
 *  adds `cost` (credits, USD) and `prompt_tokens_details.cached_tokens`. */
interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

const KEYLESS_PLACEHOLDER = 'not-needed';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface ChatOptions {
  /** Resolved per API call, never captured: a key or endpoint changed mid-conversation must reach the next turn. */
  client: () => OpenAI;
  /** Resolved per API call like the client: a model picked mid-conversation must reach the next turn. */
  model: () => string;
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  /** Live reasoning deltas during a turn, so the UI isn't frozen while a reasoning
   * model thinks for tens of seconds before it emits any tool call or content. */
  onReasoning?: (delta: string, segmentId: string) => void;
  /** Live answer-content deltas, so planner messages stream into the chat as they
   * are produced instead of appearing all at once when the turn completes. */
  onContent?: (delta: string, segmentId: string) => void;
  /** The serving provider id, stamped on usage records. */
  source?: () => string;
  /** One report per API call — the only way a call's usage leaves this chat. */
  onUsage?: (record: UsageRecord) => void;
  budget?: ChatBudget;
  compaction?: ChatCompaction;
}

/**
 * A refusal of a prompt too long for the model's window. The code is OpenAI's,
 * as its SDK maps the error; the wording is OpenAI's too, which compatible
 * servers echo (not checked against each one live). Any other refusal is not
 * an overflow, and fails the turn as it always did.
 */
function isContextOverflow(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { status, code, message } = err as { status?: unknown; code?: unknown; message?: unknown };
  if (status !== 400) return false;
  return code === 'context_length_exceeded' || (typeof message === 'string' && /maximum context length/i.test(message));
}

/** The window an overflow refusal states, in OpenAI's wording: the whole window, the reply's share included. */
function statedLimits(err: unknown): ModelLimits | undefined {
  const message = err && typeof err === 'object' ? (err as { message?: unknown }).message : undefined;
  const stated = typeof message === 'string' ? /maximum context length is ([\d,]+) tokens/i.exec(message)?.[1] : undefined;
  const window = stated ? Number(stated.replace(/,/g, '')) : NaN;
  return Number.isSafeInteger(window) && window > 0 ? { contextWindow: window } : undefined;
}

/**
 * The one record for an API call, built only from what the provider reported.
 * OpenRouter's `cost` is in USD (its credits are dollar-pegged); nothing is
 * estimated. A field the provider left out stays absent. The context the call
 * leaves is its prompt and its completion: the API's own `total_tokens`, and
 * the reply the next call's prompt carries.
 */
function usageRecord(source: string, model: string, reported: StreamUsage | undefined): UsageRecord | undefined {
  if (!reported) return undefined;
  const record: UsageRecord = { source, model };
  let hasMeasure = false;
  if (reported.prompt_tokens !== undefined) { record.inputTokens = reported.prompt_tokens; hasMeasure = true; }
  if (reported.completion_tokens !== undefined) { record.outputTokens = reported.completion_tokens; hasMeasure = true; }
  if (reported.prompt_tokens_details?.cached_tokens !== undefined) {
    record.cachedInputTokens = reported.prompt_tokens_details.cached_tokens;
    hasMeasure = true;
  }
  if (reported.cost !== undefined) { record.reportedCost = { amount: reported.cost, currency: 'USD', ...(record.source === 'openrouter' ? { kind: 'billed' } : {}) }; hasMeasure = true; }
  if (record.inputTokens !== undefined) record.contextTokens = record.inputTokens + (record.outputTokens ?? 0);
  return hasMeasure ? record : undefined;
}

class OpenAiResearchChat extends BudgetedChat<Message> {
  constructor(messages: Message[], private readonly opts: ChatOptions) {
    super(messages, JSON.stringify(opts.tools).length, CONTEXT_BUDGET.defaultMaxOutputTokens, {
      model: opts.model,
      source: () => opts.source?.() ?? 'openai',
      onUsage: opts.onUsage,
      budget: opts.budget,
      compaction: opts.compaction,
    });
  }

  protected userMessage(text: string): Message {
    return { role: 'user', content: text };
  }

  protected resultMessages(results: ToolResult[]): Message[] {
    return results.map((r) => ({ role: 'tool', tool_call_id: r.id!, content: r.output }));
  }

  protected notExecuted(callId: string, _name: string, text: string): Message {
    return { role: 'tool', tool_call_id: callId, content: text };
  }

  protected replayed(messages: ReadonlyArray<Pick<ConversationMessage, 'role' | 'content'>>): Message[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  protected isContextOverflow(err: unknown): boolean {
    return isContextOverflow(err);
  }

  protected statedLimits(err: unknown): ModelLimits | undefined {
    return statedLimits(err);
  }

  protected async callApi(input: CallInput<Message>, model: string, maxTokens: number, signal?: AbortSignal): Promise<ResearchTurn> {
    const messages = [...this.history.view(), ...input.messages];
    const sentChars = this.history.chars + this.toolsChars + this.history.charsOf(input.messages);
    // Stream the turn so reasoning surfaces live. A non-streamed completion blocks
    // for the model's entire think time with no signal — the "0 steps / nothing for
    // a long time" symptom on reasoning models. Tool-call deltas are reassembled by
    // index into the final message the loop acts on.
    const stream = await this.opts.client().chat.completions.create({
      model,
      messages,
      tools: this.opts.tools,
      tool_choice: 'auto',
      stream: true,
      // Explicit cap, matching streamPlanText: with max_tokens unset, some
      // OpenRouter providers default far lower and silently cut long plan
      // emissions mid-JSON. On a known window it leaves the prompt its room.
      max_tokens: maxTokens,
      // Exact prompt-token usage arrives in the final chunk: the measurement
      // the next call's budget estimate is calibrated on.
      stream_options: { include_usage: true },
    }, signal ? { signal } : undefined);

    // One API call is one segment: the text a call streams ends where its tool
    // calls begin, and the next call's text starts a segment of its own.
    const segmentId = uuidv4();
    let content = '';
    let reasoning = '';
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let reported: StreamUsage | undefined;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const usage = chunk.usage as StreamUsage | undefined;
      if (usage) { reported = usage; promptTokens = usage.prompt_tokens; }
      const fr = chunk.choices[0]?.finish_reason;
      if (fr) finishReason = fr;
      const delta = chunk.choices[0]?.delta as
        | { content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
        | undefined;
      if (!delta) continue;
      if (delta.reasoning) { reasoning += delta.reasoning; this.opts.onReasoning?.(delta.reasoning, segmentId); }
      if (delta.content) { content += delta.content; this.opts.onContent?.(delta.content, segmentId); }
      for (const tc of delta.tool_calls ?? []) {
        const acc = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAcc.set(tc.index, acc);
      }
    }

    const usage = usageRecord(this.opts.source?.() ?? 'openai', model, reported);
    if (usage) this.opts.onUsage?.(usage);
    this.opts.budget?.gauge.record(model, sentChars, promptTokens);

    const accepted = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((v) => v.name);

    // Rebuild the assistant message so subsequent turns (which reference tool_call_id)
    // stay consistent with what we executed.
    const assistantMsg: Message = accepted.length > 0
      ? { role: 'assistant', content: content || null, tool_calls: accepted.map((v) => ({ id: v.id, type: 'function', function: { name: v.name, arguments: v.args } })) }
      : { role: 'assistant', content };
    this.history.append(...input.messages, assistantMsg);

    const toolCalls: ResearchTurn['toolCalls'] = accepted.map((v) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(v.args); } catch { /* empty */ }
      return { name: v.name, args, id: v.id };
    });
    return { text: content, toolCalls, hasToolCalls: toolCalls.length > 0, reasoning: reasoning || undefined, finishReason, promptTokens, segmentId };
  }
}

/** What an API planner is built with beyond its config. */
export interface OpenAiServiceDeps extends PlannerContextDeps {
  turnBudgets?: TurnBudgets;
}

export class OpenAiService extends BaseAiService implements IAiService {
  private client: OpenAI | null = null;
  private clientCredentials = '';
  /** Outlives a conversation: what a model's provider measured still holds for the next one on it. */
  private readonly gauge = new TokenGauge();

  constructor(config: IConfig, private readonly deps: OpenAiServiceDeps = {}) { super(config, deps.turnBudgets); }

  private limitsOf(model: string): ModelLimits | undefined {
    return this.deps.modelLimits?.(this.config.aiProvider, model);
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

  /**
   * One call on the planner's own model and credentials that offers no tools:
   * what a summary of its context is written by. Its usage is reported like
   * any call's, for the caller to mark as measuring no context.
   */
  private readonly summaryCall: SummaryCall = async ({ model, instructions, input, maxOutputTokens, signal }, onUsage) => {
    const stream = await this.getClient().chat.completions.create({
      model,
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }],
      stream: true,
      max_tokens: maxOutputTokens,
      stream_options: { include_usage: true },
    }, signal ? { signal } : undefined);
    let text = '';
    let finishReason: string | undefined;
    let reported: StreamUsage | undefined;
    for await (const chunk of stream) {
      if (chunk.usage) reported = chunk.usage as StreamUsage;
      const fr = chunk.choices[0]?.finish_reason;
      if (fr) finishReason = fr;
      // Reasoning is not the summary: only the reply's content is.
      const content = (chunk.choices[0]?.delta as { content?: string } | undefined)?.content;
      if (content) text += content;
    }
    const usage = usageRecord(this.config.aiProvider, model, reported);
    if (usage) onUsage(usage);
    return { text, finishReason };
  };

  private summarizer(): ContextSummarizer {
    const model = this.requireModel('orchestratorModel', this.config.orchestratorModel);
    return { model, limits: this.limitsOf(model), wantedReply: CONTEXT_BUDGET.defaultMaxOutputTokens, charsPerToken: this.gauge.charsPerToken(model), call: this.summaryCall };
  }

  async condenseContext(request: ContextCondenseRequest): Promise<string> {
    this.ensureInit();
    return condenseConversation(this.conversation?.ctx.chat, request, () => this.summarizer());
  }

  /** What automatic compaction does for the planner model configured now. */
  plannerContextStatus(): PlannerContextStatus {
    if (!this.autoCompaction()) return { auto: 'off' };
    const model = stripModelPrefix((this.config.orchestratorModel ?? '').trim(), this.config.aiProvider);
    const budget = model ? callBudget(this.limitsOf(model)) : undefined;
    return budget
      ? { auto: 'on', model, contextWindow: budget.contextWindow, maxOutputTokens: budget.maxOutputTokens }
      : { auto: 'unknown_window', model };
  }

  /**
   * Rebuilt whenever the key or endpoint differs from the one the client was
   * made with. A Session outlives `/key` and endpoint edits, so a client cached
   * for good kept sending the previous key: the provider answered 401 for a
   * key the user had already replaced.
   */
  private getClient(): OpenAI {
    const provider = this.vendor();
    const baseURL = this.config.getProviderBaseUrl(provider);
    // Keyless local servers (ollama, LM Studio) are valid `openai_compatible`
    // targets, but the SDK refuses an empty key outright.
    const apiKey = this.config.getProviderApiKey(provider) || KEYLESS_PLACEHOLDER;
    const credentials = `${baseURL}\n${apiKey}`;
    if (!this.client || credentials !== this.clientCredentials) {
      this.client = new OpenAI({ baseURL, apiKey });
      this.clientCredentials = credentials;
    }
    return this.client;
  }

  /** The vendor this service talks to; `createAiService` routes every other planner elsewhere. */
  private vendor(): AiProvider {
    const provider = this.config.aiProvider;
    if (!isApiProvider(provider)) throw new Error(`Unknown planner provider "${provider}".`);
    return provider;
  }

  ensureInit(): void {
    const provider = this.vendor();
    if (provider === 'openai_compatible') {
      if (!this.config.openaiCompatibleBaseUrl) {
        throw new Error(`OpenAI-compatible base URL not configured. Set OPENAI_COMPATIBLE_BASE_URL, ${PLANNER_ESCAPE_HINT}.`);
      }
      return;
    }
    if (!this.config.getProviderApiKey(provider)) {
      const meta = getProviderMeta(provider);
      throw new Error(`${meta.label} API key not configured. Set ${meta.apiKeyEnvVar}, ${PLANNER_ESCAPE_HINT}.`);
    }
  }

  private requireModel(field: string, value: string | undefined | null): string {
    // Picker/stored ids carry a provider qualifier (e.g. `openai:gpt-4o`,
    // `openai_compat:llama3`); the serving API only knows the bare model name.
    const id = stripModelPrefix((value ?? '').trim(), this.config.aiProvider);
    if (!id) throw new Error(`OpenAI model not configured: "${field}" is empty.`);
    return id;
  }

  reset(): void { this.activeAbort?.abort(); this.client = null; this.conversation = null; }

  // --- BaseAiService abstract methods ---

  protected async streamPlanText(
    prompt: string,
    repairHint: string | undefined,
    onToken: (token: string) => void,
    onReasoning?: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const client = this.getClient();
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'user', content: prompt }];
    if (repairHint) messages.push({ role: 'user', content: repairHint });
    const model = this.requireModel('orchestratorModel', this.config.orchestratorModel);
    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
      max_tokens: replyTokens(this.limitsOf(model)),
    }, { signal });
    let fullResponse = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as { content?: string; reasoning?: string } | undefined;
      // Only content contributes to the text handed to the parser; reasoning is routed
      // to the thinking trace so chain-of-thought can never pollute the JSON.
      const reasoning = delta?.reasoning;
      if (reasoning) onReasoning?.(reasoning);
      const token = delta?.content;
      if (token) { fullResponse += token; onToken(token); }
    }
    return fullResponse;
  }

  /** A research subagent: fresh history, digest contract, cheap model, read-only tools. */
  protected createSubagentChat(onReasoning?: (delta: string) => void, onUsage?: (record: UsageRecord) => void): ResearchChat | null {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSubagentSystemPrompt() },
    ];
    return new OpenAiResearchChat(messages, {
      client: () => this.getClient(),
      model: () => this.requireModel('researchSubagentModel', this.config.researchSubagentModel),
      tools: toOpenAiSubagentTools(),
      onReasoning,
      source: () => this.config.aiProvider,
      onUsage,
    });
  }

  // --- Conversation loop (ADR-0002) ---

  async startConversation(req: ConversationRequest): Promise<ConversationTurn> {
    this.ensureInit();

    const contextStr = await BaseAiService.collectResearchContext(req.fs, req.runners);
    const systemPrompt = buildConversationSystemPrompt(
      req.goal,
      contextStr,
      req.modelsByRunner,
      req.runners,
      req.runnerModes,
      { isolatedExecution: req.isolatedExecution, skills: req.skills, execution: req.plannerTools !== undefined, autorun: req.autorun },
    );

    const userText = req.goal;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${systemPrompt}\n\n${buildResearchToolsPrompt()}` },
    ];
    for (const m of req.priorHistory ?? []) {
      messages.push({ role: m.role, content: m.content });
    }

    let currentProgress = req.onProgress;
    const host = req.compaction;
    const chat = new OpenAiResearchChat(messages, {
      client: () => this.getClient(),
      model: () => this.requireModel('orchestratorModel', this.config.orchestratorModel),
      tools: toOpenAiTools(req.plannerTools !== undefined, listsPost(req.plannerTools)),
      onReasoning: (delta, segmentId) => currentProgress({ type: 'thinking', text: delta, segmentId }),
      onContent: (delta, segmentId) => currentProgress({ type: 'text_delta', text: delta, segmentId }),
      source: () => this.config.aiProvider,
      onUsage: (record) => currentProgress({ type: 'usage', record }),
      budget: this.plannerBudget(),
      compaction: host && { host, summarize: this.summaryCall, onCompaction: (compaction) => currentProgress({ type: 'compaction', compaction }) },
    });

    const ctx: ConversationTurnContext = {
      chat,
      fs: req.fs,
      runners: req.runners,
      runnerModes: req.runnerModes,
      liveScope: req.liveScope,
      autonomousDefault: req.autonomousDefault,
      fetcher: req.fetcher,
      plannerTools: req.plannerTools?.handler,
    };

    this.conversation = {
      ctx,
      setProgress: (onProgress) => { currentProgress = onProgress; },
    };

    const combinedSignal = this.startAbortScope(req.signal);
    try {
      const result = await this.runConversationTurn(ctx, req.initialMessage ?? userText, req.onProgress, combinedSignal);
      if (result.kind === 'plan') this.conversation = null;
      return result;
    } finally {
      this.stopAbortScope();
    }
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

    const userText = `User goal: ${userDescription}`;
    const firstMessage = `${buildResearchToolsPrompt()}\n\nExplore the workspace to understand the codebase, then generate the plan.\n\n${userText}`;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    const researchChat: ResearchChat = new OpenAiResearchChat(messages, {
      client: () => this.getClient(),
      model: () => this.requireModel('orchestratorModel', this.config.orchestratorModel),
      tools: toOpenAiTools(),
      onReasoning: (delta) => onProgress({ type: 'thinking', text: delta }),
      source: () => this.config.aiProvider,
      onUsage: (record) => onProgress({ type: 'usage', record }),
      budget: this.plannerBudget(),
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
      this.streamPlanText(prompt, repairHint, (token) => onToken?.(token), undefined, signal),
      runners,
      2,
      runnerModes,
      autonomousDefault,
    );
  }

}

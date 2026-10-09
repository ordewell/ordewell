import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  DiscoveredModel,
  ResearchLogEntry,
  ResearchProgress,
  RunnerId,
  DEFAULT_RUNNERS,
} from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import {
  buildResearchPrompt,
  buildPlanWithResults,
  buildModifyPlanPrompt,
  buildResearchToolsPrompt,
  buildConversationSystemPrompt,
  buildSubagentSystemPrompt,
} from './PlanPrompts';
import { generatePlanWithRepair } from './PlanRepair';
import type { RunnerModeInfo } from './ModeResolver';
import { ContextCollector } from './ContextCollector';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from './plannerModes';
import { IAiService, ConversationRequest, ConversationTurn } from './AiService';
import { BaseAiService, ResearchChat, ResearchTurn, ToolResult, ConversationTurnContext } from './BaseAiService';
import { toOpenAiTools, toOpenAiSubagentTools } from './researchTools';
import { getProviderMeta, stripModelPrefix } from './ProviderRegistry';
import { compactToolMessages, type CompactableMessage } from './contextCompaction';
import type { UsageRecord } from '../models/Usage';
import type { LegacyPlanState } from '../models/Task';

/** The subset of an OpenAI-compatible `usage` block this service reads. OpenRouter
 *  adds `cost` (credits, USD) and `prompt_tokens_details.cached_tokens`. */
interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

const KEYLESS_PLACEHOLDER = 'not-needed';

class OpenAiResearchChat implements ResearchChat {
  constructor(
    private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    /** Resolved per API call, never captured: a key or endpoint changed mid-conversation must reach the next turn. */
    private getClient: () => OpenAI,
    /** Resolved per API call like the client: a model picked mid-conversation must reach the next turn. */
    private getModel: () => string,
    private tools: OpenAI.Chat.Completions.ChatCompletionTool[],
    /** Live reasoning deltas during a turn, so the UI isn't frozen while a reasoning
     * model thinks for tens of seconds before it emits any tool call or content. */
    private onReasoning?: (delta: string, segmentId: string) => void,
    /** Live answer-content deltas, so planner messages stream into the chat as they
     * are produced instead of appearing all at once when the turn completes. */
    private onContent?: (delta: string, segmentId: string) => void,
    /** The serving provider id, stamped on usage records. */
    private getSource: () => string = () => 'openai',
    /** One report per API call — the only way a call's usage leaves this chat. */
    private onUsage?: (record: UsageRecord) => void,
    /** The model's context window when the catalog knows it; omitted from records otherwise. */
    private contextWindow?: number,
  ) {}

  async sendMessage(text: string, signal?: AbortSignal): Promise<ResearchTurn> {
    this.answerAbandonedCalls();
    this.messages.push({ role: 'user', content: text });
    return this.callApi(signal);
  }

  /**
   * A turn that gave up on its tool budget, or was stopped, can end on calls
   * nothing answered — and the API refuses every later request over a history
   * like that. They are answered as never run before the next message.
   */
  private answerAbandonedCalls(): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role !== 'assistant' || !last.tool_calls?.length) return;
    for (const call of last.tool_calls) {
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Not executed: the turn that asked for this ended first.' });
    }
  }

  async sendToolResults(results: ToolResult[], signal?: AbortSignal): Promise<ResearchTurn> {
    for (const r of results) {
      this.messages.push({ role: 'tool', tool_call_id: r.id!, content: r.output });
    }
    return this.callApi(signal);
  }

  compactHistory(): number {
    return compactToolMessages(this.messages as CompactableMessage[]);
  }

  private async callApi(signal?: AbortSignal): Promise<ResearchTurn> {
    // Stream the turn so reasoning surfaces live. A non-streamed completion blocks
    // for the model's entire think time with no signal — the "0 steps / nothing for
    // a long time" symptom on reasoning models. Tool-call deltas are reassembled by
    // index into the final message the loop acts on.
    const stream = await this.getClient().chat.completions.create({
      model: this.getModel(),
      messages: this.messages,
      tools: this.tools,
      tool_choice: 'auto',
      stream: true,
      // Explicit cap, matching streamPlanText: with max_tokens unset, some
      // OpenRouter providers default far lower and silently cut long plan
      // emissions mid-JSON.
      max_tokens: 32000,
      // Exact prompt-token usage arrives in the final chunk — the signal
      // proactive history compaction keys on.
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
      if (delta.reasoning) { reasoning += delta.reasoning; this.onReasoning?.(delta.reasoning, segmentId); }
      if (delta.content) { content += delta.content; this.onContent?.(delta.content, segmentId); }
      for (const tc of delta.tool_calls ?? []) {
        const acc = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAcc.set(tc.index, acc);
      }
    }

    const usage = this.usageRecord(reported);
    if (usage) this.onUsage?.(usage);

    const accepted = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((v) => v.name);

    // Rebuild the assistant message so subsequent turns (which reference tool_call_id)
    // stay consistent with what we executed.
    const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = accepted.length > 0
      ? { role: 'assistant', content: content || null, tool_calls: accepted.map((v) => ({ id: v.id, type: 'function', function: { name: v.name, arguments: v.args } })) }
      : { role: 'assistant', content };
    this.messages.push(assistantMsg);

    const toolCalls: ResearchTurn['toolCalls'] = accepted.map((v) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(v.args); } catch { /* empty */ }
      return { name: v.name, args, id: v.id };
    });
    return { text: content, toolCalls, hasToolCalls: toolCalls.length > 0, reasoning: reasoning || undefined, finishReason, promptTokens };
  }

  /**
   * The one record for this API call, built only from what the provider
   * reported. OpenRouter's `cost` is in USD (its credits are dollar-pegged);
   * nothing is estimated. A field the provider left out stays absent.
   */
  private usageRecord(reported: StreamUsage | undefined): UsageRecord | undefined {
    if (!reported) return undefined;
    const record: UsageRecord = { source: this.getSource(), model: this.getModel() };
    let hasMeasure = false;
    if (reported.prompt_tokens !== undefined) { record.inputTokens = reported.prompt_tokens; hasMeasure = true; }
    if (reported.completion_tokens !== undefined) { record.outputTokens = reported.completion_tokens; hasMeasure = true; }
    if (reported.prompt_tokens_details?.cached_tokens !== undefined) {
      record.cachedInputTokens = reported.prompt_tokens_details.cached_tokens;
      hasMeasure = true;
    }
    if (reported.cost !== undefined) { record.reportedCost = { amount: reported.cost, currency: 'USD' }; hasMeasure = true; }
    if (this.contextWindow && this.contextWindow > 0) record.contextWindow = this.contextWindow;
    return hasMeasure ? record : undefined;
  }
}

export class OpenAiService extends BaseAiService implements IAiService {
  private client: OpenAI | null = null;
  private clientCredentials = '';

  constructor(config: IConfig) { super(config); }

  /**
   * Rebuilt whenever the key or endpoint differs from the one the client was
   * made with. A Session outlives `/key` and endpoint edits, so a client cached
   * for good kept sending the previous key: the provider answered 401 for a
   * key the user had already replaced.
   */
  private getClient(): OpenAI {
    const provider = this.config.aiProvider;
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

  ensureInit(): void {
    const provider = this.config.aiProvider;
    if (provider === 'openai_compatible') {
      if (!this.config.openaiCompatibleBaseUrl) {
        throw new Error('OpenAI-compatible base URL not configured. Set OPENAI_COMPATIBLE_BASE_URL.');
      }
      return;
    }
    if (!this.config.getProviderApiKey(provider)) {
      const meta = getProviderMeta(provider);
      throw new Error(`${meta.label} API key not configured. Set ${meta.apiKeyEnvVar}.`);
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
    const stream = await client.chat.completions.create({
      model: this.requireModel('orchestratorModel', this.config.orchestratorModel),
      messages,
      stream: true,
      max_tokens: 32000,
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
    return new OpenAiResearchChat(
      messages,
      () => this.getClient(),
      () => this.requireModel('researchSubagentModel', this.config.researchSubagentModel),
      toOpenAiSubagentTools(),
      onReasoning,
      undefined,
      () => this.config.aiProvider,
      onUsage,
    );
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
      req.autonomousDefault ?? true,
      { isolatedExecution: req.isolatedExecution },
    );

    const userText = req.goal;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${systemPrompt}\n\n${buildResearchToolsPrompt()}` },
    ];
    for (const m of req.priorHistory ?? []) {
      messages.push({ role: m.role, content: m.content });
    }

    let currentProgress = req.onProgress;
    const chat = new OpenAiResearchChat(
      messages,
      () => this.getClient(),
      () => this.requireModel('orchestratorModel', this.config.orchestratorModel),
      toOpenAiTools(),
      (delta, segmentId) => currentProgress({ type: 'thinking', text: delta, segmentId }),
      (delta, segmentId) => currentProgress({ type: 'text_delta', text: delta, segmentId }),
      () => this.config.aiProvider,
      (record) => currentProgress({ type: 'usage', record }),
      req.contextWindow,
    );

    const ctx: ConversationTurnContext = {
      chat,
      fs: req.fs,
      runners: req.runners,
      runnerModes: req.runnerModes,
      autonomousDefault: req.autonomousDefault,
      fetcher: req.fetcher,
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

    const researchChat: ResearchChat = new OpenAiResearchChat(
      messages,
      () => this.getClient(),
      () => this.requireModel('orchestratorModel', this.config.orchestratorModel),
      toOpenAiTools(),
      (delta) => onProgress({ type: 'thinking', text: delta }),
      undefined,
      () => this.config.aiProvider,
      (record) => onProgress({ type: 'usage', record }),
    );

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
      const collected = await new ContextCollector(fs).collect(runners[0] ?? 'claude-code');
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

  async modifyPlan(
    existingPlan: LegacyPlanState,
    userRequest: string,
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    onProgress?: (progress: ResearchProgress) => void,
    fs?: IFileSystem,
    _fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes: PlannerModes = DEFAULT_PLANNER_MODES,
    signal?: AbortSignal,
  ): Promise<{ tasks: Task[] }> {
    this.ensureInit();
    const { autonomousDefault } = modes;
    let aiflowContext: string | undefined;
    if (fs) {
      const collected = await new ContextCollector(fs).collect(existingPlan.runners[0] ?? 'claude-code');
      if (collected.aiflowContext) aiflowContext = collected.aiflowContext;
    }
    const prompt = buildModifyPlanPrompt(existingPlan, userRequest, modelsByRunner, aiflowContext, runnerModes, autonomousDefault);
    try {
      const tasks = await generatePlanWithRepair((repairHint) =>
        this.streamPlanText(prompt, repairHint, (token) => onProgress?.({ type: 'plan_token', planToken: token }), undefined, signal),
        existingPlan.runners,
        2,
        runnerModes,
        autonomousDefault,
      );
      return { tasks };
    } catch (err) {
      throw new Error(`Plan modification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

}

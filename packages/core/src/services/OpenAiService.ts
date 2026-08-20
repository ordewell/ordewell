import OpenAI from 'openai';
import {
  Task,
  DiscoveredModel,
  ResearchLogEntry,
  ResearchProgress,
  RunnerId,
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
import { stripModelPrefix } from './ProviderRegistry';
import { compactToolMessages, type CompactableMessage } from './contextCompaction';
import type { LegacyPlanState } from '../models/Task';

class OpenAiResearchChat implements ResearchChat {
  constructor(
    private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    private client: OpenAI,
    private model: string,
    private tools: OpenAI.Chat.Completions.ChatCompletionTool[],
    /** Live reasoning deltas during a turn, so the UI isn't frozen while a reasoning
     * model thinks for tens of seconds before it emits any tool call or content. */
    private onReasoning?: (delta: string) => void,
    /** Live answer-content deltas, so planner messages stream into the chat as they
     * are produced instead of appearing all at once when the turn completes. */
    private onContent?: (delta: string) => void,
  ) {}

  async sendMessage(text: string, signal?: AbortSignal): Promise<ResearchTurn> {
    this.messages.push({ role: 'user', content: text });
    return this.callApi(signal);
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
    const stream = await this.client.chat.completions.create({
      model: this.model,
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

    let content = '';
    let reasoning = '';
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) promptTokens = chunk.usage.prompt_tokens;
      const fr = chunk.choices[0]?.finish_reason;
      if (fr) finishReason = fr;
      const delta = chunk.choices[0]?.delta as
        | { content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
        | undefined;
      if (!delta) continue;
      if (delta.reasoning) { reasoning += delta.reasoning; this.onReasoning?.(delta.reasoning); }
      if (delta.content) { content += delta.content; this.onContent?.(delta.content); }
      for (const tc of delta.tool_calls ?? []) {
        const acc = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAcc.set(tc.index, acc);
      }
    }

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
}

export class OpenAiService extends BaseAiService implements IAiService {
  private client: OpenAI | null = null;

  constructor(config: IConfig) { super(config); }

  private getClient(): OpenAI {
    if (!this.client) {
      const baseUrl = this.config.getProviderBaseUrl(this.config.aiProvider);
      const apiKey = this.config.getProviderApiKey(this.config.aiProvider);
      this.client = new OpenAI({ baseURL: baseUrl, apiKey });
    }
    return this.client;
  }

  ensureInit(): void {
    if (this.config.aiProvider === 'openai_compatible' && !this.config.openaiCompatibleBaseUrl) {
      throw new Error('OpenAI-compatible base URL not configured. Set OPENAI_COMPATIBLE_BASE_URL.');
    }
    const apiKey = this.config.getProviderApiKey(this.config.aiProvider);
    if (!apiKey) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY.');
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
  protected createSubagentChat(onReasoning?: (delta: string) => void): ResearchChat | null {
    const client = this.getClient();
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSubagentSystemPrompt() },
    ];
    return new OpenAiResearchChat(
      messages,
      client,
      this.requireModel('researchSubagentModel', this.config.researchSubagentModel),
      toOpenAiSubagentTools(),
      onReasoning,
    );
  }

  // --- Conversation loop (ADR-0002) ---

  async startConversation(req: ConversationRequest): Promise<ConversationTurn> {
    this.ensureInit();
    const client = this.getClient();

    const contextStr = await BaseAiService.collectResearchContext(req.fs, req.runners);
    const systemPrompt = buildConversationSystemPrompt(
      req.goal,
      contextStr,
      req.modelsByRunner,
      req.runners,
      req.runnerModes,
      req.autonomousDefault ?? true,
      req.verificationEnabled ?? false,
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
      client,
      this.requireModel('orchestratorModel', this.config.orchestratorModel),
      toOpenAiTools(),
      (delta) => currentProgress({ type: 'thinking', text: delta }),
      (delta) => currentProgress({ type: 'plan_token', planToken: delta }),
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
    const client = this.getClient();
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
      client,
      this.requireModel('orchestratorModel', this.config.orchestratorModel),
      toOpenAiTools(),
      (delta) => onProgress({ type: 'thinking', text: delta }),
    );

    const result = await this.runResearchLoop(researchChat, firstMessage, fs, onProgress, runners, undefined, fetcher, userDescription, runnerModes, autonomousDefault, signal);
    if (result.tasks) return { tasks: result.tasks, researchLog: result.researchLog, researchResults: result.researchResults };
    const fallback = await this.generatePlanFallback(userDescription, contextStr, result.researchResults, modelsByRunner, runners, onProgress, result.researchLog, runnerModes, autonomousDefault, signal, modes);
    return { tasks: fallback.tasks, researchLog: fallback.researchLog, researchResults: result.researchResults };
  }

  async generatePlanDirect(
    userDescription: string,
    runners: RunnerId[] = ['claude-code'],
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

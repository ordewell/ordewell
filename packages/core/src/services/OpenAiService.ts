import {
  Task,
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
import { BaseAiService, ResearchChat, ConversationTurnContext, type PlanTextCall } from './BaseAiService';
import { listsPost, plannerToolDefinitions, subagentToolDefinitions } from './researchTools';
import { getProviderMeta, isApiProvider, stripModelPrefix } from './ProviderRegistry';
import { PLANNER_ESCAPE_HINT } from './plannerReadiness';
import { condenseConversation, type ContextSummarizer } from './budgetedChat';
import type { SummaryCall } from './contextSummary';
import { CONTEXT_BUDGET, TokenGauge, callBudget, largestReplyTokens, replyTokens, type ChatBudget, type ModelLimits, type PlannerContextDeps, type PlannerContextStatus } from './plannerContextBudget';
import type { UsageRecord } from '../models/Usage';
import type { EffortLevel, ModelClient } from './model';
import {
  ModelPlannerChat,
  PlannerClients,
  modelSummaryCall,
  plannerEffort,
  plannerRequest,
  streamReply,
  usageRecordOf,
  type ModelClientFactory,
  type PlannerMessage,
} from './modelPlannerChat';

/** What an API planner is built with beyond its config. */
export interface OpenAiServiceDeps extends PlannerContextDeps {
  turnBudgets?: TurnBudgets;
  /** How a client is made for the provider's dialect; tests hand in a fake. */
  modelClient?: ModelClientFactory;
}

/**
 * The API planner for every vendor but Google, which `GeminiService` serves.
 * It reaches its model through a `ModelClient` by the vendor's dialect
 * (ADR-0002): Anthropic over Messages, OpenAI over Responses, every other
 * vendor over Chat Completions.
 */
export class OpenAiService extends BaseAiService implements IAiService {
  private readonly clients: PlannerClients;
  /** Outlives a conversation: what a model's provider measured still holds for the next one on it. */
  private readonly gauge = new TokenGauge();

  constructor(config: IConfig, private readonly deps: OpenAiServiceDeps = {}) {
    super(config, deps.turnBudgets);
    this.clients = new PlannerClients(deps.modelClient);
  }

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
  private readonly summaryCall: SummaryCall = modelSummaryCall(() => this.getClient(), () => this.config.aiProvider, true);

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
   * made with (`PlannerClients`). A keyless local server (ollama, LM Studio)
   * is a valid `openai_compatible` target: its adapter sends a placeholder.
   */
  private getClient(): ModelClient {
    const provider = this.vendor();
    return this.clients.get(provider, this.config.getProviderApiKey(provider), this.config.getProviderBaseUrl(provider));
  }

  /** The planner's effort dial, read per call as its model is. */
  private effort(): EffortLevel | undefined {
    return plannerEffort(this.config.plannerThinkingEffort);
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

  reset(): void { this.activeAbort?.abort(); this.clients.reset(); this.conversation = null; }

  // --- BaseAiService abstract methods ---

  protected async streamPlanText(
    prompt: string,
    repairHint: string | undefined,
    onToken: (token: string) => void,
    onReasoning?: (token: string) => void,
    signal?: AbortSignal,
    call: PlanTextCall = {},
  ): Promise<string> {
    const messages: PlannerMessage[] = [{ role: 'user', content: prompt }];
    if (repairHint) messages.push({ role: 'user', content: repairHint });
    const model = this.requireModel('orchestratorModel', this.config.orchestratorModel);
    const effort = call.effort ?? this.effort();
    const limits = this.limitsOf(model);
    // Only the reply's text is handed to the parser; thinking is routed to the
    // trace so chain-of-thought can never pollute the JSON.
    const reply = await streamReply(
      this.getClient(),
      plannerRequest(messages, { model, tools: [], maxOutputTokens: call.largestReply ? largestReplyTokens(limits) : replyTokens(limits), ...(effort ? { effort } : {}) }),
      signal,
      { onText: onToken, ...(onReasoning ? { onThinking: onReasoning } : {}) },
    );
    call.onReply?.({ usage: usageRecordOf(this.config.aiProvider, model, reply.usage), cutOff: reply.finish === 'length' });
    return reply.text;
  }

  /** A research subagent: fresh history, digest contract, cheap model, read-only tools. */
  protected createSubagentChat(onReasoning?: (delta: string) => void, onUsage?: (record: UsageRecord) => void, only?: ReadonlySet<string>): ResearchChat | null {
    const messages: PlannerMessage[] = [{ role: 'system', content: buildSubagentSystemPrompt(only !== undefined) }];
    // No effort: the planner's dial is its own, and a subagent keeps the cheap model's default.
    return new ModelPlannerChat(messages, {
      client: () => this.getClient(),
      model: () => this.requireModel('researchSubagentModel', this.config.researchSubagentModel),
      tools: subagentToolDefinitions(only),
      wantedReply: CONTEXT_BUDGET.defaultMaxOutputTokens,
      ...(onReasoning ? { onReasoning: (delta: string) => onReasoning(delta) } : {}),
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

    const messages: PlannerMessage[] = [
      { role: 'system', content: `${systemPrompt}\n\n${buildResearchToolsPrompt()}` },
    ];
    for (const m of req.priorHistory ?? []) {
      messages.push({ role: m.role, content: m.content });
    }

    let currentProgress = req.onProgress;
    const host = req.compaction;
    const chat = new ModelPlannerChat(messages, {
      client: () => this.getClient(),
      model: () => this.requireModel('orchestratorModel', this.config.orchestratorModel),
      tools: plannerToolDefinitions(req.plannerTools !== undefined, listsPost(req.plannerTools)),
      effort: () => this.effort(),
      wantedReply: CONTEXT_BUDGET.defaultMaxOutputTokens,
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
      readLimit: req.readLimit,
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

    const messages: PlannerMessage[] = [{ role: 'system', content: systemPrompt }];

    const researchChat: ResearchChat = new ModelPlannerChat(messages, {
      client: () => this.getClient(),
      model: () => this.requireModel('orchestratorModel', this.config.orchestratorModel),
      tools: plannerToolDefinitions(),
      effort: () => this.effort(),
      wantedReply: CONTEXT_BUDGET.defaultMaxOutputTokens,
      onReasoning: (delta) => onProgress({ type: 'thinking', text: delta }),
      source: () => this.config.aiProvider,
      onUsage: (record) => onProgress({ type: 'usage', record }),
      budget: this.plannerBudget(),
    });

    const result = await this.runResearchLoop(researchChat, firstMessage, fs, onProgress, runners, undefined, fetcher, userDescription, runnerModes, autonomousDefault, signal);
    const review = (tasks: Task[], log: ResearchLogEntry[]) => this.reviewLongChain(tasks, userDescription, contextStr, result.researchResults, modelsByRunner, runners, onProgress, runnerModes, signal, modes, log, fs);
    if (result.tasks) return { tasks: await review(result.tasks, result.researchLog), researchLog: result.researchLog, researchResults: result.researchResults };
    const fallback = await this.generatePlanFallback(userDescription, contextStr, result.researchResults, modelsByRunner, runners, onProgress, result.researchLog, runnerModes, autonomousDefault, signal, modes);
    return { tasks: await review(fallback.tasks, fallback.researchLog), researchLog: fallback.researchLog, researchResults: result.researchResults };
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

import { Task, DiscoveredModel, ResearchLogEntry, ResearchProgress, RunnerId, DEFAULT_RUNNERS } from '../models/Task';
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
import { BaseAiService, ResearchChat, ConversationTurnContext, type PlanTextCall } from './BaseAiService';
import { listsPost, plannerToolDefinitions } from './researchTools';
import { condenseConversation, type ContextSummarizer } from './budgetedChat';
import type { SummaryCall } from './contextSummary';
import { TokenGauge, callBudget, largestReplyTokens, replyTokens, type ChatBudget, type ModelLimits, type PlannerContextDeps, type PlannerContextStatus } from './plannerContextBudget';
import type { EffortLevel, ModelClient, ToolDefinition } from './model';
import {
  ModelPlannerChat,
  PlannerClients,
  abandonedPlanText,
  modelSummaryCall,
  plannerEffort,
  plannerRequest,
  promptAndAnswer,
  streamReply,
  usageRecordOf,
  type ModelClientFactory,
  type ModelPlannerChatOptions,
  type PlannerMessage,
} from './modelPlannerChat';

/** No spawn tool (ADR-0005): this service has no `createSubagentChat`, so a spawn would fail on every call. */
const TOOL_DEFINITIONS = plannerToolDefinitions(false, false, false);
/** With the task reads and execution tools a session offers its conversation (ADR-0029). */
const CONVERSATION_TOOL_DEFINITIONS = plannerToolDefinitions(true, false, false);
const BOARD_TOOL_DEFINITIONS = plannerToolDefinitions(true, true, false);

const GEMINI_REPLY_TOKENS = 16_384;

export interface GeminiServiceDeps extends PlannerContextDeps {
  turnBudgets?: TurnBudgets;
  /** How a client is made for the Gemini dialect; tests hand in a fake. */
  modelClient?: ModelClientFactory;
}

/**
 * The Google planner, through the Gemini adapter (ADR-0002). Its chat keeps
 * its own history rather than a chat session's, so a failed call's function
 * responses stay in it and the next request still answers each call in the
 * very next turn (`BudgetedChat`).
 */
export class GeminiService extends BaseAiService implements IAiService {
  private readonly clients: PlannerClients;
  /** Outlives a conversation: what a model's provider measured still holds for the next one on it. */
  private readonly gauge = new TokenGauge();

  constructor(config: IConfig, private readonly deps: GeminiServiceDeps = {}) {
    super(config, deps.turnBudgets);
    this.clients = new PlannerClients(deps.modelClient);
  }

  /** A replaced key or endpoint must not keep serving from the client built with the old one. */
  private getClient(): ModelClient {
    return this.clients.get('google', this.config.apiKey, this.config.getProviderBaseUrl('google'));
  }

  private effort(): EffortLevel | undefined {
    return plannerEffort(this.config.plannerThinkingEffort);
  }

  /** The planner model picked for this session, as the API names it. */
  private plannerModel(): string {
    return normalizeGeminiModel(this.config.orchestratorModel || this.config.planningModel);
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

  /**
   * A chat on the planner model, whichever it is at each call. Consecutive
   * turns of one role go as one, as Gemini takes a conversation, and a
   * call's thinking streams as a segment apart from its text.
   */
  private chat(seed: PlannerMessage[], tools: ToolDefinition[], hooks: Pick<ModelPlannerChatOptions, 'onReasoning' | 'onContent' | 'onRetracted' | 'onUsage' | 'compaction'>): ModelPlannerChat {
    return new ModelPlannerChat(seed, {
      client: () => this.getClient(),
      model: () => this.plannerModel(),
      tools,
      effort: () => this.effort(),
      wantedReply: GEMINI_REPLY_TOKENS,
      thinkingSegment: true,
      mergeSameRole: true,
      contextTokens: promptAndAnswer,
      source: () => 'google',
      ...hooks,
      budget: this.plannerBudget(),
    });
  }

  /**
   * One call on the planner's own model and key that declares no functions:
   * what a summary of its context is written by. Its usage is reported like
   * any call's, for the caller to mark as measuring no context.
   */
  private readonly summaryCall: SummaryCall = modelSummaryCall(() => this.getClient(), () => 'google', false, promptAndAnswer);

  private summarizer(): ContextSummarizer {
    const model = this.plannerModel();
    return { model, limits: this.limitsOf(model), wantedReply: GEMINI_REPLY_TOKENS, charsPerToken: this.gauge.charsPerToken(model), call: this.summaryCall };
  }

  async condenseContext(request: ContextCondenseRequest): Promise<string> {
    this.ensureInit();
    return condenseConversation(this.conversation?.ctx.chat, request, () => this.summarizer());
  }

  ensureInit(): void {
    if (!this.config.apiKey) throw new Error(`Gemini API key not configured. Set GEMINI_API_KEY or ordewell.apiKey, ${PLANNER_ESCAPE_HINT}.`);
  }

  reset(): void {
    this.activeAbort?.abort();
    this.clients.reset();
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
    const seed: PlannerMessage[] = [{ role: 'user', content: `${systemPrompt}\n\n${buildResearchToolsPrompt(false)}` }];
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
    const researchChat = this.chat(seed, listsPost(req.plannerTools) ? BOARD_TOOL_DEFINITIONS : req.plannerTools ? CONVERSATION_TOOL_DEFINITIONS : TOOL_DEFINITIONS, {
      onReasoning: (text, segmentId) => currentProgress({ type: 'thinking', text, segmentId }),
      onContent: (text, segmentId) => currentProgress({ type: 'text_delta', text, segmentId }),
      onRetracted: (segmentId) => currentProgress({ type: 'text_retracted', segmentId }),
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
    call?: PlanTextCall,
  ): Promise<string> {
    return this.emitPlan(prompt, repairHint, onToken, onReasoning, signal, call);
  }

  /**
   * One plan emission, asking for no longer a reply than the model states it
   * serves. The repair hint joins the prompt's turn; only the reply's text is
   * handed to the parser, its thoughts to the reasoning channel.
   */
  private async emitPlan(prompt: string, repairHint: string | undefined, onToken: (token: string) => void, onReasoning?: (token: string) => void, signal?: AbortSignal, call: PlanTextCall = {}): Promise<string> {
    const model = this.plannerModel();
    const effort = call.effort ?? this.effort();
    const messages: PlannerMessage[] = [{ role: 'user', content: prompt }];
    if (repairHint) messages.push({ role: 'user', content: repairHint });
    const reply = await streamReply(
      this.getClient(),
      plannerRequest(messages, {
        model,
        tools: [],
        maxOutputTokens: (call.largestReply ? largestReplyTokens : replyTokens)(this.limitsOf(model), GEMINI_REPLY_TOKENS),
        mergeSameRole: true,
        ...(effort ? { effort } : {}),
      }),
      signal,
      {
        onText: onToken,
        ...(onReasoning ? { onThinking: onReasoning } : {}),
        onAbandoned: (a) => call.onAbandoned?.(abandonedPlanText(usageRecordOf('google', model, a.reply.usage, promptAndAnswer), a)),
      },
    );
    call.onReply?.({ usage: usageRecordOf('google', model, reply.usage, promptAndAnswer), cutOff: reply.finish === 'length' });
    return reply.text;
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
    const researchChat: ResearchChat = this.chat([{ role: 'user', content: systemPrompt }], TOOL_DEFINITIONS, {
      onUsage: (record) => onProgress({ type: 'usage', record }),
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
      this.emitPlan(prompt, repairHint, (token) => onToken?.(token), undefined, signal),
      runners,
      2,
      runnerModes,
      autonomousDefault,
    );
  }

}

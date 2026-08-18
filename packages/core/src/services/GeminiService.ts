import {
  GoogleGenerativeAI,
  GenerativeModel,
  Part,
} from '@google/generative-ai';
import { Task, DiscoveredModel, ResearchLogEntry, ResearchProgress, RunnerId } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import {
  buildResearchPrompt,
  buildPlanWithResults,
  buildModifyPlanPrompt,
  buildResearchToolsPrompt,
  buildConversationSystemPrompt,
} from './PlanPrompts';
import { generatePlanWithRepair } from './PlanRepair';
import type { RunnerModeInfo } from './ModeResolver';
import { ContextCollector } from './ContextCollector';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from './plannerModes';
import { IAiService, ConversationRequest, ConversationTurn } from './AiService';
import { BaseAiService, ResearchChat, ResearchTurn, ToolResult, ConversationTurnContext } from './BaseAiService';
import { toGeminiToolDeclarations } from './researchTools';
import type { LegacyPlanState } from '../models/Task';

const TOOL_DEFINITIONS = toGeminiToolDeclarations();

interface GeminiResult {
  response: {
    candidates?: Array<{
      content?: { parts?: Array<Record<string, unknown>> };
      finishReason?: string;
    }>;
    usageMetadata?: { promptTokenCount?: number };
  };
}

function parseGeminiTurn(resultRaw: unknown): ResearchTurn {
  const result = resultRaw as GeminiResult;
  const candidate = result.response.candidates?.[0];
  if (!candidate) return { text: '', toolCalls: [], hasToolCalls: false };
  const parts = candidate.content?.parts || [];
  let text = '';
  let reasoning = '';
  const toolCalls: ResearchTurn['toolCalls'] = [];
  for (const part of parts) {
    if ('text' in part) {
      if ((part as { thought?: boolean }).thought) reasoning += (part as { text: string }).text;
      else text += (part as { text: string }).text;
    }
    if ('functionCall' in part) {
      const fc = part.functionCall as { name: string; args: Record<string, unknown> };
      toolCalls.push({ name: fc.name, args: fc.args });
    }
  }
  // Normalize Gemini's MAX_TOKENS to the OpenAI-style 'length' the
  // conversation loop keys its truncation recovery on.
  const finishReason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : undefined;
  const promptTokens = result.response.usageMetadata?.promptTokenCount;
  return { text, toolCalls, hasToolCalls: toolCalls.length > 0, reasoning: reasoning || undefined, finishReason, promptTokens };
}

class GeminiResearchChat implements ResearchChat {
  constructor(
    private chat: ReturnType<GenerativeModel['startChat']>,
    /** Gemini's chat API is non-streaming here, so reasoning/content are emitted once per turn. */
    private onReasoning?: (text: string) => void,
    private onContent?: (text: string) => void,
  ) {}

  async sendMessage(text: string, signal?: AbortSignal): Promise<ResearchTurn> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = await this.chat.sendMessage(text);
    return this.emit(parseGeminiTurn(result));
  }

  async sendToolResults(results: ToolResult[], signal?: AbortSignal): Promise<ResearchTurn> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const funcResponses = results.map(r => ({
      functionResponse: {
        name: r.name,
        response: { output: r.output, truncated: r.truncated, totalChars: r.totalChars },
      },
    }));
    const result = await this.chat.sendMessage(funcResponses);
    return this.emit(parseGeminiTurn(result));
  }

  private emit(turn: ResearchTurn): ResearchTurn {
    if (turn.reasoning) this.onReasoning?.(turn.reasoning);
    if (turn.text && !turn.hasToolCalls) this.onContent?.(turn.text);
    return turn;
  }
}

export class GeminiService extends BaseAiService implements IAiService {
  private genAI: GoogleGenerativeAI | null = null;
  private model: GenerativeModel | null = null;

  constructor(config: IConfig) { super(config); }

  private init(): boolean {
    if (!this.config.apiKey) return false;
    if (!this.genAI) this.genAI = new GoogleGenerativeAI(this.config.apiKey);
    return true;
  }

  private getPlanningModel(): GenerativeModel {
    if (!this.genAI) this.init();
    if (!this.model || this.model.model !== this.config.planningModel) {
      this.model = this.genAI!.getGenerativeModel({
        model: this.config.planningModel,
        generationConfig: { temperature: 0.3, topP: 0.95, maxOutputTokens: 16384 },
      });
    }
    return this.model;
  }

  ensureInit(): void {
    if (!this.init()) throw new Error('Gemini API key not configured. Set GEMINI_API_KEY or ordewell.apiKey.');
  }

  reset(): void {
    this.activeAbort?.abort();
    this.genAI = null;
    this.model = null;
    this.conversation = null;
  }

  async startConversation(req: ConversationRequest): Promise<ConversationTurn> {
    this.ensureInit();
    const genModel = this.getPlanningModel();

    const contextStr = await BaseAiService.collectResearchContext(req.fs, req.runners);
    const systemPrompt = buildConversationSystemPrompt(
      req.goal,
      contextStr,
      req.modelsByRunner,
      req.runners,
      req.runnerModes,
      req.autonomousDefault ?? true,
      req.grillMeEnabled ?? false,
      req.prdEnabled ?? false,
      req.verificationEnabled ?? false,
    );

    // Gemini requires strict user/model alternation, so consecutive same-role
    // persisted turns are merged. A leading assistant turn is also absorbed by
    // the system-prompt user message never being followed by a model reply —
    // hence history seeding starts with a synthetic model ack when needed.
    const seededHistory: { role: 'user' | 'model'; parts: Part[] }[] = [
      { role: 'user', parts: [{ text: `${systemPrompt}\n\n${buildResearchToolsPrompt()}` }] },
    ];
    for (const m of req.priorHistory ?? []) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const last = seededHistory[seededHistory.length - 1];
      if (last.role === role) {
        last.parts.push({ text: `\n\n${m.content}` });
      } else {
        seededHistory.push({ role, parts: [{ text: m.content }] });
      }
    }
    // A seeded history must end on a model turn so the next sendMessage is a
    // user turn (only relevant on resume; the fresh path keeps its old shape).
    if ((req.priorHistory?.length ?? 0) > 0 && seededHistory[seededHistory.length - 1].role === 'user') {
      seededHistory.push({ role: 'model', parts: [{ text: 'Understood.' }] });
    }

    const chat = genModel.startChat({
      history: seededHistory,
      tools: [{ functionDeclarations: TOOL_DEFINITIONS }],
      generationConfig: { temperature: 0.3, topP: 0.95, maxOutputTokens: 16384 },
    });

    let currentProgress = req.onProgress;
    const researchChat = new GeminiResearchChat(
      chat,
      (text) => currentProgress({ type: 'thinking', text }),
      (text) => currentProgress({ type: 'plan_token', planToken: text }),
    );

    const ctx: ConversationTurnContext = {
      chat: researchChat,
      fs: req.fs,
      runners: req.runners,
      runnerModes: req.runnerModes,
      autonomousDefault: req.autonomousDefault,
      fetcher: req.fetcher,
      prdEnabled: req.prdEnabled ?? false,
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
    _signal?: AbortSignal,
  ): Promise<string> {
    const model = this.getPlanningModel();
    const finalParts: Part[] = repairHint
      ? [{ text: prompt }, { text: `\n\n${repairHint}` }]
      : [{ text: prompt }];
    const result = await model.generateContentStream({
      contents: [{ role: 'user', parts: finalParts }],
    });
    return this.consumePlanStream(result, onToken, onReasoning);
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

  /** Gemini-specific stream over raw Parts for generatePlanDirect / modifyPlan. */
  private async streamPlanTextWithParts(parts: Part[], repairHint: string | undefined, onToken: (token: string) => void): Promise<string> {
    const model = this.getPlanningModel();
    const finalParts: Part[] = repairHint ? [...parts, { text: `\n\n${repairHint}` }] : parts;
    const result = await model.generateContentStream({
      contents: [{ role: 'user', parts: finalParts }],
    });
    return this.consumePlanStream(result, onToken);
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
    const genModel = this.getPlanningModel();

    const contextStr = await BaseAiService.collectResearchContext(fs, runners);
    const systemPrompt = buildResearchPrompt(userDescription, contextStr, modelsByRunner, runners, runnerModes, modes);
    const firstMessage = `${buildResearchToolsPrompt()}\n\nExplore the workspace to understand the codebase, then generate the plan.`;

    const chat = genModel.startChat({
      history: [{ role: 'user', parts: [{ text: systemPrompt }] }],
      tools: [{ functionDeclarations: TOOL_DEFINITIONS }],
      generationConfig: { temperature: 0.3, topP: 0.95, maxOutputTokens: 16384 },
    });

    const researchChat: ResearchChat = new GeminiResearchChat(chat);

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
    _signal?: AbortSignal,
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
      this.streamPlanTextWithParts([{ text: prompt }], repairHint, (token) => onToken?.(token)),
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
    _signal?: AbortSignal,
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
        this.streamPlanTextWithParts([{ text: prompt }], repairHint, (token) =>
          onProgress?.({ type: 'plan_token', planToken: token })
        ),
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

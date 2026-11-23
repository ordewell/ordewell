import { v4 as uuidv4 } from 'uuid';
import { Task, DiscoveredModel, ResearchStep, ResearchLogEntry, ResearchProgress, RunnerId } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem, type ToolOutcome } from '../interfaces/IFileSystem';
import type { PlannerReadLimit } from './plannerReadLimit';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import { buildPlanWithResults } from './PlanPrompts';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from './plannerModes';
import { generatePlanWithRepair, classifyPlannerReply, repairLoop } from './PlanRepair';
import { CHAIN_REVIEW_MIN, applyChainReview, chainReviewMessage, longestChain } from './PlanChainReview';
import { shapeFanOut } from './PlanFanOut';
import { settleReply, type ReplyAttempt } from './settleReply';
import { compactResearchResults, type CompactableMessage } from './contextCompaction';
import type { RunnerModeInfo } from './ModeResolver';
import type { PlanIntake } from './PlanChangeCheck';
import { collectResearchContext } from './ContextCollector';
import { PLANNER_EXECUTION_TOOLS, PLANNER_POST, PLANNER_RECORD, PLANNER_TASK_READ_TOOLS, type PlannerToolHandler } from './mcp/tools';
import { redactSourceText } from '../utils/redactSecrets';
import { executeTool, STOPPED_TOOL_RESULT } from './executeTool';
import { runResearchAgent, mapWithConcurrency, SUBAGENT_LIMITS } from './ResearchSubagents';
import { SPAWN_RESEARCH_AGENT, isExecutionTool } from './researchTools';
import { classifyOutcome } from './researchStepSummary';
import { addUsage, type UsageTotals } from '../models/Usage';
import type { ConversationTurn, TurnRun } from './AiService';
import type { UsageRecord } from '../models/Usage';
import { abortScope } from '../utils/abortScope';
import { withTurnBudgets, type TurnBudgets } from './PlannerBudgets';
import { isModelError, type EffortLevel } from './model';
import { writtenToolCall } from './textCall';

/** What a one-shot plan call reports besides its text. */
export interface PlanTextReply {
  usage?: UsageRecord;
  cutOff: boolean;
}

export interface AbandonedPlanText {
  usage?: UsageRecord;
  line?: string;
}

/** The research log's entry for a line Ordewell writes there itself. */
export function systemEntry(content: string): ResearchLogEntry {
  return { id: `sys-${uuidv4()}`, type: 'system', content, timestamp: new Date().toISOString() };
}

/** The instruction a call written as text is answered with: short, since the model knows the tool. */
function writtenCallNote(name: string): string {
  return `[Ordewell] Your last reply wrote a tool call (${name}) as text, so it was not made. Make the call with the tool, not in your reply text.`;
}

/** The same, for a call written beside calls the reply made: those ran, and the model must not take the written one for one of them. */
function writtenBesideNote(name: string): string {
  return `[Ordewell] Your last reply also wrote a tool call (${name}) as text, so it was not made: only the calls you made through the tool ran. Make it with the tool, not in your reply text.`;
}

/** A note on a round, appended to its last result: the API history takes no message between a round and its results. */
function appendNote(toolResults: ToolResult[], text: string): void {
  const last = toolResults[toolResults.length - 1];
  if (!last) return;
  const note = `\n\n${text}`;
  last.output += note;
  last.totalChars += note.length;
}

/**
 * What the turn's record says when the instruction did not help, or could not
 * (a call made after the tool budget is spent never runs): nothing ran, and no
 * surface reports the turn as done silently.
 */
function writtenCallRecord(name: string, budgetSpent = false): ResearchLogEntry {
  return systemEntry(budgetSpent
    ? `[Ordewell] The planner wrote a ${name} call as text after its tool budget was spent: the call was not executed.`
    : `[Ordewell] The planner wrote a ${name} call as text, twice, and did not make it: the call was not executed.`);
}

/** How one plan-text call departs from the planner's own settings. */
export interface PlanTextCall {
  /** Takes the call's usage, for the planner's bill, and whether the reply was cut off at the output limit. */
  onReply?: (reply: PlanTextReply) => void;
  /** Takes each reply that broke off part way: its usage, and the research log's line when the call is sent again. */
  onAbandoned?: (abandoned: AbandonedPlanText) => void;
  /** Replaces the planner's dial for this call. */
  effort?: EffortLevel;
  /** Asks for the longest reply the model serves, not the planner's usual allowance. */
  largestReply?: boolean;
}

/**
 * Read-only, side-effect-free tools that can share a round. Deliberately a
 * denylist's opposite: `bash`, `fetch` and `web_search` are excluded because
 * they can pause on a user approval prompt, and an unknown tool is excluded
 * because we cannot reason about it.
 */
const PARALLEL_SAFE_TOOLS = new Set(['read_file', 'read_files', 'glob', 'grep', 'find_symbol', 'list_dir']);

/** The planner's own workspace reads and commands, charged to its read limit (ADR-0068). */
const OWN_READ_TOOLS = new Set([...PARALLEL_SAFE_TOOLS, 'bash']);

/** Concurrency for the read-only pre-pass. Bounded so a wide round cannot exhaust file handles. */
const TOOL_ROUND_CONCURRENCY = 8;

/**
 * A task read, a `post`, a `record` (ADR-0067) or an execution tool call (ADR-0029), answered by the session's
 * planner tools through the same handler and argument check the MCP route
 * uses. Undefined for any other tool, or when the session offered no handler.
 */
async function callPlannerTool(handler: PlannerToolHandler | undefined, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome | undefined> {
  const read = PLANNER_TASK_READ_TOOLS.find((t) => t.name === name);
  const tool = handler ? read ?? [...PLANNER_EXECUTION_TOOLS, PLANNER_POST, PLANNER_RECORD].find((t) => t.name === name) : undefined;
  if (!handler || !tool) return undefined;
  if (signal?.aborted) return { success: false, output: STOPPED_TOOL_RESULT, truncated: false };
  const reply = await tool.call(handler, args, { signal: signal ?? new AbortController().signal });
  return { success: !reply.isError, output: read ? redactSourceText(reply.text) : reply.text, truncated: false };
}

/**
 * How a step names its tool: an execution tool, `post` or `record` has no
 * research tool type, so it is an agent tool under its own name, as a harness
 * planner's is.
 */
function stepTool(name: string, handler: PlannerToolHandler | undefined): { tool: string; toolLabel?: string } {
  return handler && (isExecutionTool(name) || name === PLANNER_POST.name || name === PLANNER_RECORD.name) ? { tool: 'agent_tool', toolLabel: name } : { tool: name };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ToolResult {
  name: string;
  output: string;
  truncated: boolean;
  totalChars: number;
  id?: string;
}

export interface ResearchTurn {
  text: string;
  toolCalls: ToolCall[];
  hasToolCalls: boolean;
  /** Reasoning/chain-of-thought captured separately from `text` so it never pollutes plan JSON. */
  reasoning?: string;
  /** Provider finish reason, normalized: 'length' means the output-token limit cut the reply mid-stream. */
  finishReason?: string;
  /** Exact prompt tokens this turn consumed, when the provider reports usage. */
  promptTokens?: number;
  /** The segment `text` streamed under, where the provider streams it. */
  segmentId?: string;
  /** One line for each time the call was sent again after its reply broke off part way, for the research log. */
  resends?: string[];
}

export interface ResearchChat {
  sendMessage(text: string, signal?: AbortSignal): Promise<ResearchTurn>;
  sendToolResults(results: ToolResult[], signal?: AbortSignal): Promise<ResearchTurn>;
  /**
   * Optional: prune older workspace reads from the history (everything else,
   * and the newest rounds, are kept) so a follow-up emission has context to
   * spend on output. Returns the number of characters removed.
   */
  compactHistory?(): number;
  /**
   * Whether a call's input is held: the call could not fit the model's window
   * (`PlannerContextExhaustedError`), so its user message or tool results were
   * kept out of the history. The next message drops a held message and files
   * held results as a turn before it.
   */
  holdsInput?(): boolean;
  /** Send the held input again, once room is made: no tool runs a second time. */
  resend?(signal?: AbortSignal): Promise<ResearchTurn>;
  /** Whether {@link retry} can send the held input: a window is known to compact against. */
  retryable?(): boolean;
  /** The user's Retry compaction: condense with their consent, then send the held input once. */
  retry?(signal?: AbortSignal): Promise<ResearchTurn>;
  /**
   * Take `history` in place of the whole message list in one step — a summary
   * swapped in for what it condensed. Refused, changing nothing, unless each
   * tool result answers a call of the assistant message just before it, once.
   */
  reseed?(history: readonly CompactableMessage[]): void;
  /**
   * Optional: the answer to a call the open turn already made in rounds
   * condensed out of the model's sight, in place of running it again
   * (ADR-0002). Undefined for a call that runs.
   */
  answered?(call: ToolCall): string | undefined;
  /**
   * The names of the tools this chat offers its model. Only a chat that runs
   * the model's own tool calls has them: a reply of one that writes such a call
   * out as text is answered (ADR-0070). A harness planner's chat has none.
   */
  offeredTools?(): ReadonlySet<string>;
}

/** Everything one conversation turn needs beyond the user message itself. */
export interface ConversationTurnContext {
  chat: ResearchChat;
  fs: IFileSystem;
  runners: RunnerId[];
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  /** See {@link ConversationRequest.liveScope}. */
  liveScope?: () => PlanIntake;
  autonomousDefault?: boolean;
  fetcher?: IWebFetcher;
  /** The session's planner tools; the conversation offers their task reads and execution tools (ADR-0029) when set. */
  plannerTools?: PlannerToolHandler;
  /** The planner's own reads this turn (ADR-0068); `run_command` is charged where the session runs it. */
  readLimit?: PlannerReadLimit;
}

export abstract class BaseAiService {
  protected conversation: { ctx: ConversationTurnContext; setProgress: (fn: (p: ResearchProgress) => void) => void } | null = null;
  protected activeAbort: AbortController | null = null;
  /** See {@link compactions}. */
  private compacted = 0;

  constructor(protected config: IConfig, protected turnBudgets?: TurnBudgets) {}

  abstract reset(): void;
  abstract ensureInit(): void;

  hasActiveConversation(): boolean { return this.conversation !== null; }

  pruneContext(): number {
    return this.conversation?.ctx.chat.compactHistory?.() ?? 0;
  }

  /**
   * The compactions of a conversation's history that changed something, which
   * the chat reports through {@link countCompaction}. A pruning stubs tool
   * output alone, never the user messages a plan block rides in, but it counts
   * all the same: the conversation would rather send the plan whole again than
   * trust a context changed under it (ADR-0012 T10).
   */
  compactions(): number { return this.compacted; }

  protected countCompaction(): void { this.compacted++; }

  protected startAbortScope(callerSignal?: AbortSignal): AbortSignal {
    this.activeAbort = abortScope(callerSignal);
    return this.activeAbort.signal;
  }

  protected stopAbortScope(): void {
    this.activeAbort = null;
  }

  async continueConversation(
    userMessage: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<ConversationTurn> {
    this.ensureInit();
    if (!this.conversation) throw new Error('No active planner conversation. Start planning first.');
    this.conversation.setProgress(onProgress);
    const combinedSignal = this.startAbortScope(signal);
    try {
      const result = await this.runConversationTurn(this.conversation.ctx, userMessage, onProgress, combinedSignal);
      if (result.kind === 'plan') this.conversation = null;
      return result;
    } finally {
      this.stopAbortScope();
    }
  }

  heldInputRetryable(): boolean {
    return this.conversation?.ctx.chat.retryable?.() ?? false;
  }

  /** The turn a held input was for, carried on from it: its first call is the retry, every later one as in any turn. */
  async retryHeldInput(onProgress: (progress: ResearchProgress) => void, signal?: AbortSignal): Promise<ConversationTurn> {
    this.ensureInit();
    const chat = this.conversation?.ctx.chat;
    if (!this.conversation || !chat?.retry || !this.heldInputRetryable()) throw new Error('The planner holds no input to retry.');
    this.conversation.setProgress(onProgress);
    const combinedSignal = this.startAbortScope(signal);
    try {
      const result = await this.runConversationTurn(this.conversation.ctx, '', onProgress, combinedSignal, () => chat.retry!(combinedSignal));
      if (result.kind === 'plan') this.conversation = null;
      return result;
    } finally {
      this.stopAbortScope();
    }
  }

  protected abstract streamPlanText(
    prompt: string,
    repairHint: string | undefined,
    onToken: (token: string) => void,
    onReasoning?: (token: string) => void,
    signal?: AbortSignal,
    call?: PlanTextCall,
  ): Promise<string>;

  /**
   * Build a fresh chat for one research subagent (own history, subagent system
   * prompt, cheap model). Null means the provider does not support subagents —
   * the spawn tool then degrades to a steering message. `onReasoning` streams
   * live reasoning deltas on models that expose them, same as the top-level loop;
   * `onUsage` takes each call's usage, as the planner's own chat reports it.
   */
  protected createSubagentChat(_onReasoning?: (delta: string) => void, _onUsage?: (record: UsageRecord) => void, _only?: ReadonlySet<string>): ResearchChat | null { return null; }

  /**
   * A confined research chat for a harness planner's `spawn_research_agent`
   * (ADR-0066): this service's subagent chat with the workspace reads alone
   * declared, or null where it has none (Gemini).
   */
  confinedResearchChat(onReasoning: (delta: string) => void, onUsage: (record: UsageRecord) => void, only: ReadonlySet<string>): ResearchChat | null {
    return this.createSubagentChat(onReasoning, onUsage, only);
  }

  /**
   * One spawn_research_agent tool call, executed at the service layer (not in
   * executeTool — that would cycle the imports). Every failure path returns a
   * steering/failed result and the loop continues sequentially: a subagent can
   * never fail a plan or a turn.
   */
  private async executeSpawnAgent(
    args: Record<string, unknown>,
    fs: IFileSystem,
    onProgress: (progress: ResearchProgress) => void,
    signal: AbortSignal | undefined,
    subagentId: string,
    fetcher: IWebFetcher | undefined,
  ): Promise<{ success: boolean; output: string; truncated: boolean }> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
      return { success: false, output: 'spawn_research_agent requires a non-empty "prompt" string: a self-contained task for the agent, including what its digest must report back.', truncated: false };
    }
    // Every usage record that surfaces from this subagent's own loop belongs to
    // it, so the finish event can carry the totals. Providers that report none
    // leave them undefined.
    let usage: UsageTotals | undefined;
    return runResearchAgent(prompt, {
      createChat: (onReasoning, onUsage) => {
        const chat = this.createSubagentChat(onReasoning, onUsage);
        if (!chat) throw new Error('subagent chats are not available for this provider');
        return chat;
      },
      fs,
      signal,
      subagentId,
      // The subagent gets web tools only behind a non-prompting gate: no
      // approval channel exists in the background, so a read that would ask is
      // refused instead (ADR-0027, ADR-0008 T6).
      fetcher: fetcher?.forSubagent?.(),
      model: this.config.researchSubagentModel,
      usage: () => usage,
      onProgress: (progress) => {
        if (progress.type === 'usage' && progress.record) usage = addUsage(usage ?? {}, progress.record);
        onProgress(progress);
      },
    });
  }

  /** Collect project context for the planning phase. Shared with the harness backend. */
  protected static async collectResearchContext(fs: IFileSystem, runners: RunnerId[]): Promise<string> {
    return collectResearchContext(fs, runners);
  }

  /**
   * Execute one round of tool calls and report each through onProgress.
   * Returns the results to feed back plus the log entries produced.
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    fs: IFileSystem,
    onProgress: (progress: ResearchProgress) => void,
    fetcher: IWebFetcher | undefined,
    stepIndex: number,
    thinking: string,
    signal?: AbortSignal,
    plannerTools?: PlannerToolHandler,
    readLimit?: PlannerReadLimit,
  ): Promise<{ toolResults: ToolResult[]; logEntries: ResearchStep[]; resultsText: string }> {
    const toolResults: ToolResult[] = [];
    const logEntries: ResearchStep[] = [];
    let resultsText = '';
    let thinkingAttached = false;

    // Two concurrent pre-passes, then one ordered merge.
    //
    // Spawn calls have always run in parallel. The pure reads now do too: when
    // a model asks for six files in one round, six serial HTTP-free round trips
    // was simply latency we were choosing to pay. They are side-effect free and
    // order-independent, so the only thing sequencing bought was the illusion
    // of determinism — results are still merged back in call order below.
    //
    // Everything else (bash, fetch, web_search, unknown tools) stays serial:
    // those can block on a user approval prompt, and firing several prompts at
    // once would be hostile in every surface.
    const precomputed = new Map<number, { success: boolean; output: string; truncated: boolean }>();
    const spawnSubagentIds = new Map<number, string>();
    // When each call was announced, not when its result landed: a reloaded
    // transcript places each row where the live view drew the call.
    const announcedAt = new Map<number, string>();
    const normalizedArgs = toolCalls.map((tc) => {
      const args = { ...tc.args };
      if (tc.name === 'read_file' && !('maxBytes' in args) && !('limit' in args)) args.limit = 2000;
      return args;
    });

    // Admitted in call order before any runs, so which of a wide round's reads
    // the limit stops does not depend on which finished first (ADR-0068).
    const overLimit = new Map<number, string>();
    if (readLimit) {
      for (const [i, tc] of toolCalls.entries()) {
        if (!OWN_READ_TOOLS.has(tc.name)) continue;
        const admission = readLimit.admit();
        if (!admission.allowed) overLimit.set(i, admission.reason);
      }
    }
    const ownRead = async (i: number, run: () => Promise<ToolOutcome>): Promise<ToolOutcome> => {
      const refused = overLimit.get(i);
      if (refused !== undefined) return { success: false, output: refused, truncated: false };
      const outcome = await run();
      if (readLimit && OWN_READ_TOOLS.has(toolCalls[i].name)) {
        // A read the envelope refused read nothing, so it costs no call (ADR-0068 R1).
        if (outcome.refused) readLimit.refund();
        else readLimit.charge(Buffer.byteLength(outcome.output));
      }
      return outcome;
    };

    const spawnIndexes = toolCalls.flatMap((tc, i) => (tc.name === SPAWN_RESEARCH_AGENT ? [i] : []));
    const parallelIndexes = toolCalls.flatMap((tc, i) => (PARALLEL_SAFE_TOOLS.has(tc.name) ? [i] : []));

    await Promise.all([
      spawnIndexes.length > 0
        ? mapWithConcurrency(spawnIndexes, SUBAGENT_LIMITS.maxConcurrent, async (i) => {
          const subagentId = uuidv4();
          spawnSubagentIds.set(i, subagentId);
          announcedAt.set(i, new Date().toISOString());
          onProgress({ type: 'tool_call', tool: toolCalls[i].name, toolArgs: JSON.stringify(toolCalls[i].args), subagentId, toolCallId: toolCalls[i].id });
          precomputed.set(i, await this.executeSpawnAgent({ ...toolCalls[i].args }, fs, onProgress, signal, subagentId, fetcher));
        })
        : Promise.resolve(),
      parallelIndexes.length > 1
        ? mapWithConcurrency(parallelIndexes, TOOL_ROUND_CONCURRENCY, async (i) => {
          announcedAt.set(i, new Date().toISOString());
          onProgress({ type: 'tool_call', tool: toolCalls[i].name, toolArgs: JSON.stringify(toolCalls[i].args), toolCallId: toolCalls[i].id });
          precomputed.set(i, await ownRead(i, () => executeTool(toolCalls[i].name, normalizedArgs[i], fs, fetcher, signal)));
        })
        : Promise.resolve(),
    ]);

    for (const [index, tc] of toolCalls.entries()) {
      const toolArgs = normalizedArgs[index];

      const preResult = precomputed.get(index);
      const named = stepTool(tc.name, plannerTools);
      if (!preResult) {
        announcedAt.set(index, new Date().toISOString());
        onProgress({ type: 'tool_call', ...named, toolArgs: JSON.stringify(tc.args), toolCallId: tc.id });
      }

      // The serial tail of the round is where a stop actually lands: `bash`,
      // `fetch` and `web_search` run one after another and can each sit on an
      // approval prompt, so by the time the user hits ESC there are usually
      // calls here that have not started. `executeTool` answers those without
      // running them, the same way the budget-exhaustion path above does.
      const toolResult = preResult
        ?? await callPlannerTool(plannerTools, tc.name, toolArgs, signal)
        ?? await ownRead(index, () => executeTool(tc.name, toolArgs, fs, fetcher, signal));

      const MAX_RESPONSE_CHARS = 50000;
      const truncatedResponse = toolResult.success && (toolResult.truncated || toolResult.output.length > MAX_RESPONSE_CHARS);
      const llmOutput = toolResult.output.length > MAX_RESPONSE_CHARS
        ? toolResult.output.slice(0, MAX_RESPONSE_CHARS) + `\n[... truncated to ${MAX_RESPONSE_CHARS} chars, total ${toolResult.output.length}]`
        : toolResult.output;

      const LOG_MAX = 10000;
      const outcome = classifyOutcome(toolResult.success, toolResult.output);
      const stepEntry: ResearchStep = {
        id: `rs-${Date.now()}-${stepIndex}-${logEntries.length}`,
        tool: named.tool as ResearchStep['tool'],
        ...(named.toolLabel ? { toolLabel: named.toolLabel } : {}),
        args: JSON.stringify(tc.args),
        result: toolResult.output.length > LOG_MAX
          ? toolResult.output.slice(0, LOG_MAX) + `\n[... truncated, total ${toolResult.output.length} chars]`
          : toolResult.output,
        success: toolResult.success,
        outcome,
        toolCallId: tc.id,
        timestamp: announcedAt.get(index) ?? new Date().toISOString(),
        ...(thinking && !thinkingAttached ? { thinkingText: thinking } : {}),
      };
      if (thinking && !thinkingAttached) thinkingAttached = true;
      logEntries.push(stepEntry);

      if (toolResult.success) {
        // llmOutput, not the raw output: the fallback plan prompt must not
        // carry text the conversation itself never saw.
        resultsText += `\n[${tc.name}(${JSON.stringify(tc.args)})]\n${llmOutput}\n`;
      }

      onProgress({ type: 'tool_result', toolResult: toolResult.output, step: stepEntry, subagentId: spawnSubagentIds.get(index), toolCallId: tc.id });

      toolResults.push({ name: tc.name, output: llmOutput, truncated: truncatedResponse, totalChars: toolResult.output.length, id: tc.id });
    }

    return { toolResults, logEntries, resultsText };
  }

  /**
   * The tool a reply wrote out as text, when that is all it did: it made no
   * call, the output limit did not cut it off (a half-written reply is the
   * cut-off's to retry), and the chat offers tools to name.
   */
  private static writtenCallOf(chat: ResearchChat, turn: ResearchTurn): string | undefined {
    if (turn.hasToolCalls || turn.finishReason === 'length') return undefined;
    const offered = chat.offeredTools?.();
    return offered && offered.size > 0 ? writtenToolCall(turn.text, offered) : undefined;
  }

  /**
   * A tool a reply that did make calls wrote out as text besides: one it did
   * not call. Its round runs, so no reply is asked for; the note rides on the
   * round's results. A recorded supervisor wrote `message_task` this way, beside
   * a decision it recorded, twice, and told the user both messages were sent.
   */
  private static writtenBesideOf(chat: ResearchChat, turn: ResearchTurn): string | undefined {
    const offered = chat.offeredTools?.();
    if (!offered || !turn.text.includes('<')) return undefined;
    const made = new Set(turn.toolCalls.map((tc) => tc.name));
    return writtenToolCall(turn.text, new Set([...offered].filter((name) => !made.has(name))));
  }

  /**
   * Countdown appended to the last tool result of the final few rounds, so the
   * model lands the turn on its own terms instead of being cut off exactly at
   * the budget boundary mid-exploration.
   */
  private static appendBudgetCountdown(toolResults: ToolResult[], remaining: number, wrapUpAction: string): void {
    if (remaining <= 0 || remaining > 3) return;
    appendNote(toolResults, `[research budget: only ${remaining} tool round${remaining === 1 ? '' : 's'} left this turn — prioritize the most important remaining lookups, then ${wrapUpAction}.]`);
  }

  /**
   * Run one planner conversation turn (ADR-0002): send the message, satisfy
   * tool calls until the model answers in prose or JSON, and settle the reply
   * through {@link settleReply}, which owns classification and every
   * corrective retry. The model decides transitions — there are no sentinels
   * and no question tags. A turn whose final text parses as a `{tasks:[...]}`
   * object commits the plan; anything else is a message to the user.
   */
  protected async runConversationTurn(
    ctx: ConversationTurnContext,
    message: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
    /** What the turn's first call is, in place of sending `message`: a held input sent again. */
    firstCall?: () => Promise<ResearchTurn>,
  ): Promise<ConversationTurn> {
    // Context pressure is the chat's to handle, before each of its calls.
    const { chat } = ctx;
    let first = firstCall;
    return settleReply({
      // The turn's own input carries the budgets, not the system prompt, which stays cacheable.
      message: withTurnBudgets(this.turnBudgets, message),
      send: (text) => {
        const opening = first;
        first = undefined;
        return this.runToolRounds(chat, ctx, text, onProgress, signal, opening);
      },
      classify: { autonomousDefault: ctx.autonomousDefault, ...(ctx.liveScope?.() ?? { runners: ctx.runners, runnerModes: ctx.runnerModes }) },
      onProgress,
      signal,
      compactHistory: chat.compactHistory?.bind(chat),
    });
  }

  /** One model call of a conversation turn: the message, then tool rounds until the model replies without tools. */
  private async runToolRounds(
    chat: ResearchChat,
    ctx: ConversationTurnContext,
    message: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
    firstCall?: () => Promise<ResearchTurn>,
  ): Promise<ReplyAttempt> {
    const researchLog: ResearchLogEntry[] = [];
    const MAX_STEPS = this.config.researchMaxSteps;
    // Each model call's text is a run of the reply (ADR-0017 A1): every call
    // before the last is narration before its tool calls, and the last one's
    // is what the attempt replies.
    const narration: TurnRun[] = [];
    let last: TurnRun | undefined;
    const call = async (send: () => Promise<ResearchTurn>): Promise<ResearchTurn> => {
      const startedAt = new Date().toISOString();
      const next = await send();
      for (const line of next.resends ?? []) researchLog.push(systemEntry(line));
      if (last) narration.push({ ...last, narration: true });
      last = next.text.trim() ? { segmentId: next.segmentId ?? uuidv4(), text: next.text, startedAt } : undefined;
      return next;
    };
    const runs = (): TurnRun[] => (last ? [...narration, last] : [...narration]);
    try {
      let turn = await call(firstCall ?? (() => chat.sendMessage(message, signal)));

      // Wrap-up rounds after the tool budget runs out: the pending calls are
      // answered synthetically (never executed) so the API history stays
      // valid and the model is pushed to reply in prose. Bounded, because a
      // model could keep requesting tools forever.
      let wrapUpRounds = 0;
      let step = 0;
      // The loop runs again, with the steps already spent, for the reply to the
      // instruction a call written as text is answered with.
      for (let asked = false; ; asked = true) {
        for (; turn.hasToolCalls; step++) {
          if (signal?.aborted) return { text: turn.text, researchLog, aborted: true, runs: runs() };
          if (step >= MAX_STEPS) {
            // Budget exhausted while the model still wants tools. Dropping the
            // calls here used to surface the model's preamble ("Let me read…")
            // as the reply and leave dangling tool_calls in the API history.
            if (wrapUpRounds >= 2) break;
            wrapUpRounds++;
            const notice = `Research tool budget for this turn is exhausted (${MAX_STEPS} rounds) — this call was NOT executed and no further tool calls will be. Reply to the user now using what you already learned: summarize your findings and ask how to proceed, ask your next question, or emit the plan JSON.`;
            // These calls are answered without running. Reporting them as
            // not-executed steps keeps the budget boundary visible; dropping
            // them silently made a whole refused round look like it never
            // happened on every surface.
            for (const tc of turn.toolCalls) {
              const step: ResearchStep = {
                id: `rs-${Date.now()}-budget-${researchLog.length}`,
                tool: tc.name as ResearchStep['tool'],
                args: JSON.stringify(tc.args),
                result: notice,
                success: false,
                outcome: 'not_executed',
                toolCallId: tc.id,
                timestamp: new Date().toISOString(),
              };
              researchLog.push(step);
              onProgress({ type: 'tool_call', tool: tc.name, toolArgs: step.args, toolCallId: tc.id });
              onProgress({ type: 'tool_result', toolResult: notice, step, toolCallId: tc.id });
            }
            const calls = turn.toolCalls;
            turn = await call(() => chat.sendToolResults(
              calls.map((tc) => ({ name: tc.name, output: notice, truncated: false, totalChars: notice.length, id: tc.id })),
              signal,
            ));
            continue;
          }
          const thinking = turn.reasoning ? turn.reasoning.slice(-200) : '';
          const beside = BaseAiService.writtenBesideOf(chat, turn);
          if (beside !== undefined && last) {
            onProgress({ type: 'text_retracted', segmentId: last.segmentId });
            last = undefined;
          }
          const { toolResults, logEntries } = await this.runRound(chat, turn.toolCalls, ctx, onProgress, step, thinking, signal);
          if (beside !== undefined) appendNote(toolResults, writtenBesideNote(beside));
          researchLog.push(...logEntries);
          BaseAiService.appendBudgetCountdown(toolResults, MAX_STEPS - step - 1, 'reply to the user (summary, question, or plan JSON)');
          turn = await call(() => chat.sendToolResults(toolResults, signal));
        }

        // A plain-reply turn (no tool calls) never passes through the loop
        // above, so this is the first point it can notice an abort raised
        // while its HTTP call was already in flight — without it, a stale
        // turn classifies and returns as a normal plan/message after reset().
        if (signal?.aborted) return { text: turn.text, researchLog, aborted: true, runs: runs() };

        // A call written as markup is no finished reply (ADR-0070): it never
        // ran, and a supervisor's wake-up would end as done with its note unsent.
        const written = BaseAiService.writtenCallOf(chat, turn);
        if (written === undefined) break;
        if (asked || step >= MAX_STEPS) {
          researchLog.push(writtenCallRecord(written, !asked));
          break;
        }
        // What it wrote is taken back, not kept as narration before the reply.
        if (last) onProgress({ type: 'text_retracted', segmentId: last.segmentId });
        last = undefined;
        turn = await call(() => chat.sendMessage(writtenCallNote(written), signal));
      }

      // Forced break with nothing to show: degrade to a visible failure
      // instead of an empty planner bubble.
      if (turn.hasToolCalls && !turn.text.trim()) {
        return {
          text: turn.text,
          researchLog,
          failure: `I hit the research tool budget for this turn (${MAX_STEPS} rounds) before finishing. Tell me to continue, or narrow the request.`,
          runs: runs(),
        };
      }

      return { text: turn.text, researchLog, cutOff: turn.finishReason === 'length', runs: runs() };
    } catch (err) {
      // A spent usage limit ends the attempt as the provider's limit, with
      // the reset it stated, so the conversation waits for it and sends the
      // turn again (ADR-0044); any other failure fails the turn as before.
      // A transient one reaches here only past its retries: the client's
      // before any event, `streamReply`'s once the reply had begun.
      if (isModelError(err) && err.kind === 'usage-limit') {
        return {
          text: '',
          researchLog,
          failure: err.message,
          usageLimit: err.resetsAt !== undefined ? { resetsAt: new Date(err.resetsAt).toISOString() } : {},
          runs: runs(),
        };
      }
      throw err;
    }
  }

  /**
   * One round's calls run, except those the chat answers as already made in
   * the turn's condensed rounds (ADR-0002): each of those is answered with
   * what it returned and shown as not executed, before anything runs.
   * Results and steps stay in call order.
   */
  private async runRound(
    chat: ResearchChat,
    calls: ToolCall[],
    ctx: ConversationTurnContext,
    onProgress: (progress: ResearchProgress) => void,
    stepIndex: number,
    thinking: string,
    signal?: AbortSignal,
  ): Promise<{ toolResults: ToolResult[]; logEntries: ResearchStep[] }> {
    const answers = calls.map((tc) => chat.answered?.(tc));
    if (answers.every((a) => a === undefined)) return this.executeToolCalls(calls, ctx.fs, onProgress, ctx.fetcher, stepIndex, thinking, signal, ctx.plannerTools, ctx.readLimit);
    const answered = new Map<number, { result: ToolResult; step: ResearchStep }>();
    for (const [i, tc] of calls.entries()) {
      const output = answers[i];
      if (output === undefined) continue;
      const named = stepTool(tc.name, ctx.plannerTools);
      const step: ResearchStep = {
        id: `rs-${Date.now()}-${stepIndex}-answered-${i}`,
        tool: named.tool as ResearchStep['tool'],
        ...(named.toolLabel ? { toolLabel: named.toolLabel } : {}),
        args: JSON.stringify(tc.args),
        result: output,
        success: false,
        outcome: 'not_executed',
        toolCallId: tc.id,
        timestamp: new Date().toISOString(),
      };
      onProgress({ type: 'tool_call', ...named, toolArgs: step.args, toolCallId: tc.id });
      onProgress({ type: 'tool_result', toolResult: output, step, toolCallId: tc.id });
      answered.set(i, { result: { name: tc.name, output, truncated: false, totalChars: output.length, id: tc.id }, step });
    }
    const fresh = calls.filter((_, i) => !answered.has(i));
    const ran = fresh.length > 0
      ? await this.executeToolCalls(fresh, ctx.fs, onProgress, ctx.fetcher, stepIndex, thinking, signal, ctx.plannerTools, ctx.readLimit)
      : { toolResults: [], logEntries: [] };
    let next = 0;
    const merged = calls.map((_, i) => answered.get(i) ?? { result: ran.toolResults[next], step: ran.logEntries[next++] });
    return { toolResults: merged.map((m) => m.result), logEntries: merged.map((m) => m.step) };
  }

  /**
   * Run the LLM tool-calling research loop for one-shot planning. Returns
   * parsed tasks if a plan was emitted mid-loop, or null if the loop
   * exhausted without a valid plan.
   */
  protected async runResearchLoop(
    chat: ResearchChat,
    firstMessage: string,
    fs: IFileSystem,
    onProgress: (progress: ResearchProgress) => void,
    runners: RunnerId[],
    initialLog?: ResearchLogEntry[],
    fetcher?: IWebFetcher,
    userGoal?: string,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    autonomousDefault?: boolean,
    signal?: AbortSignal,
  ): Promise<{ tasks: Task[] | null; researchLog: ResearchLogEntry[]; researchResults: string }> {
    const researchLog: ResearchLogEntry[] = initialLog ? [...initialLog] : [];
    if (!initialLog && userGoal) {
      researchLog.push({
        id: `up-${Date.now()}`,
        type: 'user_prompt',
        content: userGoal,
        timestamp: new Date().toISOString(),
      });
    }
    let researchResults = '';
    const MAX_STEPS = this.config.researchMaxSteps;

    const send = async (call: () => Promise<ResearchTurn>): Promise<ResearchTurn> => {
      const next = await call();
      for (const line of next.resends ?? []) researchLog.push(systemEntry(line));
      return next;
    };
    let turn = await send(() => chat.sendMessage(firstMessage, signal));
    let askedForCall = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) {
        onProgress({ type: 'interrupted' });
        return { tasks: null, researchLog, researchResults };
      }
      // Prefer the model's reasoning channel for the live thinking trace; fall back to
      // the answer content when a model doesn't expose reasoning separately.
      const thinking = turn.reasoning ? turn.reasoning.slice(-200) : turn.text.slice(-200);

      // A research turn is a candidate plan whenever its (reasoning-free) content
      // carries a tasks key — not only when it starts with `{`. Reasoning models often
      // emit a short preamble before the JSON; throwing that away forced a wasteful
      // second LLM call even when the plan was already in hand.
      const reply = classifyPlannerReply(turn.text, { runners, runnerModes, autonomousDefault });
      if (reply.kind === 'plan') {
        for (const line of reply.notes) researchLog.push(systemEntry(line));
        return { tasks: reply.tasks, researchLog, researchResults };
      }

      if (!turn.hasToolCalls) {
        const written = BaseAiService.writtenCallOf(chat, turn);
        // On the last step the loop would end before reading the reply, so nothing asked for could run.
        const lastStep = step + 1 >= MAX_STEPS;
        if (written === undefined || askedForCall || lastStep) {
          if (written !== undefined) researchLog.push(writtenCallRecord(written, !askedForCall));
          break;
        }
        askedForCall = true;
        turn = await send(() => chat.sendMessage(writtenCallNote(written), signal));
        continue;
      }

      const { toolResults, logEntries, resultsText } = await this.executeToolCalls(
        turn.toolCalls, fs, onProgress, fetcher, step, thinking, signal,
      );
      researchLog.push(...logEntries);
      researchResults += resultsText;

      BaseAiService.appendBudgetCountdown(toolResults, MAX_STEPS - step - 1, 'emit the plan JSON');
      turn = await send(() => chat.sendToolResults(toolResults, signal));
    }

    if (turn.text) {
      researchResults += `\n[LLM response]\n${turn.text}\n`;
    }

    return { tasks: null, researchLog, researchResults };
  }

  /**
   * One more call when the first valid plan's longest chain reaches
   * CHAIN_REVIEW_MIN: the revision is kept only when it parses and its chain is
   * shorter, so the review can shorten a plan and never lose one (ADR-0072 R1).
   * A reply the output limit cut off is asked for once more, with the plan
   * and the question alone, the least reasoning and the longest reply; after
   * that the first plan stands.
   */
  protected async reviewLongChain(
    tasks: Task[],
    userDescription: string,
    contextStr: string,
    researchResults: string,
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    runners: RunnerId[],
    onProgress: (progress: ResearchProgress) => void,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    signal?: AbortSignal,
    modes: PlannerModes = DEFAULT_PLANNER_MODES,
    log?: ResearchLogEntry[],
    fs?: Pick<IFileSystem, 'readFile'>,
  ): Promise<Task[]> {
    const chain = longestChain(tasks);
    const note = (content: string) => log?.push({ id: `cr-${Date.now()}`, type: 'system', content, timestamp: new Date().toISOString() });
    // The role notes, the merge and the order are Ordewell's, on the plan that stands, at no call (ADR-0072 R5-R7).
    const shaped = async (final: Task[]) => {
      const { tasks: out, log: lines } = await shapeFanOut(final, fs, modes.parallelLimit);
      for (const line of lines) note(line);
      return out;
    };
    if (chain.length < CHAIN_REVIEW_MIN) return shaped(tasks);
    // The reply is a list of changes, not a plan, so it streams to no plan view.
    // Low effort: each edge is a yes-or-no question, and a reasoning model left at
    // its default can think past the output limit before it writes the list.
    // 'low' is the bottom of Ordewell's effort ladder; each adapter maps it to the least its model takes.
    const ask = async (prompt: string, hint: string | undefined, largestReply: boolean) => {
      let cutOff = false;
      let out = '';
      const reply = await this.streamPlanText(
        prompt,
        hint,
        () => {},
        (reasoning) => onProgress({ type: 'thinking', text: reasoning }),
        signal,
        {
          onReply: (r) => {
            cutOff = r.cutOff;
            if (r.usage?.outputTokens !== undefined) out = ` [reply ${r.usage.outputTokens} tokens out]`;
            if (r.usage) onProgress({ type: 'usage', record: { ...r.usage, aggregate: true } });
          },
          onAbandoned: (a) => {
            if (a.usage) onProgress({ type: 'usage', record: { ...a.usage, aggregate: true } });
            if (a.line) note(`chain review: ${a.line}`);
          },
          effort: 'low',
          largestReply,
        },
      );
      return { applied: applyChainReview(tasks, reply, runners, runnerModes), cutOff, out };
    };
    type Asked = Awaited<ReturnType<typeof ask>>;
    try {
      const prompt = buildPlanWithResults(userDescription, contextStr, compactResearchResults(researchResults), modelsByRunner, runners, runnerModes, modes);
      const { applied, cutOff, out } = await repairLoop<Asked, Asked>({
        first: () => ask(prompt, chainReviewMessage(tasks, chain), false),
        // Only a cut-off is asked again (ADR-0072 R2): an invalid reply the model finished would come back the same.
        interpret: (r) => {
          if (r.applied.ok || !r.cutOff) return { done: r };
          // A function runs only when the re-ask follows, so a second cut-off is not noted as asked again.
          const corrective = () => {
            note(`chain review: ${chain.length}, reply cut off at the output limit${r.out}; asked once more with the plan alone`);
            return chainReviewMessage(tasks, chain, true);
          };
          return { retry: { errors: [r.applied.error], corrective } };
        },
        resend: (alone) => ask(alone, undefined, true),
        maxRepairs: 1,
        onExhausted: ({ reply }) => reply,
      });
      if (!applied.ok) {
        note(`chain review: ${chain.length}, first plan kept: ${cutOff ? 'reply cut off at the output limit; ' : ''}${applied.error}${out}`);
        return shaped(tasks);
      }
      const after = longestChain(applied.tasks);
      const kept = after.length > 0 && after.length < chain.length;
      const title = (id: string) => tasks.find((t) => t.id === id)?.title ?? id;
      // A task the rules gave its dependencies back to ends as the plan wrote it: it is counted below, not named as changed.
      const changed = applied.changes.filter((c) => c.removed.length || c.added.length || c.restored?.length).map((c) => `"${title(c.id)}"${c.removed.length ? ` drops ${c.removed.map((d) => `"${title(d)}"`).join(', ')}` : ''}${c.added.length ? ` adds ${c.added.map((d) => `"${title(d)}"`).join(', ')}` : ''}${c.restored?.length ? `, kept as the closing check after ${c.restored.length} task${c.restored.length === 1 ? '' : 's'} the reply cut it from` : ''}`);
      // ADR-0072 R1: what the reply could not change, counted.
      const dropped = applied.changes.reduce((n, c) => n + (c.dropped?.length ?? 0), 0);
      const openingKept = applied.changes.reduce((n, c) => n + (c.openingKept?.length ?? 0), 0);
      const held = dropped || openingKept ? `, ${dropped} added wait${dropped === 1 ? '' : 's'} dropped, ${openingKept} opening wait${openingKept === 1 ? '' : 's'} kept` : '';
      note(`chain review: ${chain.length} -> ${after.length}, ${kept ? 'kept' : 'first plan kept, not shorter'}; ${changed.length} task${changed.length === 1 ? '' : 's'} changed${changed.length ? `: ${changed.join('; ')}` : ''}${held}${applied.ignored.length ? `; ignored subtask${applied.ignored.length === 1 ? '' : 's'} ${applied.ignored.join(', ')}` : ''}${out}`);
      return shaped(kept ? applied.tasks : tasks);
    } catch (err) {
      if (signal?.aborted) throw err;
      note(`chain review: ${chain.length}, failed: ${err instanceof Error ? err.message : String(err)}`);
      return shaped(tasks);
    }
  }

  protected async generatePlanFallback(
    userDescription: string,
    contextStr: string,
    researchResults: string,
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    runners: RunnerId[],
    onProgress: (progress: ResearchProgress) => void,
    researchLog: ResearchLogEntry[] = [],
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    autonomousDefault = false,
    signal?: AbortSignal,
    modes: PlannerModes = DEFAULT_PLANNER_MODES,
  ): Promise<{ tasks: Task[]; researchLog: ResearchLogEntry[] }> {
    // A long research phase (especially with subagents) can outgrow what one
    // prompt can carry alongside a full plan emission — bound it, digests first.
    const prompt = buildPlanWithResults(userDescription, contextStr, compactResearchResults(researchResults), modelsByRunner, runners, runnerModes, modes);
    const tasks = await generatePlanWithRepair((repairHint) =>
      this.streamPlanText(
        prompt,
        repairHint,
        (token) => onProgress({ type: 'plan_token', planToken: token }),
        (reasoning) => onProgress({ type: 'thinking', text: reasoning }),
        signal,
        {
          onReply: (r) => { if (r.usage) onProgress({ type: 'usage', record: { ...r.usage, aggregate: true } }); },
          onAbandoned: (a) => {
            if (a.usage) onProgress({ type: 'usage', record: { ...a.usage, aggregate: true } });
            if (a.line) researchLog.push(systemEntry(a.line));
          },
        },
      ),
      runners,
      2,
      runnerModes,
      autonomousDefault,
      (line) => researchLog.push(systemEntry(line)),
    );
    return { tasks, researchLog };
  }
}

import { v4 as uuidv4 } from 'uuid';
import { Task, DiscoveredModel, ResearchStep, ResearchLogEntry, ResearchProgress, RunnerId } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem, type ToolOutcome } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import { buildPlanWithResults } from './PlanPrompts';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from './plannerModes';
import { generatePlanWithRepair, classifyPlannerReply } from './PlanRepair';
import { settleReply, type ReplyAttempt } from './settleReply';
import { compactResearchResults, RECOVERABLE_READ_TOOLS, type CompactableMessage } from './contextCompaction';
import type { RunnerModeInfo } from './ModeResolver';
import type { PlanIntake } from './PlanChangeCheck';
import { collectResearchContext } from './ContextCollector';
import { PLANNER_EXECUTION_TOOLS, PLANNER_POST, PLANNER_TASK_READ_TOOLS, type PlannerToolHandler } from './mcp/tools';
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

/**
 * Read-only, side-effect-free tools that can share a round. Deliberately a
 * denylist's opposite: `bash`, `fetch` and `web_search` are excluded because
 * they can pause on a user approval prompt, and an unknown tool is excluded
 * because we cannot reason about it.
 */
const PARALLEL_SAFE_TOOLS = new Set(['read_file', 'read_files', 'glob', 'grep', 'find_symbol', 'list_dir']);

/** Concurrency for the read-only pre-pass. Bounded so a wide round cannot exhaust file handles. */
const TOOL_ROUND_CONCURRENCY = 8;

/**
 * A task read, a `post` or an execution tool call (ADR-0029), answered by the session's
 * planner tools through the same handler and argument check the MCP route
 * uses. Undefined for any other tool, or when the session offered no handler.
 */
async function callPlannerTool(handler: PlannerToolHandler | undefined, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome | undefined> {
  const read = PLANNER_TASK_READ_TOOLS.find((t) => t.name === name);
  const tool = handler ? read ?? [...PLANNER_EXECUTION_TOOLS, PLANNER_POST].find((t) => t.name === name) : undefined;
  if (!handler || !tool) return undefined;
  if (signal?.aborted) return { success: false, output: STOPPED_TOOL_RESULT, truncated: false };
  const reply = await tool.call(handler, args, { signal: signal ?? new AbortController().signal });
  return { success: !reply.isError, output: read ? redactSourceText(reply.text) : reply.text, truncated: false };
}

/**
 * How a step names its tool: an execution tool or `post` has no research tool
 * type, so it is an agent tool under its own name, as a harness planner's is.
 */
function stepTool(name: string, handler: PlannerToolHandler | undefined): { tool: string; toolLabel?: string } {
  return handler && (isExecutionTool(name) || name === PLANNER_POST.name) ? { tool: 'agent_tool', toolLabel: name } : { tool: name };
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
  ): Promise<string>;

  /**
   * Build a fresh chat for one research subagent (own history, subagent system
   * prompt, cheap model). Null means the provider does not support subagents —
   * the spawn tool then degrades to a steering message. `onReasoning` streams
   * live reasoning deltas on models that expose them, same as the top-level loop;
   * `onUsage` takes each call's usage, as the planner's own chat reports it.
   */
  protected createSubagentChat(_onReasoning?: (delta: string) => void, _onUsage?: (record: UsageRecord) => void): ResearchChat | null { return null; }

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
          precomputed.set(i, await executeTool(toolCalls[i].name, normalizedArgs[i], fs, fetcher, signal));
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
        ?? await executeTool(tc.name, toolArgs, fs, fetcher, signal);

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
   * Countdown appended to the last tool result of the final few rounds, so the
   * model lands the turn on its own terms instead of being cut off exactly at
   * the budget boundary mid-exploration.
   */
  private static appendBudgetCountdown(toolResults: ToolResult[], remaining: number, wrapUpAction: string): void {
    if (remaining <= 0 || remaining > 3 || toolResults.length === 0) return;
    const note = `\n\n[research budget: only ${remaining} tool round${remaining === 1 ? '' : 's'} left this turn — prioritize the most important remaining lookups, then ${wrapUpAction}.]`;
    const last = toolResults[toolResults.length - 1];
    last.output += note;
    last.totalChars += note.length;
  }

  /**
   * The own-reads meter (an experiment): the planner's own workspace reads,
   * by the size of what went into its context. A subagent's digest, a task
   * read, a web read and a call refused unrun are not among them.
   */
  private noteOwnReads(logEntries: readonly ResearchStep[], toolResults: readonly ToolResult[]): void {
    logEntries.forEach((entry, i) => {
      if (entry.outcome === 'success' && RECOVERABLE_READ_TOOLS.has(entry.tool)) this.turnBudgets?.noteOwnRead(toolResults[i].output.length);
    });
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
      message: withTurnBudgets(this.turnBudgets, message, true),
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
      if (last) narration.push({ ...last, narration: true });
      last = next.text.trim() ? { segmentId: next.segmentId ?? uuidv4(), text: next.text, startedAt } : undefined;
      return next;
    };
    const runs = (): TurnRun[] => (last ? [...narration, last] : [...narration]);
    let turn = await call(firstCall ?? (() => chat.sendMessage(message, signal)));

    // Wrap-up rounds after the tool budget runs out: the pending calls are
    // answered synthetically (never executed) so the API history stays
    // valid and the model is pushed to reply in prose. Bounded, because a
    // model could keep requesting tools forever.
    let wrapUpRounds = 0;
    for (let step = 0; turn.hasToolCalls; step++) {
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
      const { toolResults, logEntries } = await this.runRound(chat, turn.toolCalls, ctx, onProgress, step, thinking, signal);
      researchLog.push(...logEntries);
      // Before the countdown note below, which is not a read.
      this.noteOwnReads(logEntries, toolResults);
      BaseAiService.appendBudgetCountdown(toolResults, MAX_STEPS - step - 1, 'reply to the user (summary, question, or plan JSON)');
      turn = await call(() => chat.sendToolResults(toolResults, signal));
    }

    // A plain-reply turn (no tool calls) never passes through the loop
    // above, so this is the first point it can notice an abort raised
    // while its HTTP call was already in flight — without it, a stale
    // turn classifies and returns as a normal plan/message after reset().
    if (signal?.aborted) return { text: turn.text, researchLog, aborted: true, runs: runs() };

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
    if (answers.every((a) => a === undefined)) return this.executeToolCalls(calls, ctx.fs, onProgress, ctx.fetcher, stepIndex, thinking, signal, ctx.plannerTools);
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
      ? await this.executeToolCalls(fresh, ctx.fs, onProgress, ctx.fetcher, stepIndex, thinking, signal, ctx.plannerTools)
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

    let turn = await chat.sendMessage(firstMessage, signal);

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
        return { tasks: reply.tasks, researchLog, researchResults };
      }

      if (!turn.hasToolCalls) break;

      const { toolResults, logEntries, resultsText } = await this.executeToolCalls(
        turn.toolCalls, fs, onProgress, fetcher, step, thinking, signal,
      );
      researchLog.push(...logEntries);
      researchResults += resultsText;

      BaseAiService.appendBudgetCountdown(toolResults, MAX_STEPS - step - 1, 'emit the plan JSON');
      turn = await chat.sendToolResults(toolResults, signal);
    }

    if (turn.text) {
      researchResults += `\n[LLM response]\n${turn.text}\n`;
    }

    return { tasks: null, researchLog, researchResults };
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
      ),
      runners,
      2,
      runnerModes,
      autonomousDefault,
    );
    return { tasks, researchLog };
  }
}

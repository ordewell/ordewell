import { v4 as uuidv4 } from 'uuid';
import { Task, DiscoveredModel, ResearchStep, ResearchLogEntry, ResearchProgress, RunnerId } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import { buildPlanWithResults } from './PlanPrompts';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from './plannerModes';
import { generatePlanWithRepair, classifyPlannerReply, reEmitPlanPrompt, reEmitTaskOpsPrompt, truncatedPlanReEmitPrompt } from './PlanRepair';
import { compactResearchResults, withProactiveCompaction } from './contextCompaction';
import { extractPrdBlock } from '../utils/prdStore';
import type { RunnerModeInfo } from './ModeResolver';
import { collectResearchContext } from './ContextCollector';
import { executeTool } from './executeTool';
import { runResearchAgent, mapWithConcurrency, SUBAGENT_LIMITS } from './ResearchSubagents';
import { SPAWN_RESEARCH_AGENT } from './researchTools';
import { classifyOutcome } from './researchStepSummary';
import type { ConversationTurn } from './AiService';

/**
 * Read-only, side-effect-free tools that can share a round. Deliberately a
 * denylist's opposite: `bash`, `fetch` and `web_search` are excluded because
 * they can pause on a user approval prompt, and an unknown tool is excluded
 * because we cannot reason about it.
 */
const PARALLEL_SAFE_TOOLS = new Set(['read_file', 'read_files', 'glob', 'grep', 'find_symbol', 'list_dir']);

/** Concurrency for the read-only pre-pass. Bounded so a wide round cannot exhaust file handles. */
const TOOL_ROUND_CONCURRENCY = 8;

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
  /** Exact prompt tokens this turn consumed, when the provider reports usage — drives proactive compaction. */
  promptTokens?: number;
}

export interface ResearchChat {
  sendMessage(text: string, signal?: AbortSignal): Promise<ResearchTurn>;
  sendToolResults(results: ToolResult[], signal?: AbortSignal): Promise<ResearchTurn>;
  /**
   * Optional: prune bulky raw tool outputs from the history in place (subagent
   * digests are kept) so a follow-up emission has context to spend on output.
   * Returns the number of characters removed. Providers whose SDK owns the
   * history (Gemini) may not support it.
   */
  compactHistory?(): number;
}

/** Everything one conversation turn needs beyond the user message itself. */
export interface ConversationTurnContext {
  chat: ResearchChat;
  fs: IFileSystem;
  runners: RunnerId[];
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault?: boolean;
  fetcher?: IWebFetcher;
  /** PRD toggle: a plan must not commit before a PRD block has appeared. */
  prdEnabled?: boolean;
  /** Set once any turn carries an ORDEWELL_PRD block; gates the missing-PRD nudge. */
  prdCaptured?: boolean;
  /** The missing-PRD corrective nudge is sent at most once per conversation. */
  prdNudgeSent?: boolean;
}

export abstract class BaseAiService {
  protected conversation: { ctx: ConversationTurnContext; setProgress: (fn: (p: ResearchProgress) => void) => void } | null = null;
  protected activeAbort: AbortController | null = null;
  /** researchSubagents toggle (issue #34): set per operation from the live settings snapshot; off means bit-for-bit sequential behavior. */
  protected researchSubagentsEnabled = false;

  constructor(protected config: IConfig) {}

  abstract reset(): void;
  abstract ensureInit(): void;

  hasActiveConversation(): boolean { return this.conversation !== null; }

  protected startAbortScope(callerSignal?: AbortSignal): AbortSignal | undefined {
    this.activeAbort = new AbortController();
    if (!callerSignal) return this.activeAbort.signal;
    if (callerSignal.aborted) { this.activeAbort.abort(); return this.activeAbort.signal; }
    callerSignal.addEventListener('abort', () => this.activeAbort?.abort(), { once: true });
    return this.activeAbort.signal;
  }

  protected stopAbortScope(): void {
    this.activeAbort = null;
  }

  async sendPlanningPrompt(
    prompt: string,
    runners: RunnerId[],
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    autonomousDefault = true,
  ): Promise<Task[]> {
    this.ensureInit();
    return generatePlanWithRepair(
      (repairHint) => this.streamPlanText(prompt, repairHint, () => {}),
      runners, 2, runnerModes, autonomousDefault,
    );
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
   * live reasoning deltas on models that expose them, same as the top-level loop.
   */
  protected createSubagentChat(_onReasoning?: (delta: string) => void): ResearchChat | null { return null; }

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
  ): Promise<{ success: boolean; output: string; truncated: boolean }> {
    if (!this.researchSubagentsEnabled) {
      return { success: false, output: 'spawn_research_agent is not available in this session. Continue researching sequentially with your other tools (read_file, glob, grep, list_dir, bash).', truncated: false };
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
      return { success: false, output: 'spawn_research_agent requires a non-empty "prompt" string: a self-contained task for the agent, including what its digest must report back.', truncated: false };
    }
    return runResearchAgent(prompt, {
      createChat: (onReasoning) => {
        const chat = this.createSubagentChat(onReasoning);
        if (!chat) throw new Error('subagent chats are not available for this provider');
        return chat;
      },
      fs,
      signal,
      onProgress: (progress) => onProgress({ ...progress, subagentId }),
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
          onProgress({ type: 'tool_call', tool: toolCalls[i].name, toolArgs: JSON.stringify(toolCalls[i].args), subagentId, toolCallId: toolCalls[i].id });
          precomputed.set(i, await this.executeSpawnAgent({ ...toolCalls[i].args }, fs, onProgress, signal, subagentId));
        })
        : Promise.resolve(),
      parallelIndexes.length > 1
        ? mapWithConcurrency(parallelIndexes, TOOL_ROUND_CONCURRENCY, async (i) => {
          onProgress({ type: 'tool_call', tool: toolCalls[i].name, toolArgs: JSON.stringify(toolCalls[i].args), toolCallId: toolCalls[i].id });
          precomputed.set(i, await executeTool(toolCalls[i].name, normalizedArgs[i], fs, fetcher));
        })
        : Promise.resolve(),
    ]);

    for (const [index, tc] of toolCalls.entries()) {
      const toolArgs = normalizedArgs[index];

      const preResult = precomputed.get(index);
      if (!preResult) onProgress({ type: 'tool_call', tool: tc.name, toolArgs: JSON.stringify(tc.args), toolCallId: tc.id });

      const toolResult = preResult ?? await executeTool(tc.name, toolArgs, fs, fetcher);

      const MAX_RESPONSE_CHARS = 50000;
      const truncatedResponse = toolResult.success && (toolResult.truncated || toolResult.output.length > MAX_RESPONSE_CHARS);
      const llmOutput = toolResult.output.length > MAX_RESPONSE_CHARS
        ? toolResult.output.slice(0, MAX_RESPONSE_CHARS) + `\n[... truncated to ${MAX_RESPONSE_CHARS} chars, total ${toolResult.output.length}]`
        : toolResult.output;

      const LOG_MAX = 10000;
      const outcome = classifyOutcome(toolResult.success, toolResult.output);
      const stepEntry: ResearchStep = {
        id: `rs-${Date.now()}-${stepIndex}-${logEntries.length}`,
        tool: tc.name as ResearchStep['tool'],
        args: JSON.stringify(tc.args),
        result: toolResult.output.length > LOG_MAX
          ? toolResult.output.slice(0, LOG_MAX) + `\n[... truncated, total ${toolResult.output.length} chars]`
          : toolResult.output,
        success: toolResult.success,
        outcome,
        toolCallId: tc.id,
        timestamp: new Date().toISOString(),
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
   * Run one planner conversation turn (ADR-0002): send the message, satisfy
   * tool calls until the model answers in prose or JSON, then classify the
   * result. The model decides transitions — there are no sentinels, no
   * question tags, and no correction nags. A turn whose final text parses as
   * a `{tasks:[...]}` object commits the plan; anything else is a message to
   * the user.
   */
  protected async runConversationTurn(
    ctx: ConversationTurnContext,
    message: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<ConversationTurn> {
    const researchLog: ResearchLogEntry[] = [];
    const MAX_STEPS = this.config.researchMaxSteps;

    // Turns reporting prompt-token pressure compact the underlying history
    // before the next call — the plan emission should never be the first
    // moment the context problem surfaces.
    const chat = withProactiveCompaction(ctx.chat);

    let pending = message;
    let emptyNudgeSent = false;
    // Broken JSON (a plan or task-ops attempt that failed to parse) gets a
    // bounded number of corrective re-emits before degrading to prose.
    let jsonRepairAttempts = 0;
    const MAX_JSON_REPAIRS = 2;
    for (;;) {
      let turn = await chat.sendMessage(pending, signal);

      // Wrap-up rounds after the tool budget runs out: the pending calls are
      // answered synthetically (never executed) so the API history stays
      // valid and the model is pushed to reply in prose. Bounded, because a
      // model could keep requesting tools forever.
      let wrapUpRounds = 0;
      for (let step = 0; turn.hasToolCalls; step++) {
        if (signal?.aborted) {
          onProgress({ type: 'interrupted' });
          return { kind: 'message', text: turn.text, researchLog };
        }
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
          turn = await chat.sendToolResults(
            turn.toolCalls.map((tc) => ({ name: tc.name, output: notice, truncated: false, totalChars: notice.length, id: tc.id })),
            signal,
          );
          continue;
        }
        const thinking = turn.reasoning ? turn.reasoning.slice(-200) : '';
        const { toolResults, logEntries } = await this.executeToolCalls(
          turn.toolCalls, ctx.fs, onProgress, ctx.fetcher, step, thinking, signal,
        );
        researchLog.push(...logEntries);
        BaseAiService.appendBudgetCountdown(toolResults, MAX_STEPS - step - 1, 'reply to the user (summary, question, or plan JSON)');
        turn = await chat.sendToolResults(toolResults, signal);
      }

      // A plain-reply turn (no tool calls) never passes through the loop
      // above, so this is the first point it can notice an abort raised
      // while its HTTP call was already in flight — without it, a stale
      // turn classifies and returns as a normal plan/message after reset().
      if (signal?.aborted) {
        onProgress({ type: 'interrupted' });
        return { kind: 'message', text: turn.text, researchLog };
      }

      // Forced break with nothing to show: degrade to a visible failure
      // instead of an empty planner bubble.
      if (turn.hasToolCalls && !turn.text.trim()) {
        return {
          kind: 'message',
          text: `I hit the research tool budget for this turn (${MAX_STEPS} rounds) before finishing. Tell me to continue, or narrow the request.`,
          researchLog,
        };
      }

      // An empty turn (no text, no tool calls — flash-lite does this) would
      // leave the user staring at silence. Nudge the model once; if it comes
      // back empty again, degrade to a visible failure.
      if (!turn.text.trim()) {
        if (!emptyNudgeSent && !signal?.aborted) {
          emptyNudgeSent = true;
          pending = 'Your last reply was empty. Respond to the user now: answer their last message directly, ask your next question, or emit the plan JSON.';
          continue;
        }
        return {
          kind: 'message',
          text: 'The planner returned an empty reply twice. Please rephrase or try again.',
          researchLog,
        };
      }

      if (extractPrdBlock(turn.text)) ctx.prdCaptured = true;

      // What did the model emit? PlanRepair owns the classification (envelope
      // keys, attempt-detection) and the corrective prompt texts; this loop
      // only applies its policies: the repair budget, the abort guard, and
      // the PRD gate.
      const reply = classifyPlannerReply(turn.text, {
        runners: ctx.runners,
        runnerModes: ctx.runnerModes,
        autonomousDefault: ctx.autonomousDefault,
      });

      switch (reply.kind) {
        case 'task_ops':
          return { kind: 'task_ops', ops: reply.ops, text: turn.text, researchLog };

        case 'plan':
          // PRD mode fail-safe: a cheap model that skips the PRD and jumps to
          // JSON would otherwise commit a plan with no PRD on record. Bounce
          // once with a corrective message; if it still refuses, accept the
          // plan rather than trap the user in a loop.
          if (ctx.prdEnabled && !ctx.prdCaptured && !ctx.prdNudgeSent && !signal?.aborted) {
            ctx.prdNudgeSent = true;
            pending = [
              'PRD mode is enabled but no PRD has been produced yet, so the plan was NOT committed.',
              'In your next reply: first output the full markdown PRD wrapped EXACTLY in',
              '<!-- ORDEWELL_PRD_START slug="<feature-slug>" --> and <!-- ORDEWELL_PRD_END -->,',
              'then re-emit the exact same task plan JSON after the PRD block.',
            ].join(' ');
            continue;
          }
          return { kind: 'plan', tasks: reply.tasks, text: turn.text, researchLog };

        // Botched attempts get a bounded corrective retry — otherwise the
        // broken JSON would surface as a prose bubble and the edit or plan
        // would silently fail to commit.
        case 'broken_task_ops':
          if (jsonRepairAttempts < MAX_JSON_REPAIRS && !signal?.aborted) {
            jsonRepairAttempts++;
            pending = reEmitTaskOpsPrompt(reply.error.message);
            continue;
          }
          break;

        case 'broken_plan':
          if (jsonRepairAttempts < MAX_JSON_REPAIRS && !signal?.aborted) {
            jsonRepairAttempts++;
            if (reply.error.truncated || turn.finishReason === 'length') {
              // Output-limit truncation: re-asking in the same context would be
              // cut at the same point. Free input space first (raw transcripts
              // pruned, digests kept), then ask for a terser re-emit.
              const removed = chat.compactHistory?.() ?? 0;
              pending = truncatedPlanReEmitPrompt(removed > 0);
            } else {
              pending = reEmitPlanPrompt(reply.error.message);
            }
            continue;
          }
          break;

        case 'prose':
          break;
      }

      return { kind: 'message', text: turn.text, researchLog };
    }
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

    chat = withProactiveCompaction(chat);
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
    autonomousDefault = true,
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

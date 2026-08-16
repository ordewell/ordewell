import { spawn as nodeSpawn } from 'child_process';
import {
  type Task,
  type DiscoveredModel,
  type ResearchLogEntry,
  type ResearchProgress,
  type ResearchStep,
  type RunnerId,
  type LegacyPlanState,
} from '../../models/Task';
import type { IConfig } from '../../interfaces/IConfig';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { IWebFetcher } from '../../interfaces/IWebFetcher';
import type { RunnerModeInfo } from '../ModeResolver';
import type { IAiService, ConversationRequest, ConversationTurn } from '../AiService';
import {
  buildConversationSystemPrompt,
  buildPlanWithResults,
  buildModifyPlanPrompt,
} from '../PlanPrompts';
import {
  classifyPlannerReply,
  generatePlanWithRepair,
  reEmitPlanPrompt,
  reEmitTaskOpsPrompt,
  reEmitTaskQueryPrompt,
} from '../PlanRepair';
import { extractPrdBlock } from '../../utils/prdStore';
import { runnerForProvider } from '../ProviderRegistry';
import { collectResearchContext } from '../ContextCollector';
import type { AgentAdapter, AgentEvent, AgentProcessDeps, AgentStartOptions } from './AgentAdapter';
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter';
import { CodexAdapter } from './CodexAdapter';
import { OpenCodeAdapter } from './OpenCodeAdapter';
import { mapAgentTool, normalizeAgentArgs } from './agentTools';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from '../plannerModes';

/** Corrective re-emits allowed for botched JSON, matching the API backend. */
const MAX_JSON_REPAIRS = 2;

/**
 * How many times a turn that backgrounded a subagent may be asked to wait for
 * it. Bounded like the repair loop and for the same reason: an agent that keeps
 * deferring must cost a known number of turns, not an open-ended poll. Two,
 * because the first ask can arrive while the subagent is genuinely still
 * running, and one retry is what turns "not yet" into the report.
 */
const MAX_AGENT_WAITS = 2;

/** Kept out of the reply text and the log; a long trace would drown both. */
const LOG_MAX_CHARS = 10000;

export interface CliAgentAiServiceDeps extends Partial<AgentProcessDeps> {
  /** Overrides adapter construction. Tests supply a fake agent; production picks by runner id. */
  createAdapter?: (runner: string, deps: AgentProcessDeps) => AgentAdapter | null;
  /** Workspace root the agent explores. Defaults to the host process's cwd. */
  workspaceRoot?: () => string;
}

function defaultAdapter(runner: string, deps: AgentProcessDeps): AgentAdapter | null {
  switch (runner) {
    case 'claude-code': return new ClaudeCodeAdapter(deps);
    case 'codex': return new CodexAdapter(deps);
    case 'opencode': return new OpenCodeAdapter(deps);
    default: return null;
  }
}

/** One completed harness turn, before classification. */
interface HarnessTurn {
  text: string;
  researchLog: ResearchStep[];
  /** The agent's own failure, verbatim. Present means the turn did not complete. */
  error?: string;
  aborted?: boolean;
  /** Subagents the agent left running when it ended the turn. See {@link MAX_AGENT_WAITS}. */
  backgroundAgents: number;
}

/**
 * A coding agent driven as Ordewell's planner (ADR-0009).
 *
 * The second transport behind `IAiService`, sitting beside `OpenAiService` and
 * `GeminiService`. It deliberately does **not** extend {@link BaseAiService}:
 * that class's body is Ordewell executing research tools on a model's behalf,
 * which is precisely the part a coding agent replaces. What it reuses instead
 * is everything above the transport — `classifyPlannerReply`, the bounded
 * corrective re-emit loop, `parsePlanJson`, the `ResearchProgress` events the
 * four surfaces already render. That is why this backend reaches VS Code, the
 * web UI, the CLI and the TUI without any of them learning a coding agent is
 * on the other end.
 */
export class CliAgentAiService implements IAiService {
  private readonly runner: string;
  private readonly processDeps: AgentProcessDeps;
  private readonly makeAdapter: (runner: string, deps: AgentProcessDeps) => AgentAdapter | null;
  private readonly workspaceRoot: () => string;

  private adapter: AgentAdapter | null = null;
  /**
   * The agent's own session id, kept across a process death so the next turn
   * can resume warm context instead of re-reading the repository. Cleared at
   * every session boundary — nothing from one goal may reach the next.
   */
  private lastNativeSessionId: string | null = null;
  private conversation: { startOptions: AgentStartOptions; runners: RunnerId[]; runnerModes?: Record<RunnerId, RunnerModeInfo[]>; autonomousDefault?: boolean; prdEnabled: boolean; prdCaptured: boolean; prdNudgeSent: boolean } | null = null;
  private activeAbort: AbortController | null = null;

  constructor(private config: IConfig, deps: CliAgentAiServiceDeps = {}) {
    const runner = runnerForProvider(config.aiProvider);
    if (!runner) throw new Error(`${config.aiProvider} is not a coding-agent planner.`);
    this.runner = runner;
    this.processDeps = {
      spawn: deps.spawn ?? nodeSpawn,
      fetch: deps.fetch ?? globalThis.fetch,
      resolvePath: deps.resolvePath,
      platform: deps.platform,
      isDirectory: deps.isDirectory,
      exists: deps.exists,
    };
    this.makeAdapter = deps.createAdapter ?? defaultAdapter;
    this.workspaceRoot = deps.workspaceRoot ?? (() => process.cwd());
  }

  hasActiveConversation(): boolean { return this.conversation !== null; }

  /**
   * False when the running agent process was spawned under a model/effort the
   * user has since changed in the picker. Unlike a vendor backend, the model
   * is a spawn-time argument to the agent CLI (`--model`), not a per-request
   * field — `continueConversation` sends the next turn to whatever process is
   * already running, so a plain config read here would silently keep planning
   * on the old model. No conversation yet is vacuously "current".
   */
  conversationMatchesConfig(): boolean {
    if (!this.conversation) return true;
    return this.conversation.startOptions.model === this.plannerModel()
      && this.conversation.startOptions.effort === this.config.plannerThinkingEffort;
  }

  /** The agent's own session id, a resumption hint only — Ordewell's transcript is authoritative (T4). */
  nativeSessionId(): string | null { return this.adapter?.nativeSessionId() ?? null; }

  reset(): void {
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.adapter?.dispose();
    this.adapter = null;
    // Session boundaries are hard (ADR-0008): the next goal must not resume
    // the previous goal's agent session.
    this.lastNativeSessionId = null;
    this.conversation = null;
  }

  // --- Conversation (ADR-0002) ---

  async startConversation(req: ConversationRequest): Promise<ConversationTurn> {
    this.reset();

    const contextStr = await collectResearchContext(req.fs, req.runners);
    const systemPrompt = buildConversationSystemPrompt(
      req.goal,
      contextStr,
      req.modelsByRunner,
      req.runners,
      req.runnerModes,
      req.autonomousDefault ?? true,
      req.grillMeEnabled ?? false,
      req.prdEnabled ?? false,
      req.reviewEnabled ?? false,
      req.verificationEnabled ?? false,
      true,
    );

    const startOptions: AgentStartOptions = {
      cwd: this.workspaceRoot(),
      systemPrompt,
      model: this.plannerModel(),
      effort: this.config.plannerThinkingEffort,
    };

    await this.startAdapter(startOptions);

    this.conversation = {
      startOptions,
      runners: req.runners,
      runnerModes: req.runnerModes,
      autonomousDefault: req.autonomousDefault,
      prdEnabled: req.prdEnabled ?? false,
      prdCaptured: false,
      prdNudgeSent: false,
    };

    // A reloaded session replays its transcript instead of re-running the
    // research the agent already paid for. The agent gets it as context, not
    // as turns: the reply we act on is the one the user's new message opens.
    const opening = this.openingMessage(req);
    return this.runConversation(opening, req.onProgress, req.signal);
  }

  async continueConversation(
    userMessage: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<ConversationTurn> {
    if (!this.conversation) throw new Error('No active planner conversation. Start planning first.');
    return this.runConversation(userMessage, onProgress, signal);
  }

  private openingMessage(req: ConversationRequest): string {
    const history = req.priorHistory ?? [];
    if (history.length === 0) return req.initialMessage ?? req.goal;
    const transcript = history
      .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`)
      .join('\n\n');
    return [
      'This planning conversation is being resumed. Here is what has been said so far:',
      '',
      '<previous_conversation>',
      transcript,
      '</previous_conversation>',
      '',
      'Continue from there. The user now says:',
      '',
      req.initialMessage ?? req.goal,
    ].join('\n');
  }

  /**
   * Drive one user message to a settled planner turn. Same shape as the API
   * backend's conversation loop minus the tool rounds — those belong to the
   * agent now — and with the same three policies layered on top: the PRD gate,
   * the empty-reply nudge, and a bounded corrective re-emit for botched JSON.
   */
  private async runConversation(
    message: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<ConversationTurn> {
    const conversation = this.conversation!;
    const combined = this.startAbortScope(signal);
    const researchLog: ResearchLogEntry[] = [];
    let pending = message;
    let emptyNudgeSent = false;
    let jsonRepairAttempts = 0;
    let agentWaits = 0;
    // Text from turns Ordewell continued past on the user's behalf. A wait is
    // not a new user message, so the reply they read is the whole answer.
    const carried: string[] = [];
    const replyText = (text: string) => [...carried, text].filter((part) => part.trim()).join('\n\n');

    try {
      for (;;) {
        const turn = await this.runTurn(pending, onProgress, combined);
        researchLog.push(...turn.researchLog);

        if (turn.aborted || combined?.aborted) {
          onProgress({ type: 'interrupted' });
          return { kind: 'message', text: replyText(turn.text), researchLog };
        }

        // Fail visibly, per the repo's fail-safe contract: an agent that died,
        // hit its rate limit, or lost its login must say so in the chat rather
        // than leave an empty planner bubble.
        if (turn.error) {
          return { kind: 'message', text: turn.error, researchLog };
        }

        if (!turn.text.trim()) {
          // An agent whose tool was refused can end its turn on the refusal,
          // saying nothing. Naming it keeps the failure visible instead of
          // reporting a blank reply the user cannot act on.
          const refused = turn.researchLog.find((step) => step.outcome === 'denied');
          if (!emptyNudgeSent) {
            emptyNudgeSent = true;
            pending = refused
              ? `Your last reply was empty because "${refused.toolLabel ?? refused.tool}" was refused: you are planning read-only and confined to this workspace. Do not retry it. Answer the user now with what you already know, or ask your next question.`
              : 'Your last reply was empty. Respond to the user now: answer their last message directly, ask your next question, or emit the plan JSON.';
            continue;
          }
          return {
            kind: 'message',
            text: refused
              ? `The planner stopped without replying: "${refused.toolLabel ?? refused.tool}" was refused because planning is read-only and confined to this workspace.`
              : 'The planner returned an empty reply twice. Please rephrase or try again.',
            researchLog,
          };
        }

        // The agent ended its turn with subagents still running, so whatever
        // they find is about to be said into a closed turn. Ask for it while a
        // turn is still open — this is the whole recovery, and it is bounded.
        if (turn.backgroundAgents > 0 && agentWaits < MAX_AGENT_WAITS && !combined?.aborted) {
          agentWaits++;
          carried.push(turn.text);
          pending = [
            `You ended your turn with ${turn.backgroundAgents} subagent(s) still running in the background.`,
            'Ordewell hands the conversation back to the user when your turn ends, so anything you say after it never reaches them —',
            'the results you promised to report would be lost.',
            'Wait for those agents to finish NOW, in this reply, and do not end your turn until you have their results.',
            'Then give the user your synthesis. In future replies, await your agents inside the turn rather than backgrounding them.',
          ].join(' ');
          continue;
        }

        if (extractPrdBlock(turn.text)) conversation.prdCaptured = true;

        const reply = classifyPlannerReply(turn.text, {
          runners: conversation.runners,
          runnerModes: conversation.runnerModes,
          autonomousDefault: conversation.autonomousDefault,
        });

        switch (reply.kind) {
          case 'task_ops':
            return { kind: 'task_ops', ops: reply.ops, text: replyText(turn.text), researchLog };

          // The read channel is a text envelope precisely so it reaches here
          // too: a harness planner has no Ordewell tool loop to call into.
          case 'task_query':
            return { kind: 'task_query', query: reply.query, text: replyText(turn.text), researchLog };

          case 'plan':
            if (conversation.prdEnabled && !conversation.prdCaptured && !conversation.prdNudgeSent && !combined?.aborted) {
              conversation.prdNudgeSent = true;
              pending = [
                'PRD mode is enabled but no PRD has been produced yet, so the plan was NOT committed.',
                'In your next reply: first output the full markdown PRD wrapped EXACTLY in',
                '<!-- ORDEWELL_PRD_START slug="<feature-slug>" --> and <!-- ORDEWELL_PRD_END -->,',
                'then re-emit the exact same task plan JSON after the PRD block.',
              ].join(' ');
              continue;
            }
            // A committed plan closes the conversation, matching the API
            // backend: post-plan chat re-enters through `startConversation`
            // with the plan's own transcript rather than inheriting this
            // session's context.
            this.conversation = null;
            return { kind: 'plan', tasks: reply.tasks, text: replyText(turn.text), researchLog };

          case 'broken_task_ops':
            if (jsonRepairAttempts < MAX_JSON_REPAIRS && !combined?.aborted) {
              jsonRepairAttempts++;
              pending = reEmitTaskOpsPrompt(reply.error.message);
              continue;
            }
            break;

          case 'broken_task_query':
            if (jsonRepairAttempts < MAX_JSON_REPAIRS && !combined?.aborted) {
              jsonRepairAttempts++;
              pending = reEmitTaskQueryPrompt(reply.error.message);
              continue;
            }
            break;

          case 'broken_plan':
            if (jsonRepairAttempts < MAX_JSON_REPAIRS && !combined?.aborted) {
              jsonRepairAttempts++;
              pending = reEmitPlanPrompt(reply.error.message);
              continue;
            }
            break;

          case 'prose':
            break;
        }

        return { kind: 'message', text: replyText(turn.text), researchLog };
      }
    } finally {
      this.activeAbort = null;
    }
  }

  /**
   * Run one agent turn: stream its events into `ResearchProgress`, collect the
   * reply text, and return the research steps produced. Tool calls are matched
   * to their results by the agent's own call id — matching by tool name puts
   * one file's body on another file's row the moment an agent runs two reads
   * at once, which all three of these do routinely.
   */
  private async runTurn(
    message: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<HarnessTurn> {
    const adapter = await this.ensureAdapter();
    const pendingCalls = new Map<string, { tool: ResearchStep['tool']; toolLabel?: string; args: string }>();
    const researchLog: ResearchStep[] = [];
    let text = '';
    let error: string | undefined;
    let stepIndex = 0;
    let backgroundAgents = 0;

    const truncate = (value: string) =>
      value.length > LOG_MAX_CHARS ? `${value.slice(0, LOG_MAX_CHARS)}\n[... truncated, total ${value.length} chars]` : value;

    const settle = (id: string, output: string, success: boolean, outcome: ResearchStep['outcome']) => {
      const call = pendingCalls.get(id);
      pendingCalls.delete(id);
      const step: ResearchStep = {
        id: `rs-${Date.now()}-${stepIndex++}`,
        tool: call?.tool ?? 'agent_tool',
        toolLabel: call?.toolLabel,
        args: call?.args ?? '{}',
        result: truncate(output),
        success,
        outcome,
        toolCallId: id,
        timestamp: new Date().toISOString(),
      };
      researchLog.push(step);
      onProgress({ type: 'tool_result', toolResult: output, step, toolCallId: id });
    };

    await adapter.send(message, (event: AgentEvent) => {
      switch (event.type) {
        case 'assistant_text':
          text += event.text;
          onProgress({ type: 'plan_token', planToken: event.text });
          return;

        case 'thinking':
          onProgress({ type: 'thinking', text: event.text });
          return;

        case 'tool_call': {
          const mapped = mapAgentTool(event.name);
          const args = JSON.stringify(normalizeAgentArgs(mapped.tool, event.args));
          pendingCalls.set(event.id, { tool: mapped.tool, toolLabel: mapped.toolLabel, args });
          onProgress({ type: 'tool_call', tool: mapped.tool, toolLabel: mapped.toolLabel, toolArgs: args, toolCallId: event.id });
          return;
        }

        case 'tool_result':
          settle(event.id, event.output, event.success, event.success ? 'success' : 'failure');
          return;

        case 'background_agent':
          backgroundAgents++;
          return;

        case 'permission_request': {
          // Auto-denied, always (T1). The request is still announced so the
          // user can see the planner reached for something it may not have —
          // a silently swallowed denial reads as the agent losing interest.
          const mapped = mapAgentTool(event.name);
          const args = JSON.stringify({ detail: event.detail });
          if (!pendingCalls.has(event.id)) {
            pendingCalls.set(event.id, { tool: mapped.tool, toolLabel: mapped.toolLabel, args });
            onProgress({ type: 'tool_call', tool: mapped.tool, toolLabel: mapped.toolLabel, toolArgs: args, toolCallId: event.id });
          }
          settle(
            event.id,
            `Access denied: the planner runs read-only, so "${event.name}" was refused. Mutation belongs to the runners that execute the plan.`,
            false,
            'denied',
          );
          return;
        }

        case 'error':
          error = event.message;
          return;

        case 'turn_end':
          return;
      }
    }, signal);

    // Anything still pending when the turn ended never produced a result —
    // report it rather than leaving a spinner running in every surface.
    for (const id of [...pendingCalls.keys()]) {
      settle(id, 'The agent ended the turn without reporting this call\'s result.', false, 'not_executed');
    }

    this.lastNativeSessionId = adapter.nativeSessionId() ?? this.lastNativeSessionId;
    // A failed turn usually means the process is gone, and an aborted one kills
    // the process by contract. Either way the adapter cannot be sent to again —
    // `dispose()` is terminal — so drop it and let the next turn restart from
    // the session id rather than throwing into a dead stdin.
    if (error || signal?.aborted) { adapter.dispose(); this.adapter = null; }

    return { text, researchLog, error, aborted: signal?.aborted, backgroundAgents };
  }

  // --- Process lifecycle ---

  private async startAdapter(opts: AgentStartOptions): Promise<AgentAdapter> {
    const adapter = this.makeAdapter(this.runner, this.processDeps);
    if (!adapter) throw new Error(`No planner adapter is available for "${this.runner}".`);
    await adapter.start(opts);
    this.adapter = adapter;
    return adapter;
  }

  /**
   * The live agent process, restarted from its own session id if it died
   * between turns. Resume is a hint: when it fails, the caller's next
   * `startConversation` reseeds from Ordewell's transcript, which is the same
   * degradation `restoreChat` already performs on every surface.
   */
  private async ensureAdapter(): Promise<AgentAdapter> {
    if (this.adapter) return this.adapter;
    const conversation = this.conversation;
    if (!conversation) throw new Error('No active planner conversation.');
    await this.startAdapter({ ...conversation.startOptions, resumeSessionId: this.lastNativeSessionId ?? undefined });
    return this.adapter!;
  }

  private startAbortScope(callerSignal?: AbortSignal): AbortSignal | undefined {
    this.activeAbort = new AbortController();
    if (!callerSignal) return this.activeAbort.signal;
    if (callerSignal.aborted) { this.activeAbort.abort(); return this.activeAbort.signal; }
    callerSignal.addEventListener('abort', () => this.activeAbort?.abort(), { once: true });
    return this.activeAbort.signal;
  }

  private plannerModel(): string | undefined {
    const id = (this.config.orchestratorModel ?? '').trim();
    return id || undefined;
  }

  // --- One-shot paths (CLI `plan --goal`, web REST, plan modification) ---

  /**
   * A single agent session that answers one prompt and exits. Used by every
   * non-conversational entry point; the plan is parsed from the reply text by
   * the same extractor the conversational path uses.
   */
  private async oneShot(prompt: string, onProgress?: (p: ResearchProgress) => void, signal?: AbortSignal): Promise<{ text: string; researchLog: ResearchLogEntry[] }> {
    const previous = this.adapter;
    const previousConversation = this.conversation;
    const previousSessionId = this.lastNativeSessionId;
    this.adapter = null;

    const startOptions: AgentStartOptions = {
      cwd: this.workspaceRoot(),
      systemPrompt: prompt,
      model: this.plannerModel(),
      effort: this.config.plannerThinkingEffort,
    };
    let oneShotAdapter: AgentAdapter | null = null;
    try {
      oneShotAdapter = await this.startAdapter(startOptions);
      this.conversation = {
        startOptions,
        runners: [],
        prdEnabled: false,
        prdCaptured: false,
        prdNudgeSent: false,
      };
      const turn = await this.runTurn(
        'Follow the instructions in your system prompt and produce the plan now.',
        onProgress ?? (() => {}),
        signal,
      );
      if (turn.error) throw new Error(turn.error);
      return { text: turn.text, researchLog: turn.researchLog };
    } finally {
      // A one-shot never leaves a process behind, and never disturbs a
      // conversational session that happened to be open around it — including
      // when its own agent failed to start, which happens before there is
      // anything to dispose.
      oneShotAdapter?.dispose();
      this.adapter = previous;
      this.conversation = previousConversation;
      // The one-shot's own agent session must not become the conversation's
      // resume hint: restarting the chat into a plan-generation session would
      // cross two sessions that never shared a goal.
      this.lastNativeSessionId = previousSessionId;
    }
  }

  async researchAndPlan(
    userDescription: string,
    runners: RunnerId[],
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    fs: IFileSystem,
    onProgress: (progress: ResearchProgress) => void,
    _fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes: PlannerModes = DEFAULT_PLANNER_MODES,
    signal?: AbortSignal,
  ): Promise<{ tasks: Task[]; researchLog: ResearchLogEntry[]; researchResults: string }> {
    const contextStr = await collectResearchContext(fs, runners);
    const researchLog: ResearchLogEntry[] = [
      { id: `up-${Date.now()}`, type: 'user_prompt', content: userDescription, timestamp: new Date().toISOString() },
    ];
    let lastText = '';
    const tasks = await generatePlanWithRepair(
      async (repairHint) => {
        const prompt = buildPlanWithResults(userDescription, contextStr, '', modelsByRunner, runners, runnerModes, modes);
        const result = await this.oneShot(repairHint ? `${prompt}\n\n${repairHint}` : prompt, onProgress, signal);
        researchLog.push(...result.researchLog);
        lastText = result.text;
        return result.text;
      },
      runners, 2, runnerModes, modes.autonomousDefault,
    );
    return { tasks, researchLog, researchResults: lastText };
  }

  async generatePlanDirect(
    userDescription: string,
    runners: RunnerId[] = ['claude-code'],
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> = {},
    onToken?: (token: string) => void,
    _fs?: IFileSystem,
    _fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes: PlannerModes = DEFAULT_PLANNER_MODES,
    signal?: AbortSignal,
  ): Promise<Task[]> {
    const prompt = buildPlanWithResults(userDescription, '', '', modelsByRunner, runners, runnerModes, modes);
    return generatePlanWithRepair(
      async (repairHint) => {
        const result = await this.oneShot(
          repairHint ? `${prompt}\n\n${repairHint}` : prompt,
          (p) => { if (p.type === 'plan_token' && p.planToken) onToken?.(p.planToken); },
          signal,
        );
        return result.text;
      },
      runners, 2, runnerModes, modes.autonomousDefault,
    );
  }

  async modifyPlan(
    existingPlan: LegacyPlanState,
    userRequest: string,
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    onProgress?: (progress: ResearchProgress) => void,
    _fs?: IFileSystem,
    _fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes: PlannerModes = DEFAULT_PLANNER_MODES,
    signal?: AbortSignal,
  ): Promise<{ tasks: Task[] }> {
    const prompt = buildModifyPlanPrompt(existingPlan, userRequest, modelsByRunner, undefined, runnerModes, modes.autonomousDefault);
    try {
      const tasks = await generatePlanWithRepair(
        async (repairHint) => {
          const result = await this.oneShot(repairHint ? `${prompt}\n\n${repairHint}` : prompt, onProgress, signal);
          return result.text;
        },
        existingPlan.runners, 2, runnerModes, modes.autonomousDefault,
      );
      return { tasks };
    } catch (err) {
      throw new Error(`Plan modification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async sendPlanningPrompt(
    prompt: string,
    runners: RunnerId[],
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    autonomousDefault = true,
  ): Promise<Task[]> {
    return generatePlanWithRepair(
      async (repairHint) => {
        const result = await this.oneShot(repairHint ? `${prompt}\n\n${repairHint}` : prompt);
        return result.text;
      },
      runners, 2, runnerModes, autonomousDefault,
    );
  }
}

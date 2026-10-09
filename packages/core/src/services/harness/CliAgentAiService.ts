import { McpAttachError } from './ordewellBinding';
import { spawn as nodeSpawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import {
  type Task,
  type DiscoveredModel,
  type ResearchLogEntry,
  type ResearchProgress,
  type ResearchStep,
  type RunnerId,
  type LegacyPlanState,
  plannerTaskView,
  DEFAULT_RUNNERS,
} from '../../models/Task';
import { addUsage, type UsageTotals } from '../../models/Usage';
import type { IConfig } from '../../interfaces/IConfig';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { IWebFetcher } from '../../interfaces/IWebFetcher';
import type { RunnerModeInfo } from '../ModeResolver';
import type { IAiService, ConversationRequest, ConversationTurn, PlannerToolsOffer } from '../AiService';
import {
  buildConversationSystemPrompt,
  buildPlanWithResults,
  buildModifyPlanPrompt,
} from '../PlanPrompts';
import { generatePlanWithRepair } from '../PlanRepair';
import { validatePlanTasks } from '../PlanValidator';
import { settleReply, type ReplyAttempt } from '../settleReply';
import { ReplySplitter } from '../replyStream';
import { redactSecrets } from '../../utils/redactSecrets';
import { abortScope } from '../../utils/abortScope';
import { runnerForProvider } from '../ProviderRegistry';
import { collectResearchContext } from '../ContextCollector';
import type { AgentAdapter, AgentEvent, AgentProcessDeps, PlannerStartOptions } from './AgentAdapter';
import { createPlannerAdapter } from './connectors';
import { mapAgentTool, normalizeAgentArgs } from './agentTools';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from '../plannerModes';
import { mcpClientConfig, sharedMcpServer, type McpCredential, type OrdewellMcpServer } from '../mcp';

/**
 * How many times a turn that backgrounded a subagent may be asked to wait for
 * it. Bounded like the repair loop and for the same reason: an agent that keeps
 * deferring must cost a known number of turns, not an open-ended poll. Two,
 * because the first ask can arrive while the subagent is genuinely still
 * running, and one retry is what turns "not yet" into the report.
 */
const MAX_AGENT_WAITS = 2;

function waitForAgentsPrompt(running: number): string {
  return [
    `You ended your turn with ${running} subagent(s) still running in the background.`,
    'Ordewell hands the conversation back to the user when your turn ends, so anything you say after it never reaches them —',
    'the results you promised to report would be lost.',
    'Wait for those agents to finish NOW, in this reply, and do not end your turn until you have their results.',
    'Then give the user your synthesis. In future replies, await your agents inside the turn rather than backgrounding them.',
  ].join(' ');
}

/** Kept out of the reply text and the log; a long trace would drown both. */
const LOG_MAX_CHARS = 10000;

export interface CliAgentAiServiceDeps extends Partial<AgentProcessDeps> {
  /** Overrides adapter construction. Tests supply a fake agent; production picks by runner id. */
  createAdapter?: (runner: string, deps: AgentProcessDeps) => AgentAdapter | null;
  /** Workspace root the agent explores. Defaults to the host process's cwd. */
  workspaceRoot?: () => string;
  /** Where a conversation's planner tools are served (ADR-0022). Absent: no conversation can start. */
  mcpServer?: OrdewellMcpServer;
}

interface OneShotCatalog {
  runners: RunnerId[];
  modelsByRunner?: Partial<Record<RunnerId, DiscoveredModel[]>>;
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault?: boolean;
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
 * is everything above the transport — `settleReply` (reply classification
 * and the bounded corrective retries), `parsePlanJson`, the `ResearchProgress` events the
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
  private conversation: { startOptions: PlannerStartOptions; tools: PlannerToolsOffer; runners: RunnerId[]; runnerModes?: Record<RunnerId, RunnerModeInfo[]>; autonomousDefault?: boolean } | null = null;
  private readonly mcpServer: OrdewellMcpServer | undefined;
  /** The planner token the running process was spawned with; revoked with the process (ADR-0022, A3). */
  private plannerToken: string | null = null;
  private activeAbort: AbortController | null = null;
  /**
   * Every subagent this conversation has reported starting, and finishing.
   * Agents restate a subagent's state as it changes, and one can finish a turn
   * or a process restart after it started; surfaces get each once, in order.
   */
  private readonly subagents = { started: new Set<string>(), finished: new Set<string>() };

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
    this.makeAdapter = deps.createAdapter ?? createPlannerAdapter;
    this.workspaceRoot = deps.workspaceRoot ?? (() => process.cwd());
    this.mcpServer = deps.mcpServer ?? sharedMcpServer();
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

  /** Always: a conversation whose planner cannot reach the Ordewell MCP server fails to start rather than falling back to the envelopes. */
  plannerToolsAttached(): boolean { return true; }

  /** The agent's own session id, a resumption hint only — Ordewell's transcript is authoritative (T4). */
  nativeSessionId(): string | null { return this.adapter?.nativeSessionId() ?? null; }

  reset(): void {
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.disposeAdapter();
    // Session boundaries are hard (ADR-0008): the next goal must not resume
    // the previous goal's agent session.
    this.lastNativeSessionId = null;
    this.conversation = null;
    this.subagents.started.clear();
    this.subagents.finished.clear();
  }

  // --- Conversation (ADR-0002) ---

  async startConversation(req: ConversationRequest): Promise<ConversationTurn> {
    this.reset();
    if (!this.mcpServer || !req.plannerTools) {
      throw new Error(`The ${this.runner} planner plans through Ordewell's MCP tools, and this session has no server to hand it.`);
    }

    const contextStr = await collectResearchContext(req.fs, req.runners);
    const systemPrompt = buildConversationSystemPrompt(
      req.goal,
      contextStr,
      req.modelsByRunner,
      req.runners,
      req.runnerModes,
      req.autonomousDefault ?? true,
      { harness: true, isolatedExecution: req.isolatedExecution, skills: req.skills },
    );

    const startOptions: PlannerStartOptions = {
      kind: 'planner',
      cwd: this.workspaceRoot(),
      systemPrompt,
      model: this.plannerModel(),
      effort: this.config.plannerThinkingEffort,
    };
    const tools = req.plannerTools;
    await this.startAdapter(startOptions, tools);

    this.conversation = {
      startOptions,
      tools,
      runners: req.runners,
      runnerModes: req.runnerModes,
      autonomousDefault: req.autonomousDefault,
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
   * Drive one user message to a settled planner turn through
   * {@link settleReply}, the loop the API backend settles through too. The
   * tool rounds belong to the agent now, so one call is one agent turn —
   * continued while it left subagents running in the background.
   */
  private async runConversation(
    message: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<ConversationTurn> {
    const conversation = this.conversation!;
    this.activeAbort = abortScope(signal);
    const combined = this.activeAbort.signal;
    let agentWaits = 0;
    // Text from turns Ordewell continued past on the user's behalf. A wait is
    // not a new user message, so the reply they read is the whole answer.
    const carried: string[] = [];

    const send = async (text: string): Promise<ReplyAttempt> => {
      let turn = await this.runTurn(text, onProgress, combined);
      const researchLog: ResearchLogEntry[] = [...turn.researchLog];
      // The agent ended its turn with subagents still running, so whatever
      // they find is about to be said into a closed turn. Ask for it while a
      // turn is still open — this is the whole recovery, and it is bounded.
      while (turn.backgroundAgents > 0 && agentWaits < MAX_AGENT_WAITS && turn.text.trim() && !turn.error && !turn.aborted && !combined?.aborted) {
        agentWaits++;
        carried.push(turn.text);
        turn = await this.runTurn(waitForAgentsPrompt(turn.backgroundAgents), onProgress, combined);
        researchLog.push(...turn.researchLog);
      }
      return {
        text: turn.text,
        researchLog,
        aborted: turn.aborted || combined?.aborted,
        // Fail visibly, per the repo's fail-safe contract: an agent that died,
        // hit its rate limit, or lost its login must say so in the chat rather
        // than leave an empty planner bubble.
        failure: turn.error,
        fullText: [...carried, turn.text].filter((part) => part.trim()).join('\n\n'),
      };
    };

    try {
      const turn = await settleReply({
        message,
        send,
        classify: { runners: conversation.runners, runnerModes: conversation.runnerModes, autonomousDefault: conversation.autonomousDefault },
        onProgress,
        signal: combined,
        // `runTurn` folds every run of text the agent's turn produced into its
        // reply, a tool call's earlier segment included.
        replyJoinsSegments: true,
      });
      // A committed plan closes the conversation, matching the API backend:
      // post-plan chat re-enters through `startConversation` with the plan's
      // own transcript rather than inheriting this session's context.
      if (turn.kind === 'plan') this.conversation = null;
      return turn;
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
    const pendingCalls = new Map<string, { tool: ResearchStep['tool']; toolLabel?: string; args: string; subagentId?: string }>();
    const researchLog: ResearchStep[] = [];
    let text = '';
    // Deltas of the reply run still open. Its complete `assistant_text`
    // replaces them; a tool call or the end of the turn commits them as sent.
    let streamedRun = '';
    // Segments a run's own text streams under. A fresh id per run so a plan
    // envelope opening right after a tool call is classified on its own
    // opening, not carried over from whatever the text before the call was.
    let segmentId = uuidv4();
    const commitRun = () => { text += streamedRun; streamedRun = ''; segmentId = uuidv4(); };
    // Who streamed thinking deltas (the planner as '', or a subagent) since
    // their last complete `thinking`, which then repeats what was already sent.
    const streamedThinking = new Set<string>();
    const subagentUsage = new Map<string, UsageTotals>();
    let error: string | undefined;
    let stepIndex = 0;
    let backgroundAgents = 0;

    const truncate = (value: string) =>
      value.length > LOG_MAX_CHARS ? `${value.slice(0, LOG_MAX_CHARS)}\n[... truncated, total ${value.length} chars]` : value;

    const settle = (id: string, rawOutput: string, success: boolean, outcome: ResearchStep['outcome'], reportedBy?: string) => {
      // The other construction point for a research step (see `executeTool`).
      // A harness agent runs its own tools against its own provider, so the
      // provider half of the leak is already outside our reach — but the copy
      // this step persists into the session file is ours, and it must not hold
      // credentials in plaintext.
      const output = redactSecrets(rawOutput);
      const call = pendingCalls.get(id);
      pendingCalls.delete(id);
      const subagentId = call?.subagentId ?? reportedBy;
      const step: ResearchStep = {
        id: `rs-${Date.now()}-${stepIndex++}`,
        tool: call?.tool ?? 'agent_tool',
        toolLabel: call?.toolLabel,
        args: call?.args ?? '{}',
        result: truncate(output),
        success,
        outcome,
        toolCallId: id,
        subagentId,
        timestamp: new Date().toISOString(),
      };
      researchLog.push(step);
      onProgress({ type: 'tool_result', toolResult: output, step, toolCallId: id, subagentId });
    };

    await adapter.send(message, (event: AgentEvent) => {
      switch (event.type) {
        case 'assistant_text_delta':
          streamedRun += event.text;
          onProgress({ type: 'text_delta', text: event.text, segmentId });
          return;

        case 'assistant_text':
          text += event.text;
          if (streamedRun) streamedRun = '';
          else onProgress({ type: 'text_delta', text: event.text, segmentId });
          return;

        case 'thinking_delta':
          streamedThinking.add(event.subagentId ?? '');
          onProgress({ type: 'thinking', text: event.text, subagentId: event.subagentId });
          return;

        case 'thinking':
          if (!streamedThinking.delete(event.subagentId ?? '')) onProgress({ type: 'thinking', text: event.text, subagentId: event.subagentId });
          return;

        case 'tool_call': {
          // A subagent's call happens inside the planner's own pending call;
          // it does not end the planner's run of text.
          if (!event.subagentId) commitRun();
          const mapped = mapAgentTool(event.name);
          const args = JSON.stringify(normalizeAgentArgs(mapped.tool, event.args));
          const subagentId = event.subagentId;
          pendingCalls.set(event.id, { tool: mapped.tool, toolLabel: mapped.toolLabel, args, subagentId });
          onProgress({ type: 'tool_call', tool: mapped.tool, toolLabel: mapped.toolLabel, toolArgs: args, toolCallId: event.id, subagentId });
          return;
        }

        case 'tool_result':
          settle(event.id, event.output, event.success, event.success ? 'success' : 'failure', event.subagentId);
          return;

        case 'usage': {
          const { subagentId } = event.record;
          if (subagentId) subagentUsage.set(subagentId, addUsage(subagentUsage.get(subagentId) ?? {}, event.record));
          onProgress({ type: 'usage', record: event.record });
          return;
        }

        case 'subagent_started':
          if (this.subagents.started.has(event.subagentId)) return;
          this.subagents.started.add(event.subagentId);
          onProgress({ type: 'subagent_started', subagentId: event.subagentId, brief: event.brief, model: event.model });
          return;

        case 'subagent_finished':
          if (!this.subagents.started.has(event.subagentId) || this.subagents.finished.has(event.subagentId)) return;
          this.subagents.finished.add(event.subagentId);
          onProgress({
            type: 'subagent_finished', subagentId: event.subagentId, outcome: event.outcome, digest: event.digest,
            usage: subagentUsage.get(event.subagentId),
          });
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
    }, signal, () => onProgress({ type: 'liveness' }));

    commitRun();

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
    if (error || signal?.aborted) this.disposeAdapter();

    return { text, researchLog, error, aborted: signal?.aborted, backgroundAgents };
  }

  // --- Process lifecycle ---

  /**
   * The only way this service starts an agent, and it takes a planner start by
   * type: the read-only boundary (ADR-0008/0009) cannot be crossed into task
   * mode from here without changing this signature.
   */
  private async startAdapter(opts: PlannerStartOptions, tools: PlannerToolsOffer): Promise<AgentAdapter> {
    // A planner that cannot reach its tools cannot submit a plan, so it is
    // respawned once and never left to plan without them.
    const first = await this.startWithTools(opts, tools);
    if (typeof first !== 'string') return first;
    const second = await this.startWithTools(opts, tools);
    if (typeof second !== 'string') return second;
    throw new McpAttachError(`Could not start the ${this.runner} planner with Ordewell's tools. First spawn: ${first}. Respawn: ${second}.`);
  }

  private newAdapter(): AgentAdapter {
    const adapter = this.makeAdapter(this.runner, this.processDeps);
    if (!adapter) throw new Error(`No planner adapter is available for "${this.runner}".`);
    return adapter;
  }

  /** One spawn with the Ordewell server injected: the adapter once the runner reports it connected, otherwise why not, with nothing left running. */
  private async startWithTools(opts: PlannerStartOptions, tools: PlannerToolsOffer): Promise<AgentAdapter | string> {
    const server = this.mcpServer;
    if (!server) return 'no Ordewell MCP server was given';
    const adapter = this.newAdapter();
    if (!adapter.mcpAttached) {
      adapter.dispose();
      return `${this.runner} cannot be handed Ordewell's MCP server`;
    }
    let credential: McpCredential;
    try {
      credential = await server.issuePlannerToken({ sessionId: tools.sessionId }, tools.handler);
    } catch (err) {
      adapter.dispose();
      return `Ordewell's MCP server could not issue a token (${err instanceof Error ? err.message : String(err)})`;
    }
    try {
      await adapter.start({ ...opts, mcp: mcpClientConfig(credential) });
    } catch (err) {
      adapter.dispose();
      server.revoke(credential.token);
      throw err;
    }
    let failure = `${this.runner} did not report Ordewell's MCP server connected`;
    try {
      if (await adapter.mcpAttached()) {
        this.adapter = adapter;
        this.plannerToken = credential.token;
        return adapter;
      }
    } catch (err) {
      failure = `${this.runner} could not check Ordewell's MCP attach state (${err instanceof Error ? err.message : String(err)})`;
    }
    adapter.dispose();
    server.revoke(credential.token);
    return failure;
  }

  /** Kill the planner process, and with it the token it was spawned with. */
  private disposeAdapter(): void {
    this.adapter?.dispose();
    this.adapter = null;
    if (this.plannerToken) this.mcpServer?.revoke(this.plannerToken);
    this.plannerToken = null;
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
    await this.startAdapter({ ...conversation.startOptions, resumeSessionId: this.lastNativeSessionId ?? undefined }, conversation.tools);
    return this.adapter!;
  }

  private plannerModel(): string | undefined {
    const id = (this.config.orchestratorModel ?? '').trim();
    return id || undefined;
  }

  // --- One-shot paths (CLI `plan --goal`, web REST, plan modification) ---

  /**
   * A single agent session that answers one prompt and exits. Used by every
   * non-conversational entry point; the plan is parsed from the reply text by
   * the same extractor the conversational path uses. Its envelope streams to
   * the plan display, as a vendor planner's one-shot does, and the prose
   * around it is not streamed at all, since no turn is open to show it in.
   */
  private async oneShot(prompt: string, catalog: OneShotCatalog, onProgress?: (p: ResearchProgress) => void, signal?: AbortSignal): Promise<{ text: string; researchLog: ResearchLogEntry[] }> {
    const previous = this.adapter;
    const previousConversation = this.conversation;
    const previousSessionId = this.lastNativeSessionId;
    const previousToken = this.plannerToken;
    this.adapter = null;
    this.plannerToken = null;

    let submitted: string | undefined;
    const tools: PlannerToolsOffer = {
      sessionId: uuidv4(),
      handler: {
        listRunners: async () => ({ text: JSON.stringify({ runners: catalog.runners.map((id) => ({ id, modes: catalog.runnerModes?.[id] ?? [] })) }) }),
        listModels: async ({ runner }) => ({ text: JSON.stringify({ runner, models: catalog.modelsByRunner?.[runner] ?? [] }) }),
        submitPlan: async ({ tasks }) => {
          const result = validatePlanTasks({ tasks }, catalog.runners, catalog.runnerModes, catalog.autonomousDefault);
          if (!result.ok) return { text: result.errors.map((error) => error.message).join('\n'), isError: true };
          submitted = JSON.stringify({ tasks: result.tasks.map(plannerTaskView) });
          return { text: 'Plan recorded. End your turn now.' };
        },
      },
    };
    const toolPrompt = prompt
      .replace('produces structured task plans as JSON', 'submits structured task plans through submit_plan')
      .replace('Generate a task plan using this JSON format:', 'submit_plan takes a plan using this schema:')
      .replace('Return the COMPLETE modified plan as a JSON object with a single "tasks" array.', 'Call submit_plan with the COMPLETE modified plan in its "tasks" array.')
      .replaceAll('Do NOT wrap the JSON in markdown code blocks. Output ONLY the JSON object.', 'Submit the plan ONLY through submit_plan. Never write the plan as JSON in your reply.');
    const startOptions: PlannerStartOptions = {
      kind: 'planner',
      cwd: this.workspaceRoot(),
      systemPrompt: `${toolPrompt}\nBefore submitting, call list_runners and list_models to check the available assignments.`,
      model: this.plannerModel(),
      effort: this.config.plannerThinkingEffort,
    };
    let oneShotAdapter: AgentAdapter | null = null;
    try {
      oneShotAdapter = await this.startAdapter(startOptions, tools);
      this.conversation = {
        startOptions,
        tools,
        runners: catalog.runners,
      };
      const splitter = new ReplySplitter();
      const turn = await this.runTurn(
        'Follow the instructions in your system prompt and produce the plan now.',
        (p) => {
          if (p.type !== 'text_delta') return onProgress?.(p);
          const routed = p.segmentId && p.text ? splitter.push(p.segmentId, p.text) : null;
          if (routed?.route === 'plan') onProgress?.({ type: 'plan_token', planToken: routed.text, segmentId: p.segmentId });
        },
        signal,
      );
      if (turn.error) throw new Error(turn.error);
      return { text: submitted ?? turn.text, researchLog: turn.researchLog };
    } finally {
      // A one-shot never leaves a process behind, and never disturbs a
      // conversational session that happened to be open around it — including
      // when its own agent failed to start, which happens before there is
      // anything to dispose.
      oneShotAdapter?.dispose();
      if (this.plannerToken) this.mcpServer?.revoke(this.plannerToken);
      this.adapter = previous;
      this.plannerToken = previousToken;
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
        const result = await this.oneShot(repairHint ? `${prompt}\n\n${repairHint}` : prompt, { runners, modelsByRunner, runnerModes, autonomousDefault: modes.autonomousDefault }, onProgress, signal);
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
    runners: RunnerId[] = [...DEFAULT_RUNNERS],
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
          { runners, modelsByRunner, runnerModes, autonomousDefault: modes.autonomousDefault },
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
          const result = await this.oneShot(repairHint ? `${prompt}\n\n${repairHint}` : prompt, { runners: existingPlan.runners, modelsByRunner, runnerModes, autonomousDefault: modes.autonomousDefault }, onProgress, signal);
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
        const result = await this.oneShot(repairHint ? `${prompt}\n\n${repairHint}` : prompt, { runners, runnerModes, autonomousDefault });
        return result.text;
      },
      runners, 2, runnerModes, autonomousDefault,
    );
  }
}

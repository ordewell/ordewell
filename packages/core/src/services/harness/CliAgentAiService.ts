import { McpAttachError, McpAttachTimeout, spawnAttached } from './ordewellBinding';
import { spawn as nodeSpawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import {
  type Task,
  type DiscoveredModel,
  type ResearchLogEntry,
  type ResearchProgress,
  type ResearchStep,
  type RunnerId,
  DEFAULT_RUNNERS,
} from '../../models/Task';
import { addUsage, type RunnerSessionCost, type UsageTotals } from '../../models/Usage';
import type { IConfig } from '../../interfaces/IConfig';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { IWebFetcher } from '../../interfaces/IWebFetcher';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { readOnlyMode, type RunnerModeInfo } from '../ModeResolver';
import type { IAiService, ConversationRequest, ConversationTurn, PlannerToolsOffer, TurnRun } from '../AiService';
import {
  buildConversationSystemPrompt,
  buildPlanWithResults,
  NATIVE_SHELL_GUIDE,
} from '../PlanPrompts';
import { repairLoop, resubmitPlanPrompt } from '../PlanRepair';
import { PlanChangeCheck, planChangeErrorText, requestScope } from '../PlanChangeCheck';
import type { SkillLookup } from '../taskSkills';
import { PLANNER_TURN_ENDED } from '../plannerTools';
import { settleReply, type ReplyAttempt } from '../settleReply';
import { ReplySplitter } from '../replyStream';
import { redactSecrets } from '../../utils/redactSecrets';
import { abortScope } from '../../utils/abortScope';
import { providerForRunner, runnerForProvider } from '../ProviderRegistry';
import { recordRunnerAuth, signedOutFromFailure } from '../runnerAuth';
import { describePlannerNotReady, TERMINAL_UI_COMMANDS, type PlannerNotReady } from '../plannerReadiness';
import { workspaceEnvOf } from '../workspaceEnv';
import { augmentedPath, withPath } from '../../utils/shellPath';
import { BUILTIN_MANIFESTS } from '../../plugins/builtin';
import { collectResearchContext } from '../ContextCollector';
import { sensitiveEnvValues } from '../outboundSecrets';
import type { AgentAdapter, AgentEvent, AgentProcessDeps, PlannerStartOptions, UsageLimitSignal } from './AgentAdapter';
import { connectorFor, createPlannerAdapter } from './connectors';
import { mapAgentTool, normalizeAgentArgs } from './agentTools';
import { decidePlannerPermission, type PlannerPermissionGate } from './plannerPermissions';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from '../plannerModes';
import { mcpClientConfig, sharedMcpServer, type OrdewellMcpServer } from '../mcp';
import { instructionsBlock, repoRoot } from './repoConfig';
import { NOT_APPROVED, decideProjectServers, fileProjectServerApprovals, heldServersNote, recordUnusable, type ProjectServerApprovals } from './projectServers';
import { TurnReply } from './turnReply';
import { nativeShellOffer } from './nativeShell';
import type { IApproval } from '../../interfaces/IApproval';
import { withTurnBudgets, type TurnBudgets } from '../PlannerBudgets';

/**
 * How many times a turn that backgrounded a subagent may be asked to wait for
 * it. Bounded like the repair loop and for the same reason: an agent that keeps
 * deferring must cost a known number of turns, not an open-ended poll. Two,
 * because the first ask can arrive while the subagent is genuinely still
 * running, and one retry is what turns "not yet" into the report.
 */
const MAX_AGENT_WAITS = 2;

function waitForAgentsPrompt(running: number, then = 'Then give the user your synthesis.'): string {
  return [
    `You ended your turn with ${running} subagent(s) still running in the background.`,
    'Ordewell takes the turn back when it ends, so anything you say after it is never read —',
    'the results you were waiting for would be lost.',
    'Wait for those agents to finish NOW, in this reply, and do not end your turn until you have their results.',
    `${then} In future replies, await your agents inside the turn rather than backgrounding them.`,
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
  /** A person's approvals of project MCP servers, kept across sessions (ADR-0028). Defaults to Ordewell's data directory. */
  projectServerApprovals?: ProjectServerApprovals;
  /** What the planner is shown of its context and budgets at the start of each turn. */
  turnBudgets?: TurnBudgets;
}

interface OneShotCatalog {
  runners: RunnerId[];
  modelsByRunner?: Partial<Record<RunnerId, DiscoveredModel[]>>;
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault?: boolean;
  /** Where the plan's tasks look their skills up; a submission attaching a planner skill is refused. */
  taskSkills?: SkillLookup;
}

/** One one-shot agent session: the plan its accepted submit_plan call recorded, if any, and why its last refused one was refused. */
interface OneShot {
  tasks?: Task[];
  refused: string[];
  text: string;
  researchLog: ResearchLogEntry[];
}

/** One-shot sessions a plan may take: the first, and one corrective after it ends without an accepted submission. */
const ONE_SHOT_ATTEMPTS = 2;

/** One completed harness turn, before classification. */
interface HarnessTurn {
  text: string;
  /** The runs `text` joins, in the order they began. */
  runs: TurnRun[];
  researchLog: ResearchStep[];
  /** The agent's own failure, verbatim. Present means the turn did not complete. */
  error?: string;
  usageLimit?: UsageLimitSignal | false;
  aborted?: boolean;
  /** Subagents the agent left running when it ended the turn. See {@link MAX_AGENT_WAITS}. */
  backgroundAgents: number;
}

/** What a planner session is spawned with and decides its runner's requests against. */
interface PlannerSessionStart {
  startOptions: PlannerStartOptions;
  tools: PlannerToolsOffer;
  /** What the agent's own tool requests are decided against; absent, nobody can be asked, so only Ordewell's tools and the reads the envelope holds anyway are allowed (ADR-0026, ADR-0032). */
  gate?: PlannerPermissionGate;
}

/**
 * One planner session — a conversation or a one-shot: its process, the token
 * that process was spawned with, and what a respawn needs. The service drops
 * a session by identity, so a start that lands after its session was
 * discarded takes its own process back instead of reviving it.
 */
class PlannerSession {
  adapter: AgentAdapter | null = null;
  /** The planner token the running process was spawned with; revoked with the process (ADR-0022, A3). */
  token: string | null = null;
  /** The {@link PlannerStartOptions.nativeSearch} the running process was spawned with. */
  nativeSearch = false;
  /** The {@link PlannerStartOptions.nativeShell} the running process was spawned with. */
  nativeShell = false;
  /** The version the last process reported, kept across a restart for the native-shell check (ADR-0036 N2). */
  nativeShellVersion: string | null = null;
  /**
   * Where the native-shell setting's one warning goes (ADR-0036 N4). A
   * one-shot session has none: no surface is showing it.
   */
  notice?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** The setting's reason was already said this session; see {@link CliAgentAiService.noticeNativeShell}. */
  nativeShellNoticed = false;
  /**
   * The agent's own session id, kept across a process death so the next turn
   * can resume warm context instead of re-reading the repository. Never
   * outlives the session — nothing from one goal may reach the next.
   */
  nativeSessionId: string | null = null;
  /** What was counted of that session's running cost, so a resume counts on from it rather than dropping its first turn. */
  sessionCost: RunnerSessionCost | null = null;
  /** Set once the first spawn attached. */
  start: PlannerSessionStart | null = null;
  /**
   * What the runner's own session-wide search is decided against
   * (ADR-0027), asked again before every turn: the session's mode, its
   * exclusions or its budget can change between turns. Absent, it is off.
   */
  searchesUnasked: ((provider: string) => boolean) | undefined;
  /**
   * Every subagent this session has reported starting, and finishing.
   * Agents restate a subagent's state as it changes, and one can finish a turn
   * or a process restart after it started; surfaces get each once, in order.
   */
  readonly subagents = { started: new Set<string>(), finished: new Set<string>() };
  private readonly discarding = new AbortController();

  constructor(private readonly server: OrdewellMcpServer) {}

  /** Kill the planner process, and with it the token it was spawned with. The session can spawn another. */
  stop(): void {
    this.adapter?.dispose();
    this.adapter = null;
    if (this.token) this.server.revoke(this.token);
    this.token = null;
  }

  /** Aborted once the session is discarded; a spawn still in flight takes itself back then. */
  get discarded(): AbortSignal { return this.discarding.signal; }

  /** Stop the process for good. */
  discard(): void {
    this.discarding.abort();
    this.stop();
  }
}

/**
 * A coding agent driven as Ordewell's planner (ADR-0009).
 *
 * The second transport behind `IAiService`, sitting beside `OpenAiService` and
 * `GeminiService`. It deliberately does **not** extend {@link BaseAiService}:
 * that class's body is Ordewell executing research tools on a model's behalf,
 * which is precisely the part a coding agent replaces. What it reuses instead
 * is everything above the transport — `settleReply` (the empty-reply nudge
 * and the turn's settling), the plan validator, the `ResearchProgress` events the
 * three surfaces already render. That is why this backend reaches VS Code, the
 * CLI and the TUI without any of them learning a coding agent is
 * on the other end.
 */
export class CliAgentAiService implements IAiService {
  private readonly runner: string;
  private readonly processDeps: AgentProcessDeps;
  private readonly makeAdapter: (runner: string, deps: AgentProcessDeps) => AgentAdapter | null;
  private readonly workspaceRoot: () => string;
  private environmentSecrets: string[] = [];

  /** The conversation's session, from its start until the next session boundary. */
  private session: PlannerSession | null = null;
  private readonly mcpServer: OrdewellMcpServer;
  private readonly turnBudgets: TurnBudgets | undefined;
  private readonly projectServerApprovals: ProjectServerApprovals;
  private activeAbort: AbortController | null = null;
  /** See {@link compactions}. */
  private compacted = 0;

  constructor(private config: IConfig, deps: CliAgentAiServiceDeps = {}) {
    const runner = runnerForProvider(config.aiProvider);
    if (!runner) throw new Error(`${config.aiProvider} is not a coding-agent planner.`);
    this.runner = runner;
    const spawn = deps.spawn ?? nodeSpawn;
    this.processDeps = {
      spawn: (command, args, options) => {
        const child = spawn(command, args, options);
        this.environmentSecrets = sensitiveEnvValues(options.env);
        return child;
      },
      fetch: deps.fetch ?? globalThis.fetch,
      resolvePath: deps.resolvePath,
      platform: deps.platform,
      isDirectory: deps.isDirectory,
      exists: deps.exists,
      workspaceEnv: deps.workspaceEnv,
    };
    this.makeAdapter = deps.createAdapter ?? createPlannerAdapter;
    this.workspaceRoot = deps.workspaceRoot ?? (() => process.cwd());
    this.mcpServer = deps.mcpServer ?? sharedMcpServer();
    this.turnBudgets = deps.turnBudgets;
    this.projectServerApprovals = deps.projectServerApprovals ?? fileProjectServerApprovals();
  }

  hasActiveConversation(): boolean { return this.session?.start != null; }

  /**
   * False when the running agent process was spawned under a model/effort the
   * user has since changed in the picker. Unlike a vendor backend, the model
   * is a spawn-time argument to the agent CLI (`--model`), not a per-request
   * field — `continueConversation` sends the next turn to whatever process is
   * already running, so a plain config read here would silently keep planning
   * on the old model. No conversation yet is vacuously "current".
   */
  conversationMatchesConfig(): boolean {
    const start = this.session?.start;
    if (!start) return true;
    return start.startOptions.model === this.plannerModel()
      && start.startOptions.effort === this.config.plannerThinkingEffort;
  }

  /** Always: a conversation whose planner cannot reach the Ordewell MCP server fails to start rather than falling back to the envelopes. */
  plannerToolsAttached(): boolean { return true; }

  /** The agent's own session id, a resumption hint only — Ordewell's transcript is authoritative (T4). */
  nativeSessionId(): string | null { return this.session?.adapter?.nativeSessionId() ?? null; }

  /** The compactions the agents reported of their own context, never a subagent's or another thread's: their adapters drop those (ADR-0012 T10). */
  compactions(): number { return this.compacted; }

  promptCacheTtlMs(): number | undefined { return connectorFor(this.runner)?.promptCacheTtlMs; }

  heldSecrets(): readonly string[] { return this.environmentSecrets; }

  restart(): void {
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.session?.stop();
  }

  reset(): void {
    this.activeAbort?.abort();
    this.activeAbort = null;
    // Session boundaries are hard (ADR-0008): the next goal must not resume
    // the previous goal's agent session.
    this.session?.discard();
    this.session = null;
    this.environmentSecrets = [];
  }

  // --- Conversation (ADR-0002) ---

  async startConversation(req: ConversationRequest): Promise<ConversationTurn> {
    this.reset();
    if (!req.plannerTools) {
      throw new Error(`The ${this.runner} planner plans through Ordewell's MCP tools, and this session has no server to hand it.`);
    }
    const session = new PlannerSession(this.mcpServer);
    this.session = session;
    session.notice = req.notice;

    const contextStr = await collectResearchContext(req.fs, req.runners);
    const systemPrompt = buildConversationSystemPrompt(
      req.goal,
      contextStr,
      req.modelsByRunner,
      req.runners,
      req.runnerModes,
      { harness: true, runner: this.runner, isolatedExecution: req.isolatedExecution, skills: req.skills, execution: req.plannerTools !== undefined, autorun: req.autorun },
    );

    const fetcher = req.fetcher;
    const cwd = this.workspaceRoot();
    const startOptions: PlannerStartOptions = {
      kind: 'planner',
      cwd,
      ...await this.repoConfig(systemPrompt, cwd, req.approval),
      model: this.plannerModel(),
      effort: this.config.plannerThinkingEffort,
    };
    // Without an approval channel there is no gate, so nothing would decide a search.
    if (req.approval && fetcher?.searchesUnasked) session.searchesUnasked = (provider) => fetcher.searchesUnasked?.(provider) ?? false;
    const tools = req.plannerTools;
    try {
      const adapter = await this.startAdapter(startOptions, tools, session);
      recordUnusable(adapter.unusableProjectServers?.() ?? [], req.approval);
    } catch (err) {
      if (this.session === session) this.session = null;
      session.discard();
      throw err;
    }

    const gate = req.approval ? { approval: req.approval, fetcher: req.fetcher, workspaceRoot: startOptions.cwd } : undefined;
    session.start = { startOptions, tools, gate };

    // A reloaded session replays its transcript instead of re-running the
    // research the agent already paid for. The agent gets it as context, not
    // as turns: the reply we act on is the one the user's new message opens.
    const opening = this.openingMessage(req);
    return this.runConversation(session, opening, req.onProgress, req.signal);
  }

  async continueConversation(
    userMessage: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<ConversationTurn> {
    const session = this.session;
    if (!session?.start) throw new Error('No active planner conversation. Start planning first.');
    return this.runConversation(session, userMessage, onProgress, signal);
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
    session: PlannerSession,
    message: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<ConversationTurn> {
    this.activeAbort = abortScope(signal);
    const combined = this.activeAbort.signal;
    // Text from turns Ordewell continued past on the user's behalf. A wait is
    // not a new user message, so the reply they read is the whole answer.
    const carried: string[] = [];
    // Their runs, each handed to one attempt only: a discarded attempt's
    // narration stays with the reply already.
    const carriedRuns: TurnRun[] = [];

    const waits = { used: 0 };
    const send = async (text: string): Promise<ReplyAttempt> => {
      const { turn, researchLog } = await this.runTurnAwaitingAgents(session, text, onProgress, combined, waits, (past) => {
        carried.push(past.text);
        // The wait that follows is a call the turn made after them.
        carriedRuns.push(...past.runs.map((run): TurnRun => ({ ...run, narration: true })));
      });
      return {
        text: turn.text,
        runs: [...carriedRuns.splice(0), ...turn.runs],
        researchLog,
        aborted: turn.aborted || combined?.aborted,
        // Fail visibly, per the repo's fail-safe contract: an agent that died,
        // hit its rate limit, or lost its login must say so in the chat rather
        // than leave an empty planner bubble.
        failure: turn.error,
        usageLimit: turn.usageLimit,
        fullText: [...carried, turn.text].filter((part) => part.trim()).join('\n\n'),
      };
    };

    try {
      // No `classify`: this planner plans only through Ordewell's tools
      // (ADR-0025), so its reply is prose whatever JSON it shows, and a plan
      // or edit lands only from a tool call the conversation committed.
      const turn = await settleReply({
        // The turn's own input carries the budgets, not the system prompt, which stays cacheable.
        message: withTurnBudgets(this.turnBudgets, message),
        send,
        onProgress,
        signal: combined,
      });
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
  /**
   * A turn, and then — while the agent ended it with subagents still in the
   * background — a turn asking it to wait for them: whatever they find would
   * otherwise be said into a closed turn, or, in a one-shot, into a session
   * already thrown away. Bounded by `waits`, shared across a reply's sends.
   */
  private async runTurnAwaitingAgents(
    session: PlannerSession,
    message: string,
    onProgress: (progress: ResearchProgress) => void,
    signal: AbortSignal | undefined,
    waits: { used: number },
    onWaitedPast?: (turn: HarnessTurn) => void,
    then?: string,
  ): Promise<{ turn: HarnessTurn; researchLog: ResearchLogEntry[] }> {
    let turn = await this.runTurn(session, message, onProgress, signal);
    const researchLog: ResearchLogEntry[] = [...turn.researchLog];
    while (turn.backgroundAgents > 0 && waits.used < MAX_AGENT_WAITS && turn.text.trim() && !turn.error && !turn.aborted && !signal?.aborted) {
      waits.used++;
      onWaitedPast?.(turn);
      turn = await this.runTurn(session, waitForAgentsPrompt(turn.backgroundAgents, then), onProgress, signal);
      researchLog.push(...turn.researchLog);
    }
    return { turn, researchLog };
  }

  private async runTurn(
    session: PlannerSession,
    message: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<HarnessTurn> {
    const adapter = await this.ensureAdapter(session);
    // `at` is when the model announced the call, and `slot` is where that call
    // stands in the log: a reloaded transcript places each row where the live
    // view drew it, however the results come back.
    const pendingCalls = new Map<string, { tool: ResearchStep['tool']; toolLabel?: string; args: string; subagentId?: string; at: string; slot: number }>();
    const logSlots: (ResearchStep | null)[] = [];
    const reply = new TurnReply(onProgress);
    // Who streamed thinking deltas (the planner as '', or a subagent) since
    // their last complete `thinking`, which then repeats what was already sent.
    const streamedThinking = new Set<string>();
    // Calls whose permission request the envelope denied: their failed result is a denial, not a failure.
    const deniedCalls = new Set<string>();
    const gate: PlannerPermissionGate = {
      workspaceRoot: session.start?.startOptions.cwd ?? this.workspaceRoot(),
      ...session.start?.gate,
      savedOutput: (abs) => adapter.savedOutput?.(abs) ?? false,
    };
    const subagentUsage = new Map<string, UsageTotals>();
    let error: string | undefined;
    let usageLimit: UsageLimitSignal | false | undefined;
    let stepIndex = 0;
    let backgroundAgents = 0;

    const truncate = (value: string) =>
      value.length > LOG_MAX_CHARS ? `${value.slice(0, LOG_MAX_CHARS)}\n[... truncated, total ${value.length} chars]` : value;

    /** The log the turn leaves behind, in the order the calls were announced. */
    const settledLog = () => logSlots.filter((s): s is ResearchStep => s !== null);

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
        timestamp: call?.at ?? new Date().toISOString(),
      };
      // A call takes the log slot it was announced in; one settled without an
      // announcement — a permission request denied before its call — follows.
      if (call) logSlots[call.slot] = step;
      else logSlots.push(step);
      onProgress({ type: 'tool_result', toolResult: output, step, toolCallId: id, subagentId });
    };

    const sent = adapter.send(message, (event: AgentEvent) => {
      switch (event.type) {
        case 'assistant_text_delta':
          reply.delta(event.runId, event.text);
          return;

        case 'assistant_text':
          reply.complete(event.runId, event.text);
          return;

        case 'thinking_delta':
          streamedThinking.add(event.subagentId ?? '');
          onProgress({ type: 'thinking', text: event.text, subagentId: event.subagentId });
          return;

        case 'thinking':
          if (!streamedThinking.delete(event.subagentId ?? '')) onProgress({ type: 'thinking', text: event.text, subagentId: event.subagentId });
          return;

        case 'tool_call': {
          if (!event.subagentId) reply.toolCall();
          const mapped = mapAgentTool(event.name);
          const args = JSON.stringify(normalizeAgentArgs(mapped.tool, event.args));
          const subagentId = event.subagentId;
          pendingCalls.set(event.id, { tool: mapped.tool, toolLabel: mapped.toolLabel, args, subagentId, at: new Date().toISOString(), slot: logSlots.push(null) - 1 });
          onProgress({ type: 'tool_call', tool: mapped.tool, toolLabel: mapped.toolLabel, toolArgs: args, toolCallId: event.id, subagentId });
          return;
        }

        case 'tool_result':
          settle(event.id, event.output, event.success, event.success ? 'success' : deniedCalls.has(event.id) ? 'denied' : 'failure', event.subagentId);
          return;

        case 'usage': {
          const { subagentId } = event.record;
          if (subagentId) subagentUsage.set(subagentId, addUsage(subagentUsage.get(subagentId) ?? {}, event.record));
          onProgress({ type: 'usage', record: event.record });
          return;
        }

        case 'subagent_started':
          if (session.subagents.started.has(event.subagentId)) return;
          session.subagents.started.add(event.subagentId);
          onProgress({ type: 'subagent_started', subagentId: event.subagentId, brief: event.brief, model: event.model });
          return;

        case 'subagent_finished':
          if (!session.subagents.started.has(event.subagentId) || session.subagents.finished.has(event.subagentId)) return;
          session.subagents.finished.add(event.subagentId);
          onProgress({
            type: 'subagent_finished', subagentId: event.subagentId, outcome: event.outcome, digest: event.digest,
            usage: subagentUsage.get(event.subagentId),
          });
          return;

        case 'background_agent':
          backgroundAgents++;
          return;

        // Adapters drop a subagent's or another thread's, so this is the
        // planner's own. Native compaction reports only that it is done, and
        // its sizes when it gives them: nothing here invents a start (ADR-0017).
        case 'compaction': {
          this.compacted++;
          const { trigger, preTokens, postTokens } = event;
          onProgress({
            type: 'compaction',
            compaction: {
              phase: 'ended', id: uuidv4(), origin: 'native', trigger, outcome: 'condensed', at: new Date().toISOString(),
              ...(preTokens !== undefined ? { preTokens } : {}),
              ...(postTokens !== undefined ? { postTokens } : {}),
            },
          });
          return;
        }

        case 'permission_request': {
          // Announced so the user can see the planner reached for something it
          // may not have — a silently swallowed denial reads as the agent losing interest.
          const announceDenial = (output: string) => {
            const mapped = mapAgentTool(event.name);
            const args = JSON.stringify({ detail: event.detail });
            if (!pendingCalls.has(event.id)) {
              pendingCalls.set(event.id, { tool: mapped.tool, toolLabel: mapped.toolLabel, args, at: new Date().toISOString(), slot: logSlots.push(null) - 1 });
              onProgress({ type: 'tool_call', tool: mapped.tool, toolLabel: mapped.toolLabel, toolArgs: args, toolCallId: event.id });
            }
            settle(event.id, output, false, 'denied');
          };
          if (!event.decided && adapter.answerPermission) {
            // Open: the envelope decides it, asking the user where the API
            // planner would (ADR-0026). A call the runner linked settles from
            // its own result; one it did not is shown denied here.
            const { id, toolUseId } = event;
            void decidePlannerPermission(event.ask, event.input ?? {}, gate)
              .catch((): ApprovalDecision => ({ decision: 'deny' }))
              .then((decision) => {
                if (decision.decision === 'deny') {
                  if (toolUseId) deniedCalls.add(toolUseId);
                  else announceDenial(`Access denied: "${event.name}" was refused. ${decision.note ?? ''}`.trim());
                }
                return adapter.answerPermission?.(id, decision);
              })
              // A runner that cannot take its answer has lost its process, and its turn ends on that error.
              .catch(() => {});
            return;
          }
          if (event.decided?.decision !== 'deny') return;
          announceDenial(`Access denied: the planner runs read-only, so "${event.name}" was refused. Mutation belongs to the runners that execute the plan.`);
          return;
        }

        case 'error':
          error = event.message;
          usageLimit = event.usageLimit;
          return;

        case 'turn_end':
          return;
      }
    }, signal, () => onProgress({ type: 'liveness' }));
    try {
      await sent;
    } catch (err) {
      session.stop();
      throw err;
    }
    // A failed or stopped turn may have ended before the harness named its
    // version; the next one can still say why the setting is not offered.
    session.nativeShellVersion = adapter.version?.() ?? session.nativeShellVersion;
    if (!error && !signal?.aborted) this.noticeNativeShell(session, adapter);

    // Anything still pending when the turn ended never produced a result —
    // report it rather than leaving a spinner running in every surface.
    for (const id of [...pendingCalls.keys()]) {
      settle(id, 'The agent ended the turn without reporting this call\'s result.', false, 'not_executed');
    }

    session.nativeSessionId = adapter.nativeSessionId() ?? session.nativeSessionId;
    session.sessionCost = adapter.sessionCost?.() ?? session.sessionCost;
    // A failed turn usually means the process is gone, and an aborted one kills
    // the process by contract. Either way the adapter cannot be sent to again —
    // `dispose()` is terminal — so drop it and let the next turn restart from
    // the session id rather than throwing into a dead stdin.
    if (error || signal?.aborted) session.stop();

    if (error) {
      const failure = await this.explainSignedOut(reply.fail(error));
      return { text: reply.text, runs: reply.runs(), researchLog: settledLog(), error: failure, usageLimit, aborted: signal?.aborted, backgroundAgents };
    }
    return { text: reply.text, runs: reply.runs(), researchLog: settledLog(), error, aborted: signal?.aborted, backgroundAgents };
  }

  /**
   * A turn that failed because the runner's own account is signed out is
   * recorded for the synchronous planner gate, and the failure opens with the
   * same two ways back in the gate would give (ADR-0009). Only a phrase the
   * runner's manifest declares; any other failure is returned untouched.
   *
   * Judged with the workspace's own environment, the same merged env the
   * probe and the planner spawn use (ADR-0016): a custom provider's
   * `CODEX_HOME`/`HOME` lives there, so the reader that knows the runner's
   * "Not logged in" line is not this user's answer sees it.
   */
  private async explainSignedOut(failure: string): Promise<string> {
    const manifest = BUILTIN_MANIFESTS.find((candidate) => candidate.name === this.runner);
    if (!manifest) return failure;
    let env: NodeJS.ProcessEnv;
    try {
      const workspace = await (this.processDeps.workspaceEnv ?? workspaceEnvOf)(this.workspaceRoot());
      env = withPath(process.env, await augmentedPath(), workspace);
    } catch {
      // The runner's config could not be read; its words stand as they are.
      return failure;
    }
    const auth = signedOutFromFailure(manifest, failure, env);
    if (!auth) return failure;
    recordRunnerAuth(this.runner, auth, this.workspaceRoot());
    const reason: PlannerNotReady = {
      code: 'signed_out',
      provider: providerForRunner(this.runner) ?? this.config.aiProvider,
      label: manifest.displayName,
      runner: this.runner,
      loginCommand: auth.loginCommand,
    };
    const guidance = describePlannerNotReady(reason, TERMINAL_UI_COMMANDS);
    return failure.startsWith(guidance) ? failure : `${guidance}\n\n${failure}`;
  }

  // --- Process lifecycle ---

  /**
   * The only way this service starts an agent, and it takes a planner start by
   * type: the read-only boundary (ADR-0008/0009) cannot be crossed into task
   * mode from here without changing this signature. A planner that cannot
   * reach its tools cannot submit a plan, so it is respawned once and never
   * left to plan without them (ADR-0025).
   */
  private async startAdapter(opts: PlannerStartOptions, tools: PlannerToolsOffer, session: PlannerSession): Promise<AgentAdapter> {
    const server = this.mcpServer;
    // Decided once, here, so the token's tools and the session's config are the same decision.
    const nativeShell = this.nativeShellOffered(session);
    const start: PlannerStartOptions = {
      ...opts,
      nativeSearch: this.nativeSearch(session),
      nativeShell,
      systemPrompt: nativeShell ? `${opts.systemPrompt}\n\n${NATIVE_SHELL_GUIDE}` : opts.systemPrompt,
    };
    // A planner that exits before it answers the attach check refused what it was started with, so its words are the failure and no respawn repeats it.
    let startupExit: string | null = null;
    let starting: AgentAdapter | null = null;
    const spawned = await spawnAttached({
      runner: this.runner,
      create: () => this.newAdapter(),
      issueToken: () => server.issuePlannerToken({ sessionId: tools.sessionId, hidden: connectorFor(this.runner)?.ordewellTools.plannerHidden(start) }, tools.handler),
      revoke: (token) => server.revoke(token),
      start: async (adapter, credential) => {
        starting = adapter;
        startupExit = null;
        await adapter.start({ ...start, mcp: mcpClientConfig(credential) });
        adapter.onProcessExit?.((code, lastWords) => {
          if (adapter === starting) startupExit ??= lastWords ?? `${this.runner} exited with code ${code}`;
        });
      },
      startupExit: () => startupExit,
      cancelled: session.discarded,
      failed: (first, second) => `Could not start the ${this.runner} planner with Ordewell's tools. First spawn: ${first}. Respawn: ${second}.`,
    });
    if (!spawned) throw new Error(`The ${this.runner} planner session ended before its agent started.`);
    session.adapter = spawned.adapter;
    session.token = spawned.token;
    session.nativeSearch = start.nativeSearch ?? false;
    session.nativeShell = start.nativeShell ?? false;
    // A harness that reports its version as it connects (OpenCode 2.x) has it
    // before the first turn; Claude Code names it on `init`, inside one.
    session.nativeShellVersion = spawned.adapter.version?.() ?? session.nativeShellVersion;
    return spawned.adapter;
  }

  private newAdapter(): AgentAdapter {
    const adapter = this.makeAdapter(this.runner, this.processDeps);
    if (!adapter) throw new Error(`No planner adapter is available for "${this.runner}".`);
    return adapter;
  }

  /** Whether the web-read policy lets the runner's own session-wide search run unasked now (ADR-0027). */
  private nativeSearch(session: PlannerSession): boolean {
    const provider = connectorFor(this.runner)?.ordewellTools.sessionSearchProvider;
    return provider !== undefined && (session.searchesUnasked?.(provider) ?? false);
  }

  /**
   * Whether this planner process may be given its harness's own shell
   * (ADR-0036 N1, N2): the setting is on, and the version the last process
   * reported is one N2's live checks cover (N5). A version not known yet is
   * not offered, so the first process keeps `run_command` alone; once a turn
   * has named one, the next process gets the shell.
   */
  private nativeShellOffered(session: PlannerSession): boolean {
    if (!this.config.plannerNativeShell) return false;
    return nativeShellOffer({
      runner: this.runner,
      version: session.nativeShellVersion,
      platform: this.processDeps.platform ?? process.platform,
    }).offered;
  }

  /**
   * The setting's one warning per session when this harness's own shell is not
   * offered, and why (ADR-0036 N2, N4). Read after a turn: Claude Code names its
   * version on `init`, inside the turn, and a check before it would say the
   * wrong thing. A harness that never names one is not offered the opt-in
   * either; its notice says so.
   */
  private noticeNativeShell(session: PlannerSession, adapter: AgentAdapter): void {
    if (!this.config.plannerNativeShell || session.nativeShellNoticed) return;
    // Codex already has its own shell (N1), so the setting changes nothing and
    // there is no loss to explain.
    if (this.runner === 'codex') return;
    const version = adapter.version?.() ?? null;
    const offer = nativeShellOffer({ runner: this.runner, version, platform: this.processDeps.platform ?? process.platform });
    if (offer.offered) return;
    session.nativeShellNoticed = true;
    session.notice?.('warn', `The native-shell setting is on, but this planner keeps run_command alone: ${offer.reason}`);
  }

  /**
   * The live agent process, restarted from its own session id if it died
   * between turns. Resume is a hint: when it fails, the caller's next
   * `startConversation` reseeds from Ordewell's transcript, which is the same
   * degradation `restoreChat` already performs on every surface.
   *
   * A process can end while idle without Ordewell stopping it — the OS, the
   * CLI itself, a sleeping machine, a signal sent to its group — and every
   * path of ours that kills one also drops its adapter. So an adapter still
   * held whose process has ended died on its own, and is restarted here
   * rather than answering the next message with its exit code.
   *
   * Also restarted when the policy's decision on the runner's own search has
   * changed since the process was spawned: the running thread would otherwise
   * keep searching unasked after Full turned Guarded. Codex 0.162 applies
   * `thread/resume`'s `config.web_search` either way (checked live). The
   * native-shell setting is the same kind of spawn-time decision (ADR-0036
   * N1), so a change reopens the process too.
   *
   * Also restarted when it no longer reaches Ordewell's tools (ADR-0025). The
   * attach check was the spawn's, but the link is the process's for its whole
   * life: an idle rebuild, a revoked token or an MCP client that gave up can
   * leave a live process planning without `edit_plan`, `list_runners` or any
   * other tool, and nothing else looks again. A lost link is taken back and
   * respawned with a fresh token, resuming the conversation, so the turn is
   * never sent to tools that are gone.
   */
  private async ensureAdapter(session: PlannerSession): Promise<AgentAdapter> {
    const live = session.adapter;
    if (live && !live.exited && session.nativeSearch === this.nativeSearch(session) && session.nativeShell === this.nativeShellOffered(session)) {
      // A Stop during the check takes the process back; it must not be handed
      // to the turn it was stopped for.
      if (await this.stillAttached(live) && session.adapter === live && !live.exited) return live;
    }
    session.stop();
    const start = session.start;
    if (!start) throw new Error('No active planner conversation.');
    const resumeSessionId = session.nativeSessionId ?? undefined;
    try {
      const adapter = await this.startAdapter({ ...start.startOptions, resumeSessionId, resumeCost: session.sessionCost ?? undefined }, start.tools, session);
      const resumed = adapter.nativeSessionId();
      // Codex and OpenCode may accept a missing resume by starting fresh. That
      // context has no transcript: let the conversation reopen it as after a
      // refused resume, before sending the user's message (ADR-0009, T4).
      if (resumeSessionId && resumed && resumed !== resumeSessionId) {
        throw new Error('The runner started a different session instead.');
      }
      return adapter;
    } catch (err) {
      // A failed attach is not a failed resume: the runner refused Ordewell's
      // server, and its own two-attempt message is the one to show. The
      // conversation stays, so the next message tries a fresh process rather
      // than replaying the whole transcript over a server that may be back.
      if (err instanceof McpAttachError || err instanceof McpAttachTimeout) throw err;
      if (!resumeSessionId || session.discarded.aborted) throw err;
      // Kept, the conversation would ask for the same refused session on
      // every message. Dropped, the next one replays the transcript into a
      // fresh context (T4), as after a reload.
      if (this.session === session) this.session = null;
      session.discard();
      throw new Error(`The ${this.runner} planner's session could not be resumed (${err instanceof Error ? err.message : String(err)}). Send your message again: the planner picks the conversation up from its transcript.`);
    }
  }

  /**
   * Whether a live planner still offers Ordewell's tools, as its runner
   * reports it (ADR-0022, S4). A report that could not be read counts as lost:
   * a respawn is cheap next to a turn planned against tools that are gone.
   * Absent only on an adapter the spawn path already refused.
   */
  private async stillAttached(adapter: AgentAdapter): Promise<boolean> {
    if (!adapter.mcpAttached) return true;
    try {
      const report = await adapter.mcpAttached();
      return report === true || report === 'connected';
    } catch {
      return false;
    }
  }

  /**
   * What the planner gets of the repository's config, its runner being
   * launched without it (ADR-0028): the instruction files, which are text, in
   * its system prompt, and the project MCP servers it may start. Decided once
   * per conversation, so a respawn starts the same servers without asking.
   */
  private async repoConfig(systemPrompt: string, cwd: string, approval: IApproval | undefined): Promise<Pick<PlannerStartOptions, 'systemPrompt' | 'projectServers'>> {
    const reader = connectorFor(this.runner)?.repoConfig;
    if (!reader) return { systemPrompt };
    const found = reader.projectServers(cwd);
    const { started, held } = await decideProjectServers(found.servers, { repoRoot: repoRoot(cwd), approval, approvals: this.projectServerApprovals });
    return {
      systemPrompt: [systemPrompt, instructionsBlock(reader.instructions(cwd)), heldServersNote(held.map((server) => ({ server, reason: NOT_APPROVED })), found.unreadable)].filter(Boolean).join('\n\n'),
      ...(started.length > 0 ? { projectServers: started } : {}),
    };
  }

  private plannerModel(): string | undefined {
    const id = (this.config.orchestratorModel ?? '').trim();
    return id || undefined;
  }

  // --- One-shot paths (CLI `plan --goal`, web REST, plan modification) ---

  /**
   * A plan from one-shot agent sessions: only what a submit_plan call
   * accepted, never the reply text, so a plan the tool refused cannot come
   * back in as the JSON the agent echoed. A session that ends without an
   * accepted call is followed by one corrective session, then fails.
   */
  private async submittedPlan(prompt: string, catalog: OneShotCatalog, onProgress?: (p: ResearchProgress) => void, signal?: AbortSignal): Promise<{ tasks: Task[]; text: string; researchLog: ResearchLogEntry[] }> {
    const researchLog: ResearchLogEntry[] = [];
    return repairLoop<OneShot, { tasks: Task[]; text: string; researchLog: ResearchLogEntry[] }>({
      first: () => this.oneShot(prompt, catalog, onProgress, signal),
      resend: (corrective) => this.oneShot(`${prompt}\n\n${corrective}`, catalog, onProgress, signal),
      interpret: (shot) => {
        researchLog.push(...shot.researchLog);
        if (signal?.aborted) throw new Error('Plan generation was stopped.');
        if (shot.tasks) return { done: { tasks: shot.tasks, text: shot.text, researchLog } };
        const errors = shot.refused.length > 0 ? shot.refused : ['the agent ended its turn without calling submit_plan'];
        return { retry: { errors, corrective: resubmitPlanPrompt(errors) } };
      },
      maxRepairs: ONE_SHOT_ATTEMPTS - 1,
      onExhausted: ({ errors }) => {
        throw new Error(`The ${this.runner} planner produced no plan: no submit_plan call was accepted (${errors.join('; ')}).`);
      },
    });
  }

  /**
   * A single agent session that answers one prompt and exits. Used by every
   * non-conversational entry point. A plan-shaped envelope in its text
   * streams to the plan display, as a vendor planner's one-shot does, and the
   * prose around it is not streamed at all, since no turn is open to show it in.
   */
  private async oneShot(prompt: string, catalog: OneShotCatalog, onProgress?: (p: ResearchProgress) => void, signal?: AbortSignal): Promise<OneShot> {
    let submitted: Task[] | undefined;
    let refused: string[] = [];
    // A call still waiting on the skill check when the session ends must not record a plan nobody reads.
    let ended = false;
    const refuse = (errors: string[]) => {
      refused = errors;
      return { text: errors.join('\n'), isError: true };
    };
    const tools: PlannerToolsOffer = {
      sessionId: uuidv4(),
      handler: {
        listRunners: async () => ({ text: JSON.stringify({ runners: catalog.runners.map((id) => ({ id, readOnly: readOnlyMode(catalog.runnerModes?.[id]) !== undefined })) }) }),
        listModels: async ({ runner }) => ({ text: JSON.stringify({ runner, models: catalog.modelsByRunner?.[runner] ?? [] }) }),
        submitPlan: async ({ tasks }) => {
          const checked = await new PlanChangeCheck(requestScope(catalog)).check({ kind: 'plan', tasks }, 'submit');
          if (ended || signal?.aborted) return { text: PLANNER_TURN_ENDED, isError: true };
          if (!checked.ok) return refuse(checked.errors.map(planChangeErrorText));
          submitted = checked.tasks;
          refused = [];
          return {
            text: JSON.stringify({
              ok: true,
              ...(checked.warnings.length > 0 ? { warnings: checked.warnings } : {}),
              next: 'Plan recorded. End your turn now.',
            }),
          };
        },
      },
    };
    const cwd = this.workspaceRoot();
    const startOptions: PlannerStartOptions = {
      kind: 'planner',
      cwd,
      // No approval channel here: only servers a person approved before start.
      ...await this.repoConfig(`${prompt}\nBefore submitting, call list_runners and list_models to check the available assignments.`, cwd, undefined),
      model: this.plannerModel(),
      effort: this.config.plannerThinkingEffort,
    };
    // Its own session, never the conversation's: a one-shot leaves no process
    // behind, and its agent session must not become the conversation's resume
    // hint — restarting the chat into a plan-generation session would cross
    // two sessions that never shared a goal.
    const session = new PlannerSession(this.mcpServer);
    try {
      await this.startAdapter(startOptions, tools, session);
      session.start = { startOptions, tools };
      const splitter = new ReplySplitter();
      const { turn, researchLog } = await this.runTurnAwaitingAgents(
        session,
        'Follow the instructions in your system prompt and produce the plan now.',
        (p) => {
          if (p.type !== 'text_delta') return onProgress?.(p);
          const routed = p.segmentId && p.text ? splitter.push(p.segmentId, p.text) : null;
          if (routed?.route === 'plan') onProgress?.({ type: 'plan_token', planToken: routed.text, segmentId: p.segmentId });
        },
        signal,
        { used: 0 },
        undefined,
        'Then submit the plan with submit_plan.',
      );
      if (turn.error) throw new Error(turn.error);
      return { tasks: submitted, refused, text: turn.text, researchLog };
    } finally {
      ended = true;
      session.discard();
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
    const prompt = buildPlanWithResults(userDescription, contextStr, '', modelsByRunner, runners, runnerModes, modes, true);
    const plan = await this.submittedPlan(prompt, oneShotCatalog(runners, modelsByRunner, runnerModes, modes), onProgress, signal);
    return {
      tasks: plan.tasks,
      researchLog: [{ id: `up-${Date.now()}`, type: 'user_prompt', content: userDescription, timestamp: new Date().toISOString() }, ...plan.researchLog],
      researchResults: plan.text,
    };
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
    const prompt = buildPlanWithResults(userDescription, '', '', modelsByRunner, runners, runnerModes, modes, true);
    const plan = await this.submittedPlan(
      prompt,
      oneShotCatalog(runners, modelsByRunner, runnerModes, modes),
      (p) => { if (p.type === 'plan_token' && p.planToken) onToken?.(p.planToken); },
      signal,
    );
    return plan.tasks;
  }
}

function oneShotCatalog(
  runners: RunnerId[],
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
  runnerModes: Record<RunnerId, RunnerModeInfo[]> | undefined,
  modes: PlannerModes,
): OneShotCatalog {
  return { runners, modelsByRunner, runnerModes, autonomousDefault: modes.autonomousDefault, taskSkills: modes.taskSkills };
}

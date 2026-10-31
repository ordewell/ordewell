import { Task, ConversationMessage, DiscoveredModel, ReplyRun, ResearchLogEntry, ResearchProgress, RunnerId } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import type { IApproval } from '../interfaces/IApproval';
import type { RunnerModeInfo } from './ModeResolver';
import type { PlanIntake } from './PlanChangeCheck';
import type { PlannerContextStatus } from './plannerContextBudget';
import { GeminiService } from './GeminiService';
import { OpenAiService } from './OpenAiService';
import { isCliProvider } from './ProviderRegistry';
import { CliAgentAiService, type CliAgentAiServiceDeps } from './harness/CliAgentAiService';
import type { IsolatedExecution, PlannerModes } from './plannerModes';
import type { PlannerToolHandler } from './mcp';
import type { SkillInfo } from './SkillsService';
import type { UsageLimitSignal } from './harness/AgentAdapter';
import type { PlannerContextDeps } from './plannerContextBudget';
import type { ConversationCompactionHost } from './budgetedChat';

/**
 * The planner tools a session offers its conversation (ADR-0022). A backend
 * that can inject the Ordewell MCP server into its planner issues a planner
 * token bound to `sessionId` and these handlers; API planners use the same task read handlers directly in their tool loop.
 */
export interface PlannerToolsOffer {
  sessionId: string;
  handler: PlannerToolHandler;
}

/**
 * Everything the conversation loop needs to start planning (ADR-0002).
 * The AI service keeps the tool-use message history internally across turns;
 * the surfaces only exchange user/assistant messages with it.
 */
export interface ConversationRequest {
  goal: string;
  runners: RunnerId[];
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>;
  fs: IFileSystem;
  onProgress: (progress: ResearchProgress) => void;
  fetcher?: IWebFetcher;
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  /**
   * What a whole plan is held to now (`PlanChangeCheck.intake`), read on every
   * turn: an envelope plan is checked against what `submit_plan` checks one
   * against (ADR-0022 L2, P2). Absent: `runners`, `runnerModes` and
   * `autonomousDefault` as the conversation opened.
   */
  liveScope?: () => PlanIntake;
  autonomousDefault?: boolean;
  /** Where tasks will run (ADR-0013, ADR-0014): in worktrees, the prompt drops file-overlap ordering and describes a repo group. */
  isolatedExecution?: IsolatedExecution;
  /** A plan the planner submits starts at once (ADR-0030), so the opening prompt has no outline gate. */
  autorun?: boolean;
  signal?: AbortSignal;
  /**
   * Persisted dialogue to seed a resumed conversation (session reload). The
   * turns are injected into the message history verbatim — no LLM call happens
   * for them; the first call is the turn opened by `initialMessage`.
   */
  priorHistory?: ConversationMessage[];
  /**
   * The user message that opens this turn. Defaults to `goal` — set it when
   * resuming so the system prompt keeps the original goal while the turn
   * carries the user's new message.
   */
  initialMessage?: string;
  plannerTools?: PlannerToolsOffer;
  /**
   * The session's notice channel, for a warning the planner's surface should
   * show once (ADR-0036 N4: the native-shell setting is on but the harness is
   * not offered it). Absent: nowhere to show one, so none is raised.
   */
  notice?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * The session's approval policy, which a harness planner's own tool
   * requests are decided against as the API planner's are (ADR-0026). Absent:
   * nobody can be asked, so they are denied.
   */
  approval?: IApproval;
  /**
   * The workspace's skill catalog. Every planner is shown the task skills it
   * may attach; only one with tools is shown the planner skills, which load
   * through `load_skill` alone (ADR-0024).
   */
  skills?: readonly SkillInfo[];
  /**
   * The conversation an API planner may condense its context through during a
   * turn (ADR-0002): where its turn's messages begin, what landed before them,
   * and the checkpoint a summary of that becomes. A harness planner's agent
   * compacts its own context, and ignores it.
   */
  compaction?: ConversationCompactionHost;
}

/** What `/compact` asks of a planner that condenses its context itself. */
export interface ContextCondenseRequest {
  /** The model context to condense; absent: the live context the backend holds. */
  replay?: ConversationMessage[];
  /** The current plan's lines, which the summary is told outrank its own account of task state. */
  planLines: readonly string[] | null;
  /** Liveness and spend: each summary call's usage, which measures nothing of the planner's context. */
  onProgress: (progress: ResearchProgress) => void;
  signal?: AbortSignal;
}

/**
 * A run of a turn's reply text, as a backend reports it. `narration`: it began
 * before its call's last tool call, so it stays when a corrective retry
 * discards what the call replied.
 */
export interface TurnRun extends ReplyRun {
  narration?: true;
}

/**
 * One planner turn's outcome. The planner talks to the user (`message`),
 * commits a full plan (`plan`, a `{tasks:[...]}` JSON object), emits targeted
 * task edits (`task_ops`, a `{taskOps:[...]}` JSON object), or asks to read
 * task bodies and the full catalog before editing (`task_query`, a
 * `{taskQuery:{...}}` JSON object). The Session validates and applies task ops
 * atomically and answers queries out of its own state; the AI service only
 * parses them.
 */
export type ConversationTurn =
  /**
   * `aborted`: the call was stopped, and `text` is only what it had by then.
   * `failed`: the call ended without a reply (a dead agent, a usage limit),
   * and `text` says why; `usageLimit`, where the runner also said in a field
   * whether that was its usage limit (see {@link TurnFailure}).
   * `runs`, on every kind: the reply's runs the turn's surviving calls
   * streamed, in order, and last a note written in the planner's place when
   * `text` is one. An envelope's own run is not among them. Absent from a
   * backend that does not report runs.
   */
  | { kind: 'message'; text: string; researchLog: ResearchLogEntry[]; aborted?: boolean; failed?: boolean; usageLimit?: UsageLimitSignal | false; runs?: TurnRun[] }
  | { kind: 'plan'; tasks: Task[]; text: string; researchLog: ResearchLogEntry[]; runs?: TurnRun[] }
  | { kind: 'task_ops'; ops: import('./TaskOps').TaskOp[]; text: string; researchLog: ResearchLogEntry[]; runs?: TurnRun[] }
  | { kind: 'task_query'; query: import('./TaskQuery').TaskQuery; text: string; researchLog: ResearchLogEntry[]; runs?: TurnRun[] };

export interface IAiService {
  /** Credential values from the harness planner's effective environment, for the outbound secret check. */
  heldSecrets?(): readonly string[];
  /**
   * Begin the planner conversation: collect workspace context, run the
   * research/tool loop, and return the first planner turn. The service
   * retains the full API message history for subsequent
   * {@link continueConversation} calls.
   */
  startConversation(req: ConversationRequest): Promise<ConversationTurn>;

  /**
   * Feed the user's reply into the active conversation and return the next
   * planner turn. Throws if no conversation is active.
   */
  continueConversation(
    userMessage: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<ConversationTurn>;

  /**
   * Whether a planner conversation is currently held in memory. A branching
   * predicate only — never a test for whether there is anything to release.
   * The harness backend holds an OS process that outlives its conversation, so
   * guarding {@link reset} with this leaks an agent process; call `reset`
   * unconditionally instead.
   */
  hasActiveConversation(): boolean;

  /**
   * Optional: end the planner's live process but keep its own session id, so
   * the next turn starts a fresh one resumed from it (ADR-0009). What a
   * supervisor does to a planner that crashed or hung (ADR-0029). Absent where
   * there is no process to end: the next call is a fresh request anyway.
   */
  restart?(): void;

  /**
   * Whether the active conversation (if any) still matches the planner
   * model/effort currently configured. Optional, and true when absent: a
   * vendor backend re-reads its model from config on every turn, so there is
   * nothing to drift. A harness planner (ADR-0009) is the exception — its
   * model is baked into the agent process at spawn — so only
   * {@link CliAgentAiService} answers this for real. False tells the caller
   * the same thing an absent conversation would: don't call
   * `continueConversation`, restart instead so the new model takes effect.
   */
  conversationMatchesConfig?(): boolean;

  /**
   * Whether the planner reads the catalog and submits plans through Ordewell's
   * MCP tools (ADR-0022). Optional, and false when absent: only a harness
   * planner the server attached to has them, and every other planner keeps
   * the per-turn catalog and the envelopes.
   */
  plannerToolsAttached?(): boolean;

  /**
   * Optional: prune bulky raw tool output out of the live conversation, in
   * place, keeping subagent digests. Returns the characters removed. Absent
   * where the backend holds no tool transcript to prune (a harness planner's
   * agent owns its own context).
   */
  pruneContext?(): number;

  /**
   * Optional: how many times, over this service's life, a conversation's
   * context was compacted in place — by a harness agent itself, or by
   * {@link pruneContext} and the pruning and condensing a vendor backend does
   * before its calls (ADR-0002). A
   * context compacted since a turn was sent the plan may no longer hold it, so
   * the conversation sends the whole plan again when this moves (ADR-0012
   * T10). Absent where nothing compacts a context in place.
   */
  compactions?(): number;
  /** How long this planner's prompt cache lasts, as its connector states it; absent when it states none (ADR-0057 R4). */
  promptCacheTtlMs?(): number | undefined;

  /**
   * Optional: what automatic compaction does for the planner's model now
   * (ADR-0002) — on, off in the settings file, or off for want of a known
   * window — read from catalogs already held. Absent on a harness planner,
   * whose agent compacts its own context.
   */
  plannerContextStatus?(): PlannerContextStatus;

  /**
   * Optional: a summary of the planner's context for `/compact`, written by
   * the planner's own model and credentials in calls that offer no tools, so
   * nothing the summary turn says can run one or change the plan. Absent on a
   * harness planner, whose summary is a hidden turn of its own agent.
   */
  condenseContext?(request: ContextCondenseRequest): Promise<string>;

  /**
   * Optional: whether the live conversation holds the input of a call that
   * could not fit its model's window (`PlannerContextExhaustedError`), with a
   * window known to compact it against, so {@link retryHeldInput} can send
   * it. Absent on a harness planner, whose agent compacts its own context.
   */
  heldInputRetryable?(): boolean;

  /**
   * Optional: the user's Retry compaction of a paused planner (ADR-0002):
   * condense the live context, then send the held input once and carry its
   * turn on from there, as {@link continueConversation} carries on a message.
   * No tool runs again and no result is sent twice.
   */
  retryHeldInput?(onProgress: (progress: ResearchProgress) => void, signal?: AbortSignal): Promise<ConversationTurn>;

  /**
   * One-shot research + plan for non-conversational surfaces (CLI `plan --goal`,
   * web REST). Never asks questions — it plans with what it can find.
   */
  researchAndPlan(
    userDescription: string,
    runners: RunnerId[],
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    fs: IFileSystem,
    onProgress: (progress: ResearchProgress) => void,
    fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes?: PlannerModes,
    signal?: AbortSignal,
  ): Promise<{ tasks: Task[]; researchLog: ResearchLogEntry[]; researchResults: string }>;

  generatePlanDirect(
    userDescription: string,
    runners: RunnerId[],
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    onToken?: (token: string) => void,
    fs?: IFileSystem,
    fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes?: PlannerModes,
    signal?: AbortSignal,
  ): Promise<Task[]>;

  /**
   * Release everything this service holds: the conversation, any in-flight
   * turn, and — on the harness backend — the agent process itself. Idempotent
   * and cheap in every implementation, so callers never gate it.
   */
  reset(): void;
}

/**
 * The single branch point between planner transports. Two of them talk HTTP to
 * an LLM vendor; the third (ADR-0009) drives a coding agent already installed
 * on the machine. Everything downstream — the plan contract, the research-step
 * stream, the three surfaces — is shared.
 */
export function createAiService(config: IConfig, deps?: CliAgentAiServiceDeps & PlannerContextDeps): IAiService {
  if (isCliProvider(config.aiProvider)) {
    return new CliAgentAiService(config, deps);
  }
  if (config.aiProvider === 'google') {
    return new GeminiService(config, { turnBudgets: deps?.turnBudgets, modelLimits: deps?.modelLimits, autoCompaction: deps?.autoCompaction });
  }
  return new OpenAiService(config, { turnBudgets: deps?.turnBudgets, modelLimits: deps?.modelLimits, autoCompaction: deps?.autoCompaction });
}

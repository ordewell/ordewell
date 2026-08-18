import { Task, ConversationMessage, DiscoveredModel, ResearchLogEntry, ResearchProgress, RunnerId } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import type { LegacyPlanState } from '../models/Task';
import type { RunnerModeInfo } from './ModeResolver';
import { GeminiService } from './GeminiService';
import { OpenAiService } from './OpenAiService';
import { isCliProvider } from './ProviderRegistry';
import { CliAgentAiService, type CliAgentAiServiceDeps } from './harness/CliAgentAiService';
import type { PlannerModes } from './plannerModes';

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
  autonomousDefault?: boolean;
  grillMeEnabled?: boolean;
  prdEnabled?: boolean;
  verificationEnabled?: boolean;
  /** Declare the spawn_research_agent tool to the planner (issue #34, default off). */
  researchSubagentsEnabled?: boolean;
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
  | { kind: 'message'; text: string; researchLog: ResearchLogEntry[] }
  | { kind: 'plan'; tasks: Task[]; text: string; researchLog: ResearchLogEntry[] }
  | { kind: 'task_ops'; ops: import('./TaskOps').TaskOp[]; text: string; researchLog: ResearchLogEntry[] }
  | { kind: 'task_query'; query: import('./TaskQuery').TaskQuery; text: string; researchLog: ResearchLogEntry[] };

export interface IAiService {
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

  modifyPlan(
    existingPlan: LegacyPlanState,
    userRequest: string,
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    onProgress?: (progress: ResearchProgress) => void,
    fs?: IFileSystem,
    fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes?: PlannerModes,
    signal?: AbortSignal,
  ): Promise<{ tasks: Task[] }>;

  /**
   * Release everything this service holds: the conversation, any in-flight
   * turn, and — on the harness backend — the agent process itself. Idempotent
   * and cheap in every implementation, so callers never gate it.
   */
  reset(): void;

  sendPlanningPrompt(
    prompt: string,
    runners: RunnerId[],
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    autonomousDefault?: boolean,
  ): Promise<Task[]>;
}

/**
 * The single branch point between planner transports. Two of them talk HTTP to
 * an LLM vendor; the third (ADR-0009) drives a coding agent already installed
 * on the machine. Everything downstream — the plan contract, the research-step
 * stream, the four surfaces — is shared.
 */
export function createAiService(config: IConfig, deps?: CliAgentAiServiceDeps): IAiService {
  if (isCliProvider(config.aiProvider)) {
    return new CliAgentAiService(config, deps);
  }
  if (config.aiProvider === 'google') {
    return new GeminiService(config);
  }
  return new OpenAiService(config);
}

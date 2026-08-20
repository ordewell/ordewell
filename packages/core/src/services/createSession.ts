import { createAiService, type IAiService, type ConversationTurn } from './AiService';
import { applyTaskOps, canMergeTasks, canSplitTask, UPDATABLE_FIELDS } from './TaskOps';
import { validateTaskEdit, type EditCatalog } from './TaskEditValidator';
import { repairLoop, taskOpsRejectedPrompt } from './PlanRepair';
import { renderTaskQueryAnswer, taskQuerySignature, TASK_QUERY_ANSWER_OR_OPS, TASK_QUERY_REMINDER, type TaskQuery } from './TaskQuery';
import { Planner } from './Planner';
import { TaskOrchestrator } from './TaskOrchestrator';
import type { OrchestratorObserver } from './TaskOrchestrator';
import { PlanStore } from './PlanStore';
import { ApprovalPolicy } from './ApprovalPolicy';
import { PendingApprovals, type PendingApproval } from './PendingApprovals';
import { HttpWebFetcher } from './HttpWebFetcher';
import { ModelResolver } from './ModelResolver';
import { filterModelsForPrompt, coerceAssignments, effectiveAllowlist } from './ModelAllowlistResolver';
import { retargetTaskRunner, runnerAssignment, type RunnerCatalog } from './TaskRetarget';
import { plannerModesFrom, plannerRuntimeToggles } from './plannerModes';
import type { UserSettings } from './SettingsService';
import { SkillsService } from './SkillsService';
import { buildMergePrompt, buildSplitPrompt } from './PlanPrompts';
import {
  serializeTask,
  serializeTaskStatus,
  serializePlan,
  executionSummary,
  type SessionBroadcaster,
} from './SessionMessage';
import { saveSession } from '../utils/sessionStore';
import { mintSessionId } from '../utils/sessionId';
import { savePrdMarkdown, extractPrdBlock } from '../utils/prdStore';
import { type ConversationMessage, type DiscoveredModel, type LegacyPlanState, type PlanState, type Task, type TaskSnapshot, type RunnerId, type ResearchProgress } from '../models/Task';
import type { AiProvider, IConfig } from '../interfaces/IConfig';
import type { IFileSystem } from '../interfaces/IFileSystem';
import type { INotification } from '../interfaces/INotification';
import type { ITerminalRunner } from '../interfaces/ITerminalRunner';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import { runnerModesFrom, resolveDefaultMode, type RunnerModeInfo } from './ModeResolver';

/**
 * Per-runner model cap for the always-on catalog block. Generous enough that
 * a typical single-agent catalog (dozens of models) is never truncated —
 * only runners that aggregate hundreds of models (e.g. OpenRouter) hit it.
 */
const CATALOG_MODEL_CAP = 100;

/**
 * Reads a planner gets per user turn before every answer also carries an
 * instruction to land the turn. Three covers the realistic shape of a read —
 * look at a task, look at the catalog, look at a neighbour it now suspects —
 * without letting a confused planner explore on the user's tokens forever.
 */
const MAX_TASK_QUERIES = 3;

/**
 * Reads answered per user turn, full stop. The soft limit above still answers,
 * so without a hard stop a planner that ignores the instruction loops until
 * something else breaks.
 */
const MAX_TASK_QUERIES_HARD = 6;

/** Per-user-turn read state. Shared across the repair loop so retries don't reset it. */
interface ReadBudget {
  answered: number;
  /** Query signatures already answered this turn — a repeat is a loop, not a read. */
  seen: Set<string>;
}

function freshReadBudget(): ReadBudget {
  return { answered: 0, seen: new Set() };
}

/** A turn with every read already drained — what the settle path actually commits. */
type SettleableTurn = Exclude<ConversationTurn, { kind: 'task_query' }>;

/**
 * A direct (non-planner) plan edit the session refused. Distinct from a plain
 * Error so a surface can tell "you asked for something invalid" from "something
 * broke" and say which — the HTTP routes used to collapse both into 404/500,
 * which read to the TUI and VS Code as the edit silently doing nothing. Carries
 * no status code: core is transport-agnostic, the route maps it.
 */
export class PlanEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanEditError';
  }
}

/**
 * Options for plan generation. Progress is not overridable: every planner
 * progress event is translated to a SessionMessage inside the Session and
 * emitted through the broadcast seam, so all surfaces consume one union.
 */
export interface GeneratePlanOptions {
  signal?: AbortSignal;
}

/** The slice of Planner the Session drives — the injection seam for tests. */
export type SessionPlanner = Pick<Planner, 'generate' | 'modify' | 'modifyDuringExecution'>;

/** Runtime prefs read live — may toggle between operations. */
export interface SessionRuntimeSettings {
  tddEnabled: boolean;
  verificationEnabled?: boolean;
  modelAllowlist?: Record<string, string[]>;
}

/**
 * The whole of what a host reads off disk for a Session. Both hosts used to
 * assemble this by hand, mapping each toggle's settings key to its runtime key
 * in two blocks nothing kept in step — which is how one toggle came to be
 * dropped. `MODE_TOGGLES` holds the mapping now; this adds the one field that
 * is not a toggle.
 */
export function sessionRuntimeSettings(settings: UserSettings): SessionRuntimeSettings {
  return { ...plannerRuntimeToggles(settings), modelAllowlist: settings.modelAllowlist };
}

/**
 * Resolve a `/skill-name` invocation to the skill's markdown content. Pure and
 * exported so surfaces and verification can drive substitution without a full
 * Session. Plain text passes through unchanged; an unknown skill becomes a
 * notice naming what IS available instead of a bare slash token that a runner
 * would mis-resolve in its own skills directory.
 */
export function resolveSkillInvocation(
  text: string,
  skillsService: Pick<SkillsService, 'findSkill' | 'listSkills'>,
): string {
  const match = text.trim().match(/^\/([a-z][a-z0-9_-]*)$/im);
  if (!match) return text;
  const skillName = match[1].toLowerCase();
  const skill = skillsService.findSkill(skillName);
  if (!skill) {
    const available = typeof skillsService.listSkills === 'function'
      ? skillsService.listSkills().map((s) => s.name).join(', ')
      : '';
    return `Unknown skill: ${skillName}. Available skills: ${available}`;
  }
  return skill.content;
}

/**
 * Everything a delivery surface constructs to host a session. Structural config
 * (enabledRunners, orchestratorModel, providerModelLists) is snapshotted inside
 * `config` at construction and never re-read from the environment. Runtime
 * settings (tdd, verification) are read live via the `settings` callback so a toggle
 * between generate and execute takes effect.
 */
export interface SessionDeps {
  config: IConfig;
  notifications: INotification;
  runner: ITerminalRunner;
  registry: RunnerRegistry;
  /** Resolves the workspace root for the orchestrator (lazy — VS Code can change it). */
  workspaceRoot: () => string;
  /** Filesystem adapter for planner research. */
  fsAdapter: IFileSystem;
  /** Emits plan-lifecycle events to the surface. Transport-agnostic. */
  broadcast: SessionBroadcaster;
  /** Shared across sessions — sole producer of model catalogs and routing lists. */
  modelResolver: ModelResolver;
  /** Live runtime settings (tdd, verification). Read at each operation that needs them. */
  settings: () => SessionRuntimeSettings;
  /**
   * Host-assigned session id. When set, every persist writes under this id so
   * the host's REST/UI ids match the saved-session store. When omitted, the
   * Session mints a fresh id per plan (generatePlan/startPlanning).
   */
  sessionId?: string;
  /**
   * Planner-conversation seam. Defaults to the provider service for
   * `config.aiProvider`; inject a fake to test the conversation half without
   * an LLM.
   */
  aiService?: IAiService;
  /** Plan-generation seam. Defaults to a Planner over the session's aiService. */
  planner?: SessionPlanner;
  /**
   * Skill lookup for /skill-name interception. Defaults to a SkillsService
   * over the session's workspace root.
   */
  skillsService?: SkillsService;
}

/**
 * The per-session execution stack — deepened from a wiring bag into the
 * lifecycle owner. Owns plan generation, execution, mutation, persistence, and
 * the orchestrator observer wiring. The orchestrator's observer is subscribed
 * once for the session's lifetime (not per-operation), which kills the
 * double-subscribe class of bug. Persistence is an internal seam: every plan
 * mutation routes through `persist()`, so the obligation has a home instead of
 * being scattered across 11 call sites.
 *
 * The broadcast seam carries {@link SessionMessage} — the 15 plan-lifecycle
 * events. Catalog/config messages (setModels, setRunnerList, …) stay on the
 * host; Session never emits them.
 */
export class Session {
  /** Injected by a test; when present it is the service, forever. */
  private readonly pinnedAiService?: IAiService;
  private liveAiService: IAiService | null = null;
  private liveAiProvider: AiProvider | null = null;
  private readonly workspaceRootFn: () => string;
  private planner: SessionPlanner;
  private orchestrator: TaskOrchestrator;
  private store: PlanStore;
  private config: IConfig;
  private registry: RunnerRegistry;
  private plan: LegacyPlanState | null = null;
  private goal = '';
  private workspace: string;
  private broadcast: SessionBroadcaster;
  private modelResolver: ModelResolver;
  private fsAdapter: IFileSystem;
  private approvals: PendingApprovals;
  private approvalPolicy: ApprovalPolicy;
  private fetcher: HttpWebFetcher;
  private settingsFn: () => SessionRuntimeSettings;
  private currentAllowlist: Record<string, string[]> = {};
  /** Last discovered model catalog — lets sync plan commits clamp thinking efforts to real variants. */
  private modelsCache: Partial<Record<RunnerId, DiscoveredModel[]>> = {};
  private unsubObserver: (() => void) | null = null;
  private readonly hostSessionId?: string;
  private currentSessionId: string;
  private readonly skillsService: SkillsService;

  constructor(deps: SessionDeps) {
    this.config = deps.config;
    this.registry = deps.registry;
    this.pinnedAiService = deps.aiService;
    this.workspaceRootFn = deps.workspaceRoot;
    this.planner = deps.planner ?? new Planner(deps.config, () => this.aiService);
    this.store = new PlanStore();
    this.orchestrator = new TaskOrchestrator(deps.config, deps.notifications, deps.runner, this.store);
    this.orchestrator.setRegistry(deps.registry);
    this.orchestrator.setWorkspaceRoot(deps.workspaceRoot);
    this.orchestrator.setTddEnabled(() => this.settingsFn().tddEnabled);
    this.workspace = deps.workspaceRoot();
    this.broadcast = deps.broadcast;
    this.modelResolver = deps.modelResolver;
    this.fsAdapter = deps.fsAdapter;
    this.settingsFn = deps.settings;
    this.hostSessionId = deps.sessionId;
    this.currentSessionId = deps.sessionId ?? mintSessionId();
    this.skillsService = deps.skillsService ?? new SkillsService(this.workspaceRootFn());

    // The approval chain, wired once per session: the filesystem asks the
    // policy, the policy asks the registry, the registry announces on the same
    // broadcast seam every other planner event uses, and any surface answers
    // through `resolveApproval`. Nothing in core knows which UI is listening.
    this.approvals = new PendingApprovals({
      onRequest: ({ id, request }) => this.broadcast({
        type: 'approval_request',
        id,
        kind: request.kind,
        subject: request.subject,
        scope: request.scope,
        detail: request.detail,
      }),
      onSettled: (id, granted) => this.broadcast({ type: 'approval_settled', id, granted }),
    });
    this.approvalPolicy = new ApprovalPolicy({
      mode: this.config.approvalMode,
      preApproved: this.config.approvalPreApproved,
      ask: (req) => this.approvals.ask(req),
      // The interactive path (`asked`) already broadcasts approval_request +
      // approval_settled; only the silent sources need a signal, or a
      // remembered/pre-approved/mode grant is invisible to every surface.
      onDecision: (req, granted, source) => {
        if (source === 'asked') return;
        this.broadcast({
          type: 'approval_decided',
          kind: req.kind,
          subject: req.subject,
          scope: req.scope,
          detail: req.detail,
          granted,
          source,
        });
      },
    });
    this.fsAdapter.setApproval?.(this.approvalPolicy);
    // `fetch`/`web_search` route through the same approval channel as paths and
    // commands — one decision surface for everything that leaves the workspace.
    this.fetcher = new HttpWebFetcher({ approval: this.approvalPolicy });

    this.attachObserver();
  }

  /**
   * The planner transport for the provider configured *right now* (ADR-0009).
   *
   * Resolved on every read rather than once in the constructor, because a
   * Session outlives the choice: VS Code hosts exactly one for the whole
   * window, and the webview pills and `/planner` switch backends underneath it.
   * The model id was already read live, so a service captured at construction
   * meant a switched planner kept the old backend and got handed the new one's
   * model — an OpenCode model id spawned as `claude --model opencode/…`, which
   * the agent rejects as nonexistent.
   *
   * Switching releases the outgoing service: a harness planner holds an OS
   * process, so dropping the reference without `reset()` leaks an agent.
   */
  private get aiService(): IAiService {
    if (this.pinnedAiService) return this.pinnedAiService;
    const provider = this.config.aiProvider;
    if (this.liveAiService && this.liveAiProvider === provider) return this.liveAiService;
    this.liveAiService?.reset();
    this.liveAiService = createAiService(this.config, { workspaceRoot: this.workspaceRootFn });
    this.liveAiProvider = provider;
    return this.liveAiService;
  }

  /**
   * Answer an outstanding approval. Every surface funnels here — the web
   * server's HTTP route, the VS Code webview, the TUI prompt — so the decision
   * path is identical regardless of who is looking.
   */
  resolveApproval(id: string, granted: boolean): boolean {
    return this.approvals.resolve(id, granted);
  }

  /** Requests still waiting for an answer, replayed to a surface that connects mid-prompt. */
  outstandingApprovals(): PendingApproval[] {
    return this.approvals.outstanding();
  }

  /** Scopes the user granted this session — surfaced so a UI can show what is already allowed. */
  approvedScopes(): string[] {
    return this.approvalPolicy.grantedScopes();
  }

  /** The stable id this session persists under — matches the host's id when one was provided. */
  get sessionId(): string { return this.currentSessionId; }
  get executionLog(): TaskSnapshot[] { return this.store.getExecutionLog(); }
  /** Tasks always read from PlanStore — the single source of truth. */
  get planTasks(): Task[] { return this.store.planTasks; }

  private attachObserver(): void {
    if (this.unsubObserver) this.unsubObserver();
    this.unsubObserver = this.orchestrator.subscribe(this.buildObserver());
  }

  private buildObserver(): OrchestratorObserver {
    return {
      onTaskChanged: () => {
        if (!this.plan) return;
        const tasks = this.store.allTasks;
        this.broadcast({ type: 'status_update', tasks: tasks.map((t) => serializeTaskStatus(t, this.orchestrator.getIdleSince(t.id))) });
      },
      onQueueReady: () => {
        this.broadcast({ type: 'queue_ready' });
      },
      onReviewNeeded: () => {
        const tasks = this.store.allTasks;
        this.broadcast({ type: 'review_needed', tasks: tasks.map(serializeTask) });
      },
      onReviewApproved: () => {
        this.broadcast({ type: 'review_approved' });
      },
      onCheckpoint: (data) => {
        this.broadcast({ type: 'checkpoint', taskId: data.taskId, taskTitle: data.taskTitle, summary: data.summary });
      },
      onTick: () => {
        if (!this.plan) return;
        const tasks = this.store.allTasks;
        this.broadcast({ type: 'status_update', tasks: tasks.map((t) => serializeTaskStatus(t, this.orchestrator.getIdleSince(t.id))) });
      },
      onExecutionComplete: () => {
        if (!this.plan) return;
        const tasks = this.store.allTasks;
        this.broadcast({ type: 'execution_complete', summary: executionSummary(tasks) });
        this.persist();
      },
    };
  }

  private translateProgress(progress: ResearchProgress): void {
    if (progress.type === 'thinking' && progress.text) {
      this.broadcast({ type: 'plan_thinking', text: progress.text });
    }
    if (progress.type === 'tool_call' && progress.tool) {
      this.broadcast({ type: 'research_step', tool: progress.tool, toolLabel: progress.toolLabel, args: progress.toolArgs || '', subagentId: progress.subagentId, toolCallId: progress.toolCallId });
    }
    if (progress.type === 'plan_token' && progress.planToken) {
      this.broadcast({ type: 'plan_token', token: progress.planToken });
    }
    if (progress.type === 'tool_result' && progress.step) {
      this.broadcast({ type: 'research_step_done', step: progress.step, subagentId: progress.subagentId });
    }
  }

  /** Persists PlanStore state to disk. PlanStore is the single authority;
   * LegacyPlanState.tasks is populated only here, at persist time. */
  private persist(): void {
    if (!this.plan) return;
    this.plan.tasks = this.store.planTasks;
    this.plan.lastUpdated = new Date().toISOString();
    saveSession(this.plan, this.goal, this.workspace, this.currentSessionId);
  }

  /** A new plan on a long-lived Session gets its own persisted identity (unless the host fixed one). */
  private remintSessionId(): void {
    if (!this.hostSessionId) this.currentSessionId = mintSessionId();
  }

  /**
   * A new plan starts from zero: drop the live planner conversation and every
   * task, log, and queued message left over from a previous plan on this
   * Session. Without this, a long-lived Session (VS Code hosts exactly one)
   * leaks the previous session's tasks into `planContextBlock()` — the model
   * is told they are the CURRENT plan and re-presents them as its draft.
   */
  private beginFreshPlan(): void {
    if (this.isExecuting) this.stopExecution();
    this.aiService.reset();
    // A prompt raised by the turn we are abandoning has nobody left to serve;
    // denying it unblocks the old research loop instead of stranding it.
    this.approvals.clear();
    this.orchestrator.clearQueuedMessages();
    this.store.clearLog();
    this.orchestrator.loadPlan([]);
  }

  /**
   * Return the Session to a blank slate — hosts call this on "new session".
   * Everything scoped to the old session goes: the live AI conversation, plan,
   * goal, tasks, execution log, queued messages, model cache, and (unless the
   * host fixed one) the persisted identity, so nothing can bleed into the next
   * session.
   */
  reset(): void {
    // Null the plan first so orchestrator-stop observer callbacks
    // (onTaskChanged → status_update) no-op instead of broadcasting the
    // dying session's tasks.
    this.plan = null;
    this.goal = '';
    this.beginFreshPlan();
    // Session boundaries are hard (see ADR-0008): a path or command the user
    // approved for the previous goal must not stay approved for the next one.
    this.approvalPolicy.reset();
    this.modelsCache = {};
    this.currentAllowlist = {};
    this.remintSessionId();
  }

  private runnerModesFor(runners: RunnerId[]): Record<RunnerId, RunnerModeInfo[]> {
    return runnerModesFrom(this.registry, runners);
  }

  /**
   * The catalog a model/task-mode edit is checked against — the same
   * discovered models and manifest modes the per-turn catalog block shows the
   * planner, so a refusal here can never name something invalid that the
   * planner was never told about. `modelsCache` is read live, not filtered by
   * the allowlist here — {@link checkModelAndModeValidity} narrows by
   * allowlist itself, the same way `coerceAssignments` does.
   */
  private editCatalog(): EditCatalog {
    return {
      modelsByRunner: this.modelsCache,
      runnerModes: this.runnerModesFor(this.plan?.runners ?? []),
      perRunnerAllowlist: this.settingsFn().modelAllowlist ?? this.currentAllowlist,
    };
  }

  get planState(): LegacyPlanState | null { return this.plan; }

  /**
   * The live plan in the shape a saved session is read back as. The disk
   * boundary rewrites `in_progress` to `pending` — nothing is running when a
   * session comes off a file — so a surface that re-reads the plan mid-run must
   * come here instead, or every task it is watching reads as never started.
   */
  get currentPlanState(): PlanState | null {
    if (!this.plan) return null;
    const executionLog = this.store.getExecutionLog();
    const logged = new Set(executionLog.map((s) => s.id));
    const pendingTasks = this.store.planTasks.filter((t) => !logged.has(t.id));
    if (executionLog.length === 0 && !this.orchestrator.isRunning) {
      return { phase: 'planning', history: [], message: '', pendingTasks };
    }
    return {
      phase: 'executing',
      history: [],
      message: '',
      executionLog,
      pendingTasks,
      goal: this.goal,
      runners: this.plan.runners,
      status: this.plan.status,
    };
  }

  get currentGoal(): string { return this.goal; }
  get isPlanning(): boolean { return !this.orchestrator.isRunning; }
  get isExecuting(): boolean { return this.orchestrator.isRunning; }
  /** See {@link TaskOrchestrator.hasLiveWork} — a spawned runner, not merely an armed scheduler. */
  get hasLiveWork(): boolean { return this.orchestrator.hasLiveWork; }
  get status(): 'approved' | 'running' | 'completed' { return this.orchestrator.status; }
  get sessionConfig(): IConfig { return this.config; }

  /**
   * Deny every parked approval as soon as a planning turn is aborted, for the
   * same reason `beginFreshPlan` does it: a prompt raised by a turn nobody is
   * waiting on has no one left to serve, and denying it unblocks the research
   * loop instead of stranding it. Without this the request sat out its
   * five-minute timeout and the loop then carried on as if nothing had
   * happened — the abort was real, but invisible until long after the user
   * pressed stop.
   *
   * The listener is returned as a disposer rather than left attached: callers
   * own the signal and may reuse it, and a leaked listener would deny the
   * *next* turn's prompts the moment that stale signal aborted.
   */
  private denyApprovalsOnAbort(signal: AbortSignal | undefined): () => void {
    if (!signal) return () => {};
    if (signal.aborted) {
      this.approvals.clear();
      return () => {};
    }
    const onAbort = () => this.approvals.clear();
    signal.addEventListener('abort', onAbort);
    return () => signal.removeEventListener('abort', onAbort);
  }

  async startExecution(): Promise<void> {
    if (!this.plan || !this.store.planTasks.length) throw new Error('No plan to execute');
    this.store.clearLog();
    this.plan.status = 'approved';
    this.store.resetForRun();
    this.orchestrator.loadPlan(this.store.planTasks, this.plan.runners);
    await this.orchestrator.start();
  }

  async generatePlan(goal: string, runners: RunnerId[], options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    this.plan = null;
    this.goal = goal;
    this.remintSessionId();
    this.beginFreshPlan();
    const enabled = this.config.enabledRunners;
    const chosenRunners = runners.filter((r) => enabled.includes(r));
    if (chosenRunners.length === 0) throw new Error('None of the requested runners are enabled');

    const modelsByRunner = await this.modelResolver.modelsForRunners(chosenRunners);
    this.modelsCache = modelsByRunner;
    const runnerModes = this.runnerModesFor(chosenRunners);
    // Every planner toggle, not the two this path used to remember: `modesFor`
    // drops the ones a one-shot run cannot honour, so a structural toggle like
    // verify — which only appends a task — stops being silently lost between
    // here and the prompt.
    const settings = this.settingsFn();
    const { modelAllowlist } = settings;
    const modes = plannerModesFrom(settings, this.config.autonomousMode);

    const releaseAbort = this.denyApprovalsOnAbort(options?.signal);
    let plan: LegacyPlanState;
    try {
      plan = await this.planner.generate({
        goal,
        runners: chosenRunners,
        modelsByRunner,
        runnerModes,
        autonomousDefault: this.config.autonomousMode,
        fs: this.fsAdapter,
        fetcher: this.fetcher,
        onProgress: (p) => this.translateProgress(p),
        signal: options?.signal,
        perRunnerAllowlist: modelAllowlist,
        modes,
      });
    } finally {
      releaseAbort();
    }

    this.plan = plan;
    this.orchestrator.loadPlan(plan.tasks, plan.runners);
    this.store.resetForRun({ preserveCompleted: false });
    this.persist();
    this.broadcastPlan();
    return plan;
  }

  /**
   * Kick off the planner conversation (ADR-0002): research + the first planner
   * message. The AI service retains the tool-use history; the Session persists
   * the user/assistant dialogue on the plan state.
   */
  async startPlanning(goal: string, runners: RunnerId[], options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    this.plan = null;
    this.goal = this.resolveSkillInvocation(goal);
    this.remintSessionId();
    this.beginFreshPlan();
    const enabled = this.config.enabledRunners;
    const chosenRunners = runners.filter((r) => enabled.includes(r));
    if (chosenRunners.length === 0) throw new Error('None of the requested runners are enabled');

    const modelsByRunner = await this.modelResolver.modelsForRunners(chosenRunners);
    this.modelsCache = modelsByRunner;
    const runnerModes = this.runnerModesFor(chosenRunners);
    const { verificationEnabled, modelAllowlist } = this.settingsFn();
    this.currentAllowlist = modelAllowlist ?? {};
    const filteredModels = filterModelsForPrompt(modelsByRunner, this.currentAllowlist);

    const now = new Date().toISOString();
    this.plan = {
      tasks: [],
      generatedAt: now,
      status: 'draft',
      runners: chosenRunners,
      lastUpdated: now,
      researchLog: [{ id: `up-${Date.now()}`, type: 'user_prompt', content: this.goal, timestamp: now }],
      conversationHistory: [{ role: 'user', content: this.goal, timestamp: now }],
    };

    const releaseAbort = this.denyApprovalsOnAbort(options?.signal);
    try {
      const turn = await this.aiService.startConversation({
        goal: this.goal,
        runners: chosenRunners,
        modelsByRunner: filteredModels,
        runnerModes,
        autonomousDefault: this.config.autonomousMode,
        verificationEnabled: verificationEnabled ?? false,
        fs: this.fsAdapter,
        fetcher: this.fetcher,
        onProgress: (p) => this.translateProgress(p),
        signal: options?.signal,
      });

      return await this.settleTurn(turn, options);
    } finally {
      releaseAbort();
    }
  }

  /**
   * Every subsequent user reply in the planning conversation — clarifying
   * answers, outline confirm. One branch, no phase ladder.
   */
  async continueConversation(userMessage: string, options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    if (!this.plan) throw new Error('No planning conversation to continue');
    const priorHistory = this.plan.conversationHistory ?? [];
    const priorResearchLog = this.plan.researchLog ?? [];
    const now = new Date().toISOString();
    const resolved = this.resolveSkillInvocation(userMessage);
    this.appendTranscript('user', resolved, now);
    // The two appends above mutate `this.plan` directly (persist happens later,
    // via settleTurn's mutatePlan) — snapshot the array this call created so the
    // catch can roll back exactly its own writes, and nothing it did not write.
    const historyAfterOwnAppend = this.plan.conversationHistory;
    this.plan.researchLog = [...(this.plan.researchLog ?? []), { id: `up-${Date.now()}`, type: 'user_prompt', content: resolved, timestamp: now }];

    // The persisted transcript keeps the raw user message; the model gets the
    // live catalog (always) and the current plan (tasks, statuses, edit
    // protocol — once tasks exist) alongside it.
    const contextBlock = [this.catalogBlock(), this.planContextBlock()].filter(Boolean).join('\n\n');
    const outgoing = contextBlock ? `${contextBlock}\n\n${resolved}` : resolved;

    // A live conversation is only safe to continue in-place when it also
    // matches the model/effort configured right now — a harness planner's
    // running process was spawned with the old one baked in and cannot pick
    // up a switch (ADR-0009). `resumeConversation` handles both cases the
    // same way: tear down and restart, folding the transcript so far into the
    // opening message.
    const aiService = this.aiService;
    const canContinueLive = aiService.hasActiveConversation() && (aiService.conversationMatchesConfig?.() ?? true);
    const releaseAbort = this.denyApprovalsOnAbort(options?.signal);
    try {
      let turn = canContinueLive
        ? await aiService.continueConversation(
            outgoing,
            (p) => this.translateProgress(p),
            options?.signal,
          )
        : await this.resumeConversation(outgoing, priorHistory, options);

      // Reads settle before the execution gate below, so a query is answered
      // on the spot even mid-run: it mutates nothing, and parking it behind a
      // batch boundary would strand the planner waiting on detail it needs to
      // write the very edit that gets queued.
      const reads = freshReadBudget();
      turn = await this.drainTaskQueries(turn, reads, options);

      // Structural changes while tasks execute are queued, never applied live —
      // the orchestrator must not have the plan mutated under a running batch.
      // The gate is live runners, not an armed scheduler: a run paused on a user
      // task keeps `isExecuting` true with nothing reading the plan, and queueing
      // there parks the edit behind a batch boundary that will never arrive.
      if ((turn.kind === 'task_ops' || turn.kind === 'plan') && this.hasLiveWork) {
        this.queueMessage(userMessage);
        this.plan.queuedMessages = this.getQueuedMessages();
        turn = {
          kind: 'message',
          text: `Execution is running, so I queued your change — it will be applied between task batches (${this.queuedCount} queued).`,
          researchLog: turn.researchLog,
        };
      }

      return await this.settleTurn(turn, options, reads);
    } catch (err) {
      // If nothing persisted since this call's own append, the transcript and
      // research log still hold the exact array this call created — undo both
      // so a failed turn leaves session memory matching disk/UI. Every settle
      // path reassigns conversationHistory before persisting, so the reference
      // check alone separates "rolled back" from "already committed, don't
      // erase it".
      if (this.plan && this.plan.conversationHistory === historyAfterOwnAppend) {
        this.plan.conversationHistory = priorHistory;
        this.plan.researchLog = priorResearchLog;
      }
      throw err;
    } finally {
      releaseAbort();
    }
  }

  /**
   * Answer every read the planner emits until it says something else.
   *
   * The channel is a text envelope rather than a registered tool because the
   * protocol has to be identical on both planner backends (ADR-0009): Ordewell
   * owns a tool loop only in the API case, and a harness planner running as a
   * coding-agent subprocess can only be reached this way.
   *
   * Draining here — outside {@link repairLoop} — is what keeps reads free of
   * the repair budget. A planner that looks a task up and *then* fumbles its
   * ops JSON still gets its two corrective retries; charging it for the read
   * would cost it the chance to fix the edit.
   */
  private async drainTaskQueries(
    turn: ConversationTurn,
    reads: ReadBudget,
    options?: GeneratePlanOptions,
  ): Promise<SettleableTurn> {
    const carried: ConversationTurn['researchLog'] = [];
    let current = turn;
    while (current.kind === 'task_query') {
      carried.push(...current.researchLog);
      if (reads.answered >= MAX_TASK_QUERIES_HARD
        || !this.aiService.hasActiveConversation()
        || options?.signal?.aborted) {
        return {
          kind: 'message',
          text: 'The planner kept asking to read tasks instead of answering. Nothing was changed — ask again, or be more specific about the edit you want.',
          researchLog: carried,
        };
      }
      const signature = taskQuerySignature(current.query);
      // Two reasons to stop being accommodating: the budget is spent, or the
      // planner asked the identical question again — a loop, not a read.
      const insist = reads.seen.has(signature) || reads.answered >= MAX_TASK_QUERIES;
      reads.seen.add(signature);
      reads.answered++;
      const answer = this.taskQueryAnswer(current.query);
      current = await this.aiService.continueConversation(
        insist ? `${answer}\n\n${TASK_QUERY_ANSWER_OR_OPS}` : answer,
        (p) => this.translateProgress(p),
        options?.signal,
      );
    }
    return carried.length > 0
      ? { ...current, researchLog: [...carried, ...current.researchLog] }
      : current;
  }

  /**
   * Render one read out of live state. Never persisted to the transcript: the
   * detail is context for the planner's next reply, and re-sending it on every
   * later turn is exactly the cost this channel exists to avoid.
   */
  private taskQueryAnswer(query: TaskQuery): string {
    const runners = this.plan?.runners ?? [];
    const allowlist = this.settingsFn().modelAllowlist ?? this.currentAllowlist;
    return renderTaskQueryAnswer(query, this.store.planTasks, {
      runners,
      // Allowlist-filtered like the always-on block: a read must not offer a
      // model the planner is forbidden to assign.
      models: filterModelsForPrompt(this.modelsCache, allowlist),
      modes: this.runnerModesFor(runners),
      autonomousDefault: this.config.autonomousMode,
    });
  }

  /**
   * Drive a planner turn to a persisted, broadcast outcome. Task edits apply
   * atomically; validation failures are fed back to the model for up to 2
   * silent retries, then surfaced as a message with the plan untouched. The
   * first turn (startPlanning) and every later turn route through here — one
   * path, not two.
   */
  private async settleTurn(turn: ConversationTurn, options?: GeneratePlanOptions, reads = freshReadBudget()): Promise<LegacyPlanState> {
    type Settled = { plan: LegacyPlanState } | { turn: Exclude<SettleableTurn, { kind: 'task_ops' }> };
    const invalidOps = (errors: string[], researchLog: ConversationTurn['researchLog']): Settled => ({
      turn: {
        kind: 'message',
        text: `I tried to modify the tasks, but the changes were invalid:\n- ${errors.join('\n- ')}\n\nThe plan is unchanged. Rephrase the request, or adjust the tasks manually.`,
        researchLog,
      },
    });

    const settled = await repairLoop<SettleableTurn, Settled>({
      first: () => this.drainTaskQueries(turn, reads, options),
      resend: async (corrective) => this.drainTaskQueries(
        await this.aiService.continueConversation(
          corrective,
          (p) => this.translateProgress(p),
          options?.signal,
        ),
        reads,
        options,
      ),
      interpret: (t) => {
        if (t.kind !== 'task_ops') return { done: { turn: t } };
        const applied = this.applyTaskOpsTurn(t);
        if ('plan' in applied) return { done: { plan: applied.plan } };
        // No live conversation (or an abort) means no corrective re-send is
        // possible — surface the failure instead of retrying into the void.
        if (!this.aiService.hasActiveConversation() || options?.signal?.aborted) {
          return { done: invalidOps(applied.errors, t.researchLog) };
        }
        return { retry: { errors: applied.errors, corrective: taskOpsRejectedPrompt(applied.errors) } };
      },
      maxRepairs: 2,
      onExhausted: ({ reply, errors }) => invalidOps(errors, reply.researchLog),
    });

    if ('plan' in settled) {
      // A landed edit can make work ready under a scheduler that is armed but
      // idle-paused (waiting on a user task or a hold), and nothing else will
      // wake it — the queue-drain path never runs, because nothing queued.
      // `tick()` no-ops when the scheduler is not armed, so this costs nothing
      // during plain planning.
      await this.orchestrator.tick();
      return settled.plan;
    }
    return this.applyConversationTurn(settled.turn);
  }

  /**
   * The catalog the planner may actually draw from — model ids and task-mode
   * ids, per selected runner — emitted on EVERY turn, before any plan exists
   * or after. The system prompt shows this once at conversation start; a long
   * clarifying conversation outlives that single showing and the planner
   * starts misquoting it, so this re-states it per turn instead.
   *
   * Built from the allowlist-filtered view (`filterModelsForPrompt`), the same
   * one the system prompt used — a restricted allowlist stays a hard bound on
   * every turn, not just the first. `this.modelsCache` itself is never
   * filtered: `coerceAssignments` needs the full discovered catalog alongside
   * the allowlist to resolve labels and clamp effort to real variants.
   *
   * Reads `this.plan.runners` live, so a runner admitted mid-session by a
   * retarget (`admitRunner`) is filtered and shown like every other — there is
   * no separate "originally selected" list to fall stale.
   */
  private catalogBlock(): string | null {
    if (!this.plan) return null;
    const allowlist = this.settingsFn().modelAllowlist ?? this.currentAllowlist;
    const filteredModels = filterModelsForPrompt(this.modelsCache, allowlist);
    const runnerModes = this.runnerModesFor(this.plan.runners);
    const autonomousDefault = this.config.autonomousMode;

    const modelLines = this.plan.runners.map((runner) => {
      const models = filteredModels[runner] ?? [];
      const capped = models.slice(0, CATALOG_MODEL_CAP);
      const remainder = models.length - capped.length;
      const ids = capped.map((m) => m.modelId).join(', ') || '(no models discovered)';
      return `${runner}: ${ids}${remainder > 0 ? ` … +${remainder} more not shown` : ''}`;
    });

    const modeLines = this.plan.runners.map((runner) => {
      const modes = runnerModes[runner] ?? [];
      if (modes.length === 0) return `${runner}: (no modes declared)`;
      const defaultId = resolveDefaultMode(modes, autonomousDefault);
      const ids = modes.map((m) => `${m.id}${m.id === defaultId ? ' (default)' : ''}`).join(', ');
      return `${runner}: ${ids}`;
    });

    return [
      '<available_models>',
      ...modelLines,
      '</available_models>',
      '<available_task_modes>',
      ...modeLines,
      '</available_task_modes>',
    ].join('\n');
  }

  /**
   * The "you are here" block for post-plan chat: current tasks with stable
   * references, plus the task-ops protocol. Injected per turn (never
   * persisted) so the model always sees live statuses — including which tasks
   * are locked by a running execution.
   */
  private planContextBlock(): string | null {
    if (!this.plan || this.store.planTasks.length === 0) return null;
    const orderOf = new Map(this.store.planTasks.map((t) => [t.id, `#${t.order}`]));
    const lines = this.store.planTasks.map((t) => {
      const isMan = t.type === 'user';
      // A MAN task has no model or mode to run under — the field that means
      // something there is how many steps the human still has to do.
      const runFields = isMan
        ? `steps:${t.userSteps?.length ?? 0}`
        : `${t.assignedModel ? `model:${t.assignedModel.modelId} ` : ''}mode:${t.taskMode ?? 'build'} effort:${t.thinkingEffort ?? '-'}`;
      return `#${t.order} id=${t.id} "${t.title}" [${t.status}] type:${isMan ? 'MAN' : 'AI'} runner:${t.assignedRunner} ${runFields} autonomy:${t.autonomy ?? '-'} slice:${t.sliceType ?? '-'} deps:[${t.dependencies.map((d) => orderOf.get(d) ?? d).join(', ')}]`;
    });
    // Gated on live runners, not on `isExecuting`: a paused-but-armed run takes
    // edits immediately, so promising a queue there is a lie the model plans
    // around (it stops emitting ops and asks the user to wait).
    const locked = this.store.planTasks.filter((t) => t.status === 'in_progress');
    const execNote = this.hasLiveWork
      ? `\nExecution is RUNNING${locked.length ? ` — these tasks are locked: ${locked.map((t) => `#${t.order}`).join(', ')}` : ''}. Any task edits you emit will be queued and applied between batches.`
      : '';
    // Derived from the applier's own UPDATABLE_FIELDS so this prose can never
    // undersell what applyTaskOps actually accepts.
    const updateChanges = UPDATABLE_FIELDS
      .map((f) => (f === 'dependencies' ? '"dependencies"?:["<id or #order>"]' : `"${f}"?`))
      .join(',');
    return [
      '<current_plan>',
      ...lines,
      '</current_plan>',
      'The block above is the CURRENT task plan — short fields only. Choose how to respond:',
      '- To answer a question or discuss, reply in plain prose (no JSON).',
      // The reminder text is owned by TaskQuery beside the parser, so the
      // protocol the planner reads and the one Ordewell accepts stay one thing.
      TASK_QUERY_REMINDER,
      '- To modify specific tasks, reply with ONLY this JSON object:',
      '  {"taskOps": [',
      `    {"op":"update","taskId":"<id or #order>","changes":{${updateChanges}}},`,
      '    {"op":"add","task":{"title","description","prompt","dependencies":["<id or #order>"],"assignedRunner"?,"assignedModel"?},"handle"?:"<name>"},',
      '    {"op":"remove","taskId":"<id or #order>"},',
      '    {"op":"reorder","taskIds":["<id or #order>", "... every task exactly once"]},   // only to re-prioritise INDEPENDENT tasks',
      '    {"op":"merge","taskIds":["<id or #order>", "..."],"merged":{"title","description","prompt"?,"assignedRunner"?,"assignedModel"?,...},"handle"?:"<name>"},',
      '    {"op":"split","taskId":"<id or #order>","parts":[{"title","description","prompt"?,"assignedRunner"?,"assignedModel"?,...}, ...],"handle"?:"<name>"},',
      `    {"op":"rearm","taskId":"<id or #order>","changes"?:{${updateChanges}}}`,
      '  ]}',
      '- For sweeping changes, you may instead emit a full {"tasks":[...]} plan JSON.',
      'Every "<id or #order>" ref in a batch resolves against the plan shown above, before any op in the batch runs — an earlier remove/merge/split never shifts what a later "#N" means.',
      'Give "add", "merge", or "split" a "handle" (any name you choose, unused elsewhere in this batch) to let a LATER op in the same batch reference the task it produces — for "split", the handle names its last part. A handle used before its defining op is rejected.',
      'When creating or changing tasks, set "assignedRunner" and "assignedModel" ({"modelId","modelLabel","thinkingEffort"?}) using only the runners and models listed in <available_models>.',
      'Keep dependencies consistent: no cycles, no references to removed tasks, and never touch running or completed tasks — "rearm" is the one exception, below.',
      'Just declare the dependencies you want — display order is repaired for you afterwards, so a rewire or a newly added prerequisite never needs a "reorder" op. Only a task that is running or completed cannot be shifted, so an edit that would need one to move is rejected.' + execNote,
      'Flipping "type" between "ai" and "user" is a content change, not just a label: an update to "user" needs "userSteps" in the SAME op, and an update to "ai" needs "prompt" in the SAME op — the model/mode/effort/autonomy fields (flipping to "user") or the userSteps (flipping to "ai") are cleared automatically.',
      '"rearm" puts a failed OR completed task back to pending — verdict and output summary are cleared, any dependents it had blocked are released, and it may carry field changes (e.g. a corrected "prompt") applied in the same op. A running task cannot be re-armed. Never rearm a task just to relabel it — only when it should actually run again.',
    ].filter(Boolean).join('\n');
  }

  /** Validate + commit a task_ops turn atomically. Returns the errors on rejection (plan untouched). */
  private applyTaskOpsTurn(turn: Extract<ConversationTurn, { kind: 'task_ops' }>): { plan: LegacyPlanState } | { errors: string[] } {
    if (!this.plan) throw new Error('No active plan state');
    const result = applyTaskOps(this.store.planTasks, turn.ops, this.plan.runners, this.editCatalog());
    if (!result.ok) return { errors: result.errors };

    const now = new Date().toISOString();
    const content = `Tasks updated:\n- ${result.summary.join('\n- ')}`;
    const plan = this.mutatePlan(
      () => {
        this.plan!.researchLog = [...(this.plan!.researchLog ?? []), ...turn.researchLog];
        const allowlist = this.settingsFn().modelAllowlist ?? this.currentAllowlist;
        const coerced = coerceAssignments(result.tasks, allowlist, this.plan!.runners, this.modelsCache);
        // An armed scheduler owns run state the edit is not allowed to wipe:
        // `loadPlan` clears the on-hold set and the review approval, so a task
        // the user cancelled would be re-armed and re-spawned by the re-tick
        // that follows. `reconcilePlan` is the mid-run adoption.
        if (this.orchestrator.isRunning) {
          this.orchestrator.reconcilePlan(coerced, this.plan!.runners);
        } else {
          this.orchestrator.loadPlan(coerced, this.plan!.runners);
          this.store.resetForRun();
        }
        this.appendTranscript('assistant', content, now);
        return true;
      },
      () => {
        this.broadcast({ type: 'planner_message', content, timestamp: now });
        this.broadcastPlan();
      },
    );
    return { plan: plan! };
  }

  /**
   * Resume a persisted dialogue onto a fresh AI-service conversation — either
   * because the in-memory one is gone (session reload, extension restart), or
   * because {@link continueConversation} found it stale against the planner
   * config now in effect (a harness planner's model/effort switched mid-chat).
   * The saved transcript seeds the new conversation; no LLM call happens
   * before the user's message is sent.
   */
  private async resumeConversation(
    userMessage: string,
    priorHistory: ConversationMessage[],
    options?: GeneratePlanOptions,
  ): Promise<Awaited<ReturnType<IAiService['startConversation']>>> {
    if (!this.plan) throw new Error('No active plan state');
    const runners = this.plan.runners;
    const modelsByRunner = await this.modelResolver.modelsForRunners(runners);
    this.modelsCache = modelsByRunner;
    const runnerModes = this.runnerModesFor(runners);
    const { verificationEnabled, modelAllowlist } = this.settingsFn();
    this.currentAllowlist = modelAllowlist ?? {};
    const filteredModels = filterModelsForPrompt(modelsByRunner, this.currentAllowlist);
    const goal = this.goal || priorHistory.find((m) => m.role === 'user')?.content || userMessage;

    return this.aiService.startConversation({
      goal,
      runners,
      modelsByRunner: filteredModels,
      runnerModes,
      autonomousDefault: this.config.autonomousMode,
      verificationEnabled: verificationEnabled ?? false,
      fs: this.fsAdapter,
      fetcher: this.fetcher,
      onProgress: (p) => this.translateProgress(p),
      signal: options?.signal,
      priorHistory,
      initialMessage: userMessage,
    });
  }

  /** Whether the planner conversation is live (started and not yet committed to a plan). */
  get isConversationActive(): boolean {
    return this.aiService.hasActiveConversation();
  }

  /**
   * Intercept a skill invocation (/skill-name) and substitute the skill's
   * markdown content BEFORE the message reaches the planner. Prevents runners
   * (Claude Code, OpenCode) from trying to resolve the skill in their own
   * directory instead of .ordewell/skills/. An unknown skill is surfaced to
   * the planner as a notice naming what IS available, rather than passing a
   * bare /unknown through to be mis-resolved.
   */
  private resolveSkillInvocation(text: string): string {
    return resolveSkillInvocation(text, this.skillsService);
  }

  /** Append one dialogue entry to the persisted transcript. Callers persist via the mutatePlan ritual. */
  private appendTranscript(role: 'user' | 'assistant', content: string, timestamp: string, kind?: 'plan_generated'): void {
    if (!this.plan) return;
    this.plan.conversationHistory = [
      ...(this.plan.conversationHistory ?? []),
      { role, content, timestamp, ...(kind ? { kind } : {}) },
    ];
  }

  /** Commit a settled (non-task_ops) turn. Both branches run the mutatePlan ritual. */
  private applyConversationTurn(turn: Exclude<SettleableTurn, { kind: 'task_ops' }>): LegacyPlanState {
    if (!this.plan) throw new Error('No active plan state');
    const now = new Date().toISOString();

    if (turn.kind === 'plan') {
      return this.mutatePlan(() => {
        this.plan!.researchLog = [...(this.plan!.researchLog ?? []), ...turn.researchLog];
        // A cheap model may emit the PRD block and the plan JSON in one turn —
        // capture the PRD here too so it isn't dropped with the plan preamble.
        this.capturePrd(turn.text);
        // Read the allowlist live: it may have changed since startPlanning, and
        // committed tasks must respect the current one.
        const allowlist = this.settingsFn().modelAllowlist ?? this.currentAllowlist;
        const coerced = coerceAssignments(turn.tasks, allowlist, this.plan!.runners, this.modelsCache);
        this.orchestrator.loadPlan(coerced, this.plan!.runners);
        this.store.resetForRun({ preserveCompleted: false });
        this.appendTranscript('assistant', `Plan generated with ${coerced.length} task${coerced.length === 1 ? '' : 's'}.`, now, 'plan_generated');
        return true;
      })!;
    }

    // A message turn: persist it in the dialogue; the UI re-renders from here.
    // Budget models occasionally return an empty content turn after tool use —
    // surface that visibly instead of rendering a blank bubble.
    const text = turn.text.trim()
      ? turn.text
      : '(The planner returned an empty response. Reply to continue, or rephrase your goal.)';
    return this.mutatePlan(
      () => {
        this.plan!.researchLog = [...(this.plan!.researchLog ?? []), ...turn.researchLog];
        this.appendTranscript('assistant', text, now);
        this.capturePrd(text);
        return true;
      },
      () => this.broadcast({ type: 'planner_message', content: text, timestamp: now }),
    )!;
  }

  /**
   * PRD mode: when the planner writes the full markdown PRD, save it to
   * .scratch/<slug>/PRD.md (Matt Pocock to-prd convention) and keep it on the plan.
   */
  private capturePrd(text: string): void {
    if (!this.plan) return;
    const prd = extractPrdBlock(text);
    if (!prd) return;
    this.plan.prdMarkdown = prd.markdown;
    try {
      savePrdMarkdown(this.workspace, prd.slug, prd.markdown);
    } catch {
      // Saving the PRD file is best-effort; the markdown stays on the plan state.
    }
  }

  async executePlan(): Promise<void> {
    if (!this.plan || !this.store.planTasks.length) throw new Error('No plan to execute');
    if (this.orchestrator.isRunning) throw new Error('Session already executing');

    this.plan.status = 'approved';
    this.store.clearLog();
    this.store.resetForRun();

    this.orchestrator.loadPlan(this.store.planTasks, this.plan.runners);
    await this.orchestrator.approveReview();

    if (!this.orchestrator.isRunning) {
      const tasks = this.store.allTasks;
      this.broadcast({ type: 'execution_complete', summary: executionSummary(tasks) });
      this.persist();
    }
  }

  async approveReview(): Promise<LegacyPlanState> {
    if (!this.plan) throw new Error('No plan to review');
    await this.orchestrator.approveReview();
    return this.plan;
  }

  async forceStartTask(taskId: string): Promise<void> {
    if (!this.plan) return;
    if (!this.store.get(taskId)) {
      this.orchestrator.loadPlan(this.store.planTasks, this.plan.runners);
    }
    await this.orchestrator.forceStartTask(taskId);
  }

  async runTask(taskId: string): Promise<void> {
    if (!this.plan) return;
    if (!this.store.get(taskId)) {
      this.orchestrator.loadPlan(this.store.planTasks, this.plan.runners);
    }
    await this.orchestrator.runTask(taskId);
  }

  async retryTask(taskId: string): Promise<void> {
    await this.orchestrator.retryTask(taskId);
    this.persist();
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.orchestrator.cancelTask(taskId);
    this.persist();
  }

  async markAiTaskComplete(taskId: string): Promise<void> {
    await this.orchestrator.markAiTaskComplete(taskId);
    this.persist();
  }

  async markTaskComplete(taskId: string): Promise<void> {
    await this.orchestrator.markTaskComplete(taskId);
    this.persist();
  }

  async markTaskIncomplete(taskId: string): Promise<void> {
    await this.orchestrator.markTaskIncomplete(taskId);
    this.persist();
  }

  async tick(): Promise<void> {
    await this.orchestrator.tick();
    this.persist();
  }

  async processQueuedMessages(): Promise<void> {
    const messages = this.orchestrator.getQueuedMessages();
    if (messages.length === 0) return;

    this.orchestrator.clearQueuedMessages();

    const batchText = messages.map((m) => m.text).join('\n');
    const activeSessions = new Map(
      [...this.orchestrator.activeSessionMap.entries()].map(([taskId, sessionId]) => [
        taskId,
        { id: sessionId, taskId },
      ])
    );

    const modelsByRunner = await this.modelResolver.modelsForRunners(this.config.enabledRunners);
    const runnerModes = this.runnerModesFor(this.plan?.runners ?? ['claude-code']);
    const { modelAllowlist } = this.settingsFn();

    const result = await this.planner.modifyDuringExecution({
      executionLog: this.store.getExecutionLog(),
      pendingTasks: this.store.planTasks,
      activeSessions,
      userMessage: batchText,
      modelsByRunner,
      runners: this.plan?.runners ?? ['claude-code'],
      runnerModes,
      autonomousDefault: this.config.autonomousMode,
      perRunnerAllowlist: modelAllowlist,
    });

    this.orchestrator.reconcilePlan(result.pendingTasks, this.plan?.runners ?? ['claude-code']);
    this.persist();

    // Re-schedule. `onQueueReady` only fires when no task is active, so a paused
    // run still has `running === true` — `start()` would no-op (it early-returns
    // when already running). Ticking directly spawns the dependents that became
    // ready after reconcile. `start()` covers the halted case (`running === false`,
    // e.g. a retry that cleared the queue), re-entering approval-free.
    if (this.orchestrator.isRunning) {
      await this.orchestrator.tick();
    } else {
      await this.orchestrator.start();
    }
  }

  approveCheckpoint(taskId: string): void {
    this.orchestrator.approveCheckpoint(taskId);
  }

  rejectCheckpoint(taskId: string, reason?: string): void {
    this.orchestrator.rejectCheckpoint(taskId, reason);
  }

  queueMessage(text: string): void {
    this.orchestrator.queueMessage(text);
  }

  getQueuedMessages() { return this.orchestrator.getQueuedMessages(); }
  setQueuedMessages(msgs: ReturnType<TaskOrchestrator['getQueuedMessages']>): void {
    this.orchestrator.setQueuedMessages(msgs);
  }
  processNextQueuedMessage() { return this.orchestrator.processNextQueuedMessage(); }
  get queuedCount(): number { return this.orchestrator.queuedCount; }
  getTask(taskId: string) { return this.store.get(taskId); }
  get isReviewApproved(): boolean { return this.orchestrator.isReviewApproved; }

  stopExecution(): void {
    this.orchestrator.stop();
    this.broadcast({ type: 'execution_stopped' });
  }

  /**
   * The one mutation seam: every structural plan mutation runs the same
   * ritual — store op → persist (which snapshots tasks from PlanStore) →
   * broadcast — in that order, once. A store op returning false aborts
   * before anything is persisted. PlanStore is the single authority for
   * task state; LegacyPlanState.tasks is populated only at persist time.
   */
  private mutatePlan(op: () => boolean, notify: () => void = () => this.broadcastPlan()): LegacyPlanState | null {
    if (!this.plan) return null;
    if (!op()) return null;
    this.persist();
    notify();
    return this.plan;
  }

  /**
   * The direct-edit seam: {@link mutatePlan} plus the reschedule every
   * structural edit owes an armed scheduler. Nothing else wakes one after a
   * hand edit — the queue-drain path never runs, because a direct edit never
   * queues — so a task the edit just unblocked would sit ready and never
   * start. `tick()` no-ops while the scheduler is idle, so this costs nothing
   * during plain planning. The planner-driven path re-ticks in
   * {@link settleTurn} instead; it must not tick twice.
   */
  private async editPlan(op: () => boolean, notify?: () => void): Promise<LegacyPlanState | null> {
    const plan = this.mutatePlan(op, notify);
    if (!plan) return null;
    await this.orchestrator.tick();
    return plan;
  }

  /**
   * Patch one task's fields. A hand-set dependency list, or a type flip
   * between AI and MAN, are the patches that can leave a task incoherent
   * (unschedulable, or carrying fields that mean nothing for its new type),
   * so both go through the same {@link validateTaskEdit} guard the planner's
   * task-ops applier uses (as the 'direct' actor, which skips the lock rule)
   * rather than a second copy of the rules — and throws, so the surface can
   * say why. Gated on the task existing so an edit to an unknown id still
   * falls through to the no-op `store.update` below instead of throwing.
   */
  async updateTask(taskId: string, changes: Partial<Task>): Promise<LegacyPlanState | null> {
    if ((changes.dependencies || changes.type || changes.assignedModel || changes.taskMode) && this.store.get(taskId)) {
      const check = validateTaskEdit('direct', this.store.planTasks, taskId, changes, this.editCatalog());
      if (!check.ok) throw new PlanEditError(check.error ?? 'Those changes are not valid');
      if (check.clear?.length) {
        changes = { ...changes, ...Object.fromEntries(check.clear.map((f) => [f, undefined])) };
      }
    }
    return this.editPlan(
      () => Boolean(this.store.update(taskId, changes)),
      () => this.broadcast({ type: 'task_updated', taskId, changes: changes as Record<string, unknown> }),
    );
  }

  /**
   * Move one task onto a different runner. Distinct from {@link updateTask}
   * because a runner change is never a single-field edit: the task's model,
   * thinking effort and mode are all scoped to its runner, so they are
   * re-derived from the new runner's catalog (see {@link retargetTaskRunner}).
   * That needs discovery, which is why it is not a branch inside `updateTask`.
   *
   * The runner is also admitted into `plan.runners` — see {@link admitRunner}.
   */
  async setTaskRunner(taskId: string, runner: RunnerId): Promise<LegacyPlanState | null> {
    if (!this.plan) return null;
    const task = this.store.get(taskId);
    if (!task) return null;
    // Guard before discovery, not after: `modelsForRunners` spawns the runner's
    // own CLI to list models, which is far too expensive for a no-op re-pick.
    if (task.assignedRunner === runner || task.type === 'user') return this.plan;

    const catalog = await this.catalogFor(runner);
    const changes = retargetTaskRunner(task, runner, this.allowedCatalog(catalog, runner));
    if (Object.keys(changes).length === 0) return this.plan;

    return this.editPlan(() => {
      if (!this.store.update(taskId, changes)) return false;
      this.admitRunner(runner, catalog.models);
      return true;
    });
  }

  /** What a runner offers, as {@link runnerAssignment} needs it. Spawns the runner's CLI to list models. */
  private async catalogFor(runner: RunnerId): Promise<RunnerCatalog> {
    return {
      models: (await this.modelResolver.modelsForRunners([runner]))[runner] ?? [],
      modes: this.runnerModesFor([runner])[runner],
    };
  }

  /**
   * What a *derived* assignment may draw from: the runner's catalog narrowed to
   * the user's allowlist. Deriving from the full catalog would hand a task the
   * runner's first model regardless of a restriction the user set — the next
   * planner turn's `coerceAssignments` would snap it back anyway, so the user
   * would see their pick silently change instead of never being offered.
   *
   * `catalogFor` stays unnarrowed because {@link admitRunner} caches it as what
   * the runner really offers, which is what effort clamping needs.
   */
  private allowedCatalog(catalog: RunnerCatalog, runner: RunnerId): RunnerCatalog {
    // The other runners' catalogs are what lets `effectiveAllowlist` tell an id
    // this runner hasn't listed yet from one that belongs to a different runner.
    const allowed = effectiveAllowlist(
      this.settingsFn().modelAllowlist?.[runner],
      runner,
      { ...this.modelsCache, [runner]: catalog.models },
    );
    if (!allowed) return catalog;
    const models = catalog.models.filter((m) => allowed.includes(m.modelId));
    // Nothing left means the allowlist named only ids this runner hasn't
    // listed. An empty catalog reads as "discovery failed" to
    // `runnerAssignment`, which then leaves the task on the *old* runner's
    // model — a worse outcome than ignoring the restriction for this derivation.
    return models.length > 0 ? { ...catalog, models } : catalog;
  }

  /**
   * Make a runner a first-class member of this plan. Without this, the next
   * planner turn's `coerceAssignments` would treat it as disallowed and snap
   * every task on it back, silently undoing the user's choice; and that same
   * pass clamps efforts against `modelsCache`, so a catalog missing from there
   * makes the effort we just derived read as unverifiable.
   */
  private admitRunner(runner: RunnerId, models: DiscoveredModel[]): void {
    if (!this.plan) return;
    if (!this.plan.runners.includes(runner)) this.plan.runners = [...this.plan.runners, runner];
    // The store is what the orchestrator resolves a spawn against, and nothing
    // reloads it between this edit and a single-task run.
    this.store.admitRunner(runner);
    if (models.length > 0) this.modelsCache = { ...this.modelsCache, [runner]: models };
  }

  /**
   * Replace one task's dependency list — the named entry point the surfaces'
   * dependency pickers call. The guard itself lives in {@link updateTask}, so
   * a dependency list arriving as a plain field patch is rejected by the same
   * rule instead of slipping past it.
   */
  async setTaskDependencies(taskId: string, dependencies: string[]): Promise<LegacyPlanState | null> {
    if (!this.plan) return null;
    return this.updateTask(taskId, { dependencies });
  }

  async completeTask(taskId: string): Promise<void> {
    await this.markTaskComplete(taskId);
  }

  /**
   * Delete one task. A running task is cancelled first: the plan can drop it
   * either way, but nothing can reach its runner afterwards — the tmux session
   * outlives the plan and the orchestrator keeps counting it as active. The
   * planner-driven path refuses instead (see {@link applyTaskOps}); a user
   * deleting their own task means it.
   */
  async removeTask(taskId: string): Promise<LegacyPlanState | null> {
    if (!this.plan || !this.store.get(taskId)) return null;
    await this.orchestrator.releaseTask(taskId);
    return this.editPlan(() => (this.store.remove(taskId), true));
  }

  /**
   * Add one task, filling in whatever the caller left unset. A task with no
   * runnable assignment is not a lighter task but an unspawnable one, so the
   * runner falls back to the plan's first and the model, effort and mode are
   * derived from that runner's catalog — the same derivation a runner change
   * uses ({@link runnerAssignment}), which is why this is async like
   * {@link setTaskRunner}. Anything the caller did choose survives when the
   * runner offers it.
   *
   * Dependencies naming tasks that don't exist are dropped rather than rejected:
   * the caller is a picker over the current plan, so a stale id means the plan
   * moved on, not that the whole task should be refused.
   */
  async addTask(draft: Partial<Task>): Promise<LegacyPlanState | null> {
    if (!this.plan) return null;
    const runner = draft.assignedRunner ?? this.plan.runners[0];
    const dependencies = (draft.dependencies ?? []).filter((id) => this.store.get(id));
    const catalog = draft.type === 'user' ? null : await this.catalogFor(runner);

    return this.editPlan(() => {
      this.store.add({ ...draft, ...(catalog ? runnerAssignment(this.allowedCatalog(catalog, runner), draft) : {}), assignedRunner: runner, dependencies });
      if (catalog) this.admitRunner(runner, catalog.models);
      return true;
    });
  }

  async mergeTasks(taskIdA: string, taskIdB: string): Promise<LegacyPlanState | null> {
    return this.editPlan(() => (this.store.merge(taskIdA, taskIdB), true));
  }

  async mergeMultipleTasks(taskIds: string[]): Promise<LegacyPlanState | null> {
    return this.editPlan(() => (this.store.mergeMultiple(taskIds), true));
  }

  async splitTask(taskId: string, newTasks: Partial<Task>[]): Promise<LegacyPlanState | null> {
    return this.editPlan(() => (this.store.split(taskId, newTasks), true));
  }

  /**
   * Planner-driven merge: validate compatibility up front, then ask the planner
   * LLM to produce a single "merge" taskOps op combining the selected tasks.
   * Goes through the same conversation loop + validated-atomic-edit + corrective
   * retry flow as every other task_ops edit (ADR-0002). Throws on a
   * pre-flight compatibility failure so the host surfaces an inline error
   * before any LLM call.
   */
  async requestMerge(taskIds: string[], options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    if (!this.plan) throw new Error('No active plan state');
    const check = canMergeTasks(this.store.planTasks, taskIds);
    if (!check.ok) throw new Error(check.error ?? 'These tasks cannot be merged');
    const prompt = buildMergePrompt(taskIds, this.store.planTasks);
    return this.continueConversation(prompt, options);
  }

  /**
   * Planner-driven split: ask the planner LLM to decompose one task into a
   * sequence of smaller tasks. The model generates the breakdown (no manual
   * per-task specs from the user). Same conversation-loop/repair path as merge.
   */
  async requestSplit(taskId: string, options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    if (!this.plan) throw new Error('No active plan state');
    const check = canSplitTask(this.store.planTasks, taskId);
    if (!check.ok) throw new Error(check.error ?? 'This task cannot be split');
    const prompt = buildSplitPrompt(taskId, this.store.planTasks);
    return this.continueConversation(prompt, options);
  }

  loadPlan(plan: LegacyPlanState, goal: string, workspace: string, opts?: { sessionId?: string; persist?: boolean }): void {
    // A live planner conversation belongs to the plan it was started for.
    // Adopting a different plan (session load/switch) must drop it — otherwise
    // the next user message continues the OLD session's LLM thread and the
    // planner re-emits that session's plan here. The same-object case (e.g.
    // re-adopting the current plan on approval) keeps the conversation; after
    // a drop, the first user send reseeds it from this plan's own transcript.
    if (plan !== this.plan) {
      this.aiService.reset();
      // The execution log and queued messages are scoped to the outgoing plan;
      // callers restoring a saved queue re-apply it after adoption.
      this.store.clearLog();
      this.orchestrator.clearQueuedMessages();
      // Approval scopes are equally session-scoped: a path or command approved
      // for the previous plan must not stay approved for the newly adopted one.
      this.approvals.clear();
      this.approvalPolicy.reset();
    }
    this.plan = plan;
    this.goal = goal;
    this.workspace = workspace;
    // Adopting the saved session's id keeps subsequent persists writing to the
    // same file instead of forking the session under a fresh identity.
    if (opts?.sessionId) this.currentSessionId = opts.sessionId;
    this.orchestrator.loadPlan(plan.tasks, plan.runners);
    if (opts?.persist !== false) this.persist();
  }

  async modifyPlan(userRequest: string): Promise<Task[]> {
    if (!this.plan) throw new Error('No plan to modify');
    const now = new Date().toISOString();
    this.appendTranscript('user', userRequest, now);
    const modelsByRunner = await this.modelResolver.modelsForRunners(this.plan.runners);
    const runnerModes = this.runnerModesFor(this.plan.runners);
    const { modelAllowlist } = this.settingsFn();
    const result = await this.planner.modify({
      existingPlan: this.plan,
      userRequest,
      modelsByRunner,
      runnerModes,
      autonomousDefault: this.config.autonomousMode,
      fs: this.fsAdapter,
      fetcher: this.fetcher,
      perRunnerAllowlist: modelAllowlist,
    });
    this.orchestrator.loadPlan(result.tasks, this.plan.runners);
    this.appendTranscript('assistant', `Plan updated — now ${result.tasks.length} task${result.tasks.length === 1 ? '' : 's'}.`, new Date().toISOString(), 'plan_generated');
    this.persist();
    return result.tasks;
  }

  destroy(): void {
    this.stopExecution();
    // Planning research runs on a separate conduit from task execution — a
    // live spawn_research_agent/bash tool call would otherwise keep running
    // server-side after the client has already moved on to a new session.
    this.aiService.reset();
    // Deny any still-pending approval prompts so their timers and awaited
    // continuations settle before the Session goes away.
    this.approvals.clear();
    this.approvalPolicy.reset();
    this.unsubObserver?.();
    this.unsubObserver = null;
  }

  private broadcastPlan(): void {
    if (!this.plan) return;
    this.broadcast({
      type: 'plan_generated',
      plan: serializePlan(this.plan),
      goal: this.goal,
      runners: this.plan.runners,
    });
  }

  get aiServiceInstance(): IAiService { return this.aiService; }
}


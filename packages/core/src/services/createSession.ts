import { createAiService, type IAiService, type ConversationTurn } from './AiService';
import { applyTaskOps, canMergeTasks, canSetDependencies, canSplitTask } from './TaskOps';
import { repairLoop, taskOpsRejectedPrompt } from './PlanRepair';
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
import { buildMergePrompt, buildSplitPrompt } from './PlanPrompts';
import {
  serializeTask,
  serializeTaskStatus,
  serializePlan,
  executionSummary,
  type SessionBroadcaster,
} from './SessionMessage';
import { saveSession } from '../utils/sessionStore';
import { savePrdMarkdown, extractPrdBlock } from '../utils/prdStore';
import { type ConversationMessage, type DiscoveredModel, type LegacyPlanState, type PlanState, type Task, type TaskSnapshot, type RunnerId, type ResearchProgress } from '../models/Task';
import type { AiProvider, IConfig } from '../interfaces/IConfig';
import type { IFileSystem } from '../interfaces/IFileSystem';
import type { INotification } from '../interfaces/INotification';
import type { ITerminalRunner } from '../interfaces/ITerminalRunner';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import { runnerModesFrom, type RunnerModeInfo } from './ModeResolver';

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
  grillMeEnabled: boolean;
  prdEnabled?: boolean;
  reviewEnabled?: boolean;
  verificationEnabled?: boolean;
  researchSubagentsEnabled?: boolean;
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
 * Everything a delivery surface constructs to host a session. Structural config
 * (enabledRunners, orchestratorModel, providerModelLists) is snapshotted inside
 * `config` at construction and never re-read from the environment. Runtime
 * settings (tdd, grillMe) are read live via the `settings` callback so a toggle
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
  /** Live runtime settings (tdd, grillMe). Read at each operation that needs them. */
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
}

// Session ids are timestamp-based; two mints inside the same millisecond
// (e.g. reset() right after construction) must still differ or they'd share
// one persisted session file.
let lastMintedAt = 0;
function mintSessionId(): string {
  lastMintedAt = Math.max(Date.now(), lastMintedAt + 1);
  return `session-${lastMintedAt}`;
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
        this.broadcast({ type: 'status_update', tasks: tasks.map(serializeTaskStatus) });
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
        this.broadcast({ type: 'status_update', tasks: tasks.map(serializeTaskStatus) });
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
    // drops the ones a one-shot run cannot honour, so review — which only
    // appends a task — stops being silently lost between here and the prompt.
    const settings = this.settingsFn();
    const { modelAllowlist } = settings;
    const modes = plannerModesFrom(settings, this.config.autonomousMode);

    const plan = await this.planner.generate({
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
    this.goal = goal;
    this.remintSessionId();
    this.beginFreshPlan();
    const enabled = this.config.enabledRunners;
    const chosenRunners = runners.filter((r) => enabled.includes(r));
    if (chosenRunners.length === 0) throw new Error('None of the requested runners are enabled');

    const modelsByRunner = await this.modelResolver.modelsForRunners(chosenRunners);
    this.modelsCache = modelsByRunner;
    const runnerModes = this.runnerModesFor(chosenRunners);
    const { grillMeEnabled, prdEnabled, reviewEnabled, verificationEnabled, researchSubagentsEnabled, modelAllowlist } = this.settingsFn();
    this.currentAllowlist = modelAllowlist ?? {};
    const filteredModels = filterModelsForPrompt(modelsByRunner, this.currentAllowlist);

    const now = new Date().toISOString();
    this.plan = {
      tasks: [],
      generatedAt: now,
      status: 'draft',
      runners: chosenRunners,
      lastUpdated: now,
      researchLog: [{ id: `up-${Date.now()}`, type: 'user_prompt', content: goal, timestamp: now }],
      conversationHistory: [{ role: 'user', content: goal, timestamp: now }],
    };

    const turn = await this.aiService.startConversation({
      goal,
      runners: chosenRunners,
      modelsByRunner: filteredModels,
      runnerModes,
      autonomousDefault: this.config.autonomousMode,
      grillMeEnabled: grillMeEnabled ?? false,
      prdEnabled: prdEnabled ?? false,
      reviewEnabled: reviewEnabled ?? false,
      verificationEnabled: verificationEnabled ?? false,
      researchSubagentsEnabled: researchSubagentsEnabled ?? false,
      fs: this.fsAdapter,
      fetcher: this.fetcher,
      onProgress: (p) => this.translateProgress(p),
      signal: options?.signal,
    });

    return this.settleTurn(turn, options);
  }

  /**
   * Every subsequent user reply in the planning conversation — grill-me
   * answers, PRD accept/adjust, outline confirm. One branch, no phase ladder.
   */
  async continueConversation(userMessage: string, options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    if (!this.plan) throw new Error('No planning conversation to continue');
    const priorHistory = this.plan.conversationHistory ?? [];
    const now = new Date().toISOString();
    this.appendTranscript('user', userMessage, now);
    this.plan.researchLog = [...(this.plan.researchLog ?? []), { id: `up-${Date.now()}`, type: 'user_prompt', content: userMessage, timestamp: now }];

    // The persisted transcript keeps the raw user message; the model gets the
    // current plan (tasks, statuses, edit protocol) alongside it.
    const contextBlock = this.planContextBlock();
    const outgoing = contextBlock ? `${contextBlock}\n\n${userMessage}` : userMessage;

    // A live conversation is only safe to continue in-place when it also
    // matches the model/effort configured right now — a harness planner's
    // running process was spawned with the old one baked in and cannot pick
    // up a switch (ADR-0009). `resumeConversation` handles both cases the
    // same way: tear down and restart, folding the transcript so far into the
    // opening message.
    const aiService = this.aiService;
    const canContinueLive = aiService.hasActiveConversation() && (aiService.conversationMatchesConfig?.() ?? true);
    let turn = canContinueLive
      ? await aiService.continueConversation(
          outgoing,
          (p) => this.translateProgress(p),
          options?.signal,
        )
      : await this.resumeConversation(outgoing, priorHistory, options);

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

    return this.settleTurn(turn, options);
  }

  /**
   * Drive a planner turn to a persisted, broadcast outcome. Task edits apply
   * atomically; validation failures are fed back to the model for up to 2
   * silent retries, then surfaced as a message with the plan untouched. The
   * first turn (startPlanning) and every later turn route through here — one
   * path, not two.
   */
  private async settleTurn(turn: ConversationTurn, options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    type Settled = { plan: LegacyPlanState } | { turn: Exclude<ConversationTurn, { kind: 'task_ops' }> };
    const invalidOps = (errors: string[], researchLog: ConversationTurn['researchLog']): Settled => ({
      turn: {
        kind: 'message',
        text: `I tried to modify the tasks, but the changes were invalid:\n- ${errors.join('\n- ')}\n\nThe plan is unchanged. Rephrase the request, or adjust the tasks manually.`,
        researchLog,
      },
    });

    const settled = await repairLoop<ConversationTurn, Settled>({
      first: () => turn,
      resend: (corrective) => this.aiService.continueConversation(
        corrective,
        (p) => this.translateProgress(p),
        options?.signal,
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
   * The "you are here" block for post-plan chat: current tasks with stable
   * references, plus the task-ops protocol. Injected per turn (never
   * persisted) so the model always sees live statuses — including which tasks
   * are locked by a running execution.
   */
  private planContextBlock(): string | null {
    if (!this.plan || this.store.planTasks.length === 0) return null;
    const orderOf = new Map(this.store.planTasks.map((t) => [t.id, `#${t.order}`]));
    const lines = this.store.planTasks.map((t) =>
      `#${t.order} id=${t.id} "${t.title}" [${t.status}] runner:${t.assignedRunner}${t.assignedModel ? ` model:${t.assignedModel.modelId}` : ''} deps:[${t.dependencies.map((d) => orderOf.get(d) ?? d).join(', ')}]`,
    );
    // Gated on live runners, not on `isExecuting`: a paused-but-armed run takes
    // edits immediately, so promising a queue there is a lie the model plans
    // around (it stops emitting ops and asks the user to wait).
    const locked = this.store.planTasks.filter((t) => t.status === 'in_progress');
    const execNote = this.hasLiveWork
      ? `\nExecution is RUNNING${locked.length ? ` — these tasks are locked: ${locked.map((t) => `#${t.order}`).join(', ')}` : ''}. Any task edits you emit will be queued and applied between batches.`
      : '';
    // Compact model availability so any task edit (add/merge/split/update) can
    // assign a valid runner + model without scrolling back to the system prompt.
    const modelLines: string[] = [];
    for (const runner of this.plan.runners) {
      const models = this.modelsCache[runner] ?? [];
      const ids = models.map((m) => m.modelId).join(', ');
      modelLines.push(`${runner}: ${ids || '(no models discovered)'}`);
    }
    const modelBlock = modelLines.length > 0
      ? ['<available_models>', ...modelLines, '</available_models>'].join('\n')
      : '';
    return [
      '<current_plan>',
      ...lines,
      '</current_plan>',
      modelBlock,
      'The block above is the CURRENT task plan. Choose how to respond:',
      '- To answer a question or discuss, reply in plain prose (no JSON).',
      '- To modify specific tasks, reply with ONLY this JSON object:',
      '  {"taskOps": [',
      '    {"op":"update","taskId":"<id or #order>","changes":{"title"?,"description"?,"prompt"?,"dependencies"?:["<id or #order>"],"assignedRunner"?,"assignedModel"?,"taskMode"?}},',
      '    {"op":"add","task":{"title","description","prompt","dependencies":["<id or #order>"],"assignedRunner"?,"assignedModel"?}},',
      '    {"op":"remove","taskId":"<id or #order>"},',
      '    {"op":"reorder","taskIds":["<id or #order>", "... every task exactly once"]},',
      '    {"op":"merge","taskIds":["<id or #order>", "..."],"merged":{"title","description","prompt"?,"assignedRunner"?,"assignedModel"?,...}},',
      '    {"op":"split","taskId":"<id or #order>","parts":[{"title","description","prompt"?,"assignedRunner"?,"assignedModel"?,...}, ...]}',
      '  ]}',
      '- For sweeping changes, you may instead emit a full {"tasks":[...]} plan JSON.',
      'When creating or changing tasks, set "assignedRunner" and "assignedModel" ({"modelId","modelLabel","thinkingEffort"?}) using only the runners and models listed in <available_models>.',
      'Keep dependencies consistent: no cycles, no references to removed tasks, dependencies must come before dependents, and never touch running or completed tasks.' + execNote,
    ].filter(Boolean).join('\n');
  }

  /** Validate + commit a task_ops turn atomically. Returns the errors on rejection (plan untouched). */
  private applyTaskOpsTurn(turn: Extract<ConversationTurn, { kind: 'task_ops' }>): { plan: LegacyPlanState } | { errors: string[] } {
    if (!this.plan) throw new Error('No active plan state');
    const result = applyTaskOps(this.store.planTasks, turn.ops, this.plan.runners);
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
    const { grillMeEnabled, prdEnabled, reviewEnabled, verificationEnabled, researchSubagentsEnabled, modelAllowlist } = this.settingsFn();
    this.currentAllowlist = modelAllowlist ?? {};
    const filteredModels = filterModelsForPrompt(modelsByRunner, this.currentAllowlist);
    const goal = this.goal || priorHistory.find((m) => m.role === 'user')?.content || userMessage;

    return this.aiService.startConversation({
      goal,
      runners,
      modelsByRunner: filteredModels,
      runnerModes,
      autonomousDefault: this.config.autonomousMode,
      grillMeEnabled: grillMeEnabled ?? false,
      prdEnabled: prdEnabled ?? false,
      reviewEnabled: reviewEnabled ?? false,
      verificationEnabled: verificationEnabled ?? false,
      researchSubagentsEnabled: researchSubagentsEnabled ?? false,
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

  /** Append one dialogue entry to the persisted transcript. Callers persist via the mutatePlan ritual. */
  private appendTranscript(role: 'user' | 'assistant', content: string, timestamp: string, kind?: 'plan_generated'): void {
    if (!this.plan) return;
    this.plan.conversationHistory = [
      ...(this.plan.conversationHistory ?? []),
      { role, content, timestamp, ...(kind ? { kind } : {}) },
    ];
  }

  /** Commit a settled (non-task_ops) turn. Both branches run the mutatePlan ritual. */
  private applyConversationTurn(turn: Exclude<ConversationTurn, { kind: 'task_ops' }>): LegacyPlanState {
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
   * Patch one task's fields. A hand-set dependency list is the one patch that
   * can leave the plan unschedulable, so it goes through the same
   * {@link canSetDependencies} guard the planner's pickers use rather than a
   * second copy of the rule — and throws, so the surface can say why.
   */
  async updateTask(taskId: string, changes: Partial<Task>): Promise<LegacyPlanState | null> {
    if (changes.dependencies) {
      const check = canSetDependencies(this.store.planTasks, taskId, changes.dependencies);
      if (!check.ok) throw new PlanEditError(check.error ?? 'Those dependencies are not valid');
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


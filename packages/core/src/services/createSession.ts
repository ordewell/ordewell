import { createAiService, type IAiService } from './AiService';
import { applyTaskOps, canMergeTasks, canSplitTask } from './TaskOps';
import { validateTaskEdit, type EditCatalog } from './TaskEditValidator';
import { ConversationEditError, PlannerConversation, type ConversationCompaction, type ConversationOpening, type RewindTarget } from './PlannerConversation';
import { forkPlanState } from './conversationFork';
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
import { buildConflictResolutionPrompt, buildMergePrompt, buildSplitPrompt } from './PlanPrompts';
import {
  serializeTask,
  serializeTaskStatus,
  serializePlan,
  executionSummary,
  type SessionBroadcaster,
  type SessionNotice,
} from './SessionMessage';
import { saveSession } from '../utils/sessionStore';
import { mintSessionId } from '../utils/sessionId';
import { savePrdMarkdown, extractPrdBlock } from '../utils/prdStore';
import { type DiscoveredModel, type LegacyPlanState, type PlanState, type Task, type TaskSnapshot, type RunnerId, type ResearchProgress } from '../models/Task';
import type { AiProvider, IConfig } from '../interfaces/IConfig';
import type { IFileSystem } from '../interfaces/IFileSystem';
import type { INotification } from '../interfaces/INotification';
import type { ITerminalRunner } from '../interfaces/ITerminalRunner';
import type { TaskOutputSource } from '../interfaces/TaskOutputSource';
import type { IsolationMergeResult, IsolationView, IWorktreeIsolation } from '../interfaces/IWorktreeIsolation';
import { integrationBranchNameOf, migratePlanStateIsolation } from './isolationRecord';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import { runnerModesFrom, resolveDefaultMode, type RunnerModeInfo } from './ModeResolver';

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
 * A `/skill-name` token anywhere in a message: whitespace (or string start)
 * before it, a lowercase-led name, optional trailing punctuation that isn't
 * part of the name, then whitespace (or string end). The punctuation group
 * is what lets "/grilling," resolve as "grilling" with the comma kept intact
 * in the output.
 */
const SKILL_TOKEN = /(^|\s)\/([a-z][a-z0-9_-]*)([,.!?;:]*)(?=\s|$)/gi;

/**
 * Resolve `/skill-name` invocations to their skill's markdown content. Pure
 * and exported so surfaces and verification can drive substitution without a
 * full Session.
 *
 * A message that is *only* `/skill-name` keeps the legacy whole-message
 * behaviour: an unknown skill becomes a notice naming what IS available,
 * instead of a bare slash token a runner would mis-resolve in its own skills
 * directory. Anywhere else in a message, a matching token is spliced in place
 * (surrounding text is untouched); a token that doesn't name a real skill is
 * left as plain text rather than raising a notice, since embedded in a
 * sentence it's as likely to be incidental text (a path, an example command)
 * as a typo'd invocation. The same skill name repeated only expands its first
 * occurrence — later repeats stay literal.
 */
export function resolveSkillInvocation(
  text: string,
  skillsService: Pick<SkillsService, 'findSkill' | 'listSkills'>,
): string {
  const bareMatch = text.trim().match(/^\/([a-z][a-z0-9_-]*)$/im);
  if (bareMatch) {
    const skillName = bareMatch[1].toLowerCase();
    const skill = skillsService.findSkill(skillName);
    if (!skill) {
      const available = typeof skillsService.listSkills === 'function'
        ? skillsService.listSkills().map((s) => s.name).join(', ')
        : '';
      return `Unknown skill: ${skillName}. Available skills: ${available}`;
    }
    return skill.content;
  }

  const expanded = new Set<string>();
  return text.replace(SKILL_TOKEN, (full, lead: string, name: string, punct: string) => {
    const skillName = name.toLowerCase();
    if (expanded.has(skillName)) return full;
    const skill = skillsService.findSkill(skillName);
    if (!skill) return full;
    expanded.add(skillName);
    return `${lead}${skill.content}${punct}`;
  });
}

/**
 * Everything a delivery surface constructs to host a session. Structural config
 * (enabledRunners, orchestratorModel, providerModelLists) is snapshotted inside
 * `config` at construction and never re-read from the environment. Runtime
 * settings (tdd, verification) are read live via the `settings` callback so a toggle
 * between generate and execute takes effect.
 */
/** Where a fork landed: the new session's id, and what adopting it needs. */
export interface ConversationFork {
  sessionId: string;
  goal: string;
  workspace: string;
}

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
  /** Where {@link SessionNotice}s go, for a host whose `notifications` are not seen by the user. */
  onNotice?: (notice: SessionNotice) => void;
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
  /**
   * Where a task's output and final answer are read. Defaults to the agents'
   * own transcripts under the user's home; tests inject one that never
   * touches the disk.
   */
  taskOutput?: TaskOutputSource;
  /**
   * Git worktree isolation (ADR-0013). Defaults to git itself, gated by
   * `config.worktreeIsolation`; tests inject `FakeWorktreeIsolation`.
   */
  isolation?: IWorktreeIsolation;
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
  private onNotice?: (notice: SessionNotice) => void;
  private modelResolver: ModelResolver;
  private fsAdapter: IFileSystem;
  private approvals: PendingApprovals;
  private approvalPolicy: ApprovalPolicy;
  private fetcher: HttpWebFetcher;
  private settingsFn: () => SessionRuntimeSettings;
  /** Last discovered model catalog — lets sync plan commits clamp thinking efforts to real variants. */
  private modelsCache: Partial<Record<RunnerId, DiscoveredModel[]>> = {};
  private unsubObserver: (() => void) | null = null;
  private readonly hostSessionId?: string;
  private currentSessionId: string;
  private readonly skillsService: SkillsService;
  private readonly conversation: PlannerConversation;

  constructor(deps: SessionDeps) {
    this.config = deps.config;
    this.registry = deps.registry;
    this.pinnedAiService = deps.aiService;
    this.workspaceRootFn = deps.workspaceRoot;
    this.planner = deps.planner ?? new Planner(deps.config, () => this.aiService);
    this.store = new PlanStore();
    this.orchestrator = new TaskOrchestrator(deps.config, deps.notifications, deps.runner, this.store, deps.taskOutput, deps.isolation);
    this.orchestrator.setRegistry(deps.registry);
    this.orchestrator.setWorkspaceRoot(deps.workspaceRoot);
    this.orchestrator.setTddEnabled(() => this.settingsFn().tddEnabled);
    this.workspace = deps.workspaceRoot();
    this.broadcast = deps.broadcast;
    this.onNotice = deps.onNotice;
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

    this.conversation = new PlannerConversation({
      plan: () => this.plan,
      goal: () => this.goal,
      aiService: () => this.aiService,
      onProgress: (p) => this.translateProgress(p),
      opening: (runners) => this.conversationOpening(runners),
      catalog: () => {
        const runners = this.plan?.runners ?? [];
        return {
          runners,
          // Allowlist-filtered: neither the per-turn block nor a read may offer
          // a model the planner is forbidden to assign.
          models: filterModelsForPrompt(this.models(), this.allowlist()),
          modes: this.runnerModesFor(runners),
          autonomousDefault: this.config.autonomousMode,
        };
      },
      tasks: () => this.store.planTasks,
      liveOutput: (taskId, opts) => this.orchestrator.getLiveOutput(taskId, opts),
      hasLiveWork: () => this.hasLiveWork,
      mutate: (op, notify) => this.mutatePlan(op, notify),
      broadcast: (msg) => this.broadcast(msg),
      broadcastPlan: () => this.broadcastPlan(),
      validateOps: (ops) => applyTaskOps(this.store.planTasks, ops, this.plan!.runners, this.editCatalog()),
      adoptTasks: (tasks, how) => this.adoptPlannerTasks(tasks, how),
      capturePrd: (text) => this.capturePrd(text),
      queueEdit: (userMessage) => {
        this.queueMessage(userMessage);
        this.plan!.queuedMessages = this.getQueuedMessages();
        return this.queuedCount;
      },
      afterEdit: () => this.orchestrator.tick(),
    });

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
      onTaskChanged: () => this.broadcastStatus(),
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
      onTick: () => this.broadcastStatus(),
      onIsolationChanged: () => {
        // The run record names branches and worktrees on disk, so it is saved
        // as it changes rather than at the end: a crash must still find them.
        this.persist();
        this.broadcastStatus();
      },
      onIsolationBlocked: ({ reason, repos }) => {
        const where = repos.length > 0 ? ` in ${repos.join(', ')}` : '';
        this.broadcast({
          type: 'isolation_blocked',
          reason,
          ...(repos.length > 0 ? { repos } : {}),
          message: `Tracked files have uncommitted changes${where}, so tasks cannot run in isolated worktrees. Stash them, or run this plan without isolation.`,
        });
      },
      onIsolationNotice: ({ level, message }) => {
        this.onNotice?.({ type: 'notice', level, message });
      },
      onIsolationHandoff: (handoff) => {
        this.broadcast({ type: 'isolation_handoff', ...handoff });
      },
      onExecutionComplete: () => {
        if (!this.plan) return;
        const tasks = this.store.allTasks;
        this.broadcast({ type: 'execution_complete', summary: executionSummary(tasks) });
        this.persist();
      },
    };
  }

  private broadcastStatus(): void {
    if (!this.plan) return;
    const tasks = this.store.allTasks;
    this.broadcast({
      type: 'status_update',
      tasks: tasks.map((t) => serializeTaskStatus(t, this.orchestrator.getIdleSince(t.id), this.orchestrator.getTaskIsolation(t.id))),
    });
  }

  private translateProgress(progress: ResearchProgress): void {
    if (progress.type === 'liveness') {
      this.broadcast({ type: 'planner_liveness' });
    }
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
    this.plan.isolation = this.orchestrator.isolationRecord ?? undefined;
    this.plan.lastUpdated = new Date().toISOString();
    saveSession(this.plan, this.goal, this.workspace, this.currentSessionId);
    this.conversation.markPersisted();
  }

  /** A new plan on a long-lived Session gets its own persisted identity (unless the host fixed one). */
  private remintSessionId(): void {
    if (!this.hostSessionId) this.currentSessionId = mintSessionId();
  }

  /**
   * A new plan starts from zero: drop the live planner conversation and every
   * task, log, and queued message left over from a previous plan on this
   * Session. Without this, a long-lived Session (VS Code hosts exactly one)
   * leaks the previous session's tasks into the per-turn plan block — the
   * model is told they are the CURRENT plan and re-presents them as its draft.
   */
  private beginFreshPlan(): void {
    if (this.isExecuting) this.stopExecution();
    this.conversation.reset();
    // A prompt raised by the turn we are abandoning has nobody left to serve;
    // denying it unblocks the old research loop instead of stranding it.
    this.approvals.clear();
    this.orchestrator.clearQueuedMessages();
    this.store.clearLog();
    this.orchestrator.loadPlan([]);
    void this.orchestrator.adoptIsolation(null);
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
    this.remintSessionId();
  }

  private runnerModesFor(runners: RunnerId[]): Record<RunnerId, RunnerModeInfo[]> {
    return runnerModesFrom(this.registry, runners);
  }

  /**
   * The catalog a model/task-mode edit is checked against — the same
   * discovered models and manifest modes the per-turn catalog block shows the
   * planner, so a refusal here can never name something invalid that the
   * planner was never told about. The catalog is not filtered by the
   * allowlist here — {@link checkModelAndModeValidity} narrows by
   * allowlist itself, the same way `coerceAssignments` does.
   */
  private editCatalog(): EditCatalog {
    return {
      modelsByRunner: this.models(),
      runnerModes: this.runnerModesFor(this.plan?.runners ?? []),
      perRunnerAllowlist: this.allowlist(),
    };
  }

  /**
   * The allowlist in force right now. Unset means no restriction — falling
   * back to the one planning started under would keep a restriction the user
   * has since cleared.
   */
  private allowlist(): Record<string, string[]> {
    return this.settingsFn().modelAllowlist ?? {};
  }

  /**
   * The discovered catalog as the resolver holds it now, per runner, with this
   * session's own discovery as the fallback where the resolver has nothing
   * cached. The resolver's cache outlives this session's snapshot in both
   * directions — an allowlist picker re-discovers into it mid-session — and a
   * model allowed after that must reach the planner with its real label and
   * variants, not as an id-only stub. Never triggers discovery itself.
   */
  private models(): Partial<Record<RunnerId, DiscoveredModel[]>> {
    const out = { ...this.modelsCache };
    for (const runner of new Set([...Object.keys(out), ...(this.plan?.runners ?? [])])) {
      const cached = this.modelResolver.getCachedRunnerModels(runner);
      if (cached.length > 0) out[runner] = cached;
    }
    return out;
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

    const { modelsByRunner, runnerModes, settings } = await this.plannerCatalog(chosenRunners);
    // Every planner toggle, not the two this path used to remember: `modesFor`
    // drops the ones a one-shot run cannot honour, so a structural toggle like
    // verify — which only appends a task — stops being silently lost between
    // here and the prompt.
    const modes = { ...plannerModesFrom(settings, this.config.autonomousMode), isolatedExecution: await this.orchestrator.plannerIsolation() };

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
        perRunnerAllowlist: settings.modelAllowlist,
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
   * message. The conversation itself — transcript, live model context, turn
   * settlement — is {@link PlannerConversation}'s; the Session hosts it.
   */
  async startPlanning(goal: string, runners: RunnerId[], options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    this.plan = null;
    this.goal = this.resolveSkillInvocation(goal);
    this.remintSessionId();
    this.beginFreshPlan();
    const enabled = this.config.enabledRunners;
    const chosenRunners = runners.filter((r) => enabled.includes(r));
    if (chosenRunners.length === 0) throw new Error('None of the requested runners are enabled');

    const opening = await this.conversationOpening(chosenRunners);
    const now = new Date().toISOString();
    this.plan = { tasks: [], generatedAt: now, status: 'draft', runners: chosenRunners, lastUpdated: now };

    const releaseAbort = this.denyApprovalsOnAbort(options?.signal);
    try {
      return await this.conversation.start(this.goal, opening, options?.signal);
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
    const releaseAbort = this.denyApprovalsOnAbort(options?.signal);
    try {
      return await this.conversation.reply(this.resolveSkillInvocation(userMessage), {
        signal: options?.signal,
        verbatim: userMessage,
      });
    } finally {
      releaseAbort();
    }
  }

  /**
   * Copy this conversation and its task list into a new persisted session and
   * answer its id. This session is untouched — not even its live planner
   * context, so the original carries on exactly where it was. The fork holds
   * no run (see {@link forkPlanState}); a host adopts it like any saved
   * session, and its first message replays the copied transcript.
   */
  forkConversation(): ConversationFork {
    if (!this.plan) throw new ConversationEditError('No planning conversation to fork');
    const dialogue = this.conversation.clone();
    const sessionId = mintSessionId();
    const plan = forkPlanState(this.plan, this.store.planTasks, dialogue, new Date().toISOString());
    saveSession(plan, this.goal, this.workspace, sessionId);
    return { sessionId, goal: this.goal, workspace: this.workspace };
  }

  /**
   * Cut the conversation back to just before a user message (a transcript
   * position from {@link rewindTargets}). Conversation only: the task list,
   * and any run executing it, carry on as they are. The planner's live context
   * is dropped, so the next message replays from the shortened transcript.
   */
  rewindConversation(userMessageIndex: number): LegacyPlanState {
    if (!this.plan) throw new ConversationEditError('No planning conversation to rewind');
    return this.conversation.rewind(userMessageIndex);
  }

  /**
   * Condense the conversation on the user's say-so: a hidden planner turn
   * summarises it, and the summary replaces everything but the last two
   * exchanges. Conversation only, like a rewind — the tasks, and any run
   * executing them, are untouched. Atomic: a failed or stopped turn changes
   * nothing.
   */
  async compactConversation(signal?: AbortSignal): Promise<ConversationCompaction> {
    if (!this.plan) throw new ConversationEditError('No planning conversation to condense');
    const releaseAbort = this.denyApprovalsOnAbort(signal);
    try {
      return await this.conversation.compact(signal);
    } finally {
      releaseAbort();
    }
  }

  rewindTargets(): RewindTarget[] {
    return this.conversation.rewindTargets();
  }

  /** Whether the planner conversation is live (started and not yet committed to a plan). */
  get isConversationActive(): boolean {
    return this.conversation.isActive;
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

  /**
   * The one place planning discovers what it may draw from: the runners'
   * models (cached for later effort clamping), their modes, and the settings
   * in force. `filteredModels` is the allowlisted view a prompt may show;
   * `modelsByRunner` stays whole because coercion needs real labels and variants.
   */
  private async plannerCatalog(runners: RunnerId[]) {
    const modelsByRunner = await this.modelResolver.modelsForRunners(runners);
    this.modelsCache = modelsByRunner;
    const settings = this.settingsFn();
    return {
      modelsByRunner,
      filteredModels: filterModelsForPrompt(modelsByRunner, settings.modelAllowlist ?? {}),
      runnerModes: this.runnerModesFor(runners),
      settings,
    };
  }

  private async conversationOpening(runners: RunnerId[]): Promise<ConversationOpening> {
    const { filteredModels, runnerModes, settings } = await this.plannerCatalog(runners);
    return {
      runners,
      modelsByRunner: filteredModels,
      runnerModes,
      autonomousDefault: this.config.autonomousMode,
      verificationEnabled: settings.verificationEnabled ?? false,
      isolatedExecution: await this.orchestrator.plannerIsolation(),
      fs: this.fsAdapter,
      fetcher: this.fetcher,
    };
  }

  /**
   * Load planner-produced tasks, coerced to the allowlist read live — it may
   * have changed since planning started. An edit on an armed scheduler is
   * reconciled rather than reloaded: `loadPlan` clears the on-hold set and the
   * review approval, so a task the user cancelled would be re-armed and
   * re-spawned by the re-tick that follows.
   */
  private adoptPlannerTasks(tasks: Task[], how: 'edit' | 'commit'): number {
    const runners = this.plan!.runners;
    const coerced = coerceAssignments(tasks, this.allowlist(), runners, this.models());
    if (how === 'edit' && this.orchestrator.isRunning) {
      this.orchestrator.reconcilePlan(coerced, runners);
    } else {
      this.orchestrator.loadPlan(coerced, runners);
      this.store.resetForRun(how === 'commit' ? { preserveCompleted: false } : undefined);
    }
    return coerced.length;
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

    if (!this.orchestrator.isRunning && !this.orchestrator.awaitingIsolationChoice) {
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
      isolatedExecution: await this.orchestrator.plannerIsolation(),
    });

    this.mutatePlan(() => {
      this.orchestrator.reconcilePlan(result.pendingTasks, this.plan!.runners);
      this.conversation.recordQueuedEdits(messages.map((m) => m.text), result.pendingTasks.length);
      return true;
    });

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

  /** Replay a run a dirty tree blocked, after stashing the tracked changes. */
  async continueWithStash(): Promise<void> {
    await this.orchestrator.continueBlockedRun('stash');
    this.persist();
  }

  /** Replay a run a dirty tree blocked, in the workspace root, for this run only. */
  async continueWithoutIsolation(): Promise<void> {
    await this.orchestrator.continueBlockedRun('shared');
    this.persist();
  }

  /**
   * Each task's isolation mark and the run's handoff, read from the run record.
   * The stream reports changes only; a surface that (re)connects or loads a
   * session asks here instead.
   */
  isolationView(): IsolationView | null {
    return this.orchestrator.isolationView();
  }

  /** The run's integration branch against its base ref, as a unified diff. */
  async reviewRunDiff(): Promise<string> {
    if (!this.orchestrator.isolationRecord) throw new PlanEditError('This plan has no isolated run');
    return this.orchestrator.reviewRunDiff();
  }

  /**
   * "Merge all": each repo's integration branch into whatever the user has
   * checked out there — every repo, or none if any cannot take it. The one
   * irreversible step of isolated execution, so this explicit call is the
   * only way it ever happens.
   */
  async mergeRun(): Promise<IsolationMergeResult> {
    this.requireSettledRun();
    const result = await this.orchestrator.mergeRun();
    this.broadcast({ type: 'isolation_merge', result });
    return result;
  }

  /** Remove the run's worktrees and task branches; keep its integration branch to review or merge. */
  async cleanupRun(): Promise<void> {
    this.requireSettledRun();
    await this.orchestrator.cleanupRun();
    this.persist();
  }

  /**
   * Give the whole run up, integration branch included. The plan is not
   * rewritten: a task that landed there stays completed until the user says
   * otherwise (Mark not done), because only they know whether they kept the work.
   */
  async discardRun(): Promise<void> {
    this.requireSettledRun();
    await this.orchestrator.discardRun();
    this.persist();
  }

  private requireSettledRun(): void {
    if (!this.orchestrator.isolationRecord) throw new PlanEditError('This plan has no isolated run');
    if (this.orchestrator.isRunning) throw new PlanEditError('The run is still running — stop it first');
  }

  /**
   * The opt-in way through a merge conflict: add an AI task, on the conflicted
   * task's own runner and model, that merges its branch by hand in a worktree
   * of its own. When that task lands, the conflicted one lands through it (see
   * {@link TaskOrchestrator.linkConflictResolver}). Never automatic — nothing
   * but this call adds it.
   */
  async resolveConflictAsTask(taskId: string): Promise<LegacyPlanState | null> {
    if (!this.plan) return null;
    const task = this.store.get(taskId);
    const isolation = this.orchestrator.getTaskIsolation(taskId);
    const run = this.orchestrator.isolationRecord?.run;
    if (!task || !run || isolation?.state !== 'conflict') {
      throw new PlanEditError('Only a task whose merge conflicted can be resolved as a task');
    }
    return this.editPlan(() => {
      const resolver = this.store.add({
        title: `Resolve merge conflict: ${task.title}`,
        description: `Merge ${isolation.branch} into ${integrationBranchNameOf(run)} by hand.`,
        type: 'ai',
        prompt: buildConflictResolutionPrompt(task, isolation, integrationBranchNameOf(run)),
        assignedRunner: task.assignedRunner,
        assignedModel: task.assignedModel,
        thinkingEffort: task.thinkingEffort,
        taskMode: task.taskMode,
        autonomy: 'AFK',
        sliceType: 'AFK',
        dependencies: [],
      });
      this.orchestrator.linkConflictResolver(resolver.id, taskId);
      return true;
    });
  }

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
   * {@link PlannerConversation} instead (`afterEdit`); it must not tick twice.
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
    const modes = this.runnerModesFor([runner])[runner];
    return {
      models: (await this.modelResolver.modelsForRunners([runner]))[runner] ?? [],
      modes,
      defaultMode: resolveDefaultMode(modes, this.config.autonomousMode),
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
      { ...this.models(), [runner]: catalog.models },
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
      this.conversation.reset();
      // The execution log and queued messages are scoped to the outgoing plan;
      // callers restoring a saved queue re-apply it after adoption.
      this.store.clearLog();
      this.orchestrator.clearQueuedMessages();
      // Approval scopes are equally session-scoped: a path or command approved
      // for the previous plan must not stay approved for the newly adopted one.
      this.approvals.clear();
      this.approvalPolicy.reset();
    }
    const adopting = plan !== this.plan;
    this.plan = plan;
    this.goal = goal;
    this.workspace = workspace;
    // Adopting the saved session's id keeps subsequent persists writing to the
    // same file instead of forking the session under a fresh identity.
    if (opts?.sessionId) this.currentSessionId = opts.sessionId;
    this.orchestrator.loadPlan(plan.tasks, plan.runners);
    migratePlanStateIsolation(plan);
    // The run record is taken synchronously; only the orphan prune is awaited
    // in the background, and git serializes it ahead of any worktree a run adds.
    if (adopting) void this.orchestrator.adoptIsolation(plan.isolation ?? null);
    if (opts?.persist !== false) this.persist();
  }

  async modifyPlan(userRequest: string): Promise<Task[]> {
    if (!this.plan) throw new Error('No plan to modify');
    const requestedAt = new Date().toISOString();
    const { modelsByRunner, runnerModes, settings } = await this.plannerCatalog(this.plan.runners);
    const result = await this.planner.modify({
      existingPlan: this.plan,
      userRequest,
      modelsByRunner,
      runnerModes,
      autonomousDefault: this.config.autonomousMode,
      fs: this.fsAdapter,
      fetcher: this.fetcher,
      perRunnerAllowlist: settings.modelAllowlist,
    });
    // The exchange lands only with its outcome, so a failed modification
    // leaves nothing behind to roll back.
    this.mutatePlan(() => {
      this.orchestrator.loadPlan(result.tasks, this.plan!.runners);
      this.conversation.recordModification(userRequest, requestedAt, result.tasks.length);
      return true;
    });
    return result.tasks;
  }

  destroy(): void {
    this.stopExecution();
    // Planning research runs on a separate conduit from task execution — a
    // live spawn_research_agent/bash tool call would otherwise keep running
    // server-side after the client has already moved on to a new session.
    this.conversation.reset();
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


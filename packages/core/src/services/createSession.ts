import { createAiService, type IAiService } from './AiService';
import { applyTaskOps, type TaskOp } from './TaskOps';
import type { TaskQueryCatalog } from './TaskQuery';
import { SessionCatalog } from './SessionCatalog';
import { plannerToolHandler, runnersOf, PLANNER_TURN_ENDED, type PlanEditOutcome } from './plannerTools';
import { sharedMcpServer, type OrdewellMcpServer, type PlannerToolHandler } from './mcp';
import { ConversationEditError, PlannerConversation, PlannerTurnDiscardedError, type ConversationCompaction, type ConversationOpening, type PlannerConversationHost, type PlannerSubmission, type RewindTarget } from './PlannerConversation';
import { forkPlanState, type ForkedDialogue } from './conversationFork';
import { Planner } from './Planner';
import { TaskOrchestrator, type OrchestratorObserver } from './TaskOrchestrator';
import { PlanStore } from './PlanStore';
import { ApprovalPolicy } from './ApprovalPolicy';
import { PendingApprovals, type PendingApproval } from './PendingApprovals';
import { RunnerApprovals } from './RunnerApprovals';
import { approvalScopes, isRunnerApproval, type ApprovalAnswer, type ApprovalRequest } from '../interfaces/IApproval';
import { HttpWebFetcher } from './HttpWebFetcher';
import { ModelResolver } from './ModelResolver';
import { coerceAssignments } from './ModelAllowlistResolver';
import { plannerModesFrom } from './plannerModes';
import type { UserSettings } from './SettingsService';
import { SkillsService } from './SkillsService';
import { plannerMessage, resolveSkillInvocation, type SkillInvocation } from './skillInvocation';
import { plannedSkillLookup, type SkillCatalogLookup } from './taskSkills';
import type { MergeGateView, SessionBroadcaster, SessionNotice } from './SessionMessage';
import { SessionEventRelay } from './SessionEventRelay';
import { saveSession } from '../utils/sessionStore';
import { listTaskLogAttempts, readTaskLog, type TaskLogFile, type TaskLogLocation } from '../utils/taskLogStore';
import { digestTaskLog, type TaskLogEvent } from '../models/TaskLog';
import { TaskLogRecorder } from './TaskLogRecorder';
import { PlannerUsageLedger } from './PlannerUsage';
import { mintSessionId } from '../utils/sessionId';
import { savePrdMarkdown, extractPrdBlock } from '../utils/prdStore';
import { flattenTasks, keepExecutionState, DEFAULT_RUNNERS, type LegacyPlanState, type PlanState, type QueuedMessage, type Task, type TaskSnapshot, type RunnerId } from '../models/Task';
import { AlreadyExecutingError, NoPlanError } from './SessionErrors';
import type { AiProvider, IConfig } from '../interfaces/IConfig';
import type { IFileSystem } from '../interfaces/IFileSystem';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { INotification } from '../interfaces/INotification';
import type { ITerminalRunner } from '../interfaces/ITerminalRunner';
import type { TaskOutputSource } from '../interfaces/TaskOutputSource';
import type { IsolationMergeResult, IsolationView, IWorktreeIsolation } from '../interfaces/IWorktreeIsolation';
import { migratePlanStateIsolation } from './isolationRecord';
import type { IsolationRunController } from './IsolationRunController';
import { PlanEditor } from './PlanEditor';
import { PlanEditError } from './PlanEditError';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';

/**
 * Options for plan generation. Progress is not overridable: every planner
 * progress event is translated to a SessionMessage inside the Session and
 * emitted through the broadcast seam, so all surfaces consume one union.
 */
export interface GeneratePlanOptions {
  signal?: AbortSignal;
}

/** The slice of Planner the Session drives — the injection seam for tests. */
export type SessionPlanner = Pick<Planner, 'generate' | 'modifyDuringExecution'>;

/** Runtime prefs read live — may toggle between operations. */
export interface SessionRuntimeSettings {
  modelAllowlist?: Record<string, string[]>;
  /** Absent means the user never chose, and `config.enabledRunners` (the host's defaults) decides. */
  enabledRunners?: RunnerId[];
}

/** Calls an ops retry is told about; earlier ones are counted, not listed (ADR-0020). */
const OPS_RETRY_DIGEST_CALLS = 20;

/** What the task's newest saved attempt did, or null when it left nothing to report. */
function lastAttemptDigest(location: TaskLogLocation, taskId: string): string | null {
  const attempt = listTaskLogAttempts(location, taskId).pop();
  if (attempt === undefined) return null;
  const events = readTaskLog(location, taskId, attempt);
  return events.length > 0 ? digestTaskLog(events, OPS_RETRY_DIGEST_CALLS) : null;
}

export function sessionRuntimeSettings(settings: UserSettings): SessionRuntimeSettings {
  return {
    modelAllowlist: settings.modelAllowlist,
    enabledRunners: settings.enabledRunners,
  };
}

/** Where a fork landed: the new session's id, and what adopting it needs. */
export interface ConversationFork {
  sessionId: string;
  goal: string;
  workspace: string;
}

/** A fork made by a rewind, and the full text of the message it was made just before. */
export interface ConversationRewind extends ConversationFork {
  rewoundMessage: string;
}

/** Writes one plan to the saved-session store: {@link saveSession}'s shape, injected so tests never touch disk. */
export type SaveSession = (plan: LegacyPlanState, goal: string, workspace: string, sessionId: string) => void;

/**
 * Everything a delivery surface constructs to host a session. Structural config
 * (orchestratorModel, providerModelLists) is snapshotted inside `config` at
 * construction and never re-read from the environment. Runtime settings
 * (enabled runners) are read live via the `settings` callback so a
 * toggle between operations takes effect.
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
  /** Where {@link SessionNotice}s go, for a host whose `notifications` are not seen by the user. */
  onNotice?: (notice: SessionNotice) => void;
  /** Shared across sessions — sole producer of model catalogs and routing lists. */
  modelResolver: ModelResolver;
  /** Live runtime settings (enabled runners). Read at each operation that needs them. */
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
  /** Persistence seam. Defaults to the saved-session store under the workspace. */
  saveSession?: SaveSession;
  /** Where a structured task's log is saved (ADR-0018, P1). Defaults to a file per attempt beside the session's. */
  openTaskLog?: (location: TaskLogLocation, taskId: string) => TaskLogFile;
  /** The Ordewell MCP server a harness planner's tools are served from (ADR-0022). Defaults to the process's one. */
  mcpServer?: OrdewellMcpServer;
}

/**
 * The planner transport for the provider configured *right now* (ADR-0009).
 *
 * Resolved on every read rather than once at construction, because a
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
function liveAiService(config: IConfig, workspaceRoot: () => string, mcpServer: OrdewellMcpServer): () => IAiService {
  let live: IAiService | null = null;
  let liveProvider: AiProvider | null = null;
  return () => {
    const provider = config.aiProvider;
    if (live && liveProvider === provider) return live;
    live?.reset();
    live = createAiService(config, { workspaceRoot, mcpServer });
    liveProvider = provider;
    return live;
  };
}

/**
 * The planner's own prompts. A turn's abort or a plan change settles these;
 * a task runner's request belongs to its attempt, and is denied when that
 * attempt's runner stops.
 */
function isPlannerApproval(request: ApprovalRequest): boolean {
  return !isRunnerApproval(request);
}

/**
 * The composition root: builds every collaborator a Session drives and wires
 * them to each other, so the Session only receives them. Hosts create a
 * Session here; the optional {@link SessionDeps} are the seams tests fill.
 */
export function createSession(deps: SessionDeps): Session {
  const pinnedAiService = deps.aiService;
  const aiService = pinnedAiService ? () => pinnedAiService : liveAiService(deps.config, deps.workspaceRoot, deps.mcpServer ?? sharedMcpServer());
  const store = new PlanStore();
  const taskLogs = new TaskLogRecorder({
    broadcast: deps.broadcast,
    // Read through the Session, whose id and workspace are the ones it saves
    // under and can change with a plan. Only read once a task spawns.
    location: () => session.taskLogLocation,
    open: deps.openTaskLog,
  });
  // Made by the Session (it is the conversation's host); an approval prompt
  // names the turn that raised it, so the chain below reads it once it exists.
  let conversation: PlannerConversation | undefined;

  // The approval chain: the filesystem asks the policy, the policy asks the
  // registry, the registry announces on the same broadcast seam every other
  // planner event uses, and any surface answers through `resolveApproval`.
  // Nothing in core knows which UI is listening.
  //
  // A task runner's request (ADR-0018, A1) rides the task's log instead: it
  // is not the planner's, so it never becomes a card in the conversation.
  // What changes is the task's status, "waiting for approval".
  const approvals = new PendingApprovals({
    onRequest: ({ id, request }) => {
      if (isRunnerApproval(request)) {
        events.status(session.planState);
        return;
      }
      deps.broadcast({
        type: 'approval_request',
        id,
        kind: request.kind,
        subject: request.subject,
        scope: approvalScopes(request).join(', '),
        detail: request.detail,
        turnId: conversation?.currentTurnId,
      });
    },
    onSettled: (id, granted, { request }) => {
      if (isRunnerApproval(request)) events.status(session.planState);
      else deps.broadcast({ type: 'approval_settled', id, granted });
    },
  });
  const runnerApprovals = new RunnerApprovals(approvals);
  const orchestrator = TaskOrchestrator.compose({
    config: deps.config,
    notifications: deps.notifications,
    terminalRunner: taskLogs.wrap(runnerApprovals.wrap(deps.runner)),
    store,
    output: deps.taskOutput,
    isolation: deps.isolation,
    registry: deps.registry,
    workspaceRoot: deps.workspaceRoot,
    skillsAt: (roots) => (deps.skillsService ?? new SkillsService(roots)).forRoot(roots),
    previousAttemptFromLog: (taskId) => lastAttemptDigest(session.taskLogLocation, taskId),
  });
  const usage = new PlannerUsageLedger();
  const events = new SessionEventRelay({
    broadcast: deps.broadcast, onNotice: deps.onNotice, store, orchestrator, runs: orchestrator.runs, usage,
    awaitingApproval: (taskId) => runnerApprovals.waiting(taskId),
    checkpointQuestion: (taskId) => orchestrator.getCheckpointQuestion(taskId),
  });

  const approvalPolicy = new ApprovalPolicy({
    mode: deps.config.approvalMode,
    preApproved: deps.config.approvalPreApproved,
    ask: (req) => approvals.ask(req),
    // The interactive path (`asked`) already broadcasts approval_request +
    // approval_settled; only the silent sources need a signal, or a
    // remembered/pre-approved/mode grant is invisible to every surface.
    onDecision: (req, granted, source) => {
      if (source === 'asked') return;
      deps.broadcast({
        type: 'approval_decided',
        kind: req.kind,
        subject: req.subject,
        scope: approvalScopes(req).join(', '),
        detail: req.detail,
        granted,
        source,
      });
    },
  });
  deps.fsAdapter.setApproval?.(approvalPolicy);

  const catalog = new SessionCatalog({
    config: deps.config,
    registry: deps.registry,
    modelResolver: deps.modelResolver,
    settings: deps.settings,
    // Read through the Session, which holds the plan; the catalog is built first.
    planRunners: (): RunnerId[] => session.planState?.runners ?? [],
  });

  const session = new Session({
    config: deps.config,
    catalog,
    workspace: deps.workspaceRoot(),
    fsAdapter: deps.fsAdapter,
    broadcast: deps.broadcast,
    notifications: deps.notifications,
    onNotice: deps.onNotice,
    modelResolver: deps.modelResolver,
    settings: deps.settings,
    hostSessionId: deps.sessionId,
    aiService,
    planner: deps.planner ?? new Planner(deps.config, aiService),
    store,
    orchestrator,
    runs: orchestrator.runs,
    events,
    usage,
    approvals,
    approvalPolicy,
    // `fetch`/`web_search` route through the same approval channel as paths and
    // commands — one decision surface for everything that leaves the workspace.
    fetcher: new HttpWebFetcher({ approval: approvalPolicy }),
    skillsService: deps.skillsService ?? new SkillsService(deps.workspaceRoot()),
    saveSession: deps.saveSession ?? saveSession,
    conversation: (host) => (conversation = new PlannerConversation(host)),
  });
  return session;
}

/** What {@link createSession} hands a Session: every collaborator, already built and wired. */
export interface SessionParts {
  config: IConfig;
  catalog: SessionCatalog;
  workspace: string;
  fsAdapter: IFileSystem;
  broadcast: SessionBroadcaster;
  notifications: INotification;
  onNotice?: (notice: SessionNotice) => void;
  modelResolver: ModelResolver;
  settings: () => SessionRuntimeSettings;
  hostSessionId?: string;
  aiService: () => IAiService;
  planner: SessionPlanner;
  store: PlanStore;
  orchestrator: TaskOrchestrator;
  /** The orchestrator's own: Session reads the run and acts on it there, Merge all aside. */
  runs: IsolationRunController;
  events: SessionEventRelay;
  usage: PlannerUsageLedger;
  approvals: PendingApprovals;
  approvalPolicy: ApprovalPolicy;
  fetcher: IWebFetcher;
  skillsService: Pick<SkillsService, 'findSkill' | 'listSkills' | 'searchedDirs' | 'forRoot'>;
  saveSession: SaveSession;
  /** The conversation's host is the Session itself, so only the Session can make it. */
  conversation: (host: PlannerConversationHost) => PlannerConversation;
}

/**
 * The per-session execution stack — the lifecycle owner. Owns plan
 * generation, execution, mutation and persistence; built by
 * {@link createSession}, which wires its collaborators. The orchestrator's
 * observer is subscribed once for the session's lifetime (not per-operation),
 * which kills the double-subscribe class of bug. Persistence is an internal
 * seam: every plan mutation routes through `persist()`.
 *
 * What surfaces see is produced by the {@link SessionEventRelay}: the
 * {@link SessionMessage} plan-lifecycle events. Catalog/config messages
 * (setModels, setRunnerList, …) stay on the host; Session never emits them.
 */
export class Session {
  private readonly aiService: () => IAiService;
  private readonly usage: PlannerUsageLedger;
  private readonly events: SessionEventRelay;
  private readonly planner: SessionPlanner;
  private readonly orchestrator: TaskOrchestrator;
  private readonly runs: IsolationRunController;
  private readonly store: PlanStore;
  private readonly config: IConfig;
  private readonly catalog: SessionCatalog;
  private plan: LegacyPlanState | null = null;
  private goal = '';
  private workspace: string;
  private readonly broadcast: SessionBroadcaster;
  private readonly notifications: INotification;
  private readonly onNotice?: (notice: SessionNotice) => void;
  private readonly modelResolver: ModelResolver;
  private readonly fsAdapter: IFileSystem;
  private readonly approvals: PendingApprovals;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly fetcher: IWebFetcher;
  private readonly settingsFn: () => SessionRuntimeSettings;
  private readonly save: SaveSession;
  /** The queue drain in flight, which a second call joins; see {@link processQueuedMessages}. */
  private queueDrain: Promise<void> | null = null;
  /** The queued messages the planner has been given, no longer the user's to take back. */
  private drainingIds = new Set<string>();
  /** User controls in flight; see {@link withSave}. */
  private controlsInFlight = 0;
  private unsubObserver: (() => void) | null;
  private readonly hostSessionId?: string;
  private currentSessionId: string;
  private readonly skillsService: Pick<SkillsService, 'findSkill' | 'listSkills' | 'searchedDirs' | 'forRoot'>;
  private readonly conversation: PlannerConversation;
  private readonly editor: PlanEditor;
  private readonly plannerTools: PlannerToolHandler = plannerToolHandler({
    skills: () => this.workspaceSkills().listSkills(),
    turnId: () => this.conversation.currentTurnId,
    recordSkillLoad: (skill) => this.conversation.recordPlannerSkill(skill),
    liveCatalog: () => this.liveCatalog(),
    coerce: (tasks, runners) => coerceAssignments(tasks, this.catalog.allowlist(), runners, this.catalog.models()),
    submitPlan: (tasks, runners) => this.submitPlanFromTool(tasks, runners),
    editPlan: (ops) => this.editPlanFromTool(ops),
    tasks: () => this.store.planTasks,
    read: (signature, answer) => this.conversation.read(signature, answer),
    liveOutput: (taskId, opts) => this.orchestrator.getLiveOutput(taskId, opts),
    lastAttempt: (taskId) => lastAttemptDigest(this.taskLogLocation, taskId),
    taskSkills: () => this.workspaceSkills(),
  });

  constructor(parts: SessionParts) {
    this.config = parts.config;
    this.catalog = parts.catalog;
    this.workspace = parts.workspace;
    this.fsAdapter = parts.fsAdapter;
    this.broadcast = parts.broadcast;
    this.notifications = parts.notifications;
    this.onNotice = parts.onNotice;
    this.modelResolver = parts.modelResolver;
    this.settingsFn = parts.settings;
    this.hostSessionId = parts.hostSessionId;
    this.currentSessionId = parts.hostSessionId ?? mintSessionId();
    this.aiService = parts.aiService;
    this.planner = parts.planner;
    this.store = parts.store;
    this.orchestrator = parts.orchestrator;
    this.runs = parts.runs;
    this.events = parts.events;
    this.usage = parts.usage;
    this.approvals = parts.approvals;
    this.approvalPolicy = parts.approvalPolicy;
    this.fetcher = parts.fetcher;
    this.skillsService = parts.skillsService;
    this.save = parts.saveSession;

    this.conversation = parts.conversation({
      plan: () => this.plan,
      goal: () => this.goal,
      aiService: () => this.aiService(),
      onProgress: (p) => this.events.progress(p),
      opening: (runners) => this.conversationOpening(runners),
      catalog: () => this.catalog.queryCatalog(this.plan?.runners ?? []),
      tasks: () => this.store.planTasks,
      liveOutput: (taskId, opts) => this.orchestrator.getLiveOutput(taskId, opts),
      isExecuting: () => this.isExecuting,
      mutate: (op, notify) => this.mutatePlan(op, notify),
      broadcast: (msg) => this.broadcast(msg),
      broadcastPlan: (turnId) => this.events.planGenerated(this.plan, this.goal, turnId),
      validateOps: (ops) => applyTaskOps(this.store.planTasks, ops, this.plan!.runners, this.catalog.edit()),
      taskSkills: () => this.workspaceSkills(),
      notice: (level, message) => this.notice(level, message),
      adoptTasks: (tasks, how) => this.adoptPlannerTasks(tasks, how),
      capturePrd: (text) => this.capturePrd(text),
      queueEdit: ({ text, skills }) => {
        this.orchestrator.queueMessage(text, skills);
        this.plan!.queuedMessages = this.getQueuedMessages();
        return this.orchestrator.queuedCount;
      },
      afterEdit: () => this.orchestrator.tick(),
      // A prompt raised by a turn nobody is waiting on has no one left to
      // serve; denying it at once unblocks the research loop, which otherwise
      // sat out the approval's five-minute timeout before seeing the stop.
      turnAborted: () => this.approvals.clear(isPlannerApproval),
    });

    this.editor = new PlanEditor({
      store: this.store,
      plan: () => this.plan,
      catalog: this.catalog,
      mutate: (op, notify) => this.mutatePlan(op, notify),
      scheduler: this.orchestrator,
      runs: this.runs,
      broadcast: (msg) => this.broadcast(msg),
      plannerTools: () => this.aiService().plannerToolsAttached?.() ?? false,
      taskSkills: () => this.workspaceSkills(),
      notice: (level, message) => this.notice(level, message),
    });

    this.unsubObserver = this.orchestrator.subscribe(this.observer());
  }

  /**
   * Answer an outstanding approval. Every surface funnels here — the web
   * server's HTTP route, the VS Code webview, the TUI prompt — so the decision
   * path is identical regardless of who is looking.
   */
  resolveApproval(id: string, answer: ApprovalAnswer): boolean {
    return this.approvals.resolve(id, answer);
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
  /** Where this session's structured task logs are saved (ADR-0018, P1). */
  get taskLogLocation(): TaskLogLocation { return { baseDir: this.workspace, sessionId: this.currentSessionId }; }

  /** The attempts of a task that have a saved log, oldest first. */
  taskLogAttempts(taskId: string): number[] {
    return listTaskLogAttempts(this.taskLogLocation, taskId);
  }

  /** One attempt's saved log, for `replayTaskLog` — what a reopened task view shows. */
  taskLog(taskId: string, attempt: number): TaskLogEvent[] {
    return readTaskLog(this.taskLogLocation, taskId, attempt);
  }

  get executionLog(): ReadonlyArray<TaskSnapshot> { return this.store.getExecutionLog(); }
  /** Tasks always read from PlanStore — the single source of truth. */
  get planTasks(): ReadonlyArray<Readonly<Task>> { return this.store.planTasks; }

  /**
   * The relay announces every orchestrator event; this adds the saves some of
   * them owe, each made before the announcement so no surface sees state the
   * disk lacks, and drains the queue the scheduler parked behind.
   */
  private observer(): OrchestratorObserver {
    const relay = this.events.observer(() => this.plan);
    return {
      ...relay,
      onTaskChanged: () => {
        this.saveForControl();
        relay.onTaskChanged();
      },
      onTick: () => {
        this.saveForControl();
        relay.onTick();
      },
      // The scheduler stays parked until the queue is gone, so nothing but
      // this drain can wake it again.
      onQueueReady: () => {
        this.processQueuedMessages().catch((err: unknown) => {
          this.notice('error', `The run could not resume after your queued change: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      // Saved the moment it settles: a shared run has no run record to save
      // it mid-run, so a crash would otherwise lose every verdict since the
      // last Session operation.
      onTaskSettled: () => this.persist({ background: true }),
      onIsolationChanged: () => {
        // The run record names branches and worktrees on disk, so it is saved
        // as it changes rather than at the end: a crash must still find them.
        this.persist({ background: true });
        relay.onIsolationChanged();
      },
      onExecutionComplete: () => {
        relay.onExecutionComplete();
        this.persist({ background: true });
      },
    };
  }

  /**
   * Refresh the plan's task list from the store. LegacyPlanState.tasks is only
   * ever written from the store (here and by the relay before it announces),
   * and always as a detached copy: sharing the store's live
   * tree let a host that edits `plan.tasks` rewrite task state behind the
   * store's back.
   */
  private syncPlanTasks(): void {
    if (this.plan) this.plan.tasks = this.store.snapshot();
  }

  /**
   * Persists PlanStore state to disk. PlanStore is the single authority.
   * `background`: an execution event's save, which may land in the middle of a
   * planner turn without settling it (see {@link PlannerConversation.restore}).
   */
  private persist(opts: { background?: boolean } = {}): void {
    if (!this.plan) return;
    this.events.flushSubagentRuns(this.plan);
    this.syncPlanTasks();
    this.plan.isolation = this.runs.planIsolation ?? undefined;
    this.plan.plannerUsage = this.usage.snapshot();
    this.plan.lastUpdated = new Date().toISOString();
    this.save(this.plan, this.goal, this.workspace, this.currentSessionId);
    this.conversation.markPersisted(opts);
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
    this.events.dropSubagentRuns();
    this.conversation.abandonTurn();
    this.conversation.reset();
    // Totals belong to the plan they were recorded under; a fresh plan starts
    // its ledger from zero so the previous session's line never lingers.
    this.usage.clear();
    // A prompt raised by the turn we are abandoning has nobody left to serve;
    // denying it unblocks the old research loop instead of stranding it.
    this.approvals.clear(isPlannerApproval);
    this.orchestrator.clearQueuedMessages();
    this.store.clearLog();
    this.orchestrator.loadPlan([]);
    void this.runs.adopt(null);
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
    this.catalog.reset();
    this.remintSessionId();
  }

  /** What a planner may assign right now; see {@link SessionCatalog.live}. */
  liveCatalog(): Promise<TaskQueryCatalog> {
    return this.catalog.live();
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
      executionLog: [...executionLog],
      pendingTasks,
      goal: this.goal,
      runners: this.plan.runners,
      status: this.plan.status,
    };
  }

  get currentGoal(): string { return this.goal; }
  /**
   * A task is running right now. Deliberately live work, not the scheduler's
   * armed flag: a run paused on a user task, a hold or a cancellation has
   * nothing executing, and reporting it as executing is what left the plan
   * unstartable after its last live task was cancelled.
   */
  /** See {@link TaskOrchestrator.hasLiveWork} — a spawned runner, not merely an armed scheduler. */
  get isExecuting(): boolean { return this.orchestrator.hasLiveWork; }
  get status(): 'approved' | 'running' | 'completed' { return this.orchestrator.status; }

  /** Whether a planner turn — a reply, a compaction, plan generation — holds the conversation. */
  get isPlannerBusy(): boolean { return this.conversation.isTurnInFlight; }

  /**
   * Stop the planner turn in flight. It still settles — a backend hands back
   * what it had — and ends as stopped. False when no turn is in flight.
   */
  abortPlannerTurn(): boolean {
    return this.conversation.stopTurn();
  }

  async generatePlan(goal: string, runners: RunnerId[], options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    this.plan = null;
    this.goal = goal;
    this.remintSessionId();
    this.beginFreshPlan();
    const enabled = this.catalog.enabledRunners();
    const chosenRunners = runners.filter((r) => enabled.includes(r));
    if (chosenRunners.length === 0) throw new Error('None of the requested runners are enabled');

    return this.conversation.hold(options?.signal, async (turn) => {
      const { modelsByRunner, runnerModes } = await this.catalog.planning(chosenRunners);
      const settings = this.settingsFn();
      const modes = { ...plannerModesFrom(this.config.autonomousMode), isolatedExecution: await this.runs.plannerLayout() };

      const plan = await this.planner.generate({
        goal,
        runners: chosenRunners,
        modelsByRunner,
        runnerModes,
        autonomousDefault: this.config.autonomousMode,
        fs: this.fsAdapter,
        fetcher: this.fetcher,
        onProgress: (p) => this.events.progress(p),
        signal: turn.signal,
        perRunnerAllowlist: settings.modelAllowlist,
        modes,
      });
      if (turn.abandoned) throw new PlannerTurnDiscardedError();

      this.plan = plan;
      this.saved(() => {
        this.orchestrator.loadPlan(plan.tasks, plan.runners);
        this.store.resetForRun({ preserveCompleted: false });
      });
      this.events.planGenerated(this.plan, this.goal);
      return plan;
    });
  }

  /**
   * Kick off the planner conversation (ADR-0002): research + the first planner
   * message. The conversation itself — transcript, live model context, turn
   * settlement — is {@link PlannerConversation}'s; the Session hosts it.
   */
  async startPlanning(goal: string, runners: RunnerId[], options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    this.plan = null;
    this.goal = goal;
    this.remintSessionId();
    this.beginFreshPlan();
    const enabled = this.catalog.enabledRunners();
    const chosenRunners = runners.filter((r) => enabled.includes(r));
    if (chosenRunners.length === 0) throw new Error('None of the requested runners are enabled');

    const now = new Date().toISOString();
    this.plan = { tasks: [], generatedAt: now, status: 'draft', runners: chosenRunners, lastUpdated: now };

    return this.conversation.start(this.resolveSkillInvocation(goal), () => this.conversationOpening(chosenRunners), options?.signal);
  }

  /**
   * Every subsequent user reply in the planning conversation — clarifying
   * answers, outline confirm. One branch, no phase ladder.
   */
  async continueConversation(userMessage: string, options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    if (!this.plan) throw new Error('No planning conversation to continue');
    // A turn that failed before persist leaves its runs unflushed; drop them so
    // the next turn's log cannot absorb a previous turn's uncommitted activity.
    this.events.dropSubagentRuns();
    return this.conversation.reply(this.resolveSkillInvocation(userMessage), { signal: options?.signal });
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
    return this.saveFork(this.conversation.clone());
  }

  /**
   * Fork the conversation from just before a user message (a transcript
   * position from {@link rewindTargets}): the fork holds everything said
   * before it and the current task list, like {@link forkConversation}, and
   * this session keeps its whole history. The message's full text comes back
   * so a surface can offer it for resending.
   */
  rewindConversation(userMessageIndex: number): ConversationRewind {
    if (!this.plan) throw new ConversationEditError('No planning conversation to rewind');
    const { dialogue, rewoundMessage } = this.conversation.cloneBefore(userMessageIndex);
    return { ...this.saveFork(dialogue), rewoundMessage };
  }

  private saveFork(dialogue: ForkedDialogue): ConversationFork {
    const sessionId = mintSessionId();
    const plan = forkPlanState(this.plan!, this.store.planTasks, dialogue, new Date().toISOString());
    this.save(plan, this.goal, this.workspace, sessionId);
    return { sessionId, goal: this.goal, workspace: this.workspace };
  }

  /**
   * Condense the conversation on the user's say-so: a hidden planner turn
   * summarises it, and the summary replaces everything but the last two
   * exchanges. Conversation only — the tasks, and any run
   * executing them, are untouched. Atomic: a failed or stopped turn changes
   * nothing.
   */
  async compactConversation(signal?: AbortSignal): Promise<ConversationCompaction> {
    if (!this.plan) throw new ConversationEditError('No planning conversation to condense');
    return this.conversation.compact(signal);
  }

  rewindTargets(): RewindTarget[] {
    return this.conversation.rewindTargets();
  }

  /**
   * Hand the planner turn in flight a validated plan or a task edit; the turn
   * commits it as it would the same JSON in the planner's reply. False when
   * no turn is open.
   */
  submitToTurn(submission: PlannerSubmission): boolean {
    return this.conversation.submit(submission);
  }

  /**
   * A plan the planner submitted through its tool, already checked against the
   * live catalog. Its runners join `plan.runners` here, so a runner enabled
   * since planning started is not snapped back by the commit (#69).
   */
  private submitPlanFromTool(tasks: Task[], runners: RunnerId[]): boolean {
    if (!this.plan || !this.conversation.submit({ kind: 'plan', tasks })) return false;
    for (const runner of runners) this.editor.admitRunner(runner, this.catalog.known(runner));
    return true;
  }

  /**
   * A task edit the planner made through its tool. Checked against the live
   * catalog, then handed to the open turn, which commits it as it would the
   * same ops in a taskOps reply — including parking it behind a running batch,
   * which the envelope does before any check, so a queued edit is not checked
   * here either. Edits made in one reply join one batch.
   */
  private async editPlanFromTool(ops: TaskOp[]): Promise<PlanEditOutcome> {
    const refuse = (message: string): PlanEditOutcome => ({ ok: false, errors: [message] });
    const turn = this.conversation.currentTurnId;
    // The held batch is read after this await, so two calls made in parallel
    // join one batch instead of one replacing the other.
    const catalog = await this.liveCatalog();
    if (this.conversation.currentTurnId !== turn) return refuse(PLANNER_TURN_ENDED);
    if (!this.plan || this.store.planTasks.length === 0) return refuse('There is no plan to edit yet: submit one with submit_plan.');
    const held = this.conversation.pendingOps();
    if (!held) return refuse('A whole plan was submitted in this reply and replaces the plan when it ends: make the edit in your next reply.');

    const batch = [...held, ...ops];
    const queued = this.conversation.editWouldQueue(batch);
    let summary: string[] = [];
    if (!queued) {
      const result = applyTaskOps(this.store.planTasks, batch, catalog.runners, this.catalog.edit(catalog.runners));
      if (!result.ok) return { ok: false, errors: result.errors };
      summary = result.summary;
      for (const runner of runnersOf(result.tasks)) this.editor.admitRunner(runner, this.catalog.known(runner));
    }
    if (!this.conversation.submit({ kind: 'task_ops', ops: batch })) return refuse('No planning turn is open to take the edit.');
    return { ok: true, summary, queued };
  }

  /** Whether the planner conversation is live (started and not yet committed to a plan). */
  get isConversationActive(): boolean {
    return this.conversation.isActive;
  }

  /**
   * The skills a message's `/skill-name` tokens load, snapshotted here so the
   * planner gets Ordewell's skill rather than a runner (Claude Code, OpenCode)
   * resolving the token in its own skills directory. The message stays as
   * typed.
   */
  private resolveSkillInvocation(text: string): SkillInvocation {
    return resolveSkillInvocation(text, this.workspaceSkills());
  }

  /**
   * The one catalog every planner path reads — its skill catalogs, `/name`,
   * and the check of what a plan or an edit attaches — over the folders the
   * workspace's tasks will read at spawn.
   */
  private workspaceSkills(): SkillCatalogLookup {
    return plannedSkillLookup((roots) => this.skillsAt(roots), this.workspace, this.runs.skillLayout());
  }

  /** The catalog over workspace `roots`; the workspace root alone is the session's own. */
  private skillsAt(roots: readonly string[]): SkillCatalogLookup {
    return roots.length === 1 && roots[0] === this.workspace ? this.skillsService : this.skillsService.forRoot(roots);
  }

  private async conversationOpening(runners: RunnerId[]): Promise<ConversationOpening> {
    const { filteredModels, runnerModes } = await this.catalog.planning(runners);
    return {
      runners,
      modelsByRunner: filteredModels,
      runnerModes,
      autonomousDefault: this.config.autonomousMode,
      isolatedExecution: await this.runs.plannerLayout(),
      // The planner's own model window, when a cached catalog knows it, so the
      // usage line can show context fill (#49). Unknown stays absent.
      contextWindow: this.modelResolver.contextWindowFor?.(this.config.orchestratorModel),
      fs: this.fsAdapter,
      fetcher: this.fetcher,
      plannerTools: { sessionId: this.sessionId, handler: this.plannerTools },
      skills: this.workspaceSkills().listSkills(),
    };
  }

  /**
   * Load planner-produced tasks, coerced to the allowlist read live — it may
   * have changed since planning started. Tasks adopted on an armed scheduler are
   * reconciled rather than reloaded: `loadPlan` clears the on-hold set and the
   * review approval, so a task the user cancelled would be re-armed and
   * re-spawned by the re-tick that follows.
   *
   * A whole-plan commit is the planner restating every task, so it is laid
   * over the plan's execution state rather than replacing it: a planner that
   * answers "add a task" with the full plan must not undo the work already
   * done. Task ops need no overlay — their applier refuses to touch settled
   * tasks, and `rearm`, the one op meant to change a status, must stand.
   */
  private adoptPlannerTasks(tasks: readonly Task[], how: 'edit' | 'commit'): number {
    const runners = this.plan!.runners;
    let coerced = coerceAssignments(tasks, this.catalog.allowlist(), runners, this.catalog.models());
    if (how === 'commit') coerced = keepExecutionState(this.store.planTasks, coerced);
    if (this.orchestrator.isRunning) {
      this.orchestrator.reconcilePlan(coerced, runners);
    } else {
      this.orchestrator.loadPlan(coerced, runners);
      this.store.resetForRun();
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
    if (!this.plan || !this.store.planTasks.length) throw new NoPlanError('execute');
    if (this.orchestrator.hasLiveWork) throw new AlreadyExecutingError();

    const plan = this.plan;
    await this.withSave(async () => {
      // A scheduler armed from an earlier run but with nothing live — paused on a
      // hold, a user task, or a cancellation — would ignore the restart: `start`
      // no-ops while armed and `loadPlan` keeps the run mode. Disarm it so this
      // run starts cleanly; with nothing live, stopping has nothing to interrupt.
      this.orchestrator.stop();

      plan.status = 'approved';
      this.store.clearLog();
      this.store.resetForRun();

      this.orchestrator.loadPlan(this.store.planTasks, plan.runners);
      await this.orchestrator.approveReview();
    });

    if (!this.orchestrator.isRunning && !this.runs.blocked) this.events.executionComplete(this.plan);
  }

  async approveReview(): Promise<LegacyPlanState> {
    if (!this.plan) throw new NoPlanError('review');
    const plan = this.plan;
    await this.withSave(() => this.orchestrator.approveReview());
    return plan;
  }

  async forceStartTask(taskId: string): Promise<void> {
    if (!this.plan) return;
    if (!this.store.get(taskId)) {
      this.orchestrator.loadPlan(this.store.planTasks, this.plan.runners);
    }
    await this.withSave(() => this.orchestrator.forceStartTask(taskId));
  }

  async runTask(taskId: string): Promise<void> {
    if (!this.plan) return;
    if (!this.store.get(taskId)) {
      this.orchestrator.loadPlan(this.store.planTasks, this.plan.runners);
    }
    await this.withSave(() => this.orchestrator.runTask(taskId));
  }

  /** Start whatever the scheduler can now fit — after the parallel limit was raised mid-run, say. */
  async reschedule(): Promise<void> {
    await this.withSave(() => this.orchestrator.tick());
  }

  async retryTask(taskId: string): Promise<void> {
    await this.withSave(() => this.orchestrator.retryTask(taskId));
  }

  /**
   * Continue a finished structured task in its saved runner session with the
   * user's message (ADR-0018, K1); throws `TaskControlError` for a task that
   * cannot be continued.
   */
  async continueTask(taskId: string, message: string): Promise<void> {
    await this.withSave(() => this.orchestrator.continueTask(taskId, message));
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.withSave(() => this.orchestrator.cancelTask(taskId));
  }

  async markTaskComplete(taskId: string): Promise<void> {
    await this.withSave(() => this.orchestrator.markTaskComplete(taskId));
  }

  async markTaskIncomplete(taskId: string): Promise<void> {
    await this.withSave(() => this.orchestrator.markTaskIncomplete(taskId));
  }

  /**
   * Hand the queued edits to the planner. The Session does this itself each
   * time the scheduler parks behind the queue, so no surface has to; a caller
   * only needs it to await the drain. The messages stay queued until the
   * planner's answer is applied, so the scheduler stays paused behind them
   * meanwhile; one drain runs at a time, and a call made during it joins it.
   * Whatever was queued while it ran is drained after, before the run goes on.
   */
  async processQueuedMessages(): Promise<void> {
    if (this.queueDrain) return this.queueDrain;
    if (this.orchestrator.getQueuedMessages().length === 0) return;
    const plan = this.plan;
    this.queueDrain = this.drainQueue();
    try {
      await this.queueDrain;
    } finally {
      this.queueDrain = null;
    }
    // The run it parked belonged to the plan that was swapped out.
    if (this.plan !== plan) return;

    // Re-schedule. `onQueueReady` only fires when no task is active, so a paused
    // run still has `running === true` — `start()` would no-op (it early-returns
    // when already running). Ticking directly spawns the dependents that became
    // ready after reconcile. `start()` covers the halted case (`running === false`,
    // e.g. a retry that cleared the queue), re-entering approval-free.
    await this.withSave(() => (this.orchestrator.isRunning ? this.orchestrator.tick() : this.orchestrator.start()), { background: true });
  }

  private async drainQueue(): Promise<void> {
    const plan = this.plan;
    for (let messages = this.orchestrator.getQueuedMessages(); messages.length > 0 && this.plan === plan; messages = this.orchestrator.getQueuedMessages()) {
      for (const m of messages) this.drainingIds.add(m.id);
      try {
        await this.applyQueuedEdits(messages);
      } finally {
        // Already gone unless no plan was left to apply them to; never drained
        // twice. A successor plan's queue is its own, even under the same ids.
        if (this.plan === plan) for (const m of messages) this.orchestrator.removeQueuedMessage(m.id);
        this.drainingIds.clear();
      }
    }
  }

  /** Said through both channels: a host shows one or the other, never both (the daemon's toasts are no-ops). */
  private notice(level: SessionNotice['level'], message: string): void {
    this.notifications[level](message);
    this.onNotice?.({ type: 'notice', level, message });
  }

  private async applyQueuedEdits(messages: QueuedMessage[]): Promise<void> {
    const plan = this.plan;
    // Like a planner turn's, the answer is to the plan it was asked about: one
    // that settles after that plan was swapped out is dropped, not reconciled
    // into its successor.
    const stale = () => this.plan !== plan;
    // Taken off with the plan change they made, so the saved queue goes with
    // the live one — or a reload restores the edit and it is applied twice.
    const dequeue = () => {
      for (const m of messages) this.orchestrator.removeQueuedMessage(m.id);
      if (this.plan) this.plan.queuedMessages = this.getQueuedMessages();
    };
    const batchText = messages.map((m) => plannerMessage(m.text, m.skills ?? [])).join('\n');
    const texts = messages.map((m) => m.text);
    const activeSessions = new Map(
      [...this.orchestrator.activeSessionMap.entries()].map(([taskId, sessionId]) => [
        taskId,
        { id: sessionId, taskId },
      ])
    );

    try {
      const modelsByRunner = await this.catalog.discover(this.catalog.enabledRunners());
      const runnerModes = this.catalog.modes(this.plan?.runners ?? [...DEFAULT_RUNNERS]);
      const { modelAllowlist } = this.settingsFn();

      // The prompt calls this list the tasks not yet executed, so it must be
      // exactly that: shown finished tasks as pending, a planner hands them
      // back pending. Finished work reaches it through the log instead — all
      // of it, since the per-run log forgets what earlier runs finished.
      const result = await this.planner.modifyDuringExecution({
        executionLog: this.finishedWork(),
        pendingTasks: this.store.planTasks.filter((t) => t.status !== 'completed'),
        activeSessions,
        userMessage: batchText,
        modelsByRunner,
        runners: this.plan?.runners ?? [...DEFAULT_RUNNERS],
        runnerModes,
        autonomousDefault: this.config.autonomousMode,
        perRunnerAllowlist: modelAllowlist,
        isolatedExecution: await this.runs.plannerLayout(),
        skills: this.workspaceSkills(),
      });
      if (stale()) return;

      this.mutatePlan(() => {
        dequeue();
        const tasks = keepExecutionState(this.store.planTasks, result.pendingTasks);
        this.orchestrator.reconcilePlan(tasks, this.plan!.runners);
        this.conversation.recordQueuedEdits(texts, tasks.length);
        return true;
      });
      for (const warning of result.skillWarnings ?? []) this.notice('warn', warning);
    } catch (err) {
      if (stale()) return;
      // The edit is lost either way; the run must not be. Left unticked, a run
      // parked behind the queue stays parked with nothing left to wake it.
      const reason = err instanceof Error ? err.message : String(err);
      this.mutatePlan(() => {
        dequeue();
        this.conversation.recordQueuedEditsFailed(texts, reason);
        return true;
      });
      this.notice('error', `Your queued change could not be applied, so the plan is unchanged: ${reason}. Send it again to retry.`);
    }
  }

  /**
   * Every finished task as the log records it: this run's own entries, plus
   * the tasks earlier runs completed, which the log dropped when this run
   * began but which dependents still count on.
   */
  private finishedWork(): TaskSnapshot[] {
    const log = this.store.getExecutionLog();
    const logged = new Set(log.map((s) => s.id));
    const earlier = flattenTasks(this.store.planTasks)
      .filter((t) => t.status === 'completed' && !logged.has(t.id))
      .map((t): TaskSnapshot => ({ ...t, completedAt: 0, retryCount: 0, finalized: true }));
    return [...log, ...earlier];
  }

  approveCheckpoint(taskId: string): void {
    this.saved(() => this.orchestrator.approveCheckpoint(taskId));
  }

  rejectCheckpoint(taskId: string, reason?: string): void {
    this.saved(() => this.orchestrator.rejectCheckpoint(taskId, reason));
  }

  /** Whether an answer would reach the task: it waits at a checkpoint and a runner is left to hear it. */
  awaitsCheckpoint(taskId: string): boolean {
    return this.orchestrator.awaitsCheckpoint(taskId);
  }

  /**
   * A user message to a structured task (ADR-0018, M1); throws
   * `TaskControlError` for one that cannot take it. A task waiting for input
   * is back in progress, and saved so before any surface is told.
   */
  sendTaskMessage(taskId: string, text: string): string {
    return this.saved(() => this.orchestrator.sendTaskMessage(taskId, text), { background: true });
  }

  /**
   * Force send (ADR-0023, F1): interrupt the task's running turn and deliver
   * this message next. Throws `TaskControlError` where a plain message would,
   * and for a task on the terminal transport.
   */
  forceSendTaskMessage(taskId: string, text: string): string {
    return this.saved(() => this.orchestrator.forceSendTaskMessage(taskId, text), { background: true });
  }

  forceSendQueuedTaskMessage(taskId: string, id: string): boolean {
    return this.saved(() => this.orchestrator.forceSendQueuedTaskMessage(taskId, id), { background: true });
  }

  removeQueuedTaskMessage(taskId: string, id: string): boolean {
    return this.saved(() => this.orchestrator.removeQueuedTaskMessage(taskId, id), { background: true });
  }

  async interruptTask(taskId: string): Promise<void> {
    await this.withSave(() => this.orchestrator.interruptTask(taskId), { background: true });
  }

  getQueuedMessages(): QueuedMessage[] { return this.orchestrator.getQueuedMessages(); }
  /** Take back one unsent message — false once the planner has it; the plan's persisted queue follows so a reload cannot resurrect it. */
  removeQueuedMessage(id: string): boolean {
    if (this.drainingIds.has(id)) return false;
    const removed = this.orchestrator.removeQueuedMessage(id);
    if (removed && this.plan) {
      this.plan.queuedMessages = this.getQueuedMessages();
      this.persist({ background: true });
    }
    return removed;
  }
  setQueuedMessages(msgs: QueuedMessage[]): void {
    this.orchestrator.setQueuedMessages(msgs);
  }

  /** Replay a run a dirty tree blocked, after stashing the tracked changes. */
  async continueWithStash(): Promise<void> {
    await this.withSave(() => this.orchestrator.continueBlockedRun('stash'));
  }

  /** Replay a run a dirty tree blocked, in the workspace root, for this run only. */
  async continueWithoutIsolation(): Promise<void> {
    await this.withSave(() => this.orchestrator.continueBlockedRun('shared'));
  }

  /**
   * Each task's isolation mark and the run's handoff, read from the run record.
   * The stream reports changes only; a surface that (re)connects or loads a
   * session asks here instead.
   */
  isolationView(): IsolationView | null {
    return this.runs.view();
  }

  /** The dependencies a task waits on at its merge gate (ADR-0020); empty when it waits for no Merge all. */
  mergeGate(taskId: string): string[] {
    return this.orchestrator.getMergeGate(taskId);
  }

  /** What Merge all would merge mid-run, while any task waits at a merge gate; null otherwise. */
  mergeGateView(): MergeGateView | null {
    return this.orchestrator.mergeGateView();
  }

  /** The run's integration branch against its base ref, as a unified diff. */
  async reviewRunDiff(): Promise<string> {
    return this.runs.reviewDiff();
  }

  /**
   * "Merge all": each repo's integration branch into whatever the user has
   * checked out there — every repo, or none if any cannot take it. The one
   * irreversible step of isolated execution, so this explicit call is the
   * only way it ever happens. During a run it merges what has landed so far,
   * which is what opens a merge gate (ADR-0020); it waits for no ops task,
   * and refuses while one runs.
   */
  async mergeRun(): Promise<IsolationMergeResult> {
    // Ahead of the ops refusal: with no run there is nothing to merge once the ops task ends either.
    this.runs.requireRun();
    const result = await this.withSave(() => this.orchestrator.mergeRun());
    this.broadcast({ type: 'isolation_merge', result });
    return result;
  }

  /** Remove the run's worktrees and task branches; keep its integration branch to review or merge. */
  async cleanupRun(): Promise<void> {
    this.requireSettledRun();
    await this.withSave(() => this.runs.cleanup());
  }

  /**
   * Give the whole run up, integration branch included. The plan is not
   * rewritten: a task that landed there stays completed until the user says
   * otherwise (Mark not done), because only they know whether they kept the work.
   */
  async discardRun(): Promise<void> {
    this.requireSettledRun();
    await this.withSave(() => this.runs.discard());
  }

  private requireSettledRun(): void {
    this.runs.requireRun();
    if (this.orchestrator.isRunning) throw new PlanEditError('The run is still running — stop it first');
  }

  /** Add the task that merges a conflicted task's branch by hand; see {@link PlanEditor.addConflictResolver}. */
  async resolveConflictAsTask(taskId: string): Promise<LegacyPlanState | null> {
    return this.editor.addConflictResolver(taskId);
  }

  stopExecution(): void {
    this.saved(() => this.orchestrator.stop());
    this.broadcast({ type: 'execution_stopped' });
  }

  /**
   * Run a user control and save what it changed before any surface hears of
   * it. Not a status hold, as {@link saved} is: these await spawns and git, so
   * a hold would stall every task's status for as long, and an
   * `execution_complete` the control triggers would overtake the status held
   * back — which a surface treats as the end of the stream. Instead each status
   * announced while one runs is saved first (see {@link observer}), as the
   * background save of an execution event: it may land mid planner turn. So
   * is the last one where the control is itself execution, not the user's
   * word on the plan (`background`).
   */
  private async withSave<T>(op: () => Promise<T>, opts: { background?: boolean } = {}): Promise<T> {
    this.controlsInFlight++;
    try {
      const result = await op();
      this.persist(opts);
      return result;
    } finally {
      this.controlsInFlight--;
    }
  }

  private saveForControl(): void {
    if (this.controlsInFlight > 0) this.persist({ background: true });
  }

  /** A control that finishes synchronously: its status is held until it is saved. */
  private saved<T>(op: () => T, opts: { background?: boolean } = {}): T {
    const result = this.events.holdStatus(op);
    this.persist(opts);
    this.events.releaseStatus(this.plan);
    return result;
  }

  /**
   * The one mutation seam: every structural plan mutation runs the same
   * ritual — store op → persist (which snapshots tasks from PlanStore) →
   * broadcast — in that order, once. A store op returning false aborts
   * before anything is persisted. PlanStore is the single authority for
   * task state; LegacyPlanState.tasks is populated only at persist time.
   * Direct edits reach it through the {@link PlanEditor}, which adds the
   * reschedule they owe.
   */
  private mutatePlan(op: () => boolean, notify: () => void = () => this.events.planGenerated(this.plan, this.goal)): LegacyPlanState | null {
    if (!this.plan) return null;
    const changed = this.events.holdStatus(op);
    if (changed) this.persist();
    this.events.releaseStatus(this.plan);
    if (!changed) return null;
    notify();
    return this.plan;
  }

  /** Patch one task's fields, checked as the planner's task ops are; see {@link PlanEditor.updateTask}. */
  async updateTask(taskId: string, changes: Partial<Task>): Promise<LegacyPlanState | null> {
    return this.editor.updateTask(taskId, changes);
  }

  /** Move one task onto a different runner, re-deriving what is scoped to it; see {@link PlanEditor.setTaskRunner}. */
  async setTaskRunner(taskId: string, runner: RunnerId): Promise<LegacyPlanState | null> {
    return this.editor.setTaskRunner(taskId, runner);
  }

  /** Replace one task's dependency list, under the same guard as a field patch; see {@link PlanEditor.setTaskDependencies}. */
  async setTaskDependencies(taskId: string, dependencies: string[]): Promise<LegacyPlanState | null> {
    return this.editor.setTaskDependencies(taskId, dependencies);
  }

  /** Delete one task, cancelling its runner first if it runs; see {@link PlanEditor.removeTask}. */
  async removeTask(taskId: string): Promise<LegacyPlanState | null> {
    return this.editor.removeTask(taskId);
  }

  /** Add one task, deriving what the caller left unset; see {@link PlanEditor.addTask}. */
  async addTask(draft: Partial<Task>): Promise<LegacyPlanState | null> {
    return this.editor.addTask(draft);
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
    return this.continueConversation(this.editor.mergeRequest(taskIds), options);
  }

  /**
   * Planner-driven split: ask the planner LLM to decompose one task into a
   * sequence of smaller tasks. The model generates the breakdown (no manual
   * per-task specs from the user). Same conversation-loop/repair path as merge.
   */
  async requestSplit(taskId: string, options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    return this.continueConversation(this.editor.splitRequest(taskId), options);
  }

  loadPlan(plan: LegacyPlanState, goal: string, workspace: string, opts?: { sessionId?: string; persist?: boolean }): void {
    // A live planner conversation belongs to the plan it was started for.
    // Adopting a different plan (session load/switch) must drop it — otherwise
    // the next user message continues the OLD session's LLM thread and the
    // planner re-emits that session's plan here. The same-object case (e.g.
    // re-adopting the current plan on approval) keeps the conversation; after
    // a drop, the first user send reseeds it from this plan's own transcript.
    const adopting = plan !== this.plan;
    if (adopting) {
      this.conversation.abandonTurn();
      this.conversation.reset();
      // The execution log and queued messages are scoped to the outgoing plan;
      // callers restoring a saved queue re-apply it after adoption.
      this.store.clearLog();
      this.orchestrator.clearQueuedMessages();
      // Approval scopes are equally session-scoped: a path or command approved
      // for the previous plan must not stay approved for the newly adopted one.
      this.approvals.clear(isPlannerApproval);
      this.approvalPolicy.reset();
    }
    this.plan = plan;
    this.goal = goal;
    this.workspace = workspace;
    // The saved ledger is the session's own history: adopt it before the
    // persist below writes the plan back, so a load does not zero the totals.
    this.usage.restore(plan.plannerUsage);
    // Adopting the saved session's id keeps subsequent persists writing to the
    // same file instead of forking the session under a fresh identity.
    if (opts?.sessionId) this.currentSessionId = opts.sessionId;
    this.orchestrator.loadPlan(plan.tasks, plan.runners);
    // Loading normalizes statuses (a failed task gets a fresh chance) on the
    // store's copy; the adopted plan shows that result, not the caller's input.
    this.syncPlanTasks();
    migratePlanStateIsolation(plan);
    // Older builds copied the since-removed transport setting onto the plan.
    // Every plan now runs structured (ADR-0018), so the copy is not carried on.
    delete (plan as { runnerTransport?: unknown }).runnerTransport;
    // The run record is taken synchronously; only the orphan prune is awaited
    // in the background, and git serializes it ahead of any worktree a run adds.
    if (adopting) {
      void this.runs.adopt(plan.isolation ?? null);
    }
    if (opts?.persist !== false) this.persist();
    // A reopened session shows its token line again without waiting for the
    // next turn: announce the totals the moment the plan is adopted.
    if (this.usage.hasUsage) this.broadcast(this.usage.message());
  }

  destroy(): void {
    this.stopExecution();
    // Planning research runs on a separate conduit from task execution — a
    // live spawn_research_agent/bash tool call would otherwise keep running
    // server-side after the client has already moved on to a new session.
    this.conversation.abandonTurn();
    this.conversation.reset();
    // Deny any still-pending approval prompts so their timers and awaited
    // continuations settle before the Session goes away.
    this.approvals.clear();
    this.approvalPolicy.reset();
    this.unsubObserver?.();
    this.unsubObserver = null;
  }

  get aiServiceInstance(): IAiService { return this.aiService(); }
}

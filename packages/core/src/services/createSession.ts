import * as path from 'path';
import { resolveHandoffReferences } from './handoffReferences';
import { readSavedPatch } from './taskDiffRead';
import { savedPatchOf } from '../models/Handoff';
import { createAiService, type IAiService } from './AiService';
import type { PlannerContextDeps } from './plannerContextBudget';
import { PlannerBackend } from './PlannerBackend';
import type { TaskOp } from './TaskOps';
import { PlanChangeCheck, type PlanChangeScope } from './PlanChangeCheck';
import { carryPlannedModes } from './ModeResolver';
import { ApprovalRecord } from './ApprovalRecord';
import type { TaskQueryCatalog } from './TaskQuery';
import { SessionCatalog } from './SessionCatalog';
import { plannerToolHandler, runnersOf, PLANNER_TURN_ENDED, type PlanEditOutcome, type TaskHead } from './plannerTools';
import { sharedMcpServer, type OrdewellMcpServer, type PlannerToolHandler } from './mcp';
import { ConversationEditError, PlannerContextPausedError, PlannerConversation, PlannerTurnDiscardedError, PlannerTurnStoppedError, PlannerUsageLimitError, type ConversationCompaction, type ConversationOpening, type PlannerConversationHost, type RewindTarget, type WakeUpTurn } from './PlannerConversation';
import { forkPlanState, type ForkedDialogue } from './conversationFork';
import { PlanTurns, type PlanTurnInput } from './PlanTurns';
import { RunSupervision, runOrigin } from './RunSupervision';
import { Planner } from './Planner';
import { TaskControlError, TaskOrchestrator, type OrchestratorObserver, type RunOrigin } from './TaskOrchestrator';
import { PlanStore } from './PlanStore';
import { ApprovalPolicy, effectiveApprovalMode } from './ApprovalPolicy';
import { DEFAULT_PLANNER_ALLOWLIST } from './plannerAllowlist';
import { effectRuleFor, parseEffectAllowlist } from './effectAllowlist';
import { PendingApprovals, type PendingApproval } from './PendingApprovals';
import { RunnerApprovals } from './RunnerApprovals';
import { approvalScopes, isRunnerApproval, type ApprovalAnswer, type ApprovalRequest } from '../interfaces/IApproval';
import { HttpWebFetcher, type WebTransport } from './HttpWebFetcher';
import type { ResolveAll } from './egressGuard';
import type { ISearchProvider } from '../interfaces/ISearchProvider';
import { WebReadPolicy } from './webReadPolicy';
import { sharedWebResponseCache, type WebResponseCache } from './WebResponseCache';
import { sharedSearchProvider } from './DuckDuckGoSearchProvider';
import { PROVIDER_PRIORITY, runnerForProvider } from './ProviderRegistry';
import { ModelResolver } from './ModelResolver';
import { plannerModesFrom } from './plannerModes';
import { RUN_SETTINGS_DEFAULTS, runSettingsOf, type GlobalRunSettings, type UserSettings } from './SettingsService';
import { SkillsService } from './SkillsService';
import { resolveSkillInvocation, type SkillInvocation } from './skillInvocation';
import { plannedSkillLookup, type SkillCatalogLookup } from './taskSkills';
import { surfacePlan, type RunActivity, type RunMergeView, type RunView, type SessionBroadcaster, type SessionMessage, type SessionNotice } from './SessionMessage';
import { EMPTY_RUN, reduceRun } from './runView';
import { SessionEventRelay } from './SessionEventRelay';
import { SubagentRuns } from './SubagentRuns';
import { saveSession } from '../utils/sessionStore';
import { listTaskLogAttempts, prepareTaskOutputFile, readTaskLog, readTaskPatch, saveTaskPatch, type TaskLogFile, type TaskLogLocation } from '../utils/taskLogStore';
import { digestTaskLog, type TaskLogEvent } from '../models/TaskLog';
import { TaskLogRecorder } from './TaskLogRecorder';
import { ScriptRunner, type ScriptRunnerDeps } from './ScriptRunner';
import { rewrittenScripts } from '../models/ScriptTask';
import { taskRefOf } from './TaskRefs';
import { SessionWindows, withContextWindows } from './ContextWindowFill';
import { PlannerUsageLedger } from './PlannerUsage';
import { plannerContextFill } from '../models/Usage';
import { TurnBudgets, contextLine, taskReadsLine, webReadsLine } from './PlannerBudgets';
import { mintSessionId } from '../utils/sessionId';
import { savePrdMarkdown, extractPrdBlock } from '../utils/prdStore';
import { approvalRecordOf, flattenTasks, keepExecutionState, migrateLoadedPlan, stampOrigin, type LegacyPlanState, type PlanState, type Task, type TaskReportTo, type TaskSnapshot, type RunnerId } from '../models/Task';
import { AlreadyExecutingError, NoPlanError } from './SessionErrors';
import { describeHeld, describeLost, processLeaseHost, UNLEASED, type LeaseHost, type SessionHeld, type SessionLease } from './sessionLease';
import { PlannerNotReadyError, plannerNotReadyFor } from './plannerReadiness';
import { recordedRunnerAuth } from './runnerAuth';
import { installedPlannerAnswered, installedPlannerDetected } from './InstalledPlanner';
import type { IConfig, PlannerBackendId } from '../interfaces/IConfig';
import type { IFileSystem } from '../interfaces/IFileSystem';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { INotification } from '../interfaces/INotification';
import type { IRunner } from '../interfaces/IRunner';
import type { TaskOutputSource } from '../interfaces/TaskOutputSource';
import type { IsolationHandoff, IsolationMergeResult, IsolationView, IWorktreeIsolation } from '../interfaces/IWorktreeIsolation';
import type { IsolationRunController } from './IsolationRunController';
import { PlanEditor, type TaskEditOptions } from './PlanEditor';
import { PlanEditError } from './PlanEditError';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import { ExecutionCommands, mergeStopped, type CommandOutcome, type ExecutionCommand, type ExecutionHost } from './ExecutionCommands';
import { escalations, type Escalation } from './escalations';
import { EscalationNotifier, runNotifyCommand, type NotifyRun } from './escalationNotifier';
import type { TaskRevertPreview } from './taskRevert';
import { REPORT_TAIL_LINES, reportEnded } from './taskReport';
import { ResearchTasks, researchReportTo } from './ResearchTasks';
import type { ExecutionActor, ExecutionRecord } from '../models/Execution';
import { TurnEffects } from './TurnEffects';

/**
 * Options for plan generation. Progress is not overridable: every planner
 * progress event is translated to a SessionMessage inside the Session and
 * emitted through the broadcast seam, so all surfaces consume one union.
 */
export interface GeneratePlanOptions {
  signal?: AbortSignal;
}

/** A message sent behind the conversation's opening while it waits at the planner gate. */
interface HeldFollowUp {
  input: PlanTurnInput;
  forced: boolean;
  resolve(plan: LegacyPlanState): void;
  reject(err: unknown): void;
}

/** The conversation's opening: `held` until its turn holds the conversation, null after. */
interface PendingOpening {
  held: HeldFollowUp[] | null;
}

/** The slice of Planner the Session drives — the injection seam for tests. */
export type SessionPlanner = Pick<Planner, 'generate'>;

/** Runtime prefs read live — may toggle between operations. */
export interface SessionRuntimeSettings {
  modelAllowlist?: Record<string, string[]>;
  /** Absent means the user never chose, and `config.enabledRunners` (the host's defaults) decides. */
  enabledRunners?: RunnerId[];
  /** The user's saved run settings (ADR-0030), which seed a new session; absent means every default. */
  run?: GlobalRunSettings;
  /** Whether an API planner compacts its own context before a call that would not fit; absent means on. */
  plannerAutoCompaction?: boolean;
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
    run: runSettingsOf(settings),
    ...(settings.plannerAutoCompaction !== undefined ? { plannerAutoCompaction: settings.plannerAutoCompaction } : {}),
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
  runner: IRunner;
  /** What runs script tasks' bodies (ADR-0035); the real {@link ScriptRunner} unless a test supplies one. */
  scriptRunner?: IRunner;
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
  /**
   * Live runtime settings (enabled runners). Its run values seed a session
   * when it opens; a later change reaches an open session through
   * {@link Session.applyRunSettings}.
   */
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
  /** Where a task's output and final answer are read. */
  taskOutput?: TaskOutputSource;
  /**
   * Git worktree isolation (ADR-0013). Defaults to git itself, gated by
   * `config.worktreeIsolation`; tests inject `FakeWorktreeIsolation`.
   */
  isolation?: IWorktreeIsolation;
  /** Persistence seam. Defaults to the saved-session store under the workspace. */
  saveSession?: SaveSession;
  /**
   * The host whose lease the session holds while it is open (ADR-0049).
   * Defaults to this process's when saves go to the session store; a session
   * given its own `saveSession` owns nothing on disk, so it holds no lease
   * unless given a host too.
   */
  leaseHost?: LeaseHost;
  /** Where a structured task's log is saved (ADR-0018, P1). Defaults to a file per attempt beside the session's. */
  openTaskLog?: (location: TaskLogLocation, taskId: string, attempt?: number) => TaskLogFile;
  /** The Ordewell MCP server a harness planner's tools are served from (ADR-0022). Defaults to the process's one. */
  mcpServer?: OrdewellMcpServer;
  /**
   * What carries web reads (ADR-0027): the pinned transport, real DNS and the
   * process-wide cache and search provider unless a test fakes the network.
   */
  web?: { transport?: WebTransport; resolveHost?: ResolveAll; cache?: WebResponseCache; searchProvider?: ISearchProvider };
  /** What runs the user's notify command (ADR-0053); the real process unless a test supplies one. */
  runNotifyCommand?: NotifyRun;
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
 * The tasks a planner edit wrote: new, or held otherwise than before. Read on
 * what the task says, not where it stands, so a run moving a task on meanwhile
 * is not mistaken for the planner rewriting it.
 */
function writtenTasks(before: readonly Task[], after: readonly Task[]): Task[] {
  const said = ({ subtasks: _subtasks, status: _status, ...task }: Task): string => JSON.stringify(task);
  const prior = new Map(flattenTasks(before).map((t) => [t.id, said(t)]));
  return flattenTasks(after).filter((t) => prior.get(t.id) !== said(t));
}

/**
 * The composition root: builds every collaborator a Session drives and wires
 * them to each other, so the Session only receives them. Hosts create a
 * Session here; the optional {@link SessionDeps} are the seams tests fill.
 */
export function createSession(deps: SessionDeps): Session {
  const mcpServer = deps.mcpServer ?? sharedMcpServer();
  // Made by the Session (it is the conversation's host); an approval prompt
  // names the turn that raised it, and the backend waits for the turn on it,
  // so both read it once it exists.
  let conversation: PlannerConversation | undefined;
  const busy = () => conversation?.isTurnInFlight ?? false;
  // Each source is read when a turn's input is built; the ledger, the web
  // reads and the conversation are all made below.
  const turnBudgets: TurnBudgets = new TurnBudgets([
    () => contextLine(plannerContextFill(usage.snapshot())),
    () => taskReadsLine(conversation?.readsLeft),
    () => webReadsLine(webReads.remaining()),
  ]);
  // An API planner reads these before each call: its model's limits from the
  // catalogs already held (a fetch is started, never awaited, for a model they
  // lack), and the config file's switch, so a change applies from the next call.
  const plannerContext: PlannerContextDeps = {
    modelLimits: (source, model) => {
      const contextWindow = windows.get(source, model) ?? deps.modelResolver.contextWindowFor?.(source, model);
      if (contextWindow === undefined) deps.modelResolver.warmPickerOptions?.();
      return { contextWindow, maxOutputTokens: deps.modelResolver.maxOutputTokensFor?.(source, model) };
    },
    autoCompaction: () => deps.settings().plannerAutoCompaction !== false,
  };
  const backend = new PlannerBackend(deps.aiService
    ? { pinned: deps.aiService, busy }
    : { provider: () => deps.config.aiProvider, create: () => createAiService(deps.config, { workspaceRoot: deps.workspaceRoot, mcpServer, turnBudgets, ...plannerContext }), busy });
  const aiService = () => backend.current();
  const store = new PlanStore();
  // A window a runner or provider reports wins, and every later stream of the
  // session knows it; the catalogs the resolver already holds serve the rest.
  const windows = new SessionWindows((source, model) => deps.modelResolver.contextWindowFor?.(source, model));
  // A caller that swaps the log's store keeps the disk untouched, so no output file is made either.
  const scriptRunnerDeps: ScriptRunnerDeps = deps.openTaskLog
    ? {}
    : { fullOutputFile: (taskId, attempt) => prepareTaskOutputFile(session.taskLogLocation, taskId, attempt) };
  const taskLogs: TaskLogRecorder = new TaskLogRecorder({
    broadcast: deps.broadcast,
    // Read through the Session, whose id and workspace are the ones it saves
    // under and can change with a plan. Only read once a task spawns.
    location: () => session.taskLogLocation,
    open: deps.openTaskLog,
  });
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
      events.approvalRequested({
        type: 'approval_request',
        id,
        kind: request.kind,
        subject: request.subject,
        scope: approvalScopes(request).join(', '),
        detail: request.detail,
        ...(request.body ? { body: request.body } : {}),
        turnId: conversation?.currentTurnId,
      });
    },
    onSettled: (id, granted, { request }) => {
      if (isRunnerApproval(request)) events.status(session.planState);
      else events.approvalSettled(id, granted);
    },
  });
  const runnerApprovals = new RunnerApprovals(approvals);
  const orchestrator = TaskOrchestrator.compose({
    config: deps.config,
    notifications: deps.notifications,
    runner: taskLogs.wrap(runnerApprovals.wrap(withContextWindows(deps.runner, windows))),
    scriptRunner: taskLogs.wrap(deps.scriptRunner ?? new ScriptRunner(scriptRunnerDeps)),
    store,
    output: deps.taskOutput,
    isolation: deps.isolation,
    registry: deps.registry,
    workspaceRoot: deps.workspaceRoot,
    skillsAt: (roots) => (deps.skillsService ?? new SkillsService(roots)).forRoot(roots),
    previousAttemptFromLog: (taskId) => lastAttemptDigest(session.taskLogLocation, taskId),
    previousHandoffFromLog: (taskId) => {
      const attempt = session.taskLogAttempts(taskId).at(-1);
      if (attempt === undefined) return undefined;
      return session.taskLog(taskId, attempt).filter((e): e is Extract<TaskLogEvent, { type: 'handoff' }> => e.type === 'handoff').at(-1)?.handoff;
    },
    lastLoggedAttempt: (taskId) => session.taskLogAttempts(taskId).at(-1) ?? 0,
    runSettings: () => session.planState?.runSettings,
    plannedWith: () => session.plannedWithTrailer(),
    isApproved: (taskId) => session.isApproved(taskId),
    research: {
      started: (task) => session.research.started(task),
    },
    // The planner's command rules, at the read-only task's own working directory (ADR-0046).
    taskShell: (site) => deps.fsAdapter.taskShell?.(site),
    // The planner's web-read policy with a budget per attempt, never prompting (ADR-0046).
    taskWebFetcher: (task) => fetcher.forTask(task),
    // Beside the attempt's log, as a script's whole output is, and by the same rule: a swapped log store keeps the disk untouched (ADR-0050).
    ...(deps.openTaskLog ? {} : {
      keepPatch: (taskId: string, attempt: number, patch: Buffer) => {
        const location = session.taskLogLocation;
        return path.relative(location.baseDir, saveTaskPatch(location, taskId, attempt, patch)).split(path.sep).join('/');
      },
    }),
    recordHandoff: (sessionId, taskId, handoff) => taskLogs.note(sessionId, taskId, { type: 'handoff', handoff }),
    taskLog: { attempts: (taskId) => session.taskLogAttempts(taskId), events: (taskId, attempt) => session.taskLog(taskId, attempt), patch: (taskId, attempt) => readTaskPatch(session.taskLogLocation, taskId, attempt) },
    sessionHeld: () => session.heldElsewhere(),
  });
  const usage = new PlannerUsageLedger(windows, () => aiService().plannerContextStatus?.());
  const escalationNotifier = new EscalationNotifier({
    command: () => deps.config.notifyCommand,
    run: deps.runNotifyCommand ?? runNotifyCommand,
    log: (message) => console.warn(`[EscalationNotifier] ${message}`),
  });
  const events = new SessionEventRelay({
    broadcast: deps.broadcast, onNotice: deps.onNotice, store, orchestrator, usage,
    awaitingApproval: (taskId) => runnerApprovals.waiting(taskId),
    checkpointQuestion: (taskId) => orchestrator.getCheckpointQuestion(taskId),
    waitsForApproval: (taskId): boolean => session.waitsForApproval(taskId),
    escalations: (): Escalation[] => session.escalations(),
    escalationsSent: (list) => escalationNotifier.changed(list),
  });

  const approvalPolicy = new ApprovalPolicy({
    autonomous: () => deps.config.autonomousMode,
    // Read per request, so a change of autonomy level or allowlist applies to the next call.
    mode: (kind) => effectiveApprovalMode(deps.config.approvalMode, deps.config.autonomousMode, kind),
    preApproved: () => plannerAllowlistOf(deps.config),
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
  const outboundSecrets = () => [...configSecrets(deps.config), ...mcpServer.heldTokens(), ...(aiService().heldSecrets?.() ?? [])];
  deps.fsAdapter.setOutboundSecrets?.(outboundSecrets);
  const webReads = new WebReadPolicy({
    approval: approvalPolicy,
    secrets: outboundSecrets,
    budget: () => deps.config.webReadBudget,
    turn: () => conversation?.currentTurnId,
    ...(deps.web?.resolveHost ? { resolveHost: deps.web.resolveHost } : {}),
  });
  // Every planner's web reads, carried here or natively, and every read-only
  // task's, are decided by the one policy, which asks through the same channel
  // as paths and commands. A task's decisions go to its attempt's log, never
  // to this channel (ADR-0046). The response cache and search provider are
  // process-wide, so parallel sessions, their subagents and their tasks share
  // bytes and the search cooldown.
  const fetcher = new HttpWebFetcher({
    policy: webReads,
    cache: deps.web?.cache ?? sharedWebResponseCache,
    searchProvider: deps.web?.searchProvider ?? sharedSearchProvider,
    ...(deps.web?.transport ? { fetchImpl: deps.web.transport } : {}),
    ...(deps.web?.resolveHost ? { resolveHost: deps.web.resolveHost } : {}),
  });

  const catalog = new SessionCatalog({
    config: deps.config,
    registry: deps.registry,
    modelResolver: deps.modelResolver,
    settings: deps.settings,
    // Read through the Session, which holds the plan; the catalog is built first.
    planRunners: (): RunnerId[] => session.planState?.runners ?? [],
    liveRunner: (taskId) => orchestrator.getAttempt(taskId) !== undefined,
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
    backend,
    planner: deps.planner ?? new Planner(deps.config, aiService),
    store,
    orchestrator,
    runs: orchestrator.runs,
    events,
    escalationNotifier,
    usage,
    windows,
    approvals,
    approvalPolicy,
    taskLogs,
    fetcher,
    skillsService: deps.skillsService ?? new SkillsService(deps.workspaceRoot()),
    saveSession: deps.saveSession ?? saveSession,
    lease: (onLost) => {
      const host = deps.leaseHost ?? (deps.saveSession ? undefined : processLeaseHost());
      return host ? host.lease(onLost) : UNLEASED;
    },
    conversation: (host) => (conversation = new PlannerConversation(host)),
  });
  return session;
}

/** The planner allowlist in force: the built-in reads unless turned off, then the user's entries. */
function plannerAllowlistOf(config: IConfig): string[] {
  return [...(config.approvalDefaults ? DEFAULT_PLANNER_ALLOWLIST : []), ...config.approvalPreApproved];
}

/** Every credential the config holds, read afresh so a key set mid-session is covered. */
function configSecrets(config: IConfig): string[] {
  return [
    config.apiKey, config.openAiApiKey, config.openrouterKey, config.geminiKey, config.openaiCompatibleApiKey,
    ...PROVIDER_PRIORITY.map((provider) => config.getProviderApiKey(provider)),
  ];
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
  backend: PlannerBackend;
  planner: SessionPlanner;
  store: PlanStore;
  orchestrator: TaskOrchestrator;
  /** The orchestrator's own: Session reads the run and acts on it there, Merge all aside. */
  runs: IsolationRunController;
  events: SessionEventRelay;
  /** Told by the Session when a plan changes hands; what it sees comes from the relay. */
  escalationNotifier: Pick<EscalationNotifier, 'hush' | 'baseline'>;
  usage: PlannerUsageLedger;
  /** The windows every stream of the session reports, saved with the plan. */
  windows: SessionWindows;
  approvals: PendingApprovals;
  approvalPolicy: ApprovalPolicy;
  /** Where the Session writes what it made of a task's event into that attempt's log. */
  taskLogs: Pick<TaskLogRecorder, 'note'>;
  fetcher: IWebFetcher;
  skillsService: Pick<SkillsService, 'findSkill' | 'listSkills' | 'searchedDirs' | 'forRoot'>;
  saveSession: SaveSession;
  /** Its lease, told by the Session what to do when another host takes it (ADR-0049). */
  lease: (onLost: (held: SessionHeld) => void) => SessionLease;
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
  readonly research = new ResearchTasks({
    plan: () => this.plan,
    owe: (id, to) => { this.store.update(id, { reportTo: to, researchOrigin: to }); },
  });

  private readonly backend: PlannerBackend;
  private readonly usage: PlannerUsageLedger;
  private readonly windows: SessionWindows;
  private readonly events: SessionEventRelay;
  private readonly escalationNotifier: SessionParts['escalationNotifier'];
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
  /**
   * The handoff the surfaces hold, folded from what this Session sent them as
   * they fold it, for one that joins late: the run record's own would also
   * show a handoff after a stop, which hands nothing over, and miss what the
   * supervisor has first.
   */
  private sentHandoff: IsolationHandoff | null = null;
  /** The effect allowlist rules already warned about as ignored, so each is said once, not on every script. */
  private readonly ignoredEffectRules = new Set<string>();
  /** The run was forgotten and no surface has been told yet; see {@link announceClosed}. */
  private closedUnannounced = false;
  private readonly notifications: INotification;
  private readonly onNotice?: (notice: SessionNotice) => void;
  private readonly modelResolver: ModelResolver;
  private readonly fsAdapter: IFileSystem;
  private readonly approvals: PendingApprovals;
  /** What the user, and the planner for research, approved to run; kept by {@link ApprovalRecord}, saved on the plan. */
  private readonly record: ApprovalRecord;
  /** Approval was withdrawn and no plan broadcast has carried it to the surfaces yet; see {@link withdrawalOwed}. */
  private withdrawalUnannounced = false;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly taskLogs: SessionParts['taskLogs'];
  private readonly fetcher: IWebFetcher;
  private readonly settingsFn: () => SessionRuntimeSettings;
  /**
   * This session's copy of the user's run settings (ADR-0030), seeded when it
   * opens. Another session's change writes the file but does not move this one.
   */
  private runSettingsValue: GlobalRunSettings;
  private readonly save: SaveSession;
  /** One live host per session (ADR-0049): no save, and no run, without it. */
  private readonly lease: SessionLease;
  /** The host a save was refused for, so the refusal is said once rather than at every save. */
  private saveRefusedFor: string | null = null;
  /** User controls in flight; see {@link withSave}. */
  private controlsInFlight = 0;
  /** A whole-plan start opening; a second Execute joins it rather than resetting the run under it. */
  private runOpening: Promise<void> | null = null;
  private unsubObserver: (() => void) | null;
  private readonly hostSessionId?: string;
  private currentSessionId: string;
  private readonly skillsService: Pick<SkillsService, 'findSkill' | 'listSkills' | 'searchedDirs' | 'forRoot'>;
  private readonly conversation: PlannerConversation;
  private readonly turns: PlanTurns;
  /** Destroyed: a turn that waited for the planner to be found must not open on it. */
  private closed = false;
  /** Destroyed and let go of its lease for good: whatever settles later neither saves nor holds the session. */
  private leaseReleased = false;
  /**
   * Turns PlanTurns does not open, waiting at the planner gate, each ended
   * with why it must not open: a Stop, a newer goal, or its plan scope ending.
   */
  private readonly openingsWaiting = new Set<(err: Error) => void>();
  /** The conversation's opening, from admission until its turn settles; see {@link behindOpening}. */
  private opening: PendingOpening | null = null;
  private readonly editor: PlanEditor;
  private readonly commands: ExecutionCommands;
  private readonly supervision: RunSupervision;
  /** The open planner turn's, or the last one's once it settled; see {@link openTurn}. */
  private turnEffects = new TurnEffects();
  private unlistenApprovals: (() => void) | null;
  /** The one check of a planner's change to the plan; an Act supervisor's edits meet its guard. */
  private readonly planChanges = new PlanChangeCheck(this.changeScope(() => this.supervisorEditing()));
  private readonly plannerTools: PlannerToolHandler = plannerToolHandler({
    skills: () => this.workspaceSkills().listSkills(),
    turnId: () => this.conversation.currentTurnId,
    recordSkillLoad: (skill) => this.conversation.recordPlannerSkill(skill),
    liveCatalog: () => this.liveCatalog(),
    checkPlan: async (tasks) => {
      // Discovered first: a model is resolved against what the runner was found to offer.
      await this.liveCatalog();
      return this.planChanges.check({ kind: 'plan', tasks }, 'submit');
    },
    submitPlan: (tasks, turn) => this.submitPlanFromTool(tasks, turn),
    editPlan: (ops, turn) => this.editPlanFromTool(ops, turn),
    tasks: () => this.store.planTasks,
    read: (signature, answer) => this.conversation.read(signature, answer),
    liveOutput: (taskId, opts) => this.orchestrator.getLiveOutput(taskId, opts),
    lastAttempt: (taskId) => lastAttemptDigest(this.taskLogLocation, taskId),
    taskLogAttempts: (taskId) => this.taskLogAttempts(taskId),
    taskLog: (taskId, attempt) => this.taskLog(taskId, attempt),
    taskDiff: (taskId, options) => {
      // A read-only task lands nothing and its worktree is gone: the patch it saved is what it changed (ADR-0050).
      const patch = savedPatchOf(this.store.get(taskId)?.handoff);
      if (patch) return Promise.resolve(readSavedPatch(readTaskPatch(this.taskLogLocation, taskId, patch.attempt), patch, options));
      return this.runs.taskDiff(taskId, options);
    },
    runCommand: (command, signal, opts) => this.fsAdapter.bash(command, signal, opts),
    fetchUrl: (url) => this.fetcher.fetch(url),
    webSearch: async (query) => this.fetcher.search?.(query),
    execute: (command, signal) => this.commands.run(command, this.turnActor(), signal),
    editsRefused: (change) => this.conversation.currentWakeUp?.refused(change),
  });

  constructor(parts: SessionParts) {
    this.config = parts.config;
    this.catalog = parts.catalog;
    this.workspace = parts.workspace;
    this.fsAdapter = parts.fsAdapter;
    this.broadcast = (msg) => {
      if (msg.type === 'isolation_handoff' || msg.type === 'isolation_merge' || msg.type === 'run_closed') {
        this.sentHandoff = reduceRun({ ...EMPTY_RUN, handoff: this.sentHandoff }, msg).handoff;
      }
      parts.broadcast(msg);
    };
    this.notifications = parts.notifications;
    this.onNotice = parts.onNotice;
    // A planner shell without an OS sandbox is said once, here, rather than in every command's output (ADR-0011 B5).
    this.fsAdapter.setNotice?.((message) => this.notice('warn', message));
    this.modelResolver = parts.modelResolver;
    this.settingsFn = parts.settings;
    this.runSettingsValue = { ...RUN_SETTINGS_DEFAULTS, ...(parts.settings().run ?? {}) };
    this.hostSessionId = parts.hostSessionId;
    this.currentSessionId = parts.hostSessionId ?? mintSessionId();
    this.backend = parts.backend;
    this.planner = parts.planner;
    this.store = parts.store;
    this.record = new ApprovalRecord({
      plan: () => this.plan,
      store: this.store,
      runnerModes: (runner) => this.catalog.edit().runnerModes?.[runner],
      onWithdrawn: (taskIds) => {
        // What the task would run now is not what was approved, so waiting on that is another wait (ADR-0053).
        for (const id of taskIds) this.store.endWait(id);
        this.withdrawalOwed();
      },
    });
    this.store.onTree = (ids) => this.record.reconcile(ids);
    this.orchestrator = parts.orchestrator;
    this.runs = parts.runs;
    this.events = parts.events;
    this.escalationNotifier = parts.escalationNotifier;
    this.usage = parts.usage;
    this.windows = parts.windows;
    this.approvals = parts.approvals;
    this.approvalPolicy = parts.approvalPolicy;
    this.taskLogs = parts.taskLogs;
    this.fetcher = parts.fetcher;
    this.skillsService = parts.skillsService;
    this.save = parts.saveSession;
    this.lease = parts.lease((held) => this.leaseLost(held));

    this.conversation = parts.conversation({
      plan: () => this.plan,
      goal: () => this.goal,
      aiService: () => this.backend.current(),
      onProgress: (p) => this.events.progress(p),
      opening: (runners) => this.conversationOpening(runners),
      catalog: () => this.catalog.current(),
      assignmentScope: () => this.catalog.scope(),
      autorun: () => this.userRunSettings().autorun,
      tasks: () => this.store.planTasks,
      // Before plan approval, only research has start rules to explain (ADR-0037 R4).
      startWaits: (task) => (this.record.planApproved || task.research ? this.orchestrator.startWaits(task) : []),
      liveOutput: (taskId, opts) => this.orchestrator.getLiveOutput(taskId, opts),
      isExecuting: () => this.isExecuting,
      mutate: (op, notify) => this.mutatePlan(op, notify),
      broadcast: (msg) => this.broadcast(msg),
      broadcastPlan: (turnId) => this.announcePlan(turnId),
      planChanges: this.planChanges,
      notice: (level, message) => this.notice(level, message),
      adoptTasks: (tasks, how) => this.adoptPlannerTasks(tasks, how),
      capturePrd: (text) => this.capturePrd(text),
      // A prompt raised by a turn nobody is waiting on has no one left to
      // serve; denying it at once unblocks the research loop, which otherwise
      // sat out the approval's five-minute timeout before seeing the stop.
      turnAborted: () => this.approvals.clear(isPlannerApproval),
      // A planner switch or settings change made while no turn ran is made
      // before the next one takes the backend, and one made during a turn as
      // soon as it is over.
      turnClaiming: () => this.backend.settle(),
      // After the turn has announced its end, so the next one never starts
      // ahead of it on a surface.
      turnReleased: () => {
        this.backend.settle();
        queueMicrotask(() => this.turns.pump());
      },
      usageLimit: (said, answered) => this.turns.usageLimit(said, answered),
      contextPaused: (details) => this.turns.contextPaused(details),
    });

    this.turns = new PlanTurns({
      turnStarting: () => {
        this.persist();
      },
      plan: () => (this.closed ? null : this.plan),
      conversationBusy: () => this.conversation.isTurnInFlight,
      mayWake: () => this.supervision.mayWake(),
      mayReport: () => this.supervision.mayReport(),
      persist: () => this.persist(),
      announce: () => {
        this.persist();
        this.announcePlan();
      },
      interrupt: () => { this.conversation.stopTurn('force_send'); },
      holdStarts: () => this.orchestrator.holdStarts(),
      // A start queued behind its dependencies waited for the turn too, with or without a run.
      resumeStarts: async () => {
        if (this.orchestrator.isRunning || this.orchestrator.startsPending) await this.withSave(() => this.orchestrator.tick());
      },
      run: async (prompt, { taken, signal }) => {
        const reply = (turnSignal: AbortSignal | undefined, wakeUp?: WakeUpTurn) => this.conversation.reply(prompt, {
          signal: turnSignal, onCommit: taken, wakeUps: prompt.wakeUps, forced: prompt.forced, ...(wakeUp ? { wakeUp } : {}), ...(prompt.recovery ? { recovery: prompt.recovery } : {}),
        });
        // Wake-ups that ride with a user's message are context for the user's turn.
        const { landed, effects } = await this.openTurn(() => (prompt.source === 'supervisor'
          ? this.supervision.wakeUp(reply, signal, prompt.authority)
          : reply(signal)));
        // A report turn for a task the user's turn started acts as their turns do, autorun included (ADR-0037, R3).
        if (prompt.source !== 'supervisor' || prompt.authority === 'user') this.autorunSubmitted(effects);
        return landed;
      },
      notice: (message) => this.notice('error', message),
      plannerDetecting: () => (installedPlannerAnswered() ? null : installedPlannerDetected()),
      assertPlannerReady: () => this.assertPlannerReady(),
      plannerRunner: () => runnerForProvider(this.config.aiProvider),
    });

    this.supervision = new RunSupervision({
      plan: () => this.plan,
      userSettings: () => this.userRunSettings(),
      tasks: () => this.store.planTasks,
      checkpointQuestion: (taskId) => this.orchestrator.getCheckpointQuestion(taskId) ?? undefined,
      landedWork: () => (this.runMergeView() ? 'pending' : this.runs.mergedRun ? 'merged' : null),
      recentOutput: (taskId) => this.orchestrator.getLiveOutput(taskId, { maxLines: 3 })?.text.trim(),
      reportTail: (taskId) => this.reportTail(taskId),
      reported: (taskId, to) => {
        this.store.update(taskId, { reportTo: undefined });
        if (!to.research) this.commands.scriptEnded(taskId, to);
      },
      systemNote: (text) => this.systemNote(text),
      supervisorNote: (text) => this.supervisorNote(text),
      changed: () => this.mutatePlan(() => true),
      save: () => this.persist(),
      resendHandoff: () => {
        const handoff = this.owedHandoff();
        if (handoff) this.broadcast({ type: 'isolation_handoff', ...handoff });
      },
      deliver: (digest, report) => this.turns.enqueue({ source: 'supervisor', text: digest, ...(report ? { report } : {}) }),
      pump: () => this.turns.pump(),
      restartPlanner: () => this.backend.current().restart?.(),
      abandonTurn: () => this.conversation.abandonHungTurn(),
      notice: (level, message) => this.notice(level, message),
    });
    this.unlistenApprovals = this.approvals.listen(({ request }) => {
      if (isRunnerApproval(request) && request.taskId) {
        this.supervision.observe({ kind: 'waiting_approval', taskId: request.taskId, detail: request.subject });
      }
    });

    this.editor = new PlanEditor({
      store: this.store,
      plan: () => this.plan,
      catalog: this.catalog,
      mutate: (op, notify) => this.mutatePlan(op, notify),
      scheduler: this.orchestrator,
      runs: this.runs,
      broadcast: (msg) => this.broadcast(msg),
      taskSkills: () => this.workspaceSkills(),
      notice: (level, message) => this.notice(level, message),
      approve: (taskIds) => this.record.approve(taskIds),
      plannedWith: () => this.plannedWithTrailer(),
    });

    this.commands = new ExecutionCommands({
      host: this.executionHost(),
      // A Guarded start asks on the card the planner's other requests use.
      consent: { request: (request) => this.approvals.ask(request) },
      guards: [this.supervision.guard],
      // Read per request, like the planner allowlist, so an edited rule applies to the next script (ADR-0035).
      effects: (body) => {
        const rules = parseEffectAllowlist(this.config.effectAllowlist, plannerAllowlistOf(this.config));
        for (const { rule, warning } of rules.ignored) {
          if (this.ignoredEffectRules.has(rule)) continue;
          this.ignoredEffectRules.add(rule);
          this.notice('warn', warning);
        }
        return effectRuleFor(rules, body);
      },
    });

    this.unsubObserver = this.orchestrator.subscribe(this.observer());
  }

  /**
   * The command seam (ADR-0029): an execution action asked for by `actor`,
   * checked, consented to and recorded in one place. The planner's execution
   * tools come here; see {@link ExecutionCommands}.
   */
  async execute(command: ExecutionCommand, actor: ExecutionActor): Promise<CommandOutcome> {
    return this.commands.run(command, actor);
  }

  /** What will not move without a person, derived afresh from the plan, the run and the pending approvals (ADR-0053). */
  escalations(): Escalation[] {
    if (!this.plan) return [];
    const { scheduled, resumable, advancesOnItsOwn } = this.orchestrator.activity;
    return escalations({
      tasks: this.store.planTasks,
      waits: this.orchestrator.planStartWaits(),
      approvals: this.approvals.outstanding(),
      attempt: (task) => this.orchestrator.latestAttempt(task),
      live: (taskId) => this.orchestrator.getAttempt(taskId) !== undefined,
      checkpoint: (taskId) => this.orchestrator.getCheckpointQuestion(taskId),
      waitsForApproval: (taskId) => this.record.waitsForApproval(taskId),
      startQueued: (taskId) => this.orchestrator.startQueuedFor(taskId),
      holdReason: (taskId) => this.orchestrator.holdReason(taskId),
      run: {
        open: scheduled || resumable,
        advancing: advancesOnItsOwn,
        merging: this.orchestrator.isMerging,
        autoMerges: this.orchestrator.mergesAtGates,
        mergesAtClose: this.orchestrator.mergesAtClose,
        merge: this.runMergeView(),
        id: this.runs.planIsolation?.run.id ?? null,
        blocked: this.runs.blocked ? this.runs.blockedStarts : null,
      },
    });
  }

  /** The user's answer to an escalation; see {@link ExecutionCommands.answerEscalation}. */
  async answerEscalation(id: string, option: string, note?: string, confirmed?: boolean): Promise<CommandOutcome> {
    return this.commands.answerEscalation(id, option, note, confirmed);
  }

  /** Run one planner turn with its own {@link TurnEffects}, which only a turn that lands hands back. */
  private async openTurn<T>(turn: () => Promise<T>): Promise<{ landed: T; effects: TurnEffects }> {
    const effects = new TurnEffects();
    this.turnEffects = effects;
    return { landed: await turn(), effects };
  }

  /**
   * Autorun (ADR-0030): a plan the planner submitted in the turn that just
   * ended starts as if the user had pressed Execute, through the seam, so the
   * timeline says autorun started it. Read now, not when the turn opened: the
   * switch is the user's to flip at any time. Work already live, a task the
   * planner started with `run_task` in that turn, joins it as one scheduled
   * run, so autorun skips only a run the scheduler already drives; in Guarded
   * only one at work, and the seam keeps it out of any other live work there.
   * A plan it could not start says why.
   */
  private autorunSubmitted(effects: TurnEffects): void {
    if (!effects.planSubmitted || !this.userRunSettings().autorun) return;
    if (this.orchestrator.isScheduling && (this.config.autonomousMode || this.orchestrator.hasLiveWork)) return;
    void this.execute({ command: 'run_plan' }, { kind: 'autorun' })
      .then((outcome) => { if (!outcome.ok) this.notice('warn', `Autorun could not start the plan: ${outcome.message}`); })
      .catch((err: unknown) => this.notice('error', `Autorun could not start the plan: ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * What the seam reads and calls: the operations the surfaces' buttons run,
   * less the approval a button press gives, which the seam decides itself.
   */
  private executionHost(): ExecutionHost {
    return {
      tasks: () => (this.plan ? this.store.planTasks : null),
      planApproved: () => this.record.planApproved,
      taskApproved: (taskId) => this.record.isApproved(taskId),
      waitsForApproval: (taskId) => this.record.waitsForApproval(taskId),
      approve: (taskIds) => this.record.approve(taskIds),
      approvePlan: () => this.record.approvePlan(),
      autonomous: () => this.config.autonomousMode,
      autorun: () => this.userRunSettings().autorun,
      scheduling: () => this.orchestrator.isScheduling,
      startsHeld: () => this.orchestrator.startsHeld,
      hasLiveWork: () => this.orchestrator.hasLiveWork,
      startsPending: () => this.orchestrator.startsPending,
      loopRunsOn: (taskId) => this.orchestrator.loopRunsOn(taskId),
      advancesOnItsOwn: () => this.orchestrator.advancesOnItsOwn,
      admitStart: () => this.orchestrator.admitStart(),
      running: (taskId) => this.orchestrator.getAttempt(taskId) !== undefined,
      repairOwed: (taskId) => this.orchestrator.repairWait(taskId) !== null,
      maxParallel: () => this.config.maxParallelSessions,
      runBlocked: () => this.runs.blocked,
      startWaits: (task) => this.orchestrator.startWaits(task),
      waitingRequests: (taskId) => this.approvals.outstanding()
        .filter(({ request }) => isRunnerApproval(request) && request.taskId === taskId)
        .map(({ id, request }) => ({ id, subject: request.subject })),
      runPlan: (actor) => this.runWholePlan(runOrigin(actor)),
      joinRun: (approved, left) => this.joinRun(approved, left),
      startTask: (taskId, actor) => this.startOneTask(taskId, runOrigin(actor)),
      forceStart: (taskId) => this.withSave(() => this.orchestrator.forceStartTask(taskId, 'user')),
      markComplete: (taskId) => this.withSave(() => this.orchestrator.markTaskComplete(taskId)),
      markNotDone: (taskId) => this.withSave(() => this.orchestrator.markTaskIncomplete(taskId)),
      revertScope: (taskId) => this.orchestrator.revertScope(taskId),
      revertTask: (taskId) => this.withSave(() => this.orchestrator.revertTask(taskId)),
      interrupt: (taskId) => this.withSave(() => this.orchestrator.interruptTask(taskId)),
      stopTask: (taskId) => this.withSave(() => this.orchestrator.cancelTask(taskId)),
      stopRun: () => this.stopExecution(),
      retryTask: (taskId, actor) => this.restartTask(taskId, runOrigin(actor)),
      skipTask: (taskId, reason, actor) => this.withSave(() => this.orchestrator.skipTask(taskId, reason, runOrigin(actor))),
      continueTask: (taskId, message, actor) => this.resumeTask(taskId, message, runOrigin(actor)),
      resumeNow: (taskId, message, actor) => this.withSave(() => this.orchestrator.resumeNow(taskId, runOrigin(actor), message)),
      messageTask: (taskId, text) => this.sendTaskMessage(taskId, text),
      forceMessage: (taskId, text) => this.forceSendTaskMessage(taskId, text),
      forceSendQueued: (taskId, id) => this.forceSendQueuedTaskMessage(taskId, id),
      removeQueued: (taskId, id) => this.removeQueuedTaskMessage(taskId, id),
      cancelResume: (taskId) => this.cancelScheduledResume(taskId),
      awaitsCheckpoint: (taskId) => this.awaitsCheckpoint(taskId),
      approveReview: async () => {
        // The plan's own mark beside the record the seam keeps: planner starts read it (ADR-0029).
        this.record.approvePlan();
        await this.withSave(() => this.orchestrator.approveReview('user'));
      },
      answerCheckpoint: (taskId, approve, reason) => (approve ? this.approveCheckpoint(taskId) : this.rejectCheckpoint(taskId, reason)),
      answerRequest: (requestId, decision) => this.resolveApproval(requestId, decision),
      mergeAll: () => this.mergeAll(),
      runMerged: () => this.runs.mergedRun !== null,
      record: (record, text) => this.recordExecution(record, text),
      guardTripped: (trip) => this.supervision.guardTripped(trip),
      turnHandle: (name) => this.conversation.turnHandle(name),
      draftScript: (call, actor) => this.draftScript(call, actor),
      addScript: (task, actor) => this.addScript(task, actor),
      startAtGate: (taskId) => this.orchestrator.startAtGate(taskId),
      awaitEnd: (taskId, ms, signal) => this.awaitEnd(taskId, ms, signal),
      owe: (taskId, to) => this.oweReport(taskId, to),
      reportTail: (taskId) => this.reportTail(taskId),
      escalations: () => this.escalations(),
      resolveConflict: async (taskId) => (await this.resolveConflictAsTask(taskId)) !== null,
      continueRun: (how) => (how === 'stash' ? this.continueWithStash() : this.continueWithoutIsolation()),
    };
  }

  /**
   * The script task a `run_script` call would add (ADR-0035), checked as the
   * planner's own add is, against the plan as it stands, the turn's committed
   * edits included. A supervisor's is held to the oscillation guard its edits
   * are held to, and marked as its own.
   */
  private draftScript(call: Extract<ExecutionCommand, { command: 'run_script' }>, actor: ExecutionActor): { ok: true; task: Task } | { ok: false; errors: string[] } {
    const spec: Partial<Task> = {
      title: call.title, type: 'script', sliceType: 'AFK',
      ...(call.commands !== undefined ? { commands: call.commands } : {}),
      ...(call.script !== undefined ? { script: call.script } : {}),
      ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
      ...(call.dependencies !== undefined ? { dependencies: call.dependencies } : {}),
    };
    // A script attaches no skill, so nothing waits between the check and the start that follows it.
    const checked = new PlanChangeCheck(this.changeScope(() => actor.kind === 'supervisor')).checkNow({ kind: 'ops', ops: [{ op: 'add', task: spec }] }, 'land');
    if (!checked.ok) return { ok: false, errors: checked.errors.map((e) => e.message) };
    const known = new Set(this.store.allTasks.map((t) => t.id));
    const task = flattenTasks(checked.tasks).find((t) => !known.has(t.id));
    if (!task) return { ok: false, errors: ['the plan did not take it'] };
    return { ok: true, task: actor.kind === 'supervisor' ? { ...task, addedBy: 'supervisor' } : task };
  }

  /** A drafted script task into the plan now, unapproved: the seam approves it once its start is consented to. */
  private addScript(task: Task, actor: ExecutionActor): void {
    const before = this.store.planTasks;
    this.mutatePlan(() => {
      this.store.add(task);
      return true;
    });
    if (actor.kind === 'supervisor') this.supervision.edited(before, this.store.planTasks);
  }

  /** Settles once the task's attempt is over — it ended, was stopped or left the plan — or after `ms`, or as `signal` aborts. */
  private awaitEnd(taskId: string, ms: number, signal?: AbortSignal): Promise<void> {
    const over = () => {
      const task = this.store.get(taskId);
      return !task || reportEnded(task) || (task.status !== 'in_progress' && !this.orchestrator.getAttempt(taskId));
    };
    if (over() || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      const check = () => { if (over()) done(); };
      const unsubscribe = this.orchestrator.subscribe({ onTaskChanged: check, onTaskSettled: check });
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** A task's result is owed to the planner (ADR-0037, R2): saved on the task, so a restart still owes it. */
  private oweReport(taskId: string, to: TaskReportTo): void {
    this.mutatePlan(() => !!this.store.update(taskId, { reportTo: to }), () => {});
  }

  /** The end of a task's output as a report carries it: the live capture while it lasts, else the tail its verdict kept. */
  private reportTail(taskId: string): string | undefined {
    const live = this.orchestrator.getLiveOutput(taskId, { maxLines: REPORT_TAIL_LINES })?.text;
    return live?.trim() ? live : this.store.get(taskId)?.outputSummary?.logTail;
  }

  /** The open planner turn is the supervisor's, acting at Act: its edits and added tasks are its own (ADR-0029). */
  private supervisorEditing(): boolean {
    const actor = this.turnActor();
    return actor.kind === 'supervisor' && actor.level === 'act';
  }

  /**
   * What every planner change is checked against (`PlanChangeCheck`), as it
   * is submitted and as it commits: the live catalog and plan, and the
   * handles the open turn's committed edits gave. A change may put a task
   * only on the runners enabled now (`assignableRunners`), one set at both
   * ends, so what was accepted cannot be refused at commit unless the catalog
   * moved; the plan's own runners' modes are read too, for a task left on one
   * switched off since. `guarded`: the change meets the supervisor's
   * oscillation guard.
   */
  private changeScope(guarded: () => boolean): PlanChangeScope {
    return {
      tasks: () => this.store.planTasks,
      runners: (kind) => this.catalog.runnersFor(kind === 'plan' ? 'plan' : 'edit') ?? [],
      catalog: (runners) => this.catalog.edit([...new Set([...(this.plan?.runners ?? []), ...runners])]),
      skills: () => this.workspaceSkills(),
      handles: () => this.conversation.turnHandles(),
      guard: (before, after) => (guarded() ? this.supervision.checkEdit(before, after)?.refusal : undefined),
    };
  }

  /** A line from Ordewell itself, kept in the transcript where it happened. */
  private systemNote(text: string): void {
    this.mutatePlan(() => {
      // Surfaces take from the transcript only entries newer than the last they synced, so a note in that entry's millisecond would never show.
      const newest = (this.plan?.conversationHistory ?? []).reduce((latest, e) => Math.max(latest, Date.parse(e.timestamp) || 0), 0);
      this.conversation.append('assistant', text, { kind: 'system', timestamp: new Date(Math.max(Date.now(), newest + 1)).toISOString() });
      return true;
    });
  }

  /** A message to the user in the supervisor's voice, kept in the transcript where it happened. */
  private supervisorNote(text: string): void {
    const timestamp = new Date().toISOString();
    this.mutatePlan(() => {
      this.conversation.append('assistant', text, { timestamp, kind: 'supervisor' });
      return true;
    }, () => this.broadcast({ type: 'planner_message', content: text, timestamp, supervisor: true }));
  }

  /**
   * Who the open planner turn speaks for at the seam: the supervisor in a
   * wake-up turn, at its level as of this call, else the user's turn — which a
   * report turn for a task that turn started acts as (ADR-0037, R3).
   */
  private turnActor(): ExecutionActor {
    const wakeUp = this.conversation.currentWakeUp;
    if (!wakeUp) return { kind: 'planner-turn' };
    return wakeUp.actor?.() ?? { kind: 'supervisor', level: this.supervision.level };
  }

  /** Whether the commits Ordewell writes carry the Planned-with trailer now; the user's setting, not the run's copy, so a change reaches the next landing. */
  plannedWithTrailer(): boolean {
    return this.settingsFn().run?.plannedWithTrailer ?? this.runSettingsValue.plannedWithTrailer;
  }

  /** The run settings this session shows and starts its runs with (ADR-0030): its own copy, not the file's. */
  runSettings(): GlobalRunSettings {
    // The Planned-with line keeps no copy: every landing reads the user's saved setting (ADR-0030).
    return { ...this.runSettingsValue, plannedWithTrailer: this.plannedWithTrailer() };
  }

  /** The user's run settings as they stand for this session (ADR-0030). */
  private userRunSettings(): GlobalRunSettings {
    return this.runSettingsValue;
  }

  /** A call at the seam, in the transcript where it happened and on every surface at once. */
  private recordExecution(record: ExecutionRecord, text: string): void {
    this.supervision.executed(record);
    this.mutatePlan(() => {
      this.conversation.recordExecution(record, text);
      return true;
    }, () => this.broadcast({ type: 'execution_action', record, text }));
  }

  /** Whether the user approved this task to run; see {@link ApprovalRecord.isApproved}. */
  isApproved(taskId: string): boolean {
    return this.record.isApproved(taskId);
  }

  /** A task the scheduler leaves for the user to approve; see {@link ApprovalRecord.waitsForApproval}. */
  waitsForApproval(taskId: string): boolean {
    return this.record.waitsForApproval(taskId);
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

  /** The planner's requests still waiting, as their cards were announced — what a surface (re)joining replays. */
  announcedApprovals(): Extract<SessionMessage, { type: 'approval_request' }>[] {
    return this.events.announcedApprovals();
  }

  /**
   * The planner compaction in flight, as its start was announced, for a
   * surface that joins or reconnects while it runs; undefined when none is.
   */
  plannerCompaction(): Extract<SessionMessage, { type: 'planner_compaction' }> | undefined {
    return this.events.currentCompaction();
  }

  /** Scopes the user granted this session — surfaced so a UI can show what is already allowed. */
  approvedScopes(): string[] {
    return this.approvalPolicy.grantedScopes();
  }

  /** The stable id this session persists under — matches the host's id when one was provided. */
  get sessionId(): string { return this.currentSessionId; }
  /**
   * The workspace whose account this session's planner gate judges, so a host
   * can re-probe it before a turn without keeping a second copy.
   */
  get workspaceRoot(): string { return this.workspace; }
  /** The planner this session's own gate reads — not whatever the host's config says now. */
  get plannerProvider(): PlannerBackendId { return this.config.aiProvider; }
  /** Where this session's structured task logs are saved (ADR-0018, P1). */
  get taskLogLocation(): TaskLogLocation { return { baseDir: this.workspace, sessionId: this.currentSessionId }; }

  /** The attempts of a task that have a saved log, oldest first. */
  taskLogAttempts(taskId: string): number[] {
    return listTaskLogAttempts(this.taskLogLocation, taskId);
  }

  /**
   * Mark tasks a saved plan has no attempted flag for but whose logs prove an
   * attempt ran. Only AI and script tasks: a manual task's completion wrote a
   * handoff log, which is not a chat.
   */
  private creditLoggedAttempts(tasks: readonly Task[]): void {
    for (const task of flattenTasks(tasks)) {
      if (task.attempted || task.type === 'user') continue;
      if (this.taskLogAttempts(task.id).length > 0) task.attempted = true;
    }
  }

  /** One attempt's saved log, for `replayTaskLog` — what a reopened task view shows. */
  taskLog(taskId: string, attempt: number): TaskLogEvent[] {
    return readTaskLog(this.taskLogLocation, taskId, attempt).map((event) => event.type === 'handoff'
      ? { ...event, handoff: resolveHandoffReferences(event.handoff, this.workspace) } : event);
  }

  get executionLog(): ReadonlyArray<TaskSnapshot> { return this.store.getExecutionLog(); }
  /** Tasks always read from PlanStore — the single source of truth. */
  get planTasks(): ReadonlyArray<Readonly<Task>> { return this.store.planTasks; }

  /**
   * The relay announces every orchestrator event; this adds the saves some of
   * them owe, each made before the announcement so no surface sees state the
   * disk lacks.
   */
  private observer(): OrchestratorObserver {
    const relay = this.events.observer(() => this.plan);
    return {
      ...relay,
      onRunStarted: ({ origin }) => {
        if (!this.plan) return;
        this.supervision.runStarted(origin);
        this.persist();
        this.announcePlan();
      },
      onAutoMerge: ({ trigger, result }) => {
        if (!this.plan) return;
        const taskId = trigger.kind === 'gate' ? trigger.taskId : undefined;
        // Saved either way: the run record changed with the merge.
        this.mutatePlan(() => {
          if (result.outcome === 'merged') {
            this.conversation.append('assistant', taskId === undefined
              ? 'Ordewell setting: auto-merged at the end of the run'
              : `Ordewell setting: auto-merged for task ${this.store.get(taskId)?.order ?? taskId}`, { kind: 'system', actor: 'Ordewell setting' });
          }
          return true;
        });
        this.broadcast({ type: 'isolation_merge', result, trigger });
        this.announceClosed();
        if (result.outcome !== 'merged') this.supervision.observe({ kind: 'auto_merge_stopped', ...(taskId === undefined ? {} : { taskId }), detail: mergeStopped(result) });
      },
      onTaskChanged: () => {
        this.saveForControl();
        relay.onTaskChanged();
      },
      onTick: () => {
        this.saveForControl();
        relay.onTick();
      },
      // Saved the moment it settles: a shared run has no run record to save
      // it mid-run, so a crash would otherwise lose every verdict since the
      // last Session operation.
      onTaskSettled: ({ taskId }) => {
        const task = this.store.get(taskId);
        if (task) this.supervision.taskSettled(task);
        this.persist();
      },
      onUsageLimitWait: ({ taskId, runner, resumeAt, cancelled }) => {
        if (!cancelled) this.supervision.observe({ kind: 'usage_limit', taskId, runner, resumeAt });
      },
      onModelSwitched: (switched) => { void this.followRunnerModel(switched); },
      onTaskIdle: ({ taskId, idleSince }) => {
        this.supervision.observe({ kind: 'task_idle', taskId, detail: `no output since ${idleSince}` });
      },
      onUsageChanged: () => {
        this.persist();
        relay.onUsageChanged();
      },
      onIsolationChanged: () => {
        // The run record names branches and worktrees on disk, so it is saved
        // as it changes rather than at the end: a crash must still find them.
        this.persist();
        relay.onIsolationChanged();
      },
      onRunClosed: () => { this.closedUnannounced = true; },
      onIsolationHandoff: (handoff) => this.broadcast({ type: 'isolation_handoff', ...this.supervision.handoff(handoff) }),
      onExecutionComplete: () => {
        this.persist();
        this.announceClosed();
        relay.onExecutionComplete();
        this.supervision.runFinished();
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
   * Persists PlanStore state to disk. PlanStore is the single authority. Any
   * save may come in the middle of a planner turn, and finds nothing of it to
   * write: a turn holds what it writes until the mutation that lands it.
   */
  private persist(): void {
    // A save that settles after destroy would claim the lease again, and hold
    // the session from every other host until this process exits (ADR-0049 L7).
    if (!this.plan || this.leaseReleased) return;
    // A host that does not hold the session must not write over the one that
    // does (ADR-0049): the last writer would otherwise win.
    const held = this.heldElsewhere();
    if (held) {
      this.saveRefused(held);
      return;
    }
    this.syncPlanTasks();
    this.plan.isolation = this.runs.planIsolation ?? undefined;
    this.plan.mergedRun = this.runs.mergedRun ?? undefined;
    this.plan.plannerUsage = this.usage.snapshot();
    this.plan.contextWindows = this.windows.snapshot();
    // What supervision remembers is read here, at the one save seam, so it is
    // written in the same save as the action that changed it (ADR-0029).
    this.plan.supervision = this.supervision.snapshot();
    this.plan.lastUpdated = new Date().toISOString();
    this.save(this.plan, this.goal, this.workspace, this.currentSessionId);
  }

  /** A new plan on a long-lived Session gets its own persisted identity (unless the host fixed one). */
  private remintSessionId(): void {
    if (this.hostSessionId) return;
    this.currentSessionId = mintSessionId();
    // The session left is no longer open here; the new one is claimed at its first save.
    this.lease.release();
  }

  /**
   * Null while this Session may save its session and run in its isolation
   * run; otherwise the host that holds it (ADR-0049). Claims the lease when
   * no live host holds it, as a new session's first save does.
   */
  heldElsewhere(): SessionHeld | null {
    if (this.leaseReleased) return null;
    return this.lease.hold(this.currentSessionId, this.workspace);
  }

  /**
   * A new plan under the host's fixed id writes that session's file: refused
   * before any planner turn while another host has it open (ADR-0049). A
   * minted id is new, and is claimed at its first save.
   */
  private claimHostSession(): void {
    if (this.hostSessionId) this.lease.claim(this.hostSessionId, this.workspace);
  }

  private saveRefused(held: SessionHeld): void {
    if (this.saveRefusedFor === held.holder.hostId) return;
    this.saveRefusedFor = held.holder.hostId;
    this.notice('error', `${describeHeld(held)} Nothing of this session is saved from here meanwhile.`);
  }

  /**
   * Another host took the session over, judging this one gone (ADR-0049). Its
   * runners must not work on beside that host's, in the worktrees that host
   * now prepares, so the run here stops.
   */
  private leaseLost(held: SessionHeld): void {
    this.saveRefusedFor = held.holder.hostId;
    this.notice('error', describeLost(held));
    if (this.isExecuting || this.orchestrator.isRunning || this.orchestrator.awaitsResume || this.orchestrator.startsPending) this.stopExecution();
  }

  /**
   * The plan scope ends: everything that belongs to the plan this Session
   * holds goes, so nothing of it reaches the next one — a new plan, another
   * session adopted, or the Session closed. Its run is stopped, the planner
   * turn in flight is abandoned with everything it held, and the
   * conversation, supervision, usage ledger, execution log and planner
   * prompts are cleared. A new plan on the same
   * Session keeps the scopes the user granted (`keepGrants`); a session
   * boundary does not (ADR-0008).
   */
  private dropPlanScope({ keepGrants = false }: { keepGrants?: boolean } = {}): void {
    this.escalationNotifier.hush();
    // A turn waiting at the planner gate belongs to this scope too: let open
    // later, it would plan the old goal in whatever scope is held by then.
    this.endWaiting(() => new PlannerTurnDiscardedError());
    // A start still opening its run belongs to this plan: let through, it would claim a task of the next one that shares its id.
    if (this.isExecuting || this.orchestrator.isRunning || this.orchestrator.awaitsResume || this.orchestrator.startsPending) this.stopExecution();
    this.conversation.abandonTurn();
    this.turns.abandon();
    this.supervision.reset();
    this.conversation.reset();
    // Totals belong to the plan they were recorded under; a fresh plan starts
    // its ledger from zero so the previous session's line never lingers.
    this.usage.clear();
    this.windows.clear();
    // A prompt raised by the turn we are abandoning has nobody left to serve;
    // denying it unblocks the old research loop instead of stranding it.
    this.approvals.clear(isPlannerApproval);
    if (!keepGrants) this.approvalPolicy.reset();
    this.store.clearLog();
    this.sentHandoff = null;
    this.closedUnannounced = false;
  }

  /** The handoff a settled run with landed work owes the user, unmarked; null while a run is open or nothing landed. */
  private owedHandoff(): IsolationHandoff | null {
    const handoff = this.runs.view()?.handoff;
    return !this.runs.isOpen && handoff?.landed.length ? handoff : null;
  }

  /**
   * A new plan starts from zero. Without this, a long-lived Session (VS Code
   * hosts exactly one) leaks the previous session's tasks into the per-turn
   * plan block — the model is told they are the CURRENT plan and re-presents
   * them as its draft.
   */
  private beginFreshPlan(opts: { keepGrants?: boolean } = {}): void {
    this.dropPlanScope(opts);
    this.orchestrator.loadPlan([]);
    void this.runs.adopt(null);
    this.escalationNotifier.baseline([]);
  }

  /**
   * Return the Session to a blank slate — hosts call this on "new session".
   * Everything scoped to the old session goes: the live AI conversation, plan,
   * goal, tasks, execution log, pending turns, approved scopes, model cache,
   * and (unless the host fixed one) the persisted identity, so nothing can
   * bleed into the next session.
   */
  reset(): void {
    // Null the plan first so orchestrator-stop observer callbacks
    // (onTaskChanged → status_update) no-op instead of broadcasting the
    // dying session's tasks.
    this.plan = null;
    this.goal = '';
    this.beginFreshPlan();
    this.catalog.reset();
    this.remintSessionId();
    this.fsAdapter.endSession?.();
  }

  /** What a planner may assign right now; see {@link SessionCatalog.live}. */
  liveCatalog(): Promise<TaskQueryCatalog> {
    return this.catalog.live();
  }

  get planState(): LegacyPlanState | null { return this.plan; }

  /**
   * The live plan in the shape a saved session is read back as. The disk
   * boundary fails an `in_progress` task — nothing is running when a session
   * comes off a file — so a surface that re-reads the plan mid-run must come
   * here instead, or every task it is watching reads as interrupted.
   * An archived snapshot carries the task as it is now: a retry or continue
   * keeps the archive while the live task runs on and spends more.
   */
  get currentPlanState(): PlanState | null {
    if (!this.plan) return null;
    const executionLog = this.store.getExecutionLog().map((s) => ({ ...s, ...this.store.get(s.id) }));
    const logged = new Set(executionLog.map((s) => s.id));
    const pendingTasks = this.store.planTasks.filter((t) => !logged.has(t.id));
    const record = approvalRecordOf(this.plan);
    if (executionLog.length === 0 && !this.orchestrator.isRunning) {
      return { phase: 'planning', history: [], message: '', pendingTasks, ...record };
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
      ...record,
    };
  }

  get currentGoal(): string { return this.goal; }
  /**
   * A task is running right now. Deliberately live work, not the scheduler's
   * armed flag: a run paused on a user task, a hold or a cancellation has
   * nothing executing, and reporting it as executing is what left the plan
   * unstartable after its last live task was cancelled. See
   * {@link TaskOrchestrator.hasLiveWork}: a spawned runner, not merely an armed scheduler.
   */
  get isExecuting(): boolean { return this.orchestrator.hasLiveWork; }
  get status(): 'approved' | 'running' | 'completed' { return this.orchestrator.status; }

  /**
   * Throws {@link PlannerNotReadyError} when the planner this session's config
   * selects cannot plan. Judged on the session's own config, so a model
   * override sent with the request is the one judged; every planner turn
   * passes it, and a host may call it first to refuse before it builds on
   * the session.
   */
  assertPlannerReady(): void {
    // Read the record for this session's workspace: a daemon may serve several,
    // and another one's runner list must not decide this planner's login.
    const reason = plannerNotReadyFor(this.config, (runner) => recordedRunnerAuth(runner, this.workspace));
    if (reason) throw new PlannerNotReadyError(reason);
  }

  /**
   * The planner gate for a turn {@link PlanTurns} does not open — an opening,
   * plan generation, a compaction — the same one its turns pass: wait for the
   * installed-planner probe, then judge the planner in use now. A wait is
   * ended at once, not when the probe answers, by its caller's abort, a Stop,
   * a newer goal or its plan scope ending ({@link endWaiting}): a turn that
   * only learnt of these afterwards would open on a session that moved on.
   *
   * Null when the turn may open at once: awaited regardless, the turn would
   * take the conversation a tick late, and a message sent alongside it would
   * no longer be refused as one sent during it.
   */
  private plannerTurnMayOpen(signal?: AbortSignal): Promise<void> | null {
    if (installedPlannerAnswered()) {
      this.assertPlannerReady();
      return null;
    }
    if (signal?.aborted) return Promise.reject(new PlannerTurnStoppedError());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        if (this.openingsWaiting.delete(end)) end(new PlannerTurnStoppedError());
      };
      const end = (err: Error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      };
      this.openingsWaiting.add(end);
      signal?.addEventListener('abort', onAbort, { once: true });
      installedPlannerDetected().then(() => {
        // Ended meanwhile: its caller has heard, and the probe's answer must not open it after all.
        if (!this.openingsWaiting.delete(end)) return;
        signal?.removeEventListener('abort', onAbort);
        this.assertPlannerReady();
      }).then(resolve, reject);
    });
  }

  /** End every turn waiting at the planner gate before it opens; false when none was. */
  private endWaiting(why: () => Error): boolean {
    const waiting = [...this.openingsWaiting];
    this.openingsWaiting.clear();
    for (const end of waiting) end(why());
    return waiting.length > 0;
  }

  /**
   * Whether a planner turn — a reply, a compaction, plan generation — holds
   * the conversation, or one admitted waits at the planner gate to: a host
   * that read the wait as idle sent a follow-up as a new goal.
   */
  get isPlannerBusy(): boolean { return this.conversation.isTurnInFlight || this.openingsWaiting.size > 0; }

  /**
   * The planner turn answering right now, if one is: a surface whose stream
   * lost that turn's end reads this back to tell a stale gate from a live one.
   */
  get plannerTurnId(): string | undefined { return this.conversation.currentTurnId; }

  /**
   * Stop the planner turn in flight. It still settles — a backend hands back
   * what it had — and ends as stopped. A turn still waiting at the planner
   * gate is stopped too, before it opens, and so is every message sent behind
   * either: the user stopped the planner, not one turn of it. False when
   * there was neither.
   */
  abortPlannerTurn(): boolean {
    // The queue first, while the stopped turn still holds the conversation: its release must find nothing of the user's to open.
    const queued = this.turns.stopQueued();
    const inFlight = this.conversation.stopTurn();
    const waiting = this.endWaiting(() => new PlannerTurnStoppedError());
    return inFlight || queued || waiting;
  }

  /**
   * The runners a first turn may plan for. None requested means every enabled
   * one, read here, after the planner gate: until the installed-agent probe
   * answers, the enabled default is a stale guess a request must not freeze.
   */
  private chosenRunners(requested: RunnerId[] | undefined): RunnerId[] {
    const enabled = this.catalog.enabledRunners();
    const chosen = requested ? requested.filter((r) => enabled.includes(r)) : enabled;
    if (chosen.length === 0) throw new Error('None of the requested runners are enabled');
    return chosen;
  }

  /** Whether a first turn for `requested` would be refused for want of an enabled runner: a host calls it before it replaces a live session. */
  assertRunnersEnabled(requested: RunnerId[] | undefined): void {
    this.chosenRunners(requested);
  }

  async generatePlan(goal: string, runners?: RunnerId[], options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    // A new goal replaces whatever still waits to open: the latest intent wins.
    this.endWaiting(() => new PlannerTurnDiscardedError());
    // Before the plan scope is dropped, so a refusal leaves the plan held now as it was.
    const opening = this.plannerTurnMayOpen(options?.signal);
    if (opening) await opening;
    const chosenRunners = this.chosenRunners(runners);
    this.claimHostSession();
    this.plan = null;
    this.goal = goal;
    this.remintSessionId();
    this.beginFreshPlan({ keepGrants: true });

    const generated = await this.conversation.hold(options?.signal, async (turn) => {
      const { modelsByRunner, runnerModes } = await this.catalog.planning(chosenRunners);
      const settings = this.settingsFn();
      const modes = { ...plannerModesFrom(this.config.autonomousMode), isolatedExecution: await this.runs.plannerLayout(), taskSkills: this.workspaceSkills() };
      const subagents = new SubagentRuns();

      const { skillWarnings = [], ...plan } = await this.planner.generate({
        goal,
        runners: chosenRunners,
        modelsByRunner,
        runnerModes,
        autonomousDefault: this.config.autonomousMode,
        fs: this.fsAdapter,
        fetcher: this.fetcher,
        onProgress: (p) => {
          subagents.observe(p);
          this.events.progress(p);
        },
        signal: turn.signal,
        perRunnerAllowlist: settings.modelAllowlist,
        modes,
      });
      if (turn.abandoned) throw new PlannerTurnDiscardedError();

      // Part of the plan as it is adopted, like the research the planner returned.
      plan.researchLog = subagents.foldInto(plan.researchLog ?? []);
      this.plan = plan;
      this.mutatePlan(() => {
        this.conversation.recordSkillWarnings(skillWarnings, plan.generatedAt);
        this.orchestrator.loadPlan(plan.tasks, plan.runners);
        this.store.resetForRun({ preserveCompleted: false });
        this.adoptResearch([]);
        return true;
      });
      for (const warning of skillWarnings) this.notice('warn', warning);
      return plan;
    });
    if (this.orchestrator.startsPending) await this.withSave(() => this.orchestrator.tick());
    return generated;
  }

  /**
   * Kick off the planner conversation (ADR-0002): research + the first planner
   * message. The conversation itself — transcript, live model context, turn
   * settlement — is {@link PlannerConversation}'s; the Session hosts it.
   */
  async startPlanning(goal: string, runners?: RunnerId[], options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    // A new goal replaces whatever still waits to open: the latest intent wins.
    this.endWaiting(() => new PlannerTurnDiscardedError());
    const pending: PendingOpening = { held: [] };
    this.opening = pending;
    let opened: Promise<{ landed: LegacyPlanState; effects: TurnEffects }>;
    try {
      const gate = this.plannerTurnMayOpen(options?.signal);
      if (gate) await gate;
      const chosenRunners = this.chosenRunners(runners);
      this.claimHostSession();
      this.plan = null;
      this.goal = goal;
      this.remintSessionId();
      this.beginFreshPlan({ keepGrants: true });

      const now = new Date().toISOString();
      this.plan = { tasks: [], generatedAt: now, status: 'draft', runners: chosenRunners, lastUpdated: now };
      opened = this.openTurn(() => this.conversation.start(this.resolveSkillInvocation(goal), () => this.conversationOpening(chosenRunners), options?.signal));
    } catch (err) {
      // What was sent behind an opening that never opened shares its end: a
      // stop, a newer goal, a refusal its sender must hear as the goal's.
      if (this.opening === pending) this.opening = null;
      for (const held of pending.held ?? []) held.reject(err);
      throw err;
    }
    // The opening holds the conversation now, so what waited for it queues behind it, in order.
    const held = pending.held ?? [];
    pending.held = null;
    for (const h of held) this.turns.follow(h.input, h.forced).then(h.resolve, h.reject);
    try {
      const { landed, effects } = await opened;
      this.autorunSubmitted(effects);
      if (this.orchestrator.startsPending) await this.withSave(() => this.orchestrator.tick());
      return landed;
    } catch (err) {
      if (err instanceof PlannerContextPausedError && this.plan) {
        this.turns.waitOnPause({ source: 'user', ...this.resolveSkillInvocation(goal) });
        return this.plan;
      }
      if (!(err instanceof PlannerUsageLimitError) || !this.plan) throw err;
      // A goal its own submit_plan already answered is not sent again to be planned twice (ADR-0022 P2).
      if (!err.answered) this.turns.waitOnLimit({ source: 'user', ...this.resolveSkillInvocation(goal) });
      return this.plan;
    } finally {
      if (this.opening === pending) this.opening = null;
    }
  }

  /**
   * A message sent while the conversation's opening is pending answers it, so
   * it goes after it rather than replacing the goal or being refused: held
   * while the opening waits at the planner gate — there is no conversation
   * yet to queue it on — and queued behind it once it holds the conversation.
   * Null with no opening pending.
   */
  private behindOpening(input: PlanTurnInput, forced = false): Promise<LegacyPlanState> | null {
    const pending = this.opening;
    if (!pending) return null;
    const held = pending.held;
    if (!held) return this.turns.follow(input, forced);
    return new Promise((resolve, reject) => {
      held.push({ input, forced, resolve, reject });
    });
  }

  /**
   * Every subsequent user reply in the planning conversation — clarifying
   * answers, outline confirm, a message during a run. One branch, no phase
   * ladder: each is a live planner turn (ADR-0029), taken at once, or with
   * whatever else arrives during the turn in flight by the next one.
   */
  async continueConversation(userMessage: string, options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    const input: PlanTurnInput = { source: 'user', ...this.resolveSkillInvocation(userMessage), signal: options?.signal };
    const behind = this.behindOpening(input);
    if (behind) return behind;
    if (!this.plan) throw new Error('No planning conversation to continue');
    return this.turns.enqueue(input);
  }

  /**
   * Send now in the planner chat (ADR-0023): stop the planner turn in flight
   * and answer `text` in the turn that replaces it, ahead of anything waiting.
   * Turn-scoped — the run's tasks carry on untouched, and what the stopped
   * turn deferred is settled as for any stop. With no turn in flight it is a
   * plain {@link continueConversation}.
   */
  async forceSendPrompt(text: string, options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    const input: PlanTurnInput = { source: 'user', ...this.resolveSkillInvocation(text), signal: options?.signal };
    // Before the opening opens there is no turn to stop: it goes first behind it.
    if (this.opening?.held) return this.behindOpening(input, true)!;
    if (!this.plan) throw new Error('No planning conversation to continue');
    return this.turns.forceSend(input);
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
   * summarises it, and the summary stands in for everything but the last two
   * exchanges in the planner's context, the transcript keeping every message.
   * Conversation only — the tasks, and any run
   * executing them, are untouched. Atomic: a failed or stopped turn changes
   * nothing.
   */
  async compactConversation(signal?: AbortSignal): Promise<ConversationCompaction> {
    if (!this.plan) throw new ConversationEditError('No planning conversation to condense');
    const opening = this.plannerTurnMayOpen(signal);
    if (opening) await opening;
    const compaction = await this.conversation.compact(signal);
    // The backend's live context is gone: the next prompt replays the
    // condensed context, so the size of the last call before it says
    // nothing of how full that prompt is. It is a reset with no size stated,
    // like a runner's compaction that reports none.
    const usage = this.usage.snapshot();
    if (usage.lastPromptTokens !== undefined) {
      this.usage.record({
        source: usage.source ?? this.config.aiProvider,
        ...(usage.model ? { model: usage.model } : {}),
        compacted: true,
      });
      this.persist();
      this.broadcast(this.usage.message());
    }
    return compaction;
  }

  rewindTargets(): RewindTarget[] {
    return this.conversation.rewindTargets();
  }

  /**
   * A plan the planner submitted through its tool, already checked against
   * the live catalog: committed now, in the turn the call was made in
   * (ADR-0022 P2), and answered with the tasks it holds.
   */
  private async submitPlanFromTool(tasks: Task[], turn: string | undefined): Promise<PlanEditOutcome> {
    if (!this.plan) return { ok: false, errors: [{ field: 'tasks', message: 'No planning turn is open to take the plan.' }] };
    const committed = await this.conversation.commitFromTool({ kind: 'plan', tasks }, turn);
    if (!committed.ok) return committed;
    const { adjustments, warnings } = committed.passed;
    return { ok: true, summary: [], coerced: adjustments, warnings, tasks: this.taskHeads(flattenTasks(this.store.planTasks)) };
  }

  /**
   * A task edit the planner made through its tool, checked against the live
   * catalog and committed now, in the turn the call was made in, as a batch
   * of its own: whole or not at all, against the plan as it stands
   * (ADR-0022 P2). An edit to a running or completed task is refused, with
   * what would be accepted. Answered with the tasks it added and the task
   * each handle it gave names, for a later call to read or start them by.
   */
  private async editPlanFromTool(ops: TaskOp[], turn: string | undefined): Promise<PlanEditOutcome> {
    const refuse = (message: string): PlanEditOutcome => ({ ok: false, errors: [{ message }] });
    await this.liveCatalog();
    if (this.conversation.currentTurnId !== turn) return refuse(PLANNER_TURN_ENDED);
    if (!this.plan || this.store.planTasks.length === 0) return refuse('There is no plan to edit yet: submit one with submit_plan.');
    const committed = await this.conversation.commitFromTool({ kind: 'task_ops', ops }, turn);
    if (!committed.ok) return committed;
    const { summary, adjustments, warnings, handles } = committed.passed;
    const known = new Set(flattenTasks(committed.before).map((t) => t.id));
    const added = flattenTasks(this.store.planTasks).filter((t) => !known.has(t.id));
    const named = [...handles].flatMap(([name, id]) => {
      const task = this.store.get(id);
      return task ? [[name, this.taskHeads([task])[0]] as const] : [];
    });
    return {
      ok: true, summary, coerced: adjustments, warnings, tasks: this.taskHeads(added),
      ...(named.length > 0 ? { handles: Object.fromEntries(named) } : {}),
    };
  }

  /** Tasks as a planner tool's answer names them: by id and by the reference the plan gives each now. */
  private taskHeads(tasks: readonly Task[]): TaskHead[] {
    return tasks.map((t) => ({ id: t.id, ref: taskRefOf(this.store.planTasks, t.id) ?? `#${t.order}`, title: t.title }));
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
      // An envelope's plan is parsed against what submit_plan checks a plan against.
      liveScope: () => this.planChanges.intake(),
      autonomousDefault: this.config.autonomousMode,
      autorun: this.userRunSettings().autorun,
      isolatedExecution: await this.runs.plannerLayout(),
      fs: this.fsAdapter,
      fetcher: this.fetcher,
      approval: this.approvalPolicy,
      notice: (level, message) => this.notice(level, message),
      plannerTools: { sessionId: this.sessionId, handler: this.plannerTools },
      skills: this.workspaceSkills().listSkills(),
    };
  }

  /**
   * Load planner-produced tasks, as the check they landed through resolved
   * them against the catalog read live: it may have changed since planning
   * started. The scheduler adopts them into the run under way, or as the plan
   * the next run starts from (`adoptEdit`).
   *
   * A whole-plan commit is the planner restating every task, so it is laid
   * over the plan's execution state rather than replacing it: a planner that
   * answers "add a task" with the full plan must not undo the work already
   * done. Task ops need no overlay — their applier refuses to touch settled
   * tasks, and `rearm`, the one op meant to change a status, must stand.
   */
  private adoptPlannerTasks(tasks: readonly Task[], how: 'edit' | 'commit'): number {
    this.turnEffects.landed(how);
    // A runner the planner was allowed to use joins the plan as its tasks land (#69).
    for (const runner of runnersOf(tasks)) this.editor.admitRunner(runner, this.catalog.known(runner));
    const runners = this.plan!.runners;
    const before = this.store.planTasks;
    let coerced = [...tasks];
    if (how === 'commit') coerced = keepExecutionState(before, carryPlannedModes(before, coerced, this.catalog.edit(runners)));
    // Tasks an Act supervisor adds are approved to run, ops tasks included (ADR-0029): choosing Act was the consent.
    const bySupervisor = this.supervisorEditing();
    const { tasks: stamped, added } = stampOrigin(before, coerced, bySupervisor);
    coerced = this.preparePlannerTaskUpdates(stamped);
    if (bySupervisor) this.supervision.edited(before, coerced);
    // Consent is to a body (ADR-0035): a script that will run something else
    // than what was approved waits for approval again, read before any rule
    // below approves what this edit wrote.
    const rewritten = rewrittenScripts(before, coerced);
    this.orchestrator.adoptEdit(coerced, runners);
    this.record.withdraw(rewritten);
    // Once they are in the plan: approval is only ever of a task the plan holds.
    if (bySupervisor) this.record.approve(added);
    // With autorun on the user said they need not approve what the planner writes; read as it lands, so turning it off first holds the task.
    this.record.approve(this.commands.autorunApproves(this.turnActor(), writtenTasks(before, coerced)));
    this.adoptResearch(before);
    return coerced.length;
  }

  private adoptResearch(before: readonly Task[]): void {
    const known = new Map(flattenTasks(before).map((t) => [t.id, t]));
    for (const task of this.store.planTasks) {
      if (!task.research || known.get(task.id)?.research) continue;
      const to = researchReportTo(this.turnActor());
      this.store.update(task.id, { reportTo: to, researchOrigin: to });
      this.record.approveResearch(task.id);
      // Queue only as it lands: re-queuing on each turn would undo the user's Stop (ADR-0037 R4).
      this.orchestrator.startAtGate(task.id);
    }
  }

  private preparePlannerTaskUpdates(tasks: Task[]): Task[] {
    return tasks.map((t) => ({
      ...t,
      ...this.orchestrator.releaseMovedResume(t.id, t),
      subtasks: this.preparePlannerTaskUpdates(t.subtasks ?? []),
    }));
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

  /** Merge the run settings this session owns, ignoring a field it does not know from a client's body. */
  private mergeRunSettings(changes: Partial<GlobalRunSettings>): void {
    const next: GlobalRunSettings = { ...this.runSettingsValue };
    for (const key of Object.keys(next) as (keyof GlobalRunSettings)[]) {
      const value = (changes as Partial<Record<keyof GlobalRunSettings, unknown>>)[key];
      if (value !== undefined) (next as Record<keyof GlobalRunSettings, unknown>)[key] = value;
    }
    this.runSettingsValue = next;
  }

  /**
   * The user changed run settings in this session (ADR-0030), which the host
   * has already saved: the run under way takes them at once, in either
   * direction — the wake-up turn under way too, since the seam reads the run's
   * level at each call. Other sessions keep the values they opened with.
   */
  applyRunSettings(changes: Partial<GlobalRunSettings>): void {
    // This session's copy first: with no run yet, it is what the next run starts from.
    this.mergeRunSettings(changes);
    this.supervision.apply(changes);
    // The scheduler reads the setting as it decides; a gate already reached merges now, not at the next event.
    if (changes.mergeAtGatesAutomatically) this.orchestrator.runSettingsChanged();
  }

  private idlePlan(): LegacyPlanState {
    if (!this.plan || !this.store.planTasks.length) throw new NoPlanError('execute');
    if (this.orchestrator.hasLiveWork) throw new AlreadyExecutingError();
    return this.plan;
  }

  private runWholePlan(origin: RunOrigin): Promise<void> {
    // Before the first await: two Executes can arrive while the run is still
    // opening, and the second must join the one under way rather than load the
    // plan over it and spawn its tasks a second time.
    if (this.runOpening) return this.runOpening;
    const plan = this.idlePlan();
    const opening = this.withSave(async () => {
      // Approved first: the scheduler reads the record at each start.
      this.record.approvePlan();
      plan.status = 'approved';
      await this.orchestrator.beginRun(origin);
    });
    this.runOpening = opening;
    return opening.finally(() => {
      if (this.runOpening === opening) this.runOpening = null;
    });
  }

  /**
   * Execute while a run is under way (#95): the seam has approved every task,
   * as executing does, and the run takes them in. A run the scheduler was not
   * driving, one task started on its own, becomes the plan's run, as Execute
   * would make it. The planner's run_plan joins with `approved` 0: the
   * scheduler starts only approved tasks, so `left` tasks still wait.
   */
  private async joinRun(approved: number, left: number): Promise<string> {
    const scheduling = this.orchestrator.isScheduling;
    await this.withSave(async () => {
      this.record.approvePlan();
      await this.orchestrator.joinRun('user');
    });
    const line = approved === 0
      ? left > 0 ? `The plan is ${scheduling ? 'already ' : ''}running; ${left} ${left === 1 ? 'task waits' : 'tasks wait'} for your approval.`
        : scheduling ? 'The plan is already running, and no task waits for your approval.' : 'The plan is running: each task starts once its dependencies finish.'
      : approved === 1 ? 'Approved 1 task; it starts once its dependencies finish.' : `Approved ${approved} tasks; each starts once its dependencies finish.`;
    this.notice('info', line);
    return line;
  }

  private async startOneTask(taskId: string, origin: RunOrigin): Promise<void> {
    if (!this.plan) return;
    this.requireTask(taskId);
    await this.withSave(() => this.orchestrator.forceStartTask(taskId, origin));
  }

  /**
   * A stale id — a task removed since the surface last drew it — is refused.
   * Reloading the plan to find it never could, and reset the verifier under
   * the agents still running, whose verdicts were then lost.
   */
  private requireTask(taskId: string): void {
    if (!this.store.get(taskId)) throw new TaskControlError(`There is no task "${taskId}" in this plan.`);
  }

  /** Start whatever the scheduler can now fit — after the parallel limit was raised mid-run, say. */
  async reschedule(): Promise<void> {
    await this.withSave(() => this.orchestrator.tick());
  }

  private async restartTask(taskId: string, origin: RunOrigin): Promise<void> {
    await this.withSave(() => this.orchestrator.retryTask(taskId, origin));
  }

  private async resumeTask(taskId: string, message: string, origin: RunOrigin): Promise<void> {
    await this.withSave(() => this.orchestrator.continueTask(taskId, message, origin));
  }

  /**
   * The user's Retry compaction of a planner paused on its context (ADR-0002):
   * the paused turn opens again on the inputs it kept. On the live context it
   * condenses what it can, then sends the held input once; with the live
   * context gone — a reload, another provider — a turn that only read starts
   * again from the transcript. One whose calls changed something is refused,
   * the pause kept, since no note could stop an effect running twice. Settles
   * with the plan the turn lands, or paused again on; a Stop ends the pause.
   */
  async retryPlannerCompaction(signal?: AbortSignal): Promise<LegacyPlanState> {
    const pause = this.plan?.plannerContextPause;
    if (!pause) throw new ConversationEditError('The planner is not paused on its context: there is nothing to retry.');
    const retry = this.conversation.retryPlan(pause);
    if ('refused' in retry) throw new ConversationEditError(retry.refused);
    return this.turns.retryCompaction(signal);
  }

  /**
   * Keep what waits on the planner's usage limit from being sent at the reset:
   * it goes with the user's next message instead. False when nothing waits on
   * a reset.
   */
  cancelPlannerResend(): boolean {
    return this.turns.cancelResend();
  }

  /** Keep a task paused on a usage limit from resuming on its own; see {@link TaskOrchestrator.cancelScheduledResume}. */
  private cancelScheduledResume(taskId: string): Promise<boolean> {
    return this.withSave(() => this.orchestrator.cancelScheduledResume(taskId));
  }

  /**
   * The plan follows a model switch the user made in the runner (#106), and
   * the task's log says what the plan holds once that settled: a write-back
   * not made — no model command asked for the change, or the edit failed — is
   * stated, never shown as made. Once the switch's attempt has ended, the plan
   * may be another one, so nothing of it is said.
   */
  private async followRunnerModel({ taskId, sessionId, from, model, effort, asked, attemptEnded }: Parameters<NonNullable<OrchestratorObserver['onModelSwitched']>>[0]): Promise<void> {
    let kept: string | undefined = asked ? undefined : 'no model command in the chat asked for it';
    const live = () => this.orchestrator.activeSessionMap.get(taskId) === sessionId;
    const ended = () => this.taskLogs.note(sessionId, taskId, { type: 'model_switched', from, to: model, kept: kept ?? 'its attempt had already ended' });
    if (attemptEnded) return ended();
    if (asked) {
      try {
        if (!(await this.editor.followRunnerModel(taskId, model, effort, live)) && !live()) return ended();
      } catch (err: unknown) {
        kept = `the plan could not follow it: ${err instanceof Error ? err.message : String(err)}`;
        this.notice('warn', `The plan could not follow the model switch of task ${this.store.get(taskId)?.order ?? taskId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const assigned = this.store.get(taskId)?.assignedModel;
    if (!kept && assigned?.modelId !== model.model) kept = 'the plan did not take the edit';
    this.taskLogs.note(sessionId, taskId, {
      type: 'model_switched', from, to: model,
      plan: {
        ...(assigned ? { model: { model: assigned.modelId, label: assigned.modelLabel } } : {}),
        ...(assigned?.thinkingEffort ? { effort: assigned.thinkingEffort } : {}),
      },
      ...(kept ? { kept } : {}),
    });
  }

  /** Said through both channels: a host shows one or the other, never both (the daemon's toasts are no-ops). */
  private notice(level: SessionNotice['level'], message: string): void {
    this.notifications[level](message);
    this.onNotice?.({ type: 'notice', level, message });
  }

  private approveCheckpoint(taskId: string): void {
    this.saved(() => this.orchestrator.approveCheckpoint(taskId));
  }

  private rejectCheckpoint(taskId: string, reason?: string): void {
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
  private sendTaskMessage(taskId: string, text: string): string {
    return this.saved(() => this.orchestrator.sendTaskMessage(taskId, text));
  }

  /**
   * Force send (ADR-0023, F1): interrupt the task's running turn and deliver
   * this message next. Throws `TaskControlError` where a plain message would.
   */
  private forceSendTaskMessage(taskId: string, text: string): string {
    return this.saved(() => this.orchestrator.forceSendTaskMessage(taskId, text));
  }

  /**
   * The task runner's own command `/name args` (#66), as a turn of its own;
   * not an execution control, so it carries no command at the seam and the
   * daemon hands it straight to the runner. Throws `TaskControlError` where a
   * plain message would.
   */
  invokeTaskCommand(taskId: string, name: string, args = ''): string {
    return this.saved(() => this.orchestrator.invokeTaskCommand(taskId, name, args));
  }

  private forceSendQueuedTaskMessage(taskId: string, id: string): boolean {
    return this.saved(() => this.orchestrator.forceSendQueuedTaskMessage(taskId, id));
  }

  private removeQueuedTaskMessage(taskId: string, id: string): boolean {
    return this.saved(() => this.orchestrator.removeQueuedTaskMessage(taskId, id));
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
    return this.orchestrator.isolationView();
  }

  /**
   * The run as a surface that has folded every message so far would hold it,
   * for one that joins now: the stream reports changes only. What Merge all
   * last did is not kept, so it is not here.
   */
  runSnapshot(): RunView {
    if (!this.plan) return EMPTY_RUN;
    const planned = reduceRun(EMPTY_RUN, { type: 'plan_snapshot', plan: surfacePlan({ ...this.plan, tasks: this.store.snapshot() }) });
    // The status last, as the stream's newest word: it drops what of the handoff git has found merged since it was sent.
    const handed = this.sentHandoff ? reduceRun(planned, { type: 'isolation_handoff', ...this.sentHandoff }) : planned;
    return reduceRun(handed, this.events.statusMessage());
  }

  /** The ancestors a task waits on at its merge gate (ADR-0020); empty when it waits for no Merge all. */
  mergeGate(taskId: string): string[] {
    return this.orchestrator.getMergeGate(taskId);
  }

  /** What reverting the task would do now, for a surface to confirm before `revert_task` (ADR-0054). Reads only. */
  revertPreview(taskId: string): Promise<TaskRevertPreview> {
    return this.orchestrator.revertPreview(taskId);
  }

  /** What Merge all would merge now; null once everything landed is merged. */
  runMergeView(): RunMergeView | null {
    return this.orchestrator.runMergeView();
  }

  /** The run's integration branch against its base ref, as a unified diff. */
  async reviewRunDiff(): Promise<string> {
    return this.runs.reviewDiff();
  }

  /**
   * "Merge all": each repo's integration branch into whatever the user has
   * checked out there — every repo, or none if any cannot take it. The one
   * irreversible step of isolated execution. The user's Merge all and the
   * supervisor's merge_all reach it through the seam; automatic gate merging
   * shares the scheduler's half of it. During a run it merges what has landed
   * so far, which is what opens a merge gate (ADR-0020); it waits for no ops
   * task, and refuses while one runs.
   */
  private async mergeAll(): Promise<IsolationMergeResult> {
    // Ahead of the ops refusal: with no run there is nothing to merge once the ops task ends either.
    this.runs.requireRun();
    const result = await this.withSave(() => this.orchestrator.mergeRun());
    this.broadcast({ type: 'isolation_merge', result });
    this.announceClosed();
    return result;
  }

  /**
   * Say so when the isolated run is gone: a merge that left nothing to hand
   * over clears it up (ADR-0013), and so does a discard. Surfaces fold this
   * instead of reading the merge result, which cannot tell a merge that ended
   * the run from one that only opened a gate (ADR-0020).
   */
  private announceClosed(): void {
    if (!this.closedUnannounced) return;
    this.closedUnannounced = false;
    this.broadcast({ type: 'run_closed' });
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
    this.announceClosed();
  }

  private requireSettledRun(): void {
    this.runs.requireRun();
    if (this.orchestrator.isRunning) throw new PlanEditError('The run is still running: stop it first');
  }

  /** Add the task that merges a conflicted task's branch by hand; see {@link PlanEditor.addConflictResolver}. */
  async resolveConflictAsTask(taskId: string): Promise<LegacyPlanState | null> {
    return this.editor.addConflictResolver(taskId);
  }

  /**
   * The user's Stop (ADR-0029): the run, and every start admitted before it —
   * one queued behind a planner turn's edit, one waiting on its card, one
   * still opening its run. A card still asking is cleared, so its start
   * answers as stopped rather than waiting on a question that no longer stands.
   */
  stopExecution(): void {
    // The opening stopped here may still be awaiting a spawn; an Execute after
    // this Stop starts afresh instead of joining a run that no longer stands.
    this.runOpening = null;
    this.saved(() => this.orchestrator.stop());
    this.approvals.clear((request) => request.kind === 'task_start');
    this.broadcast({ type: 'execution_stopped' });
  }

  /** Something will start without being asked again; see {@link TaskOrchestrator.startsPending}. */
  get startsPending(): boolean { return this.orchestrator.startsPending; }

  /**
   * What the run is doing — starting, running, scheduled, resumable, and
   * whether it advances on its own — for a surface or a guard that must tell a
   * start on its way from real execution.
   * See {@link TaskOrchestrator.activity}.
   */
  get activity(): RunActivity { return this.orchestrator.activity; }

  /**
   * Run a user control and save what it changed before any surface hears of
   * it. Not a status hold, as {@link saved} is: these await spawns and git, so
   * a hold would stall every task's status for as long, and an
   * `execution_complete` the control triggers would overtake the status held
   * back — which a surface treats as the end of the stream. Instead each status
   * announced while one runs is saved first (see {@link observer}).
   */
  private async withSave<T>(op: () => Promise<T>): Promise<T> {
    this.controlsInFlight++;
    try {
      const result = await op();
      this.persist();
      return result;
    } finally {
      this.controlsInFlight--;
    }
  }

  private saveForControl(): void {
    if (this.controlsInFlight > 0) this.persist();
  }

  /** A control that finishes synchronously: its status is held until it is saved. */
  private saved<T>(op: () => T): T {
    const result = this.events.holdStatus(op);
    this.persist();
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
  private mutatePlan(op: () => boolean, notify: () => void = () => this.announcePlan()): LegacyPlanState | null {
    if (!this.plan) return null;
    const changed = this.events.holdStatus(op);
    if (changed) this.persist();
    this.events.releaseStatus(this.plan);
    if (!changed) return null;
    notify();
    // A notify of another kind (a timeline entry) does not carry the plan's approvals.
    if (this.withdrawalUnannounced) this.announcePlan();
    return this.plan;
  }

  /** The plan to every surface, with the approvals it holds now. */
  private announcePlan(turnId?: string): void {
    const withdrew = this.withdrawalUnannounced;
    this.withdrawalUnannounced = false;
    this.events.planGenerated(this.plan, this.goal, turnId);
    // The plan does not carry who waits for approval; the status does.
    if (withdrew) this.events.status(this.plan);
  }

  /**
   * Approval was taken from a task, by a rule that runs wherever the tree
   * changes (ADR-0029). A mutation that is under way announces the plan as it
   * ends, and that broadcast carries this; one that is not, a load or a route
   * that announces nothing of the plan, is followed by one of its own as soon
   * as the synchronous work is done, so no surface keeps showing the task
   * approved.
   */
  private withdrawalOwed(): void {
    if (this.withdrawalUnannounced) return;
    this.withdrawalUnannounced = true;
    queueMicrotask(() => {
      if (this.withdrawalUnannounced && this.plan) this.announcePlan();
    });
  }

  /** Patch one task's fields, checked as the planner's task ops are; see {@link PlanEditor.updateTask}. */
  async updateTask(taskId: string, changes: Partial<Task>, options?: TaskEditOptions): Promise<LegacyPlanState | null> {
    return this.editor.updateTask(taskId, changes, options);
  }

  /** Move one task onto a different runner, re-deriving what is scoped to it; see {@link PlanEditor.setTaskRunner}. */
  async setTaskRunner(taskId: string, runner: RunnerId, options?: TaskEditOptions): Promise<LegacyPlanState | null> {
    return this.editor.setTaskRunner(taskId, runner, options);
  }

  /** Replace one task's dependency list, under the same guard as a field patch; see {@link PlanEditor.setTaskDependencies}. */
  async setTaskDependencies(taskId: string, dependencies: string[], options?: TaskEditOptions): Promise<LegacyPlanState | null> {
    return this.editor.setTaskDependencies(taskId, dependencies, options);
  }

  /** Delete one task, cancelling its runner first if it runs; see {@link PlanEditor.removeTask}. */
  async removeTask(taskId: string): Promise<LegacyPlanState | null> {
    return this.editor.removeTask(taskId);
  }

  /** Add one task, deriving what the caller left unset; see {@link PlanEditor.addTask}. */
  async addTask(draft: Partial<Task>): Promise<LegacyPlanState | null> {
    return this.editor.addTask(draft);
  }

  loadPlan(plan: LegacyPlanState, goal: string, workspace: string, opts?: { sessionId?: string; persist?: boolean }): void {
    // A live planner conversation belongs to the plan it was started for.
    // Adopting a different plan (session load/switch) must drop it — otherwise
    // the next user message continues the OLD session's LLM thread and the
    // planner re-emits that session's plan here. The same-object case (e.g.
    // re-adopting the current plan on approval) keeps the conversation; after
    // a drop, the first user send reseeds it from this plan's own transcript.
    const adopting = plan !== this.plan;
    // Before anything of the plan held now is dropped, so a refusal leaves it
    // as it was: another live host has this session open (ADR-0049).
    if (adopting) this.lease.claim(opts?.sessionId ?? this.currentSessionId, workspace);
    if (adopting) this.dropPlanScope();
    this.plan = plan;
    // A plan adopted off disk carries what supervision remembered: the loop
    // guards' memory and any batch inside its debounce window (ADR-0029). The
    // same-object load keeps the live run's, which is fresher than the save.
    if (adopting) this.supervision.restore(plan.supervision);
    // Loading is not consent to spend tokens: saved inputs wait for a new
    // input, and saved reset times never restart work (ADR-0044).
    if (adopting) this.turns.restoreResend();
    this.goal = goal;
    this.workspace = workspace;
    // A saved session is reopened after closing: it starts from the file, not
    // the copy this window's previous session left behind (ADR-0030).
    if (adopting && opts?.sessionId) {
      this.runSettingsValue = { ...RUN_SETTINGS_DEFAULTS, ...(this.settingsFn().run ?? {}) };
    }
    // Every plan-shape migration lives in one place (models/Task.ts); this load
    // only calls it. A saved pause is reset before the orchestrator clones the
    // tasks, so its copy is idle too.
    migrateLoadedPlan(plan, { adopting });
    // The saved ledger is the session's own history: adopt it before the
    // persist below writes the plan back, so a load does not zero the totals.
    // The same-object load keeps the live ledger, which holds what the turn in
    // flight spent and the save does not yet.
    if (adopting) {
      this.usage.restore(plan.plannerUsage);
      this.windows.restore(plan.contextWindows);
    }
    // Adopting the saved session's id keeps subsequent persists writing to the
    // same file instead of forking the session under a fresh identity.
    if (opts?.sessionId) this.currentSessionId = opts.sessionId;
    // A plan saved before a task kept its attempted mark is read against the
    // attempt logs it left, so upgrading keeps the chats it already had. A
    // manual task's handoff log is not an attempt, and stays no chat.
    if (adopting) this.creditLoggedAttempts(plan.tasks);
    this.orchestrator.loadPlan(plan.tasks, plan.runners);
    // Loading normalizes statuses (a stored `blocked` goes) on the store's
    // copy; the adopted plan shows that result, not the caller's input.
    this.syncPlanTasks();
    // The run record is taken synchronously; the orphan prune and the look at
    // what the user has merged since are awaited in the background, and git
    // serializes them ahead of any worktree a run adds.
    if (adopting) {
      void this.adoptRun(plan, opts?.persist !== false || opts?.sessionId !== undefined);
      // What the surfaces were last sent is not saved; a settled run is handed
      // over again as its resend would, until git says what of it is merged.
      this.sentHandoff = this.owedHandoff();
      // Last, once the run is taken over: what waits now was there before this load (ADR-0053).
      this.escalationNotifier.baseline(this.escalations());
    }
    if (opts?.persist !== false) this.persist();
    // A reopened session shows its token line again without waiting for the
    // next turn: announce the totals the moment the plan is adopted.
    if (this.usage.hasUsage) this.broadcast(this.usage.message());
  }

  /**
   * Take the loaded plan's run over, then correct what the surfaces were told
   * by what git found: the saved record cannot know what the user merged
   * since, and its handoff would offer Merge all for work already in their
   * branch. The status update says what landed work is still unmerged, which
   * a handoff folds to (see `reduceRun`), and `run_closed` that the run was
   * cleared up. Saved only where the load itself may save (`persists`), so a
   * restore with no session file to write keeps the correction in memory for
   * its next save. A plan loaded meanwhile is not this one's to correct.
   * Starts nothing (ADR-0044).
   */
  private async adoptRun(plan: LegacyPlanState, persists: boolean): Promise<void> {
    const outcome = await this.runs.adopt(plan.isolation ?? null, plan.mergedRun);
    if (this.closed || this.plan !== plan || outcome === 'unchanged') return;
    plan.isolation = this.runs.planIsolation ?? undefined;
    plan.mergedRun = this.runs.mergedRun ?? undefined;
    if (persists) this.persist();
    this.events.status(plan);
    if (outcome === 'cleared') this.broadcast({ type: 'run_closed' });
  }

  destroy(): void {
    // Planning research runs on a separate conduit from task execution — a
    // live spawn_research_agent/bash tool call would otherwise keep running
    // server-side after the client has already moved on to a new session.
    this.closed = true;
    this.dropPlanScope();
    this.unlistenApprovals?.();
    this.unlistenApprovals = null;
    // Deny any still-pending approval prompts so their timers and awaited
    // continuations settle before the Session goes away.
    this.approvals.clear();
    this.unsubObserver?.();
    this.unsubObserver = null;
    this.fsAdapter.endSession?.();
    // Last: stopping the run above saves what it changed, which needs the lease.
    this.lease.release();
    this.leaseReleased = true;
  }

  /**
   * The planner's settings or credentials changed: its backend is let go and
   * built afresh from them, once no planner turn is running on it (see
   * {@link PlannerBackend}).
   */
  plannerSettingsChanged(): void {
    this.backend.settingsChanged();
  }
}

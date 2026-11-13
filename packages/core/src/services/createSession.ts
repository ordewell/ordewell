import * as path from 'path';
import { resolveHandoffReferences } from './handoffReferences';
import { readSavedPatch } from './taskDiffRead';
import { savedPatchOf } from '../models/Handoff';
import { createAiService, type IAiService } from './AiService';
import type { PlannerContextDeps } from './plannerContextBudget';
import { PlannerBackend } from './PlannerBackend';
import type { TaskOp } from './TaskOps';
import { PlanChangeCheck, type PlanChangeScope } from './PlanChangeCheck';
import { ApprovalRecord } from './ApprovalRecord';
import type { TaskQueryCatalog } from './TaskQuery';
import { SessionCatalog } from './SessionCatalog';
import { plannerToolHandler, runnersOf, NODE_REPORTED, PLANNER_TURN_ENDED, type PlanEditOutcome, type TaskHead } from './plannerTools';
import { sharedMcpServer, type OrdewellMcpServer, type PlannerToolHandler } from './mcp';
import { ConversationEditError, PlannerContextPausedError, PlannerConversation, PlannerTurnDiscardedError, PlannerTurnStoppedError, PlannerUsageLimitError, type ConversationCompaction, type ConversationOpening, type PlannerConversationHost, type RewindTarget, type WakeUpTurn } from './PlannerConversation';
import { forkPlanState, type ForkedDialogue } from './conversationFork';
import { PlanTurns, type PlanTurnInput } from './PlanTurns';
import { TurnGate } from './TurnGate';
import { RunSupervision, runOrigin } from './RunSupervision';
import { Planner } from './Planner';
import { TaskControlError, TaskOrchestrator, type OrchestratorObserver, type RunOrigin, type TaskOrchestratorOptions } from './TaskOrchestrator';
import { ChildDirectory } from './ChildDirectory';
import { ChildPlanRunner, type ChildHost, type ChildNode, type SubplannerLink } from './ChildPlanRunner';
import { ScopeLines } from './ScopeLines';
import { DELEGATION_OFFERED, rememberDelegationBudget } from './runSettingsText';
import { SURFACE_CONTROLS, surfaceOf, surfaceSettingsBlock, type SurfaceSettings } from './surfaceControls';
import { checksDelegatedTask, type DelegatedRow } from '../models/Delegation';
import type { SlotPool } from './SlotPool';
import type { OpenLease } from './executionLease';
import { PlanStore } from './PlanStore';
import { ApprovalPolicy, effectiveApprovalMode } from './ApprovalPolicy';
import { DEFAULT_PLANNER_ALLOWLIST } from './plannerAllowlist';
import { effectRuleFor, parseEffectAllowlist, type EffectRules } from './effectAllowlist';
import { type Mandate, type MandateRequest, type NodeAuthority, type RootSettings } from './Mandate';
import type { Carved, NodeBudget, TreeLedger } from './TreeLedger';
import type { NodeFunding } from './NodeFunding';
import type { NodeSeat } from './NodeSeat';
import type { NodeReading } from './NodeReading';
import { childSessionDeps, nodePosition, type ChildSpec, type NodeHost, type NodePosition } from './NodePosition';
import type { EventStore } from './eventStore';
import { jsonlEventStore, treeEventLogFile } from '../utils/treeEventLog';
import { ensureStateDirIgnored } from '../utils/fsHelpers';
import { PendingApprovals, type PendingApproval } from './PendingApprovals';
import { RunnerApprovals } from './RunnerApprovals';
import { approvalScopes, isRunnerApproval, type ApprovalAnswer, type ApprovalRequest } from '../interfaces/IApproval';
import { HttpWebFetcher, type WebTransport } from './HttpWebFetcher';
import type { ResolveAll } from './egressGuard';
import type { ISearchProvider } from '../interfaces/ISearchProvider';
import { WebReadPolicy } from './webReadPolicy';
import { PlannerReadLimit, plannerReadLimitOf } from './plannerReadLimit';
import { sharedWebResponseCache, type WebResponseCache } from './WebResponseCache';
import { sharedSearchProvider } from './DuckDuckGoSearchProvider';
import { PROVIDER_PRIORITY, runnerForProvider } from './ProviderRegistry';
import { VENDORS } from './apiProviders';
import type { HeldValue } from '../utils/redactSecrets';
import { ModelResolver } from './ModelResolver';
import { plannerModesFrom } from './plannerModes';
import { RUN_SETTINGS_DEFAULTS, runSettingsOf, type GlobalRunSettings, type UserSettings } from './SettingsService';
import { SkillsService } from './SkillsService';
import { resolveSkillInvocation, type SkillInvocation } from './skillInvocation';
import { plannedSkillLookup, type SkillCatalogLookup } from './taskSkills';
import { surfacePlan, type RunActivity, type RunMergeView, type RunView, type SessionBroadcaster, type SessionMessage, type SessionNotice } from './SessionMessage';
import { EMPTY_RUN, reduceRun } from './runView';
import { SessionEventRelay } from './SessionEventRelay';
import { SessionSaves } from './SessionSaves';
import { SubagentRuns } from './SubagentRuns';
import { listTaskLogAttempts, prepareTaskOutputFile, readTaskLog, readTaskPatch, saveTaskPatch, type TaskLogFile, type TaskLogLocation } from '../utils/taskLogStore';
import { digestTaskLog, type TaskLogEvent } from '../models/TaskLog';
import { TaskLogRecorder } from './TaskLogRecorder';
import { ScriptRunner, type ScriptRunnerDeps } from './ScriptRunner';
import { rewrittenScripts } from '../models/ScriptTask';
import { taskRefOf } from './TaskRefs';
import { SessionWindows, withContextWindows } from './ContextWindowFill';
import { withTaskRunnerConfig } from './taskRunnerConfig';
import { containerExecution } from './container/dockerLease';
import type { TaskRunnerConfig } from './harness/AgentAdapter';
import { PlannerUsageLedger } from './PlannerUsage';
import { plannerContextFill } from '../models/Usage';
import { TurnBudgets, contextLine, taskReadsLine, webReadsLine } from './PlannerBudgets';
import { mintSessionId } from '../utils/sessionId';
import { savePrdMarkdown, extractPrdBlock } from '../utils/prdStore';
import { takeUserActions } from '../utils/userActionLog';
import { approvalRecordOf, flattenTasks, migrateLoadedPlan, stampOrigin, type LegacyPlanState, type PlanState, type Task, type TaskReportTo, type TaskSnapshot, type RunnerId } from '../models/Task';
import { AlreadyExecutingError, NoPlanError } from './SessionErrors';
import { describeHeld, describeLost, SessionHeldError, type LeaseHost, type SessionHeld, type SessionLease } from './sessionLease';
import { PlannerNotReadyError, plannerNotReadyFor } from './plannerReadiness';
import { recordedRunnerAuth } from './runnerAuth';
import { installedPlannerAnswered, installedPlannerDetected } from './InstalledPlanner';
import type { IConfig, PlannerBackendId } from '../interfaces/IConfig';
import type { BashOptions, IFileSystem, ToolOutcome } from '../interfaces/IFileSystem';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { INotification } from '../interfaces/INotification';
import type { IRunner } from '../interfaces/IRunner';
import type { TaskOutputSource } from '../interfaces/TaskOutputSource';
import type { IsolationHandoff, IsolationMergeResult, IsolationView, IWorktreeIsolation } from '../interfaces/IWorktreeIsolation';
import type { IsolationRunController } from './IsolationRunController';
import { PlanEditor, type TaskEditOptions } from './PlanEditor';
import { cardEditPatch, type CardEdit } from './CardEdit';
import { cardEditNeedsUnstarted, runHoldsEditors } from '../taskRow';
import type { PlannerDelegation, SubplannerBrief } from './PlanPrompts';
import { PlanEditError } from './PlanEditError';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import { ExecutionCommands, mergeStopped, type CommandOutcome, type ExecutionCommand, type ExecutionHost } from './ExecutionCommands';
import { escalations, type Escalation } from './escalations';
import { EscalationNotifier, runNotifyCommand, type NotifyRun } from './escalationNotifier';
import type { TaskRevertPreview } from './taskRevert';
import { REPORT_TAIL_LINES, reportEnded } from './taskReport';
import { ResearchTasks, researchReportTo } from './ResearchTasks';
import { actorAuthority, type ExecutionActor, type ExecutionRecord } from '../models/Execution';
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
  /** The settings file's `plannerReadLimit`, as written; `plannerReadLimitOf` reads it with its variable. */
  plannerReadLimit?: UserSettings['plannerReadLimit'];
  /** What a task runner loads of the user's own setup; absent means all of it. */
  taskRunnerConfig?: TaskRunnerConfig;
  /** The `containers` setting, as written; absent means local worktrees (ADR-0059 L4). */
  containers?: unknown;
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
    ...(settings.plannerReadLimit !== undefined ? { plannerReadLimit: settings.plannerReadLimit } : {}),
    ...(settings.taskRunnerConfig !== undefined ? { taskRunnerConfig: settings.taskRunnerConfig } : {}),
    ...(settings.containers !== undefined ? { containers: settings.containers } : {}),
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

/** Writes one plan to the saved-session store: {@link saveSession}'s shape, injected so tests never touch disk. `workspace` is the state root. */
export type SaveSession = (plan: LegacyPlanState, goal: string, workspace: string, sessionId: string) => void;

/**
 * Where a child session sits in its tree, handed out by the parent's
 * {@link Session.hostChild}. Its code root is its `workspaceRoot`, a delegated
 * task's worktree, which goes with that task; what must outlive that goes here.
 */
export interface ChildPlacement {
  /** The id it saves under, which the parent's run record names. */
  sessionId: string;
  /** The root Session's workspace, at every depth (ADR-0055 D11). */
  stateRoot: string;
  /** The root Session's id: a child's state sits under that session's. */
  rootSessionId: string;
  /** Who holds the tree, as the root's lease says (D13). */
  held: () => SessionHeld | null;
  /** Its parent's, so one repository's worktree bookkeeping takes one lock across the tree (D11). */
  isolation: IWorktreeIsolation;
  /** The root's, so the tree shares one Parallel limit (D18). */
  pool: SlotPool;
  /** The root's, which a surface finds this child through (D20). */
  directory: ChildDirectory;
  /** Its side of the tree's ledger, once a carve gave it one (ADR-0056 M5). */
  budget?: NodeBudget;
}

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
  /** Where its sessions run (ADR-0059), given the local worktrees: those, unless a test supplies another. */
  execution?: TaskOrchestratorOptions['execution'];
  /** The node this session is, below the root (ADR-0056); absent, it is the root, whose mandate its settings hold. */
  child?: NodeAuthority;
  /** Where this session sits below the root (ADR-0055 D11, D13); absent, its workspace is both its code root and its state root. */
  placement?: ChildPlacement;
  /** Where a root's tree keeps its log (ADR-0058 S3): a file in that root's directory, unless a test supplies another. */
  eventLog?: (rootSessionId: string, stateRoot: string) => EventStore;
  /** How this session answers to its parent's attempt, as a subplanner (ADR-0055 D5); absent at the root. */
  subplanner?: SubplannerLink;
  /** What this child was given to do, for its prompt; read only with a `placement`, as `subplanner` is. */
  brief?: SubplannerBrief;
  /** Whether a planner may write a delegated task here; the build's own switch (ADR-0055 D21) unless a test sets it. */
  delegationOffered?: boolean;
  /** What a test puts in a child's deps, in place of what a real child is built with. */
  childDeps?: (task: Task) => Partial<SessionDeps>;
}

/** Withdrawn by either: the caller's own signal, or the end of the planner turn that raised it. */
function withTurnEnd(signal: AbortSignal | undefined, turnEnded: AbortSignal | undefined): AbortSignal | undefined {
  if (!signal || !turnEnded) return signal ?? turnEnded;
  return AbortSignal.any([signal, turnEnded]);
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
  // Chosen once, here: below it the Session never asks its depth for what this answers (ADR-0055 D11-D13).
  const position = nodePosition({ ...deps, eventLog: deps.eventLog ?? treeLog });
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
    () => readLimit.line(),
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
    : { provider: () => deps.config.aiProvider, create: () => createAiService(deps.config, { workspaceRoot: deps.workspaceRoot, mcpServer, turnBudgets, openLease: (signal: AbortSignal): Promise<OpenLease> | undefined => session.openTurnLease(signal), ...plannerContext }), busy });
  const aiService = () => backend.current();
  const store = new PlanStore();
  // A window a runner or provider reports wins, and every later stream of the
  // session knows it; the catalogs the resolver already holds serve the rest.
  const windows = new SessionWindows((source, model) => deps.modelResolver.contextWindowFor?.(source, model));
  // A caller that swaps the log's store keeps the disk untouched, so no output file is made either.
  const scriptRunnerDeps: ScriptRunnerDeps = deps.openTaskLog
    ? {}
    : { fullOutputFile: (taskId, attempt) => prepareTaskOutputFile(session.taskLogLocation, taskId, attempt) };
  const childHost: ChildHost = {
    openChild: (...open) => session.openChild(...open),
    changedPaths: (taskId, names) => session.changedPaths(taskId, names),
    stopped: () => session.underStop || session.reported,
    passUp: (record) => position.passUsageUp(record),
    moved: () => events.rowsMoved(session.planState),
  };
  const childPlans = new ChildPlanRunner(childHost);
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
        if (!position.mayAskAPerson) {
          approvals.resolve(id, { decision: 'deny', note: 'A person cannot be asked here: do it another way, or report that it needs one.' });
          return;
        }
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
  const containers = position.containers(deps.settings);
  const execution = deps.execution ?? (containers === undefined ? undefined : containerExecution(containers));
  const orchestrator = TaskOrchestrator.compose({
    config: deps.config,
    notifications: deps.notifications,
    runner: taskLogs.wrap(runnerApprovals.wrap(withContextWindows(withTaskRunnerConfig(deps.runner, () => deps.settings().taskRunnerConfig), windows))),
    scriptRunner: taskLogs.wrap(deps.scriptRunner ?? new ScriptRunner(scriptRunnerDeps)),
    childPlanRunner: taskLogs.wrap(childPlans),
    store,
    output: deps.taskOutput,
    isolation: deps.isolation ?? position.isolation,
    registry: deps.registry,
    workspaceRoot: deps.workspaceRoot,
    ...position.run(),
    ...(execution ? { execution } : {}),
    startRefused: (why) => session.startRefused(why),
    autonomous: () => position.autonomous(deps.config.autonomousMode),
    inheritedProtectedPaths: () => position.inheritedProtectedPaths(),
    unsealedRefusal: (task) => position.unsealedRefusal(task),
    discardChild: (task) => session.discardChild(task),
    subtree: () => session.reading.subtree(),
    board: () => session.reading.board(),
    landed: (task) => session.reading.landed(task),
    sessionId: () => session.sessionId,
    treeId: () => session.rootSessionId,
    openTurn: () => session.turnRoomFreed(),
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
    mayMergeUnasked: () => position.mayMergeUnasked(),
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
    ...(position.budget ? { spent: position.budget.turnSpent } : {}),
    awaitingApproval: (taskId) => runnerApprovals.waiting(taskId),
    checkpointQuestion: (taskId) => orchestrator.getCheckpointQuestion(taskId),
    waitsForApproval: (taskId): boolean => session.waitsForApproval(taskId),
    delegation: (taskId) => session.delegatedRow(taskId),
    escalations: (): Escalation[] => session.escalations(),
    escalationsSent: (list) => escalationNotifier.changed(list),
  });

  const approvalPolicy = new ApprovalPolicy({
    autonomous: () => deps.config.autonomousMode,
    // Read per request, so a change of autonomy level or allowlist applies to the next call.
    mode: (kind) => effectiveApprovalMode(deps.config.approvalMode, deps.config.autonomousMode, kind),
    preApproved: () => plannerAllowlistOf(deps.config),
    // A planner request raised during a turn is that turn's: once the turn is
    // over nothing waits on the answer, and a card left open would swallow
    // the user's next message, so it is withdrawn however the turn ends.
    ask: (req, signal) => approvals.ask(req, { signal: withTurnEnd(signal, conversation?.liveTurnEnded) }),
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
  // Read per call, so a settings change or the variable applies from the next read.
  const readLimit = new PlannerReadLimit({
    limit: () => plannerReadLimitOf(deps.settings().plannerReadLimit, process.env.ORDEWELL_PLANNER_READ_LIMIT),
    turn: () => conversation?.currentTurnId,
  });
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
    autonomous: () => position.autonomous(deps.config.autonomousMode),
    held: () => position.heldLimits(),
    registry: deps.registry,
    modelResolver: deps.modelResolver,
    settings: deps.settings,
    // Read through the Session, which holds the plan; the catalog is built first.
    planRunners: (): RunnerId[] => session.planState?.runners ?? [],
    liveRunner: (taskId) => orchestrator.getAttempt(taskId) !== undefined,
  });

  const session: Session = new Session({
    config: deps.config,
    catalog,
    workspace: deps.workspaceRoot(),
    fsAdapter: deps.fsAdapter,
    broadcast: deps.broadcast,
    notifications: deps.notifications,
    onNotice: deps.onNotice,
    modelResolver: deps.modelResolver,
    settings: deps.settings,
    hostSessionId: position.sessionId(deps.sessionId),
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
    readLimit,
    skillsService: deps.skillsService ?? new SkillsService(deps.workspaceRoot()),
    position,
    conversation: (host) => (conversation = new PlannerConversation(host, {
      heldSecrets: () => [...namedConfigSecrets(deps.config), ...outboundSecrets().map((value) => ({ value }))],
    })),
    runnerConfig: () => deps.settings().taskRunnerConfig,
    delegationOffered: deps.delegationOffered ?? DELEGATION_OFFERED,
    childPlans,
    childSession: (spec) => createSession(childSessionDeps(execution ? { ...deps, execution } : deps, spec)),
  });
  return session;
}

/** A root's tree log: a file in its state directory (ADR-0058 S3). */
function treeLog(rootSessionId: string, stateRoot: string): EventStore {
  ensureStateDirIgnored(stateRoot);
  return jsonlEventStore(treeEventLogFile(rootSessionId, stateRoot));
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

/** The vendor keys the config holds, by the variable each is handed over as: what a summary names in a key's place. */
function namedConfigSecrets(config: IConfig): HeldValue[] {
  return PROVIDER_PRIORITY.map((provider) => ({ name: VENDORS[provider].apiKeyEnvVar, value: config.getProviderApiKey(provider) }));
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
  /** The planner's own reads per turn (ADR-0068): handed to its backend, and charged here for `run_command`. */
  readLimit: PlannerReadLimit;
  skillsService: Pick<SkillsService, 'findSkill' | 'listSkills' | 'searchedDirs' | 'forRoot'>;
  /** Its place in its tree, which it binds once its own state exists: what it saves and leases through, and everything a node is at its depth. */
  position: NodePosition;
  /** The conversation's host is the Session itself, so only the Session can make it. */
  conversation: (host: PlannerConversationHost) => PlannerConversation;
  runnerConfig: () => TaskRunnerConfig | undefined;
  delegationOffered: boolean;
  childPlans: Pick<ChildPlanRunner, 'stopEvery' | 'activeCount' | 'progressOf'>;
  childSession: (spec: ChildSpec) => Session;
}

/**
 * The per-session execution stack — the lifecycle owner. Owns plan
 * generation, execution, mutation and persistence; built by
 * {@link createSession}, which wires its collaborators. The orchestrator's
 * observer is subscribed once for the session's lifetime (not per-operation),
 * which kills the double-subscribe class of bug. Persistence is an internal
 * seam: every save routes through {@link SessionSaves}.
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
  /** The code root: what its planner and runners read and git works in. See {@link stateRoot} for Ordewell's own files. */
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
  private readonly readLimit: PlannerReadLimit;
  private readonly settingsFn: () => SessionRuntimeSettings;
  /**
   * This session's copy of the user's run settings (ADR-0030), seeded when it
   * opens. Another session's change writes the file but does not move this one.
   */
  private runSettingsValue: GlobalRunSettings;
  private readonly save: SaveSession;
  /** One live host per session (ADR-0049): no save, and no run, without it. */
  private readonly lease: SessionLease;
  private readonly saves: SessionSaves;
  /** A whole-plan start opening; a second Execute joins it rather than resetting the run under it. */
  private runOpening: Promise<void> | null = null;
  private unsubObserver: (() => void) | null;
  /** What this node may do, as its position holds it: given from above, or the root's settings (ADR-0056 M1). */
  private readonly authority: NodeAuthority;
  private readonly runnerConfig: () => TaskRunnerConfig | undefined;
  private readonly delegationOffered: boolean;
  private readonly childPlans: SessionParts['childPlans'];
  private readonly childSession: SessionParts['childSession'];
  /** Where this node sits in its tree, chosen once by {@link createSession}: its funding, seat and reading are held there. */
  private readonly position: NodePosition;
  /** The lines this plan's landings owe its running tasks (ADR-0057 R6). */
  private readonly scopeLines = new ScopeLines({
    running: () => this.store.planTasks.filter((task) => task.type === 'delegated' && task.scope && (task.status === 'in_progress' || task.status === 'awaiting_user')),
    changedPaths: (taskId) => this.changedPaths(taskId),
    send: (taskId, line) => this.orchestrator.addressTask(taskId, line),
  });
  private readonly hostSessionId?: string;
  private currentSessionId: string;
  private readonly skillsService: Pick<SkillsService, 'findSkill' | 'listSkills' | 'searchedDirs' | 'forRoot'>;
  private readonly conversation: PlannerConversation;
  private readonly turns: PlanTurns;
  /** Planner-turn admission: the probe's wait, a child's wait for a slot, and the turn's lease. */
  private readonly gate: TurnGate;
  /** Destroyed: a turn that waited for the planner to be found must not open on it. */
  private closed = false;
  /** Destroyed and let go of its lease for good: whatever settles later neither saves nor holds the session. */
  private leaseReleased = false;
  /** Settles once a destroyed Session's lease has gone. */
  private departed: Promise<void> = Promise.resolve();
  /** The conversation's opening, from admission until its turn settles; see {@link behindOpening}. */
  private opening: PendingOpening | null = null;
  private readonly editor: PlanEditor;
  private readonly commands: ExecutionCommands;
  private readonly supervision: RunSupervision;
  /** The open planner turn's, or the last one's once it settled; see {@link openTurn}. */
  private turnEffects = new TurnEffects();
  private unlistenApprovals: (() => void) | null;
  /** The one check of a planner's change to the plan; an Act supervisor's edits meet its guard. */
  private readonly planChanges = new PlanChangeCheck({ ...this.changeScope(() => this.supervisorEditing()), child: () => this.position.heldAuthority() });
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
    unread: () => this.position.answersToParent,
    editPlan: (ops, turn) => this.editPlanFromTool(ops, turn),
    record: (entries, turn) => this.conversation.recordFromTool(entries, turn),
    tasks: () => this.store.planTasks,
    read: (signature, answer) => this.conversation.read(signature, answer),
    liveOutput: (taskId, opts) => this.orchestrator.getLiveOutput(taskId, opts),
    lastAttempt: (taskId) => lastAttemptDigest(this.taskLogLocation, taskId),
    taskLogAttempts: (taskId) => this.taskLogAttempts(taskId),
    taskLog: (taskId, attempt) => this.taskLog(taskId, attempt),
    readHandoff: (args) => this.reading.read(args),
    below: () => this.reading.subtree(),
    post: (args) => this.reading.post(args),
    taskDiff: (taskId, options) => {
      // A read-only task lands nothing and its worktree is gone: the patch it saved is what it changed (ADR-0050).
      const patch = savedPatchOf(this.store.get(taskId)?.handoff);
      if (patch) return Promise.resolve(readSavedPatch(readTaskPatch(this.taskLogLocation, taskId, patch.attempt), patch, options));
      return this.runs.taskDiff(taskId, options);
    },
    runCommand: (command, signal, opts) => this.ownCommand(command, signal, opts),
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
    this.authority = parts.position.authority(() => this.rootSettings());
    this.runnerConfig = parts.runnerConfig;
    this.delegationOffered = parts.delegationOffered;
    this.childPlans = parts.childPlans;
    this.childSession = parts.childSession;
    this.position = parts.position;
    this.position.bind(this.nodeHost());
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
    this.readLimit = parts.readLimit;
    this.skillsService = parts.skillsService;
    this.save = parts.position.save;
    this.lease = parts.position.lease((held) => this.leaseLost(held), () => this.runIsLive);
    this.saves = new SessionSaves({
      plan: () => (this.leaseReleased ? null : this.plan),
      write: (plan) => this.write(plan),
      heldElsewhere: () => this.heldElsewhere(),
      store: this.store,
      status: this.events,
      notice: (message) => this.notice('error', message),
    });

    this.conversation = parts.conversation({
      plan: () => this.plan,
      goal: () => this.goal,
      aiService: () => this.backend.current(),
      onProgress: (p) => this.events.progress(p),
      opening: (runners) => this.conversationOpening(runners),
      catalog: () => this.catalog.current(),
      subplanner: () => this.position.answersToParent,
      assignmentScope: () => this.catalog.scope(),
      autorun: () => this.userRunSettings().autorun,
      surfaceFacts: () => {
        const facts = this.surfaceSettings();
        return facts ? surfaceSettingsBlock(facts) : null;
      },
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
      // soon as it is over. A Retry compaction alone arrives here with no
      // slot: run past the refusal, it would be one more than the tree's limit.
      turnClaiming: () => {
        this.backend.settle();
        const refused = this.gate.claim();
        if (refused) throw new Error(refused);
      },
      // After the turn has announced its end, so the next one never starts
      // ahead of it on a surface.
      turnReleased: () => {
        this.gate.released();
        this.backend.settle();
        queueMicrotask(() => this.turns.pump());
        this.position.changed();
      },
      turnDropped: () => {
        this.gate.released();
        this.position.changed();
      },
      usageLimit: (said, answered) => {
        const limit = this.turns.usageLimit(said, answered);
        const runner = runnerForProvider(this.config.aiProvider);
        if (this.position.turnsTakeTreeSlots && limit.resendAt && runner) this.orchestrator.plannerLimited(runner, limit.resendAt);
        return limit;
      },
      contextPaused: (details) => this.turns.contextPaused(details),
    });

    this.gate = new TurnGate({
      reserve: () => this.orchestrator.reserveTurn(),
      placed: () => this.position.turnsTakeTreeSlots,
      plannerAnswered: installedPlannerAnswered,
      plannerDetected: installedPlannerDetected,
      detecting: (waiting) => this.broadcast({ type: 'planner_detection', waiting }),
      assertReady: () => this.assertPlannerReady(),
      queuedTurnRunning: () => this.turns.turnRunning,
      conversationBusy: () => this.conversation.isTurnInFlight,
      parked: () => {
        if (this.position.turnsTakeTreeSlots) this.backend.current().restart?.();
        this.funds.parked();
      },
      pump: () => this.turns.pump(),
    });

    this.turns = new PlanTurns({
      turnStarting: () => {
        this.saves.after();
      },
      plan: () => (this.closed ? null : this.plan),
      conversationBusy: () => this.conversation.isTurnInFlight,
      mayWake: () => this.supervision.mayWake(),
      mayReport: () => this.supervision.mayReport(),
      stoppedByUser: (tasks) => this.supervision.stoppedByUser(tasks),
      persist: () => this.saves.after(),
      announce: () => {
        this.saves.after();
        this.announcePlan();
      },
      interrupt: () => { this.conversation.stopTurn('force_send'); },
      holdStarts: () => this.orchestrator.holdStarts(),
      turnRoom: () => this.gate.claim() === null,
      turnSettled: () => this.gate.settled(),
      // A start queued behind its dependencies waited for the turn too, with or without a run.
      resumeStarts: async () => {
        if (this.orchestrator.isRunning || this.orchestrator.startsPending) await this.saves.control(() => this.orchestrator.tick());
      },
      run: async (prompt, { taken, signal }) => {
        const reply = (turnSignal: AbortSignal | undefined, wakeUp?: WakeUpTurn) => this.conversation.reply(prompt, {
          signal: turnSignal, onCommit: taken, wakeUps: prompt.wakeUps, asides: prompt.asides, forced: prompt.forced, ...(wakeUp ? { wakeUp } : {}), ...(prompt.recovery ? { recovery: prompt.recovery } : {}),
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
      plannerDetecting: () => this.gate.probe(),
      assertPlannerReady: () => this.assertTurnMayRun(),
      plannerRunner: () => runnerForProvider(this.config.aiProvider),
    });

    this.supervision = new RunSupervision({
      plan: () => this.plan,
      subplanner: () => this.position.answersToParent,
      userSettings: () => this.userRunSettings(),
      tasks: () => this.store.planTasks,
      startWaits: () => this.orchestrator.planStartWaits(),
      plannerCache: () => ({ ttlMs: this.backend.current().promptCacheTtlMs?.(), requestAt: this.conversation.lastRequestAt }),
      checkpointQuestion: (taskId) => this.orchestrator.getCheckpointQuestion(taskId) ?? undefined,
      landedWork: () => (this.runMergeView() ? 'pending' : this.runs.mergedRun ? 'merged' : null),
      mergeTarget: () => this.position.mergeTarget(),
      landingError: (taskId) => this.runs.current?.tasks[taskId]?.landingError,
      recentOutput: (taskId) => this.orchestrator.getLiveOutput(taskId, { maxLines: 3 })?.text.trim(),
      reportTail: (taskId) => this.reportTail(taskId),
      reported: (taskId, to) => {
        this.store.update(taskId, { reportTo: undefined });
        if (!to.research) this.commands.scriptEnded(taskId, to);
      },
      systemNote: (text) => this.systemNote(text),
      supervisorNote: (text) => this.supervisorNote(text),
      changed: () => this.mutatePlan(() => true),
      save: () => this.saves.after(),
      resendHandoff: () => {
        const handoff = this.owedHandoff();
        if (handoff) this.broadcast({ type: 'isolation_handoff', ...handoff });
      },
      // Async so a failed save rejects, as a turn's failure does: the input already waits on the plan, and a Stop that took must not throw.
      deliver: async (digest, report, idle, tasks) => this.turns.enqueue({ source: 'supervisor', text: digest, ...(report ? { report } : {}), ...(idle ? { idle } : {}), ...(tasks ? { tasks } : {}) }),
      pump: () => this.turns.pump(),
      restartPlanner: () => this.backend.current().restart?.(),
      abandonTurn: () => this.conversation.abandonHungTurn(),
      notice: (level, message) => this.notice(level, message),
    });
    this.unlistenApprovals = this.approvals.listen(({ request }) => {
      if (isRunnerApproval(request) && request.taskId) {
        // Denied by the time this hears of it, below the root (ADR-0056 M8).
        this.supervision.observe({ kind: this.position.mayAskAPerson ? 'waiting_approval' : 'approval_denied', taskId: request.taskId, detail: request.subject });
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
      authority: this.authority,
      // Read per request, like the planner allowlist, so an edited rule applies to the next script (ADR-0035).
      effects: (body) => {
        const rules = this.effectRules();
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
    return this.orchestrator.judgingOnce(() => this.judgedEscalations());
  }

  private judgedEscalations(): Escalation[] {
    if (!this.plan) return [];
    const { scheduled, resumable, advancesOnItsOwn } = this.orchestrator.activity;
    const carried = this.orchestrator.carriedTasks();
    return escalations({
      tasks: this.store.planTasks,
      waits: this.orchestrator.planStartWaits(),
      approvals: this.approvals.outstanding(),
      attempt: (task) => this.orchestrator.latestAttempt(task),
      live: (taskId) => this.orchestrator.getAttempt(taskId) !== undefined,
      checkpoint: (taskId) => this.orchestrator.getCheckpointQuestion(taskId),
      waitsForApproval: (taskId) => this.record.waitsForApproval(taskId),
      startQueued: (taskId) => this.orchestrator.startQueuedFor(taskId),
      resolvable: (taskId) => this.orchestrator.canResolveConflict(taskId),
      holdReason: (taskId) => this.orchestrator.holdReason(taskId),
      loopRunsOn: (taskId) => this.orchestrator.loopRunsOn(taskId),
      carried: (taskId) => carried.has(taskId),
      run: {
        open: scheduled || resumable,
        advancing: advancesOnItsOwn,
        merging: this.orchestrator.isMerging,
        autoMerges: this.orchestrator.mergesAtGates,
        mergesAtClose: this.orchestrator.mergesAtClose,
        merge: this.runMergeView(),
        mergeHold: this.mergeHold(),
        opsInCheckout: this.opsInCheckout(),
        id: this.runs.planIsolation?.run.id ?? null,
        blocked: this.runs.blocked ? { start: this.runs.blockedStarts, repos: this.runs.blockedIn } : null,
      },
    });
  }

  /** What holds a merge nobody asked for here, as a list or a refusal names it (ADR-0055 D9). */
  private mergeHold(): string[] {
    return this.orchestrator.mergeHold.map((check) => this.namedRow(check));
  }

  /** The ops tasks running in the user's checkout, named as {@link mergeHold} names its checks (ADR-0020). None to ask about without a run to merge, which Merge all refuses on its own. */
  private opsInCheckout(): string[] {
    if (!this.runs.planIsolation) return [];
    return this.orchestrator.opsInCheckout.map((task) => this.namedRow(task));
  }

  private namedRow(task: Task): string {
    return `${taskRefOf(this.store.planTasks, task.id) ?? `#${task.order}`} "${task.title}"`;
  }

  /** The user's answer to an escalation; see {@link ExecutionCommands.answerEscalation}. `raiseTokens` goes with an Approve of a delegated task (ADR-0056 M5). */
  async answerEscalation(id: string, option: string, note?: string, confirmed?: boolean, raiseTokens?: number): Promise<CommandOutcome> {
    return this.commands.answerEscalation(id, option, note, confirmed, raiseTokens);
  }

  /** Run one planner turn with its own {@link TurnEffects}, which only a turn that lands hands back. */
  private async openTurn<T>(turn: () => Promise<T>): Promise<{ landed: T; effects: TurnEffects }> {
    const effects = new TurnEffects(this.failedTasks());
    this.turnEffects = effects;
    try {
      return { landed: await turn(), effects };
    } finally {
      effects.closed();
    }
  }

  /** Each failed task, with the attempt that failed. */
  private failedTasks(): Map<string, number> {
    return new Map(this.store.allTasks.filter((t) => t.status === 'failed').map((t) => [t.id, this.orchestrator.latestAttempt(t)]));
  }

  /**
   * What a run this actor begins leaves failed. The fresh chance is the user's
   * to ask for (ADR-0053), and a supervisor's `run_plan` is a retry its guards
   * count (ADR-0029), so only autorun and a planner leave any; autorun only what
   * failed in the reply it follows (ADR-0030).
   */
  private failuresLeftBy(actor: ExecutionActor): ReadonlySet<string> | undefined {
    if (actor.kind === 'autorun') return actor.leavesFailed;
    return actor.kind === 'planner-turn' ? new Set(this.failedTasks().keys()) : undefined;
  }

  /**
   * Autorun (ADR-0030): a plan the planner submitted in the turn that just
   * ended starts as if the user had pressed Execute, through the seam, so the
   * timeline says autorun started it. Read now, not when the turn opened: the
   * switch is the user's to flip at any time. Work already live, a task the
   * planner started with `run_task` in that turn, joins it as one scheduled
   * run, in Full; the seam keeps it out of live work in Guarded. A scheduled
   * run has the plan's tasks, waiting on a person or a reset or not, so autorun
   * skips it, and starts nothing over what a usage limit holds: a restart
   * would take back that run's pause and failures (ADR-0053).
   * A plan it could not start says why, and a Stop since the plan was submitted
   * withdraws the start as it withdraws any (ADR-0029), unless a run opened
   * after that Stop has the plan already. What failed in that turn stays
   * failed: the fresh chance is the user's to ask for (ADR-0053).
   */
  private autorunSubmitted(effects: TurnEffects): void {
    if (!effects.planSubmitted || !this.userRunSettings().autorun) return;
    if (effects.submissionStopped) {
      if (!effects.ranSinceStop) this.notice('info', 'Autorun did not start the plan: the run was stopped after the planner submitted it. Execute it to start it.');
      return;
    }
    if (this.orchestrator.scheduledRun) return;
    void this.execute({ command: 'run_plan' }, { kind: 'autorun', leavesFailed: effects.failedSince(this.failedTasks()) })
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
      autonomous: () => this.autonomous(),
      userControls: () => SURFACE_CONTROLS[surfaceOf(this.lease.host?.())],
      mergesByThemselves: () => this.automaticMerging() === 'on',
      autorun: () => this.userRunSettings().autorun,
      scheduling: () => this.orchestrator.isScheduling,
      startsHeld: () => this.orchestrator.startsHeld,
      hasLiveWork: () => this.orchestrator.hasLiveWork,
      holdsSlot: (taskId) => this.orchestrator.holdsSlot(taskId),
      runHeld: () => this.orchestrator.runHeld,
      scheduledRun: () => this.orchestrator.scheduledRun,
      startsPending: () => this.orchestrator.startsPending,
      loopCarried: () => this.orchestrator.loopCarried,
      awaitsResume: () => this.orchestrator.awaitsResume,
      submittedStartWaits: () => this.turnEffects.startWaits && this.userRunSettings().autorun,
      loopRunsOn: (taskId) => this.orchestrator.loopRunsOn(taskId),
      advancesOnItsOwn: () => this.orchestrator.advancesOnItsOwn,
      admitStart: () => this.orchestrator.admitStart(),
      running: (taskId) => this.orchestrator.getAttempt(taskId) !== undefined,
      repairOwed: (taskId) => this.orchestrator.repairWait(taskId) !== null,
      maxParallel: () => this.config.maxParallelSessions,
      runBlocked: () => this.runs.blocked,
      heldRefusal: () => {
        const held = this.heldElsewhere();
        return held && describeHeld(held);
      },
      startWaits: (task) => this.orchestrator.startWaits(task),
      waitingRequests: (taskId) => this.approvals.outstanding()
        .filter(({ request }) => isRunnerApproval(request) && request.taskId === taskId)
        .map(({ id, request }) => ({ id, subject: request.subject })),
      runPlan: (actor) => this.runWholePlan(runOrigin(actor), this.failuresLeftBy(actor)),
      joinRun: (approved, left) => this.joinRun(approved, left),
      readyFailed: () => this.orchestrator.readyFailed(),
      startTask: (taskId, actor) => this.startOneTask(taskId, runOrigin(actor)),
      forceStart: (taskId) => this.saves.control(() => this.orchestrator.forceStartTask(taskId, 'user')),
      markComplete: (taskId) => this.saves.control(() => this.orchestrator.markTaskComplete(taskId)),
      markNotDone: (taskId) => this.saves.control(() => this.orchestrator.markTaskIncomplete(taskId)),
      revertScope: (taskId) => this.orchestrator.revertScope(taskId),
      revertTask: (taskId) => this.saves.control(() => this.orchestrator.revertTask(taskId)),
      interrupt: (taskId) => this.saves.control(() => this.orchestrator.interruptTask(taskId)),
      stopTask: (taskId, actor) => {
        // Before it ends: its release can outlast a held event's timer, which must find the stop.
        if (actorAuthority(actor.kind) === 'user') this.supervision.taskStoppedByUser(taskId);
        return this.saves.control(() => this.orchestrator.cancelTask(taskId));
      },
      stopRun: (actor) => this.stopExecution(actor),
      stopAsked: () => {
        this.supervision.userStopped();
        this.orchestrator.stopAsked();
        this.saves.after();
      },
      startAsked: (actor) => { if (actorAuthority(actor.kind) === 'user') this.supervision.userStarting(); },
      retryTask: (taskId, actor) => this.restartTask(taskId, runOrigin(actor)),
      checksDelegatedTask: (taskId) => {
        const task = this.store.get(taskId);
        return task !== undefined && checksDelegatedTask(this.store.planTasks, task, { runnerModes: this.catalog.edit().runnerModes });
      },
      skipTask: (taskId, reason, actor) => this.saves.control(() => this.orchestrator.skipTask(taskId, reason, runOrigin(actor))),
      continueTask: (taskId, message, actor) => this.resumeTask(taskId, message, runOrigin(actor)),
      landKept: (taskId) => this.saves.control(() => this.orchestrator.landKeptWork(taskId)),
      resumeNow: (taskId, message, actor) => this.saves.control(() => this.orchestrator.resumeNow(taskId, runOrigin(actor), message)),
      messageTask: (taskId, text) => this.sendTaskMessage(taskId, text),
      forceMessage: (taskId, text) => this.forceSendTaskMessage(taskId, text),
      forceSendQueued: (taskId, id) => this.forceSendQueuedTaskMessage(taskId, id),
      removeQueued: (taskId, id) => this.removeQueuedTaskMessage(taskId, id),
      cancelResume: (taskId) => this.cancelScheduledResume(taskId),
      awaitsCheckpoint: (taskId) => this.awaitsCheckpoint(taskId),
      approveReview: async () => {
        // The plan's own mark beside the record the seam keeps: planner starts read it (ADR-0029).
        this.record.approvePlan();
        await this.saves.control(() => this.orchestrator.approveReview('user'));
      },
      answerCheckpoint: (taskId, approve, reason, note) => (approve ? this.approveCheckpoint(taskId, note) : this.rejectCheckpoint(taskId, reason)),
      raiseChild: (taskId, tokens) => this.funds.raise(taskId, tokens),
      mergeHold: () => this.mergeHold(),
      answerRequest: (requestId, decision) => this.resolveApproval(requestId, decision),
      opsInCheckout: () => this.opsInCheckout(),
      mergeAll: (besideOps) => this.mergeAll(besideOps),
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
      // Read only where the build offers delegation, so a flat session's change meets what it always met (ADR-0055 D21).
      node: () => {
        if (!this.delegationOffered) return undefined;
        const budget = this.funds.held();
        return { mandate: this.mandate(), level: this.authority.depth, ...(budget ? { budget } : {}) };
      },
      canSeal: async () => (await this.fsAdapter.canSeal?.()) ?? false,
    };
  }

  private get delegates(): boolean {
    return this.delegationOffered && this.mandate().grants.has('delegate');
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
    const placed = this.position.plannerActor();
    if (placed) return placed;
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

  /**
   * Where this session's user is and how its run is set, for the planner and
   * the refusals that tell it what the user does (ADR-0030). The surface is
   * the live host's (ADR-0049). None for a subplanner: its asker is a planner,
   * which presses no control.
   */
  private surfaceSettings(): SurfaceSettings | null {
    if (this.position.answersToParent) return null;
    return {
      surface: surfaceOf(this.lease.host?.()),
      automaticMerging: this.automaticMerging(),
      autorun: this.userRunSettings().autorun,
      supervisorLevel: this.supervision.standing().level,
      parallelLimit: this.config.maxParallelSessions,
    };
  }

  /** The run's automatic merging as it stands: the run's own setting while one runs, the user's otherwise (ADR-0030). */
  private automaticMerging(): SurfaceSettings['automaticMerging'] {
    const standing = this.supervision.standing();
    if (!standing.mergeAtGatesAutomatically) return 'off';
    // On, yet not merging now (a landing override, a delegated task's check): the user's merge is what lands the work.
    return standing.running && !this.orchestrator.mergesAtGates ? 'held' : 'on';
  }

  /** The user's run settings as they stand for this session (ADR-0030). */
  private userRunSettings(): GlobalRunSettings {
    return this.runSettingsValue;
  }

  /** What this node may do without a person, as it stands now (ADR-0056 M1): derived at the root, and never saved. */
  mandate(): Mandate {
    return this.authority.mandate(this.supervision.level);
  }

  /** Each value where it lives today; the level is the caller's to name (ADR-0056 M1). */
  private rootSettings(): Omit<RootSettings, 'level'> {
    const { autorun, delegationTokens, delegationDepth, delegatedTasksPerPlan, tasksPerChildPlan } = this.userRunSettings();
    return {
      autorun,
      autonomous: this.config.autonomousMode,
      delegationTokens,
      shape: { depth: delegationDepth, delegatedTasks: delegatedTasksPerPlan, tasksPerPlan: tasksPerChildPlan },
      effects: this.effectRules(),
      runners: this.catalog.runnersFor('plan') ?? [],
      models: this.catalog.allowlist(),
    };
  }

  private effectRules(): EffectRules {
    return parseEffectAllowlist(this.config.effectAllowlist, plannerAllowlistOf(this.config));
  }

  /** Whether this node's tasks default to their runner's autonomous mode. */
  private autonomous(): boolean {
    return this.position.autonomous(this.config.autonomousMode);
  }

  /**
   * A call at the seam, in the transcript where it happened and on every
   * surface at once. The call has happened by now, so a failed save is said
   * rather than thrown: a Stop that took must not answer as refused.
   */
  private recordExecution(record: ExecutionRecord, text: string): void {
    this.supervision.executed(record);
    this.mutatePlan(() => {
      this.conversation.recordExecution(record, text);
      return true;
    }, () => this.broadcast({ type: 'execution_action', record, text }), 'after');
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

  /** Whether a planner turn waits on the installed-planner probe, for a surface that joins or reconnects meanwhile. */
  plannerDetection(): Extract<SessionMessage, { type: 'planner_detection' }> {
    return { type: 'planner_detection', waiting: this.gate.detecting };
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
  /**
   * Where this session's own files live: its workspace, unless it is a child,
   * whose code root goes with a worktree (ADR-0055 D11). Git and the planner
   * read {@link workspaceRoot}; a save, a log and the lease read this.
   */
  private get stateRoot(): string { return this.position.stateRoot(this.workspace); }
  /** The planner this session's own gate reads — not whatever the host's config says now. */
  get plannerProvider(): PlannerBackendId { return this.config.aiProvider; }
  /** Where this session's structured task logs are saved (ADR-0018, P1). */
  get taskLogLocation(): TaskLogLocation {
    return this.position.logLocation(this.workspace, this.currentSessionId);
  }

  /** Seat a child session in a task's worktree (ADR-0055 D11, D17): see {@link NodePosition.hostChild}. */
  hostChild(taskId: string): ChildPlacement {
    return this.position.hostChild(taskId);
  }

  /** The tree's plans as a surface reaches them, one directory at every depth (ADR-0055 D20). */
  get children(): ChildDirectory {
    return this.position.children;
  }

  /** The root Session's id, under which a tree's state sits (ADR-0055 D11). */
  get rootSessionId(): string {
    return this.position.rootSessionId(this.currentSessionId);
  }

  /** The pool has a slot for the turn it refused: the opening waiting for one, or else the next of the queue. */
  turnRoomFreed(): void {
    this.gate.freed();
  }

  /** Where a planner's process starts, opened around its adapter (ADR-0059 L1). No lease: nothing has a turn to start it for. */
  openTurnLease(signal: AbortSignal): Promise<OpenLease> | undefined {
    return this.gate.open(signal);
  }

  /**
   * The tree's ledger, opened from the log if nothing has yet. A Continue asks
   * before {@link hostChild}, whose placement names a child's node only once
   * this has answered. A flat run has no reason to ask.
   */
  ledger(): Promise<TreeLedger> {
    return this.funds.ledger();
  }

  /** This node's side of the tree's ledger (ADR-0056 M5). */
  private get funds(): NodeFunding { return this.position.funds; }
  /** Where this node sits under its parent (ADR-0055 D20). */
  private get seat(): NodeSeat { return this.position.seat; }
  /** What this node reads of its plan, the plans below it and its board (ADR-0057 R1, R8). */
  get reading(): NodeReading { return this.position.reading; }

  /** What its position reads of this Session, bound once: everything here is read afresh, since a load moves the plan, the id and the workspace under it. */
  private nodeHost(): NodeHost {
    return {
      depth: this.authority.depth,
      mandate: () => this.mandate(),
      sessionId: () => this.currentSessionId,
      workspace: () => this.workspace,
      closed: () => this.closed,
      delegationOffered: this.delegationOffered,
      runs: () => this.runs,
      pool: () => this.orchestrator.slotPool,
      store: () => this.store,
      saved: () => this.saves.after(),
      heldElsewhere: () => this.heldElsewhere(),
      delegationLimit: () => this.userRunSettings().delegationTokens,
      notice: (level, message) => this.notice(level, message),
      childrenStopped: () => this.childPlans.stopEvery(),
      stopSubtree: () => this.stopSubtree(),
      // A raise only moves numbers: what its room lets start is this run's to start (ADR-0056 M5).
      raised: () => {
        if (this.orchestrator.isScheduling) void this.saves.control(() => this.orchestrator.tick()).catch((err: unknown) => this.notice('error', `The raise could not start work: ${err instanceof Error ? err.message : String(err)}`));
      },
      refusedStart: (why) => this.supervision.observe({ kind: 'start_refused', detail: why.replace(/\.$/, '') }),
      child: (spec) => {
        const child = this.childSession(spec);
        return {
          load: (plan, goal) => child.loadPlan(plan, goal, spec.cwd, { sessionId: spec.placement.sessionId }),
          asNode: (task, mandate, pins) => child.seat.asNode(task, mandate, pins),
          destroy: () => child.destroy(),
        };
      },
      seat: {
        sessionId: () => this.sessionId,
        goal: () => this.goal,
        plan: () => this.plan,
        tasks: () => this.store.planTasks,
        snapshot: () => this.store.snapshot(),
        run: () => this.runSnapshot(),
        plannerTurnId: () => this.plannerTurnId,
        plannerCompaction: () => this.plannerCompaction(),
        working: () => this.isPlannerBusy || this.turns.turnRunning,
        opened: () => this.plan !== null || this.opening !== null,
        turns: () => this.turns,
        follow: (input) => this.behindOpening(input) ?? this.turns.follow(input),
        startPlanning: (goal) => this.startPlanning(goal),
        continueConversation: (text) => this.continueConversation(text),
        execute: (command, actor) => this.execute(command, actor),
        actor: () => this.turnActor(),
        awaitsCheckpoint: (taskId) => this.awaitsCheckpoint(taskId),
        checkpointQuestion: (taskId) => this.orchestrator.getCheckpointQuestion(taskId),
        owesChildren: (text) => this.orchestrator.owesChildren(text),
        refusedStart: () => this.orchestrator.refusedStart,
        runIsLive: () => this.runIsLive,
        unmerged: () => this.runMergeView() !== null,
        wakeOwed: () => this.supervision.wakeOwed || this.plan?.plannerResend?.at !== undefined,
        supervisorLevel: () => this.supervision.level,
        takeReport: (report) => this.reading.report(report),
        notice: (level, message) => this.notice(level, message),
        stopSubtree: () => this.stopSubtree(),
        destroy: async () => {
          this.destroy();
          await this.departed;
        },
      },
      reading: {
        tasks: () => this.store.planTasks,
        logs: { attempts: (taskId) => this.taskLogAttempts(taskId), events: (taskId, attempt) => this.taskLog(taskId, attempt) },
        workspaceRoot: () => this.workspaceRoot,
        git: { branch: () => this.runs.integrationBranch, blob: (branch, file) => this.runs.blobOn(branch, file) },
        childSession: (taskId) => this.runs.childSession(taskId),
        addressed: (task) => this.scopeLines.landed(task),
      },
    };
  }

  /** A child's mandate and budget, carved from what this node has left (ADR-0056 M4, M5). */
  carveChild(taskId: string, request: Omit<MandateRequest, 'level'>, reopening?: string): Promise<Carved> {
    return this.funds.carve(taskId, request, reopening);
  }

  /** A raise for the child in `taskId`, applied from what this node has left (M5). Null when it took; otherwise why not. */
  raiseChild(taskId: string, tokens: number): Promise<string | null> {
    return this.funds.raise(taskId, tokens);
  }

  /** A delegated task's row (ADR-0055 D20), read afresh each time a status goes out: nothing of it is kept. */
  delegatedRow(taskId: string): DelegatedRow | undefined {
    const task = this.store.get(taskId);
    if (task?.type !== 'delegated') return undefined;
    const tasks = this.childPlans.progressOf(taskId);
    const tokens = this.funds.rowTokens(task);
    const row: DelegatedRow = {
      ...(tasks ? { tasks } : {}),
      ...(tokens ? { tokens } : {}),
      ...(this.orchestrator.windingDown(taskId) ? { stopping: true as const } : {}),
    };
    return Object.keys(row).length > 0 ? row : undefined;
  }

  /** A child plan's start (ADR-0055 D3, D17): see {@link NodePosition.openChild}. */
  openChild(task: Task, cwd: string, link: SubplannerLink, reopening?: string): Promise<ChildNode> {
    return this.position.openChild(task, cwd, link, reopening);
  }

  /** A delegated task's next attempt is fresh: the child its last one left goes (ADR-0055 D15). */
  discardChild(task: Readonly<Task>): Promise<void> {
    return this.position.discardChild(task);
  }

  /** The run's own discard reaches no child: each is named only by what this run forgets (ADR-0055 D11). */
  private async discardChildren(): Promise<void> {
    for (const task of this.store.allTasks) if (task.type === 'delegated') await this.discardChild(task);
  }

  /** A Stop stands at this node or above it, or its budget has stopped it (ADR-0055 D16, ADR-0056 M5). */
  get underStop(): boolean {
    return this.position.underStop;
  }

  /** Why no claim and no planner turn may start at this node (ADR-0055 D16). */
  nodeRefusal(): string | null {
    return this.position.nodeRefusal();
  }

  /** Its report is what its verdict and landing go by (ADR-0055 D7). */
  get reported(): boolean {
    return this.position.reported;
  }

  /** {@link nodeRefusal}, and a report: a turn can still read a person's message, but no task may start from it. */
  startRefusal(): string | null {
    return this.position.startRefusal();
  }

  /**
   * Everything under this node stops, leaves first, its planner turn and any
   * turn waiting included, and this resolves once it has all gone: with no
   * timeout of its own, since a runner's grace is the runner's (ADR-0055 D16).
   */
  async stopSubtree(): Promise<void> {
    try {
      this.abortPlannerTurn();
    } finally {
      // A turn that failed to stop leaves no runner, and no child, working on.
      if (this.stopOwed || this.orchestrator.movesUnasked) this.stopRun();
      await this.childPlans.stopEvery();
      await this.orchestrator.woundDown();
    }
    await this.conversation.idle();
  }

  /** What is ready cannot start and nothing live will free room for it (ADR-0056 M5). */
  startRefused(why: string): void {
    this.position.startRefused(why);
  }

  /** What a delegated task's branch changed since its base. */
  changedPaths(taskId: string, names?: 'both'): Promise<string[]> {
    return this.runs.changedPaths(taskId, names);
  }

  /** Why this node stopped for its budget, or null: a parent's reason for ending it `blocked`. */
  get outOfBudget(): string | null {
    return this.funds.stoppedFor();
  }

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
   * The relay announces every orchestrator event and makes the saves they owe
   * first; this adds the events the Session announces itself, each saved
   * before its announcement too so no surface sees a decision the disk lacks.
   */
  private observer(): OrchestratorObserver {
    const relay = this.events.observer(() => this.plan, this.saves);
    return {
      ...relay,
      onRunStarted: ({ origin }) => {
        if (!this.plan) return;
        this.supervision.runStarted(origin);
        this.saves.after();
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
      onCheckpoint: (data) => {
        // A child that asks pays first for the answer (ADR-0056 M5).
        this.funds.woken(this.runs.childSession(data.taskId) ?? '');
        relay.onCheckpoint(data);
      },
      // A script's effects do not wait for a save, and a reload that finds it
      // unstarted would offer to run them again as if they never ran (ADR-0035).
      onScriptClaimed: () => this.saves.after(),
      // Saved the moment it settles: a shared run has no run record to save
      // it mid-run, so a crash would otherwise lose every verdict since the
      // last Session operation.
      onTaskSettled: ({ taskId }) => {
        const task = this.store.get(taskId);
        this.saves.once(() => { if (task) this.supervision.taskSettled(task); });
      },
      onUsageLimitWait: ({ taskId, runner, resumeAt, cancelled }) => {
        if (!cancelled) this.supervision.observe({ kind: 'usage_limit', taskId, runner, resumeAt });
      },
      onModelSwitched: (switched) => { void this.followRunnerModel(switched); },
      onTaskIdle: ({ taskId, idleSince }) => {
        this.supervision.observe({ kind: 'task_idle', taskId, detail: `no output since ${idleSince}` });
      },
      onRunClosed: () => { this.closedUnannounced = true; },
      onIsolationHandoff: (handoff) => this.broadcast({ type: 'isolation_handoff', ...this.supervision.handoff(handoff) }),
      onExecutionComplete: () => {
        this.saves.after();
        this.events.flushStatus(this.plan);
        this.announceClosed();
        this.events.executionComplete(this.plan);
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

  /** Persists PlanStore state to disk, through {@link SessionSaves}: PlanStore is the single authority. */
  private write(plan: LegacyPlanState): void {
    this.syncPlanTasks();
    plan.isolation = this.runs.planIsolation ?? undefined;
    plan.mergedRun = this.runs.mergedRun ?? undefined;
    plan.plannerUsage = this.usage.snapshot();
    plan.contextWindows = this.windows.snapshot();
    // What supervision remembers is read here, at the one save seam, so it is
    // written in the same save as the action that changed it (ADR-0029).
    plan.supervision = this.supervision.snapshot();
    plan.lastUpdated = new Date().toISOString();
    this.save(plan, this.goal, this.stateRoot, this.currentSessionId);
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
    return this.lease.hold(this.currentSessionId, this.stateRoot);
  }

  /** Work on the session this Session has open is refused while another host holds it (ADR-0049 L5). */
  private refuseHeld(): void {
    const held = this.heldElsewhere();
    if (held) throw new SessionHeldError(held);
  }

  /**
   * A new plan under the host's fixed id writes that session's file: refused
   * before any planner turn while another host has it open (ADR-0049). A
   * minted id is new, and is claimed at its first save.
   */
  private claimHostSession(): void {
    if (this.hostSessionId) this.lease.claim(this.hostSessionId, this.stateRoot);
  }

  /**
   * Another host took the session over, judging this one gone (ADR-0049). Its
   * runners must not work on beside that host's, in the worktrees that host
   * now prepares, so the run here stops. The planner turn is abandoned, not
   * only stopped: a backend can still answer past a stop, and that reply would
   * write a PRD into the checkout that host now holds. What waits behind it
   * stays, for the gate to refuse with the hold's own reason (L5).
   */
  private leaseLost(held: SessionHeld): void {
    this.saves.heldBy(held);
    this.notice('error', describeLost(held));
    if (this.stopOwed) this.stopRun();
    this.conversation.abandonTurn();
  }

  /** Something of the run would go on if left: work, a resume, a start on its way, or a loop a retry would carry on (ADR-0045 L5). */
  private get stopOwed(): boolean {
    return this.isExecuting || this.orchestrator.isRunning || this.orchestrator.awaitsResume || this.orchestrator.startsPending || this.orchestrator.loopCarried;
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
    this.saves.settle();
    this.escalationNotifier.hush();
    // A turn waiting at the planner gate belongs to this scope too: let open
    // later, it would plan the old goal in whatever scope is held by then.
    this.gate.endAll(() => new PlannerTurnDiscardedError());
    // A start still opening its run belongs to this plan: let through, it would claim a task of the next one that shares its id.
    if (this.stopOwed) this.stopRun();
    this.conversation.abandonTurn();
    this.turns.abandon();
    this.supervision.reset();
    this.conversation.reset();
    // A tree is its root session's: the next one reads its own log, if it has one.
    this.funds.letGo();
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

  /** The fresh plan of a goal its gate let in, which keeps the slot that gate took (ADR-0055 D18). */
  private beginFreshPlanForTurn(): void {
    this.gate.carry(() => this.beginFreshPlan({ keepGrants: true }));
  }

  /**
   * Return the Session to a blank slate — hosts call this on "new session".
   * Everything scoped to the old session goes: the live AI conversation, plan,
   * goal, tasks, execution log, pending turns, approved scopes, model cache,
   * and (unless the host fixed one) the persisted identity, so nothing can
   * bleed into the next session.
   */
  reset(): void {
    this.saves.settle();
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
  /**
   * The run has not settled: an attempt at work, a start pending, or a landing
   * or Merge all under way. While it holds, so does its landing branch (ADR-0062 G7).
   */
  get runIsLive(): boolean { return this.runOpening !== null || this.orchestrator.movesUnasked || this.orchestrator.isMerging; }

  /**
   * A person's git action on this run's landing branch, as one line of the
   * timeline (ADR-0062 G6). The action has happened by now, so a failed save
   * is said rather than thrown.
   */
  recordUserAction(text: string, at: string = new Date().toISOString()): void {
    this.mutatePlan(() => {
      this.conversation.recordUserAction(text, at);
      return true;
    }, undefined, 'after');
  }

  /** The lines a host that does not hold this session left for it, folded into the timeline (ADR-0062 G6). */
  foldUserActions(): void {
    if (!this.plan) return;
    for (const line of takeUserActions(this.currentSessionId, this.stateRoot)) this.recordUserAction(line.text, line.at);
  }
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
    // A node with no turn left cannot say so itself (ADR-0056 M5).
    const stopped = this.nodeRefusal();
    if (stopped) throw new Error(stopped);
    const refused = this.funds.turnRefusal();
    if (refused) {
      this.funds.stop(refused);
      throw new Error(refused);
    }
  }

  /**
   * What a turn on the session this Session has open passes. Not part of
   * {@link assertPlannerReady}, which a new goal passes too: under a minted id
   * that goal leaves a held session behind, and {@link claimHostSession} judges
   * a fixed one.
   */
  private assertTurnMayRun(): void {
    this.refuseHeld();
    this.assertPlannerReady();
  }

  /**
   * Whether a planner turn — a reply, a compaction, plan generation — holds
   * the conversation, or one admitted waits at the planner gate to: a host
   * that read the wait as idle sent a follow-up as a new goal.
   */
  get isPlannerBusy(): boolean { return this.conversation.isTurnInFlight || this.gate.waiting; }

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
    const waiting = this.gate.endAll(() => new PlannerTurnStoppedError());
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
    this.gate.endAll(() => new PlannerTurnDiscardedError());
    // Before the plan scope is dropped, so a refusal leaves the plan held now as it was.
    let chosenRunners: RunnerId[];
    try {
      const opening = this.gate.admit(options?.signal);
      if (opening) await opening;
      chosenRunners = this.chosenRunners(runners);
      this.claimHostSession();
    } catch (err) {
      this.gate.dropped();
      throw err;
    }
    this.plan = null;
    this.goal = goal;
    this.remintSessionId();
    this.beginFreshPlanForTurn();

    const generated = await this.conversation.hold(options?.signal, async (turn) => {
      const { modelsByRunner, runnerModes } = await this.catalog.planning(chosenRunners);
      const modes = { ...plannerModesFrom(this.autonomous()), isolatedExecution: await this.runs.plannerLayout(), taskSkills: this.workspaceSkills() };
      const subagents = new SubagentRuns();

      const { skillWarnings = [], ...plan } = await this.planner.generate({
        goal,
        runners: chosenRunners,
        modelsByRunner,
        runnerModes,
        autonomousDefault: this.autonomous(),
        fs: this.fsAdapter,
        fetcher: this.fetcher,
        onProgress: (p) => {
          subagents.observe(p);
          this.events.progress(p);
        },
        signal: turn.signal,
        perRunnerAllowlist: this.catalog.allowlist(),
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
    if (this.orchestrator.startsPending) await this.saves.control(() => this.orchestrator.tick());
    return generated;
  }

  /**
   * Kick off the planner conversation (ADR-0002): research + the first planner
   * message. The conversation itself — transcript, live model context, turn
   * settlement — is {@link PlannerConversation}'s; the Session hosts it.
   */
  async startPlanning(goal: string, runners?: RunnerId[], options?: GeneratePlanOptions): Promise<LegacyPlanState> {
    // A new goal replaces whatever still waits to open: the latest intent wins.
    this.gate.endAll(() => new PlannerTurnDiscardedError());
    const pending: PendingOpening = { held: [] };
    this.opening = pending;
    let opened: Promise<{ landed: LegacyPlanState; effects: TurnEffects }>;
    try {
      const gate = this.gate.admit(options?.signal);
      if (gate) await gate;
      const chosenRunners = this.chosenRunners(runners);
      this.claimHostSession();
      this.plan = null;
      this.goal = goal;
      this.remintSessionId();
      this.beginFreshPlanForTurn();

      const now = new Date().toISOString();
      this.plan = { tasks: [], generatedAt: now, status: 'draft', runners: chosenRunners, lastUpdated: now };
      opened = this.openTurn(() => this.conversation.start(this.resolveSkillInvocation(goal), () => this.conversationOpening(chosenRunners), options?.signal));
    } catch (err) {
      this.gate.dropped();
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
      if (this.orchestrator.startsPending) await this.saves.control(() => this.orchestrator.tick());
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
    this.save(plan, this.goal, this.stateRoot, sessionId);
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
    let compaction: ConversationCompaction;
    try {
      const opening = this.gate.admit(signal);
      if (opening) await opening;
      // After the wait, which a takeover can land in.
      this.refuseHeld();
      compaction = await this.conversation.compact(signal);
    } catch (err) {
      this.gate.dropped();
      throw err;
    }
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
      // The compaction has landed and is saved: what fails now is only the meter's save.
      this.saves.after();
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
    if (this.reported) return { ok: false, errors: [{ field: 'tasks', message: NODE_REPORTED }] };
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
    if (this.reported) return refuse(NODE_REPORTED);
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
      autonomousDefault: this.autonomous(),
      autorun: this.userRunSettings().autorun,
      isolatedExecution: await this.runs.plannerLayout(),
      fs: this.fsAdapter,
      fetcher: this.fetcher,
      readLimit: this.readLimit,
      approval: this.approvalPolicy,
      notice: (level, message) => this.notice(level, message),
      // No turn's stream: the agent spent it after the turn ended, so it is the session's.
      onUsage: (record) => this.events.progress({ type: 'usage', record }),
      plannerTools: {
        sessionId: this.sessionId,
        handler: this.position.offeredTools(this.plannerTools),
        ...(this.delegates ? { delegates: true } : {}),
        ...this.position.plannerTools(this.runnerConfig()),
      },
      ...(this.delegates ? { delegation: this.delegationBrief() } : {}),
      ...(this.position.brief ? { subplanner: this.position.brief } : {}),
      skills: this.workspaceSkills().listSkills(),
    };
  }

  /**
   * A harness planner's `run_command`, charged to its read limit (ADR-0068).
   * The planner's MCP token is its runner's own subagents' too, so a command
   * one of them runs here counts against the planner as well.
   */
  private async ownCommand(command: string, signal?: AbortSignal, opts?: BashOptions): Promise<ToolOutcome> {
    const admission = this.readLimit.admit();
    if (!admission.allowed) return { success: false, output: admission.reason, truncated: false };
    const outcome = await this.fsAdapter.bash(command, signal, opts);
    // A refused command read nothing, so it costs no call (ADR-0068 R1).
    if (outcome.refused) this.readLimit.refund();
    else this.readLimit.charge(Buffer.byteLength(outcome.output));
    return outcome;
  }

  /** What the prompt says of this node's limits, as it stands when the planner starts (ADR-0055 D19): what a carve could take then, which a child's limit overstates by what it keeps for its own turns. */
  private delegationBrief(): PlannerDelegation {
    const { limits, grants } = this.mandate();
    return { tokens: this.funds.held()?.left ?? limits.tokens, delegatedTasks: limits.delegatedTasks, grantable: [...grants].filter((grant) => grant === 'research' || grant === 'delegate' || grant === 'effect') };
  }

  /**
   * Load planner-produced tasks, as the check they landed through resolved
   * them against the catalog read live: it may have changed since planning
   * started. The scheduler adopts them into the run under way, or as the plan
   * the next run starts from (`adoptEdit`).
   *
   * They are stored as the check passed them: a whole-plan commit was laid
   * over the plan's execution state there, before its rules judged what lands
   * (ADR-0022 P2), so a planner that answers "add a task" with the full plan
   * cannot undo the work already done.
   */
  private adoptPlannerTasks(tasks: readonly Task[], how: 'edit' | 'commit'): number {
    this.turnEffects.landed(how, this.orchestrator.admittedNow());
    // A runner the planner was allowed to use joins the plan as its tasks land (#69).
    for (const runner of runnersOf(tasks)) this.editor.admitRunner(runner, this.catalog.known(runner));
    const runners = this.plan!.runners;
    const before = this.store.planTasks;
    let coerced = [...tasks];
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
      // A generated plan meets no change check, so a child's grant is read here too (ADR-0056 M6).
      if (!this.mandate().grants.has('research')) continue;
      const to = researchReportTo(this.turnActor());
      this.store.update(task.id, { reportTo: to, researchOrigin: to });
      this.record.approveResearch(task.id);
      // Behind work only the plan's approval starts, a queued start would hold the session as advancing,
      // Stop in place of Approve, while nothing can move: the run that approval opens starts it instead.
      if (!this.startsUnapproved(task.id)) continue;
      if (actorAuthority(this.turnActor().kind) === 'user') this.supervision.userStarting();
      // Queue only as it lands: re-queuing on each turn would undo the user's Stop (ADR-0037 R4).
      this.orchestrator.startAtGate(task.id);
    }
  }

  /** Whether a task, and the unfinished work it builds on, may start before anyone approves the plan. */
  private startsUnapproved(taskId: string, seen = new Set<string>()): boolean {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'skipped' || this.record.planApproved) return true;
    if (seen.has(taskId) || !this.record.isApproved(taskId)) return false;
    seen.add(taskId);
    return task.dependencies.every((dep) => this.startsUnapproved(dep, seen));
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
      // Not a child's code root: an untracked file there is swept into its landing, and a subplanner writes no repository files (ADR-0055 D4).
      savePrdMarkdown(this.stateRoot, prd.slug, prd.markdown);
    } catch {
      // Saving the PRD file is best-effort; the markdown stays on the plan state.
    }
  }

  /** Merge the run settings this session owns, ignoring a field it does not know from a client's body. */
  private mergeRunSettings(given: Partial<GlobalRunSettings>): void {
    const changes = rememberDelegationBudget(given);
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

  private runWholePlan(origin: RunOrigin, keepFailed?: ReadonlySet<string>): Promise<void> {
    // Before the first await: two Executes can arrive while the run is still
    // opening, and the second must join the one under way rather than load the
    // plan over it and spawn its tasks a second time.
    if (this.runOpening) return this.runOpening;
    const plan = this.idlePlan();
    this.turnEffects.ran(this.orchestrator.admittedNow());
    const opening = this.saves.control(async () => {
      // Approved first: the scheduler reads the record at each start.
      this.record.approvePlan();
      plan.status = 'approved';
      await this.orchestrator.beginRun(origin, keepFailed);
    });
    this.runOpening = opening;
    // Another host's interlock reads the start in the lease record (ADR-0062 G7),
    // and a start that came to nothing there too, not a heartbeat later.
    this.lease.publish();
    return opening.finally(() => {
      if (this.runOpening !== opening) return;
      this.runOpening = null;
      this.lease.publish();
    });
  }

  /**
   * Execute while a run is under way (#95): the seam has approved every task,
   * as executing does, and the run takes them in. A run the scheduler was not
   * driving, one task started on its own, becomes the plan's run, as Execute
   * would make it. The planner's run_plan joins with `approved` 0: the
   * scheduler starts only approved tasks, so `left` tasks still wait. A run a
   * usage limit holds stays held, and the line says so, since nothing it names
   * starts before the reset.
   */
  private async joinRun(approved: number, left: number): Promise<string> {
    const scheduling = this.orchestrator.scheduledRun;
    this.turnEffects.ran(this.orchestrator.admittedNow());
    await this.saves.control(async () => {
      this.record.approvePlan();
      await this.orchestrator.joinRun('user');
    });
    const line = approved === 0
      ? left > 0 ? `The plan is ${scheduling ? 'already ' : ''}running; ${left} ${left === 1 ? 'task waits' : 'tasks wait'} for your approval.`
        : scheduling ? 'The plan is already running, and no task waits for your approval.' : 'The plan is running: each task starts once its dependencies finish.'
      : approved === 1 ? 'Approved 1 task; it starts once its dependencies finish.' : `Approved ${approved} tasks; each starts once its dependencies finish.`;
    const said = this.orchestrator.runHeld ? `${line} A usage limit holds the run, so nothing starts before its reset.` : line;
    // A checkout that turned the start away again has said so itself, and nothing the line names starts.
    if (!this.runs.blocked) this.notice('info', said);
    return said;
  }

  private async startOneTask(taskId: string, origin: RunOrigin): Promise<void> {
    if (!this.plan) return;
    this.requireTask(taskId);
    await this.saves.control(() => this.orchestrator.forceStartTask(taskId, origin));
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
    await this.saves.control(() => this.orchestrator.tick());
  }

  private async restartTask(taskId: string, origin: RunOrigin): Promise<void> {
    await this.saves.control(() => this.orchestrator.retryTask(taskId, origin));
  }

  private async resumeTask(taskId: string, message: string, origin: RunOrigin): Promise<void> {
    await this.saves.control(() => this.orchestrator.continueTask(taskId, message, origin));
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
    return this.saves.control(() => this.orchestrator.cancelScheduledResume(taskId));
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

  private approveCheckpoint(taskId: string, note?: string): void {
    this.saves.sync(() => this.orchestrator.approveCheckpoint(taskId, note));
  }

  private rejectCheckpoint(taskId: string, reason?: string): void {
    this.saves.sync(() => this.orchestrator.rejectCheckpoint(taskId, reason));
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
    return this.saves.sync(() => this.orchestrator.sendTaskMessage(taskId, text));
  }

  /**
   * Force send (ADR-0023, F1): interrupt the task's running turn and deliver
   * this message next. Throws `TaskControlError` where a plain message would.
   */
  private forceSendTaskMessage(taskId: string, text: string): string {
    return this.saves.sync(() => this.orchestrator.forceSendTaskMessage(taskId, text));
  }

  /**
   * The task runner's own command `/name args` (#66), as a turn of its own;
   * not an execution control, so it carries no command at the seam and the
   * daemon hands it straight to the runner. Throws `TaskControlError` where a
   * plain message would.
   */
  invokeTaskCommand(taskId: string, name: string, args = ''): string {
    return this.saves.sync(() => this.orchestrator.invokeTaskCommand(taskId, name, args));
  }

  private forceSendQueuedTaskMessage(taskId: string, id: string): boolean {
    return this.saves.sync(() => this.orchestrator.forceSendQueuedTaskMessage(taskId, id));
  }

  private removeQueuedTaskMessage(taskId: string, id: string): boolean {
    return this.saves.sync(() => this.orchestrator.removeQueuedTaskMessage(taskId, id));
  }

  /** Replay a run a dirty tree blocked, after stashing the tracked changes. */
  async continueWithStash(): Promise<void> {
    await this.saves.control(() => this.orchestrator.continueBlockedRun('stash'));
  }

  /** Replay a run a dirty tree blocked, in the workspace root, for this run only. */
  async continueWithoutIsolation(): Promise<void> {
    // Refused here, with the choice still parked: a shared run asks the leased isolation nothing (ADR-0049).
    this.refuseHeld();
    await this.saves.control(() => this.orchestrator.continueBlockedRun('shared'));
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
   * task, and refuses while one runs unless the user said yes to merging
   * beside it (`besideOps`).
   */
  private async mergeAll(besideOps = false): Promise<IsolationMergeResult> {
    // Ahead of the ops refusal: with no run there is nothing to merge once the ops task ends either.
    this.runs.requireRun();
    const merging = this.saves.control(() => this.orchestrator.mergeRun({ besideOps }));
    // The merge has begun by now: another host's interlock reads it in the lease
    // record (ADR-0062 G7), and reads its end there too, not a heartbeat later.
    this.lease.publish();
    const result = await merging.finally(() => this.lease.publish());
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
    // Before its children: closing a child's node writes to the holder's tree log, ahead of the isolation's own refusal.
    this.refuseHeld();
    this.requireSettledRun();
    await this.saves.control(async () => {
      await this.discardChildren();
      await this.runs.cleanup();
      await this.orchestrator.reclaimLeases();
    });
  }

  /**
   * Give the whole run up, integration branch included. The plan is not
   * rewritten: a task that landed there stays completed until the user says
   * otherwise (Mark not done), because only they know whether they kept the work.
   */
  async discardRun(): Promise<void> {
    // As in cleanupRun.
    this.refuseHeld();
    this.requireSettledRun();
    await this.saves.control(async () => {
      await this.discardChildren();
      await this.runs.discard();
      await this.orchestrator.reclaimLeases();
    });
    this.announceClosed();
  }

  /**
   * Narrower than {@link stopOwed}: a run that ended on a failure, or whose
   * loop a body task stopped, is what these are for. Such a loop ends with the
   * run, once git has let it go, so a refused discard leaves it standing.
   */
  private requireSettledRun(): void {
    this.runs.requireRun();
    if (this.orchestrator.isRunning) throw new PlanEditError('The run is still running: stop it first');
  }

  /** Add the task that merges a conflicted task's branch by hand; see {@link PlanEditor.addConflictResolver}. */
  async resolveConflictAsTask(taskId: string): Promise<LegacyPlanState | null> {
    // It adds an approved task and starts it, which the seam's refusal never sees (ADR-0049 L5).
    this.refuseHeld();
    return this.editor.addConflictResolver(taskId);
  }

  /**
   * The user's Stop (ADR-0029): the run, and every start admitted before it —
   * one queued behind a planner turn's edit, one waiting on its card, one
   * still opening its run. A card still asking is cleared, so its start
   * answers as stopped rather than waiting on a question that no longer stands.
   * The user's stands the supervisor down too; a supervisor's own, for a change
   * it means to run, does not.
   */
  stopExecution(actor: ExecutionActor = { kind: 'user' }): void {
    // A Stop is answered whatever the saves before it already said.
    this.saves.sayNextFailure();
    // First: what the run's stop reports waits with the rest.
    if (actorAuthority(actor.kind) === 'user') this.supervision.userStopped();
    this.stopRun();
  }

  private stopRun(): void {
    // The opening stopped here may still be awaiting a spawn; an Execute after
    // this Stop starts afresh instead of joining a run that no longer stands.
    this.runOpening = null;
    this.events.holdStatus(() => this.orchestrator.stop());
    this.saves.after();
    this.events.releaseStatus(this.plan);
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
   * The one mutation seam: every structural plan mutation runs the same
   * ritual — store op → persist (which snapshots tasks from PlanStore) →
   * broadcast — in that order, once. A store op returning false aborts
   * before anything is persisted. PlanStore is the single authority for
   * task state; LegacyPlanState.tasks is populated only at persist time.
   * Direct edits reach it through the {@link PlanEditor}, which adds the
   * reschedule they owe.
   */
  private mutatePlan(op: () => boolean, notify: () => void = () => this.announcePlan(), save: 'first' | 'after' = 'first'): LegacyPlanState | null {
    if (!this.plan) return null;
    if (!this.saves.mutation(op, save)) return null;
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

  /**
   * A field edit from a task card, with the card's own precondition derived
   * here from the run's facts instead of by each host: a run that could still
   * move a task on holds its editors to a task that has not started, and a task
   * that has not started is held to it in an idle plan too, since a start can
   * claim it while the edit waits on discovery or a skills check. The editor
   * checks it again after those waits, so a task claimed meanwhile is left
   * untouched and the edit is refused. A settled task of an idle plan, a failed
   * one a run ended on included, keeps the wider direct-edit contract.
   */
  async cardEdit(taskId: string, edit: CardEdit): Promise<LegacyPlanState | null> {
    const target = flattenTasks(this.store.planTasks as Task[]).find((t) => t.id === taskId);
    const held = runHoldsEditors(this.isExecuting, this.activity);
    const requireUnstarted = target ? cardEditNeedsUnstarted(held, target) : held;
    return this.editor.updateTask(taskId, cardEditPatch(edit), { requireUnstarted });
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
    // `workspace` becomes the code root: as where a child is built (ADR-0055 D12).
    this.position.refuseCheckout(workspace);
    // A live planner conversation belongs to the plan it was started for.
    // Adopting a different plan (session load/switch) must drop it — otherwise
    // the next user message continues the OLD session's LLM thread and the
    // planner re-emits that session's plan here. The same-object case (e.g.
    // re-adopting the current plan on approval) keeps the conversation; after
    // a drop, the first user send reseeds it from this plan's own transcript.
    const adopting = plan !== this.plan;
    // Every plan-shape migration lives in one place (models/Task.ts); this load
    // only calls it. Before the refusal check, so the check reads the tasks the
    // orchestrator will be handed: a stored type no kind owns becomes "ai" and
    // is held to the runner set like any other. A saved pause is reset before
    // the orchestrator clones the tasks, so its copy is idle too.
    migrateLoadedPlan(plan, { adopting });
    // First, so a plan the orchestrator would refuse is neither saved over the
    // picked session nor half adopted: past the claim a load is not undone.
    this.orchestrator.assertLoadable(plan.tasks, plan.runners);
    // Before anything of the plan held now is dropped, so a refusal leaves it
    // as it was: another live host has this session open (ADR-0049), or the
    // disk will not take it. A run stopped below cannot be started again, so
    // the load's save is tried here, on the plan as it came (migrated to this
    // build's shape), not undone after.
    // The plan held now goes inside the claim too: what it saves as it goes
    // needs its own lease, and taking that back after the claim would let the
    // picked one go.
    if (adopting) {
      const stateRoot = this.position.stateRoot(workspace);
      this.lease.claim(opts?.sessionId ?? this.currentSessionId, stateRoot, () => {
        this.writeLoaded(plan, goal, stateRoot, opts);
        this.dropPlanScope();
      });
    }
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
    // Held, so a task the load puts back is not saved here: whether a load saves is the caller's to say.
    this.events.holdStatus(() => this.orchestrator.loadPlan(plan.tasks, plan.runners));
    this.saves.loaded();
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
    // The load has happened: the file has the plan as it came, and the next
    // save carries what adopting it added.
    if (opts?.persist !== false) this.saves.after();
    this.events.releaseStatus(this.plan);
    // A reopened session shows its token line again without waiting for the
    // next turn: announce the totals the moment the plan is adopted.
    if (this.usage.hasUsage) this.broadcast(this.usage.message());
  }

  /** The plan a load adopts goes to disk first; whoever asked hears that nothing here changed if it cannot. */
  private writeLoaded(plan: LegacyPlanState, goal: string, stateRoot: string, opts?: { sessionId?: string; persist?: boolean }): void {
    if (opts?.persist === false) return;
    try {
      this.save(plan, goal, stateRoot, opts?.sessionId ?? this.currentSessionId);
    } catch (err) {
      throw new Error(`The session could not be saved (${err instanceof Error ? err.message : String(err)}), so it was not opened. What was open here stays as it was.`, { cause: err });
    }
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
    if (persists) this.saves.after();
    this.events.status(plan);
    if (outcome === 'cleared') this.broadcast({ type: 'run_closed' });
  }

  destroy(): void {
    this.scopeLines.dispose();
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
    this.saves.settle();
    this.events.closeStatus(this.plan);
    this.orchestrator.leaveTree();
    // Last: stopping the run above saves what it changed, which needs the lease.
    // A child reads the lease through this Session (ADR-0055 D13), so with one
    // still stopping it goes only once that child has: read as free, the tree
    // could be taken from under what it still writes. So with what this run
    // started: a runner winding down, a container and all it holds open, or a
    // release or a merge still changing git.
    if (this.childPlans.activeCount === 0 && this.orchestrator.leftNothing) this.letLeaseGo();
    else this.departed = this.childPlans.stopEvery().then(() => this.orchestrator.allGone()).catch(() => undefined).then(() => this.letLeaseGo());
  }

  private letLeaseGo(): void {
    this.lease.release();
    this.leaseReleased = true;
  }

  /** Destroyed, with everything under it gone and its lease let go. */
  get gone(): Promise<void> {
    return this.departed;
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

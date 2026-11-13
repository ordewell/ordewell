import { actorAuthority } from '../models/Execution';
import { Task, TaskSnapshot, Verdict, RunnerId, DEFAULT_RUNNERS, flattenTasks, flattenTasksWithParents, pausedOnLimit, waitsForReset, waitsMidAttempt, type RunSettings } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { INotification } from '../interfaces/INotification';
import type { IRunner, QueuedTaskMessage } from '../interfaces/IRunner';
import type { TaskShell, TaskShellSite } from '../interfaces/IFileSystem';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { RunnerModelRef } from '../models/RunnerCommand';
import { checksHoldingMerge, checksOf, type DelegationRules } from '../models/Delegation';
import { summarizeOutput } from './promptAugment';
import { BufferedTaskOutputSource } from './BufferedTaskOutputSource';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { PlanStore, assertAssignedRunners } from './PlanStore';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type {
  IsolationHandoff,
  IsolationMergeResult,
  IsolationRevertResult,
  IsolationRun,
  IsolationView,
  IWorktreeIsolation,
  RepairWait,
  TaskIsolation,
} from '../interfaces/IWorktreeIsolation';
import { createWorktreeIsolation } from './GitWorktreeIsolation';
import { SELF_REPO } from './isolationRecord';
import { taskRefOf } from './TaskRefs';
import { IsolationRunController, type IsolationDecision, type IsolationStart } from './IsolationRunController';
import { completesTask, Landing, type LandingMessage, type LandingOutcome, type UnlandedOutcome } from './Landing';
import { LimitPauses, type LimitWait, type ResumeNow } from './LimitPauses';
import { IDLE_RUN, heldFrom, nextRunState, type RunEvent, type RunState } from './runState';
import { Attempts, type Admitted, type AttemptEnvironment, type AttemptEnded, type EndedAttempt, type TaskAttemptSnapshot } from './Attempts';
import { TaskControlError } from './TaskControlError';
import { landed, planStartWaits, selectReadyTasks, startWaits, waitOf, type ForcedStart, type Readiness, type StartRuleInput, type StartWait, type StartWaitKind } from './readiness';
import type { ResearchTasks } from './ResearchTasks';
import { blockingFailures, planBlocks } from './blocking';
import { loopRoundOf, outOfRounds } from '../models/Loop';
import { LOOP_CHECK_MARKED_COMPLETE, LOOP_CHECK_SKIPPED, LOOP_PASSED } from '../models/SkipOrigin';
import { LEFT_UNDONE, LoopRounds } from './LoopRounds';
import { decidesIsolation, handoffKept, mergeExcludes, type Continuation } from './attemptKind';
import type { SkillLookup } from './taskSkills';
import { SkillsService } from './SkillsService';
import { capConflictFiles } from './conflictFiles';
import { resolveWorkspaceEnv, type WorkspaceEnv } from './workspaceEnv';
import { continuability, reopenMessage, sessionOwner } from './continuation';
import { quotedList } from '../utils/quotedList';
import { inBranchRefusal, landedOnOf, revertReach, revertScope, type RevertScope, type TaskRevertPreview } from './taskRevert';
import type { RunMergeView, RunActivity } from './SessionMessage';
import { ScriptRunner } from './ScriptRunner';
import type { StoredHandoff } from '../models/Handoff';
import { userTaskHandoff } from '../models/DerivedHandoff';
import type { TaskLogReader } from './readTask';
import type { Subtree } from './Subtree';
import type { NodeBoard } from './Board';
import { leasedIsolation, type RunChanges } from './leasedIsolation';
import { LocalWorktreeLease } from './LocalWorktreeLease';
import { SlotPool, type PoolNode } from './SlotPool';
import { StartLedger, type Offer, type QueuedStart } from './StartLedger';
import type { NodeBudget } from './TreeLedger';
import type { ExecutionBackend, LeaseRequest, ReservedLease } from './executionLease';
import type { SessionHeld } from './sessionLease';

export { TaskControlError } from './TaskControlError';

/** What ran an automatic Merge all: a task reaching its merge gate, or the run settling with landed work unmerged. */
export type AutoMergeTrigger = { kind: 'gate'; taskId: string } | { kind: 'run_end' };

/**
 * Who opened a run (ADR-0029): a call the user made, or one made for them; a
 * call of the supervisor's own, or a subplanner's, which has no user to make
 * one for (ADR-0056 M6); a usage-limit reset resuming what it paused; or a loop
 * carried on with no scheduler (ADR-0045 L5). Only the user's starts a run's
 * supervision afresh.
 */
export type RunOrigin = 'user' | 'supervisor' | 'limit-reset' | 'loop';

/** What the scheduler reads of the open run's settings, at each decision it makes from them. */
export type SchedulerRunSettings = Pick<RunSettings, 'mergeAtGatesAutomatically'>;

/**
 * A start someone asked for, from the moment it was admitted until it has
 * taken its claim or been let go (ADR-0029): a start waiting on the user's
 * answer, or on the run to open. Stop counts it as live work,
 * and a Stop since it was admitted refuses its claim.
 */
export interface StartAdmission {
  /** No Stop came since it was admitted. */
  current(): boolean;
  /** It claimed, or will not: Stop no longer counts it. Idempotent. */
  release(): void;
}

/** What a start the user's Stop withdrew answers, wherever it was waiting. */
export const STOPPED_BEFORE_START = 'Not done: stopped before it could start. The run was stopped meanwhile; start it again if it is still wanted.';

function beingMarkedComplete(task: Readonly<Task>): string {
  return `Task "${task.title}" is being marked complete: its work is landing.`;
}

/** A claim taken — its spawn under way — or why the start may not take one. */
type Claim = { spawned: Promise<void> } | { refused: string };

/**
 * The one notification channel out of the orchestrator. Everything that used
 * to travel over a separate callback (onRefresh) is an observer event; the
 * Session subscribes once and turns these into SessionMessages.
 */
export interface OrchestratorObserver {
  /** Any task-shaped state changed (store mutation, checkpoint, retry, …). */
  onTaskChanged?(): void;
  /** A script attempt was claimed and its task is in progress, before anything of it has run (ADR-0035). */
  onScriptClaimed?(): void;
  /**
   * A run reached an outcome that stands until the user acts — completed,
   * failed, or awaiting the user — on its own, not as the answer to a call.
   * Emitted before the `onTaskChanged` that announces it, so a listener can
   * save the outcome before any surface is told.
   */
  onTaskSettled?(data: { taskId: string }): void;
  onRunStarted?(data: { origin: RunOrigin }): void;
  /** An automatic Merge all settled, at a gate or at the run's end; failures are attention events for a supervisor. */
  onAutoMerge?(data: { trigger: AutoMergeTrigger; result: IsolationMergeResult }): void;
  onTick?(): void;
  onUsageChanged?(): void;
  onExecutionComplete?(): void;
  /**
   * A task paused on its runner's usage limit, or its resume changed:
   * `resumeAt` is when it resumes on its own (ISO time), null when it waits
   * for a manual retry — the reset could not be read, the resume was
   * cancelled, or the resumed attempt hit the limit again at once.
   * `cancelled` marks the resume being cancelled, which is no new pause.
   */
  onUsageLimitWait?(data: LimitWait): void;
  /**
   * A task's runner now answers on another model (#106). `asked` when a model
   * command sent through its chat chose it: the user's own choice, which the
   * plan is to follow. `attemptEnded` when the attempt that runs `sessionId`
   * is no longer the task's, so the switch says nothing of what runs next.
   * `effort` only where the runner reported one.
   */
  onModelSwitched?(data: { taskId: string; sessionId: string; from: RunnerModelRef; model: RunnerModelRef; effort?: string; asked: boolean; attemptEnded: boolean }): void;
  /** A live task's runner went silent (ADR-0018's idle timer); paused while it waits on input, a checkpoint or an approval. */
  onTaskIdle?(data: { taskId: string; idleSince: string }): void;
  onReviewNeeded?(data: { tasks: Task[]; planRunners: RunnerId[] }): void;
  onReviewApproved?(data: { tasks: Task[] }): void;
  onCheckpoint?(data: { taskId: string; taskTitle: string; summary: string }): void;
  /**
   * The isolation run record changed and should be persisted with the plan.
   * `detached` is the record of a run another plan has replaced since — a
   * release that outlived a plan load — for the session it belongs to.
   */
  onIsolationChanged?(detached?: IsolationRun): void;
  /** A run did not start: the tree is dirty, and the user picks stash or no isolation. `repos` names the dirty repos of a group. */
  onIsolationBlocked?(data: { reason: 'dirty'; repos: string[] }): void;
  /** An isolated run settled; emitted before `onExecutionComplete`, which surfaces treat as terminal. */
  onIsolationHandoff?(handoff: IsolationHandoff): void;
  /** The isolated run was cleared up and forgotten, by a Merge all that left nothing to hand over or by a discard. */
  onRunClosed?(): void;
  /**
   * What a run says about how it isolates — the fallback to the workspace root,
   * shared paths, copies, a stash. Beside the notification channel, which a
   * daemon may leave unwired, so a surface without toasts can still show it.
   */
  onIsolationNotice?(data: { level: 'info' | 'warn' | 'error'; message: string }): void;
}

/**
 * How many runners one tick waits on to attach at once. One at a time, a
 * fan-out takes attach time times its width; all at once, every harness boots
 * together on one machine.
 */
export const STARTS_AT_ONCE = 8;

/** What keeps a queued force start waiting, with nothing to say: it starts once these clear. */
const QUEUED_WAITS: ReadonlySet<StartWaitKind> = new Set<StartWaitKind>(['queued', 'completing', 'merging', 'start-hold', 'unapproved', 'check-running']);
/** What keeps a delegated task's check out of the carried work: only something else starting would free it, and a run held open for it would read as advancing (ADR-0055 D8). */
const CHECK_NOT_READY: ReadonlySet<StartWaitKind> = new Set<StartWaitKind>(['started', 'blocked', 'dependencies', 'on-hold', 'no-prompt', 'resolver']);

/** A force start the user made now: their own act, past the whole merge gate they confirmed. */
const FORCED_NOW: ForcedStart = { queued: false };

/**
 * The wiring a {@link TaskOrchestrator} runs on, every collaborator resolved.
 * {@link TaskOrchestrator.compose} is the only production caller; tests build
 * one through it too. The constructor makes nothing itself, so there is exactly
 * one place defaults live.
 */
export interface TaskOrchestratorDeps {
  /**
   * Everything an attempt runs on, built once in compose; the orchestrator adds
   * only the host. What the orchestrator reads itself is narrowed to its full
   * type beside it, so a capability only attempts use is declared in
   * {@link AttemptsDeps} and the options, and nowhere here.
   */
  attempt: AttemptEnvironment & {
    config: IConfig;
    /** The plan's isolation run and the open run's lifecycle (ADR-0013). */
    runs: IsolationRunController;
    /** Where sessions run (ADR-0059). */
    leases: ExecutionBackend;
    /** A passed attempt's work onto the integration branch, and any conflict repair. */
    landing: Landing;
    budget?: NodeBudget;
  };
  /**
   * The open run's settings, read as each automatic merge is decided rather
   * than copied when the run opens, so a change to the run under way applies
   * at once (ADR-0030); absent before any run.
   */
  runSettings: () => SchedulerRunSettings | undefined;
  /**
   * The user's approval record, read at each start (ADR-0035): the Session
   * owns it, and the scheduler starts nothing outside it.
   */
  isApproved: (taskId: string) => boolean;
  /** Read beside the run's setting at each automatic merge, which passes no command (ADR-0056 M6). */
  mayMergeUnasked: () => boolean;
  /** The run's changes to git in flight; absent where no session's lease stands behind them. */
  runChanges?: RunChanges;
  /** What a landing owes the tasks beside it (ADR-0057 R6); undefined where it owes nothing, as on a flat plan. */
  landed?: (task: Readonly<Task>) => Promise<void> | undefined;
  /** The tree's slots and usage limits (ADR-0055 D18), which the backend reserves from. */
  pool: SlotPool;
  /** The Session's id, as it saves under it. */
  sessionId: () => string;
  /** Tell the tree this Session found a runner's usage limit; the reset as the tree has it. */
  limitFound: (runner: string, at: Date) => Date;
  /** This Session is done with the tree. */
  leaveTree: () => void;
  /** What is ready cannot start, and nothing live will free room for it, so nothing ticks this again. */
  startRefused: (why: string) => void;
  /** Nothing is deciding where the run goes any more; see {@link TaskOrchestrator.movesUnasked}. */
  decided?: () => void;
  /** Why nothing may start at this node (ADR-0055 D16, ADR-0056 M10); absent at the root, whose own Stop is its generation. */
  nodeRefusal?: () => string | null;
}

/** What a backend hears of the Session it serves, past the local lease it wraps. */
export interface ExecutionContext {
  sessionId: () => string;
  /** The root of this Session's tree: what a clean-up at the root finds a child's leavings by. */
  treeId: () => string;
  tell: (level: 'info' | 'warn' | 'error', text: string) => void;
  /** What a worktree's bootstrap runs on this host, in what was last landed. */
  setupCommand: () => string | undefined;
}

/**
 * What a caller supplies to {@link TaskOrchestrator.compose}; every optional
 * one gets its default there. This is what a host or test chooses, not the
 * resolved wiring the orchestrator itself runs on.
 */
export interface TaskOrchestratorOptions {
  /** The plans below this one (ADR-0057 R1); absent or null with nothing delegated. */
  subtree?: () => Promise<Subtree | null>;
  /** This plan's node in its tree, what a reference is pinned under. Absent, the root's. */
  planNode?: () => string;
  /** This plan's board; null for a flat plan, which has none (ADR-0057 R8). */
  board?: () => Promise<NodeBoard | null>;
  /** What a landing owes the tasks beside it (ADR-0057 R6); undefined where it owes nothing, as on a flat plan. */
  landed?: (task: Readonly<Task>) => Promise<void> | undefined;
  /** What starting a research task owes the planner (ADR-0037 R3). */
  research?: Pick<ResearchTasks, 'started'>;
  config: IConfig;
  notifications: INotification;
  runner: IRunner;
  scriptRunner?: IRunner;
  childPlanRunner?: IRunner;
  store?: PlanStore;
  output?: TaskOutputSource;
  isolation?: IWorktreeIsolation;
  registry?: RunnerRegistry | null;
  workspaceRoot?: () => string;
  /** A child session's state root (ADR-0055 D11); absent on a flat run, whose workspace is both roots. */
  stateRoot?: string;
  workspaceEnv?: (cwd: string) => Promise<WorkspaceEnv>;
  skillsAt?: (roots: readonly string[]) => SkillLookup;
  previousAttemptFromLog?: (taskId: string) => string | null;
  previousHandoffFromLog?: (taskId: string) => StoredHandoff | undefined;
  lastLoggedAttempt?: (taskId: string) => number;
  runSettings?: () => SchedulerRunSettings | undefined;
  /** Whether the commits Ordewell writes end with the Planned-with trailer, read as each is written (ADR-0030). */
  plannedWith?: () => boolean;
  /** Every task is approved unless a Session supplies its record: an orchestrator on its own has no user to ask. */
  isApproved?: (taskId: string) => boolean;
  /** Whether this node's mandate lets an automatic merge run; true unless set. */
  mayMergeUnasked?: () => boolean;
  taskShell?: (site: TaskShellSite) => TaskShell | undefined;
  /** See {@link TaskOrchestratorDeps.unsealedRefusal}. */
  unsealedRefusal?: (task: Readonly<Task>) => string | null;
  taskWebFetcher?: (task: string) => IWebFetcher | undefined;
  keepPatch?: (taskId: string, attempt: number, patch: Buffer) => string;
  recordHandoff?: (sessionId: string | undefined, taskId: string, handoff: StoredHandoff) => void;
  taskLog?: TaskLogReader;
  /**
   * Who holds the session when it is not this host, read before each change
   * to the run (ADR-0049); the run is changed only while it answers null.
   */
  sessionHeld?: () => SessionHeld | null;
  /** Where sessions run (ADR-0059), given the local worktrees: those, unless the `containers` setting or a test supplies another. */
  execution?: (local: ExecutionBackend, context: ExecutionContext) => ExecutionBackend;
  /** The root's pool, handed down to a child (ADR-0055 D18); absent, this is a root, with a pool of its own. */
  pool?: SlotPool;
  /** The Session's id, as it saves under it. */
  sessionId?: () => string;
  /** Its tree's root's, when it is a child; absent, it is a root. */
  treeId?: () => string;
  /** The pool has a slot for the planner turn it refused this Session. */
  openTurn?: () => void;
  /** A child's side of the tree's ledger (ADR-0056 M5). */
  budget?: NodeBudget;
  /** What follows a start its budget refuses with nothing live; the node stops, unless a subplanner can ask. */
  startRefused?: (why: string) => void;
  /** This node's autonomy, as its mandate reads it (ADR-0056 M6); the config's, at a root. */
  autonomous?: () => boolean;
  /** Nothing is deciding where the run goes any more. */
  decided?: () => void;
  /** What this node's ancestors protect (ADR-0056 M4). */
  inheritedProtectedPaths?: () => readonly string[];
  /** See {@link TaskOrchestratorDeps.nodeRefusal}. */
  nodeRefusal?: () => string | null;
  /** See {@link TaskOrchestratorDeps.discardChild}. */
  discardChild?: (task: Readonly<Task>) => Promise<void>;
}

/**
 * The pure scheduler. Owns execution state (the {@link RunState},
 * `reviewApproved`, the start hold) and decides which task starts and what
 * follows however its attempt ended; the attempts themselves, from claim to
 * end, and the verifier are {@link Attempts}'. All task-shaped state — the
 * plan tree, the flat index, the completed set — lives in {@link PlanStore},
 * injected at construction. The orchestrator calls `store.markCompleted(id)` /
 * `store.markFailed(id)` instead of mutating task state directly. A task
 * completes only after the runner reports it done through `task_complete` on
 * its attempt's token; process exit without that evidence is a visible failure
 * and does not unblock dependent work.
 */
export class TaskOrchestrator {
  private config: IConfig;
  private notifications: INotification;
  private store: PlanStore;
  /** Every live attempt, from its claim to its end, and how each that ended on its own ended: see {@link settle}. */
  private readonly attempts: Attempts;
  /** Written only through {@link transition}, by the run's events in {@link nextRunState}. */
  private runState: RunState = IDLE_RUN;
  /** Planner turns in flight that new starts wait for (ADR-0029); running attempts carry on. */
  private startHolds = 0;
  /** The judgement a {@link judgingOnce} read shares, while one runs. */
  private judgement: { waits?: Map<string, StartWait[]> } | undefined;
  /** The {@link revertReach} of each revert under way: unlike a hold, it stops a start admitted before the revert too. */
  private readonly reverting = new Set<ReadonlySet<string>>();
  /** Bumped by the user's Stop: a start admitted under an older generation never takes its claim. */
  private stopGeneration = 0;
  /** Starts admitted and not yet claimed or let go; see {@link StartAdmission}. */
  private admissions = 0;
  private reviewApproved = false;
  private autoMergeBlocked = false;
  /** Ticks and attempt ends under way; see {@link deciding}. */
  private decisions = 0;
  /** The run closed with its merge held, which it would otherwise have made itself. */
  private mergeOwedAtClose = false;
  private mergesInFlight = 0;
  /** The run settled while a Merge all was in flight; the tick that merge ends with closes it, so nothing hands over a run that is still merging. */
  private closeOwedToMerge = false;
  /*
   * Retry counts describe a task across attempts, so they deliberately live
   * outside the attempt record: ending an attempt must not forget how often
   * it was retried. Holds live in {@link starts} for the same reason.
   */
  private retryCounts = new Map<string, number>();
  /** A Merge all is under way: no ops task starts until it ends (ADR-0020). */
  private merging = false;
  /** The last "waiting for Merge all" notice, so a run paused at a gate says it once, not on every tick. */
  private gateNotice = '';
  /**
   * The owed-start ledger: each task's hold, the starts owed with no
   * scheduler to make them, and the delegated tasks' checks carried on without one,
   * told what happened to the task rather than edited by hand. Its drain
   * calls back here to judge and claim each; a tick starts what it carries.
   */
  private readonly starts: StartLedger<Admitted> = new StartLedger<Admitted>({
    queued: (id, start) => this.offerQueued(id, start),
    repair: (id, admission) => this.offerRepair(id, admission),
    resume: (id) => this.offerResume(id),
  });
  /** A loop's rounds and the loops carried on with no scheduler (ADR-0045 L5–L7). */
  private readonly loops: LoopRounds;
  /** What was last said of a carried loop's approvals, so it is said once. */
  private loopNotice = '';
  /**
   * Tasks Mark complete is landing after it ended their attempt, or that
   * their conflict resolver is landing, and that landing: in progress with
   * no attempt for as long as it takes, and not orphans for it. Both can be
   * landing one task at once, so each holds it for itself (see {@link holdWhileLanding}).
   */
  private completing = new Map<string, Set<Promise<LandingOutcome>>>();
  /** Tasks {@link releaseTask} is tearing down once their landings have settled: none may begin another. */
  private releasing = new Set<string>();
  /** Tasks paused on a usage limit, the run's hold on them, and each runner's wait for its reset (ADR-0018, U1). */
  private readonly limitPauses: LimitPauses;
  /** What a close waits out past the runners: ticks, attempt ends, and work nothing awaits, a Stop's release of a worktree chiefly. */
  private readonly loose = new Set<Promise<unknown>>();

  /**
   * The plan's isolation run and the open run's lifecycle (ADR-0013); see
   * {@link IsolationRunController}. Read and acted on there directly, except
   * Merge all: that goes through {@link mergeRun}, which keeps it apart from
   * ops tasks and starts the tasks its merge lets through.
   */
  readonly runs: IsolationRunController;
  /** Where a session runs (ADR-0059): every start reserves here in its claim, and opens here after it. */
  private readonly leases: ExecutionBackend;
  /** The tree's slots and usage limits (ADR-0055 D18); a flat run's own. */
  private readonly pool: SlotPool;
  private readonly sessionId: () => string;
  /** A passed attempt's work onto the integration branch, and the conflict repair a landing may need. */
  private landing: Landing;

  private observers: OrchestratorObserver[] = [];
  private runSettings: () => SchedulerRunSettings | undefined;
  private isApproved: (taskId: string) => boolean;
  private mayMergeUnasked: () => boolean;

  constructor(private readonly deps: TaskOrchestratorDeps) {
    const env = deps.attempt;
    this.config = env.config;
    this.notifications = env.notifications;
    this.store = env.store;
    this.runs = env.runs;
    this.leases = env.leases;
    this.pool = deps.pool;
    this.sessionId = deps.sessionId;
    this.landing = env.landing;
    this.runSettings = deps.runSettings;
    this.isApproved = deps.isApproved;
    this.mayMergeUnasked = deps.mayMergeUnasked;
    this.store.checksOf = (task) => checksOf(this.store.allTasks, task, this.checkRules);
    this.loops = new LoopRounds({
      store: this.store,
      atWork: (taskId) => this.attempts.has(taskId),
      scheduling: () => this.isScheduling,
      scheduledRun: () => this.scheduledRun,
      landed: (taskId) => landed(taskId, this.store, this.runs),
      startWaits: (task) => this.startWaits(task),
      roundStarted: (taskId) => this.starts.roundStarted(taskId),
      skip: (taskId, reason) => {
        this.store.markSkipped(taskId, 'loop', reason);
        this.retireResolvers(taskId);
        this.starts.skipped(taskId);
      },
      tell: (message) => this.tell('info', message),
      info: (message) => this.notifications.info(message),
    });
    this.attempts = new Attempts({
      ...env,
      host: {
        settle: (ended) => this.deciding(() => this.settle(ended)),
        completing: (taskId) => this.completing.has(taskId),
        retried: (taskId) => (this.retryCounts.get(taskId) ?? 0) > 0,
        previousRound: (taskId) => this.loops.previousRound(taskId),
        emit: (event, ...args) => this.emit(event, ...args),
        tell: (level, message) => this.tell(level, message),
        unawaited: (work, failure) => this.unawaited(work, failure),
      },
    });
    this.limitPauses = new LimitPauses({
      store: this.store,
      run: {
        hold: () => this.transition({ type: 'hold' }),
        heldFrom: () => heldFrom(this.runState),
        release: () => this.transition({ type: 'release' }),
      },
      tell: (level, message) => this.tell(level, message),
      waitChanged: (wait) => this.emit('onUsageLimitWait', wait),
      changed: () => this.emit('onTaskChanged'),
      unawaited: (work, failure) => this.unawaited(work, failure),
      keepWorktree: (taskId) => this.leases.letGo(taskId, { keep: true, reason: 'usage limit' }),
      settled: (taskId) => this.afterVerdict(taskId),
      resume: (taskId, now) => this.resumeTask(taskId, now),
      limitFound: (runner, at) => deps.limitFound(runner, at),
    });

    this.store.onMutate = () => this.emit('onTaskChanged');
    // What an attempt waits on decides whether a planner turn may pass the limit (ADR-0055 D18).
    this.subscribe({ onTaskSettled: () => this.pool.waitsChanged() });
  }

  /**
   * The composition root: resolves every optional collaborator and wires the
   * isolation listener that the constructor cannot, because it needs the
   * instance's own (private) emit seam. Nothing else in the
   * codebase constructs an orchestrator, so this is the one place defaults
   * live — a host or test supplies what it cares about and gets the rest.
   */
  static compose(options: TaskOrchestratorOptions): TaskOrchestrator {
    const store = options.store ?? new PlanStore();
    const output = options.output ?? new BufferedTaskOutputSource();
    const git = options.isolation ?? createWorktreeIsolation({ config: options.config, ...(options.plannedWith ? { plannedWith: options.plannedWith } : {}), ...(options.execution ? { noHooks: true } : {}) });
    const leased = options.sessionHeld ? leasedIsolation(git, options.sessionHeld) : undefined;
    const isolation = leased ?? git;
    const workspaceRoot = options.workspaceRoot ?? (() => process.cwd());
    // The listener callbacks fire only after construction, so the reference
    // below is settled by the time any of them runs.
    const runs = new IsolationRunController({
      isolation,
      config: options.config,
      notifications: options.notifications,
      workspaceRoot,
      ...(options.stateRoot !== undefined ? { stateRoot: options.stateRoot } : {}),
      listener: {
        changed: (detached) => orchestrator.emit('onIsolationChanged', detached),
        blocked: (repos) => orchestrator.emit('onIsolationBlocked', { reason: 'dirty', repos }),
        handoff: (handoff) => orchestrator.emit('onIsolationHandoff', handoff),
        closed: () => orchestrator.emit('onRunClosed'),
        ended: () => orchestrator.endCarriedLoops(),
        notice: (level, message) => orchestrator.emit('onIsolationNotice', { level, message }),
        resolversEnded: (resolverIds) => { for (const id of resolverIds) orchestrator.retireResolver(id); },
      },
      liveTasks: (): ReadonlySet<string> => orchestrator.liveTaskIds(),
      landedOn: (taskId) => landedOnOf(taskId, store.allTasks),
    });
    const landing = new Landing({ runs, config: options.config, tasks: store, ...(options.plannedWith ? { plannedWith: options.plannedWith } : {}), ...(options.inheritedProtectedPaths ? { inheritedProtectedPaths: options.inheritedProtectedPaths } : {}) });
    const pool = options.pool ?? new SlotPool(() => options.config.maxParallelSessions);
    const node: PoolNode = {
      tick: () => orchestrator.offered(),
      openTurn: () => options.openTurn?.(),
      waitsOnPlanner: (taskId) => orchestrator.waitsOnPlanner(taskId),
      limitFound: (runner, at) => orchestrator.limitFoundElsewhere(runner, at),
    };
    const orchestrator = new TaskOrchestrator({
      attempt: {
        config: options.config,
        notifications: options.notifications,
        runner: options.runner,
        scriptRunner: options.scriptRunner ?? new ScriptRunner(),
        childPlanRunner: options.childPlanRunner ?? NO_CHILD_PLANS,
        store,
        output,
        runs,
        leases: (options.execution ?? ((local) => local))(new LocalWorktreeLease({ pool, node, runs, workspaceRoot }), {
          sessionId: options.sessionId ?? (() => ''),
          treeId: options.treeId ?? options.sessionId ?? (() => ''),
          tell: (level, text) => options.notifications[level](text),
          setupCommand: () => options.config.worktreeSetupCommand,
        }),
        landing,
        registry: options.registry ?? null,
        workspaceRoot,
        workspaceEnv: options.workspaceEnv ?? ((cwd) => resolveWorkspaceEnv(cwd)),
        skillsAt: options.skillsAt ?? ((roots) => new SkillsService(roots)),
        previousAttemptFromLog: options.previousAttemptFromLog ?? (() => null),
        previousHandoffFromLog: options.previousHandoffFromLog ?? (() => undefined),
        lastLoggedAttempt: options.lastLoggedAttempt ?? (() => 0),
        recordHandoff: options.recordHandoff ?? (() => undefined),
        taskLog: options.taskLog ?? { attempts: () => [], events: () => [] },
        autonomous: options.autonomous ?? (() => options.config.autonomousMode),
        ...(options.research ? { research: options.research } : {}),
        ...(options.taskShell ? { taskShell: options.taskShell } : {}),
        ...(options.unsealedRefusal ? { unsealedRefusal: options.unsealedRefusal } : {}),
        ...(options.taskWebFetcher ? { taskWebFetcher: options.taskWebFetcher } : {}),
        ...(options.keepPatch ? { keepPatch: options.keepPatch } : {}),
        ...(options.subtree ? { subtree: options.subtree } : {}),
        ...(options.planNode ? { planNode: options.planNode } : {}),
        ...(options.board ? { board: options.board } : {}),
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.discardChild ? { discardChild: options.discardChild } : {}),
      },
      runSettings: options.runSettings ?? (() => undefined),
      isApproved: options.isApproved ?? (() => true),
      mayMergeUnasked: options.mayMergeUnasked ?? (() => true),
      ...(options.landed ? { landed: options.landed } : {}),
      pool,
      sessionId: options.sessionId ?? (() => ''),
      limitFound: (runner, at) => pool.limitFound(node, runner, at),
      leaveTree: pool.join(node),
      startRefused: options.startRefused ?? ((why) => options.budget?.stop(why)),
      ...(options.decided ? { decided: options.decided } : {}),
      ...(options.nodeRefusal ? { nodeRefusal: options.nodeRefusal } : {}),
      ...(leased ? { runChanges: leased } : {}),
    });
    return orchestrator;
  }

  /** Advisory silence timestamp for a task's live runner, or null if not idle. */
  getIdleSince(taskId: string): string | null {
    return this.attempts.idleSince(taskId);
  }

  /** What a live attempt's runner reported through `task_complete` while it winds down (ADR-0018, L1); null otherwise. */
  getCompletionReceipt(taskId: string): Verdict['reported'] | null {
    return this.attempts.receipt(taskId);
  }

  /** Which spawn of a live attempt's runner waits for Ordewell's tools to connect (ADR-0025); null when none does. */
  getToolsAttaching(taskId: string): 1 | 2 | null {
    return this.attempts.attaching(taskId);
  }

  /** Recent clean output of a task's latest attempt, running or ended; null if it never ran. */
  getLiveOutput(taskId: string, opts: LiveTailOptions): LiveTail | null {
    return this.attempts.liveTail(taskId, opts);
  }

  get storeInstance(): PlanStore { return this.store; }

  approveCheckpoint(taskId: string, note?: string): void {
    this.attempts.approveCheckpoint(taskId, note);
  }

  rejectCheckpoint(taskId: string, reason?: string): void {
    this.attempts.rejectCheckpoint(taskId, reason);
  }

  /** What the task's waiting checkpoint asks, whole; undefined once it settles or when none waits. */
  getCheckpointQuestion(taskId: string): string | undefined {
    return this.attempts.checkpointQuestion(taskId);
  }

  /** Whether the task waits at a checkpoint its live attempt can still answer. */
  awaitsCheckpoint(taskId: string): boolean {
    return this.attempts.awaitsCheckpoint(taskId);
  }

  /** A line from Ordewell to a running task (ADR-0057 R6); false where nothing is running. */
  addressTask(taskId: string, line: string): boolean {
    return this.attempts.address(taskId, line);
  }

  /**
   * Send a structured task a user message (ADR-0018, M1). Mid-turn it queues
   * behind the turn; a task waiting for input takes it at once and is back in
   * progress. Returns the message's id, for {@link removeQueuedTaskMessage}.
   */
  sendTaskMessage(taskId: string, text: string): string {
    return this.attempts.message(taskId, text, 'message', (session, message) => session.sendMessage(message));
  }

  /**
   * Force send (ADR-0023, F1–F3): interrupt the running turn and deliver the
   * message as the next one, ahead of anything queued and with what the person
   * queued glued ahead of it, without the task waiting for input in between. A
   * task already waiting for input just takes it.
   */
  forceSendTaskMessage(taskId: string, text: string): string {
    return this.attempts.message(taskId, text, 'force', (session, message) => session.forceSend(message));
  }

  /**
   * Run the task runner's own command `/name args` (#66) as a turn of its
   * own, waiting behind a running turn as a message would. Ordewell carries
   * it; what it does is the runner's business (#24).
   */
  invokeTaskCommand(taskId: string, name: string, args = ''): string {
    const command = args.trim() ? `/${name} ${args.trim()}` : `/${name}`;
    return this.attempts.message(taskId, command, 'command', (session) => session.invokeCommand(name, args));
  }

  /** Force send a message not yet delivered, queued or handed over, the person's other queued ones glued in with a queued one; false once it was delivered. */
  forceSendQueuedTaskMessage(taskId: string, id: string): boolean {
    return this.attempts.forceSendQueued(taskId, id);
  }

  /** Take back a message still queued behind a turn; false once it was delivered. */
  removeQueuedTaskMessage(taskId: string, id: string): boolean {
    return this.attempts.removeQueued(taskId, id);
  }

  /** Stop a structured task's running turn; it then waits for input like any turn that ends without a `task_complete` call. */
  async interruptTask(taskId: string): Promise<void> {
    await this.attempts.interrupt(taskId);
  }

  /** What is waiting for a structured task's turn to end; empty for any other task. */
  getQueuedTaskMessages(taskId: string): QueuedTaskMessage[] {
    return this.attempts.queued(taskId);
  }

  subscribe(observer: OrchestratorObserver): () => void {
    this.observers.push(observer);
    return () => {
      this.observers = this.observers.filter(o => o !== observer);
    };
  }

  /**
   * Isolated per observer: one that throws must not take down the scheduler
   * or stop the remaining observers from hearing the event.
   */
  private emit(event: keyof OrchestratorObserver, ...args: unknown[]): void {
    for (const o of this.observers) {
      const fn = o[event] as (...args: unknown[]) => void;
      if (!fn) continue;
      try {
        fn(...args);
      } catch (err) {
        console.error(`[TaskOrchestrator] observer threw from ${event}:`, err);
      }
    }
  }

  get isRunning(): boolean {
    return this.isScheduling || this.attempts.size > 0 || this.carriedOn().length > 0;
  }
  /**
   * A runner is executing *right now*. Narrower than {@link isRunning}, which
   * also covers the armed-but-idle scheduler `tick()` deliberately leaves
   * behind when a plan is paused on a user task, a checkpoint or a hold —
   * nothing is executing then, so nothing is reading the plan mid-mutation.
   */
  get hasLiveWork(): boolean {
    return this.attempts.size > 0;
  }
  get isReviewApproved(): boolean { return this.reviewApproved; }
  /** The scheduler is driving the plan: ready tasks start on their own as slots free. Narrower than {@link isRunning}. */
  get isScheduling(): boolean { return this.runState.kind === 'scheduling'; }
  /** A scheduled run, driving the plan or held by a usage limit that gives it back: a hold never closes one. */
  get scheduledRun(): boolean { return this.isScheduling || heldFrom(this.runState) === 'scheduling'; }
  /** A usage limit holds the run, whatever it goes back to at the reset. */
  get runHeld(): boolean { return this.runState.kind === 'held'; }
  /**
   * A full-plan run with nothing starting that something still resumes: a
   * usage limit's reset, or a retry of a failed task its blocked tasks wait on.
   */
  get awaitsResume(): boolean { return this.runState.kind === 'held' || this.runState.kind === 'endedOnFailure'; }
  get status(): 'approved' | 'running' | 'completed' {
    if (this.runState.kind === 'scheduling') return 'running';
    return this.runState.kind === 'finished' ? 'completed' : 'approved';
  }
  get activeTaskIds(): string[] { return [...this.activeSessionMap.keys()]; }
  /** Task id → session id of every attempt whose runner is up; a spawn in flight has no session yet. */
  get activeSessionMap(): Map<string, string> {
    return this.attempts.sessionMap();
  }

  getAttempt(taskId: string): TaskAttemptSnapshot | undefined {
    return this.attempts.snapshot(taskId);
  }

  /** The number of the task's latest attempt, live or ended; 0 before any ran. */
  latestAttempt(task: Readonly<Task>): number {
    return this.attempts.latestAttempt(task);
  }

  /** A planner turn holds new starts: what is ready starts when it releases them. */
  get startsHeld(): boolean { return this.startHolds > 0; }

  /**
   * Hold the scheduler's new starts while a planner turn decides what runs
   * next, so its edits do not race a task that would otherwise start under
   * it. Running attempts are untouched. The release is idempotent and starts
   * nothing itself: whoever releases ticks, which starts what became ready.
   */
  holdStarts(): () => void {
    this.startHolds++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.startHolds--;
    };
  }

  /**
   * Admit a start that will wait before it claims — on the user's answer, or
   * the run opening. Until it is released, Stop counts it as live
   * work; once a Stop comes it is no longer current, and its claim is refused.
   */
  admitStart(): StartAdmission {
    const { current } = this.admittedNow();
    let held = true;
    this.admissions++;
    return {
      current,
      release: () => {
        if (!held) return;
        held = false;
        this.admissions--;
        // The window a surface drew as "starting" is over. A claimed start has
        // an attempt and is announced by its tick; one let go with nothing live
        // (declined, cancelled, refused after asking) otherwise leaves the
        // last status update saying work is still on its way.
        if (this.admissions === 0 && this.attempts.size === 0) this.emit('onTaskChanged');
      },
    };
  }

  /**
   * Something can still start that nobody has to ask for again: a start
   * admitted and not yet claimed, a force start queued behind its
   * dependencies, a conflict repair owed a slot or the end of a start hold,
   * a task that resumes on its own at its usage limit's reset, a start a
   * dirty checkout parked for Stash and continue to replay, or a loop or a
   * delegated task's check carried on with no scheduler. A Stop is owed to it,
   * whether or not anything runs.
   * A carried loop a body task stopped starts nothing, so it is not here: see
   * {@link loopCarried}.
   */
  get startsPending(): boolean {
    return this.admissions > 0 || this.starts.pendingUnasked() || this.runs.blocked || this.store.allTasks.some(waitsForReset) || this.carriedOn().length > 0;
  }

  /**
   * A loop is carried on, one a body task stopped included. Nothing of that
   * one starts by itself, so nothing here moves a task on, but a retry that
   * passes would resume it: a Stop is owed to it too (ADR-0045 L7).
   */
  get loopCarried(): boolean {
    return this.loops.anyCarried;
  }

  /**
   * The plan's activity as one word for every surface: a start on its way,
   * work running, a scheduler driving the plan, or a run that resumes by
   * itself. `starting` is the async window between a start being admitted and
   * its first claim — the window a surface must not draw as execution and a
   * manual override must not race. `advancesOnItsOwn` is the override guard's
   * own predicate, so a surface asks only what the seam would accept.
   */
  get activity(): RunActivity {
    return {
      starting: this.admissions > 0 && this.attempts.size === 0,
      running: this.attempts.size > 0,
      scheduled: this.isScheduling,
      resumable: this.awaitsResume,
      advancesOnItsOwn: this.advancesOnItsOwn,
    };
  }

  /**
   * Whether anything could still move a task on without being asked: a start
   * on its way, an attempt in any phase (starting, running, integrating), a
   * scheduler driving the plan, a usage-limit hold or a scheduled resume. What
   * a manual override of an AI or script task must not race (ADR-0029). A run
   * that ended on a failure is not here: nothing advances until a retry or
   * skip, so overriding the failed task is the way out.
   */
  get advancesOnItsOwn(): boolean {
    return this.startsPending || this.attempts.size > 0 || this.isScheduling || this.runState.kind === 'held';
  }

  /** A start admitted now that nothing has to count as live work: one that claims before it awaits, or follows on from one that did. */
  admittedNow(): Admitted {
    const generation = this.stopGeneration;
    return { current: () => generation === this.stopGeneration };
  }

  /** The user's Stop found nothing to stop: it still withdraws every start admitted before it, one no live work counts included (ADR-0029). */
  stopAsked(): void {
    this.stopGeneration++;
  }

  /** Run `work`, which awaits before it claims, under an admission it holds throughout and claims under. */
  private async whileAdmitted<T>(work: (admission: StartAdmission) => Promise<T>): Promise<T> {
    const admission = this.admitStart();
    try {
      return await work(admission);
    } finally {
      admission.release();
    }
  }

  /**
   * "Merge all"; a settled run that merged everything is cleared up and
   * forgotten. During a run it merges what has landed and the run goes on:
   * the tasks waiting at a merge gate for that work then start (ADR-0020).
   * Never alongside ops work, either way round ({@link mergeExcludes}), but
   * for `besideOps`: the user's yes to merging beside the ops tasks running
   * now, which no automatic merge and no model can give. No ops task starts
   * while it merges, either way.
   */
  async mergeRun(options: { besideOps?: boolean } = {}): Promise<IsolationMergeResult> {
    return this.mergeLanded(undefined, options.besideOps === true);
  }

  /** The tasks whose live attempts work in the user's checkout, which hold every Merge all but the one the user confirms (ADR-0020). */
  get opsInCheckout(): readonly Task[] {
    return this.attempts.excludingMergeAll().flatMap((id) => this.store.get(id) ?? []);
  }

  private async mergeLanded(trigger?: AutoMergeTrigger, besideOps = false): Promise<IsolationMergeResult> {
    const excluded = besideOps && !trigger ? undefined : this.attempts.excludingMerge();
    if (excluded) {
      const title = this.store.get(excluded)?.title ?? excluded;
      throw new TaskControlError(`Ops task "${title}" is running in your checkout: Merge all once it has finished.`);
    }
    this.mergesInFlight++;
    this.merging = true;
    let result: IsolationMergeResult;
    let lease: ReservedLease | undefined;
    let refused: { error: unknown } | undefined;
    try {
      // An automatic merge passes here as Merge all does: it reaches a checkout, and no claim would ever see it (ADR-0059 L1).
      const reserved = this.leases.reserve(this.leaseRequest('merge'));
      if ('refused' in reserved) throw new TaskControlError(reserved.refused);
      lease = reserved.lease;
      result = await this.runs.merge();
    } catch (err) {
      if (!trigger) refused = { error: err };
      result = { outcome: 'failed', repo: SELF_REPO };
      if (trigger) this.tell('error', `Automatic Merge all could not finish: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      lease?.release('merged');
      this.merging = --this.mergesInFlight > 0;
    }
    if (refused) {
      // No tick follows a merge that threw, and one that settled the run in the meantime still owes it its close.
      if (this.closeOwedToMerge && !this.merging) await this.tick();
      throw refused.error;
    }
    if (!trigger && result.outcome === 'merged') this.autoMergeBlocked = false;
    if (trigger) {
      this.autoMergeBlocked = result.outcome !== 'merged';
      this.emit('onAutoMerge', { trigger, result });
      if (this.autoMergeBlocked) {
        this.tell('warn', trigger.kind === 'gate'
          ? `Automatic Merge all for task ${this.store.get(trigger.taskId)?.order ?? trigger.taskId} stopped. The merge gate is waiting for you.`
          : 'Automatic Merge all at the end of the run stopped. The run is handed over to you to merge.');
      }
    }
    // The run's end closes the run itself, straight after.
    if (trigger?.kind !== 'run_end') await this.tick();
    return result;
  }

  /**
   * Close the settled run. With merge at gates automatically on, landed work
   * not merged yet is merged first, through the gate's path, so no surface
   * hears of a handoff for a run about to merge; one that stopped is handed
   * over as before.
   */
  private async closeRun(): Promise<void> {
    if (this.merging) {
      this.closeOwedToMerge = true;
      return;
    }
    this.closeOwedToMerge = false;
    this.mergeOwedAtClose = false;
    if (this.mergesAtClose) await this.mergeLanded({ kind: 'run_end' });
    else this.mergeOwedAtClose = this.mergesAutomatically() && !this.autoMergeBlocked && this.mergeHold.length > 0;
    await this.runs.close();
  }

  /** A hold is no merge that stopped (ADR-0055 D9): the tick after its check's pass or Skip merges, the run closed or not. */
  private async mergeOwedAfterHold(): Promise<void> {
    if (!this.mergesAtGates || this.merging || !this.settled || this.runMergeView() === null) return;
    this.mergeOwedAtClose = false;
    await this.mergeLanded({ kind: 'run_end' });
  }

  /**
   * Whether closing the run merges what landed, with nobody asked. The run
   * says it has ended before it closes, and a list read in between must not
   * name a Merge all it is about to do itself (ADR-0053). A Stop takes the run
   * out of isolating and a merge that stopped blocks this, so neither wait is hidden.
   */
  get mergesAtClose(): boolean {
    return this.mergesAtGates && !this.merging && this.settled && this.runs.isolating
      && this.runMergeView() !== null && this.attempts.excludingMerge() === undefined;
  }

  /**
   * The run as a surface offers Merge all mid-run (ADR-0020): what has landed
   * and is not merged, and whether the run is paused at its gates with nothing
   * else running. Null once everything landed is merged.
   */
  runMergeView(): RunMergeView | null {
    const handoff = this.runs.view()?.handoff;
    if (!handoff?.landed.length) return null;
    const waitingAtGate = this.judgingOnce(() => this.store.allTasks.some((t) => this.getMergeGate(t.id).length > 0));
    return { waitingAtGate, paused: waitingAtGate && this.startsOnTick && this.attempts.size === 0, repos: handoff.repos, landed: handoff.landed };
  }

  /**
   * The ancestors an ops or user task waits on at its merge gate: those whose
   * landed work is not in the user's branch yet (ADR-0020). Empty for every
   * other task. Judged whatever the task's status but `completed` — a retry of
   * a failed ops task acts on the checkout as a first start does — so a start
   * the user is about to confirm is told what it would act without.
   */
  getMergeGate(taskId: string): string[] {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed') return [];
    return waitOf(this.startWaits(task), 'merge-gate')?.unmerged ?? [];
  }

  /** Why a task is held out of auto-scheduling, as the surfaces show it; null when it is not held. */
  holdReason(taskId: string): string | null {
    return this.starts.holdReason(taskId);
  }

  /**
   * Every reason a task cannot start now, from the one start rule
   * (ADR-0034); none when it can. `forced` judges a start the user forced.
   * Takes the task, not its id: the one the command seam located.
   */
  startWaits(task: Readonly<Task>, forced?: ForcedStart): StartWait[] {
    const judged = forced || !this.judgement ? undefined : this.planStartWaits().get(task.id);
    return judged ?? startWaits(task, this.startRule(), forced);
  }

  /** Every task's {@link startWaits}, the plan judged once. */
  planStartWaits(): Map<string, StartWait[]> {
    if (!this.judgement) return planStartWaits(this.startRule());
    return (this.judgement.waits ??= planStartWaits(this.startRule()));
  }

  /**
   * Run `read`, a synchronous read of the plan, on one judgement of it: what a
   * read asks task by task would otherwise judge the whole plan per task.
   * Nothing can change the plan inside it, so no answer can be stale.
   */
  judgingOnce<T>(read: () => T): T {
    if (this.judgement) return read();
    this.judgement = {};
    try {
      return read();
    } finally {
      this.judgement = undefined;
    }
  }

  private startRule(): StartRuleInput {
    return {
      store: this.store,
      onHold: this.starts.holds,
      approved: this.isApproved,
      runs: this.runs,
      merging: this.merging,
      startsHeld: this.startHolds > 0,
      completing: this.completing,
      queued: this.starts.queued,
      conflictResolver: (taskId) => this.landing.liveResolvers(taskId)[0]?.id,
      ...(this.pool.shared ? { treeLimited: this.pool.limited() } : {}),
      liveCheck: (task) => this.liveCheck(task)?.id,
    };
  }

  /** What tells a check, which reads the runners' modes as an attempt's kind does (ADR-0031). */
  private get checkRules(): Pick<DelegationRules, 'runnerModes'> {
    const { registry } = this.deps.attempt;
    if (!registry) return {};
    return { runnerModes: Object.fromEntries(this.store.allTasks.map((t) => [t.assignedRunner, registry.get(t.assignedRunner)?.manifest.modes])) };
  }

  private liveCheck(task: Readonly<Task>): Readonly<Task> | undefined {
    return task.type === 'delegated' ? this.store.checksOf(task).find((check) => this.attempts.has(check.id)) : undefined;
  }

  /** A retry takes the task's checks back, and a live one cannot be (ADR-0055 D8). */
  private refuseBesideLiveCheck(taskId: string): void {
    const task = this.store.get(taskId);
    const check = task && this.liveCheck(task);
    if (check) throw new TaskControlError(`Task "${check.title}" is checking the work of task "${task.title}", and a new attempt takes that back: stop it first, or let it finish.`);
  }

  /** What holds every merge but the user's (ADR-0055 D9), named as a refusal names it. */
  get mergeHold(): readonly Task[] {
    if (!this.store.allTasks.some((t) => t.type === 'delegated')) return [];
    return checksHoldingMerge(this.store.allTasks, (id) => this.runs.awaitsMerge(id), this.checkRules);
  }

  /**
   * Why no resolver may be added to this task's conflict now, or null: a
   * conflict has one worker (ADR-0015), so a repair or a resolver that has it
   * keeps it. The words are for whoever asked, since a surface may still offer
   * the action from a status update it has not yet replaced.
   */
  resolverRefusal(taskId: string): string | null {
    const task = this.store.get(taskId);
    if (!task) return null;
    const record = this.runs.current?.tasks[taskId]?.status;
    // Claimed, an attempt already has the conflict: the record reads `conflict` until its prepare reopens it.
    if (record === 'repairing' || (record === 'conflict' && this.attempts.has(taskId))) return `Task "${task.title}" is repairing its conflict: stop it, then add a resolver if its conflict still waits.`;
    if (this.owesRepair(task)) return `Task "${task.title}" waits to repair its conflict. Stop it to withdraw the repair, then add a resolver.`;
    const [resolver] = this.landing.liveResolvers(taskId);
    if (resolver) return `Task "${resolver.title}" already resolves the conflict of task "${task.title}". Skip or remove it to add another.`;
    return null;
  }

  /** Whether {@link resolverRefusal} and the record both let a resolver be added: the one test an offer of it and its acceptance share. */
  canResolveConflict(taskId: string): boolean {
    return this.runs.current?.tasks[taskId]?.status === 'conflict' && this.resolverRefusal(taskId) === null;
  }

  /** What the conflict repair this task is owed waits for; null when no repair will start by itself. */
  repairWait(taskId: string): RepairWait | null {
    const task = this.store.get(taskId);
    if (!task || !this.owesRepair(task)) return null;
    if (this.startHolds > 0) return 'planner';
    return this.onUsageLimit(task) ? 'usage-limit' : 'slot';
  }

  /** A usage limit keeps this task from starting by itself: the hold on the run, or its own runner's limit with no reset to wait for. */
  private onUsageLimit(task: Readonly<Task>): boolean {
    return this.runState.kind === 'held' || !!waitOf(this.startWaits(task), 'usage-limit');
  }

  /** Where a task's isolated work stands, and who has its conflict: the record says the first, the scheduler the second. */
  taskIsolation(taskId: string): TaskIsolation | null {
    const isolation = this.runs.taskIsolation(taskId);
    return isolation && this.withConflictWorker(taskId, isolation);
  }

  /** Each task's isolation mark and the run's handoff, as {@link taskIsolation} reads them. */
  isolationView(): IsolationView | null {
    const view = this.runs.view();
    if (!view) return null;
    return { ...view, tasks: Object.fromEntries(Object.entries(view.tasks).map(([id, isolation]) => [id, this.withConflictWorker(id, isolation)])) };
  }

  private withConflictWorker(taskId: string, isolation: TaskIsolation): TaskIsolation {
    if (isolation.state !== 'conflict') return isolation;
    const waits = this.repairWait(taskId);
    const [resolver] = this.landing.liveResolvers(taskId);
    return { ...isolation, ...(waits ? { repairWaits: waits } : {}), ...(resolver ? { resolver: resolver.id } : {}) };
  }

  /**
   * A repair will start by itself: the task is not started, it has one left,
   * and something will claim it, the scheduler or the owed-start ledger. Nothing
   * saves this: a reload or a Stop leaves the conflict waiting on the user.
   */
  private owesRepair(task: Readonly<Task>): boolean {
    if ((task.status !== 'pending' && task.status !== 'approved') || this.starts.holds.has(task.id) || !this.landing.nextRepair(task.id)) return false;
    return this.starts.owesRepair(task.id) || this.scheduledRun;
  }

  /** The failed tasks a task not started yet waits on, through its dependencies (ADR-0034); empty when it is not blocked. */
  getBlockedBy(taskId: string): string[] {
    return blockingFailures(this.store.planTasks).get(taskId) ?? [];
  }

  /** Throws what {@link loadPlan} would, for a caller with work of its own to do before it loads. */
  assertLoadable(tasks: readonly Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS]): void {
    assertAssignedRunners(tasks, planRunners);
  }

  /**
   * `edited`: the plan is the last one edited, not a new one. Only a Stop
   * withdraws a queued start (ADR-0035), so one of a task the edit keeps
   * stays queued: a script task waiting at its merge gate still starts at
   * Merge all.
   */
  loadPlan(tasks: readonly Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS], edited = false): void {
    this.load(tasks, planRunners, { edited, keepsHolds: edited });
  }

  /** `keepsHolds`: the plan edited, or begun again, keeps the holds someone chose (see {@link StartLedger.planLoaded}). */
  private load(tasks: readonly Task[], planRunners: RunnerId[], { edited, keepsHolds }: { edited: boolean; keepsHolds: boolean }): void {
    // Refused before the plan being replaced is ended: a throw past that
    // would leave its run scheduling over a plan half loaded.
    this.assertLoadable(tasks, planRunners);
    // Ended before the plan is swapped, so nothing of the plan being replaced reaches the next one.
    const repairs = this.attempts.unload().filter((a) => a.kind.kind === 'repair' && a.worktree);
    this.store.load(tasks, planRunners);
    for (const a of repairs) this.unawaited(this.leases.letGo(a.taskId, { keep: true, landing: a.integration, reason: 'stopped' }), `Could not keep the worktree of task "${this.store.get(a.taskId)?.title ?? a.taskId}"`);
    // A plan committed while the scheduler runs keeps that run, and its mode
    // with it; otherwise the next start decides afresh.
    this.runs.interrupt({ keepOpen: this.isScheduling });
    // A held or ended run goes with the plan it was in; a plan loaded from
    // disk holds no run either, so at a reset only its paused tasks resume,
    // as after any restart.
    this.transition({ type: 'load' });
    this.reviewApproved = false;
    this.retryCounts.clear();
    this.loops.planLoaded(edited);
    this.starts.planLoaded({ has: (id) => !!this.store.get(id) }, { keepsChosen: keepsHolds, edited });
    // Saved on the task, so another process does not run what the user took back (ADR-0054).
    for (const t of this.store.allTasks) if (t.reverted) this.starts.hold(t.id, REVERTED_HOLD, 'chosen');
    this.recoverOrphans();
    // Whatever the plan left behind for a slot, the ledger dropped: a resume past its time is armed again here.
    this.limitPauses.rearm();
  }

  /**
   * Adopt a planner's edit, or its whole-plan commit. With a run at work, or
   * one that awaits a resume (ADR-0034), it is reconciled into that run: a
   * reload would clear the holds and the review approval, so a task the user
   * cancelled would be re-armed by the tick that follows, and a retry after
   * the edit would run the failed task alone, its failure lost. Otherwise it
   * is the plan the next run starts from, with a failed task still failed and
   * what waits on the user still waiting: an edit between runs is not the user
   * starting over.
   */
  adoptEdit(tasks: readonly Task[], planRunners: RunnerId[]): void {
    if (this.admissions > 0 || this.isRunning || this.awaitsResume || this.starts.owesRepairs) return this.reconcilePlan(tasks, planRunners);
    const before = this.store.planTasks;
    this.loadPlan(tasks, planRunners, true);
    this.store.resetForRun({ edited: true });
    this.retireResolversLeft(before);
    this.retireChildrenLeft(before);
  }

  /**
   * Adopt an edited plan without letting go of the run in progress. Everything
   * the scheduler owns — live attempts, holds, retry counts and the review
   * approval — survives, because `loadPlan` clears all of it and a
   * mid-run edit is not a new run. Only the tasks change.
   *
   * The ids with live sessions are defended: one dropped from the edited plan is
   * carried over (its verdict still has to land somewhere), and one whose status
   * the snapshot predates is put back to `in_progress`, or to the checkpoint or
   * input it waits at — adopting the snapshot's "pending" would offer the
   * scheduler work a runner is already doing.
   *
   * A failed task stays failed: an edit is not a retry, and the tasks it blocks
   * wait for that retry (ADR-0034). One the edit made manual has no retry to wait for.
   */
  reconcilePlan(newTasks: readonly Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS]): void {
    const before = this.store.planTasks;
    const adopted = [...newTasks];
    for (const taskId of this.attempts.taskIds()) {
      const task = this.store.get(taskId);
      if (!task) continue;

      const at = adopted.findIndex((t) => t.id === taskId);
      if (at < 0) {
        adopted.push({ ...task });
        continue;
      }
      // The snapshot may predate waits this attempt has ended since (ADR-0053).
      adopted[at] = { ...adopted[at], waitsEnded: task.waitsEnded };
      if (waitsMidAttempt(task)) {
        // The question the runner asked is still open: the snapshot's status
        // would hide it, and the supervisor already settled the task on it.
        adopted[at] = { ...adopted[at], status: task.status, awaitingReason: task.awaitingReason };
      } else if (adopted[at].status !== 'in_progress') {
        console.warn(`[TaskOrchestrator] Running task "${task.title}" status changed to "${adopted[at].status}" in modified plan, using orchestrator truth`);
        adopted[at] = { ...adopted[at], status: 'in_progress' };
      }
    }

    this.store.load(adopted, planRunners);
    this.planEdited(before);
  }

  /**
   * An edit landed on the plan — a planner's task ops through
   * {@link reconcilePlan}, or the user's direct edit through the PlanEditor.
   * A task it made manual is the manual task it now is (ADR-0053), a runner
   * still at a question apart. One that leaves a loop's check out of rounds
   * ends the loop (ADR-0045 L6): what of its body has not run will not run,
   * and, while the run is under way, the check settles once more so the
   * supervisor hears the end. Nothing else notices such an edit: the check
   * settled when it failed a round, and no round will run it again.
   */
  planEdited(before: readonly Task[]): void {
    this.store.releaseMadeManual((id) => this.attempts.has(id));
    this.retireResolversLeft(before);
    this.retireChildrenLeft(before);
    for (const checkId of this.loops.planEdited(before)) {
      // Outside a run there is no supervisor to settle it for, and the next
      // run starts a failed check's rounds over; the close still stands.
      if (this.isRunning) this.emit('onTaskSettled', { taskId: checkId });
    }
    // An edit may have taken the last task waiting on a reset out of the plan, or ended its pause.
    this.limitPauses.recount();
  }

  /**
   * Begin the full-plan run afresh, as Execute does with no open run to join.
   * Whatever an earlier run left goes: its state, which {@link start} would
   * take as a run already under way; its scheduled resumes and execution log;
   * and, as the plan is loaded over
   * itself, its retry counts, holds but those someone chose, loop rounds and review approval. Every
   * task not done is ready to run again, and the scheduler starts it; a plan
   * with nothing left to run ends at once, and the scheduler says so, but for
   * `keepFailed`: failures nobody asked this run to try again (ADR-0030).
   */
  async beginRun(origin: RunOrigin, keepFailed?: ReadonlySet<string>): Promise<void> {
    this.stop('restart');
    this.store.clearLog();
    this.store.resetForRun({ keepFailed: new Set([...(keepFailed ?? []), ...this.starts.keptChildren]) });
    this.load(this.store.planTasks, [...this.store.planRunners], { edited: false, keepsHolds: true });
    await this.approveReview(origin);
  }

  /**
   * A Continue from above reached this node (ADR-0055 D17): the run about to
   * begin is Execute's, but a Continue never discards a child, at any depth. So
   * each delegated task with a child to reopen is claimed as a continue when
   * the scheduler reaches it, its dependencies and approval as for any task,
   * and one whose child cannot be reopened is held rather than started fresh.
   * Answers what was held and why, for its subplanner to decide.
   */
  owesChildren(message: string): string[] {
    const held: string[] = [];
    for (const task of this.store.allTasks) {
      if (task.type !== 'delegated' || task.status === 'completed' || task.status === 'skipped' || this.attempts.has(task.id)) continue;
      const reopens = continuability(task);
      if (reopens.ok) this.starts.oweReopen(task.id, { message: reopenMessage(task, message), resumeSessionId: reopens.sessionId });
      else if (task.runnerSessionId) {
        this.starts.keepChild(task.id, reopens.reason);
        held.push(reopens.reason);
      }
    }
    return held;
  }

  /**
   * Take the plan into the run under way (#95), whose tasks were approved
   * first: a scheduled run starts them as their dependencies finish, and one
   * the scheduler was not driving — tasks started on their own — becomes the
   * plan's run, as Execute would make it. A hold starts nothing either way:
   * the plan's run is what its reset gives back (ADR-0018 U1). A start a dirty
   * checkout parked in a scheduled run is replayed, which reads the checkout
   * again; a new run would take back the run's failures (ADR-0053).
   */
  async joinRun(origin: RunOrigin): Promise<void> {
    if (this.isScheduling) {
      await this.continueBlockedRun('reread');
      return this.tick();
    }
    if (!this.reviewApproved) return this.approveReview(origin);
    if (this.runHeld) return this.joinHold();
    return this.start(origin);
  }

  private joinHold(): void {
    this.transition({ type: 'join' });
    this.emit('onTaskChanged');
  }

  /**
   * The user's Execute takes in work the scheduler was not driving: it becomes
   * the plan's run, so what failed gets the fresh chance Execute gives
   * (ADR-0053). A scheduled run keeps its failures, which a retry continues
   * (ADR-0034), and Execute only approves what waits in it: a hold that gives
   * one back is that run still.
   */
  readyFailed(): void {
    if (!this.scheduledRun) this.store.readyFailed((id) => this.attempts.has(id));
  }

  /** Start the full-plan run, or continue one that is held or ended on a failure. */
  async start(origin: RunOrigin = 'user'): Promise<void> {
    if (this.runs.blocked) return;
    if (this.isScheduling) {
      console.error('[TaskOrchestrator] start() called but already running: no-op');
      return;
    }
    if (!this.reviewApproved) {
      console.log('[TaskOrchestrator] start() blocked: plan review not yet approved. Emitting onReviewNeeded.');
      this.emit('onReviewNeeded', { tasks: this.store.planTasks, planRunners: this.store.planRunners });
      return;
    }
    this.openRun(origin);
    console.log(`[TaskOrchestrator] Starting with ${this.store.allTasks.length} tasks (${this.store.allTasks.filter(t => t.type === 'ai' && t.prompt).length} AI ready)`);
    this.transition({ type: 'schedule' });
    this.emit('onTaskChanged');
    await this.tick();
  }

  /**
   * Stop the run. The user's Stop also withdraws every start admitted before
   * it and not yet claimed (ADR-0029); a `restart` only disarms an idle
   * scheduler for the run about to start, which must not undo starts asked
   * for meanwhile.
   */
  stop(reason: 'user' | 'restart' = 'user'): void {
    if (reason === 'user') this.stopAsked();
    this.transition({ type: 'stop' });
    // Interrupted work is kept like a failed attempt's: inspectable, and off
    // `active` so a crash-recovery prune does not sweep it away. A stopped
    // repair did not land, so its task waits on the user as its conflict did;
    // every other stopped task is back to not started, as a cancel leaves it.
    // Left in progress, it would read as running with nothing behind it — and
    // its kept worktree as work a finished run could clear up.
    const stopped: EndedAttempt[] = [];
    for (const a of this.attempts.stopAll()) {
      if (a.kind.kind === 'repair') this.store.markAwaitingUser(a.taskId, 'conflict');
      else if (this.store.get(a.taskId)) {
        this.store.markPending(a.taskId);
        stopped.push(a);
      }
      if (a.worktree) this.unawaited(this.leases.letGo(a.taskId, { keep: true, landing: a.integration, reason: 'stopped' }), `Could not keep the worktree of task "${this.store.get(a.taskId)?.title ?? a.taskId}"`);
    }
    this.runs.interrupt();
    this.starts.stopped(reason);
    this.loops.runEnded();
    this.withdrawRepairs();
    this.loopNotice = '';
    if (reason === 'user') this.reholdReverted();
    this.limitPauses.cancelAll();
    this.sayStopped(stopped);
    this.recoverOrphans();
    this.emit('onTaskChanged');
  }

  /**
   * Nothing claims a repair once the run has stopped, so what was owed one is
   * a conflict waiting on the user, listed with its options, not a task that
   * reads as never started.
   */
  private withdrawRepairs(): void {
    for (const t of this.store.allTasks) {
      if ((t.status === 'pending' || t.status === 'approved') && this.runs.current?.tasks[t.id]?.status === 'conflict') this.store.markAwaitingUser(t.id, 'conflict');
    }
  }

  /**
   * A force start behind a dependency lifted a reverted task's hold for that
   * start alone, in the queue or left to the scheduler. With the start
   * withdrawn by the user's Stop, the task stays what the user took back (ADR-0054).
   */
  private reholdReverted(): void {
    for (const t of this.store.allTasks) if (t.reverted) this.starts.hold(t.id, REVERTED_HOLD, 'chosen');
  }

  /** Name the tasks a stop took down, so none is mistaken for one still at work. */
  private sayStopped(stopped: readonly EndedAttempt[]): void {
    if (stopped.length === 0) return;
    const one = stopped.length === 1;
    const named = quotedList(stopped.map((a) => this.store.get(a.taskId)?.title ?? a.taskId));
    const delegated = stopped.every((a) => this.store.get(a.taskId)?.type === 'delegated');
    const kept = delegated
      ? ` Continue keeps what ${one ? 'its child' : 'their children'} landed; anything else that starts ${one ? 'it' : 'them'} starts over with a new child.`
      : stopped.some((a) => a.worktree)
        ? ` What ${one ? 'it' : 'they'} did is kept in ${one ? 'its worktree' : 'their worktrees'}: Mark complete lands it; Retry starts over and keeps it on a branch.`
        : '';
    this.tell('info', `Stopped ${named}: back to not started.${kept}`);
  }

  /**
   * A task in progress with no attempt has nothing running it: a stop, a plan
   * load or anything else that ended its attempt left its status behind. It
   * is put back to not started, and said, so it can be retried rather than
   * read as running — or, in an isolated run, count as live work forever.
   */
  private recoverOrphans(): void {
    const orphans = this.store.allTasks.filter((t) => t.type !== 'user' && t.status === 'in_progress' && !this.attempts.has(t.id) && !this.completing.has(t.id));
    if (orphans.length === 0) return;
    for (const t of orphans) this.store.markPending(t.id);
    const one = orphans.length === 1;
    const titles = quotedList(orphans.map((t) => t.title));
    this.tell('warn', `${one ? 'Task' : 'Tasks'} ${titles} ${one ? 'was' : 'were'} shown as running, but nothing was running ${one ? 'it' : 'them'}: back to not started. Retry or force-start ${one ? 'it' : 'them'}; a worktree ${one ? 'it' : 'they'} had is kept.`);
    this.emit('onTaskChanged');
  }

  /**
   * Task ids still live, whose worktrees no clean-up of the whole run may
   * take: an attempt is running them, or the plan has them in progress or
   * waiting on the user mid-attempt — at a checkpoint, or for input. One
   * waiting on the user's decision instead (a conflict, a usage limit, files
   * an ops task changed) is not: no runner is at work on it, and a clean-up
   * keeps what it holds on a branch before its worktree goes.
   */
  private liveTaskIds(): Set<string> {
    const live = new Set(this.attempts.taskIds());
    for (const t of this.store.allTasks) {
      if (t.status === 'in_progress' || waitsMidAttempt(t)) live.add(t.id);
    }
    return live;
  }

  /**
   * Whether the run may close with its handoff: no task is live. A handoff
   * tells the user the run has finished, and a Merge all after it clears the
   * run up, so neither may happen under a task the plan still shows at work.
   */
  private get settled(): boolean {
    return this.liveTaskIds().size === 0;
  }

  /**
   * Apply how an attempt ended on its own ({@link AttemptEnded}): the one
   * place the scheduler takes every way out of {@link Attempts}, as
   * {@link applyLanding} takes a landing's. Each marks the task, says why,
   * and settles the run or ticks.
   */
  private async settle(ended: AttemptEnded): Promise<void> {
    switch (ended.kind) {
      case 'usage-limited':
        // A pause is no verdict, however the limit arrived (ADR-0018, U1).
        return this.limitPauses.pause(ended.taskId, ended.attempt, ended.said, ended.output);
      case 'spawn-failed':
        return this.settleSpawnFailure(ended);
      case 'unsettled':
        return this.settleUnsettled(ended);
      case 'repaired': {
        const { task, verdict } = ended;
        // A repair that does not land leaves the task waiting on the user —
        // never a failed task, so never one that blocks its dependents.
        await this.applyLanding(task, ended.landing, ended.attempt.admission, () => this.logAndArchive(task, task.verdict ?? verdict));
        break;
      }
      case 'passed': {
        const { task } = ended;
        await this.applyLanding(task, ended.landing, ended.attempt.admission, () => this.notifications.info(`Task "${task.title}" completed.`));
        this.logAndArchive(task, ended.verdict);
        break;
      }
      case 'files-changed':
        // Nothing is committed, and nothing fails.
        this.store.markAwaitingUser(ended.task.id, 'files-changed');
        this.tell('warn', `Ops task "${ended.task.title}" finished, but changed tracked files in your checkout: ${capConflictFiles(ended.files)}. An ops task must not change repository files, so nothing was committed: look at the changes, then mark it complete or retry it.`);
        this.logAndArchive(ended.task, ended.verdict);
        break;
      case 'failed': {
        const { task, verdict } = ended;
        // Missing completion evidence is a hard boundary for what depends on
        // this task: its dependents are blocked until a retry passes
        // (ADR-0034). Independent work keeps starting. A loop's check that
        // starts a round instead is no failure yet (ADR-0045 L3).
        this.store.markFailed(task.id);
        // A runner that stopped on its login is told as the way back in (ADR-0052).
        // With no scheduler the loop is carried on, unless a Stop since it was claimed ended it.
        if (!this.loops.checkFailed(task.id, !this.isScheduling && ended.attempt.admission.current())) {
          this.notifications.error(ended.unresumed ?? withSignInHint(ended.signedOut, failureText(this.store.get(task.id) ?? task, verdict)));
        }
        if (ended.attempt.worktree) await this.leases.letGo(task.id, { keep: true, reason: 'failed' });
        this.logAndArchive(task, verdict);
        break;
      }
    }
    await this.afterVerdict(ended.task.id);
  }

  /**
   * A start that never ran, however its spawn failed (`SpawnFailure`).
   * The task's status is settled before anything is awaited, so no tick in
   * between finds it in progress with no attempt; then its worktree is let
   * go, the user is told why and the run goes on.
   */
  private async settleSpawnFailure({ task, attempt, failure }: Extract<AttemptEnded, { kind: 'spawn-failed' }>): Promise<void> {
    if (failure.leaves === 'conflict') {
      this.store.markAwaitingUser(task.id, 'conflict');
      this.settleUnlanded(task, await this.landing.unrepaired(task, failure.why), attempt.admission);
    } else {
      if (failure.leaves === 'failed') {
        this.store.markFailed(task.id);
        this.store.setTaskOutputSummary(task.id, failure.summary);
      } else {
        this.store.markPending(task.id);
        this.starts.hold(task.id, failure.hold, 'failed-start');
      }
      if (failure.leaves !== 'held' || !failure.preserveWorktree) {
        await this.leases.letGo(task.id, { keep: failure.leaves === 'failed' && failure.keepWorktree, reason: 'spawn failed' });
      }
      const { level, text, toastOnly } = failure.notice;
      if (toastOnly) this.notifications[level](text);
      else this.tell(level, text);
    }
    if (failure.leaves !== 'held' || failure.settles) this.emit('onTaskSettled', { taskId: task.id });
    this.emit('onTaskChanged');
    await this.tick();
  }

  /**
   * A verdict whose settling threw. One still live when it did fails (a
   * repair waits on the user, as its conflict did) and blocks only its
   * dependents; either way the run says why and goes on.
   */
  private settleUnsettled({ taskId, attempt, reason }: Extract<AttemptEnded, { kind: 'unsettled' }>): void {
    const title = this.store.get(taskId)?.title ?? taskId;
    if (attempt) {
      if (attempt.kind.kind === 'repair') this.store.markAwaitingUser(taskId, 'conflict');
      else this.store.markFailed(taskId);
      this.store.setTaskOutputSummary(taskId, summarizeOutput(reason, ''), handoffKept(this.store.get(taskId), attempt.kind));
      // Its landing may be what threw, so the release does not wait on it.
      if (attempt.worktree) this.unawaited(this.leases.letGo(taskId, { keep: true, reason: 'unsettled' }), `Could not keep the worktree of task "${title}"`);
    }
    this.tell('error', attempt ? `Task "${title}" could not be settled: ${reason}` : `Task "${title}" settled, but what follows it could not be scheduled: ${reason}`);
    this.unawaited(this.afterVerdict(taskId), 'The run could not be closed');
  }

  /** Work nothing awaits: a rejection is said, not left unhandled. */
  private unawaited(work: Promise<unknown>, failure: string): void {
    this.underWay(work).catch((err: unknown) => {
      const message = `${failure}: ${err instanceof Error ? err.message : String(err)}`;
      try {
        this.tell('error', message);
      } catch (tellErr) {
        console.error(`[TaskOrchestrator] ${message}; saying so failed:`, tellErr);
      }
    });
  }

  private async afterVerdict(taskId: string): Promise<void> {
    // The runner a task made manual kept its wait for is gone, so it is the manual task it now is (ADR-0053).
    this.store.releaseMadeManual((id) => this.attempts.has(id));
    // A paused task a direct edit made manual goes with it, and it may be the last wait on a reset.
    this.limitPauses.recount();
    // A conflict owed a repair is back in progress: nothing has settled yet.
    const status = this.store.get(taskId)?.status;
    if (status === 'completed' || status === 'failed' || status === 'awaiting_user') this.emit('onTaskSettled', { taskId });
    this.emit('onTaskChanged');
    if (this.startsOnTick) {
      await this.tick();
      return;
    }
    // A run the scheduler is not driving settles here rather than in a tick,
    // so what was queued behind this task starts here too.
    await this.starts.offer(this.admittedNow());
    await this.settleRun('verdict');
  }

  /**
   * Settle a task by how its landing went; `onLanded` is what the path that
   * landed it adds to completing it. `admission` is the start the landed work
   * came from, which a repair follows on from.
   */
  private async applyLanding(task: Task, outcome: LandingOutcome, admission: Admitted, onLanded: () => void): Promise<void> {
    if (!completesTask(outcome)) return this.settleUnlanded(task, outcome, admission);
    this.store.markCompleted(task.id);
    this.retireResolvers(task.id);
    this.loops.close(task, LOOP_PASSED);
    this.carryChecks(task, admission);
    onLanded();
    this.say(outcome.messages);
    await this.owedByLanding(task, outcome);
    await this.landResolved(task.id, admission);
  }

  /** Before anything the landing lets start: what a dependent reads of it should be there (ADR-0057 R6). A flat plan owes nothing, and waits on nothing. */
  private async owedByLanding(task: Readonly<Task>, outcome: LandingOutcome): Promise<void> {
    const owed = outcome.kind === 'landed' ? this.deps.landed?.(task) : undefined;
    if (owed) await owed;
  }

  /**
   * Work that did not land waits on the user — it never fails the task or
   * blocks its dependents — unless its conflict is owed a repair, which takes
   * the slot the ending attempt freed and never one more than the run allows.
   * A planner turn's start hold holds it as it holds any new spawn (ADR-0029),
   * and a usage limit does too: `reopen` spends a repair, so one the runner
   * would refuse is not tried. The repair follows on from the start whose work
   * it repairs: a Stop since that was admitted withdraws it.
   */
  private settleUnlanded(task: Task, outcome: UnlandedOutcome, admission: Admitted): void {
    this.store.markAwaitingUser(task.id, 'conflict');
    this.say(outcome.messages);
    if (outcome.kind !== 'repair-needed') return;
    const waitsFor = this.startHolds > 0 ? 'the planner\'s turn ends' : this.onUsageLimit(task) ? 'the usage limit resets' : this.slotsFull() ? 'a slot is free' : null;
    if (!waitsFor) {
      const claimed = this.claim(task.id, admission);
      if ('refused' in claimed) this.tell('warn', `The conflict of task "${task.title}" is not repaired: ${claimed.refused}`);
      else this.unawaited(claimed.spawned, `Could not start the repair of task "${task.title}"`);
    } else {
      this.store.markPending(task.id);
      // A scheduler driving the run claims it; outside one nothing else would.
      if (!this.isScheduling) this.starts.oweRepair(task.id);
      this.tell('info', `Task "${task.title}" is repaired once ${waitsFor}.`);
    }
  }

  /** A repair {@link settleUnlanded} left owed, as slots and any start hold allow. */
  private offerRepair(id: string, admission: Admitted): Offer<() => void> {
    if (this.startHolds > 0 || this.slotsFull()) return 'full';
    // Held as any start on that runner is; the reset ticks, and it is still owed then.
    if (this.repairWait(id) === 'usage-limit') return 'waits';
    const task = this.store.get(id);
    // A retry, skip or edit since has settled it some other way.
    if (!task || task.status !== 'pending' || this.attempts.has(id) || !this.landing.nextRepair(id)) return 'ends';
    return {
      start: () => {
        const claimed = this.claim(id, admission);
        if ('refused' in claimed) {
          // Nothing will ask again, so it waits on the user as a repair that could not start does.
          this.store.markAwaitingUser(id, 'conflict');
          this.tell('warn', `The conflict of task "${task.title}" is not repaired: ${claimed.refused}`);
        } else this.unawaited(claimed.spawned, `Could not start the repair of task "${task.title}"`);
      },
    };
  }

  /**
   * A conflict ended some other way than through its resolver: the task
   * landed, was retried or skipped, or left the plan. The merge the resolver
   * was added for is no longer needed, so it goes with its link: skipped,
   * with why, and never started (ADR-0015).
   */
  private retireResolvers(conflictedId: string): void {
    for (const id of this.runs.resolversOf(conflictedId)) {
      this.runs.takeResolver(id);
      this.retireResolver(id);
    }
  }

  private retireResolver(id: string): void {
    const resolver = this.store.get(id);
    if (!resolver || this.attempts.has(id) || !LEFT_UNDONE.has(resolver.status)) return;
    this.store.markSkipped(id, 'resolver', RESOLVER_NOT_NEEDED);
    this.starts.skipped(id);
    this.tell('info', `Task "${resolver.title}" was skipped: the conflict it was added for is gone.`);
  }

  /** A planner's remove reaches no {@link releaseTask}: what it took out of the plan since `before` ends its conflicts here. */
  private retireResolversLeft(before: readonly Task[]): void {
    for (const { id } of flattenTasks(before)) if (!this.store.get(id)) this.retireResolvers(id);
  }

  /** A delegated task the edit took out leaves nothing naming its child's run, so that goes with it, once a child still stopping has (ADR-0055 D15). */
  private retireChildrenLeft(before: readonly Task[]): void {
    for (const task of flattenTasks(before)) {
      if (task.type !== 'delegated' || !task.runnerSessionId || this.store.get(task.id)) continue;
      this.unawaited(this.attempts.allWoundDown().then(() => this.deps.attempt.discardChild?.(task)), `Could not discard the child of task "${task.title}"`);
    }
  }

  /** A control that would end a conflict waits for the resolver at work on it: a conflict has one worker (ADR-0015). */
  private refuseBesideResolver(taskId: string): void {
    const resolver = this.landing.liveResolvers(taskId).find((r) => this.attempts.has(r.id));
    if (resolver) throw new TaskControlError(`Task "${resolver.title}" is resolving the conflict of task "${this.store.get(taskId)?.title ?? taskId}": stop it first, or let it finish.`);
  }

  private async landResolved(resolverId: string, admission: Admitted): Promise<void> {
    const resolved = this.landing.landResolved(resolverId, (id) => this.releasing.has(id));
    if (!resolved) return;
    const { task } = resolved;
    // The conflicted task's own landing as much as Mark complete's is: a
    // delete or retry of it must not take the worktree being merged.
    const outcome = await this.holdWhileLanding(task.id, resolved.outcome);
    // Mark complete, landing it alongside, has completed it already: this
    // merge brought nothing more, and a failure of it must not undo that.
    if (this.store.get(task.id)?.status === 'completed') return;
    await this.applyLanding(task, outcome, admission, () => {
      if (task.verdict) this.logAndArchive(task, task.verdict);
    });
  }

  /**
   * Hold a task for as long as `landing` is merging its worktree. Its end lets
   * go of its own hold only: another landing of the task begun meanwhile
   * still holds it.
   */
  private async holdWhileLanding(taskId: string, landing: Promise<LandingOutcome>): Promise<LandingOutcome> {
    const holds = this.completing.get(taskId) ?? new Set<Promise<LandingOutcome>>();
    holds.add(landing);
    this.completing.set(taskId, holds);
    try {
      return await landing;
    } finally {
      holds.delete(landing);
      if (holds.size === 0 && this.completing.get(taskId) === holds) this.completing.delete(taskId);
    }
  }

  getReadyTasks(): Task[] {
    return this.readiness().ready;
  }

  private readiness(): Readiness {
    if (!this.startsOnTick) return { ready: [], candidateCount: 0, excluded: [], gated: [] };
    const maxParallel = this.config.maxParallelSessions;
    // This Session's own: a task the pool refuses stays ready, and its run is not settled (ADR-0055 D18).
    const active = this.attempts.slotsHeld;
    const readiness = selectReadyTasks({ ...this.startRule(), active, maxParallel, ...(this.isScheduling ? {} : { within: this.carriedTasks() }) });

    // Counted, not listed: a line per task would make every tick walk the plan's tree once per task.
    if (readiness.excluded.length > 0) {
      const kinds = new Map<StartWaitKind, number>();
      for (const { waits } of readiness.excluded) kinds.set(waits[0].kind, (kinds.get(waits[0].kind) ?? 0) + 1);
      console.log(`[TaskOrchestrator] excluded: ${readiness.excluded.length} (${[...kinds].map(([kind, count]) => `${kind} ${count}`).join(', ')})`);
    }
    console.log(`[TaskOrchestrator] getReadyTasks: ${readiness.candidateCount} candidates, ${Math.max(0, maxParallel - active)} slots, maxParallel=${maxParallel}`);
    return readiness;
  }

  private mergesAutomatically(): boolean {
    return (this.runSettings()?.mergeAtGatesAutomatically ?? false) && this.mayMergeUnasked();
  }

  /** A Merge all is under way. */
  get isMerging(): boolean { return this.merging; }

  /** A gate reached now is merged with nobody asked: the setting is on, and no merge has stopped it. */
  get mergesAtGates(): boolean { return this.mergesAutomatically() && !this.autoMergeBlocked && this.mergeHold.length === 0; }

  /**
   * The user changed the run settings under an open run (ADR-0030). The
   * scheduler reads them at each decision it makes from them, so a merge gate
   * already reached is merged now rather than at the next event. Fire-and-forget
   * — no caller waits on the change — and its failure is said through
   * {@link unawaited}, never left unhandled.
   */
  runSettingsChanged(): void {
    if (!this.runs.isOpen || !this.startsOnTick) return;
    this.unawaited(this.tick(), 'Could not act on the changed run settings');
  }

  private transition(event: RunEvent): void {
    this.runState = nextRunState(this.runState, event);
  }

  /**
   * A retry, skip or continue of a task continues a run that ended on a
   * failure (ADR-0034): the scheduler drives it again. A run a reset holds
   * stays held, and one held from an ended run is the plan's run once the
   * reset lets it go. Null when no run starts.
   */
  private continueRun(origin: RunOrigin): Promise<void> | null {
    if (this.runState.kind === 'endedOnFailure') return this.start(origin);
    this.transition({ type: 'continue' });
    return null;
  }

  private openRun(origin: RunOrigin): void {
    const opening = !this.runs.isOpen;
    this.runs.open();
    if (!opening) return;
    this.autoMergeBlocked = false;
    this.emit('onRunStarted', { origin });
  }

  /**
   * Open the run a task starts in, and decide whether it isolates if the
   * task's next attempt needs that ({@link decidesIsolation}). A dirty tree
   * parks it; `resume` is what the user's choice replays.
   */
  private async openFor(taskId: string, origin: RunOrigin, resume: () => Promise<void>): Promise<IsolationStart | 'checkout'> {
    this.openRun(origin);
    return decidesIsolation(this.attempts.nextKind(taskId)) ? this.runs.decide(resume) : 'checkout';
  }

  /**
   * {@link openFor} for an explicit start under `admission`. A Stop while the
   * run opened interrupts that opening too, which then opens nothing; the
   * start says it was stopped rather than going quiet as if a dirty tree were
   * waiting on the user. A run that settled and closed under a start still
   * admitted is no Stop: often what closed it (a revert, a skip) changed the
   * task, and the start then says what its claim would have; otherwise it
   * opens the next run, as if it had been asked just after the close.
   */
  private async openForAdmitted(taskId: string, origin: RunOrigin, resume: () => Promise<void>, admission: Admitted, revives: boolean): Promise<IsolationDecision | 'checkout' | false> {
    for (;;) {
      const opened = await this.openFor(taskId, origin, resume);
      if (!admission.current() || opened === 'interrupted') throw new TaskControlError(STOPPED_BEFORE_START);
      if (opened !== 'closed') return opened === 'blocked' ? false : opened;
      // Reopening ticks nothing, so only another settle can close the next run under it too.
      const refused = this.startRefusal(taskId, admission, { revives });
      if (refused) throw new TaskControlError(refused);
    }
  }

  /**
   * Cancel a running (or scheduled) task: kill its session and return it to
   * 'pending' — "not executed". The task is put on hold so the scheduler
   * doesn't immediately restart it; Retry / Force Start release the hold.
   * A repair, running or owed a start, leaves its conflict waiting instead.
   *
   * The attempt's worktree is kept, as a stopped or failed one is: a runner is
   * often cancelled because it looked stuck after doing the work, and Mark
   * complete can still land that work. The next attempt replaces it.
   */
  async cancelTask(taskId: string): Promise<void> {
    this.refuseWhileCompleting(taskId);
    if (this.repairWait(taskId)) {
      this.starts.cancelled(taskId);
      this.store.markAwaitingUser(taskId, 'conflict');
      this.emit('onTaskChanged');
      return this.tick();
    }
    await this.cancelAttempt(taskId, { keep: true });
  }

  /**
   * Mark complete's landing owns the task until it settles: a control that
   * ended or restarted the attempt under it would take the worktree it is
   * merging, and the landing would then complete the task anyway.
   */
  private refuseWhileCompleting(taskId: string): void {
    const task = this.store.get(taskId);
    if (task && this.completing.has(taskId)) throw new TaskControlError(beingMarkedComplete(task));
  }

  private async cancelAttempt(taskId: string, worktree: { keep: boolean }): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    // A cancel that arrives after the task already settled (its verdict
    // landed and the attempt was torn down) has nothing left to cancel. Without
    // this guard it would still revert a completed/failed task to 'pending',
    // silently discarding a verdict that already landed.
    if (!this.attempts.has(taskId) && task.status !== 'in_progress') return;
    const ended = this.attempts.end(taskId, 'cancel', worktree);
    // A stopped repair did not land, so its conflict waits on the user, as the run's Stop leaves it.
    if (ended?.kind.kind === 'repair') this.store.markAwaitingUser(taskId, 'conflict');
    else {
      this.store.markPending(taskId);
      this.starts.hold(taskId, 'cancelled; retry or force start to run it again', 'chosen');
    }
    this.emit('onTaskChanged');
    await this.leases.letGo(taskId, { ...worktree, landing: ended?.integration, reason: 'cancelled' });
    await this.tick();
  }

  /**
   * Let go of a task that is leaving the plan. A live runner is cancelled
   * as {@link cancelTask} does, but its worktree goes: no task is left to land
   * it into. A spawn still in flight just loses its attempt,
   * which is what makes {@link Attempts} kill the session it is about to
   * receive. Every landing of it in flight — Mark complete's, its resolver's —
   * settles first, so its worktree is not torn down under a merge, and none
   * begins while it goes; a repair a landing claims is cancelled as any
   * running attempt is. The id's cross-attempt bookkeeping
   * goes too — a hold or retry count kept for a task that no longer exists
   * would be inherited by nothing.
   */
  async releaseTask(taskId: string): Promise<void> {
    this.limitPauses.cancel(taskId);
    // Every landing holding it, including one begun while an earlier one
    // settled; a failure of one is its own path's to report.
    for (let holds = this.completing.get(taskId); holds; holds = this.completing.get(taskId)) await Promise.allSettled(holds);
    this.releasing.add(taskId);
    try {
      // The user deleting the task means it: its resolver has nothing left to merge.
      for (const resolver of this.landing.liveResolvers(taskId)) {
        if (this.attempts.has(resolver.id)) await this.cancelAttempt(resolver.id, { keep: false });
      }
      this.retireResolvers(taskId);
      this.runs.takeResolver(taskId);
      const phase = this.attempts.phaseOf(taskId);
      if (phase === 'running' || phase === 'integrating') await this.cancelAttempt(taskId, { keep: false });
      else {
        this.attempts.end(taskId, 'release', { keep: false });
        // Not left in progress while its worktree goes: it is leaving the plan, not running.
        if (this.store.get(taskId)?.status === 'in_progress') this.store.markPending(taskId);
        await this.leases.letGo(taskId, { keep: false, reason: 'left the plan' });
      }
    } finally {
      this.releasing.delete(taskId);
    }
    this.starts.left(taskId);
    this.retryCounts.delete(taskId);
    this.attempts.forget(taskId);
  }

  async markTaskComplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed') return;
    // A second call made while the first awaits its landing finds no attempt —
    // it was ended by the first — and would land, archive and announce again.
    // One leaving the plan would merge the worktree being torn down.
    if (this.completing.has(taskId) || this.releasing.has(taskId)) return;
    // A repair its landing may be owed follows on from this, the user's act.
    const admission = this.admittedNow();

    const ended = this.attempts.end(taskId, 'complete');
    const verdict = this.attempts.markComplete(task);
    // The user vouches for the work, so it lands the way a passed verdict's
    // would — including a landing a passed verdict already has in flight.
    const landed = ended?.integration ?? this.attempts.afterCollecting(taskId, () => this.landing.landVouched(task));
    const landing = await this.holdWhileLanding(taskId, landed);

    // Recorded before the landing settles, as a verdict is: a repair it
    // claims starts with a summary of its own, not this one.
    this.store.setTaskVerdict(taskId, verdict);
    // A user task has no attempt to have written a handoff: the user's act is its.
    const handoff = task.type === 'user' ? userTaskHandoff(task.userSteps) : undefined;
    this.attempts.handOver(taskId, summarizeOutput(verdict.reason, ''), handoff);
    if (completesTask(landing)) {
      this.store.markCompleted(taskId);
      this.retireResolvers(taskId);
      this.loops.close(task, LOOP_CHECK_MARKED_COMPLETE);
    } else this.settleUnlanded(task, landing, admission);
    this.logAndArchive(task, verdict);
    if (completesTask(landing)) {
      this.starts.completed(taskId);
      this.notifications.info(`Task "${task.title}" marked complete.`);
      this.say(landing.messages);
      await this.owedByLanding(task, landing);
      await this.landResolved(taskId, admission);
    }

    // A task paused on a usage limit no longer waits on its reset.
    this.limitPauses.recount();
    this.emit('onTaskChanged');
    await this.tick();
  }

  /**
   * Undo a completion: return the task to "not executed" — pending, verdict and
   * summary dropped, archive entry removed. It is put on hold like a cancel, so
   * a running plan does not immediately re-spawn the work the user just
   * un-marked; only Retry / Force Start release the hold, starting the plan again does not. Dependents fall back
   * to waiting on their own, because the scheduler gates on `isCompleted`.
   */
  async markTaskIncomplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status !== 'completed') return;

    this.attempts.clear(task);
    this.store.retry(taskId);
    this.store.removeFromLog(taskId);
    this.starts.hold(taskId, 'marked not done; retry or force start to run it again', 'chosen');

    this.notifications.info(`Task "${task.title}" marked not done.`);
    this.emit('onTaskChanged');
    await this.tick();
  }

  /**
   * What reverting a task would take, and what stands in its way, as far as
   * the plan can say (ADR-0054); {@link revertPreview} and the revert itself
   * ask git the rest.
   */
  revertScope(taskId: string): RevertScope {
    const live = this.liveTaskIds();
    // Mark complete's landing is at work with no attempt, and a usage-limit pause goes on by itself.
    for (const id of this.completing.keys()) live.add(id);
    for (const t of this.store.allTasks) if (pausedOnLimit(t)) live.add(t.id);
    return revertScope(taskId, { tasks: this.store.allTasks, run: this.runs.current, live, resolvers: (id) => this.landing.liveResolvers(id) });
  }

  /** What a revert of the task would do now: the tasks, newest landing first, or why it would not go ahead. */
  async revertPreview(taskId: string): Promise<TaskRevertPreview> {
    const { taskIds, refusal } = this.revertScope(taskId);
    if (taskIds.length === 0) return { revertible: false, ...refusal! };
    const landed = await this.runs.readLanded(taskIds);
    if (!landed.ok) return { revertible: false, reason: landed.reason, message: landed.error };
    if (landed.inBranch.length > 0) return { revertible: false, ...inBranchRefusal(landed.inBranch) };
    if (refusal) return { revertible: false, ...refusal };
    return { revertible: true, tasks: landed.tasks.map((t) => ({ ...t, dependent: t.taskId !== taskId, ref: taskRefOf(this.store.planTasks, t.taskId) })) };
  }

  /**
   * Revert the task's landed work, with its landed dependents, on the
   * integration branches (ADR-0054). No new start while it waits for its
   * turn and works: one that took its claim now would be cut from a tip about
   * to lose what it depends on, so the claim of anything depending on the work
   * is refused too, a start admitted before the revert with it. What it finds
   * in the way there is judged again: a Mark complete landing a dependent is
   * live like any other. Tasks not depending on it keep running.
   */
  async revertTask(taskId: string): Promise<IsolationRevertResult> {
    const { taskIds, refusal } = this.revertScope(taskId);
    if (refusal) return { outcome: 'refused', reason: refusal.message };
    const releaseStarts = this.holdStarts();
    // A resolver's merge would land what this ends, so it may not start either.
    const reach = new Set([...revertReach(taskId, this.store.allTasks, this.runs.current), ...taskIds.flatMap((id) => this.runs.resolversOf(id))]);
    this.reverting.add(reach);
    let result: IsolationRevertResult;
    try {
      result = await this.runs.revert(taskIds, {
        refusal: () => this.revertRefusalNow(taskId, taskIds),
        settled: (reverted) => this.takeBack(reverted),
      });
    } finally {
      this.reverting.delete(reach);
      releaseStarts();
    }
    if (result.outcome === 'reverted') {
      const one = result.tasks.length === 1;
      this.notifications.info(`Reverted ${quotedList(result.tasks.map((t) => t.title))} on the integration branch: back to not started and held until ${one ? 'it is' : 'they are'} retried. ${one ? 'Its attempts and logs are' : 'Their attempts and logs are'} kept.`);
    }
    this.emit('onTaskChanged');
    await this.tick();
    return result;
  }

  private revertRefusalNow(taskId: string, asked: readonly string[]): string | null {
    const { taskIds, refusal } = this.revertScope(taskId);
    if (refusal) return refusal.message;
    const same = taskIds.length === asked.length && taskIds.every((id) => asked.includes(id));
    return same ? null : 'What this revert would take changed while it waited for its turn. Nothing was reverted; look at it again.';
  }

  /**
   * Each reverted task goes back to not started, held like a stopped one so
   * the scheduler does not run it again, and starts over when retried: from
   * the current tip, which no longer holds its work. Its completion goes as
   * Mark not done takes one back; the logs of its attempts stay. A conflict it
   * held is over, so a resolver out to it goes too (ADR-0015).
   */
  private takeBack(taskIds: readonly string[]): void {
    for (const id of taskIds) {
      const task = this.store.get(id);
      if (!task) continue;
      this.attempts.clear(task);
      this.store.markReverted(id);
      this.store.removeFromLog(id);
      this.starts.hold(id, REVERTED_HOLD, 'chosen');
    }
    // Last: retiring one saves the run, whose records have gone already, so every task has to be back by then.
    for (const id of taskIds) this.retireResolvers(id);
  }

  /**
   * Skip: end a task as `skipped`, with no verdict and nothing of its work
   * landed. Its worktree is kept, as a failed attempt's is, so the user can
   * still look at it or Mark complete it later. Its dependents go ahead
   * without it once the work it waited on is done, and a run that ended on a
   * failure continues for them, as a retry would continue it. A running task is stopped before it is skipped.
   */
  async skipTask(taskId: string, reason?: string, origin: RunOrigin = 'user'): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'skipped') return;
    this.refuseWhileCompleting(taskId);
    if (task.status === 'in_progress') throw new TaskControlError(`Task "${task.title}" is running: stop it before skipping it.`);
    this.refuseBesideResolver(taskId);
    await this.whileAdmitted(async (admission) => {
      // Dropping its resume may release a held run, which the tick below then schedules.
      this.limitPauses.cancel(taskId);
      const ended = this.attempts.end(taskId, 'skip');
      this.attempts.clear(task);
      this.store.markSkipped(taskId, origin === 'supervisor' ? 'supervisor' : 'user', reason?.trim() || undefined);
      // Skipped itself, a resolver leaves its conflict free for another worker.
      this.runs.takeResolver(taskId);
      this.retireResolvers(taskId);
      this.loops.close(task, LOOP_CHECK_SKIPPED);
      this.starts.skipped(taskId);
      this.notifications.info(`Task "${task.title}" skipped: none of its work lands, and the tasks that depend on it go ahead without it once the work it waited on is done.`);
      this.emit('onTaskChanged');
      await this.leases.letGo(taskId, { keep: true, landing: ended?.integration, reason: 'skipped' });
      // A Stop while the worktree was kept leaves the run stopped: the skip
      // stands, and nothing it released starts.
      if (admission.current()) await (this.continueRun(origin) ?? this.tick());
      else await this.tick();
    });
  }

  private logAndArchive(task: Task, verdict: Verdict): void {
    const snapshot: TaskSnapshot = {
      ...task,
      completedAt: Date.now(),
      verdict,
      retryCount: this.retryCounts.get(task.id) ?? 0,
      finalized: true,
    };
    this.store.appendToLog(snapshot);
    // Completed tasks remain in the active plan tree so the UI can keep
    // showing them alongside pending and running work.
  }

  async retryTask(taskId: string, origin: RunOrigin = 'user'): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    this.refuseWhileCompleting(taskId);
    this.refuseBesideResolver(taskId);
    this.refuseBesideLiveCheck(taskId);
    await this.whileAdmitted(async (admission) => {
      // A retried task's own pause ends with it; that may release a held run,
      // which the tick below then schedules (ADR-0018, U1).
      this.limitPauses.cancel(taskId);
      this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
      const ended = this.attempts.end(taskId, 'retry');
      const movedFrom = this.movedFrom(task);
      this.store.retry(taskId);
      // Now, not once the worktree has gone: a tick in between would start it.
      this.retireResolvers(taskId);
      if (movedFrom) this.store.setCarriedFrom(taskId, movedFrom);
      this.starts.retried(taskId);
      this.emit('onTaskChanged');
      if (movedFrom) {
        // The earlier runner's work is the new attempt's to restore, so its worktree stays until that prepare replaces it.
        await ended?.integration;
      } else {
        // A retry starts over from the integration tip, which by now holds what its
        // predecessors landed; the old attempt's worktree has nothing to offer it.
        await this.leases.letGo(taskId, { keep: false, landing: ended?.integration, reason: 'retried' });
      }
      // A Stop while the worktree went leaves the run stopped, the task back to not started.
      if (!admission.current()) return;
      await (this.continueRun(origin) ?? this.tick());
    });
  }

  /**
   * Continue a finished structured task in its saved runner session (ADR-0018,
   * K1): a retry whose first turn is the user's message, sent to the session
   * the task ended in rather than a fresh one given its prompt again. The
   * worktree keeps the same path, where the runner keeps its sessions, and
   * restores the previous work so that session's memory matches its files.
   * `revives` is {@link claimRefusal}'s, read as the start is asked for: a dirty
   * tree's replay carries the first answer, not one read after a skip.
   */
  async continueTask(taskId: string, message: string, origin: RunOrigin = 'user', revives = this.store.get(taskId)?.status === 'skipped'): Promise<void> {
    const text = message.trim();
    if (!text) throw new TaskControlError('A message to continue a task with cannot be empty.');
    const task = this.store.get(taskId);
    if (!task) throw new TaskControlError(`No task ${taskId} in this plan.`);
    const eligible = continuability(task);
    if (!eligible.ok) throw new TaskControlError(eligible.reason);
    if (pausedOnLimit(task)) return this.resumeNow(taskId, origin, text);
    this.refuseBesideLiveCheck(taskId);
    await this.whileAdmitted(async (admission) => {
      const decision = await this.openForAdmitted(taskId, origin, () => this.continueTask(taskId, message, origin, revives), admission, revives);
      if (!decision) return;
      // The run may have started it while opening, or the task changed: the
      // claim below must be the only one, and continues the task as it is now.
      const now = this.store.get(taskId);
      const resumable = now && continuability(now);
      if (this.attempts.has(taskId) || !resumable?.ok) return;
      this.refuseClaim(taskId, admission, { revives });

      this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
      this.attempts.end(taskId, 'retry');
      this.store.retry(taskId);
      this.starts.retried(taskId);
      // Claimed before anything is awaited, so a running scheduler never sees the
      // pending task and starts it afresh. Its prepare replaces the old worktree.
      const started = this.claimed(taskId, admission, { message: text, resumeSessionId: resumable.sessionId }, { decision });
      const resumed = this.continueRun(origin) ?? Promise.resolve();
      // Both are awaited even if one fails: the claimed attempt's start must not
      // be left unhandled because restarting the run threw.
      await Promise.all([resumed, started]);
    });
  }

  /**
   * Keep a task paused on its runner's usage limit from resuming on its own:
   * it waits for a manual retry, as one whose reset time could not be read
   * does. What a surface's cancel calls. A run the pause held goes on once
   * nothing else waits on a reset. False when no resume was scheduled for it.
   */
  async cancelScheduledResume(taskId: string): Promise<boolean> {
    if (!this.limitPauses.cancel(taskId)) return false;
    await this.tick();
    return true;
  }

  /**
   * The runner whose attempt left the task's work, when the task has been
   * moved off it since: a session cannot cross runners, so whatever starts
   * the task next is a carry-over of that work, the rule a paused task's move
   * follows (ADR-0018, U1).
   */
  private movedFrom(task: Task): RunnerId | undefined {
    const owner = sessionOwner(task);
    return owner && owner !== this.store.resolveTaskRunner(task) ? owner : undefined;
  }

  /**
   * Run before writing assignments so cancellation sees the old runner's
   * shared wait. A session cannot cross runners, so the next attempt is a
   * carry-over of the paused attempt's files (ADR-0018, U1).
   *
   * The move routes the task around the limit, so a run the pause held goes
   * on, as a retry would continue it, and a task started alone starts again
   * alone. That run is still open — a hold never closes one — and every edit
   * that calls this ticks once it is written, which starts the task.
   */
  releaseMovedResume(taskId: string, changes: Partial<Task>): Partial<Task> {
    const task = this.store.get(taskId);
    if (!task || task.status !== 'awaiting_user' || task.awaitingReason !== 'usage-limit') return changes;
    const next = { ...task, ...changes };
    // No next attempt to route around the limit: the edit's landing releases a task it made manual (ADR-0053).
    if (next.type === 'user') return changes;
    // The limit belongs to the runner's account, so a model change on that
    // same runner must keep waiting for its reset.
    if ((next.assignedRunner ?? this.store.planRunners[0]) === this.store.resolveTaskRunner(task)) return changes;
    const from = this.limitPauses.moved(taskId);
    this.starts.moved(taskId);
    // Started alone, it starts again alone: no scheduler would claim it.
    if (from === 'idle' || from === 'endedOnFailure') this.starts.queue(taskId, { pastGate: [] });
    return { ...changes, status: 'pending', awaitingReason: undefined, resumeAt: undefined, carriedFrom: this.store.resolveTaskRunner(task) };
  }

  /**
   * Resume a task paused on its runner's usage limit now, in its saved
   * session, once the user says the limit has reset early, with every task
   * waiting on that runner's reset (see {@link LimitPauses.resumeNow}).
   * `message` follows the reset notice in the same continuation. A resumed
   * attempt that hits the limit again at once waits for the user, as an
   * automatic resume's does: that is what keeps a caller from resuming it
   * round and round.
   */
  async resumeNow(taskId: string, origin: RunOrigin = 'user', message?: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) throw new TaskControlError(`No task ${taskId} in this plan.`);
    if (!pausedOnLimit(task)) throw new TaskControlError(`Task "${task.title}" is not paused on a usage limit.`);
    const eligible = continuability(task);
    if (!eligible.ok) throw new TaskControlError(eligible.reason);
    // Refused before the runner's wait is disarmed, so a refusal leaves every
    // resume at the reset as it was.
    this.refuseClaim(taskId, this.admittedNow());
    await this.limitPauses.resumeNow({ taskId, origin, message: message?.trim() || undefined });
  }

  /**
   * Retry a task paused on a usage limit, continuing its saved session where
   * it left one (ADR-0018, K1), then release the hold the pause put on the
   * run once nothing else waits on a reset. `now` is the Resume now that
   * asked for it, or for another task on its runner, which sweeps it along.
   */
  private async resumeTask(taskId: string, now?: ResumeNow): Promise<void> {
    const origin = now?.origin ?? 'limit-reset';
    const asked = now?.taskId === taskId;
    await this.whileAdmitted(async (admission) => {
      const replay = () => this.resumeTask(taskId, now);
      let opened = await this.openFor(taskId, origin, replay);
      // One asked for now answers its caller as {@link openForAdmitted} does,
      // inline so it still claims before the tasks swept along with it; any
      // other was stopped with its run, which said so.
      while (asked && opened === 'closed') {
        const refused = this.startRefusal(taskId, admission);
        if (refused) throw new TaskControlError(refused);
        opened = await this.openFor(taskId, origin, replay);
      }
      if (asked && (!admission.current() || opened === 'interrupted')) throw new TaskControlError(STOPPED_BEFORE_START);
      if (opened === 'blocked' || opened === 'interrupted' || opened === 'closed') return;
      const task = this.store.get(taskId);
      // One asked for now resumes without a resume time; any other cancelled meanwhile stays put.
      if (!task || !(asked ? pausedOnLimit(task) : waitsForReset(task)) || this.attempts.has(taskId)) return;
      // An edit releases a task it made manual as it lands, so this is only the
      // last line: no runner is spawned for one (CONTEXT.md, "Start rule").
      if (task.type !== 'ai') {
        this.limitPauses.cancel(taskId);
        return;
      }
      if (asked) this.refuseClaim(taskId, admission);
      else if (!this.mayResume(task, admission, now !== undefined)) return;
      const resumeSessionId = task.runnerSessionId;
      this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
      // The attempt the limit cut short goes on, in the round it was in.
      this.store.retry(taskId, { sameRound: true });
      this.starts.retried(taskId);
      const message = asked && now?.message ? `${LIMIT_RESET_MESSAGE}\n\n${now.message}` : LIMIT_RESET_MESSAGE;
      const continuation = resumeSessionId ? { message, resumeSessionId } : null;
      const started = this.claimed(taskId, admission, continuation, { autoResumed: true, decision: opened });
      const resumed = this.limitPauses.resumed() ? this.start(origin) : Promise.resolve();
      // No tick follows a task started alone, and what the limit held — a
      // repair, a start asked for under the rule — is owed its start now.
      const offered = this.starts.offer(admission);
      // All are awaited even if one fails: the claimed attempt's start must not
      // be left unhandled because restarting the run threw.
      await Promise.all([resumed, started, offered]);
    });
  }

  /**
   * A resume nobody asked for cannot be refused to anyone. At the limit's
   * reset, one that may not claim waits for the user instead — its resume
   * time dropped, and said. One swept along by a Resume now keeps its resume
   * time, which its caller arms again: the reset has not come. A Stop says
   * so itself.
   */
  private mayResume(task: Readonly<Task>, admission: Admitted, swept: boolean): boolean {
    const refused = this.claimRefusal(task.id, admission);
    if (!refused) return true;
    if (!admission.current()) return false;
    // In a tree a slot is a wait, not a failure: nobody asked for this start, and its timer has fired, so it is kept for a tick to offer (ADR-0055 D18).
    if (!swept && this.pool.shared && this.startRefusal(task.id, admission) === null) {
      this.starts.keepResume(task.id);
      this.leases.reserve(this.leaseRequest('task', task.id));
      return false;
    }
    if (swept) {
      this.tell('info', `Task "${task.title}" did not resume now: ${refused} It still resumes on its own at its usage limit's reset.`);
    } else {
      this.limitPauses.cancel(task.id);
      this.tell('warn', `Task "${task.title}" did not resume at its usage limit's reset: ${refused} Resume it once it can start.`);
    }
    return false;
  }

  /**
   * Manually start a single AI task right now (the "force start" affordance on
   * a task card), past a failed dependency (ADR-0034) or a merge gate
   * (ADR-0020), but never past the claim: it still needs the user's approval,
   * a free slot, and no Stop since it was asked for, and throws
   * {@link TaskControlError} saying which it lacks. A dependency still under
   * way or yet to run is not forced past: the task is released to the
   * scheduler instead, which starts it once they finish, and the line saying
   * so is the answer.
   * Reuses the scheduler's own claim so a force-started task gets the same
   * augmented prompt, session tracking, and exit handling — callers must not
   * re-spawn the runner themselves. No-op if the task is unknown, a user
   * task, or already running. `revives` is as on {@link continueTask}.
   */
  async forceStartTask(taskId: string, origin: RunOrigin = 'user', revives = this.store.get(taskId)?.status === 'skipped'): Promise<string | undefined> {
    const task = this.store.get(taskId);
    if (!task || task.type === 'user') return;
    if (this.attempts.has(taskId)) return;
    const queued = this.queueBehindDependencies(task);
    if (queued) return queued;
    this.starts.forcedNow(taskId);
    return this.startForced(taskId, origin, FORCED_NOW, revives);
  }

  /**
   * Start an approved task once its merge gate opens, never past it: a script
   * task `run_script` added behind work not merged into the user's branch yet
   * (ADR-0035). A scheduler driving the run starts it as it would any task;
   * otherwise it waits with the queued force starts, confirmed past nothing,
   * so it starts once Merge all has merged that work, and a Stop withdraws it.
   */
  startAtGate(taskId: string): void {
    if (!this.store.get(taskId) || this.attempts.has(taskId)) return;
    if (!this.isScheduling) this.starts.queue(taskId, { pastGate: [] });
    this.emit('onTaskChanged');
  }

  /** A start of this task waits in the queue, and starts with nobody asked once what holds it clears. */
  startQueuedFor(taskId: string): boolean {
    return this.starts.queued.has(taskId);
  }

  /**
   * Start a task the user's own act asked for, under the one start rule and
   * past none of it (ADR-0015). A scheduler driving the run claims it as it
   * would any task; otherwise it waits with the queued starts for a slot, a
   * start hold or a usage limit, says what holds it, and a Stop withdraws it.
   * A conflict repair is started the same way, and this is what a resolver
   * added outside a run has in place of one.
   */
  startWhenAllowed(taskId: string): void {
    if (!this.store.get(taskId) || this.attempts.has(taskId) || this.isScheduling) return;
    this.starts.queue(taskId, { pastGate: [], asScheduled: true });
  }

  /**
   * A forced start, from its run opening to its claim. It is judged again once
   * the run has opened, against the task as it stands then, which is what
   * the claim reads and runs. A queued one that something holds back again
   * meanwhile goes back in the queue; one made now that an edit gave
   * dependencies still under way waits for them as if forced after the edit,
   * and says so.
   */
  private async startForced(taskId: string, origin: RunOrigin, forced: ForcedStart, revives = this.store.get(taskId)?.status === 'skipped'): Promise<string | undefined> {
    // A dirty tree's replay of a start made now asks again, from its dependencies on.
    const resume = async () => { await (forced.queued ? this.startForced(taskId, origin, forced, revives) : this.forceStartTask(taskId, origin, revives)); };
    return this.whileAdmitted(async (admission) => {
      const decision = await this.openForAdmitted(taskId, origin, resume, admission, revives);
      if (!decision) return;
      // The run may have started it while opening.
      if (this.attempts.has(taskId)) return;
      const task = this.store.get(taskId);
      if (forced.queued && (this.holdsQueued(taskId, forced) || this.slotsFull(task))) {
        this.starts.queue(taskId, { pastGate: forced.pastGate, ...(forced.asScheduled ? { asScheduled: true } : {}) });
        return;
      }
      const requeued = !forced.queued && task ? this.queueBehindDependencies(task) : null;
      if (requeued) return requeued;
      this.refuseClaim(taskId, admission, { revives });
      // Nothing else would run a check whose fix has landed, so this is its next
      // round. Forced again after any other failure, a check starts its rounds
      // over, as a retry does (ADR-0045 L5, L7).
      this.loops.forced(taskId);
      // A force start is the user's own act, so it ends the task's pause: its
      // resume goes, and the hold with it once nothing else waits (U1).
      this.limitPauses.cancel(taskId);
      this.starts.forced(taskId);
      this.notePastGate(taskId);
      await this.claimed(taskId, admission, null, { revives, decision });
    });
  }

  /**
   * A force start of a task whose dependencies are still under way or yet to
   * run: started now, it would build on work that is not there, so it waits
   * for them in the run, off any hold, and says so. Dependencies are never
   * bypassed silently. A blocked task is forced past its failure as asked.
   * What it goes past at the merge gate is the gate the user confirmed now.
   */
  private queueBehindDependencies(task: Readonly<Task>): string | null {
    const waits = this.startWaits(task, FORCED_NOW);
    const check = waitOf(waits, 'check-running')?.check;
    const waiting = [...(waitOf(waits, 'dependencies') ?? waitOf(waits, 'queued'))?.waiting ?? [], ...(check ? [check] : [])];
    if (waiting.length === 0) return null;
    this.starts.forced(task.id);
    if (!this.leftToScheduler(task)) this.starts.queue(task.id, { pastGate: this.getMergeGate(task.id) });
    const names = waiting.map((id) => `task "${this.store.get(id)?.title ?? id}"`);
    const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const idle = this.isScheduling || waiting.some((id) => this.attempts.has(id)) ? '' : ' Nothing is running now: run the plan to start them.';
    const queued = `Task "${task.title}" is approved and starts once ${listed} ${names.length === 1 ? 'finishes' : 'finish'}.${idle}`;
    this.tell('info', queued);
    this.emit('onTaskChanged');
    return queued;
  }

  /**
   * A force start the scheduler driving the run makes for itself once its
   * dependencies finish: a task not started yet that nothing blocks. A failed
   * one, such as a loop's check forced mid-round, it would never start again,
   * so the force start stays queued.
   */
  private leftToScheduler(task: Readonly<Task>): boolean {
    return this.isScheduling && (task.status === 'pending' || task.status === 'approved') && this.getBlockedBy(task.id).length === 0;
  }

  /**
   * A queued start, as the ledger offers it: started once nothing holds it
   * back any more. One the scheduler now drives the run for, that nothing blocks and that was not
   * confirmed past a gate, is left to it. One at a gate the user did not
   * confirm — work that landed after they forced the start — waits for Merge
   * all, or for another force start, and says so once.
   */
  private offerQueued(id: string, queued: QueuedStart): Offer<() => Promise<void>> {
    const task = this.store.get(id);
    if (!task || this.attempts.has(id) || task.status === 'completed' || task.status === 'skipped') return 'ends';
    // The start rule leaves slots to the claim, so a start a full run would refuse waits in the queue for one.
    if (this.slotsFull(task)) return 'waits';
    const waits = this.startWaits(task, task.research || queued.asScheduled ? undefined : { queued: true, pastGate: queued.pastGate });
    if (task.research && waits.length > 0) return 'waits';
    if (queued.asScheduled && (waits.length > 0 || this.runState.kind === 'held')) {
      this.sayQueuedHeld(task, queued, waits);
      return 'waits';
    }
    if (waits.some((w) => QUEUED_WAITS.has(w.kind))) return 'waits';
    if (this.leftToScheduler(task) && queued.pastGate.length === 0) return 'ends';
    const gate = waitOf(waits, 'merge-gate');
    if (gate) {
      this.sayQueuedAtGate(task, queued, gate.unmerged);
      return 'waits';
    }
    return {
      start: async () => {
        try {
          const owed = task.research ? task.reportTo ?? task.researchOrigin : undefined;
          const origin = owed ? actorAuthority(owed.actor) : 'user';
          await this.startForced(id, origin, { queued: true, pastGate: queued.pastGate, ...(queued.asScheduled ? { asScheduled: true } : {}) });
        } catch (err) {
          this.tell('warn', `Task "${task.title}" did not start${queued.asScheduled ? '' : ' once its dependencies finished'}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
  }

  /**
   * A queued start the start rule holds back, at a gate it was not confirmed
   * past or otherwise. Taken out of the queue by now, so its dependencies
   * still under way read as `dependencies` rather than `queued`.
   */
  private holdsQueued(taskId: string, forced: Extract<ForcedStart, { queued: true }>): boolean {
    const task = this.store.get(taskId);
    return !!task && this.startWaits(task, forced).some((w) => QUEUED_WAITS.has(w.kind) || w.kind === 'dependencies' || w.kind === 'merge-gate');
  }

  /**
   * Whether a start nobody asked for has to wait for a slot, wherever in the
   * tree they are held. Asked with no claim to follow, so it reserves to be
   * refused: the refusal is what has a slot freed elsewhere tick this Session
   * (ADR-0059 L1). Asked of `task`, it asks what that task's claim would
   * reserve, so a delegated start, which takes no slot, never waits for one.
   */
  private slotsFull(task?: Readonly<Task>): boolean {
    const request = task ? this.attemptRequest(task) : this.leaseRequest('task');
    if (this.leases.refusal(request) === null) return false;
    this.leases.reserve(request);
    return true;
  }

  /** A kept resume, once the tree has room for it. One a cancel since left not waiting for its reset is owed nothing. */
  private offerResume(id: string): Offer<() => void> {
    const task = this.store.get(id);
    if (!task || !waitsForReset(task)) return 'ends';
    if (this.slotsFull(task)) return 'full';
    return { start: () => this.unawaited(this.resumeTask(id), `Could not resume task "${task.title}"`) };
  }

  /** A pool's tick: it has nobody to tell of a failure, so it is said. */
  async offered(): Promise<void> {
    await this.tick().catch((err: unknown) => this.tell('error', `Could not start what waited for a slot: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** The task's live attempt holds a slot: every one does but a delegated task's (ADR-0055 D18). */
  holdsSlot(taskId: string): boolean {
    return this.attempts.holdsSlot(taskId);
  }

  /** The task's live attempt waits on this Session's planner: what lets a turn pass the limit (ADR-0055 D18). */
  waitsOnPlanner(taskId: string): boolean {
    const task = this.store.get(taskId);
    return !!task && waitsMidAttempt(task) && this.attempts.has(taskId);
  }

  /** A subplanner's turn found its runner's limit, the account's and so the tree's (ADR-0055 D18). */
  plannerLimited(runner: string, at: Date): void {
    this.deps.limitFound(runner, at);
  }

  limitFoundElsewhere(runner: string, at: Date): void {
    this.limitPauses.foundElsewhere(runner, at);
    this.emit('onTaskChanged');
  }

  /** A planner turn's lease (ADR-0059 L1): a subplanner's waits its turn for a slot, and a root's is never held (ADR-0055 D18). */
  reserveTurn(): { lease: ReservedLease } | { refused: string } {
    return this.leases.reserve(this.leaseRequest('planner'));
  }

  /** The tree's pool, which a child joins (ADR-0055 D18). */
  get slotPool(): SlotPool {
    return this.pool;
  }

  /** A runner let go for the task has not gone yet. */
  windingDown(taskId: string): boolean {
    return this.attempts.windingDown(taskId);
  }

  /** Every runner this Session let go has gone. */
  woundDown(): Promise<void> {
    return this.attempts.allWoundDown();
  }

  /** Nothing the run started is still going, so a close has nothing to wait for. */
  get leftNothing(): boolean {
    return !this.attempts.anyWindingDown && !this.leases.settle && this.loose.size === 0 && !this.deps.runChanges?.changing;
  }

  /** Every runner let go has gone, with what a Stop left to end after it and whatever a backend had running past one, and the run changes git no more. What a next attempt comes back to stays. */
  async allGone(): Promise<void> {
    await this.attempts.allWoundDown();
    await Promise.all(this.loose);
    await this.leases.settle?.();
    await this.deps.runChanges?.closeChanges();
  }

  /** The Session is closing: the tree stops counting on it. */
  leaveTree(): void {
    this.deps.leaveTree();
  }

  /** What the run left past its worktrees, as a Clean up gives it up (ADR-0059 L6). */
  async reclaimLeases(): Promise<void> {
    await this.leases.reclaim?.();
  }

  private leaseRequest(role: LeaseRequest['role'], taskId?: string): LeaseRequest {
    return { node: { sessionId: this.sessionId(), ...(taskId !== undefined ? { taskId } : {}) }, role };
  }

  /** What a start of `task` reserves: a delegated task takes a node and no slot, or a parent at its limit deadlocks on the children that need them (ADR-0055 D18). */
  /** Whether a start of `task` is its child plan's: a delegated task's repair is a plain runner's, which holds a slot and spends tokens (ADR-0055 D14). */
  private startsChildPlan(task: Readonly<Task>): boolean {
    return task.type === 'delegated' && this.landing.nextRepair(task.id) === null;
  }

  private attemptRequest(task: Readonly<Task>): LeaseRequest {
    const role = task.type === 'script' ? 'script' : this.startsChildPlan(task) ? 'child-plan' : 'task';
    return { ...this.leaseRequest(role, task.id), runner: this.store.resolveTaskRunner(task) };
  }

  private sayQueuedAtGate(task: Readonly<Task>, queued: QueuedStart, unmerged: readonly string[]): void {
    const titles = unmerged.map((id) => `"${this.store.get(id)?.title ?? id}"`).join(', ');
    this.sayOnce(queued, `Task "${task.title}" waits for Merge all: the work of ${titles} is not merged into your branch yet. Merge all to start it, or force start it again to start it without that work.`);
  }

  /** A start asked for under the whole rule that the rule holds back, in words the user can act on; a turn's hold ends by itself. */
  private sayQueuedHeld(task: Readonly<Task>, queued: QueuedStart, waits: readonly StartWait[]): void {
    if (waitOf(waits, 'start-hold')) return;
    const limited = this.runState.kind === 'held' || waitOf(waits, 'usage-limit');
    this.sayOnce(queued, `Task "${task.title}" has not started: ${limited ? 'its runner is on a usage limit, so it starts after the reset' : 'the plan holds it back: see what it waits on, then start it'}.`);
  }

  private sayOnce(queued: QueuedStart, notice: string): void {
    if (queued.notice === notice) return;
    queued.notice = notice;
    this.tell('info', notice);
  }

  /**
   * A force start passes a merge gate (ADR-0020), and the surface confirmed it
   * first; the choice is kept on the task and said, because the work it acts
   * on is not in the user's branch.
   */
  private notePastGate(taskId: string): void {
    const task = this.store.get(taskId);
    // Whatever its status: a failed ops task started again acts on the checkout as its first start did.
    const unmerged = (task && waitOf(this.startWaits(task), 'merge-gate')?.unmerged) ?? [];
    if (!task || unmerged.length === 0) return;
    const titles = unmerged.map((id) => `"${this.store.get(id)?.title ?? id}"`);
    this.store.setForcedPastGate(taskId, titles);
    this.tell('warn', `Task "${task.title}" was force-started before the work of ${titles.join(', ')} was merged into your branch.`);
  }

  getCompletedCount(): number { return this.store.completedCount; }
  getTotalCount(): number { return this.store.allTasks.length; }
  isAllComplete(): boolean { return this.store.isAllComplete(); }
  isAnyFailed(): boolean { return this.store.isAnyFailed(); }

  async approveReview(origin: RunOrigin = 'user'): Promise<void> {
    if (this.reviewApproved) {
      console.log('[TaskOrchestrator] approveReview() called but already approved: no-op');
      return;
    }
    this.reviewApproved = true;
    this.emit('onTaskChanged');
    this.emit('onReviewApproved', { tasks: this.store.planTasks });
    if (this.runHeld) return this.joinHold();
    await this.start(origin);
  }

  tick(): Promise<void> {
    return this.deciding(() => this.ticked());
  }

  /**
   * A tick or an attempt's end is under way, so the run may yet go on or end,
   * and tell its supervisor which. A child read in that gap has neither, and
   * would be taken for one that sits on nothing (ADR-0056 M8). Only a child is
   * read that way, so a flat run's ticks take the turns they always took. A
   * close waits one out, at any level: its next step may be a release.
   */
  private deciding(work: () => Promise<void>): Promise<void> {
    if (!this.deps.decided) return this.underWay(work());
    this.decisions += 1;
    return this.underWay(work().finally(() => {
      this.decisions -= 1;
      if (this.decisions === 0) this.deps.decided?.();
    }));
  }

  /** `work`, unchanged, as a close waits for it. */
  private underWay<T>(work: Promise<T>): Promise<T> {
    const ended: Promise<unknown> = work.catch(() => undefined).finally(() => this.loose.delete(ended));
    this.loose.add(ended);
    return work;
  }

  private async ticked(): Promise<void> {
    // What this tick starts was admitted as it began: a Stop during one of its awaits withdraws it.
    const admission = this.admittedNow();
    this.recoverOrphans();
    // A merge taken back out closes its gate again, before anything reads it.
    if (this.runs.readsMerged) await this.runs.refreshInHead();
    // Every way a dependency finishes ticks — a verdict, Mark complete, a skip,
    // a failed spawn — so a queued force start waiting on it is started here.
    await this.starts.offer(admission);
    if (this.mergeOwedAtClose) await this.mergeOwedAfterHold();
    if (!this.startsOnTick) return this.settleRun('tick');

    // Ahead of the run-complete check too: the turn may add work to a run
    // that would otherwise end under it. Its release ticks again.
    if (this.startHolds > 0) return;

    if (this.loops.repeatDue()) this.emit('onTaskChanged');
    let readiness = this.readiness();
    // Work merged by hand opens a gate as Merge all does; only git can tell.
    // A user task's gate counts too, though the scheduler never starts one.
    if (readiness.gated.length > 0 && (await this.runs.refreshInHead())) {
      this.autoMergeBlocked = false;
      readiness = this.readiness();
    }
    if (!this.startsOnTick) return;
    if (this.mergesAtGates && !this.merging && this.attempts.excludingMerge() === undefined) {
      // Only for a task the merge lets start, or lets the user do: nothing else holds it back.
      const gate = readiness.gated[0];
      if (gate) {
        // Another landing must not repeatedly attempt a merge the user now
        // needs to resolve. A user merge or a new run releases this hold.
        this.autoMergeBlocked = true;
        await this.mergeLanded({ kind: 'gate', taskId: gate.id });
        readiness = this.readiness();
      }
    }
    if (!this.startsOnTick) return;
    const { ready } = readiness;
    console.log(`[TaskOrchestrator] tick(): ${ready.length} ready, ${this.attempts.size} active, held=${this.startHolds}`);

    if (ready.length === 0 && this.attempts.size === 0) return this.settleRun('tick');

    const waiting = ready.map(({ id }) => id);
    await Promise.all(Array.from({ length: Math.min(STARTS_AT_ONCE, waiting.length) }, () => this.startReady(waiting, admission)));
    const refused = this.refusedStart;
    if (refused) this.deps.startRefused(refused);
    this.emit('onTick');
  }

  /** Why what is ready cannot start, with nothing live to free room for it: no event will tick this again (ADR-0056 M5). Null otherwise. */
  get refusedStart(): string | null {
    const refused = this.deps.attempt.budget?.refusal() ?? null;
    if (!refused || this.attempts.size > 0) return null;
    return this.readyNow().some((task) => task.type !== 'script' && task.type !== 'delegated' && this.stillReady(task.id)) ? refused : null;
  }

  /**
   * The run moves with nobody asked: something is at work, a reset resumes it,
   * or a slot elsewhere in the tree starts what is ready (ADR-0055 D18). What
   * tells a child that sits on nothing from one that waits (ADR-0056 M8).
   */
  get movesUnasked(): boolean {
    if (this.decisions > 0 || this.attempts.size > 0 || this.runHeld || this.owesUnasked || this.store.allTasks.some(waitsForReset)) return true;
    if (!this.isScheduling) return false;
    return this.waitsOnTree() || (this.refusedStart === null && !this.deps.nodeRefusal?.() && this.readyNow().length > 0);
  }

  /**
   * An owed start a tick makes with nobody asked: a repair, a kept resume, or a
   * queued start a slot elsewhere in the tree holds back (ADR-0055 D18). A
   * queued start that waits on anything else waits on the user's run, so it is
   * owed a Stop but moves nothing.
   */
  private get owesUnasked(): boolean {
    return this.starts.pendingUnasked((id) => this.pool.shared && this.slotsFull(this.store.get(id)));
  }

  /** What is ready now, for a reader that asks far more often than a tick does, so it logs nothing. */
  private readyNow(): readonly Task[] {
    if (!this.startsOnTick) return [];
    return selectReadyTasks({ ...this.startRule(), active: this.attempts.slotsHeld, maxParallel: this.config.maxParallelSessions, ...(this.isScheduling ? {} : { within: this.carriedTasks() }) }).ready;
  }

  /** One of a tick's starters: takes the next of `waiting` as each start it made has attached. */
  private async startReady(waiting: string[], admission: Admitted): Promise<void> {
    for (let id = waiting.shift(); id !== undefined; id = waiting.shift()) {
      // Readiness was read before this loop awaited any start: a stop, a plan
      // load, a Merge all, a user control or a concurrent tick may have come
      // since, so each id is judged again — and last with nothing awaited
      // between that and the claim.
      if (!this.startsOnTick) return;
      if (!this.stillReady(id)) continue;
      // The run a stopped loop settled is gone by the time a retry resumes it.
      if (!this.isScheduling) this.openRun('loop');
      const decision = decidesIsolation(this.attempts.nextKind(id)) ? await this.runs.decide(() => this.tick()) : 'checkout';
      if (decision === 'blocked' || decision === 'interrupted' || decision === 'closed') continue;
      if (!this.startsOnTick) return;
      if (!this.stillReady(id)) continue;
      const claimed = this.claim(id, admission, null, { decision });
      if ('refused' in claimed) {
        if (!admission.current()) return;
        continue;
      }
      await claimed.spawned;
    }
  }

  /**
   * The one step that decides, with nothing at work and nothing the scheduler
   * can start, whether the run goes on, is held, waits on the user or is over
   * (ADR-0034). Every surface takes `onExecutionComplete` as the run's end, so
   * only an end emits it. A run the scheduler is not driving — tasks started
   * on their own — ends on a verdict; a cancel, Mark complete or failed spawn
   * just closes it, so the next run decides its own mode rather than inherit
   * this one's. A loop carried on outside a scheduled run holds that run open
   * as a scheduled one is held, on whatever the start rule waits for.
   */
  private async settleRun(after: 'tick' | 'verdict'): Promise<void> {
    // A retry, Mark not done or an added task since leaves the plan unfinished:
    // still finished, it would tell every surface the run is over while a task waits.
    if (!this.store.isFinished()) this.transition({ type: 'reopen' });
    // An owed repair is the next attempt: closed under it, the run would hand over the work it repairs.
    if (this.attempts.size > 0 || this.owesUnasked) return;
    // A task on a usage limit keeps the run open: closed, it would be handed
    // over or merged before the work the reset resumes.
    if (this.runState.kind === 'held') return;
    if (this.waitsOnTree()) return;
    if (this.runState.kind !== 'scheduling') {
      if (this.carriedOn().length > 0) return this.waitOnUser();
      if (after === 'tick') {
        if (this.runs.isOpen && this.settled) await this.closeRun();
        return;
      }
      if (this.store.isFinished()) this.transition({ type: 'end', outcome: 'finished' });
      this.emit('onTick');
      if (this.settled) await this.closeRun();
      this.emit('onExecutionComplete');
      return;
    }

    const remaining = this.store.allTasks.filter(t => t.status !== 'completed' && t.status !== 'skipped');
    console.log(`[TaskOrchestrator] tick(): no work. remaining=${remaining.length}, completed=${this.store.isAllComplete()}`);
    const remainingById = new Map(remaining.map((t) => [t.id, t]));
    for (const { task, label } of flattenTasksWithParents(this.store.planTasks)) {
      if (!remainingById.has(task.id)) continue;
      console.log(`  - ${label}. ${task.title} [${task.type}/${task.status}] prompt=${!!task.prompt}`);
    }
    const { blocked, repeating } = planBlocks(this.store.planTasks);
    if (remaining.length === 0) {
      this.transition({ type: 'end', outcome: 'finished' });
      this.sayFinished();
    } else if (remaining.every((t) => (t.status === 'failed' && !repeating.has(t.id)) || blocked.has(t.id))) {
      // Nothing left can start until a failed task is retried (ADR-0034):
      // the run ends, and a retry continues it.
      this.transition({ type: 'end', outcome: 'failed' });
      this.sayEndedOnFailure(blocked);
    } else {
      // Waiting on the user: a user task, a checkpoint, a held task or a merge
      // gate. The scheduler stays armed, because the control that answers it
      // ticks, and a tick schedules only while it is.
      return this.waitOnUser();
    }
    this.emit('onTaskChanged');
    this.emit('onTick');
    await this.closeRun();
    this.emit('onExecutionComplete');
  }

  /**
   * What holds this run back is another Session's, not the user's: a slot, or a
   * usage limit a sibling found. Nothing here will tick for it, and what frees
   * it does, so no child parks waiting on a user (ADR-0055 D18). A flat run has
   * no such wait: an idle Session of one has its slots free.
   */
  private waitsOnTree(): boolean {
    if (!this.pool.shared) return false;
    const limited = this.pool.limited();
    return limited.size > 0 && this.judgingOnce(() => this.store.allTasks.some((t) => {
      const wait = waitOf(this.startWaits(t), 'usage-limit');
      return !!wait && limited.has(wait.runner);
    }));
  }

  private waitOnUser(): void {
    this.notifications.info('Remaining tasks require user action or are on hold.');
    this.sayGate();
    this.sayUnapprovedInLoop();
    this.emit('onTaskChanged');
    this.emit('onTick');
  }

  /**
   * Something will run this check between rounds without being asked: a
   * scheduler, the one a reset gives back, or its loop carried on (ADR-0045
   * L5). What the seam reads before it says so to anyone.
   */
  loopRunsOn(checkId: string): boolean {
    return this.loops.runsOn(checkId);
  }

  /** A check between rounds that nothing will run; see {@link LoopRounds.stranded}. */
  loopStranded(taskId: string): boolean {
    return this.loops.stranded(taskId);
  }

  /** A tick starts something: the scheduler the plan, or what is carried on, those tasks alone. */
  private get startsOnTick(): boolean {
    return this.isScheduling || this.carriedOn().length > 0;
  }

  /**
   * What is owed with no scheduler, the carried work that has some now: the
   * carried loops {@link LoopRounds.carriedOwed} counts, then the ledger's
   * carried checks. A delegated task's carried check: ready to start, since
   * whatever start ended that task, a run with no scheduler would otherwise
   * close under it with its merge still held (ADR-0055 D8, D9); one behind a
   * failure or other unfinished work is not here, nothing is moving towards
   * it. None under a scheduler, which owes them itself, or while a usage limit
   * holds the run, which starts nothing.
   */
  private carriedOn(): Task[] {
    if (this.isScheduling || this.runState.kind === 'held') return [];
    const ids = [...this.loops.carriedOwed(), ...this.starts.carried((id) => {
      const check = this.store.get(id);
      return !!check && !this.startWaits(check).some((wait) => CHECK_NOT_READY.has(wait.kind));
    })];
    return ids.flatMap((id) => this.store.get(id) ?? []);
  }

  /** A delegated task passed, and nothing scheduled follows it. A Stop since the start that landed it leaves its checks where they are: a resolver's landing outlives one, with this task waiting on the user and no attempt to stop. */
  private carryChecks(task: Readonly<Task>, admission: Admitted): void {
    if (task.type !== 'delegated' || this.scheduledRun || !admission.current()) return;
    for (const check of this.store.checksOf(task)) if (check.status === 'pending' || check.status === 'approved') this.starts.carryCheck(check.id);
  }

  /**
   * The run that carried them is over, by what gives the run up or clears it
   * up: a retry of a body task that passes runs that task alone. A Stop ends
   * them through the ledger's `stopped`.
   */
  private endCarriedLoops(): void {
    this.starts.runEnded();
    this.loops.runEnded();
    this.loopNotice = '';
  }

  /** What a tick may start with no scheduler: what is carried on, and nothing that depends on it. */
  carriedTasks(): Set<string> {
    return new Set(this.carriedOn().flatMap((check) => [check.id, ...check.loop?.body ?? []]));
  }

  /**
   * A carried task outside the user's approval record waits as any does
   * (ADR-0045, Consent): starting a delegated task consents to that task alone,
   * and a script check's consent is to its body (ADR-0035). Said here, once, as
   * well as listed: a run they started one task of says nothing else of why the
   * next step does not come.
   */
  private sayUnapprovedInLoop(): void {
    const waiting = [...this.carriedTasks()].flatMap((id) => this.store.get(id) ?? []).filter((t) => waitOf(this.startWaits(t), 'unapproved'));
    const notice = waiting.length === 0
      ? ''
      : `${waiting.every((t) => this.starts.carriesCheck(t.id)) ? 'A delegated task has ended, and its check waits' : 'A loop waits'} for your approval of ${quotedList(waiting.map((t) => t.title))}: start ${waiting.length === 1 ? 'it' : 'them'}, or execute the plan, and it goes on.`;
    if (notice === this.loopNotice) return;
    this.loopNotice = notice;
    if (notice) this.tell('info', notice);
  }

  /** Skipped work is not completed work, so a run with any says so rather than that everything completed. */
  private sayFinished(): void {
    const skipped = this.store.allTasks.filter((t) => t.status === 'skipped').length;
    if (skipped === 0) this.notifications.info('All tasks completed!');
    else this.notifications.info(`Run finished: ${this.store.completedCount} completed, ${skipped} skipped.`);
  }

  /** How a run that ended on failures ends: what it finished, what failed, and what that blocks. */
  private sayEndedOnFailure(blocked: ReadonlyMap<string, string[]>): void {
    const tasks = this.store.allTasks;
    const failed = tasks.filter((t) => t.status === 'failed');
    const stuck = tasks.filter((t) => blocked.has(t.id));
    const skipped = tasks.filter((t) => t.status === 'skipped').length;
    const counts = `${tasks.filter((t) => t.status === 'completed').length} completed, ${failed.length} failed, ${stuck.length} blocked${skipped > 0 ? `, ${skipped} skipped` : ''}`;
    const retry = stuck.length > 0 ? ' A blocked task starts once the failed task it waits on is retried and passes.' : '';
    this.tell('warn', `Run finished: ${counts}.${retry}`);
  }

  /** Whether the scheduler may start `id` now: nothing in the start rule holds it back, and a slot is free. */
  private stillReady(id: string): boolean {
    const task = this.store.get(id);
    if (!task || this.attempts.has(id) || this.attempts.slotsHeld >= this.config.maxParallelSessions) return false;
    return this.startWaits(task).length === 0;
  }

  /**
   * A run paused at merge gates says so, as plainly as a task that waits on
   * the user: which tasks wait, and that Merge all lets them go on (ADR-0020).
   */
  private sayGate(): void {
    // With no scheduler only a carried loop's tasks start, so a gate elsewhere holds nothing back.
    const within = this.isScheduling ? null : this.carriedTasks();
    const waiting = this.judgingOnce(() => this.store.allTasks.filter((t) => (!within || within.has(t.id)) && this.getMergeGate(t.id).length > 0));
    const notice = waiting.length === 0
      ? ''
      : `Waiting for Merge all: ${waiting.map((t) => `"${t.title}"`).join(', ')} ${waiting.length === 1 ? 'needs' : 'need'} work that is not merged into your branch yet.`;
    if (notice === this.gateNotice) return;
    this.gateNotice = notice;
    if (notice) this.tell('info', notice);
  }

  /**
   * Why a start may not take its claim now, or null when it may: a Stop came
   * since it was admitted (ADR-0029), the task left the plan or is being
   * marked complete, this node may start nothing (ADR-0055 D16, ADR-0056 M10), a resolver has its conflict, so a start of it would be a
   * second worker on it (ADR-0015), a revert is taking back work it depends on
   * or skipped it since (ADR-0054), it
   * is outside the user's approval record (ADR-0035), its node's budget has no
   * room for it (ADR-0056 M5), it acts from the checkout a Merge all is
   * rewriting (ADR-0020), or its lease cannot be
   * reserved, every slot being taken (ADR-0059 L1). Read in the same
   * synchronous step as the claim it guards, so nothing can change in between.
   */
  private claimRefusal(taskId: string, admission: Admitted, opts: { revives?: boolean } = {}): string | null {
    return this.startRefusal(taskId, admission, opts) ?? this.leases.refusal(this.attemptRequest(this.store.get(taskId)!));
  }

  /**
   * All of {@link claimRefusal} short of the lease: what a refusal keeps nobody
   * for. Whatever else a start spends is checked here, since every attempt
   * passes it. `revives` is a start asked of a task already skipped, as a force
   * start or a continue may be: only that runs one again. A retry has made it
   * pending by the time it claims.
   */
  private startRefusal(taskId: string, admission: Admitted, { revives = false }: { revives?: boolean } = {}): string | null {
    if (!admission.current()) return STOPPED_BEFORE_START;
    const refused = this.deps.nodeRefusal?.();
    if (refused) return refused;
    const task = this.store.get(taskId);
    if (!task) return `There is no task "${taskId}" in this plan any more.`;
    if (task.status === 'skipped' && !revives) return `Task "${task.title}" was skipped after this start was asked for${task.skipReason ? `: ${task.skipReason}` : ''}. Start it again to run it.`;
    if (this.completing.has(taskId)) return beingMarkedComplete(task);
    const [resolver] = this.landing.liveResolvers(taskId);
    if (resolver) return `Task "${resolver.title}" already resolves the conflict of task "${task.title}": skip or remove it first, or let it finish.`;
    if ([...this.reverting].some((reach) => reach.has(taskId))) return `A revert is taking back work task "${task.title}" depends on. Start it again once the revert has ended.`;
    if (!this.isApproved(taskId)) return `Task "${task.title}" waits for the user's approval: they approve it by starting it, or by executing the plan.`;
    if (this.merging && mergeExcludes(this.attempts.nextKind(taskId))) return `A Merge all is under way: ops task "${task.title}" can start once it has finished.`;
    // A script spends no tokens (ADR-0035), so a node out of them can still run its checks.
    // Nor does a delegated task's own attempt: what it spends is carved, and its carve answers for it.
    return task.type === 'script' || this.startsChildPlan(task) ? null : this.deps.attempt.budget?.refusal() ?? null;
  }

  /** An explicit start's refusal, before it changes anything: its caller's answer, as a {@link TaskControlError}. */
  private refuseClaim(taskId: string, admission: Admitted, opts: { revives?: boolean } = {}): void {
    const refused = this.claimRefusal(taskId, admission, opts);
    if (refused) throw new TaskControlError(refused);
  }

  /** An explicit start's claim, once {@link refuseClaim} let it through: its spawn, or the refusal as a rejection. */
  private claimed(taskId: string, admission: Admitted, continuation: Continuation | null = null, opts: { autoResumed?: boolean; revives?: boolean; decision?: IsolationDecision | 'checkout' } = {}): Promise<void> {
    const claimed = this.claim(taskId, admission, continuation, opts);
    return 'spawned' in claimed ? claimed.spawned : Promise.reject(new TaskControlError(claimed.refused));
  }

  /**
   * The one claim every attempt start passes — the scheduler's, a run or force
   * start, a retry's, a continue, a resume, a repair. Checked and taken in one
   * synchronous step ({@link startRefusal}, the lease's `reserve`, then
   * {@link Attempts.start}), so no other start can take the same task or slot.
   * `reserve` rather than `refusal` answers for the slot, since being turned
   * down is what keeps this Session for the slot that frees (ADR-0059 L1).
   * The task is read here, as it stands: a start that awaited first — its run
   * opening, the user's answer — runs what the plan holds now, not what it
   * held when it was asked for. A task already claimed is not claimed again:
   * there is nothing to start.
   */
  private claim(taskId: string, admission: Admitted, continuation: Continuation | null = null, opts: { autoResumed?: boolean; revives?: boolean; decision?: IsolationDecision | 'checkout' } = {}): Claim {
    if (this.attempts.has(taskId)) return { spawned: Promise.resolve() };
    const refused = this.startRefusal(taskId, admission, opts);
    if (refused) return { refused };
    const task = this.store.get(taskId)!;
    const reserved = this.leases.reserve(this.attemptRequest(task));
    if ('refused' in reserved) return { refused: reserved.refused };
    // Taken whichever way it continues: a reopen a claim passed over would continue a later, unrelated start.
    const owed = this.starts.claimed(taskId);
    const continuing = continuation ?? owed;
    // The one point every start passes: Execute's fresh chance and a force start never call `retry` (ADR-0055 D8).
    if (continuing === null && !opts.autoResumed && !this.landing.nextRepair(taskId)) this.store.takeBackChecks(taskId);
    const decision = opts.decision ?? (this.runs.decided ? this.runs.decision : 'checkout');
    return { spawned: this.attempts.start(task, { admission, continuation: continuing, autoResumed: opts.autoResumed === true, lease: reserved.lease, isolationDecision: decision === 'checkout' ? null : decision }) };
  }

  private tell(level: 'info' | 'warn' | 'error', message: string): void {
    this.notifications[level](message);
    this.emit('onIsolationNotice', { level, message });
  }

  private say(messages: readonly LandingMessage[]): void {
    for (const { level, text, repairLog } of messages) {
      if (repairLog) this.tell(level, text);
      else this.notifications[level](text);
    }
  }

  /**
   * Replay the start a dirty tree turned away. `stash` puts the user's tracked
   * changes on the git stash first, so the run isolates; `shared` runs this one
   * run in the workspace root, knowingly; `reread` reads the tree again, which
   * may turn the start away again.
   */
  async continueBlockedRun(how: 'stash' | 'shared' | 'reread'): Promise<void> {
    const resume = await this.runs.continueBlocked(how);
    if (resume) await resume();
  }
}

/** A scheduler composed with no Session behind it has nothing to host a child in. */
const NO_CHILD_PLANS: IRunner = {
  spawn: () => Promise.reject(new Error('This scheduler has no Session to host a child plan.')),
  stop: () => Promise.resolve(),
  stopAll: () => undefined,
  activeCount: 0,
};

const LIMIT_RESET_MESSAGE = 'Your usage limit has reset. Carry on with the task from where you stopped.';

const REVERTED_HOLD = 'reverted; retry or force start to run it again';

/** Why a resolver ends skipped once its conflict has ended some other way (ADR-0015). */
const RESOLVER_NOT_NEEDED = 'not needed: the conflict it was added for is gone';

/** A failure's notice, then the way back into the agent where it stopped on its login. */
function withSignInHint(hint: string | null, text: string): string {
  return hint ? `${text} ${hint}` : text;
}

/** What a failed task's notice says; a loop's check out of rounds says how many it ran. */
function failureText(task: Readonly<Task>, verdict: Verdict): string {
  if (outOfRounds(task)) return `Task "${task.title}" failed in all ${loopRoundOf(task)} rounds of its loop: ${verdict.reason}`;
  return `Task "${task.title}" failed verification: ${verdict.reason}`;
}

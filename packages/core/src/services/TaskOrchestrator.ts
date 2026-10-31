import { Task, TaskSnapshot, Verdict, RunnerId, DEFAULT_RUNNERS, flattenTasks, flattenTasksWithParents, pausedOnLimit, waitsForReset, waitsMidAttempt, type RunSettings } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { INotification } from '../interfaces/INotification';
import type { IRunner, QueuedTaskMessage } from '../interfaces/IRunner';
import type { TaskShell, TaskShellSite } from '../interfaces/IFileSystem';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { RunnerModelRef } from '../models/RunnerCommand';
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
import { IsolationRunController } from './IsolationRunController';
import { completesTask, Landing, type LandingMessage, type LandingOutcome, type UnlandedOutcome } from './Landing';
import { LimitPauses, type LimitWait, type ResumeNow } from './LimitPauses';
import { IDLE_RUN, heldFrom, nextRunState, type RunEvent, type RunState } from './runState';
import { Attempts, type Admitted, type AttemptEnded, type EndedAttempt, type TaskAttemptSnapshot } from './Attempts';
import { TaskControlError } from './TaskControlError';
import { landed, planStartWaits, selectReadyTasks, startWaits, waitOf, type ForcedStart, type Readiness, type StartRuleInput, type StartWait, type StartWaitKind } from './readiness';
import type { ResearchTasks } from './ResearchTasks';
import { blockingFailures, planBlocks, repeatingChecks } from './blocking';
import { betweenRounds, loopRoundOf, outOfRounds } from '../models/Loop';
import { decidesIsolation, type Continuation } from './attemptKind';
import type { SkillLookup } from './taskSkills';
import { SkillsService } from './SkillsService';
import { capConflictFiles } from './conflictFiles';
import { resolveWorkspaceEnv, type WorkspaceEnv } from './workspaceEnv';
import { continuability, sessionOwner } from './continuation';
import { quotedList } from '../utils/quotedList';
import { inBranchRefusal, landedOnOf, revertReach, revertScope, type RevertScope, type TaskRevertPreview } from './taskRevert';
import type { RunMergeView, RunActivity } from './SessionMessage';
import { ScriptRunner } from './ScriptRunner';
import type { StoredHandoff } from '../models/Handoff';
import { userTaskHandoff } from '../models/DerivedHandoff';
import type { TaskLogReader } from './readTask';
import { leasedIsolation } from './leasedIsolation';
import type { SessionHeld } from './sessionLease';

export { TaskControlError } from './TaskControlError';

/** What ran an automatic Merge all: a task reaching its merge gate, or the run settling with landed work unmerged. */
export type AutoMergeTrigger = { kind: 'gate'; taskId: string } | { kind: 'run_end' };

/**
 * Who opened a run (ADR-0029): a call the user made, or one made for them; a
 * call of the supervisor's own; a usage-limit reset resuming what it paused;
 * or a loop carried on with no scheduler (ADR-0045 L5). Only the user's starts
 * a run's supervision afresh.
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

/** A force start queued behind its dependencies (see {@link TaskOrchestrator.forceStartTask}). */
interface QueuedStart {
  /** The merge gate as it stood when the user forced the start: every surface confirms that one first (ADR-0020). */
  pastGate: readonly string[];
  /** What it last said of what holds it back, so it says so once. */
  notice?: string;
  /**
   * Judged by the whole start rule, as the scheduler judges a task, rather
   * than as a force start: asked for by the user's act, and past nothing.
   */
  asScheduled?: true;
}

/**
 * How many runners one tick waits on to attach at once. One at a time, a
 * fan-out takes attach time times its width; all at once, every harness boots
 * together on one machine.
 */
export const STARTS_AT_ONCE = 8;

/** What keeps a queued force start waiting, with nothing to say: it starts once these clear. */
const QUEUED_WAITS: ReadonlySet<StartWaitKind> = new Set<StartWaitKind>(['queued', 'completing', 'merging', 'start-hold', 'unapproved']);

/** A force start the user made now: their own act, past the whole merge gate they confirmed. */
const FORCED_NOW: ForcedStart = { queued: false };

/**
 * The wiring a {@link TaskOrchestrator} runs on, every collaborator resolved.
 * {@link TaskOrchestrator.compose} is the only production caller; tests build
 * one through it too. The constructor makes nothing itself, so there is exactly
 * one place defaults live.
 */
export interface TaskOrchestratorDeps {
  /** What starting a research task owes the planner (ADR-0037 R3); starts are bounded by the run's Parallel limit. */
  research?: Pick<ResearchTasks, 'started'>;
  config: IConfig;
  notifications: INotification;
  runner: IRunner;
  /** Runs script tasks' bodies (ADR-0035), in place of a registered runner. */
  scriptRunner: IRunner;
  store: PlanStore;
  output: TaskOutputSource;
  /** The plan's isolation run and the open run's lifecycle (ADR-0013). */
  runs: IsolationRunController;
  /** A passed attempt's work onto the integration branch, and any conflict repair. */
  landing: Landing;
  registry: RunnerRegistry | null;
  /** The workspace root, read at call time — VS Code can change it. */
  workspaceRoot: () => string;
  /** The workspace's own variables for a task's cwd (ADR-0016). */
  workspaceEnv: (cwd: string) => Promise<WorkspaceEnv>;
  /** The skill catalog over workspace roots, as `workspaceSkillRoots` orders them — read at each spawn. */
  skillsAt: (roots: readonly string[]) => SkillLookup;
  /** What the task's last saved attempt did, or null when it left no log (ADR-0020). */
  previousAttemptFromLog: (taskId: string) => string | null;
  previousHandoffFromLog: (taskId: string) => StoredHandoff | undefined;
  /**
   * The newest attempt the task has a saved log for, 0 for none. An attempt's
   * log is saved under its number, so a new one is numbered past a log kept
   * from before the task had ledgers.
   */
  lastLoggedAttempt: (taskId: string) => number;
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
  /** A read-only attempt's shell (ADR-0046); absent, its runner is given no `run_command`. */
  taskShell?: (site: TaskShellSite) => TaskShell | undefined;
  /** The session's web fetcher for one read-only attempt (ADR-0046); absent, its `fetch` and `web_search` are not available. */
  taskWebFetcher?: (task: string) => IWebFetcher | undefined;
  /** Keep a read-only attempt's saved patch beside its log (ADR-0050); absent, `save_patch` is not available. */
  keepPatch?: (taskId: string, attempt: number, patch: Buffer) => string;
  /**
   * Write an attempt's whole handoff into the log of the attempt `sessionId`
   * ran (ADR-0047). A task that ran no session, a user task, gets a log of its own.
   */
  recordHandoff: (sessionId: string | undefined, taskId: string, handoff: StoredHandoff) => void;
  /** The session's saved task logs, which a task's `read_task` reads handoffs from (ADR-0047). */
  taskLog: TaskLogReader;
}

/**
 * What a caller supplies to {@link TaskOrchestrator.compose}; every optional
 * one gets its default there. This is what a host or test chooses, not the
 * resolved wiring the orchestrator itself runs on.
 */
export interface TaskOrchestratorOptions {
  /** What starting a research task owes the planner (ADR-0037 R3). */
  research?: Pick<ResearchTasks, 'started'>;
  config: IConfig;
  notifications: INotification;
  runner: IRunner;
  scriptRunner?: IRunner;
  store?: PlanStore;
  output?: TaskOutputSource;
  isolation?: IWorktreeIsolation;
  registry?: RunnerRegistry | null;
  workspaceRoot?: () => string;
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
  taskShell?: (site: TaskShellSite) => TaskShell | undefined;
  taskWebFetcher?: (task: string) => IWebFetcher | undefined;
  keepPatch?: (taskId: string, attempt: number, patch: Buffer) => string;
  recordHandoff?: (sessionId: string | undefined, taskId: string, handoff: StoredHandoff) => void;
  taskLog?: TaskLogReader;
  /**
   * Who holds the session when it is not this host, read before each change
   * to the run (ADR-0049); the run is changed only while it answers null.
   */
  sessionHeld?: () => SessionHeld | null;
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
  private mergesInFlight = 0;
  /*
   * Retry counts and holds describe a task across attempts, so they
   * deliberately live outside the attempt record: ending an attempt must not
   * forget that the user held the task or how often it was retried.
   */
  private retryCounts = new Map<string, number>();
  /** A Merge all is under way: no ops task starts until it ends (ADR-0020). */
  private merging = false;
  /** The last "waiting for Merge all" notice, so a run paused at a gate says it once, not on every tick. */
  private gateNotice = '';
  /**
   * Tasks pulled out of auto-scheduling (user-cancelled, marked not done, or a
   * start that could not reach its runner), each with the reason the surfaces
   * show. They stay 'pending' — "not executed" — but the scheduler skips them
   * until the user retries or force-starts, which would otherwise loop forever
   * on a task whose spawn always throws.
   */
  private onHold = new Map<string, string>();
  /**
   * The holds someone chose (a stop, a completion taken back). Starting the
   * plan again or editing it does not release these, or a task the user or
   * supervisor stopped would run at the next Execute plan; only a retry, a
   * force start or another plan does. A start's failure hold is not in it: a
   * new run is the "start it again" that hold asks for.
   */
  private chosenHolds = new Set<string>();
  /**
   * Force starts queued behind dependencies the scheduler will not start them
   * after: outside a run it drives, or past a failed dependency, which it
   * never forces. Each starts once those still under way have finished.
   */
  private queuedStarts = new Map<string, QueuedStart>();
  /** Conflict repairs owed with every slot taken and no scheduler to claim them: a freed slot starts them. */
  private owedRepairs = new Set<string>();
  /**
   * The checks whose loop goes on with no scheduler: each failed a round in a
   * run the scheduler was not driving, so nothing else would start what it
   * owes (ADR-0045 L5). Held here and not on the plan, because a Stop ends it
   * and a reload does not bring it back; an edit does neither. A loop stopped
   * by its body stays here, so a retry of that task resumes it (L7).
   */
  private readonly carriedLoops = new Set<string>();
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

  /**
   * The plan's isolation run and the open run's lifecycle (ADR-0013); see
   * {@link IsolationRunController}. Read and acted on there directly, except
   * Merge all: that goes through {@link mergeRun}, which keeps it apart from
   * ops tasks and starts the tasks its merge lets through.
   */
  readonly runs: IsolationRunController;
  /** A passed attempt's work onto the integration branch, and the conflict repair a landing may need. */
  private landing: Landing;

  private observers: OrchestratorObserver[] = [];
  private previousRounds = new Map<string, { round: number; report?: string }>();
  private runSettings: () => SchedulerRunSettings | undefined;
  private isApproved: (taskId: string) => boolean;

  constructor(deps: TaskOrchestratorDeps) {
    this.config = deps.config;
    this.notifications = deps.notifications;
    this.store = deps.store;
    this.runs = deps.runs;
    this.landing = deps.landing;
    this.runSettings = deps.runSettings;
    this.isApproved = deps.isApproved;
    this.attempts = new Attempts({
      config: deps.config,
      notifications: deps.notifications,
      runner: deps.runner,
      scriptRunner: deps.scriptRunner,
      store: deps.store,
      output: deps.output,
      runs: deps.runs,
      landing: deps.landing,
      registry: deps.registry,
      workspaceRoot: deps.workspaceRoot,
      workspaceEnv: deps.workspaceEnv,
      skillsAt: deps.skillsAt,
      previousAttemptFromLog: deps.previousAttemptFromLog,
      previousHandoffFromLog: deps.previousHandoffFromLog,
      lastLoggedAttempt: deps.lastLoggedAttempt,
      ...(deps.taskShell ? { taskShell: deps.taskShell } : {}),
      ...(deps.taskWebFetcher ? { taskWebFetcher: deps.taskWebFetcher } : {}),
      ...(deps.keepPatch ? { keepPatch: deps.keepPatch } : {}),
      recordHandoff: deps.recordHandoff,
      taskLog: deps.taskLog,
      ...(deps.research ? { research: deps.research } : {}),
      host: {
        settle: (ended) => this.settle(ended),
        completing: (taskId) => this.completing.has(taskId),
        retried: (taskId) => (this.retryCounts.get(taskId) ?? 0) > 0,
        previousRound: (taskId) => this.previousRounds.get(taskId),
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
      keepWorktree: (taskId) => this.runs.release(taskId, { keep: true }),
      settled: (taskId) => this.afterVerdict(taskId),
      resume: (taskId, now) => this.resumeTask(taskId, now),
    });

    this.store.onMutate = () => this.emit('onTaskChanged');
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
    const git = options.isolation ?? createWorktreeIsolation({ config: options.config, ...(options.plannedWith ? { plannedWith: options.plannedWith } : {}) });
    const isolation = options.sessionHeld ? leasedIsolation(git, options.sessionHeld) : git;
    const workspaceRoot = options.workspaceRoot ?? (() => process.cwd());
    // The listener callbacks fire only after construction, so the reference
    // below is settled by the time any of them runs.
    const runs = new IsolationRunController({
      isolation,
      config: options.config,
      notifications: options.notifications,
      workspaceRoot,
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
    const landing = new Landing({ runs, config: options.config, tasks: store, ...(options.plannedWith ? { plannedWith: options.plannedWith } : {}) });
    const orchestrator = new TaskOrchestrator({
      config: options.config,
      notifications: options.notifications,
      runner: options.runner,
      scriptRunner: options.scriptRunner ?? new ScriptRunner(),
      store,
      output,
      runs,
      landing,
      registry: options.registry ?? null,
      workspaceRoot,
      workspaceEnv: options.workspaceEnv ?? ((cwd) => resolveWorkspaceEnv(cwd)),
      skillsAt: options.skillsAt ?? ((roots) => new SkillsService(roots)),
      previousAttemptFromLog: options.previousAttemptFromLog ?? (() => null),
      previousHandoffFromLog: options.previousHandoffFromLog ?? (() => undefined),
      lastLoggedAttempt: options.lastLoggedAttempt ?? (() => 0),
      runSettings: options.runSettings ?? (() => undefined),
      isApproved: options.isApproved ?? (() => true),
      research: options.research,
      ...(options.taskShell ? { taskShell: options.taskShell } : {}),
      ...(options.taskWebFetcher ? { taskWebFetcher: options.taskWebFetcher } : {}),
      ...(options.keepPatch ? { keepPatch: options.keepPatch } : {}),
      recordHandoff: options.recordHandoff ?? (() => undefined),
      taskLog: options.taskLog ?? { attempts: () => [], events: () => [] },
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

  approveCheckpoint(taskId: string): void {
    this.attempts.approveCheckpoint(taskId);
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
   * message as the next one, ahead of anything queued, without the task
   * waiting for input in between. A task already waiting for input just takes it.
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

  /** Force send a message not yet delivered, queued or handed over; false once it was delivered. */
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
    return this.isScheduling || this.attempts.size > 0 || this.loopsCarriedOn().length > 0;
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
   * dirty checkout parked for Stash and continue to replay, or a loop carried
   * on with no scheduler. A Stop is owed to it, whether or not anything runs.
   * A carried loop a body task stopped starts nothing, so it is not here: see
   * {@link loopCarried}.
   */
  get startsPending(): boolean {
    return this.admissions > 0 || this.queuedStarts.size > 0 || this.owedRepairs.size > 0 || this.runs.blocked || this.store.allTasks.some(waitsForReset) || this.loopsCarriedOn().length > 0;
  }

  /**
   * A loop is carried on, one a body task stopped included. Nothing of that
   * one starts by itself, so nothing here moves a task on, but a retry that
   * passes would resume it: a Stop is owed to it too (ADR-0045 L7).
   */
  get loopCarried(): boolean {
    return [...this.carriedLoops].some((id) => this.store.get(id)?.loop);
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
   * Never alongside ops work, either way round ({@link mergeExcludes}).
   */
  async mergeRun(): Promise<IsolationMergeResult> {
    return this.mergeLanded();
  }

  private async mergeLanded(trigger?: AutoMergeTrigger): Promise<IsolationMergeResult> {
    const excluded = this.attempts.excludingMerge();
    if (excluded) {
      const title = this.store.get(excluded)?.title ?? excluded;
      throw new TaskControlError(`Ops task "${title}" is running in your checkout: Merge all once it has finished.`);
    }
    this.mergesInFlight++;
    this.merging = true;
    let result: IsolationMergeResult;
    try {
      result = await this.runs.merge();
    } catch (err) {
      if (!trigger) throw err;
      result = { outcome: 'failed', repo: SELF_REPO };
      this.tell('error', `Automatic Merge all could not finish: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.merging = --this.mergesInFlight > 0;
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
    if (this.mergesAtClose) await this.mergeLanded({ kind: 'run_end' });
    await this.runs.close();
  }

  /**
   * Whether closing the run merges what landed, with nobody asked. The run
   * says it has ended before it closes, and a list read in between must not
   * name a Merge all it is about to do itself (ADR-0053). A Stop takes the run
   * out of isolating and a merge that stopped blocks this, so neither wait is hidden.
   */
  get mergesAtClose(): boolean {
    return this.mergesAutomatically() && !this.autoMergeBlocked && !this.merging && this.settled && this.runs.isolating
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
    return this.onHold.get(taskId) ?? null;
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
      onHold: this.onHold,
      approved: this.isApproved,
      runs: this.runs,
      merging: this.merging,
      startsHeld: this.startHolds > 0,
      completing: this.completing,
      queued: this.queuedStarts,
      conflictResolver: (taskId) => this.landing.liveResolvers(taskId)[0]?.id,
    };
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
   * and something will claim it, the scheduler or {@link owedRepairs}. Nothing
   * saves this: a reload or a Stop leaves the conflict waiting on the user.
   */
  private owesRepair(task: Readonly<Task>): boolean {
    if ((task.status !== 'pending' && task.status !== 'approved') || this.onHold.has(task.id) || !this.landing.nextRepair(task.id)) return false;
    return this.owedRepairs.has(task.id) || this.scheduledRun;
  }

  /** The failed tasks a task not started yet waits on, through its dependencies (ADR-0034); empty when it is not blocked. */
  getBlockedBy(taskId: string): string[] {
    return blockingFailures(this.store.planTasks).get(taskId) ?? [];
  }

  /**
   * `edited`: the plan is the last one edited, not a new one. Only a Stop
   * withdraws a queued start (ADR-0035), so one of a task the edit keeps
   * stays queued: a script task waiting at its merge gate still starts at
   * Merge all.
   */
  loadPlan(tasks: readonly Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS], edited = false): void {
    // Refused before the plan being replaced is ended: a throw past that
    // would leave its run scheduling over a plan half loaded.
    assertAssignedRunners(tasks, planRunners);
    const queued = edited ? [...this.queuedStarts] : [];
    const carried = edited ? [...this.carriedLoops] : [];
    const chosen = this.chosenHoldsNow();
    // Ended before the plan is swapped, so nothing of the plan being replaced reaches the next one.
    const repairs = this.attempts.unload().filter((a) => a.kind.kind === 'repair' && a.worktree);
    this.store.load(tasks, planRunners);
    for (const a of repairs) this.unawaited(this.runs.release(a.taskId, { keep: true }, a.integration), `Could not keep the worktree of task "${this.store.get(a.taskId)?.title ?? a.taskId}"`);
    // A plan committed while the scheduler runs keeps that run, and its mode
    // with it; otherwise the next start decides afresh.
    this.runs.interrupt({ keepOpen: this.isScheduling });
    // A held or ended run goes with the plan it was in; a plan loaded from
    // disk holds no run either, so at a reset only its paused tasks resume,
    // as after any restart.
    this.transition({ type: 'load' });
    this.reviewApproved = false;
    this.retryCounts.clear();
    this.previousRounds.clear();
    this.onHold.clear();
    if (edited) this.restoreHolds(chosen);
    else this.chosenHolds.clear();
    // Saved on the task, so another process does not run what the user took back (ADR-0054).
    for (const t of this.store.allTasks) if (t.reverted) this.hold(t.id, REVERTED_HOLD, true);
    this.queuedStarts = new Map(queued.filter(([id]) => this.store.get(id)));
    this.carriedLoops.clear();
    for (const id of carried) if (this.store.get(id)?.loop) this.carriedLoops.add(id);
    this.owedRepairs.clear();
    this.recoverOrphans();
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
    if (this.isRunning || this.awaitsResume || this.owedRepairs.size > 0) return this.reconcilePlan(tasks, planRunners);
    const before = this.store.planTasks;
    this.loadPlan(tasks, planRunners, true);
    this.store.resetForRun({ edited: true });
    this.retireResolversLeft(before);
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
    const was = new Map(before.map((task) => [task.id, task]));
    for (const check of this.store.allTasks) {
      if (!outOfRounds(check)) continue;
      const prior = was.get(check.id);
      if (prior && outOfRounds(prior)) continue;
      this.closeLoop(check, LOOP_OUT_OF_ROUNDS);
      // Outside a run there is no supervisor to settle it for, and the next
      // run starts a failed check's rounds over; the close still stands.
      if (this.isRunning) this.emit('onTaskSettled', { taskId: check.id });
    }
    // An edit may have taken the last task waiting on a reset out of the plan, or ended its pause.
    this.limitPauses.recount();
  }

  /**
   * Begin the full-plan run afresh, as Execute does with no open run to join.
   * Whatever an earlier run left goes: its state, which {@link start} would
   * take as a run already under way; its scheduled resumes and execution log;
   * and, as the plan is loaded over
   * itself, its retry counts, holds, loop rounds and review approval. Every
   * task not done is ready to run again, and the scheduler starts it; a plan
   * with nothing left to run ends at once, and the scheduler says so, but for
   * `keepFailed`: failures nobody asked this run to try again (ADR-0030).
   */
  async beginRun(origin: RunOrigin, keepFailed?: ReadonlySet<string>): Promise<void> {
    this.stop('restart');
    this.store.clearLog();
    this.store.resetForRun({ keepFailed });
    const chosen = this.chosenHoldsNow();
    this.loadPlan(this.store.planTasks, [...this.store.planRunners]);
    this.restoreHolds(chosen);
    await this.approveReview(origin);
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
      if (a.worktree) this.unawaited(this.runs.release(a.taskId, { keep: true }, a.integration), `Could not keep the worktree of task "${this.store.get(a.taskId)?.title ?? a.taskId}"`);
    }
    this.runs.interrupt();
    this.releaseUnchosenHolds();
    this.withdrawRepairs();
    this.endCarriedLoops();
    if (reason === 'user') this.withdrawQueuedStarts();
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
    this.owedRepairs.clear();
    for (const t of this.store.allTasks) {
      if ((t.status === 'pending' || t.status === 'approved') && this.runs.current?.tasks[t.id]?.status === 'conflict') this.store.markAwaitingUser(t.id, 'conflict');
    }
  }

  /**
   * A force start behind a dependency lifted a reverted task's hold for that
   * start alone, in the queue or left to the scheduler. With the start
   * withdrawn, the task stays what the user took back (ADR-0054).
   */
  private withdrawQueuedStarts(): void {
    this.queuedStarts.clear();
    for (const t of this.store.allTasks) if (t.reverted) this.hold(t.id, REVERTED_HOLD, true);
  }

  private chosenHoldsNow(): [string, string][] {
    return [...this.onHold].filter(([id]) => this.chosenHolds.has(id));
  }

  private restoreHolds(holds: readonly [string, string][]): void {
    for (const [id, reason] of holds) {
      if (this.store.get(id)) this.hold(id, reason, true);
    }
  }

  private releaseUnchosenHolds(): void {
    for (const id of [...this.onHold.keys()]) {
      if (!this.chosenHolds.has(id)) this.onHold.delete(id);
    }
  }

  private hold(taskId: string, reason: string, chosen: boolean): void {
    this.onHold.set(taskId, reason);
    if (chosen) this.chosenHolds.add(taskId);
    else this.chosenHolds.delete(taskId);
  }

  /** Name the tasks a stop took down, so none is mistaken for one still at work. */
  private sayStopped(stopped: readonly EndedAttempt[]): void {
    if (stopped.length === 0) return;
    const one = stopped.length === 1;
    const named = quotedList(stopped.map((a) => this.store.get(a.taskId)?.title ?? a.taskId));
    const kept = stopped.some((a) => a.worktree)
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
        if (!this.startRound(task.id)) this.notifications.error(ended.unresumed ?? failureText(this.store.get(task.id) ?? task, verdict));
        // A Stop since it was claimed ended its loop with it.
        else if (!this.isScheduling && ended.attempt.admission.current()) this.carriedLoops.add(task.id);
        if (ended.attempt.worktree) await this.runs.release(task.id, { keep: true });
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
        this.hold(task.id, failure.hold, false);
      }
      if (failure.leaves !== 'held' || !failure.preserveWorktree) {
        await this.runs.release(task.id, { keep: failure.leaves === 'failed' && failure.keepWorktree });
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
      this.store.setTaskOutputSummary(taskId, summarizeOutput(reason, ''));
      // Its landing may be what threw, so the release does not wait on it.
      if (attempt.worktree) this.unawaited(this.runs.release(taskId, { keep: true }), `Could not keep the worktree of task "${title}"`);
    }
    this.tell('error', attempt ? `Task "${title}" could not be settled: ${reason}` : `Task "${title}" settled, but what follows it could not be scheduled: ${reason}`);
    this.unawaited(this.afterVerdict(taskId), 'The run could not be closed');
  }

  /** Work nothing awaits: a rejection is said, not left unhandled. */
  private unawaited(work: Promise<unknown>, failure: string): void {
    work.catch((err: unknown) => {
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
    await this.startQueued();
    this.startOwedRepairs(this.admittedNow());
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
    this.closeLoop(task, LOOP_PASSED);
    onLanded();
    this.say(outcome.messages);
    await this.landResolved(task.id, admission);
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
      if (!this.isScheduling) this.owedRepairs.add(task.id);
      this.tell('info', `Task "${task.title}" is repaired once ${waitsFor}.`);
    }
  }

  /** Start the repairs {@link settleUnlanded} left owed, as slots and any start hold allow. */
  private startOwedRepairs(admission: Admitted): void {
    if (this.startHolds > 0) return;
    for (const id of [...this.owedRepairs]) {
      if (this.slotsFull()) return;
      // Held as any start on that runner is; the reset ticks, and it is still owed then.
      if (this.repairWait(id) === 'usage-limit') continue;
      this.owedRepairs.delete(id);
      const task = this.store.get(id);
      // A retry, skip or edit since has settled it some other way.
      if (!task || task.status !== 'pending' || this.attempts.has(id) || !this.landing.nextRepair(id)) continue;
      const claimed = this.claim(id, admission);
      if ('refused' in claimed) {
        // Nothing will ask again, so it waits on the user as a repair that could not start does.
        this.store.markAwaitingUser(id, 'conflict');
        this.tell('warn', `The conflict of task "${task.title}" is not repaired: ${claimed.refused}`);
      } else this.unawaited(claimed.spawned, `Could not start the repair of task "${task.title}"`);
    }
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
    this.store.markSkipped(id, RESOLVER_NOT_NEEDED);
    this.onHold.delete(id);
    this.queuedStarts.delete(id);
    this.tell('info', `Task "${resolver.title}" was skipped: the conflict it was added for is gone.`);
  }

  /** A planner's remove reaches no {@link releaseTask}: what it took out of the plan since `before` ends its conflicts here. */
  private retireResolversLeft(before: readonly Task[]): void {
    for (const { id } of flattenTasks(before)) if (!this.store.get(id)) this.retireResolvers(id);
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
    const active = this.attempts.size;
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
    return this.runSettings()?.mergeAtGatesAutomatically ?? false;
  }

  /** A Merge all is under way. */
  get isMerging(): boolean { return this.merging; }

  /** A gate reached now is merged with nobody asked: the setting is on, and no merge has stopped it. */
  get mergesAtGates(): boolean { return this.mergesAutomatically() && !this.autoMergeBlocked; }

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
   * task's next attempt needs that ({@link decidesIsolation}). False while a
   * dirty tree waits on the user; `resume` is what their choice replays.
   */
  private async openFor(taskId: string, origin: RunOrigin, resume: () => Promise<void>): Promise<boolean> {
    this.openRun(origin);
    return !decidesIsolation(this.attempts.nextKind(taskId)) || this.runs.decide(resume);
  }

  /**
   * {@link openFor} for an explicit start under `admission`. A Stop while the
   * run opened interrupts that opening too, which then opens nothing; the
   * start says it was stopped rather than going quiet as if a dirty tree were
   * waiting on the user.
   */
  private async openForAdmitted(taskId: string, origin: RunOrigin, resume: () => Promise<void>, admission: Admitted): Promise<boolean> {
    const opened = await this.openFor(taskId, origin, resume);
    if (!admission.current()) throw new TaskControlError(STOPPED_BEFORE_START);
    return opened;
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
      this.owedRepairs.delete(taskId);
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
    const ended = this.attempts.end(taskId, 'cancel');
    // A stopped repair did not land, so its conflict waits on the user, as the run's Stop leaves it.
    if (ended?.kind.kind === 'repair') this.store.markAwaitingUser(taskId, 'conflict');
    else {
      this.store.markPending(taskId);
      this.hold(taskId, 'cancelled; retry or force start to run it again', true);
    }
    this.emit('onTaskChanged');
    await this.runs.release(taskId, worktree, ended?.integration);
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
        this.attempts.end(taskId, 'release');
        // Not left in progress while its worktree goes: it is leaving the plan, not running.
        if (this.store.get(taskId)?.status === 'in_progress') this.store.markPending(taskId);
        await this.runs.release(taskId, { keep: false });
      }
    } finally {
      this.releasing.delete(taskId);
    }
    this.onHold.delete(taskId);
    this.owedRepairs.delete(taskId);
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
    const landed = ended?.integration ?? this.landing.landVouched(task);
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
      this.closeLoop(task, LOOP_CHECK_MARKED_COMPLETE);
    } else this.settleUnlanded(task, landing, admission);
    this.logAndArchive(task, verdict);
    if (completesTask(landing)) {
      this.onHold.delete(taskId);
      this.notifications.info(`Task "${task.title}" marked complete.`);
      this.say(landing.messages);
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
    this.hold(taskId, 'marked not done; retry or force start to run it again', true);

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
      this.hold(id, REVERTED_HOLD, true);
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
      this.store.markSkipped(taskId, reason?.trim() || undefined);
      this.owedRepairs.delete(taskId);
      // Skipped itself, a resolver leaves its conflict free for another worker.
      this.runs.takeResolver(taskId);
      this.retireResolvers(taskId);
      this.closeLoop(task, LOOP_CHECK_SKIPPED);
      this.onHold.delete(taskId);
      this.notifications.info(`Task "${task.title}" skipped: none of its work lands, and the tasks that depend on it go ahead without it once the work it waited on is done.`);
      this.emit('onTaskChanged');
      await this.runs.release(taskId, { keep: true }, ended?.integration);
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
    await this.whileAdmitted(async (admission) => {
      // A retried task's own pause ends with it; that may release a held run,
      // which the tick below then schedules (ADR-0018, U1).
      this.limitPauses.cancel(taskId);
      this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
      const ended = this.attempts.end(taskId, 'retry');
      const movedFrom = this.movedFrom(task);
      this.store.retry(taskId);
      this.owedRepairs.delete(taskId);
      // Now, not once the worktree has gone: a tick in between would start it.
      this.retireResolvers(taskId);
      if (movedFrom) this.store.setCarriedFrom(taskId, movedFrom);
      this.onHold.delete(taskId);
      this.emit('onTaskChanged');
      if (movedFrom) {
        // The earlier runner's work is the new attempt's to restore, so its worktree stays until that prepare replaces it.
        await ended?.integration;
      } else {
        // A retry starts over from the integration tip, which by now holds what its
        // predecessors landed; the old attempt's worktree has nothing to offer it.
        await this.runs.release(taskId, { keep: false }, ended?.integration);
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
    await this.whileAdmitted(async (admission) => {
      if (!(await this.openForAdmitted(taskId, origin, () => this.continueTask(taskId, message, origin, revives), admission))) return;
      // The run may have started it while opening, or the task changed: the
      // claim below must be the only one, and continues the task as it is now.
      const now = this.store.get(taskId);
      const resumable = now && continuability(now);
      if (this.attempts.has(taskId) || !resumable?.ok) return;
      this.refuseClaim(taskId, admission, { revives });

      this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
      this.attempts.end(taskId, 'retry');
      this.store.retry(taskId);
      this.onHold.delete(taskId);
      // Claimed before anything is awaited, so a running scheduler never sees the
      // pending task and starts it afresh. Its prepare replaces the old worktree.
      const started = this.claimed(taskId, admission, { message: text, resumeSessionId: resumable.sessionId });
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
    this.onHold.delete(taskId);
    // Started alone, it starts again alone: no scheduler would claim it.
    if (from === 'idle' || from === 'endedOnFailure') this.queuedStarts.set(taskId, { pastGate: [] });
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
      const opened = await this.openFor(taskId, origin, () => this.resumeTask(taskId, now));
      // One asked for now answers its caller as stopped; any other was stopped with its run, which said so.
      if (asked && !admission.current()) throw new TaskControlError(STOPPED_BEFORE_START);
      if (!opened) return;
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
      this.onHold.delete(taskId);
      const message = asked && now?.message ? `${LIMIT_RESET_MESSAGE}\n\n${now.message}` : LIMIT_RESET_MESSAGE;
      const continuation = resumeSessionId ? { message, resumeSessionId } : null;
      const started = this.claimed(taskId, admission, continuation, { autoResumed: true });
      const resumed = this.limitPauses.resumed() ? this.start(origin) : Promise.resolve();
      // No tick follows a task started alone, and a repair the limit held is owed its start now.
      this.startOwedRepairs(admission);
      // Both are awaited even if one fails: the claimed attempt's start must not
      // be left unhandled because restarting the run threw.
      await Promise.all([resumed, started]);
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
    this.refuseOpsDuringMerge(taskId, FORCED_NOW);
    const queued = this.queueBehindDependencies(task);
    if (queued) return queued;
    this.queuedStarts.delete(taskId);
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
    if (!this.isScheduling) this.queuedStarts.set(taskId, { pastGate: [] });
    this.emit('onTaskChanged');
  }

  /** A start of this task waits in the queue, and starts with nobody asked once what holds it clears. */
  startQueuedFor(taskId: string): boolean {
    return this.queuedStarts.has(taskId);
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
    this.queuedStarts.set(taskId, { pastGate: [], asScheduled: true });
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
      if (!(await this.openForAdmitted(taskId, origin, resume, admission))) return;
      // The run may have started it while opening.
      if (this.attempts.has(taskId)) return;
      // A Merge all may have begun while it opened.
      this.refuseOpsDuringMerge(taskId, forced);
      if (forced.queued && (this.holdsQueued(taskId, forced) || this.slotsFull())) {
        this.queuedStarts.set(taskId, { pastGate: forced.pastGate, ...(forced.asScheduled ? { asScheduled: true } : {}) });
        return;
      }
      const task = this.store.get(taskId);
      const requeued = !forced.queued && task ? this.queueBehindDependencies(task) : null;
      if (requeued) return requeued;
      this.refuseClaim(taskId, admission, { revives });
      // Nothing else would run a check whose fix has landed, so this is its next
      // round. Forced again after any other failure, a check starts its rounds
      // over, as a retry does (ADR-0045 L5, L7).
      if (task && this.ownsNextRound(task)) this.repeatCheck(task);
      else if (this.store.isFailed(taskId)) this.store.startRoundsOver(taskId);
      // A force start is the user's own act, so it ends the task's pause: its
      // resume goes, and the hold with it once nothing else waits (U1).
      this.limitPauses.cancel(taskId);
      this.onHold.delete(taskId);
      this.notePastGate(taskId);
      await this.claimed(taskId, admission, null, { revives });
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
    const waiting = (waitOf(waits, 'dependencies') ?? waitOf(waits, 'queued'))?.waiting ?? [];
    if (waiting.length === 0) return null;
    this.onHold.delete(task.id);
    if (!this.leftToScheduler(task)) this.queuedStarts.set(task.id, { pastGate: this.getMergeGate(task.id) });
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
   * Starts the queued force starts nothing holds back any more. One the
   * scheduler now drives the run for, that nothing blocks and that was not
   * confirmed past a gate, is left to it. One at a gate the user did not
   * confirm — work that landed after they forced the start — waits for Merge
   * all, or for another force start, and says so once.
   */
  private async startQueued(): Promise<void> {
    for (const [id, queued] of [...this.queuedStarts]) {
      const task = this.store.get(id);
      if (!task || this.attempts.has(id) || task.status === 'completed' || task.status === 'skipped') {
        this.queuedStarts.delete(id);
        continue;
      }
      // The start rule leaves slots to the claim, so a start a full run would refuse waits in the queue for one.
      if (this.slotsFull()) continue;
      const waits = this.startWaits(task, task.research || queued.asScheduled ? undefined : { queued: true, pastGate: queued.pastGate });
      if (task.research && waits.length > 0) continue;
      if (queued.asScheduled && (waits.length > 0 || this.runState.kind === 'held')) {
        this.sayQueuedHeld(task, queued, waits);
        continue;
      }
      if (waits.some((w) => QUEUED_WAITS.has(w.kind))) continue;
      if (this.leftToScheduler(task) && queued.pastGate.length === 0) {
        this.queuedStarts.delete(id);
        continue;
      }
      const gate = waitOf(waits, 'merge-gate');
      if (gate) {
        this.sayQueuedAtGate(task, queued, gate.unmerged);
        continue;
      }
      this.queuedStarts.delete(id);
      try {
        const origin = task.research && (task.reportTo ?? task.researchOrigin)?.actor === 'supervisor' ? 'supervisor' : 'user';
        await this.startForced(id, origin, { queued: true, pastGate: queued.pastGate, ...(queued.asScheduled ? { asScheduled: true } : {}) });
      } catch (err) {
        this.tell('warn', `Task "${task.title}" did not start${queued.asScheduled ? '' : ' once its dependencies finished'}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

  private slotsFull(): boolean {
    return this.attempts.size >= this.config.maxParallelSessions;
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

  private refuseOpsDuringMerge(taskId: string, forced: ForcedStart): void {
    const task = this.store.get(taskId);
    if (task && waitOf(this.startWaits(task, forced), 'merging')) {
      throw new TaskControlError(`A Merge all is under way: ops task "${task.title}" can start once it has finished.`);
    }
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

  async tick(): Promise<void> {
    // What this tick starts was admitted as it began: a Stop during one of its awaits withdraws it.
    const admission = this.admittedNow();
    this.recoverOrphans();
    // A merge taken back out closes its gate again, before anything reads it.
    if (this.runs.readsMerged) await this.runs.refreshInHead();
    // Every way a dependency finishes ticks — a verdict, Mark complete, a skip,
    // a failed spawn — so a queued force start waiting on it is started here.
    await this.startQueued();
    this.startOwedRepairs(admission);
    if (!this.startsOnTick) return this.settleRun('tick');

    // Ahead of the run-complete check too: the turn may add work to a run
    // that would otherwise end under it. Its release ticks again.
    if (this.startHolds > 0) return;

    this.repeatChecks();
    let readiness = this.readiness();
    // Work merged by hand opens a gate as Merge all does; only git can tell.
    // A user task's gate counts too, though the scheduler never starts one.
    if (readiness.gated.length > 0 && (await this.runs.refreshInHead())) {
      this.autoMergeBlocked = false;
      readiness = this.readiness();
    }
    if (!this.startsOnTick) return;
    if (this.mergesAutomatically() && !this.autoMergeBlocked && !this.merging
      && this.attempts.excludingMerge() === undefined) {
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
    this.emit('onTick');
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
      if (decidesIsolation(this.attempts.nextKind(id)) && !(await this.runs.decide(() => this.tick()))) continue;
      if (!this.startsOnTick) return;
      if (!this.stillReady(id)) continue;
      const claimed = this.claim(id, admission);
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
    if (this.attempts.size > 0 || this.owedRepairs.size > 0) return;
    // A task on a usage limit keeps the run open: closed, it would be handed
    // over or merged before the work the reset resumes.
    if (this.runState.kind === 'held') return;
    if (this.runState.kind !== 'scheduling') {
      if (this.loopsCarriedOn().length > 0) return this.waitOnUser();
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

  private waitOnUser(): void {
    this.notifications.info('Remaining tasks require user action or are on hold.');
    this.sayGate();
    this.sayUnapprovedInLoop();
    this.emit('onTaskChanged');
    this.emit('onTick');
  }

  /**
   * A loop's check failed (ADR-0045). With `failed` evidence and rounds left,
   * a round starts: its body runs again as new attempts, each from the
   * integration tip, so it builds on what earlier rounds landed, and true says
   * the failure is the round's, not the task's. Approval is not spent by a
   * run, so the plan's approval of the body covers every round. Out of
   * rounds, the body still to run will not run. A body task the user skipped
   * has stopped the loop (L7): no round starts, and the skip stands. One they
   * reverted keeps its hold, which a round takes as any start does (L5, ADR-0054):
   * the rest of the body runs, and the loop waits for them to say.
   */
  private startRound(checkId: string): boolean {
    const check = this.store.get(checkId);
    if (!check?.loop) return false;
    if (outOfRounds(check)) {
      this.closeLoop(check, LOOP_OUT_OF_ROUNDS);
      return false;
    }
    if (!betweenRounds(check)) return false;
    const body = check.loop.body.flatMap((id) => this.store.get(id) ?? []);
    if (body.some((t) => t.status === 'skipped' && !LOOP_SKIPS.has(t.skipReason ?? ''))) return false;
    const [taken, runs] = [body.filter((t) => t.reverted), body.filter((t) => !t.reverted)];
    for (const task of runs.filter((t) => !this.attempts.has(t.id) && REPEATABLE.has(t.status))) {
      this.store.retry(task.id);
      this.onHold.delete(task.id);
      this.queuedStarts.delete(task.id);
    }
    const fixes = runs.length === 0 ? '' : ` ${quotedList(runs.map((t) => t.title))} ${runs.length === 1 ? 'runs' : 'run'} to fix what it found, then it checks again.`;
    const held = taken.length === 0 ? '' : ` ${quotedList(taken.map((t) => t.title))} ${taken.length === 1 ? 'was' : 'were'} reverted, so the loop waits for you to start ${taken.length === 1 ? 'it' : 'them'} again.`;
    this.tell('info', `Task "${check.title}" failed round ${loopRoundOf(check)} of ${check.loop.maxRounds}:${fixes}${held}`);
    return true;
  }

  /**
   * The loop is over (ADR-0045 L6): its check passed, or will run no more.
   * What of its body has not run, or did not pass, is not waited for: it ends
   * skipped, with why. A body task at work is left to finish.
   */
  private closeLoop(check: Readonly<Task>, reason: string): void {
    this.carriedLoops.delete(check.id);
    for (const id of check.loop?.body ?? []) {
      const task = this.store.get(id);
      if (!task || this.attempts.has(id) || !LEFT_UNDONE.has(task.status)) continue;
      this.store.markSkipped(id, reason);
      this.retireResolvers(id);
      this.onHold.delete(id);
      this.queuedStarts.delete(id);
    }
  }

  /**
   * A check whose round's body has all passed and landed runs again, as the
   * next round (ADR-0045 L5). Read off the plan at each tick rather than at a
   * body's verdict, so whatever finishes the body — a verdict, a retry, a Mark
   * complete, a reload in between — resumes the loop alike.
   */
  private repeatChecks(): void {
    let repeated = false;
    for (const id of repeatingChecks(this.store.planTasks)) {
      const check = this.store.get(id);
      if (!check?.loop || !(this.isScheduling || this.carriedLoops.has(id)) || this.attempts.has(id) || !check.loop.body.every((b) => landed(b, this.store, this.runs))) continue;
      this.repeatCheck(check);
      repeated = true;
    }
    if (repeated) this.emit('onTaskChanged');
  }

  private repeatCheck(check: Task): void {
    this.previousRounds.set(check.id, { round: loopRoundOf(check), report: check.outputSummary?.report });
    this.store.repeat(check.id);
    this.onHold.delete(check.id);
    this.notifications.info(`The fix for task "${check.title}" has landed: it checks again, round ${loopRoundOf(check)} of ${check.loop?.maxRounds}.`);
  }

  /**
   * Something will run this check between rounds without being asked: a
   * scheduler, the one a reset gives back, or its loop carried on (ADR-0045
   * L5). What the seam reads before it says so to anyone.
   */
  loopRunsOn(checkId: string): boolean {
    return this.scheduledRun || this.carriedLoops.has(checkId);
  }

  /** A start of this task would be its loop's next round: between rounds, its body landed, and nothing else will run it. */
  private ownsNextRound(task: Readonly<Task>): boolean {
    return this.loopStranded(task.id) && waitOf(this.startWaits(task), 'repeating')?.waiting.length === 0;
  }

  /** A check between rounds that nothing will run: it waits on a person, its failure no longer one its loop answers (ADR-0045 L5, ADR-0053). */
  loopStranded(taskId: string): boolean {
    const task = this.store.get(taskId);
    return !!task?.loop && !!waitOf(this.startWaits(task), 'repeating') && !this.loopRunsOn(taskId);
  }

  /** A tick starts something: the scheduler the plan, or the loops carried on, their tasks alone. */
  private get startsOnTick(): boolean {
    return this.isScheduling || this.loopsCarriedOn().length > 0;
  }

  /**
   * The carried loops with work owed now: a check between rounds whose loop
   * goes on, or a round waiting to start. None under a scheduler, which owes
   * them itself, or while a usage limit holds the run, which starts nothing.
   * One a body task stopped is not here until that task passes (L7).
   */
  private loopsCarriedOn(): Task[] {
    if (this.carriedLoops.size === 0 || this.isScheduling || this.runState.kind === 'held') return [];
    const repeating = repeatingChecks(this.store.planTasks);
    return [...this.carriedLoops].flatMap((id) => {
      const check = this.store.get(id);
      return check?.loop && (repeating.has(id) || check.status === 'pending' || check.status === 'approved') ? [check] : [];
    });
  }

  /**
   * The run that carried them is over, by a Stop or by what gives the run up
   * or clears it up: a retry of a body task that passes runs that task alone.
   */
  private endCarriedLoops(): void {
    this.carriedLoops.clear();
    this.loopNotice = '';
  }

  /** What a tick may start with no scheduler: the loops carried on, and nothing that depends on them. */
  carriedTasks(): Set<string> {
    return new Set(this.loopsCarriedOn().flatMap((check) => [check.id, ...check.loop?.body ?? []]));
  }

  /**
   * A task of a carried loop outside the user's approval record waits as any
   * does (ADR-0045, Consent). Said here, once, as well as listed: a run they
   * started one task of says nothing else of why the loop's next step does not come.
   */
  private sayUnapprovedInLoop(): void {
    const waiting = [...this.carriedTasks()].flatMap((id) => this.store.get(id) ?? []).filter((t) => waitOf(this.startWaits(t), 'unapproved'));
    const notice = waiting.length === 0
      ? ''
      : `A loop waits for your approval of ${quotedList(waiting.map((t) => t.title))}: start ${waiting.length === 1 ? 'it' : 'them'}, or execute the plan, and it goes on.`;
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
    if (!task || this.attempts.has(id) || this.attempts.size >= this.config.maxParallelSessions) return false;
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
   * marked complete, a resolver has its conflict, so a start of it would be a
   * second worker on it (ADR-0015), a revert is taking back work it depends on
   * or skipped it since (ADR-0054), it
   * is outside the user's approval record (ADR-0035), or every slot is taken.
   * Read in the same synchronous step as the claim it
   * guards, so nothing can change in between. `revives` is a start asked of a
   * task already skipped, as a force start or a continue may be: only that runs
   * one again. A retry has made it pending by the time it claims.
   */
  private claimRefusal(taskId: string, admission: Admitted, { revives = false }: { revives?: boolean } = {}): string | null {
    if (!admission.current()) return STOPPED_BEFORE_START;
    const task = this.store.get(taskId);
    if (!task) return `There is no task "${taskId}" in this plan any more.`;
    if (task.status === 'skipped' && !revives) return `Task "${task.title}" was skipped after this start was asked for${task.skipReason ? `: ${task.skipReason}` : ''}. Start it again to run it.`;
    if (this.completing.has(taskId)) return beingMarkedComplete(task);
    const [resolver] = this.landing.liveResolvers(taskId);
    if (resolver) return `Task "${resolver.title}" already resolves the conflict of task "${task.title}": skip or remove it first, or let it finish.`;
    if ([...this.reverting].some((reach) => reach.has(taskId))) return `A revert is taking back work task "${task.title}" depends on. Start it again once the revert has ended.`;
    if (!this.isApproved(taskId)) return `Task "${task.title}" waits for the user's approval: they approve it by starting it, or by executing the plan.`;
    const live = this.attempts.size;
    if (live >= this.config.maxParallelSessions) {
      return `${live} ${live === 1 ? 'task is' : 'tasks are'} already running, the most this session runs at once. Wait for one to finish, or stop one first.`;
    }
    return null;
  }

  /** An explicit start's refusal, before it changes anything: its caller's answer, as a {@link TaskControlError}. */
  private refuseClaim(taskId: string, admission: Admitted, opts: { revives?: boolean } = {}): void {
    const refused = this.claimRefusal(taskId, admission, opts);
    if (refused) throw new TaskControlError(refused);
  }

  /** An explicit start's claim, once {@link refuseClaim} let it through: its spawn, or the refusal as a rejection. */
  private claimed(taskId: string, admission: Admitted, continuation: Continuation | null = null, opts: { autoResumed?: boolean; revives?: boolean } = {}): Promise<void> {
    const claimed = this.claim(taskId, admission, continuation, opts);
    return 'spawned' in claimed ? claimed.spawned : Promise.reject(new TaskControlError(claimed.refused));
  }

  /**
   * The one claim every attempt start passes — the scheduler's, a run or force
   * start, a retry's, a continue, a resume, a repair. Checked and taken in one
   * synchronous step ({@link claimRefusal}, then {@link Attempts.start}), so
   * no other start can take the same task or slot.
   * The task is read here, as it stands: a start that awaited first — its run
   * opening, the user's answer — runs what the plan holds now, not what it
   * held when it was asked for. A task already claimed is not claimed again:
   * there is nothing to start.
   */
  private claim(taskId: string, admission: Admitted, continuation: Continuation | null = null, opts: { autoResumed?: boolean; revives?: boolean } = {}): Claim {
    if (this.attempts.has(taskId)) return { spawned: Promise.resolve() };
    const refused = this.claimRefusal(taskId, admission, opts);
    if (refused) return { refused };
    return { spawned: this.attempts.start(this.store.get(taskId)!, { admission, continuation, autoResumed: opts.autoResumed === true }) };
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

const LIMIT_RESET_MESSAGE = 'Your usage limit has reset. Carry on with the task from where you stopped.';

const REVERTED_HOLD = 'reverted; retry or force start to run it again';

/** Why a loop's body that did not run ends skipped once its loop is over (ADR-0045 L6). */
const LOOP_PASSED = 'not needed: its check passed';
const LOOP_OUT_OF_ROUNDS = 'not run: the loop ran out of rounds';
const LOOP_CHECK_MARKED_COMPLETE = 'not needed: its check was marked complete';
const LOOP_CHECK_SKIPPED = 'not needed: its check was skipped';

/** Why a resolver ends skipped once its conflict has ended some other way (ADR-0015). */
const RESOLVER_NOT_NEEDED = 'not needed: the conflict it was added for is gone';

/** The skips a loop made itself, which a new set of rounds undoes; any other is the user's, and stops the loop (L7). */
const LOOP_SKIPS: ReadonlySet<string> = new Set([LOOP_PASSED, LOOP_OUT_OF_ROUNDS, LOOP_CHECK_MARKED_COMPLETE, LOOP_CHECK_SKIPPED]);

/** A body task a round runs again: not at work, and not waiting on the user. */
const REPEATABLE: ReadonlySet<Task['status']> = new Set<Task['status']>(['pending', 'approved', 'completed', 'failed', 'skipped']);

/** A body task a closed loop leaves undone: it has not run, or it did not pass. */
const LEFT_UNDONE: ReadonlySet<Task['status']> = new Set<Task['status']>(['pending', 'approved', 'failed']);

/** What a failed task's notice says; a loop's check out of rounds says how many it ran. */
function failureText(task: Readonly<Task>, verdict: Verdict): string {
  if (outOfRounds(task)) return `Task "${task.title}" failed in all ${loopRoundOf(task)} rounds of its loop: ${verdict.reason}`;
  return `Task "${task.title}" failed verification: ${verdict.reason}`;
}

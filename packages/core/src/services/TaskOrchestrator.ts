import * as path from 'path';
import { Task, TaskSkillSnapshot, TaskSnapshot, Verdict, QueuedMessage, RunnerId, DEFAULT_RUNNERS, flattenTasksWithParents, taskOrderLabel } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { INotification } from '../interfaces/INotification';
import { isStructuredSession, type ITerminalRunner, type ITerminalSession, type QueuedTaskMessage, type RunnerTransport, type StructuredSessionCapability } from '../interfaces/ITerminalRunner';
import { summarizeOutput } from './promptAugment';
import { VerdictEngine } from './VerdictEngine';
import { BufferedTaskOutputSource } from './BufferedTaskOutputSource';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { PlanStore } from './PlanStore';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type {
  IsolationHandoff,
  IsolationMergeResult,
  IWorktreeIsolation,
  TreeSnapshot,
} from '../interfaces/IWorktreeIsolation';
import { createWorktreeIsolation } from './GitWorktreeIsolation';
import { SELF_REPO } from './isolationRecord';
import { IsolationRunController } from './IsolationRunController';
import { completesTask, Landing, type LandingMessage, type LandingOutcome, type UnlandedOutcome } from './Landing';
import { watchBlockingPrompts } from './blockingPrompts';
import { classifyRunnerStop, keepsTerminalReadable, stopsRunner, LingeringRunners, type AttemptEnd } from './runnerExit';
import { MessageQueue } from './MessageQueue';
import { mergeGate, selectReadyTasks, type Readiness } from './readiness';
import {
  attemptCwd, attemptPrompt, attemptTransport, checksTree, classifyAttempt, decidesIsolation, mergeExcludes, takesSkills,
  type AttemptKind, type Continuation,
} from './attemptKind';
import { resolveTaskSkills, TaskSkillsError, type SkillLookup } from './taskSkills';
import { SkillsService } from './SkillsService';
import { capConflictFiles } from './conflictFiles';
import { resolveWorkspaceEnv, type WorkspaceEnv } from './workspaceEnv';
import { givesCompletionTool, routeTransport } from './TransportRouter';
import { continuability } from './continuation';
import { quotedList } from '../utils/quotedList';
import type { MergeGateView } from './SessionMessage';

/**
 * The one notification channel out of the orchestrator. Everything that used
 * to travel over separate callbacks (onRefresh, onQueueReady) is an observer
 * event; the Session subscribes once and turns these into SessionMessages.
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
  onTick?(): void;
  onExecutionComplete?(): void;
  /** The run is parked behind queued user messages, with nothing live, until they are drained. */
  onQueueReady?(): void;
  onReviewNeeded?(data: { tasks: Task[]; planRunners: RunnerId[] }): void;
  onReviewApproved?(data: { tasks: Task[] }): void;
  onCheckpoint?(data: { taskId: string; taskTitle: string; summary: string }): void;
  /** The isolation run record changed and should be persisted with the plan. */
  onIsolationChanged?(): void;
  /** A run did not start: the tree is dirty, and the user picks stash or no isolation. `repos` names the dirty repos of a group. */
  onIsolationBlocked?(data: { reason: 'dirty'; repos: string[] }): void;
  /** An isolated run settled; emitted before `onExecutionComplete`, which surfaces treat as terminal. */
  onIsolationHandoff?(handoff: IsolationHandoff): void;
  /**
   * What a run says about how it isolates — the fallback to the workspace root,
   * shared paths, copies, a stash. Beside the notification channel, which a
   * daemon may leave unwired, so a surface without toasts can still show it.
   */
  onIsolationNotice?(data: { level: 'info' | 'warn' | 'error'; message: string }): void;
}

/**
 * A message or interrupt a task cannot take: it is not running, it runs on the
 * terminal transport, or it is waiting on something a message does not answer.
 * The request is wrong, not the orchestrator, so a surface says why.
 */
export class TaskControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskControlError';
  }
}

/** How a refused {@link TaskControlError} names what was asked: "no turn to …", "cannot take … from Ordewell". */
const CONTROL_WORDS = {
  message: { noTurn: 'send a message to', terminal: 'a message' },
  interrupt: { noTurn: 'interrupt', terminal: 'an interrupt' },
  force: { noTurn: 'send a message to', terminal: 'a message sent now' },
} as const;

/**
 * One run of one task, from the moment the scheduler claims it until its
 * verdict, cancel, stop or plan load. Everything that has to die with the run
 * lives on this record, so {@link TaskOrchestrator.endAttempt} releases all of
 * it at once and nothing can be left behind for one exit path to forget.
 */
interface TaskAttempt {
  readonly taskId: string;
  /** 1-based count of spawns this task has had since the plan was loaded. */
  readonly attempt: number;
  /**
   * `starting` while the async spawn is in flight; `session` is null until
   * `running`. `integrating` once its verdict is with {@link Landing} — still
   * live, so the task neither completes nor frees its dependents until the
   * landing says so.
   */
  phase: AttemptPhase;
  session: ITerminalSession | null;
  readonly runner: string;
  /** Null until {@link attemptCwd} settles. */
  cwd: string | null;
  /** Whether `cwd` is a worktree prepared for this attempt rather than the workspace root. */
  worktree: boolean;
  /** The landing in flight, so a cancel waits for it before tearing the worktree down. */
  integration: Promise<LandingOutcome> | null;
  /** What this attempt is, which decides where it runs, what it is told and what is checked; see {@link AttemptKind}. */
  readonly kind: AttemptKind;
  /** The workspace's tracked state as the attempt started, when its tree is checked; what that check compares with. */
  snapshot: TreeSnapshot | null;
  readonly startedAt: string;
  /**
   * Set as its verdict arrives, before the verdict is applied: the turn that
   * carried the marker ends while the verdict is still settling, and must not
   * read as waiting for input.
   */
  decided: boolean;
  /** The task skills put in this attempt's prompt, as read from where it runs. */
  skills: readonly TaskSkillSnapshot[];
}

type AttemptPhase = 'starting' | 'running' | 'integrating';

/** Read-only view of a task's live attempt. */
export interface TaskAttemptSnapshot {
  taskId: string;
  attempt: number;
  phase: AttemptPhase;
  sessionId: string | null;
  runner: string;
  cwd: string | null;
  startedAt: string;
  skills: readonly TaskSkillSnapshot[];
}

/**
 * The wiring a {@link TaskOrchestrator} runs on, every collaborator resolved.
 * {@link TaskOrchestrator.compose} is the only production caller; tests build
 * one through it too. The constructor makes nothing itself, so there is exactly
 * one place defaults live.
 */
export interface TaskOrchestratorDeps {
  config: IConfig;
  notifications: INotification;
  terminalRunner: ITerminalRunner;
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
  /** The skill catalog at a root — a task's worktree, or the workspace root — read at each spawn. */
  skillsAt: (root: string) => SkillLookup;
  /**
   * What a fresh attempt asks its runner for (ADR-0018). Hosts take the
   * structured default; `routeTransport` still sends a runner with no
   * connector to the terminal.
   */
  transport: RunnerTransport;
  /** What the task's last saved attempt did, or null when it left no log (ADR-0020). */
  previousAttemptFromLog: (taskId: string) => string | null;
}

/**
 * What a caller supplies to {@link TaskOrchestrator.compose}; every optional
 * one gets its default there. This is what a host or test chooses, not the
 * resolved wiring the orchestrator itself runs on.
 */
export interface TaskOrchestratorOptions {
  config: IConfig;
  notifications: INotification;
  terminalRunner: ITerminalRunner;
  store?: PlanStore;
  output?: TaskOutputSource;
  isolation?: IWorktreeIsolation;
  registry?: RunnerRegistry | null;
  workspaceRoot?: () => string;
  workspaceEnv?: (cwd: string) => Promise<WorkspaceEnv>;
  skillsAt?: (root: string) => SkillLookup;
  /** Tests whose fake sessions emit only the completion marker ask for `terminal`. */
  transport?: RunnerTransport;
  previousAttemptFromLog?: (taskId: string) => string | null;
}

/**
 * The pure scheduler. Owns execution state (`running`, `planStatus`,
 * `reviewApproved`, the live task attempts, `messageQueue`) and the verifier.
 * All task-shaped state — the plan tree, the flat index, the completed set
 * — lives in {@link PlanStore}, injected at construction. The orchestrator
 * calls `store.markCompleted(id)` / `store.markFailed(id)` instead of mutating
 * task state directly. A task completes only after the runner emits its
 * per-task completion marker; process exit without that evidence is a visible
 * failure and does not unblock dependent work.
 */
export class TaskOrchestrator {
  private config: IConfig;
  private notifications: INotification;
  private terminalRunner: ITerminalRunner;
  private store: PlanStore;
  private output: TaskOutputSource;
  private attempts = new Map<string, TaskAttempt>();
  private verifier = new VerdictEngine();
  private running = false;
  private planStatus: 'approved' | 'running' | 'completed' = 'approved';
  private messageQueue = new MessageQueue();
  private reviewApproved = false;
  /*
   * Retry counts, spawn counts and holds describe a task across attempts, so
   * they deliberately live outside the attempt record: ending an attempt must
   * not forget that the user held the task or how often it has run.
   */
  private retryCounts = new Map<string, number>();
  private spawnCounts = new Map<string, number>();
  /** The terminal a verdict left open, by task; see {@link LingeringRunners}. */
  private lingering = new LingeringRunners((sessionId) => this.terminalRunner.stop(sessionId));
  /**
   * A full-plan run a failure paused. Retrying the failed task is the explicit
   * resume the pause waits for — without this a retry only reset the task to
   * pending and nothing ran until the user also re-ran the whole plan.
   */
  private haltedByFailure = false;
  /** A Merge all is under way: no ops task starts until it ends (ADR-0020). */
  private merging = false;
  /** The last "waiting for Merge all" notice, so a run paused at a gate says it once, not on every tick. */
  private gateNotice = '';
  /** The workspace's own variables for a task's cwd (ADR-0016); swapped out in tests. */
  private workspaceEnv: (cwd: string) => Promise<WorkspaceEnv>;
  /** What the workspace env has already warned about, so a run says it once, not per task. */
  private envWarnings = new Set<string>();
  /**
   * Tasks pulled out of auto-scheduling (user-cancelled or failed to spawn).
   * They stay 'pending' — "not executed" — but the scheduler skips them until
   * the user retries or force-starts, which would otherwise loop forever on a
   * task whose spawn always throws.
   */
  private onHold = new Set<string>();
  /**
   * Tasks Mark complete is landing after it ended their attempt: in progress
   * with no attempt for as long as that takes, and not orphans for it.
   */
  private completing = new Set<string>();

  /**
   * The plan's isolation run and the open run's lifecycle (ADR-0013); see
   * {@link IsolationRunController}. Read and acted on there directly, except
   * Merge all: that goes through {@link mergeRun}, which keeps it apart from
   * ops tasks and starts the tasks its merge lets through.
   */
  readonly runs: IsolationRunController;
  /** A passed attempt's work onto the integration branch, and the conflict repair a landing may need. */
  private landing: Landing;

  private registry: RunnerRegistry | null;
  private workspaceRootFn: () => string;
  private observers: OrchestratorObserver[] = [];
  private skillsAt: (root: string) => SkillLookup;
  private transport: RunnerTransport;
  private previousAttemptFromLog: (taskId: string) => string | null;

  constructor(deps: TaskOrchestratorDeps) {
    this.config = deps.config;
    this.notifications = deps.notifications;
    this.terminalRunner = deps.terminalRunner;
    this.store = deps.store;
    this.output = deps.output;
    this.runs = deps.runs;
    this.landing = deps.landing;
    this.registry = deps.registry;
    this.workspaceRootFn = deps.workspaceRoot;
    this.workspaceEnv = deps.workspaceEnv;
    this.skillsAt = deps.skillsAt;
    this.transport = deps.transport;
    this.previousAttemptFromLog = deps.previousAttemptFromLog;

    this.store.onMutate = () => this.emit('onTaskChanged');
    this.verifier.onVerdict((taskId, verdict) => { void this.deliverVerdict(taskId, verdict); });
    this.verifier.onCheckpoint((taskId, summary) => {
      const task = this.store.get(taskId);
      if (!task) return;
      this.store.markAwaitingUser(taskId, 'checkpoint');
      this.verifier.pauseIdle(taskId);
      this.emit('onTaskSettled', { taskId });
      this.emit('onCheckpoint', { taskId, taskTitle: task.title, summary });
    });
    this.verifier.onCheckpointWithdrawn((taskId) => {
      if (!this.awaitsCheckpoint(taskId)) return;
      this.store.markInProgress(taskId);
      this.emit('onTaskChanged');
    });
    // idleSince is advisory UI state, not a store mutation — broadcast it
    // through the same onTaskChanged seam without touching PlanStore.
    this.verifier.onIdleChange(() => this.emit('onTaskChanged'));
  }

  /**
   * The composition root: resolves every optional collaborator and wires the
   * isolation listener that the constructor cannot, because it needs the
   * instance's own (private) emit and lingering seams. Nothing else in the
   * codebase constructs an orchestrator, so this is the one place defaults
   * live — a host or test supplies what it cares about and gets the rest.
   */
  static compose(options: TaskOrchestratorOptions): TaskOrchestrator {
    const store = options.store ?? new PlanStore();
    const output = options.output ?? new BufferedTaskOutputSource();
    const isolation = options.isolation ?? createWorktreeIsolation({ config: options.config });
    const workspaceRoot = options.workspaceRoot ?? (() => process.cwd());
    // The listener callbacks fire only after construction, so the reference
    // below is settled by the time any of them runs.
    const runs = new IsolationRunController({
      isolation,
      config: options.config,
      notifications: options.notifications,
      workspaceRoot,
      listener: {
        changed: () => orchestrator.emit('onIsolationChanged'),
        blocked: (repos) => orchestrator.emit('onIsolationBlocked', { reason: 'dirty', repos }),
        handoff: (handoff) => orchestrator.emit('onIsolationHandoff', handoff),
        notice: (level, message) => orchestrator.emit('onIsolationNotice', { level, message }),
        releasing: (taskIds) => { for (const taskId of taskIds) orchestrator.lingering.close(taskId); },
      },
      liveTasks: (): ReadonlySet<string> => orchestrator.liveTaskIds(),
    });
    const landing = new Landing({ runs, config: options.config, tasks: store });
    const orchestrator = new TaskOrchestrator({
      config: options.config,
      notifications: options.notifications,
      terminalRunner: options.terminalRunner,
      store,
      output,
      runs,
      landing,
      registry: options.registry ?? null,
      workspaceRoot,
      workspaceEnv: options.workspaceEnv ?? ((cwd) => resolveWorkspaceEnv(cwd)),
      skillsAt: options.skillsAt ?? ((root) => new SkillsService(root)),
      transport: options.transport ?? 'structured',
      previousAttemptFromLog: options.previousAttemptFromLog ?? (() => null),
    });
    return orchestrator;
  }

  /** Advisory silence timestamp for a task's live runner, or null if not idle. */
  getIdleSince(taskId: string): string | null {
    return this.verifier.getIdleSince(taskId);
  }

  /**
   * What an ops retry is told about the attempt before. The saved log is read
   * whether or not the session was reloaded, so both behave alike; the terminal
   * buffer is the fallback for a runner that has no log. A reload clears the
   * attempt count along with the buffer, so a retry made since is what says
   * there was an attempt to report on.
   */
  private opsPreviousAttempt(taskId: string): string | undefined {
    const saved = this.previousAttemptFromLog(taskId) ?? this.output.liveTail(taskId, { maxLines: OPS_RETRY_TAIL_LINES })?.text;
    if (saved !== undefined) return saved;
    return (this.retryCounts.get(taskId) ?? 0) > 0 ? 'Its output is not available: this session was reloaded since it ran.' : undefined;
  }

  /** Recent clean output of a task's latest attempt, running or ended; null if it never ran. */
  getLiveOutput(taskId: string, opts: LiveTailOptions): LiveTail | null {
    return this.output.liveTail(taskId, opts);
  }

  get storeInstance(): PlanStore { return this.store; }

  /**
   * The variables a task's agent gets from its workspace. What cannot be
   * applied is said once — silently starting without them is how agents ran
   * under the wrong account when an edited `.envrc` was left unallowed.
   */
  private async envForTask(cwd: string): Promise<Record<string, string>> {
    const resolved = await this.workspaceEnv(cwd);
    const warn = (key: string, message: string) => {
      if (this.envWarnings.has(key)) return;
      this.envWarnings.add(key);
      this.notifications.warn(message);
    };
    if (resolved.blockedEnvrc) {
      warn(`blocked:${resolved.blockedEnvrc}`, `direnv has blocked ${resolved.blockedEnvrc}, so tasks start without its variables. Run \`direnv allow\` in ${path.dirname(resolved.blockedEnvrc)} to use them.`);
    }
    if (resolved.trackedEnvFile) {
      warn(`tracked:${resolved.trackedEnvFile}`, `Ignored ${resolved.trackedEnvFile}: git tracks it, and a committed file must not choose the environment agents run in. Untrack it to use it.`);
    }
    if (resolved.refused.length > 0) {
      warn(`refused:${resolved.refused.join(',')}`, `Ignored ${resolved.refused.join(', ')} from the workspace environment: Ordewell never passes these to agents.`);
    }
    return resolved.env;
  }

  approveCheckpoint(taskId: string): void {
    if (!this.awaitsCheckpoint(taskId)) return;
    this.verifier.approveCheckpoint(taskId);
    this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
  }

  rejectCheckpoint(taskId: string, reason?: string): void {
    if (!this.awaitsCheckpoint(taskId)) return;
    this.verifier.rejectCheckpoint(taskId, reason ?? 'Checkpoint rejected by user');
    this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
  }

  /** What the task's waiting checkpoint asks, whole; undefined once it settles or when none waits. */
  getCheckpointQuestion(taskId: string): string | undefined {
    return this.verifier.getCheckpointQuestion(taskId);
  }

  /*
   * The saved reason says what the task waits on. The live attempt stays a
   * guard: a checkpoint reloaded from disk has no runner left to answer it,
   * and putting it back to in_progress would strand it with nothing behind it.
   */
  awaitsCheckpoint(taskId: string): boolean {
    return this.store.get(taskId)?.awaitingReason === 'checkpoint' && this.attempts.has(taskId);
  }

  /**
   * Send a structured task a user message (ADR-0018, M1). Mid-turn it queues
   * behind the turn; a task waiting for input takes it at once and is back in
   * progress. Returns the message's id, for {@link removeQueuedTaskMessage}.
   */
  sendTaskMessage(taskId: string, text: string): string {
    return this.messageTask(taskId, text, 'message', (session, message) => session.sendMessage(message));
  }

  /**
   * Force send (ADR-0023, F1–F3): interrupt the running turn and deliver the
   * message as the next one, ahead of anything queued, without the task
   * waiting for input in between. A task already waiting for input just takes it.
   */
  forceSendTaskMessage(taskId: string, text: string): string {
    return this.messageTask(taskId, text, 'force', (session, message) => session.forceSend(message));
  }

  private messageTask(
    taskId: string,
    text: string,
    action: 'message' | 'force',
    send: (session: StructuredSessionCapability, message: string) => string,
  ): string {
    const message = text.trim();
    if (!message) throw new TaskControlError('A message to a task cannot be empty.');
    const task = this.store.get(taskId);
    const session = this.structuredSession(taskId, action);
    if (task?.status === 'awaiting_user' && task.awaitingReason !== 'input') {
      throw new TaskControlError(`Task "${task.title}" is at a checkpoint: approve or reject it instead.`);
    }
    const id = send(session, message);
    if (task?.status === 'awaiting_user') this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
    return id;
  }

  /** Force send a message still queued behind the running turn; false once the runner has it. */
  forceSendQueuedTaskMessage(taskId: string, id: string): boolean {
    const sent = this.structuredSession(taskId, 'force').forceSendQueued(id);
    if (sent) this.emit('onTaskChanged');
    return sent;
  }

  /** Take back a message still queued behind a turn; false once it was delivered. */
  removeQueuedTaskMessage(taskId: string, id: string): boolean {
    const removed = this.structuredSession(taskId, 'message').removeQueued(id);
    if (removed) this.emit('onTaskChanged');
    return removed;
  }

  /** Stop a structured task's running turn; it then waits for input like any turn that ends without its marker. */
  async interruptTask(taskId: string): Promise<void> {
    await this.structuredSession(taskId, 'interrupt').interrupt();
  }

  /** What is waiting for a structured task's turn to end; empty for any other task. */
  getQueuedTaskMessages(taskId: string): QueuedTaskMessage[] {
    const session = this.attempts.get(taskId)?.session;
    return session && isStructuredSession(session) ? session.queued() : [];
  }

  private structuredSession(taskId: string, action: keyof typeof CONTROL_WORDS): StructuredSessionCapability {
    const task = this.store.get(taskId);
    if (!task) throw new TaskControlError(`No task ${taskId} in this plan.`);
    const attempt = this.attempts.get(taskId);
    const session = attempt?.session;
    const words = CONTROL_WORDS[action];
    if (!attempt || !session || attempt.phase !== 'running' || attempt.decided) {
      throw new TaskControlError(`Task "${task.title}" is not running, so there is no turn to ${words.noTurn}.`);
    }
    if (!isStructuredSession(session)) {
      throw new TaskControlError(`Task "${task.title}" runs in a terminal, which cannot take ${words.terminal} from Ordewell: use its terminal instead.`);
    }
    return session;
  }

  /**
   * A structured turn that ended without the done marker (ADR-0018, W1). No
   * verdict is guessed: the task waits for input, unless a checkpoint in the
   * same turn already has it waiting, or a queued message went straight out —
   * the session never passes through idle then, so nothing flickers.
   */
  private onTurnEnd(taskId: string, attempt: TaskAttempt, session: ITerminalSession & StructuredSessionCapability): void {
    if (this.attempts.get(taskId) !== attempt || attempt.phase !== 'running' || attempt.decided) return;
    if (session.turnState() === 'working') {
      this.emit('onTaskChanged');
      return;
    }
    if (this.store.get(taskId)?.status !== 'in_progress') return;
    if (this.unresumed(attempt)) {
      // There is no session to wait in. Ending the runner hands the attempt to
      // its verdict, which fails it for want of the marker.
      session.kill();
      return;
    }
    this.store.markAwaitingUser(taskId, 'input');
    this.verifier.pauseIdle(taskId);
    this.emit('onTaskSettled', { taskId });
    this.emit('onTaskChanged');
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
    return this.running || this.attempts.size > 0;
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
  get status(): 'approved' | 'running' | 'completed' { return this.planStatus; }
  get activeTaskIds(): string[] { return [...this.activeSessionMap.keys()]; }
  /** Task id → session id of every attempt whose runner is up; a spawn in flight has no session yet. */
  get activeSessionMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, attempt] of this.attempts) {
      if (attempt.session) map.set(taskId, attempt.session.id);
    }
    return map;
  }

  getAttempt(taskId: string): TaskAttemptSnapshot | undefined {
    const attempt = this.attempts.get(taskId);
    if (!attempt) return undefined;
    const { taskId: id, attempt: n, phase, session, runner, cwd, startedAt, skills } = attempt;
    return { taskId: id, attempt: n, phase, sessionId: session?.id ?? null, runner, cwd, startedAt, skills };
  }

  get queuedCount(): number { return this.messageQueue.length; }

  /**
   * "Merge all"; a settled run that merged everything is cleared up and
   * forgotten. During a run it merges what has landed and the run goes on:
   * the tasks waiting at a merge gate for that work then start (ADR-0020).
   * Never alongside ops work, either way round ({@link mergeExcludes}).
   */
  async mergeRun(): Promise<IsolationMergeResult> {
    const excluded = [...this.attempts.values()].find((a) => mergeExcludes(a.kind));
    if (excluded) {
      const title = this.store.get(excluded.taskId)?.title ?? excluded.taskId;
      throw new TaskControlError(`Ops task "${title}" is running in your checkout — Merge all once it has finished.`);
    }
    this.merging = true;
    let result: IsolationMergeResult;
    try {
      result = await this.runs.merge();
    } finally {
      this.merging = false;
    }
    await this.tick();
    return result;
  }

  /**
   * The run as a surface offers Merge all mid-run (ADR-0020): what has landed
   * and is not merged, and whether the run is paused at its gates with nothing
   * else running. Null while no task waits at a gate.
   */
  mergeGateView(): MergeGateView | null {
    const handoff = this.runs.view()?.handoff;
    if (!handoff || !this.store.allTasks.some((t) => this.getMergeGate(t.id).length > 0)) return null;
    return { paused: this.running && this.attempts.size === 0, repos: handoff.repos, landed: handoff.landed };
  }

  /**
   * The dependencies an ops or user task waits on at its merge gate: those
   * whose landed work is not in the user's branch yet (ADR-0020). Empty once
   * the task has started, and for every other task.
   */
  getMergeGate(taskId: string): string[] {
    const task = this.store.get(taskId);
    if (!task || (task.status !== 'pending' && task.status !== 'approved')) return [];
    return mergeGate(task, this.store, this.runs);
  }

  private watchBlockingPrompts(task: Task, attempt: TaskAttempt, session: ITerminalSession): void {
    const manifest = this.registry?.get(attempt.runner)?.manifest;
    watchBlockingPrompts(session, manifest?.runner.blockingPrompts ?? [], (prompt) => {
      if (this.attempts.get(task.id) !== attempt) return;
      this.notifications.warn(`Task "${task.title}" is waiting for you: ${manifest?.displayName ?? attempt.runner} is asking ${prompt.asks}. Answer it in the task's terminal.`);
    });
  }

  queueMessage(text: string): void {
    this.messageQueue.enqueue(text);
    this.emit('onTaskChanged');
  }

  getQueuedMessages(): QueuedMessage[] {
    return this.messageQueue.all();
  }

  /** Take one unsent message back out of the queue; false when it was never there (or already drained). */
  removeQueuedMessage(id: string): boolean {
    const removed = this.messageQueue.remove(id);
    if (removed) this.emit('onTaskChanged');
    return removed;
  }

  setQueuedMessages(messages: QueuedMessage[]): void {
    this.messageQueue.replace(messages);
  }

  clearQueuedMessages(): void {
    this.messageQueue.clear();
  }

  loadPlan(tasks: readonly Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS]): void {
    this.store.load(tasks, planRunners);
    const repairs = this.endAllAttempts('load').filter((a) => a.kind.kind === 'repair' && a.worktree);
    for (const a of repairs) this.unawaited(this.runs.release(a.taskId, { keep: true }, a.integration), `Could not keep the worktree of task "${this.store.get(a.taskId)?.title ?? a.taskId}"`);
    // A plan committed while the scheduler runs keeps that run, and its mode
    // with it; otherwise the next start decides afresh.
    this.runs.interrupt({ keepOpen: this.running });
    this.planStatus = 'approved';
    this.reviewApproved = false;
    this.retryCounts.clear();
    this.spawnCounts.clear();
    this.onHold.clear();
    this.recoverOrphans();
  }

  /**
   * Adopt an edited plan without letting go of the run in progress. Everything
   * the scheduler owns — live sessions, holds, retry counts, the verifier and
   * the review approval — survives, because `loadPlan` clears all of it and a
   * mid-run edit is not a new run. Only the tasks change.
   *
   * The ids with live sessions are defended: one dropped from the edited plan is
   * carried over (its verdict still has to land somewhere), and one whose status
   * the snapshot predates is put back to `in_progress` — adopting the snapshot's
   * "pending" would offer the scheduler work a runner is already doing.
   */
  reconcilePlan(newTasks: Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS]): void {
    const adopted = [...newTasks];
    for (const taskId of this.attempts.keys()) {
      const task = this.store.get(taskId);
      if (!task) continue;

      const at = adopted.findIndex((t) => t.id === taskId);
      if (at < 0) {
        adopted.push({ ...task });
      } else if (adopted[at].status !== 'in_progress') {
        console.warn(`[TaskOrchestrator] Running task "${task.title}" status changed to "${adopted[at].status}" in modified plan, using orchestrator truth`);
        adopted[at] = { ...adopted[at], status: 'in_progress' };
      }
    }

    this.store.load(adopted, planRunners);
    this.planStatus = 'running';
  }

  async start(): Promise<void> {
    if (this.runs.blocked) return;
    if (this.running) {
      console.error('[TaskOrchestrator] start() called but already running — no-op');
      return;
    }
    if (!this.reviewApproved) {
      console.log('[TaskOrchestrator] start() blocked — plan review not yet approved. Emitting onReviewNeeded.');
      this.emit('onReviewNeeded', { tasks: this.store.planTasks, planRunners: this.store.planRunners });
      return;
    }
    this.runs.open();
    console.log(`[TaskOrchestrator] Starting with ${this.store.allTasks.length} tasks (${this.store.allTasks.filter(t => t.type === 'ai' && t.prompt).length} AI ready)`);
    this.running = true;
    this.haltedByFailure = false;
    this.planStatus = 'running';
    this.emit('onTaskChanged');
    await this.tick();
  }

  private haltOnFailure(): void {
    if (this.running) this.haltedByFailure = true;
    this.running = false;
    this.planStatus = 'approved';
  }

  stop(): void {
    this.haltedByFailure = false;
    this.running = false;
    this.planStatus = 'approved';
    this.terminalRunner.stopAll();
    // Interrupted work is kept like a failed attempt's: inspectable, and off
    // `active` so a crash-recovery prune does not sweep it away. A stopped
    // repair did not land, so its task waits on the user as its conflict did;
    // every other stopped task is back to not started, as a cancel leaves it.
    // Left in progress, it would read as running with nothing behind it — and
    // its kept worktree as work a finished run could clear up.
    const stopped: TaskAttempt[] = [];
    for (const a of this.endAllAttempts('stop')) {
      if (a.kind.kind === 'repair') this.store.markAwaitingUser(a.taskId, 'conflict');
      else if (this.store.get(a.taskId)) {
        this.store.markPending(a.taskId);
        stopped.push(a);
      }
      if (a.worktree) this.unawaited(this.runs.release(a.taskId, { keep: true }, a.integration), `Could not keep the worktree of task "${this.store.get(a.taskId)?.title ?? a.taskId}"`);
    }
    this.runs.interrupt();
    this.onHold.clear();
    this.sayStopped(stopped);
    this.recoverOrphans();
    this.emit('onTaskChanged');
  }

  /** Name the tasks a stop took down, so none is mistaken for one still at work. */
  private sayStopped(stopped: readonly TaskAttempt[]): void {
    if (stopped.length === 0) return;
    const one = stopped.length === 1;
    const named = quotedList(stopped.map((a) => this.store.get(a.taskId)?.title ?? a.taskId));
    const kept = stopped.some((a) => a.worktree)
      ? ` What ${one ? 'it' : 'they'} did is kept in ${one ? 'its worktree' : 'their worktrees'}: Mark complete lands it; Retry starts over and keeps it on a branch.`
      : '';
    this.tell('info', `Stopped ${named} — back to not started.${kept}`);
  }

  /**
   * A task in progress with no attempt has nothing running it: a stop, a plan
   * load or anything else that ended its attempt left its status behind. It
   * is put back to not started, and said, so it can be retried rather than
   * read as running — or, in an isolated run, count as live work forever.
   */
  private recoverOrphans(): void {
    const orphans = this.store.allTasks.filter((t) => t.type === 'ai' && t.status === 'in_progress' && !this.attempts.has(t.id) && !this.completing.has(t.id));
    if (orphans.length === 0) return;
    for (const t of orphans) this.store.markPending(t.id);
    const one = orphans.length === 1;
    const titles = quotedList(orphans.map((t) => t.title));
    this.tell('warn', `${one ? 'Task' : 'Tasks'} ${titles} ${one ? 'was' : 'were'} shown as running, but nothing was running ${one ? 'it' : 'them'} — back to not started. Retry or force-start ${one ? 'it' : 'them'}; a worktree ${one ? 'it' : 'they'} had is kept.`);
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
    const live = new Set(this.attempts.keys());
    for (const t of this.store.allTasks) {
      const midAttempt = t.status === 'awaiting_user' && (t.awaitingReason === 'checkpoint' || t.awaitingReason === 'input');
      if (t.status === 'in_progress' || midAttempt) live.add(t.id);
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
   * The boundary a verdict crosses: nothing awaits the verifier's listener, so
   * a throw from reading the output, landing, releasing a worktree or the tick
   * after would be an unhandled rejection — and an attempt left integrating is
   * live work forever. One that never settled fails (a repair waits on the
   * user, as its conflict did); either way the run halts and says why.
   */
  private async deliverVerdict(taskId: string, verdict: Verdict): Promise<void> {
    const attempt = this.attempts.get(taskId);
    try {
      await this.onVerdict(taskId, verdict);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        const title = this.store.get(taskId)?.title ?? taskId;
        const unsettled = attempt !== undefined && this.attempts.get(taskId) === attempt;
        if (unsettled) {
          this.endAttempt(taskId, 'verdict');
          if (attempt.kind.kind === 'repair') this.store.markAwaitingUser(taskId, 'conflict');
          else this.store.markFailed(taskId);
          this.store.setTaskOutputSummary(taskId, summarizeOutput(reason, ''));
          // Its landing may be what threw, so the release does not wait on it.
          if (attempt.worktree) this.unawaited(this.runs.release(taskId, { keep: true }), `Could not keep the worktree of task "${title}"`);
        }
        this.haltOnFailure();
        this.tell('error', unsettled ? `Task "${title}" could not be settled: ${reason}` : `Task "${title}" settled, but the run could not go on: ${reason}`);
        this.unawaited(this.afterVerdict(taskId), 'The run could not be closed');
      } catch (cleanupErr) {
        // Nothing awaits a verdict, so this is the last place its failure can surface.
        console.error(`[TaskOrchestrator] verdict for ${taskId} failed (${reason}) and so did handling it:`, cleanupErr);
      }
    }
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

  private async onVerdict(taskId: string, verdict: Verdict): Promise<void> {
    const task = this.store.get(taskId);
    const attempt = this.attempts.get(taskId);
    if (!task || !attempt) return;
    attempt.decided = true;

    console.error(`[TaskOrchestrator] Task #${task.order} "${task.title}" verdict=${verdict.outcome}`);
    console.error(`[TaskOrchestrator] Runner: ${task.assignedRunner}, Model: ${task.assignedModel?.modelId ?? 'default'}`);
    console.error(`[TaskOrchestrator] Prompt preview: ${(task.prompt ?? '').slice(0, 200)}`);
    if (attempt.kind.kind === 'repair') return this.settleRepair(task, attempt, verdict);

    // The terminal stays the source of truth for the verdict itself; this only
    // changes what gets summarized for downstream consumers.
    const doneToken = `<<<ORDEWELL_DONE_${task.completionMarker}>>>`;
    const summary = await this.output.finalText({ ...attempt, completionMarker: task.completionMarker }, doneToken);
    // The attempt stays live across the read, so a cancel, retry, mark
    // complete, stop or plan load in that window ends it — and has decided the
    // task since. A stale verdict must not overwrite that decision.
    if (this.attempts.get(taskId) !== attempt) return;
    const landing = verdict.outcome === 'pass' ? await this.land(attempt, () => this.landing.landPassed(task, attempt)) : null;
    const changedFiles = landing && checksTree(attempt.kind) ? await this.runs.filesChangedSince(attempt.snapshot) : [];
    const unresumedReason = this.unresumed(attempt) ? unresumedMessage(task, `${attempt.runner} could not find its saved session`) : null;
    if (this.attempts.get(taskId) !== attempt) return;
    this.endAttempt(taskId, 'verdict');
    this.store.setTaskVerdict(taskId, verdict);
    console.error(`[TaskOrchestrator] Output summary:\n${summary || '(empty — no output captured)'}`);
    if (changedFiles.length > 0) {
      // The evidence the ops rule rests on: a runner cannot be kept from
      // writing, only caught. Nothing is committed, and nothing fails.
      this.store.markAwaitingUser(taskId, 'files-changed');
      this.tell('warn', `Ops task "${task.title}" finished, but changed tracked files in your checkout: ${capConflictFiles(changedFiles)}. An ops task must not change repository files, so nothing was committed — look at the changes, then mark it complete or retry it.`);
    } else if (landing) {
      await this.applyLanding(task, landing, () => this.notifications.info(`Task "${task.title}" completed.`));
    } else if (classifyRunnerStop(attempt.session?.getOutput() ?? '') === 'usage-limit') {
      // No marker, but what stopped the runner was its account rather than the
      // work. Failing would paint a red X on a task the user can simply retry,
      // and spawning more tasks would only spend the same exhausted limit, so
      // the task pauses and the run holds until the user resumes it.
      this.store.markAwaitingUser(taskId);
      this.haltOnFailure();
      this.tell('warn', `Task "${task.title}" stopped before its completion marker: ${attempt.runner} hit its usage limit. Retry it once the limit resets${attempt.worktree ? ' — its worktree is kept' : ''}.`);
      if (attempt.worktree) await this.runs.release(taskId, { keep: true });
    } else {
      this.store.markFailed(taskId);
      // Missing completion evidence is a hard boundary: do not launch more
      // work from a full-plan run until the user retries/resumes explicitly.
      // Already-active parallel tasks may finish, but no new task is spawned.
      this.haltOnFailure();
      this.notifications.error(unresumedReason ?? `Task "${task.title}" failed verification: ${verdict.reason}`);
      if (attempt.worktree) await this.runs.release(taskId, { keep: true });
    }

    this.store.setTaskOutputSummary(taskId, summarizeOutput(unresumedReason ?? verdict.reason, summary));

    this.logAndArchive(task, verdict);
    await this.afterVerdict(taskId);
  }

  private async afterVerdict(taskId: string): Promise<void> {
    // A conflict owed a repair is back in progress: nothing has settled yet.
    const status = this.store.get(taskId)?.status;
    if (status === 'completed' || status === 'failed' || status === 'awaiting_user') this.emit('onTaskSettled', { taskId });
    this.emit('onTaskChanged');
    if (!this.running) {
      if (this.attempts.size === 0) {
        if (this.store.isAllComplete()) this.planStatus = 'completed';
        this.emit('onTick');
        if (this.settled) await this.runs.close();
        this.emit('onExecutionComplete');
      }
      return;
    }
    await this.tick();
  }

  /**
   * A repair's verdict never replaces the verdict the task's own work earned,
   * and a repair that does not land leaves the task waiting on the user —
   * never a failed task, so never a halted run.
   */
  private async settleRepair(task: Task, attempt: TaskAttempt, verdict: Verdict): Promise<void> {
    const outcome = await this.land(attempt, () => this.landing.settleRepair(task, verdict));
    if (this.attempts.get(task.id) !== attempt) return;
    this.endAttempt(task.id, 'verdict');
    await this.applyLanding(task, outcome, () => {
      this.store.unblockDependents(task.id);
      this.logAndArchive(task, task.verdict ?? verdict);
    });
    await this.afterVerdict(task.id);
  }

  /**
   * Hand an attempt's verdict to Landing. The attempt stays live while that
   * settles — it may wait on the module's merge queue — so a cancel, retry or
   * stop in that window still wins, and waits for the merge before tearing the
   * worktree down; nothing counts the task as done before its work is on the
   * integration branch.
   */
  private land(attempt: TaskAttempt, settle: () => Promise<LandingOutcome>): Promise<LandingOutcome> {
    attempt.phase = 'integrating';
    attempt.integration = settle();
    return attempt.integration;
  }

  /** Settle a task by how its landing went; `onLanded` is what the path that landed it adds to completing it. */
  private async applyLanding(task: Task, outcome: LandingOutcome, onLanded: () => void): Promise<void> {
    if (!completesTask(outcome)) return this.settleUnlanded(task, outcome);
    this.store.markCompleted(task.id);
    onLanded();
    this.say(outcome.messages);
    await this.landResolved(task.id);
  }

  /**
   * Work that did not land waits on the user — it never fails the task or
   * halts the run — unless its conflict is owed a repair, which takes the slot
   * the ending attempt freed and never one more than the run allows.
   */
  private settleUnlanded(task: Task, outcome: UnlandedOutcome): void {
    this.store.markAwaitingUser(task.id, 'conflict');
    this.say(outcome.messages);
    if (outcome.kind !== 'repair-needed') return;
    if (this.attempts.size < this.config.maxParallelSessions) this.unawaited(this.startTask(task), `Could not start the repair of task "${task.title}"`);
    else {
      this.store.markPending(task.id);
      this.tell('info', `Task "${task.title}" is repaired once a slot is free.`);
    }
  }

  private async landResolved(resolverId: string): Promise<void> {
    const resolved = await this.landing.landResolved(resolverId);
    if (!resolved) return;
    const { task, outcome } = resolved;
    await this.applyLanding(task, outcome, () => {
      this.store.unblockDependents(task.id);
      if (task.verdict) this.logAndArchive(task, task.verdict);
    });
  }

  getReadyTasks(): Task[] {
    return this.readiness().ready;
  }

  private readiness(): Readiness {
    if (!this.running) return { ready: [], candidateCount: 0, excluded: [], gated: [] };
    const maxParallel = this.config.maxParallelSessions;
    const active = this.attempts.size;
    const readiness = selectReadyTasks({
      store: this.store,
      onHold: this.onHold,
      runs: this.runs,
      active,
      maxParallel,
      merging: this.merging,
    });

    for (const { task, reasons } of readiness.excluded) {
      console.log(`[TaskOrchestrator] excluded: #${task.order} "${task.title}" — ${reasons.join(', ')}`);
    }
    console.log(`[TaskOrchestrator] getReadyTasks: ${readiness.candidateCount} candidates, ${Math.max(0, maxParallel - active)} slots, maxParallel=${maxParallel}`);
    return readiness;
  }

  /**
   * Open the run a task starts in, and decide whether it isolates if the
   * task's next attempt needs that ({@link decidesIsolation}). False while a
   * dirty tree waits on the user; `resume` is what their choice replays.
   */
  private async openFor(taskId: string, resume: () => Promise<void>): Promise<boolean> {
    this.runs.open();
    return !decidesIsolation(this.nextAttemptKind(taskId)) || this.runs.decide(resume);
  }

  /** The kind a task's next attempt starts as, short of a repair or a continue: what is weighed before one exists. */
  private nextAttemptKind(taskId: string): AttemptKind {
    return classifyAttempt(this.store.isOps(taskId));
  }

  /**
   * Cancel a running (or scheduled) task: kill its session and return it to
   * 'pending' — "not executed". The task is put on hold so the scheduler
   * doesn't immediately restart it; Retry / Force Start release the hold.
   *
   * The attempt's worktree is kept, as a stopped or failed one is: a runner is
   * often cancelled because it looked stuck after doing the work, and Mark
   * complete can still land that work. The next attempt replaces it.
   */
  async cancelTask(taskId: string): Promise<void> {
    await this.cancelAttempt(taskId, { keep: true });
  }

  private async cancelAttempt(taskId: string, worktree: { keep: boolean }): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    // A cancel that arrives after the task already settled (its verdict
    // landed and the attempt was torn down) has nothing left to cancel. Without
    // this guard it would still revert a completed/failed task to 'pending',
    // silently discarding a verdict that already landed.
    if (!this.attempts.has(taskId) && task.status !== 'in_progress') return;
    const ended = this.endAttempt(taskId, 'cancel');
    this.store.markPending(taskId);
    this.onHold.add(taskId);
    this.emit('onTaskChanged');
    await this.runs.release(taskId, worktree, ended?.integration);
    await this.tick();
  }

  /**
   * Let go of a task that is leaving the plan. A live runner is cancelled
   * as {@link cancelTask} does, but its worktree goes: no task is left to land
   * it into. A spawn still in flight just loses its attempt,
   * which is what makes {@link startTask} kill the session it is about to
   * receive. The id's cross-attempt bookkeeping goes too — a hold or retry
   * count kept for a task that no longer exists would be inherited by nothing.
   */
  async releaseTask(taskId: string): Promise<void> {
    const phase = this.attempts.get(taskId)?.phase;
    if (phase === 'running' || phase === 'integrating') await this.cancelAttempt(taskId, { keep: false });
    else {
      this.endAttempt(taskId, 'release');
      // Not left in progress while its worktree goes: it is leaving the plan, not running.
      if (this.store.get(taskId)?.status === 'in_progress') this.store.markPending(taskId);
      await this.runs.release(taskId, { keep: false });
    }
    this.onHold.delete(taskId);
    this.retryCounts.delete(taskId);
    this.spawnCounts.delete(taskId);
  }

  async markTaskComplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed') return;

    const ended = this.endAttempt(taskId, 'complete');
    const verdict = this.verifier.markComplete(task);
    // The user vouches for the work, so it lands the way a passed verdict's
    // would — including a landing a passed verdict already has in flight.
    this.completing.add(taskId);
    let landing: LandingOutcome;
    try {
      landing = await (ended?.integration ?? this.landing.landVouched(task));
    } finally {
      this.completing.delete(taskId);
    }

    if (completesTask(landing)) this.store.markCompleted(taskId);
    else this.settleUnlanded(task, landing);
    this.store.setTaskVerdict(taskId, verdict);
    this.store.setTaskOutputSummary(taskId, summarizeOutput(verdict.reason, ''));
    this.logAndArchive(task, verdict);
    if (completesTask(landing)) {
      this.store.unblockDependents(taskId);
      this.onHold.delete(taskId);
      this.notifications.info(`Task "${task.title}" marked complete.`);
      this.say(landing.messages);
      await this.landResolved(taskId);
    }

    this.emit('onTaskChanged');
    await this.tick();
  }

  /**
   * Undo a completion: return the task to "not executed" — pending, verdict and
   * summary dropped, archive entry removed. It is put on hold like a cancel, so
   * a running plan does not immediately re-spawn the work the user just
   * un-marked; Retry / Force Start / Run release the hold. Dependents fall back
   * to waiting on their own, because the scheduler gates on `isCompleted`.
   */
  async markTaskIncomplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status !== 'completed') return;

    this.verifier.clear(task);
    this.store.retry(taskId);
    this.store.removeFromLog(taskId);
    this.onHold.add(taskId);
    // A finished plan is no longer finished — leaving 'completed' would tell
    // every surface the run is over while a task sits pending.
    if (this.planStatus === 'completed') this.planStatus = 'approved';

    this.notifications.info(`Task "${task.title}" marked not done.`);
    this.emit('onTaskChanged');
    await this.tick();
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

  async retryTask(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
    const ended = this.endAttempt(taskId, 'retry');
    this.store.retry(taskId);
    this.store.unblockDependents(taskId);
    this.onHold.delete(taskId);
    this.emit('onTaskChanged');
    // A retry starts over from the integration tip, which by now holds what its
    // predecessors landed; the old attempt's worktree has nothing to offer it.
    await this.runs.release(taskId, { keep: false }, ended?.integration);
    if (this.haltedByFailure && !this.running) await this.start();
    else await this.tick();
  }

  /**
   * Continue a finished structured task in its saved runner session (ADR-0018,
   * K1): a retry whose first turn is the user's message, sent to the session
   * the task ended in rather than a fresh one given its prompt again. Like a
   * retry it is a new attempt in a fresh worktree from the integration tip —
   * the same path, which is where the runner keeps its sessions — verified and
   * landed like any other, and dependents are left alone.
   */
  async continueTask(taskId: string, message: string): Promise<void> {
    const text = message.trim();
    if (!text) throw new TaskControlError('A message to continue a task with cannot be empty.');
    const task = this.store.get(taskId);
    if (!task) throw new TaskControlError(`No task ${taskId} in this plan.`);
    const eligible = continuability(task);
    if (!eligible.ok) throw new TaskControlError(eligible.reason);
    const runner = this.store.resolveTaskRunner(task);
    const route = routeTransport('structured', runner, this.registry);
    if (route.transport !== 'structured') throw new TaskControlError(`Task "${task.title}" cannot be continued: ${route.fallback}. Use Retry instead.`);
    if (!(await this.openFor(taskId, () => this.continueTask(taskId, message)))) return;
    // The run may have started it while opening; the claim below must be the only one.
    if (this.attempts.has(taskId) || !continuability(task).ok) return;

    this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
    this.endAttempt(taskId, 'retry');
    this.store.retry(taskId);
    this.store.unblockDependents(taskId);
    this.onHold.delete(taskId);
    // Claimed before anything is awaited, so a running scheduler never sees the
    // pending task and starts it afresh. Its prepare replaces the old worktree.
    const started = this.startTask(task, { message: text, resumeSessionId: eligible.sessionId });
    if (this.haltedByFailure && !this.running) await this.start();
    await started;
  }

  /**
   * Manually start a single AI task right now, bypassing dependency/readiness
   * gating (the "force start" affordance on a task card). Reuses the scheduler's
   * own startTask so a force-started task gets the same augmented prompt, session
   * tracking, and exit handling — callers must not re-spawn the runner themselves.
   * No-op if the task is unknown, not an AI task, or already running.
   */
  async forceStartTask(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.type !== 'ai') return;
    if (this.attempts.has(taskId)) return;
    this.refuseOpsDuringMerge(task);
    if (!(await this.openFor(taskId, () => this.forceStartTask(taskId)))) return;
    this.onHold.delete(taskId);
    this.notePastGate(task);
    await this.startTask(task);
  }

  private refuseOpsDuringMerge(task: Readonly<Task>): void {
    if (this.merging && mergeExcludes(this.nextAttemptKind(task.id))) {
      throw new TaskControlError(`A Merge all is under way — ops task "${task.title}" can start once it has finished.`);
    }
  }

  /**
   * A force start passes a merge gate (ADR-0020), and the surface confirmed it
   * first; the choice is kept on the task and said, because the work it acts
   * on is not in the user's branch.
   */
  private notePastGate(task: Readonly<Task>): void {
    const unmerged = mergeGate(task, this.store, this.runs);
    if (unmerged.length === 0) return;
    const titles = unmerged.map((id) => `"${this.store.get(id)?.title ?? id}"`);
    this.store.setForcedPastGate(task.id, titles);
    this.tell('warn', `Task "${task.title}" was force-started before the work of ${titles.join(', ')} was merged into your branch.`);
  }

  /**
   * Run exactly one task outside full-plan scheduling. The active/starting
   * session still contributes to {@link hasLiveWork} so every surface exposes
   * Stop and disables Execute Plan, but onVerdict cannot auto-schedule other
   * tasks because the plan scheduler's `running` flag remains false.
   */
  async runTask(taskId: string): Promise<void> {
    if (this.hasLiveWork) return;
    const task = this.store.get(taskId);
    if (!task || task.type !== 'ai') return;
    this.refuseOpsDuringMerge(task);
    if (!(await this.openFor(taskId, () => this.runTask(taskId)))) return;
    this.onHold.delete(taskId);
    this.notePastGate(task);
    await this.startTask(task);
  }

  getCompletedCount(): number { return this.store.completedCount; }
  getTotalCount(): number { return this.store.allTasks.length; }
  isAllComplete(): boolean { return this.store.isAllComplete(); }
  isAnyFailed(): boolean { return this.store.isAnyFailed(); }

  async approveReview(): Promise<void> {
    if (this.reviewApproved) {
      console.log('[TaskOrchestrator] approveReview() called but already approved — no-op');
      return;
    }
    this.reviewApproved = true;
    this.planStatus = 'approved';
    this.emit('onTaskChanged');
    this.emit('onReviewApproved', { tasks: this.store.planTasks });
    await this.start();
  }

  async tick(): Promise<void> {
    this.recoverOrphans();
    if (!this.running) {
      // A run the scheduler is not driving — a manual task run, or a halted
      // plan's remaining attempts — is closed by a verdict only. Ended by
      // cancel, Mark complete or a failed spawn instead, it would stay open, and
      // the next run would inherit its mode rather than decide its own.
      if (this.attempts.size === 0 && this.runs.isOpen && this.settled) await this.runs.close();
      return;
    }

    if (this.messageQueue.length > 0) {
      if (this.attempts.size === 0) {
        this.emit('onQueueReady');
      }
      return;
    }

    let readiness = this.readiness();
    // Work merged by hand opens a gate as Merge all does; only git can tell.
    // A user task's gate counts too, though the scheduler never starts one.
    const atGate = readiness.gated.length > 0 || this.store.allTasks.some((t) => t.type === 'user' && this.getMergeGate(t.id).length > 0);
    if (atGate && (await this.runs.refreshInHead())) readiness = this.readiness();
    if (!this.running) return;
    const { ready } = readiness;
    console.log(`[TaskOrchestrator] tick(): ${ready.length} ready, ${this.attempts.size} active, queue=${this.messageQueue.length}`);

    if (ready.length === 0 && this.attempts.size === 0) {
      const remaining = this.store.allTasks.filter(t => t.status !== 'completed');
      console.log(`[TaskOrchestrator] tick(): no work. remaining=${remaining.length}, completed=${this.store.isAllComplete()}`);
      const remainingById = new Map(remaining.map((t) => [t.id, t]));
      for (const { task, parent } of flattenTasksWithParents(this.store.planTasks)) {
        if (!remainingById.has(task.id)) continue;
        console.log(`  - ${taskOrderLabel(task, parent ?? undefined)}. ${task.title} [${task.type}/${task.status}] prompt=${!!task.prompt}`);
      }
      if (this.store.isAllComplete()) {
        // Genuinely done — stop the loop so a fresh Execute click can start it again.
        this.running = false;
        this.planStatus = 'completed';
        this.notifications.info('All tasks completed!');
        this.emit('onTaskChanged');
        this.emit('onTick');
        await this.runs.close();
        this.emit('onExecutionComplete');
      } else {
        // Not done — just waiting on a user task, checkpoint, or held task.
        // Keep `running` true: markTaskComplete/retryTask/forceStartTask/cancelTask
        // all re-tick() afterward, and that only ever schedules new work while
        // `running` is true. Flipping it false here would silently kill the
        // scheduler and leave dependents unblocked-but-never-started.
        // Do NOT emit onExecutionComplete here: a paused run is not a finished
        // one, and every surface treats that signal as terminal (the TUI closes
        // its execution stream on receipt, so a later fan-out from completing the
        // user task would arrive to a closed socket and be invisible).
        this.notifications.info('Remaining tasks require user action or are on hold.');
        this.sayGate();
        this.emit('onTaskChanged');
        this.emit('onTick');
      }
      return;
    }

    for (const { id } of ready) {
      // Readiness was read before this loop awaited any start: a stop, a plan
      // load, a Merge all, a user control or a concurrent tick may have come
      // since, so each id is judged again — and last with nothing awaited
      // between that and the slot startTask claims.
      if (!this.running) return;
      if (!this.stillReady(id)) continue;
      const kind = this.nextAttemptKind(id);
      if (this.merging && mergeExcludes(kind)) continue;
      if (decidesIsolation(kind) && !(await this.runs.decide(() => this.tick()))) continue;
      if (!this.running) return;
      if (!this.stillReady(id)) continue;
      const task = this.store.get(id);
      if (task) await this.startTask(task);
    }
    this.emit('onTick');
  }

  /** Whether the scheduler may start `id` now: it passes every readiness gate and a slot is free. */
  private stillReady(id: string): boolean {
    if (this.attempts.has(id) || this.attempts.size >= this.config.maxParallelSessions) return false;
    const { ready } = selectReadyTasks({
      store: this.store,
      onHold: this.onHold,
      runs: this.runs,
      active: 0,
      maxParallel: Number.POSITIVE_INFINITY,
      merging: this.merging,
    });
    return ready.some((t) => t.id === id);
  }

  /**
   * A run paused at merge gates says so, as plainly as a task that waits on
   * the user: which tasks wait, and that Merge all lets them go on (ADR-0020).
   */
  private sayGate(): void {
    const waiting = this.store.allTasks.filter((t) => this.getMergeGate(t.id).length > 0);
    const notice = waiting.length === 0
      ? ''
      : `Waiting for Merge all: ${waiting.map((t) => `"${t.title}"`).join(', ')} ${waiting.length === 1 ? 'needs' : 'need'} work that is not merged into your branch yet.`;
    if (notice === this.gateNotice) return;
    this.gateNotice = notice;
    if (notice) this.tell('info', notice);
  }

  private async startTask(task: Task, continuation: Continuation | null = null): Promise<void> {
    if (this.attempts.has(task.id) || !this.store.get(task.id)) return;
    const attempt: TaskAttempt = {
      taskId: task.id,
      attempt: (this.spawnCounts.get(task.id) ?? 0) + 1,
      phase: 'starting',
      session: null,
      runner: this.store.resolveTaskRunner(task),
      cwd: null,
      worktree: false,
      integration: null,
      kind: classifyAttempt(this.store.isOps(task.id), { repair: this.landing.nextRepair(task.id), continuation }),
      snapshot: null,
      startedAt: new Date().toISOString(),
      decided: false,
      skills: [],
    };
    this.spawnCounts.set(task.id, attempt.attempt);
    this.attempts.set(task.id, attempt);
    this.store.markInProgress(task.id);
    this.emit('onTaskChanged');

    if (!(await this.spawnAttempt(task, attempt))) return;

    // Committed as running: notify observers only now, outside the fallible
    // spawn path above, so an observer throwing here is never mistaken for a
    // failed spawn (which would tear down the attempt it just announced).
    if (attempt.worktree) this.emit('onIsolationChanged');
    this.emit('onTaskChanged');
    if (attempt.kind.kind === 'repair') {
      const group = this.runs.current?.repos.some((r) => r.path !== SELF_REPO);
      const { n, limit } = attempt.kind.repair;
      this.tell('info', `Repairing the conflict of task "${task.title}" in its own ${group ? 'worktrees' : 'worktree'} (repair ${n} of ${limit}).`);
    } else {
      this.notifications.info(`Task "${task.title}" ${continuation ? 'continued' : 'started'} (${attempt.runner})`);
    }
  }

  /**
   * The fallible half of starting a task: resolving its cwd/worktree and
   * spawning the runner. Resolves false when the attempt never committed —
   * abandoned because it was ended from under it, or a failed spawn already
   * unwound (both leave `startTask` with nothing further to announce).
   */
  private async spawnAttempt(task: Task, attempt: TaskAttempt): Promise<boolean> {
    try {
      const { kind } = attempt;
      const { cwd, worktree } = await attemptCwd(kind, task, this.runs);
      attempt.cwd = cwd;
      attempt.worktree = worktree;
      if (checksTree(kind)) attempt.snapshot = await this.runs.snapshotWorkspace();
      if (this.attempts.get(task.id) !== attempt) {
        // Ended while its worktree was being made, so whatever ended it could
        // not release it. A newer attempt's own prepare replaces it instead.
        // A repair's worktree holds work that passed, so it is only handed back.
        if (attempt.worktree && !this.attempts.has(task.id)) await this.runs.release(task.id, { keep: kind.kind === 'repair' });
        this.abandonSpawn(task, attempt);
        return false;
      }
      // Read where the attempt runs: a skill an earlier task committed is in
      // this worktree only once that task's work has landed.
      if (takesSkills(kind) && task.skills?.length) attempt.skills = resolveTaskSkills(task, this.skillsAt(cwd));
      const transport = attemptTransport(kind, this.transport);
      const completionTool = givesCompletionTool(transport, attempt.runner, this.registry);
      const finalPrompt = attemptPrompt(kind, {
        task,
        plan: this.store.planTasks,
        completionTool,
        planMapEnabled: this.config.planMapEnabled,
        skills: attempt.skills,
        repairPrompt: (t) => this.landing.repairPrompt(t),
        previousAttempt: (taskId) => this.opsPreviousAttempt(taskId),
      });
      this.lingering.close(task.id);
      const env = await this.envForTask(cwd);
      const session = await this.terminalRunner.spawn({
        taskId: task.id,
        runner: attempt.runner,
        prompt: finalPrompt,
        modelId: task.assignedModel?.modelId,
        thinkingEffort: task.assignedModel?.thinkingEffort,
        modelVariants: task.assignedModel?.availableVariants,
        mode: task.taskMode ?? 'build',
        cwd,
        registry: this.registry ?? undefined,
        order: task.order,
        title: task.title,
        env,
        transport,
        resumeSessionId: kind.kind === 'continuation' ? kind.resumeSessionId : undefined,
        attempt: attempt.attempt,
      });

      // Stop/load/cancel can end the attempt while the async adapter is
      // starting. Do not resurrect that execution after the surface already
      // went idle — and compare identity, not presence, because a newer
      // attempt of the same task may have been claimed in the meantime.
      if (this.attempts.get(task.id) !== attempt) {
        this.abandonSpawn(task, attempt, session);
        return false;
      }
      if (kind.kind === 'continuation' && !isStructuredSession(session)) {
        // A terminal session ignored the resume and started fresh, with none of
        // what the message refers to.
        session.kill();
        throw new Error(routeTransport(transport, attempt.runner, this.registry).fallback ?? 'this surface cannot run structured tasks');
      }
      attempt.phase = 'running';
      attempt.session = session;
      this.recordTransport(task, attempt, transport, session);
      if (takesSkills(kind)) this.store.setTaskAttemptSkills(task.id, [...attempt.skills]);

      // Attached before the verifier so the chunk that carries the marker is
      // captured before that chunk's verdict asks for the final text.
      this.output.attach(task.id, session);
      this.verifier.watch(task, session);
      if (isStructuredSession(session)) session.onTurnEnd(() => this.onTurnEnd(task.id, attempt, session));
      this.watchBlockingPrompts(task, attempt, session);
      return true;
    } catch (err) {
      if (this.attempts.get(task.id) !== attempt) {
        this.abandonSpawn(task, attempt);
        return false;
      }
      this.endAttempt(task.id, 'spawn-failed');
      // Each way out settles the task's status before it awaits anything, so
      // no tick in between finds it in progress with no attempt.
      if (attempt.kind.kind === 'continuation') {
        const reason = unresumedMessage(task, `could not start: ${err instanceof Error ? err.message : String(err)}`);
        this.store.markFailed(task.id);
        this.store.setTaskOutputSummary(task.id, summarizeOutput(reason, ''));
        await this.runs.release(task.id, { keep: false });
        this.notifications.error(reason);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      if (attempt.kind.kind === 'repair') {
        this.store.markAwaitingUser(task.id, 'conflict');
        this.settleUnlanded(task, await this.landing.unrepaired(task, `could not start: ${err instanceof Error ? err.message : String(err)}`));
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      if (err instanceof TaskSkillsError) {
        // Running without a skill the plan attached would be a silent rewrite
        // of the plan (ADR-0001): the task fails, saying what was missing.
        this.store.markFailed(task.id);
        this.store.setTaskOutputSummary(task.id, summarizeOutput(err.message, ''));
        await this.runs.release(task.id, { keep: false });
        this.haltOnFailure();
        this.tell('error', err.message);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      // Couldn't spawn — the task was never executed, so it stays "to do".
      // Held out of auto-scheduling to avoid a spawn-throw retry loop.
      this.store.markPending(task.id);
      this.onHold.add(task.id);
      await this.runs.release(task.id, { keep: false });
      this.tell('error', `Failed to start task "${task.title}": ${err}`);
      this.emit('onTaskChanged');
      await this.tick();
      return false;
    }
  }

  /**
   * Say on the task how this attempt is driven, when it asked for the
   * structured transport; a terminal request records nothing. A structured
   * request that came back a terminal session is a fallback, and says why —
   * a host without a router included — never a silent downgrade.
   */
  private recordTransport(task: Task, attempt: TaskAttempt, requested: RunnerTransport, session: ITerminalSession): void {
    if (requested !== 'structured') {
      this.store.setTaskTransport(task.id, undefined);
      return;
    }
    if (isStructuredSession(session)) {
      this.store.setTaskTransport(task.id, { kind: 'structured' });
      return;
    }
    const fallback = routeTransport(requested, attempt.runner, this.registry).fallback ?? 'this surface cannot run structured tasks';
    this.store.setTaskTransport(task.id, { kind: 'terminal', fallback });
  }

  /**
   * A continue whose runner never announced the session it was told to
   * resume. Nothing was continued, and nothing fresh was started in its place.
   */
  private unresumed(attempt: TaskAttempt): boolean {
    const session = attempt.session;
    return attempt.kind.kind === 'continuation' && session !== null && isStructuredSession(session) && !session.nativeSessionId();
  }

  /**
   * A spawn whose attempt ended while it was in flight: kill what it produced
   * and take back the claim it made. Only the claim — whatever ended the
   * attempt may have decided the task since (mark complete, cancel, retry).
   */
  private abandonSpawn(task: Task, attempt: TaskAttempt, session?: ITerminalSession): void {
    session?.kill();
    if (this.attempts.has(task.id) || this.store.get(task.id)?.status !== 'in_progress') return;
    if (attempt.kind.kind === 'repair') this.store.markAwaitingUser(task.id, 'conflict');
    else this.store.markPending(task.id);
    this.emit('onTaskChanged');
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
   * run in the workspace root, knowingly.
   */
  async continueBlockedRun(how: 'stash' | 'shared'): Promise<void> {
    const resume = await this.runs.continueBlocked(how);
    if (resume) await resume();
  }

  /**
   * The one way an attempt ends. Dropping the record is itself what
   * invalidates a spawn still in flight ({@link startTask} kills the session
   * it receives for an attempt that is no longer current).
   *
   * A user interruption also bumps the verifier's generation *before* stopping
   * the runner: some runners (e.g. tmux) fire onExit synchronously from
   * stop(), and if that exit reaches VerdictEngine under the still-valid
   * generation it delivers a verdict that marks the task 'completed' for one
   * tick — long enough for the scheduler to start a dependent task. A verdict
   * leaves a terminal runner up so its screen stays readable (a structured one
   * ends), and stop/load reset the whole verifier themselves.
   */
  private endAttempt(taskId: string, reason: AttemptEnd): TaskAttempt | undefined {
    const attempt = this.attempts.get(taskId);
    this.attempts.delete(taskId);
    if (attempt) this.output.detach(taskId);
    const session = attempt?.session ?? null;
    const structured = session !== null && isStructuredSession(session);
    const transport: RunnerTransport = structured ? 'structured' : 'terminal';
    if (structured) this.saveNativeSession(taskId, session.nativeSessionId());
    if (session && keepsTerminalReadable(reason, transport)) this.lingering.remember(taskId, session.id);
    if (stopsRunner(reason, transport)) {
      const task = this.store.get(taskId);
      if (task) this.verifier.clear(task);
      if (session) this.terminalRunner.stop(session.id);
    }
    return attempt;
  }

  /** Kept on the task once the attempt ends, so a continue can resume it after a reload (ADR-0018, K1). */
  private saveNativeSession(taskId: string, nativeSessionId: string | null): void {
    const recorded = this.store.get(taskId)?.transport;
    if (!nativeSessionId || recorded?.kind !== 'structured') return;
    this.store.setTaskTransport(taskId, { ...recorded, nativeSessionId });
  }

  private endAllAttempts(reason: 'stop' | 'load'): TaskAttempt[] {
    const ended = [...this.attempts.values()];
    for (const { taskId } of ended) this.endAttempt(taskId, reason);
    this.verifier.reset();
    if (reason === 'load') this.output.reset();
    return ended;
  }
}

/** How much of an ops task's last attempt the next one is shown. */
const OPS_RETRY_TAIL_LINES = 60;

function unresumedMessage(task: Task, why: string): string {
  return `Could not continue task "${task.title}": ${why}. Retry starts it afresh.`;
}

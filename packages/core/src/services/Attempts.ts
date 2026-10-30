import * as path from 'path';
import { taggedReadOnlyMode, unavailableTaskModeMessage } from './ModeResolver';
import { McpAttachError, McpAttachTimeout, RunnerStartupExit } from './harness/ordewellBinding';
import type { RunnerId, Task, TaskOutputSummary, TaskSkillSnapshot, Verdict } from '../models/Task';
import type { IConfig } from '../interfaces/IConfig';
import type { INotification } from '../interfaces/INotification';
import type { IRunner, IRunnerSession, QueuedTaskMessage, StructuredTurnEnd } from '../interfaces/IRunner';
import type { TaskShell, TaskShellSite } from '../interfaces/IFileSystem';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import type { PreviousWork, TreeSnapshot } from '../interfaces/IWorktreeIsolation';
import { countedSessionCost, resumedSessionWindow } from '../models/Usage';
import { summarizeOutput } from './promptAugment';
import { endedByExit, VerdictEngine } from './VerdictEngine';
import type { PlanStore } from './PlanStore';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { IsolationRunController } from './IsolationRunController';
import type { Landing, LandingOutcome } from './Landing';
import { SELF_REPO } from './isolationRecord';
import { TaskStartConfig } from './taskStartConfig';
import { taskRefOf } from './TaskRefs';
import { classifyRunnerStop, stopsRunner, type AttemptEnd, type TurnFailure } from './runnerExit';
import type { ResearchTasks } from './ResearchTasks';
import {
  attemptCwd, attemptPrompt, checksTree, classifyAttempt, landsNothing, mergeExcludes, takesSkills, writesCommit,
  type AttemptKind, type Continuation, type TaskWork,
} from './attemptKind';
import { resolveTaskSkills, TaskSkillsError, type SkillLookup } from './taskSkills';
import { workspaceSkillRoots } from './SkillsService';
import type { WorkspaceEnv } from './workspaceEnv';
import { supportsTaskMode } from './harness/connectors';
import { quotedList } from '../utils/quotedList';
import { scriptBodyOf } from '../models/ScriptTask';
import { SCRIPT_RUNNER } from './ScriptRunner';
import { checkHandoff, withPatch, type HandoffPatch, type StoredHandoff } from '../models/Handoff';
import { applySavedPatch, capturePatch, patchArtifact, patchReply } from './PatchCapture';
import { readTask, type TaskLogReader } from './readTask';
import { defaultExecFile, type GitInvoker } from './gitExec';
import { augmentedPath } from '../utils/shellPath';
import type { ApplyPatchArgs, McpToolReply } from './mcp/tools';
import { TaskControlError } from './TaskControlError';
import { TaskWebReader } from './taskWebReads';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { OrchestratorObserver, StartAdmission } from './TaskOrchestrator';

class TaskStartConfigError extends Error {
  constructor(paths: string[]) {
    super(`repository configuration ${paths.map((p) => JSON.stringify(p)).join(', ')} differs from where this run started; remove it to continue, or start a new run once your branch holds it`);
  }
}

/** Where a start stands against the user's Stop (ADR-0029): no longer current once one comes. */
export type Admitted = Pick<StartAdmission, 'current'>;

export type AttemptPhase = 'starting' | 'running' | 'integrating';

/** What the scheduler reads of an attempt, live or ended. */
export interface EndedAttempt {
  readonly taskId: string;
  readonly runner: string;
  /** What this attempt is, which decides where it runs, what it is told and what is checked; see {@link AttemptKind}. */
  readonly kind: AttemptKind;
  /** Whether it ran in a worktree prepared for it rather than the workspace root. */
  readonly worktree: boolean;
  /** The landing in flight, so a cancel waits for it before tearing the worktree down. */
  readonly integration: Promise<LandingOutcome> | null;
  /**
   * The start it was claimed for, as the user's Stop stands to it. The repair
   * its conflict is owed claims under it too, so a Stop since withdraws that
   * repair as it withdrew the attempt.
   */
  readonly admission: Admitted;
  /** Resumed after a usage limit, at its reset or by a Resume now, rather than started: one that hits the limit again at once is not resumed on its own again (`LimitPauses`). */
  readonly autoResumed: boolean;
  readonly startedAt: string;
}

/**
 * One run of one task, from the moment the scheduler claims it until its
 * verdict, cancel, stop or plan load. Everything that has to die with the run
 * lives on this record, so {@link Attempts.end} releases all of it at once and
 * nothing can be left behind for one exit path to forget.
 */
interface TaskAttempt extends EndedAttempt {
  /** 1-based count of spawns, continued from the persisted attempt ledgers. */
  readonly attempt: number;
  /**
   * `starting` while the async spawn is in flight; `session` is null until
   * `running`. `integrating` once its verdict is with {@link Landing} — still
   * live, so the task neither completes nor frees its dependents until the
   * landing says so.
   */
  phase: AttemptPhase;
  session: IRunnerSession | null;
  /** Null until {@link attemptCwd} settles. */
  cwd: string | null;
  worktree: boolean;
  integration: Promise<LandingOutcome> | null;
  /** The workspace's tracked state as the attempt started, when its tree is checked; what that check compares with. */
  snapshot: TreeSnapshot | null;
  /**
   * Set as its verdict arrives, before the verdict is applied: the turn that
   * called `task_complete` ends while the verdict is still settling, and must
   * not read as waiting for input.
   */
  decided: boolean;
  /** The task skills put in this attempt's prompt, as read from where it runs. */
  skills: readonly TaskSkillSnapshot[];
  /** Why the running turn failed, as the runner reported it, if it did. */
  turnError: TurnFailure | null;
  /** Where the running turn's output starts in the session's. */
  turnOutputFrom: number;
  /** The completion reminder went out: once per attempt, so a second turn without `task_complete` waits for input. */
  reminded: boolean;
  /**
   * Its runner was told to stop (ADR-0018, L1). What it reports as it winds
   * down is still this attempt's, though the attempt has ended.
   */
  runnerStopped: boolean;
  /**
   * The plan scope it was claimed in. A plan loaded after it ends the scope:
   * what the runner still reports belongs to the old plan's task, never to a
   * task of the new one that happens to reuse its id.
   */
  readonly planScope: number;
  /** A script task's attempt (ADR-0035): the script runner runs its body, with no model. */
  readonly script: boolean;
  /** A read-only attempt's `run_command` (ADR-0046), ended with the attempt. */
  shell: TaskShell | null;
  /** A read-only attempt's `fetch` and `web_search` (ADR-0046), ended with the attempt. */
  web: TaskWebReader | null;
  /** The patch it last saved (ADR-0050), which its handoff names. */
  patch: HandoffPatch | null;
  /**
   * What its runner's accepted `task_complete` call reported, while the report
   * still stands (ADR-0018, L1): a receipt for surfaces, never a verdict. A new
   * turn or a message the runner reads voids it, as it voids the report.
   */
  receipt: Verdict['reported'] | null;
  /**
   * Which spawn of its runner waits for Ordewell's tools to connect
   * (ADR-0025); null until its runner starts and once the tools connect.
   * Progress for surfaces: the wait itself is the runner's.
   */
  attaching: 1 | 2 | null;
  /**
   * Aborted as the attempt ends, so a runner still starting — waiting for its
   * tools to attach, or respawning — is taken back then, not once it reports.
   */
  readonly spawning: AbortController;
}

const DEFAULT_GIT: GitInvoker = { exec: defaultExecFile, resolvePath: () => augmentedPath() };

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

/** What the user is told of a start that failed. */
export interface AttemptNotice {
  level: 'warn' | 'error';
  text: string;
  /** Toasted only, as a failed verdict is; otherwise a surface that shows no toasts hears it too. */
  toastOnly?: true;
}

/**
 * How a start that never ran leaves its task. Nothing ran, so no verdict is
 * recorded, and the error it failed with decides:
 * - `failed`: it cannot run as the plan holds it — a skill it names is
 *   missing, its runner refused the Ordewell server or its saved session —
 *   so it blocks its dependents until a retry passes (ADR-0034).
 * - `held`: it may run if started again, so it stays not started, out of the
 *   scheduler with `hold` as the reason, and blocks nothing. `settles` when a
 *   supervisor is to hear of it, as of a runner that never connected (ADR-0022, S2).
 * - `conflict`: a repair that could not start leaves the task as its
 *   conflict did, waiting on the user (ADR-0015).
 */
export type SpawnFailure =
  | { leaves: 'failed'; summary: TaskOutputSummary; keepWorktree: boolean; notice: AttemptNotice }
  | { leaves: 'held'; hold: string; notice: AttemptNotice; settles: boolean; preserveWorktree?: boolean }
  | { leaves: 'conflict'; why: string };

/**
 * How an attempt ended on its own, for the scheduler to apply: it marks the
 * task, settles the run and starts what follows. By the time one is reported
 * the attempt is over — no longer live, its runner told to stop — and any
 * verdict and handoff are recorded on the task. Endings the scheduler causes
 * itself (cancel, retry, skip, Mark complete, stop, a plan load) are not
 * reported: the scheduler ends those through {@link Attempts.end}.
 *
 * - `passed`: its verdict passed and Landing settled its work.
 * - `files-changed`: an ops attempt passed but changed tracked files in the
 *   checkout (ADR-0020), so nothing of it is committed.
 * - `failed`: its verdict did not pass; `unresumed` when it was a continue
 *   whose runner never found the session it was told to resume.
 * - `repaired`: a conflict repair's verdict, settled by Landing; the task
 *   keeps the verdict its own work earned (ADR-0015).
 * - `usage-limited`: its runner's usage limit ended it — mid-turn, as a turn's
 *   error, or by refusing its start — which is a pause, not a verdict
 *   (ADR-0018, U1). `said` is what the runner reported; `output` what the
 *   attempt printed.
 * - `spawn-failed`: it never ran; see {@link SpawnFailure}.
 * - `unsettled`: applying its verdict threw. `attempt` when it was still live
 *   and has been ended for it; null when it had settled and what followed threw.
 */
export type AttemptEnded =
  | { kind: 'passed'; task: Task; attempt: EndedAttempt; verdict: Verdict; landing: LandingOutcome }
  | { kind: 'files-changed'; task: Task; attempt: EndedAttempt; verdict: Verdict; files: string[] }
  | { kind: 'failed'; task: Task; attempt: EndedAttempt; verdict: Verdict; unresumed: string | null }
  | { kind: 'repaired'; task: Task; attempt: EndedAttempt; verdict: Verdict; landing: LandingOutcome }
  | { kind: 'usage-limited'; taskId: string; attempt: EndedAttempt; said: string | TurnFailure; output: string }
  | { kind: 'spawn-failed'; task: Task; attempt: EndedAttempt; failure: SpawnFailure }
  | { kind: 'unsettled'; taskId: string; attempt: EndedAttempt | null; reason: string };

/** The claim a start took, as the scheduler granted it. */
export interface AttemptClaim {
  admission: Admitted;
  /** A continue of the task's saved session (ADR-0018, K1); a fresh session when absent. */
  continuation?: Continuation | null;
  autoResumed?: boolean;
}

/** What a control on a running task's turn is, as a refused {@link TaskControlError} names it: "no turn to …". */
export type TaskControl = keyof typeof CONTROL_WORDS;

/** The scheduler's side of an attempt: what it is told, and what it answers about the task across attempts. */
export interface AttemptsHost {
  /** Apply how an attempt ended. Awaited: the attempt's own path, a spawn or a verdict, goes on only once it has settled. */
  settle(ended: AttemptEnded): Promise<void>;
  /** Mark complete is landing the task: in progress with no attempt for as long as that takes. */
  completing(taskId: string): boolean;
  /** The task has been retried since the session loaded, so an attempt before this one ran even when nothing of it is left. */
  retried(taskId: string): boolean;
  /** The round a loop's check ran before this one, and what it reported (ADR-0045). */
  previousRound(taskId: string): { round: number; report?: string } | undefined;
  emit<K extends keyof OrchestratorObserver>(event: K, ...args: Parameters<NonNullable<OrchestratorObserver[K]>>): void;
  tell(level: 'info' | 'warn' | 'error', message: string): void;
  /** Work nothing awaits: a rejection is said, not left unhandled. */
  unawaited(work: Promise<unknown>, failure: string): void;
}

export interface AttemptsDeps {
  config: Pick<IConfig, 'planMapEnabled'>;
  notifications: INotification;
  runner: IRunner;
  /** Runs script tasks' bodies (ADR-0035), in place of a registered runner. */
  scriptRunner: IRunner;
  store: PlanStore;
  output: TaskOutputSource;
  /** Where an attempt runs, and its worktree once it ends. */
  runs: Pick<IsolationRunController, 'attemptCwd' | 'workspaceCwd' | 'snapshotWorkspace' | 'filesChangedSince' | 'release' | 'openRecord' | 'skillLayout' | 'current' | 'epoch'>;
  /** A passed attempt's work, or a repair's, onto the integration branch, while the attempt stays live. */
  landing: Pick<Landing, 'landPassed' | 'settleRepair' | 'nextRepair' | 'repairPrompt'>;
  registry: RunnerRegistry | null;
  /** The workspace root, read at call time — VS Code can change it. */
  workspaceRoot: () => string;
  /** The workspace's own variables for a task's cwd (ADR-0016). */
  workspaceEnv: (cwd: string) => Promise<WorkspaceEnv>;
  /** The skill catalog over workspace roots, as {@link workspaceSkillRoots} orders them — read at each spawn. */
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
  /** A read-only attempt's shell (ADR-0046); absent, its runner is given no `run_command`. */
  taskShell?: (site: TaskShellSite) => TaskShell | undefined;
  /**
   * The session's web fetcher for one read-only attempt, by its task's title
   * (ADR-0046, `IWebFetcher.forTask`), asked once per attempt so each has its
   * own web-read budget. Absent, its `fetch` and `web_search` are not available.
   */
  taskWebFetcher?: (task: string) => IWebFetcher | undefined;
  /**
   * Keep a read-only attempt's saved patch beside its log, in place of one it
   * kept before, and say where, relative to the workspace root (ADR-0050).
   * Absent, `save_patch` is not available.
   */
  keepPatch?: (taskId: string, attempt: number, patch: Buffer) => string;
  /** The git a change attempt's `apply_patch` runs; the system's by default. */
  git?: GitInvoker;
  /**
   * Write an attempt's whole handoff into the log of the attempt `sessionId`
   * ran (ADR-0047). A task that ran no session, a user task, gets a log of its own.
   */
  recordHandoff: (sessionId: string | undefined, taskId: string, handoff: StoredHandoff) => void;
  /** The session's saved task logs, which a task's `read_task` reads handoffs from (ADR-0047). */
  taskLog: TaskLogReader;
  /** What starting a research task owes the planner (ADR-0037 R3). */
  research?: Pick<ResearchTasks, 'started'>;
  host: AttemptsHost;
}

/**
 * Task attempts (CONTEXT.md, "Task attempt"): every live attempt, from the
 * claim the scheduler grants through its spawn, its runner's turns and its
 * verdict to its end. This owns the attempt map, the runner sessions, the
 * VerdictEngine wiring and the attempt's output; the scheduler owns which
 * task starts and what follows. However an attempt ends on its own — a
 * verdict, its runner's usage limit, a spawn that failed — it is reported as
 * one {@link AttemptEnded} to the scheduler's `settle`, as Landing answers
 * with a LandingOutcome, so this never marks a task done, failed or held.
 */
export class Attempts {
  private readonly live = new Map<string, TaskAttempt>();
  /** Bumped by every plan load: an ended attempt's wind-down belongs to the scope before it. */
  private planScope = 0;
  private readonly startConfig = new TaskStartConfig();
  /** Each task's runners still winding down once stopped: a continue waits for them (ADR-0018, L1). */
  private readonly windDowns = new Map<string, Promise<void>>();
  /**
   * How often each task has spawned, which numbers its next attempt. It
   * describes the task across attempts, so it lives outside the record:
   * ending an attempt must not forget how often the task has run.
   */
  private readonly spawnCounts = new Map<string, number>();
  private readonly verifier = new VerdictEngine();
  /** What the workspace env has already warned about, so a run says it once, not per task. */
  private readonly envWarnings = new Set<string>();
  private readonly host: AttemptsHost;

  constructor(private readonly deps: AttemptsDeps) {
    this.host = deps.host;
    this.verifier.onVerdict((taskId, verdict) => { void this.deliver(taskId, verdict); });
    this.verifier.onCheckpoint((taskId, summary) => {
      const task = this.deps.store.get(taskId);
      if (!task) return;
      this.deps.store.markAwaitingUser(taskId, 'checkpoint');
      this.verifier.pauseIdle(taskId);
      this.host.emit('onTaskSettled', { taskId });
      this.host.emit('onTaskChanged');
      this.host.emit('onCheckpoint', { taskId, taskTitle: task.title, summary });
    });
    this.verifier.onCheckpointWithdrawn((taskId) => {
      if (!this.awaitsCheckpoint(taskId)) return;
      this.deps.store.markInProgress(taskId);
      this.host.emit('onTaskChanged');
    });
    // idleSince is advisory UI state, not a store mutation — broadcast it
    // through the same onTaskChanged seam without touching PlanStore. Only
    // going silent is news to a supervisor: null also comes on teardown.
    this.verifier.onIdleChange((taskId, idleSince) => {
      if (idleSince) this.host.emit('onTaskIdle', { taskId, idleSince });
      this.host.emit('onTaskChanged');
    });
  }

  has(taskId: string): boolean {
    return this.live.has(taskId);
  }

  /** How many attempts are live: what the run's Parallel limit counts. */
  get size(): number {
    return this.live.size;
  }

  taskIds(): string[] {
    return [...this.live.keys()];
  }

  phaseOf(taskId: string): AttemptPhase | undefined {
    return this.live.get(taskId)?.phase;
  }

  /** The task of a live attempt that no Merge all may run beside ({@link mergeExcludes}), if any. */
  excludingMerge(): string | undefined {
    return [...this.live.values()].find((a) => mergeExcludes(a.kind))?.taskId;
  }

  snapshot(taskId: string): TaskAttemptSnapshot | undefined {
    const attempt = this.live.get(taskId);
    if (!attempt) return undefined;
    const { taskId: id, attempt: n, phase, session, runner, cwd, startedAt, skills } = attempt;
    return { taskId: id, attempt: n, phase, sessionId: session?.id ?? null, runner, cwd, startedAt, skills };
  }

  /** Task id → session id of every attempt whose runner is up; a spawn in flight has no session yet. */
  sessionMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, attempt] of this.live) {
      if (attempt.session) map.set(taskId, attempt.session.id);
    }
    return map;
  }

  /** Recent clean output of a task's latest attempt, running or ended; null if it never ran. */
  liveTail(taskId: string, opts: LiveTailOptions): LiveTail | null {
    return this.deps.output.liveTail(taskId, opts);
  }

  /** Advisory silence timestamp for a task's live runner, or null if not idle. */
  idleSince(taskId: string): string | null {
    return this.verifier.getIdleSince(taskId);
  }

  /** What the live attempt's runner reported through `task_complete`, while its report stands; null otherwise. */
  receipt(taskId: string): Verdict['reported'] | null {
    return this.live.get(taskId)?.receipt ?? null;
  }

  /** Which spawn of the live attempt's runner waits for Ordewell's tools to connect; null when none does. */
  attaching(taskId: string): 1 | 2 | null {
    return this.live.get(taskId)?.attaching ?? null;
  }

  /** The kind a task's next attempt starts as, short of a repair or a continue: what is weighed before one exists. */
  nextKind(taskId: string): AttemptKind {
    const task = this.deps.store.get(taskId);
    return classifyAttempt(task ? this.workOf(task) : 'change', { carriedFrom: task?.carriedFrom });
  }

  /**
   * Take the claim the scheduler granted for `task`, as the plan holds it
   * now. The attempt is live, numbered and in progress before this returns,
   * so no other start can take the same task or slot; its spawn goes on in
   * the promise returned, and a spawn that fails is reported, not thrown.
   */
  start(task: Task, claim: AttemptClaim): Promise<void> {
    const { store } = this.deps;
    const continuation = claim.continuation ?? null;
    const script = task.type === 'script';
    const attempt: TaskAttempt = {
      taskId: task.id,
      attempt: Math.max(this.spawnCounts.get(task.id) ?? 0, this.deps.lastLoggedAttempt(task.id), ...task.attemptUsage?.map((u) => u.attempt) ?? []) + 1,
      phase: 'starting',
      session: null,
      runner: script ? SCRIPT_RUNNER : store.resolveTaskRunner(task),
      cwd: null,
      worktree: false,
      integration: null,
      kind: classifyAttempt(this.workOf(task), { repair: this.deps.landing.nextRepair(task.id), continuation, carriedFrom: task.carriedFrom }),
      snapshot: null,
      startedAt: new Date().toISOString(),
      decided: false,
      skills: [],
      admission: claim.admission,
      autoResumed: claim.autoResumed === true,
      turnError: null,
      turnOutputFrom: 0,
      reminded: false,
      runnerStopped: false,
      planScope: this.planScope,
      script,
      shell: null,
      web: null,
      patch: null,
      receipt: null,
      attaching: null,
      spawning: new AbortController(),
    };
    this.spawnCounts.set(task.id, attempt.attempt);
    this.live.set(task.id, attempt);
    this.deps.research?.started(task);
    // Before the status leaves: a surface may show its chat from the first
    // status of the attempt, with no output or usage required yet.
    store.markAttempted(task.id);
    // A script spends nothing a ledger counts: no model, no tokens (ADR-0035).
    if (!script) store.startAttemptUsage(task.id, attempt.attempt, attempt.runner, attempt.startedAt);
    store.setTaskOutputSummary(task.id, undefined);
    store.markInProgress(task.id);
    this.host.emit('onTaskChanged');
    return this.run(task, attempt, continuation);
  }

  /**
   * The one way an attempt ends. Dropping the record is itself what
   * invalidates a spawn still in flight ({@link run} kills the session it
   * receives for an attempt that is no longer current), and its cancel takes
   * back a runner still starting meanwhile.
   *
   * A user interruption also bumps the verifier's generation *before* stopping
   * the runner: a runner may fire onExit synchronously from
   * stop(), and if that exit reaches VerdictEngine under the still-valid
   * generation it delivers a verdict that marks the task 'completed' for one
   * tick — long enough for the scheduler to start a dependent task. Stop and
   * load reset the whole verifier themselves.
   */
  end(taskId: string, reason: AttemptEnd): EndedAttempt | undefined {
    const { store } = this.deps;
    const attempt = this.live.get(taskId);
    this.live.delete(taskId);
    const session = attempt?.session ?? null;
    const nativeSessionId = session?.nativeSessionId() ?? null;
    if (attempt) {
      attempt.spawning.abort();
      store.endAttemptUsage(taskId, attempt.attempt, new Date().toISOString(), session?.sessionCost?.() ?? undefined, nativeSessionId ?? undefined);
      this.deps.output.detach(taskId);
      attempt.shell?.end();
      attempt.web?.end();
    }
    if (attempt && session) this.saveNativeSession(taskId, nativeSessionId, attempt.runner);
    if (stopsRunner(reason)) {
      const task = store.get(taskId);
      if (task) this.verifier.clear(task);
      if (attempt) this.stopRunner(attempt);
    }
    return attempt;
  }

  /**
   * The user's Stop: every attempt ends, each runner let go as any ended
   * attempt's is, so what it reports meanwhile is still counted; whatever is
   * still starting goes too.
   */
  stopAll(): EndedAttempt[] {
    // Let the verifier go before the runners: a killed session fires its exit
    // synchronously, and under a still-valid generation that exit is a verdict
    // — for a conflict repair, one that lands work the stop just cancelled.
    this.verifier.reset();
    for (const attempt of this.live.values()) this.stopRunner(attempt);
    this.deps.runner.stopAll();
    this.deps.scriptRunner.stopAll();
    return this.endAll('stop');
  }

  /**
   * End what belongs to a plan being replaced, before it is swapped: its
   * ledgers are its tasks', and a task of the next plan that reuses an id
   * must not inherit them. The scope then closes, so a runner still winding
   * down reports into nothing rather than into the next plan.
   */
  unload(): EndedAttempt[] {
    const ended = this.endAll('load');
    this.planScope += 1;
    this.spawnCounts.clear();
    this.startConfig.clear();
    return ended;
  }

  /** A task leaving the plan: no later attempt of it is numbered from its runs. */
  forget(taskId: string): void {
    this.spawnCounts.delete(taskId);
  }

  /** Mark complete: the user vouches for the work, which is the verdict, and the task's verification ends. */
  markComplete(task: Task): Verdict {
    return this.verifier.markComplete(task);
  }

  /** Forget what the task's verification held, so nothing an earlier attempt left settles it. */
  clear(task: Task): void {
    this.verifier.clear(task);
  }

  /**
   * How a task's latest attempt ended and the handoff it left (ADR-0047): the
   * plan keeps the digest and the attempt's log the whole of it. One path for
   * an attempt a runner or a script ran, and for the completion a user marked.
   */
  handOver(taskId: string, summary: Task['outputSummary'], handoff: StoredHandoff | undefined, sessionId?: string): void {
    this.deps.store.setTaskOutputSummary(taskId, summary, handoff);
    if (handoff) this.deps.recordHandoff(sessionId, taskId, handoff);
  }

  /**
   * The number of the task's latest attempt, live or ended; 0 before any ran.
   * A script's attempt has no ledger, so after a reload only its log says.
   */
  latestAttempt(task: Readonly<Task>): number {
    const known = Math.max(this.spawnCounts.get(task.id) ?? 0, ...task.attemptUsage?.map((u) => u.attempt) ?? []);
    return known > 0 || task.type === 'user' ? known : this.deps.lastLoggedAttempt(task.id);
  }

  /*
   * The saved reason says what the task waits on. The live attempt stays a
   * guard: a checkpoint reloaded from disk has no runner left to answer it,
   * and putting it back to in_progress would strand it with nothing behind it.
   */
  awaitsCheckpoint(taskId: string): boolean {
    return this.deps.store.get(taskId)?.awaitingReason === 'checkpoint' && this.live.has(taskId);
  }

  approveCheckpoint(taskId: string): void {
    if (!this.awaitsCheckpoint(taskId)) return;
    this.verifier.approveCheckpoint(taskId);
    this.deps.store.markInProgress(taskId);
    this.host.emit('onTaskChanged');
  }

  rejectCheckpoint(taskId: string, reason?: string): void {
    if (!this.awaitsCheckpoint(taskId)) return;
    this.verifier.rejectCheckpoint(taskId, reason ?? 'Checkpoint rejected by user');
    this.deps.store.markInProgress(taskId);
    this.host.emit('onTaskChanged');
  }

  /** What the task's waiting checkpoint asks, whole; undefined once it settles or when none waits. */
  checkpointQuestion(taskId: string): string | undefined {
    return this.verifier.getCheckpointQuestion(taskId);
  }

  /**
   * Hand the running task's runner `text` through `send`. A task waiting for
   * input is back in progress; one at a checkpoint is answered there instead.
   */
  message(taskId: string, text: string, control: TaskControl, send: (session: IRunnerSession, message: string) => string): string {
    const message = text.trim();
    if (!message) throw new TaskControlError('A message to a task cannot be empty.');
    const task = this.deps.store.get(taskId);
    const session = this.runningSession(taskId, control);
    // The command seam words this refusal for who asked (ADR-0029), so a model is told the tool or the card; this is for a caller past the seam.
    if (task?.status === 'awaiting_user' && task.awaitingReason !== 'input') {
      throw new TaskControlError(`Task "${task.title}" is at a checkpoint: approve or reject it instead.`);
    }
    const id = send(session, message);
    if (task?.status === 'awaiting_user') this.deps.store.markInProgress(taskId);
    this.host.emit('onTaskChanged');
    return id;
  }

  forceSendQueued(taskId: string, id: string): boolean {
    const sent = this.runningSession(taskId, 'force').forceSendQueued(id);
    if (sent) this.host.emit('onTaskChanged');
    return sent;
  }

  removeQueued(taskId: string, id: string): boolean {
    const removed = this.runningSession(taskId, 'message').removeQueued(id);
    if (removed) this.host.emit('onTaskChanged');
    return removed;
  }

  async interrupt(taskId: string): Promise<void> {
    await this.runningSession(taskId, 'interrupt').interrupt();
  }

  queued(taskId: string): QueuedTaskMessage[] {
    return this.live.get(taskId)?.session?.queued() ?? [];
  }

  private runningSession(taskId: string, control: TaskControl): IRunnerSession {
    const task = this.deps.store.get(taskId);
    if (!task) throw new TaskControlError(`No task ${taskId} in this plan.`);
    if (task.type === 'script') throw new TaskControlError(`Task "${task.title}" is a script task: it runs no model, so there is no turn to ${CONTROL_WORDS[control]}. Stop it, or edit its body and retry it.`);
    const attempt = this.live.get(taskId);
    const session = attempt?.session;
    if (!attempt || !session || attempt.phase !== 'running' || attempt.decided) {
      throw new TaskControlError(`Task "${task.title}" is not running, so there is no turn to ${CONTROL_WORDS[control]}.`);
    }
    return session;
  }

  /**
   * What a task's work is. A read-only task is one on the mode its runner's
   * manifest tags read-only (ADR-0001), which is what lands nothing (ADR-0046).
   */
  private workOf(task: Task): TaskWork {
    if (this.deps.store.isOps(task.id)) return 'ops';
    const modes = this.deps.registry?.get(this.deps.store.resolveTaskRunner(task))?.manifest.modes;
    return task.type === 'ai' && task.taskMode !== undefined && task.taskMode === taggedReadOnlyMode(modes) ? 'readOnly' : 'change';
  }

  private async run(task: Task, attempt: TaskAttempt, continuation: Continuation | null): Promise<void> {
    if (!(await this.spawn(task, attempt))) return;

    // Committed as running: notify observers only now, outside the fallible
    // spawn path above, so an observer throwing here is never mistaken for a
    // failed spawn (which would tear down the attempt it just announced).
    if (attempt.worktree) this.host.emit('onIsolationChanged');
    this.host.emit('onTaskChanged');
    if (attempt.kind.kind === 'repair') {
      const group = this.deps.runs.current?.repos.some((r) => r.path !== SELF_REPO);
      const { n, limit } = attempt.kind.repair;
      this.host.tell('info', `Repairing the conflict of task "${task.title}" in its own ${group ? 'worktrees' : 'worktree'} (repair ${n} of ${limit}).`);
    } else {
      this.deps.notifications.info(`Task "${task.title}" ${continuation ? 'continued' : 'started'} (${attempt.runner})`);
    }
  }

  /**
   * The fallible half of starting a task: resolving its cwd/worktree and
   * spawning the runner. Resolves false when the attempt never committed —
   * abandoned because it was ended from under it, or a failed spawn already
   * reported and settled (both leave {@link run} with nothing to announce).
   */
  private async spawn(task: Task, attempt: TaskAttempt): Promise<boolean> {
    const { store, runs } = this.deps;
    try {
      const { kind } = attempt;
      if (!attempt.script) {
        // Nothing can drive a runner without a structured connector, so it is
        // refused before a worktree is made for it.
        if (!supportsTaskMode(attempt.runner)) {
          const name = this.deps.registry?.get(attempt.runner)?.manifest.displayName ?? attempt.runner;
          throw new Error(`${name} has no structured connector, so Ordewell cannot run its tasks. Assign the task to another runner.`);
        }
        // The plan fixed this mode when it was made and ADR-0001 forbids
        // swapping it here, so a host that cannot run it ends the attempt
        // before a worktree is made for it.
        const manifest = this.deps.registry?.get(attempt.runner)?.manifest;
        const unavailable = manifest && unavailableTaskModeMessage(manifest, task.taskMode);
        if (unavailable) throw new Error(unavailable);
      }
      // Resumed beside a runner still winding it down, a session would run in
      // two processes, and count from before what the first one still reports.
      if (kind.kind === 'continuation') await this.windDowns.get(task.id);
      if (!attempt.script && kind.kind === 'repair') {
        const paths = await this.startConfig.check(runs.current, task.id, { epoch: runs.epoch, root: this.deps.workspaceRoot(), cwd: null, worktree: true });
        if (paths.length) throw new TaskStartConfigError(paths);
      }
      const { cwd, worktree, previousWork, workspace } = await attemptCwd(kind, task, runs);
      attempt.cwd = cwd;
      attempt.worktree = worktree;
      // A read-only task withholds project configuration (ADR-0046), so none reaches it.
      if (!attempt.script && kind.kind !== 'repair' && !landsNothing(kind)) {
        const paths = await this.startConfig.check(runs.current, task.id, { epoch: runs.epoch, root: this.deps.workspaceRoot(), cwd, worktree });
        if (paths.length) throw new TaskStartConfigError(paths);
      }
      if (checksTree(kind)) attempt.snapshot = await runs.snapshotWorkspace();
      if (this.live.get(task.id) !== attempt) {
        // Ended while its worktree was being made, so whatever ended it could
        // not release it. A newer attempt's own prepare replaces it instead,
        // and a Mark complete lands what is in it. A repair's worktree holds
        // work that passed, so it is only handed back.
        if (attempt.worktree && !this.live.has(task.id) && !this.host.completing(task.id)) await runs.release(task.id, { keep: kind.kind === 'repair' });
        this.abandonSpawn(task, attempt);
        return false;
      }
      this.verifier.starting(task.id);
      const session = attempt.script
        ? await this.spawnScript(task, attempt, cwd)
        : await this.spawnRunner(task, attempt, cwd, worktree ? workspace : undefined, previousWork);

      // Stop/load/cancel can end the attempt while the async adapter is
      // starting. Do not resurrect that execution after the surface already
      // went idle — and compare identity, not presence, because a newer
      // attempt of the same task may have been claimed in the meantime.
      if (this.live.get(task.id) !== attempt) {
        this.abandonSpawn(task, attempt, session);
        return false;
      }
      attempt.phase = 'running';
      attempt.attaching = null;
      attempt.session = session;
      store.setTaskRunnerSessionId(task.id, undefined);
      store.clearCarriedFrom(task.id);
      if (kind.kind === 'carryOver' && previousWork?.outcome === 'fallback') {
        this.host.tell('warn', `Task "${task.title}" starts fresh on ${attempt.runner}: the work its paused attempt on ${kind.from} left conflicts with the integration tip, so it was not carried over. It is kept on branch ${quotedList([...new Set(previousWork.preserved.map((kept) => kept.branch))])}.`);
      }
      if (takesSkills(kind)) store.setTaskAttemptSkills(task.id, [...attempt.skills]);
      this.watch(task, attempt, session);
      return true;
    } catch (err) {
      if (this.live.get(task.id) !== attempt) {
        this.abandonSpawn(task, attempt);
        return false;
      }
      this.end(task.id, 'spawn-failed');
      await this.host.settle(this.spawnFailed(task, attempt, err));
      return false;
    }
  }

  /** Follow a running attempt's session: its usage, its verdict, its turns and what its runner switches to. */
  private watch(task: Task, attempt: TaskAttempt, session: IRunnerSession): void {
    // Attached before the verifier, so the summary of the call that settles
    // the attempt is captured before its verdict asks for the final text.
    session.onEvent((event) => {
      if (event.type !== 'usage' || attempt.planScope !== this.planScope || (this.live.get(task.id) !== attempt && !attempt.runnerStopped)) return;
      this.deps.store.recordAttemptUsage(task.id, attempt.attempt, event.record, new Date().toISOString());
      this.host.emit('onUsageChanged');
    });
    session.onExit(() => this.woundDown(attempt, session));
    this.deps.output.attach(task.id, session);
    this.verifier.watch(task, session);
    session.onEvent((event) => {
      if (event.type === 'completion_received' || event.type === 'turn_start' || event.type === 'message_delivered') {
        this.noteReceipt(task.id, attempt, event.type === 'completion_received' ? event.status : null);
      }
      if (event.type === 'turn_start') {
        attempt.turnError = null;
        attempt.turnOutputFrom = session.getOutput().length;
      } else if (event.type === 'error') attempt.turnError = event;
      else if (event.type === 'model_switched' || event.type === 'model_drifted') {
        this.host.emit('onModelSwitched', {
          taskId: task.id, sessionId: session.id, from: event.from, model: event.to,
          ...(event.type === 'model_switched' && event.effort ? { effort: event.effort } : {}),
          asked: event.type === 'model_switched', attemptEnded: this.live.get(task.id) !== attempt,
        });
      }
    });
    session.onTurnEnd((reason) => this.turnEnded(task.id, attempt, session, reason));
  }

  /** Only the task's current attempt shows a receipt: a runner from an earlier one, still winding down, changes nothing. */
  private noteReceipt(taskId: string, attempt: TaskAttempt, receipt: TaskAttempt['receipt']): void {
    if (this.live.get(taskId) !== attempt || attempt.receipt === receipt) return;
    attempt.receipt = receipt;
    this.host.emit('onTaskChanged');
  }

  /**
   * How a spawn that threw leaves its task ({@link SpawnFailure}), the
   * attempt already ended; a usage limit that refused the start is a pause.
   */
  private spawnFailed(task: Task, attempt: TaskAttempt, err: unknown): AttemptEnded {
    const message = err instanceof Error ? err.message : String(err);
    // A missed attach is a hold for a start or a continue: nothing ran, so
    // the task is not failed and its saved session stays for a retry.
    const attachTimeout = err instanceof McpAttachTimeout;
    // A script has no runner whose account a limit could stop (ADR-0035).
    if (attempt.kind.kind !== 'repair' && !attempt.script && classifyRunnerStop(message) === 'usage-limit') {
      // The limit refused the turn Ordewell was starting: a pause, as one
      // mid-turn is, and the saved session stays for the resume to continue.
      return { kind: 'usage-limited', taskId: task.id, attempt, said: { message }, output: '' };
    }
    const failed = (failure: SpawnFailure): AttemptEnded => ({ kind: 'spawn-failed', task, attempt, failure });
    if (err instanceof TaskStartConfigError) {
      return failed({ leaves: 'held', hold: err.message, preserveWorktree: true, settles: false, notice: { level: 'warn', text: `Task "${task.title}" is on hold: ${err.message}` } });
    }
    if (attempt.kind.kind === 'continuation' && !attachTimeout) {
      // A runner that exits while starting on a saved session has refused it.
      const refused = err instanceof RunnerStartupExit;
      const reason = unresumedMessage(task, refused ? `${attempt.runner} could not find its saved session` : `could not start: ${message}`);
      if (refused) this.deps.store.setTaskRunnerSessionId(task.id, undefined);
      return failed({ leaves: 'failed', summary: summarizeOutput(reason, refused ? message : ''), keepWorktree: false, notice: { level: 'error', text: reason, toastOnly: true } });
    }
    if (attempt.kind.kind === 'repair') return failed({ leaves: 'conflict', why: `could not start: ${message}` });
    if (attachTimeout) {
      // The runner stayed up but never connected. Nothing was sent to it
      // and no verdict exists, so the task is held with a reason rather
      // than failed: its dependents stay on the plan, and a later start
      // can still run it (ADR-0022, S2).
      return failed({ leaves: 'held', hold: 'could not connect to Ordewell\'s tools; start it again', settles: true, notice: { level: 'warn', text: `Task "${task.title}" is on hold: could not connect to Ordewell's tools. Start it again.` } });
    }
    if (err instanceof TaskSkillsError) {
      // Running without a skill the plan attached would be a silent rewrite
      // of the plan (ADR-0001): the task fails, saying what was missing.
      // An earlier attempt's snapshot would read as what this one was given.
      this.deps.store.setTaskAttemptSkills(task.id, undefined);
      return failed({ leaves: 'failed', summary: summarizeOutput(message, ''), keepWorktree: false, notice: { level: 'error', text: message } });
    }
    if (err instanceof McpAttachError || err instanceof RunnerStartupExit) {
      return failed({ leaves: 'failed', summary: summarizeOutput(message, message), keepWorktree: true, notice: { level: 'error', text: message } });
    }
    // Couldn't spawn — the task was never executed, so it stays "to do".
    // Held out of auto-scheduling to avoid a spawn-throw retry loop.
    return failed({ leaves: 'held', hold: `could not start: ${message}; start it again`, settles: false, notice: { level: 'error', text: `Failed to start task "${task.title}": ${String(err)}` } });
  }

  /**
   * The runner's half of a start: the skills read where the attempt runs, the
   * prompt its kind is told, and the runner spawned on its model and mode. A
   * read-only attempt is given its shell, which may write its task workspace,
   * `writable`, and nothing of the user's (ADR-0046).
   */
  private async spawnRunner(task: Task, attempt: TaskAttempt, cwd: string, writable: string | undefined, previousWork: PreviousWork | undefined): Promise<IRunnerSession> {
    const { store, runs } = this.deps;
    const worktree = attempt.worktree;
    const { kind } = attempt;
    // Read where the attempt runs: a skill an earlier task committed is in
    // this worktree only once that task's work has landed.
    if (takesSkills(kind) && task.skills?.length) {
      attempt.skills = resolveTaskSkills(task, this.deps.skillsAt(this.skillRoots(cwd)), worktree ? (name) => this.uncommittedSkillFolder(name) : undefined);
    }
    const finalPrompt = attemptPrompt(kind, {
      task,
      plan: store.planTasks,
      planMapEnabled: this.deps.config.planMapEnabled,
      previousWork,
      skills: attempt.skills,
      repairPrompt: (t) => this.deps.landing.repairPrompt(t),
      previousAttempt: (taskId) => this.opsPreviousAttempt(taskId),
      previousHandoff: this.deps.previousHandoffFromLog,
      previousRound: this.host.previousRound(task.id),
    });
    const env = await this.envForTask(cwd);
    if (landsNothing(kind)) {
      // Each repo worktree's `.git` must stay the repository's, so a sealed run
      // cannot plant one for the runner's own git to load (ADR-0046).
      const worktrees = writable ? Object.values(runs.openRecord(task.id)?.repos ?? {}).map((r) => r.worktree) : [];
      attempt.shell = this.deps.taskShell?.({ cwd, ...(writable ? { writable } : {}), ...(worktrees.length ? { worktrees } : {}) }) ?? null;
      const fetcher = this.deps.taskWebFetcher?.(task.title);
      attempt.web = fetcher ? new TaskWebReader(fetcher) : null;
    }
    const { shell, web } = attempt;
    return this.deps.runner.spawn({
      taskId: task.id,
      runner: attempt.runner,
      prompt: finalPrompt,
      modelId: task.assignedModel?.modelId,
      thinkingEffort: task.assignedModel?.thinkingEffort,
      modelVariants: task.assignedModel?.availableVariants,
      mode: task.taskMode ?? 'build',
      cwd,
      registry: this.deps.registry ?? undefined,
      order: task.order,
      title: task.title,
      env,
      resumeSessionId: kind.kind === 'continuation' ? kind.resumeSessionId : undefined,
      resumeCost: kind.kind === 'continuation' ? countedSessionCost(task.attemptUsage, kind.resumeSessionId) : undefined,
      resumeWindow: kind.kind === 'continuation' ? resumedSessionWindow(task.attemptUsage, attempt.runner, attempt.attempt, kind.resumeSessionId) : undefined,
      attempt: attempt.attempt,
      ...(attempt.skills.length > 0 ? { skills: attempt.skills } : {}),
      ...(shell ? { shell } : {}),
      ...(writesCommit(kind) ? { commits: true } : {}),
      checkHandoff: (completion) => checkHandoff(completion, task.id, store.planTasks),
      readTask: (args) => readTask(args, task.id, store.planTasks, this.deps.taskLog),
      ...(shell ? { savePatch: (signal: AbortSignal) => this.savePatch(task, attempt, signal) } : {}),
      ...(web ? { webReads: web } : {}),
      applyPatch: (args) => this.applyPatch(task, attempt, args),
      workspaceRoot: this.deps.workspaceRoot(),
      onNotice: (message) => this.host.tell('warn', `Task "${task.title}": ${message}`),
      cancelled: attempt.spawning.signal,
      onAttaching: (spawn) => {
        if (this.live.get(task.id) !== attempt) return;
        attempt.attaching = spawn;
        this.host.emit('onTaskChanged');
      },
    });
  }

  /**
   * A read-only attempt's `save_patch` (ADR-0050): its shell captures what
   * the attempt changed, sealed, and the attempt keeps the patch beside its
   * log for its handoff to name. What Ordewell linked into the worktree stays
   * out, as it stays out of a landing commit.
   */
  private async savePatch(task: Task, attempt: TaskAttempt, signal: AbortSignal): Promise<McpToolReply> {
    const { shell } = attempt;
    const keep = this.deps.keepPatch;
    if (!shell || !keep) return { text: 'save_patch is not available in this session.', isError: true };
    const result = await capturePatch(shell, { linked: this.linkedPaths(task.id, attempt.cwd) }, signal);
    if (result.kind !== 'saved') return patchReply(result, undefined, attempt.patch ?? undefined);
    if (this.live.get(task.id) !== attempt) return patchReply({ kind: 'refused', reason: 'the attempt ended while its changes were being captured.' }, undefined, undefined);
    let where: string;
    try {
      where = keep(task.id, attempt.attempt, result.patch);
    } catch (err) {
      return patchReply({ kind: 'refused', reason: `Ordewell could not keep the patch (${err instanceof Error ? err.message : String(err)}).` }, undefined, attempt.patch ?? undefined);
    }
    attempt.patch = patchArtifact(result.stats, { path: where, attempt: attempt.attempt });
    return patchReply(result, attempt.patch, undefined);
  }

  /**
   * A change attempt's `apply_patch` (ADR-0050): a saved patch of a task it
   * may read, merged into its own worktree. A read-only attempt has no
   * worktree it keeps, so it is refused here as well as by its tool list.
   * What Ordewell linked into the worktree leads into the user's checkout,
   * so the patch may not write there.
   */
  private applyPatch(task: Task, attempt: TaskAttempt, args: ApplyPatchArgs): Promise<McpToolReply> {
    const repos = Object.values(this.deps.runs.openRecord(task.id)?.repos ?? {});
    return applySavedPatch(args, {
      callerId: task.id,
      plan: this.deps.store.planTasks,
      log: this.deps.taskLog,
      worktrees: repos.map((repo) => repo.worktree),
      readOnly: landsNothing(attempt.kind),
      git: this.deps.git ?? DEFAULT_GIT,
      linked: this.linkedPaths(task.id, attempt.cwd),
    });
  }

  /**
   * What Ordewell linked into a lone repository's worktree, relative to its
   * root: its record names them relative to the task's working directory,
   * which sits below the root when the workspace is a folder of the repo.
   */
  private linkedPaths(taskId: string, cwd: string | null): string[] {
    const repos = Object.values(this.deps.runs.openRecord(taskId)?.repos ?? {});
    if (repos.length !== 1 || cwd === null) return [];
    const [{ worktree, linked }] = repos;
    const prefix = path.relative(worktree, cwd).split(path.sep).join('/');
    if (prefix.startsWith('..') || path.isAbsolute(prefix)) return [];
    return linked.map((name) => (prefix ? `${prefix}/${name}` : name).split(path.sep).join('/'));
  }

  /**
   * A script task's start (ADR-0035): its body as the plan holds it now, run
   * by the script runner at the workspace root with the workspace's own
   * variables, as a task's runner gets them (ADR-0016). There is no prompt,
   * so no skills and no account of an earlier attempt: a retry runs the body
   * again as written.
   */
  private async spawnScript(task: Task, attempt: TaskAttempt, cwd: string): Promise<IRunnerSession> {
    const body = scriptBodyOf(task);
    if (!body) throw new Error(`Task "${task.title}" has no script to run: give it "commands" or a "script".`);
    const env = await this.envForTask(cwd);
    return this.deps.scriptRunner.spawn({
      taskId: task.id,
      runner: attempt.runner,
      prompt: '',
      cwd,
      order: task.order,
      title: task.title,
      env,
      attempt: attempt.attempt,
      script: body,
    });
  }

  /**
   * The variables a task's agent gets from its workspace. What cannot be
   * applied is said once — silently starting without them is how agents ran
   * under the wrong account when an edited `.envrc` was left unallowed.
   */
  private async envForTask(cwd: string): Promise<Record<string, string>> {
    const resolved = await this.deps.workspaceEnv(cwd);
    const warn = (key: string, message: string) => {
      if (this.envWarnings.has(key)) return;
      this.envWarnings.add(key);
      this.deps.notifications.warn(message);
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

  /**
   * What an ops retry is told about the attempt before. The saved log is read
   * whether or not the session was reloaded, so both behave alike; the output
   * buffer is the fallback for a runner that has no log. A reload clears the
   * attempt count along with the buffer, so a retry made since is what says
   * there was an attempt to report on.
   */
  private opsPreviousAttempt(taskId: string): string | undefined {
    const saved = this.deps.previousAttemptFromLog(taskId) ?? this.deps.output.liveTail(taskId, { maxLines: OPS_RETRY_TAIL_LINES })?.text;
    if (saved !== undefined) return saved;
    return this.host.retried(taskId) ? 'Its output is not available: this session was reloaded since it ran.' : undefined;
  }

  /** For a skill the main checkout has, the folder a worktree only gets once it is committed. */
  private uncommittedSkillFolder(name: string): string | undefined {
    const root = this.deps.workspaceRoot();
    const skill = this.deps.skillsAt(this.skillRoots(root)).findSkill(name);
    return skill?.source === 'workspace' ? path.relative(root, path.dirname(skill.path)).split(path.sep).join('/') : undefined;
  }

  /**
   * The roots whose `.ordewell/skills/` an attempt at `cwd` reads: in a repo
   * group, `cwd` holds each repo — a worktree of it when isolated, the
   * workspace's own checkout when not — and no folder of its own (ADR-0014).
   */
  private skillRoots(cwd: string): string[] {
    return workspaceSkillRoots(this.deps.workspaceRoot(), this.deps.runs.skillLayout().repos, cwd);
  }

  /**
   * A spawn whose attempt ended while it was in flight: kill what it produced
   * and take back the claim it made. Only the claim — whatever ended the
   * attempt may have decided the task since (mark complete, cancel, retry).
   * A task Mark complete is landing stays in progress until that lands:
   * back to not started, the scheduler would start it again under the landing.
   */
  private abandonSpawn(task: Task, attempt: TaskAttempt, session?: IRunnerSession): void {
    const { store } = this.deps;
    session?.kill();
    attempt.shell?.end();
    attempt.web?.end();
    if (this.live.has(task.id) || this.host.completing(task.id) || store.get(task.id)?.status !== 'in_progress') return;
    if (attempt.kind.kind === 'repair') store.markAwaitingUser(task.id, 'conflict');
    else store.markPending(task.id);
    this.host.emit('onTaskChanged');
  }

  /**
   * A structured turn that ended without a `task_complete` call (ADR-0018, W1). No
   * verdict is guessed: the task waits for input, unless a checkpoint in the
   * same turn already has it waiting, or a queued message went straight out —
   * the session never passes through idle then, so nothing flickers. The first
   * turn of an attempt to end that way, cleanly, gets the completion reminder
   * instead: weaker models often finish the work and report in prose.
   */
  private turnEnded(taskId: string, attempt: TaskAttempt, session: IRunnerSession, reason: StructuredTurnEnd): void {
    const { store } = this.deps;
    if (this.live.get(taskId) !== attempt || attempt.phase !== 'running' || attempt.decided) return;
    if (session.turnState() === 'working') {
      this.host.emit('onTaskChanged');
      return;
    }
    if (store.get(taskId)?.status !== 'in_progress') return;
    if (this.unresumed(attempt)) {
      // There is no session to wait in. Ending the runner hands the attempt to
      // its verdict, which fails it for want of a `task_complete` call.
      session.kill();
      return;
    }
    if (reason === 'failed' && attempt.turnError !== null && classifyRunnerStop(attempt.turnError) === 'usage-limit') {
      // The runner is still up, but no turn can run until the limit resets.
      this.host.unawaited(this.stopOnLimit(taskId, attempt), `Could not pause task "${store.get(taskId)?.title ?? taskId}" on its usage limit`);
      return;
    }
    if (reason === 'completed' && !attempt.reminded) {
      attempt.reminded = true;
      this.message(taskId, COMPLETION_REMINDER, 'message', (live, message) => live.sendMessage(message, 'ordewell'));
      return;
    }
    store.markAwaitingUser(taskId, 'input');
    this.verifier.pauseIdle(taskId);
    this.host.emit('onTaskSettled', { taskId });
    this.host.emit('onTaskChanged');
  }

  /**
   * The limit arrived as the turn's error with the runner still up: the
   * attempt ends here, as its verdict would have ended it, so a resume is a
   * continue in a fresh process (ADR-0018, L1/K1).
   */
  private async stopOnLimit(taskId: string, attempt: TaskAttempt): Promise<void> {
    if (!this.deps.store.get(taskId)) return;
    attempt.decided = true;
    const output = this.deps.output.finalText(taskId);
    this.end(taskId, 'usage-limit');
    await this.host.settle({ kind: 'usage-limited', taskId, attempt, said: attempt.turnError ?? '', output });
  }

  /**
   * The boundary a verdict crosses: nothing awaits the verifier's listener, so
   * a throw from reading the output, landing, releasing a worktree or what the
   * scheduler does after would be an unhandled rejection — and an attempt left
   * integrating is live work forever. One that never settled is ended and
   * reported `unsettled`, as is a settled one whose aftermath threw, so the
   * run says why and goes on.
   */
  private async deliver(taskId: string, verdict: Verdict): Promise<void> {
    const attempt = this.live.get(taskId);
    try {
      await this.decide(taskId, verdict);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        const unsettled = attempt !== undefined && this.live.get(taskId) === attempt;
        if (unsettled) this.end(taskId, 'verdict');
        await this.host.settle({ kind: 'unsettled', taskId, attempt: unsettled ? attempt : null, reason });
      } catch (cleanupErr) {
        // Nothing awaits a verdict, so this is the last place its failure can surface.
        console.error(`[Attempts] verdict for ${taskId} failed (${reason}) and so did handling it:`, cleanupErr);
      }
    }
  }

  /**
   * The attempt's half of its verdict: decided, its runner stopped, its work
   * with Landing while it stays live, its evidence read, and only then ended,
   * with the verdict and handoff recorded on the task, and how it ended
   * reported. Nothing is reported once it is no longer the task's attempt:
   * whatever ended it has settled the task.
   */
  private async decide(taskId: string, verdict: Verdict): Promise<void> {
    const { store, output, runs } = this.deps;
    const task = store.get(taskId);
    const attempt = this.live.get(taskId);
    if (!task || !attempt) return;
    attempt.decided = true;
    // Read before anything is awaited: the turn an exit cut short ends a moment later.
    const stoppedMidTurn = endedByExit(verdict) ? saidInFlight(attempt) : null;
    // Not after the landing: whatever the runner did meanwhile would go unverified (ADR-0018, L1).
    this.stopRunner(attempt);

    console.error(`[Attempts] Task ${taskRefOf(store.planTasks, task.id) ?? `#${task.order}`} "${task.title}" verdict=${verdict.outcome}`);
    if (attempt.script) {
      console.error(`[Attempts] Script body: ${JSON.stringify(scriptBodyOf(task)).slice(0, 200)}`);
    } else {
      console.error(`[Attempts] Runner: ${task.assignedRunner}, Model: ${task.assignedModel?.modelId ?? 'default'}`);
      console.error(`[Attempts] Prompt preview: ${(task.prompt ?? '').slice(0, 200)}`);
    }
    if (attempt.kind.kind === 'repair') return this.decideRepair(task, attempt, verdict);

    // A verdict can arrive inside whatever ended the runner: a stop kills every
    // session before it ends their attempts. Applied a tick later, it finds
    // such an attempt ended and leaves the task as that left it.
    await Promise.resolve();
    if (this.live.get(taskId) !== attempt) return;
    const summary = output.finalText(taskId);
    const authored = output.handoff(taskId);
    // Whatever the verdict: a prototype is worth reading even from a task that failed (ADR-0050).
    const handoff = attempt.patch ? withPatch(authored, attempt.patch) : authored;
    const landing = verdict.outcome === 'pass' ? await this.land(attempt, () => this.deps.landing.landPassed(task, attempt, handoff?.commit)) : null;
    const changedFiles = landing && checksTree(attempt.kind) ? await runs.filesChangedSince(attempt.snapshot) : [];
    const unresumed = this.unresumed(attempt) ? unresumedMessage(task, `${attempt.runner} could not find its saved session`) : null;
    if (this.live.get(taskId) !== attempt) return;
    this.end(taskId, 'verdict');
    // A pause is no verdict, however the limit arrived (ADR-0018, U1).
    if (!landing && stoppedMidTurn !== null && classifyRunnerStop(stoppedMidTurn) === 'usage-limit') {
      return this.host.settle({ kind: 'usage-limited', taskId, attempt, said: stoppedMidTurn, output: summary });
    }
    store.setTaskVerdict(taskId, verdict);
    this.handOver(taskId, summarizeOutput(unresumed ?? verdict.reason, authored ? '' : summary), handoff, attempt.session?.id);
    console.error(`[Attempts] Output summary:\n${summary || '(empty: no output captured)'}`);
    // The evidence the ops rule rests on: a runner cannot be kept from
    // writing, only caught.
    if (changedFiles.length > 0) return this.host.settle({ kind: 'files-changed', task, attempt, verdict, files: changedFiles });
    if (landing) return this.host.settle({ kind: 'passed', task, attempt, verdict, landing });
    return this.host.settle({ kind: 'failed', task, attempt, verdict, unresumed });
  }

  /**
   * A repair's verdict decides only whether its work may land, through
   * Landing's own check; it never replaces the verdict the task's own work
   * earned, so none is recorded here.
   */
  private async decideRepair(task: Task, attempt: TaskAttempt, verdict: Verdict): Promise<void> {
    const summary = this.deps.output.finalText(task.id);
    const handoff = this.deps.output.handoff(task.id);
    const landing = await this.land(attempt, () => this.deps.landing.settleRepair(task, verdict, () => this.live.get(task.id) === attempt));
    if (this.live.get(task.id) !== attempt) return;
    this.end(task.id, 'verdict');
    this.handOver(task.id, summarizeOutput(verdict.reason, handoff ? '' : summary), handoff, attempt.session?.id);
    return this.host.settle({ kind: 'repaired', task, attempt, verdict, landing });
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

  /**
   * A continue whose runner never announced the session it was told to
   * resume. Nothing was continued, and nothing fresh was started in its place.
   */
  private unresumed(attempt: TaskAttempt): boolean {
    const session = attempt.session;
    return attempt.kind.kind === 'continuation' && session !== null && !session.nativeSessionId();
  }

  /**
   * Let the attempt's runner go the way it ends a turn (ADR-0018, L1): it
   * winds down on its own time, bounded by its interrupt grace, and nothing
   * here waits on it but a continue of the same task.
   */
  private stopRunner(attempt: TaskAttempt): void {
    const session = attempt.session;
    if (!session || attempt.runnerStopped) return;
    attempt.runnerStopped = true;
    const { taskId } = attempt;
    // A stop that failed leaves nothing to wait for, and nothing awaits this but a continue.
    const runner = attempt.script ? this.deps.scriptRunner : this.deps.runner;
    const windDown = Promise.all([this.windDowns.get(taskId), runner.stop(session.id)]).catch(() => undefined).then(() => {
      if (this.windDowns.get(taskId) === windDown) this.windDowns.delete(taskId);
    });
    this.windDowns.set(taskId, windDown);
  }

  /**
   * An ended attempt's runner is gone: the count its session ended on is the
   * one a continue of that session counts from. One still current is ended
   * with that count instead.
   */
  private woundDown(attempt: TaskAttempt, session: IRunnerSession): void {
    if (attempt.planScope !== this.planScope || !attempt.runnerStopped || this.live.get(attempt.taskId) === attempt) return;
    this.deps.store.endAttemptUsage(attempt.taskId, attempt.attempt, new Date().toISOString(), session.sessionCost?.() ?? undefined, session.nativeSessionId() ?? undefined);
    this.host.emit('onUsageChanged');
  }

  /** Kept on the task once the attempt ends, so a continue can resume it after a reload (ADR-0018, K1). */
  private saveNativeSession(taskId: string, nativeSessionId: string | null, runner: RunnerId): void {
    if (nativeSessionId) this.deps.store.setTaskRunnerSessionId(taskId, nativeSessionId, runner);
  }

  private endAll(reason: 'stop' | 'load'): TaskAttempt[] {
    const ended = [...this.live.values()];
    for (const { taskId } of ended) this.end(taskId, reason);
    this.verifier.reset();
    if (reason === 'load') this.deps.output.reset();
    return ended;
  }
}

/** How a refused {@link TaskControlError} names what was asked: "no turn to …". */
const CONTROL_WORDS = {
  message: 'send a message to',
  interrupt: 'interrupt',
  force: 'send a message to',
  command: 'run a command in',
} as const;

/** What Ordewell tells a runner whose turn ended without a `task_complete` call (ADR-0018, W1). */
const COMPLETION_REMINDER = 'Your turn ended without calling `task_complete`. If the task is done, call `task_complete` with status `done` and a summary of at most 1,500 characters for the next reader. Put atomic findings in findings and the long form in report (at most 20,000 characters). If you are blocked, call it with status `blocked` and the reason. If you need something from the user, say exactly what and end your turn.';

/** How much of an ops task's last attempt the next one is shown. */
const OPS_RETRY_TAIL_LINES = 60;

function unresumedMessage(task: Task, why: string): string {
  return `Could not continue task "${task.title}": ${why}. Retry starts it afresh.`;
}

/**
 * What the runner said in the turn its exit cut short, or null when no turn
 * was in flight. A limit is acted on only when it ended a turn Ordewell
 * started (ADR-0018, U1): limit words in a turn that had already ended did
 * not stop the runner. The turn's error, where the runner said in a field
 * whether it is the limit, outranks the words (ADR-0044).
 */
function saidInFlight(attempt: TaskAttempt): string | TurnFailure | null {
  const session = attempt.session;
  if (!session || session.turnState() !== 'working') return null;
  if (attempt.turnError?.usageLimit !== undefined) return attempt.turnError;
  return session.getOutput().slice(attempt.turnOutputFrom);
}

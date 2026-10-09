import type { Task, Verdict, VerificationCheck } from '../models/Task';
import type { IRunnerSession } from '../interfaces/IRunner';
import type { CheckpointAnswer, TaskCompleteArgs } from './mcp/tools';

export type VerdictListener = (taskId: string, verdict: Verdict) => void;
export type CheckpointListener = (taskId: string, summary: string) => void;
/** A tool-raised checkpoint whose call went away while its attempt lives on, so nothing is left to answer it. */
export type CheckpointWithdrawnListener = (taskId: string) => void;
/** Fires on every idleSince transition (null→timestamp on silence, timestamp→null on resume/teardown). */
export type IdleListener = (taskId: string, idleSince: string | null) => void;

/** No output for this long marks a running task idle (advisory, UI-only). */
const IDLE_TIMEOUT_MS = 60_000;


export class VerdictEngine {
  private pendingVerdicts = new Map<string, Verdict>();
  private sessions = new Map<string, IRunnerSession>();
  private listeners: VerdictListener[] = [];
  private checkpointListeners: CheckpointListener[] = [];
  private withdrawnListeners: CheckpointWithdrawnListener[] = [];
  /** The open `checkpoint` tool call per task (ADR-0022, V5): settling it is how an answer reaches the runner. */
  private toolCheckpoints = new Map<string, (answer: CheckpointAnswer) => void>();
  /** The question a task's checkpoint asks, whole, for as long as it waits. */
  private checkpointQuestions = new Map<string, string>();
  private idleListeners: IdleListener[] = [];
  /**
   * Per-task generation. Replaced on every watch(), clear() and verdict.
   * Stale callbacks (from a prior session whose generation doesn't match
   * the current one) bail out instead of delivering a verdict for the
   * wrong session.
   */
  private generations = new Map<string, number>();
  /**
   * Generations come from one counter that {@link reset} never rewinds: a
   * per-task count restarted at 1 after a reset, and the next watch handed a
   * session that outlived the reset the same generation as its successor.
   */
  private lastGeneration = 0;
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private idleSince = new Map<string, string | null>();
  /** Tasks waiting on the user, whose silence is expected rather than a sign of a stuck runner. */
  private idlePaused = new Set<string>();
  /**
   * Open tool approvals per structured task. They arrive mid-turn and leave the
   * status alone (ADR-0018, W1), but a task waiting on one is waiting on the
   * user, so it is not idle either.
   */
  private openApprovals = new Map<string, Set<string>>();

  onVerdict(listener: VerdictListener): void {
    this.listeners.push(listener);
  }

  onCheckpoint(listener: CheckpointListener): void {
    this.checkpointListeners.push(listener);
  }

  onCheckpointWithdrawn(listener: CheckpointWithdrawnListener): void {
    this.withdrawnListeners.push(listener);
  }

  onIdleChange(listener: IdleListener): void {
    this.idleListeners.push(listener);
  }

  /** Advisory silence timestamp for a task, or null if it isn't idle. */
  getIdleSince(taskId: string): string | null {
    return this.idleSince.get(taskId) ?? null;
  }

  /**
   * Stop watching a task's silence while it waits on the user (ADR-0018, W1).
   * Watching resumes when its next turn starts, or when a checkpoint is answered.
   */
  pauseIdle(taskId: string): void {
    this.idlePaused.add(taskId);
    this.clearIdle(taskId);
  }

  private resumeIdle(taskId: string): void {
    const gen = this.generations.get(taskId);
    if (!this.idlePaused.delete(taskId) || gen === undefined) return;
    this.touchIdle(taskId, gen);
  }

  /** Restart the silence timer on fresh output; broadcasts the null transition if it was idle. */
  private touchIdle(taskId: string, gen: number): void {
    if (this.idlePaused.has(taskId) || this.openApprovals.get(taskId)?.size) return;
    const existing = this.idleTimers.get(taskId);
    if (existing) clearTimeout(existing);
    if (this.idleSince.get(taskId)) {
      this.idleSince.set(taskId, null);
      for (const l of this.idleListeners) l(taskId, null);
    }
    this.idleTimers.set(taskId, setTimeout(() => {
      if (this.generations.get(taskId) !== gen) return;
      const now = new Date().toISOString();
      this.idleSince.set(taskId, now);
      for (const l of this.idleListeners) l(taskId, now);
    }, IDLE_TIMEOUT_MS));
  }

  /** Tear down idle tracking for a task; broadcasts the null transition if it was idle. */
  private clearIdle(taskId: string): void {
    const timer = this.idleTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(taskId);
    const wasIdle = this.idleSince.get(taskId);
    this.idleSince.delete(taskId);
    if (wasIdle) {
      for (const l of this.idleListeners) l(taskId, null);
    }
  }

  /** What a task's waiting checkpoint asks, untruncated; undefined when none waits. */
  getCheckpointQuestion(taskId: string): string | undefined {
    return this.checkpointQuestions.get(taskId);
  }

  approveCheckpoint(taskId: string): void {
    this.checkpointQuestions.delete(taskId);
    this.resumeIdle(taskId);
    this.toolCheckpoints.get(taskId)?.({ kind: 'continue' });
  }

  rejectCheckpoint(taskId: string, reason: string): void {
    this.checkpointQuestions.delete(taskId);
    this.resumeIdle(taskId);
    this.toolCheckpoints.get(taskId)?.({ kind: 'rejected', reason });
  }

  /**
   * Attach to a spawned session. The runner's `task_complete` call on the
   * attempt's token is the only completion evidence (ADR-0022, V2); a session
   * that exits before one gets a failed verdict.
   *
   * Returns the attempt's generation, what {@link signalComplete} is checked against.
   */
  watch(task: Task, session: IRunnerSession): number {
    const gen = this.bumpGeneration(task.id);
    session.onOutput(() => {
      if (this.generations.get(task.id) === gen) this.touchIdle(task.id, gen);
    });
    this.sessions.set(task.id, session);
    session.onTurnEnd(() => {
      if (this.generations.get(task.id) !== gen) return;
      // The call lives inside the turn that made it. A runner cut short by an
      // interrupt does not always cancel it, and left open it would refuse the next one.
      this.callWentAway(task.id, 'the turn it was asked in has ended.');
      // A queued follow-up supersedes this turn's evidence without ending the attempt.
      const pending = this.pendingVerdicts.get(task.id);
      this.pendingVerdicts.delete(task.id);
      if (session.turnState() === 'idle' && pending) this.publishVerdict(task.id, pending);
    });
    session.onEvent((event) => {
      if (this.generations.get(task.id) !== gen) return;
      if (event.type === 'turn_start') {
        this.supersede(task.id);
        this.resumeIdle(task.id);
      }
      // Read mid-turn, a message voids what the runner reported before it just as a new turn does (ADR-0023).
      else if (event.type === 'message_delivered') this.supersede(task.id);
      else if (event.type === 'permission_request' && !event.decided) this.approvalOpened(task.id, event.id);
      else if (event.type === 'permission_decided' || event.type === 'permission_withdrawn') this.approvalClosed(task.id, event.id, gen);
    });
    session.onTaskComplete((report) => this.signalComplete(task.id, gen, report));
    session.onToolCheckpoint((question, signal) => this.raiseCheckpoint(task.id, gen, question, signal));
    session.onExit((exitCode: number) => {
      if (this.generations.get(task.id) !== gen) return;
      this.forget(task.id);
      const verdict = exitVerdict(exitCode);
      for (const l of this.listeners) l(task.id, verdict);
    });
    return gen;
  }

  /**
   * The runner's own `task_complete` call (ADR-0022, V1/V3): settles the
   * attempt, unless that attempt is no longer the task's current one or an
   * earlier call already settled it.
   */
  signalComplete(taskId: string, generation: number, report: TaskCompleteArgs): void {
    if (this.generations.get(taskId) !== generation) return;
    this.acceptVerdict(taskId, reportedVerdict(report));
  }

  /** The runner was told something after its evidence so far, so only what it reports from here counts. */
  private supersede(taskId: string): void {
    this.pendingVerdicts.delete(taskId);
  }

  private acceptVerdict(taskId: string, verdict: Verdict): void {
    if (this.pendingVerdicts.has(taskId)) return;
    if (this.sessions.get(taskId)?.queued().length) {
      this.pendingVerdicts.set(taskId, verdict);
      return;
    }
    this.publishVerdict(taskId, verdict);
  }

  private publishVerdict(taskId: string, verdict: Verdict): void {
    this.forget(taskId);
    this.bumpGeneration(taskId);
    for (const l of this.listeners) l(taskId, verdict);
  }

  /**
   * The runner's `checkpoint` call (ADR-0022, V5): the task waits on the
   * user until it is settled by {@link approveCheckpoint} or {@link rejectCheckpoint}. It is
   * withdrawn, never left hanging, once the attempt is over or the call goes.
   */
  raiseCheckpoint(taskId: string, generation: number, question: string, signal: AbortSignal): Promise<CheckpointAnswer> {
    if (this.generations.get(taskId) !== generation || signal.aborted) {
      return Promise.resolve({ kind: 'withdrawn', why: 'this attempt has ended.' });
    }
    if (this.toolCheckpoints.has(taskId)) {
      return Promise.resolve({ kind: 'withdrawn', why: 'another checkpoint is still waiting for an answer. Wait for it before asking again.' });
    }
    return new Promise((resolve) => {
      const settle = (answer: CheckpointAnswer) => {
        signal.removeEventListener('abort', onAbort);
        if (this.toolCheckpoints.get(taskId) === settle) {
          this.toolCheckpoints.delete(taskId);
          this.checkpointQuestions.delete(taskId);
        }
        resolve(answer);
      };
      const onAbort = () => {
        settle({ kind: 'withdrawn', why: 'the call was cancelled.' });
        if (this.generations.get(taskId) !== generation) return;
        this.resumeIdle(taskId);
        for (const l of this.withdrawnListeners) l(taskId);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.toolCheckpoints.set(taskId, settle);
      this.checkpointQuestions.set(taskId, question.trim());
      for (const l of this.checkpointListeners) l(taskId, question.trim());
    });
  }

  /** The open `checkpoint` call can no longer be answered: refuse it, and let the task out of the wait. */
  private callWentAway(taskId: string, why: string): void {
    const open = this.toolCheckpoints.get(taskId);
    if (!open) return;
    open({ kind: 'withdrawn', why });
    this.resumeIdle(taskId);
    for (const l of this.withdrawnListeners) l(taskId);
  }

  private withdrawToolCheckpoint(taskId: string): void {
    this.toolCheckpoints.get(taskId)?.({ kind: 'withdrawn', why: 'this attempt has ended.' });
  }

  private approvalOpened(taskId: string, approvalId: string): void {
    const open = this.openApprovals.get(taskId) ?? new Set<string>();
    open.add(approvalId);
    this.openApprovals.set(taskId, open);
    this.clearIdle(taskId);
  }

  private approvalClosed(taskId: string, approvalId: string, gen: number): void {
    const open = this.openApprovals.get(taskId);
    if (!open?.delete(approvalId) || open.size) return;
    this.openApprovals.delete(taskId);
    this.touchIdle(taskId, gen);
  }

  private bumpGeneration(taskId: string): number {
    this.lastGeneration += 1;
    this.generations.set(taskId, this.lastGeneration);
    return this.lastGeneration;
  }

  private forget(taskId: string): void {
    this.pendingVerdicts.delete(taskId);
    this.sessions.delete(taskId);
    this.withdrawToolCheckpoint(taskId);
    this.checkpointQuestions.delete(taskId);
    this.idlePaused.delete(taskId);
    this.openApprovals.delete(taskId);
    this.clearIdle(taskId);
  }

  /** Manual "Mark complete" override: a pass verdict that bypasses evidence. */
  markComplete(task: Task): Verdict {
    this.ceaseTracking(task.id);
    return {
      outcome: 'pass',
      reason: 'Manually marked complete by user.',
      checks: [
        {
          name: 'manual',
          passed: true,
          skipped: false,
          detail: 'Task was manually marked complete by the user; no automatic verification was performed.',
        },
      ],
      decidedAt: new Date().toISOString(),
    };
  }

  /** Clear verification state for a task (used on retry). */
  clear(task: Task): void {
    this.ceaseTracking(task.id);
  }

  /** Drop a task's verification state and invalidate any callbacks still holding its generation. */
  private ceaseTracking(taskId: string): void {
    this.forget(taskId);
    this.bumpGeneration(taskId);
  }

  /** Drop all tracking state (used on stop / loadPlan). */
  reset(): void {
    this.pendingVerdicts.clear();
    this.sessions.clear();
    for (const taskId of [...this.toolCheckpoints.keys()]) this.withdrawToolCheckpoint(taskId);
    this.checkpointQuestions.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.idleSince.clear();
    this.idlePaused.clear();
    this.openApprovals.clear();
    this.generations.clear();
  }
}

/** A runner that exited without reporting through `task_complete` did not finish, whatever its exit code. */
function exitVerdict(exitCode: number): Verdict {
  const normalized = exitCode == null ? 0 : exitCode;
  const exitOk = normalized === 0;
  return {
    outcome: 'fail',
    reason: exitOk
      ? 'Failed verification: the runner exited cleanly but never called task_complete.'
      : `Failed verification: the runner exited with code ${normalized} without calling task_complete.`,
    checks: [
      { name: 'task_complete', passed: false, skipped: false, detail: 'the runner exited before calling task_complete' },
      { name: 'exit_code', passed: exitOk, skipped: false, detail: exitOk ? 'the runner exited cleanly (code 0)' : `the runner exited with code ${normalized}` },
    ],
    decidedAt: new Date().toISOString(),
  };
}

function reportedVerdict(report: TaskCompleteArgs): Verdict {
  const checks: VerificationCheck[] = [
    {
      name: 'task_complete',
      passed: report.status === 'done',
      skipped: false,
      detail: `the runner called task_complete with status "${report.status}"`,
    },
  ];
  const decidedAt = new Date().toISOString();
  if (report.status === 'done') {
    return { outcome: 'pass', reason: 'Verified: the runner reported completion through task_complete. Task completed successfully.', checks, decidedAt };
  }
  const why = report.reason?.trim() || 'no reason given';
  return { outcome: 'fail', reason: `The runner reported the task ${report.status}: ${why}`, checks, decidedAt };
}

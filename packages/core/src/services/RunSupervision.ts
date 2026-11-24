import { flattenTasks, flattenTasksWithParents, type LegacyPlanState, type RunSettings, type SupervisionSnapshot, type Task, type TaskReportTo, type TurnAuthority } from '../models/Task';
import { actorAuthority, type ExecutionActor, type ExecutionCommandName, type ExecutionRecord, type SupervisorLevel } from '../models/Execution';
import type { IsolationHandoff } from '../interfaces/IWorktreeIsolation';
import type { GlobalRunSettings } from './SettingsService';
import type { RunOrigin } from './TaskOrchestrator';
import type { ExecutionCommand, LoopGuard } from './ExecutionCommands';
import type { WakeUpTurn } from './PlannerConversation';
import { namedFirst, Supervisor, WAKE_DEBOUNCE_MS, type DigestReader, type RunEventInput, type SupervisorHost, type SupervisorOptions } from './Supervisor';
import { cut, planWakeFacts, type WakeCacheClock } from './WakePolicy';
import type { StartWait } from './readiness';
import { SupervisionMemory, type GuardTarget, type GuardTrip } from './LoopGuards';
import { SUPERVISOR_LEVEL_LABEL } from './runSettingsText';
import { executionSummary } from './SessionMessage';
import { blockingFailures, repeatingChecks } from './blocking';
import { betweenRounds, loopRoundOf, outOfRounds } from '../models/Loop';
import { reportEnded, researchReport, runUpdateReport } from './taskReport';
import { researchReportTo } from './ResearchTasks';
import { heldBy, heldByCall, runHeldDetail, runHolds, runHoldsKey, standingBlock, standingDetail, standingKey, untoldDetail } from './runHolds';
import { taskRefOf } from './TaskRefs';
import { landedBlockers } from './LandedBlockers';
import { FAN_OUT_ROLE_WORDS, notedRole } from './PlanFanOut';

/** Supervisor levels, lowest first: an automatic lowering only ever goes down. */
const LEVEL_RANK: Record<SupervisorLevel, number> = { off: 0, watch: 1, act: 2 };

/**
 * A run the supervisor or a subplanner opens continues the last; every other
 * actor asks for the user (ADR-0029, ADR-0030, ADR-0056 M6), and only the
 * user's own call is a person's start (ADR-0028).
 */
export function runOrigin(actor: ExecutionActor): RunOrigin {
  return actor.kind === 'user' ? 'person' : actorAuthority(actor.kind);
}

/** The tasks that may stand failed or held: what {@link standingBlock} judges, without walking the whole plan once a task. */
function standingCandidates(plan: readonly Task[], waits: ReadonlyMap<string, readonly StartWait[]>): string[] {
  return flattenTasks([...plan])
    .filter((t) => t.status === 'failed' || t.status === 'awaiting_user' || (waits.get(t.id) ?? []).some((w) => w.kind === 'on-hold'))
    .map((t) => t.id);
}

/** The calls that start a task again: a start is no settle, so what a Stop marked told must be forgotten here, for a hold a failed start leaves is Ordewell's. */
const STARTING_COMMANDS: ReadonlySet<ExecutionCommandName> = new Set<ExecutionCommandName>(['run_task', 'retry_task', 'force_start']);

/** How much of why a task failed a catch-up's line carries, as a run update's detail runs: the supervisor reads the rest. */
const WHY_CHARS = 240;

/** Why a task failed, as a run update says it. A task that failed before its runner started has no verdict; its output summary says why, and what to do. */
function failureWhy(task: Readonly<Task>): string {
  const why = task.verdict ? task.verdict.reason : task.outputSummary?.reviewReason ?? '';
  return `${outOfRoundsNote(task)} ${why}`.trim();
}

/** One word for a loop's whole run, saying how many rounds it took (ADR-0045 L6); empty for any other failure. */
function outOfRoundsNote(task: Readonly<Task>): string {
  return outOfRounds(task) ? `its loop ran out of rounds: it failed all ${loopRoundOf(task)}.` : '';
}

/**
 * What {@link RunSupervision} reaches outside the run: where its settings are
 * saved, the user's settings, the transcript, and what the supervisor's
 * wake-ups need of the planner.
 */
export interface RunSupervisionHost extends Pick<SupervisorHost, 'deliver' | 'pump' | 'restartPlanner' | 'abandonTurn' | 'notice'> {
  /**
   * The plan the run belongs to: its `runSettings` are the run's own, saved
   * with it, and its waiting inputs and planner waits say whether a closing
   * turn can still come. Null with no plan.
   */
  plan(): Pick<LegacyPlanState, 'runSettings' | 'pendingTurns' | 'plannerResend' | 'plannerContextPause' | 'conversationHistory'> | null;
  /** The user's Stop of the planner's turn left the supervisor's inputs waiting for their next message: no turn opens them by itself (ADR-0029). */
  wakeUpsParked(): boolean;
  /** This plan is a child's, with no user above it (ADR-0055 D4). */
  subplanner(): boolean;
  /** The user's run settings as they stand now (ADR-0030). */
  userSettings(): GlobalRunSettings;
  /** The plan's task tree, as the guards and the run updates read it. */
  tasks(): readonly Task[];
  /** Why each task cannot start now, the plan judged once (ADR-0034). */
  startWaits(): ReadonlyMap<string, readonly StartWait[]>;
  /** The planner's prompt cache as its provider counts it (ADR-0057 R4). */
  plannerCache(): WakeCacheClock;
  /** What a task waiting at a checkpoint asked, if it said. */
  checkpointQuestion(taskId: string): string | undefined;
  /**
   * Where the work the run landed stands: merged into the user's branch with
   * the run cleared up, waiting to be merged, or null: the run did not
   * isolate, or landed nothing.
   */
  landedWork(): 'merged' | 'pending' | null;
  /** Where a merge of this run's work goes, as an update names it. */
  mergeTarget?(): string;
  /** What git said when it refused to land a passed task's work, as the run record keeps it. */
  landingError?(taskId: string): string | undefined;
  /** The last few lines a task's runner wrote. */
  recentOutput(taskId: string): string | undefined;
  /** The tail of a task's output a report carries; see {@link taskReport}. */
  reportTail(taskId: string): string | undefined;
  /** A task's result owed to the planner went into a report: it is owed no longer, and its end is kept in the timeline (ADR-0035). */
  reported(taskId: string, to: TaskReportTo): void;
  /** A line in the transcript in Ordewell's voice, saved and announced with the run's settings as they are now. */
  systemNote(text: string): void;
  /** A message to the user in the supervisor's voice, saved and announced. */
  supervisorNote(text: string): void;
  /** The run's settings changed with nothing to say: save and announce the plan. */
  changed(): void;
  /** Save the plan, and what supervision remembers with it. */
  save(): void;
  /** Send the end-of-run handoff again, unmarked, unless the run merged meanwhile or a new one opened. */
  resendHandoff(): void;
  /**
   * The run's end stands for a follower that cannot answer it; see
   * {@link RunSupervision.settle}. `held` says why a closing turn that was
   * owed could not run: the planner waits on its usage limit or its context.
   */
  runConcluded(held?: string): void;
  /**
   * The files a landed task's work changed, for a blocker that cites a file
   * rather than the task (LandedBlockers): a recorded run's slices named the
   * broken file and never the task. Rejects where the run cannot say.
   */
  landedPaths?(taskId: string): Promise<readonly string[]>;
}

/**
 * One plan's run supervision (ADR-0029, ADR-0030): the one owner of the run's
 * settings (`runSettings` on the plan) and of everything that reads or lowers
 * them — whether a run starts afresh or continues the last, the user's change
 * applied at once, a failed supervisor or a tripped guard lowering the run,
 * the loop guards' memory, and the end-of-run handoff an Act supervisor has
 * first. It feeds the {@link Supervisor}, which decides when the planner
 * wakes. The session's observer forwards run events here and reads nothing
 * back but the level.
 */
export class RunSupervision {
  private readonly supervisor: Supervisor;
  /** What the loop guards remember from the user's start of a run to their next. */
  private readonly guards = new SupervisionMemory();
  /** The run's handoff went out marked as an Act supervisor's, and is owed unmarked unless it merges. */
  private handoffDeferred = false;
  /** A run is under way: only then is there a record for the user's change to reach (ADR-0030). */
  private running = false;
  /** The user changed a run setting after the last run ended: the next supervisor call reads their copy, not the finished run's. */
  private changedAfterRun = false;
  /** The run ended, and a follower has not been told the end stands. */
  private endOwed = false;
  /** The holds the run stood idle behind when the supervisor last had a turn on it (ADR-0057 R4); see {@link runIdle}. */
  private holdsSeen: string | undefined;
  /** Each task the supervisor was woken for again after its turn left it failed or held, by how it stood then (ADR-0057 R4); see {@link failuresStanding}. */
  private readonly standingWoken = new Map<string, string>();
  /**
   * A closing turn ended, not by the user's Stop, and what it left standing is
   * not judged yet (ADR-0057 R4): judged once its retry is not in flight or
   * owed either, and answered by the user's Stop of that retry; see
   * {@link judgeClosing}.
   */
  private closingOwed = false;
  /** The files each landed task's work changed, by the landing that changed them: a landing's files never change, so each is read once. */
  private readonly landedPathsRead = new Map<string, Promise<readonly string[] | undefined>>();
  /**
   * The tasks an event the supervisor gathered was about, or a call left on
   * hold, since each last settled: it was told of them, or will be with the
   * inputs that wait, and a hold a call left is its caller's, which `run_held`
   * names. What stands failed or held outside it is
   * {@link catchUp}'s. Not saved: after a reload, what stands is told once more.
   */
  private readonly told = new Set<string>();
  /** The catch-up a run's start owes, once the start has claimed what it starts. */
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(private readonly host: RunSupervisionHost, options: SupervisorOptions = {}) {
    this.debounceMs = options.debounceMs ?? WAKE_DEBOUNCE_MS;
    this.supervisor = new Supervisor({
      run: () => {
        const settings = this.settings();
        return settings ? { level: settings.supervisorLevel ?? 'off', ...(settings.unsupervised ? { unsupervised: settings.unsupervised } : {}) } : null;
      },
      deliver: (digest, report, idle, tasks) => {
        // A turn on the run as it stands idle has seen its holds, whatever woke it.
        if (!idle) this.holdsSeen = this.idleHolds()?.key ?? this.holdsSeen;
        return host.deliver(digest, report, idle, tasks);
      },
      pump: () => host.pump(),
      saveState: () => host.save(),
      stoppedByUser: (tasks) => this.stoppedByUser(tasks),
      digestReader: () => this.digestReader(),
      wakeFacts: () => ({ ...planWakeFacts(this.host.tasks(), this.host.startWaits(), this.running), ...this.host.plannerCache() }),
      readBudget: () => this.settings()?.wakeUpReadBudget ?? host.userSettings().wakeUpReadBudget,
      retryLimit: () => this.retryLimit(),
      subplanner: () => host.subplanner(),
      restartPlanner: () => host.restartPlanner(),
      abandonTurn: () => host.abandonTurn(),
      goUnsupervised: (reason) => this.goUnsupervised(reason),
      wakeUpEnded: (tasks, runEnd, stopped) => {
        // The user's Stop of the closing turn is their answer to it.
        if (runEnd) this.closingOwed = stopped !== true;
        // First: a wake it owes holds the run's end and the handoff.
        this.failuresStanding(tasks ?? [], false);
        this.judgeClosing();
        if (!this.supervisor.awaitsRunEnd) this.handOver();
        this.settle();
        this.runIdle();
      },
      inputsWait: () => (host.plan()?.pendingTurns ?? []).some((t) => t.source === 'supervisor' && !t.rides),
      dropToWatch: (reason) => this.dropToWatch(reason),
      notice: (level, message) => host.notice(level, message),
    }, options);
  }

  /** The level the supervisor acts at now: the run's, lowered during it perhaps, and Off once it failed. */
  get level(): SupervisorLevel {
    return this.supervisor.level;
  }

  /**
   * The merging and level that hold now: the run's while one is under way,
   * which the user's changes reach at once, and otherwise the user's, which
   * the next run copies (ADR-0030).
   */
  standing(): { running: boolean; mergeAtGatesAutomatically: boolean; level: SupervisorLevel } {
    const run = this.running ? this.settings() : undefined;
    if (run) return { running: true, mergeAtGatesAutomatically: run.mergeAtGatesAutomatically, level: this.level };
    const user = this.host.userSettings();
    return { running: false, mergeAtGatesAutomatically: user.mergeAtGatesAutomatically, level: user.supervisorLevel };
  }

  /**
   * A run opened. Only the user's starts its supervision afresh, from their
   * settings as they stand. A run the supervisor opens itself, or a
   * usage-limit reset resumes, carries on the one before: its settings, its
   * level as lowered, and what the loop guards remember.
   */
  runStarted(origin: RunOrigin): void {
    const plan = this.host.plan();
    if (!plan) return;
    const byUser = origin === 'person' || origin === 'user';
    const continued = plan.runSettings !== undefined && !byUser;
    if (!continued) {
      const user = this.host.userSettings();
      plan.runSettings = {
        mergeAtGatesAutomatically: user.mergeAtGatesAutomatically,
        supervisorLevel: user.supervisorLevel,
        supervisorRetryLimit: user.supervisorRetryLimit,
        wakeUpReadBudget: user.wakeUpReadBudget,
      };
      this.guards.forget();
    }
    if (byUser) {
      this.supervisor.userStarted();
      this.holdsSeen = undefined;
      this.standingWoken.clear();
    }
    this.running = true;
    this.changedAfterRun = false;
    this.endOwed = false;
    this.closingOwed = false;
    this.supervisor.runStarted(continued);
    // A start claims what it starts after it opens the run, a retried failure included: judged at the merge window's end, that is not named.
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      if (this.running) this.catchUp();
    }, this.debounceMs);
  }

  /**
   * The user changed run settings in this session (ADR-0030), already saved
   * as theirs: the run under way takes them at once, in either direction.
   * Their level lifts what a failure or a guard lowered — a fresh consent —
   * with the guards' memory kept. No run, nothing to apply: the next copies
   * the user's.
   */
  apply(changes: Partial<GlobalRunSettings>): void {
    const settings = this.settings();
    if (!settings) return;
    const level = changes.supervisorLevel;
    if (!this.running) {
      // The run is over: its saved record keeps what it used. A lower level
      // still releases a handoff deferred to the supervisor; the next run
      // copies the session's new values (ADR-0030).
      this.changedAfterRun = true;
      if (level !== undefined && settings.unsupervised !== undefined) this.liftStop(settings, level);
      if (level !== undefined && level !== 'act') this.handOver();
      this.settle();
      return;
    }
    let raised = false;
    if (level !== undefined && (level !== (settings.supervisorLevel ?? 'off') || settings.unsupervised !== undefined)) {
      settings.supervisorLevel = level;
      delete settings.unsupervised;
      this.host.systemNote(`You set the supervisor to ${SUPERVISOR_LEVEL_LABEL[level]}.`);
      if (level === 'off') this.supervisor.standDown();
      // At Off too: a report the planner asked for still opens a turn (ADR-0037, R2), and what failed before is behind it.
      this.supervisor.setByUser();
      if (level !== 'act') this.handOver();
      raised = this.catchUp();
    }
    if (changes.mergeAtGatesAutomatically !== undefined) settings.mergeAtGatesAutomatically = changes.mergeAtGatesAutomatically;
    if (changes.supervisorRetryLimit !== undefined) settings.supervisorRetryLimit = changes.supervisorRetryLimit;
    if (changes.wakeUpReadBudget !== undefined) settings.wakeUpReadBudget = changes.wakeUpReadBudget;
    this.host.save();
    // What waits on the plan goes now, in one turn with the catch-up's wake, whose delivery opens it.
    if (level !== undefined && level !== 'off' && !raised) this.host.pump();
    this.settle();
  }

  /**
   * The user set a level after the run ended with its supervisor stopped
   * (ADR-0030): the stop the record says is not what they consented to now, so
   * the level they chose replaces it, and a run that continues this one is
   * supervised at it. What was kept for the supervisor goes now, and at Act
   * what it was never told of goes as its closing turn's, which the run's end
   * did not get.
   */
  private liftStop(settings: RunSettings, level: SupervisorLevel): void {
    settings.supervisorLevel = level;
    delete settings.unsupervised;
    this.supervisor.setByUser();
    this.host.save();
    if (level !== 'off' && !this.catchUp(true)) this.host.pump();
  }

  /**
   * The user stopped the run, or found nothing to stop (ADR-0029): the
   * supervisor stands down until they start work again, and a handoff deferred
   * to it is theirs now.
   */
  userStopped(): void {
    if (!this.host.plan()) return;
    this.supervisor.userStopped();
    this.handOver();
    this.settle();
  }

  /**
   * The user is stopping the planner's turns, before any of them ends: the
   * retry a failed closing turn owes is among what they stopped, in flight or
   * at the gate, and their Stop is their answer to what it leaves standing
   * (ADR-0029). A closing turn's own Stop is heard as it ends.
   */
  plannerStopping(): void {
    this.closingOwed = false;
  }

  /**
   * The user stopped one task, and the run goes on (ADR-0029). What was
   * gathered about it, and all that comes, waits for them, and the supervisor
   * may not start it again.
   */
  taskStoppedByUser(taskId: string): void {
    this.guards.stopped(taskId);
  }

  /** The user asked for a start, which ends their Stop whatever the run's state: not every start opens a run of its own (ADR-0029). */
  userStarting(): void {
    this.supervisor.userStarted();
    // The user's start asks for the run afresh, a join of one idle behind holds the supervisor already saw included:
    // a follower waits on a turn about them (ADR-0057 R4).
    this.holdsSeen = undefined;
  }

  /** Whether an input about these tasks waits for the user: they stopped every one (ADR-0029). */
  stoppedByUser(tasks: readonly string[] | undefined): boolean {
    return tasks !== undefined && this.guards.allStopped(tasks);
  }

  /** A run event for the supervisor to batch; see {@link Supervisor.observe}. */
  observe(event: RunEventInput): void {
    this.gather(event);
  }

  /** Every event goes to the supervisor through here, so what it gathered is known to have been told (see {@link told}). */
  private gather(event: RunEventInput): void {
    if (!this.supervisor.observe(event)) return;
    for (const taskId of event.taskIds ?? (event.taskId === undefined ? [] : [event.taskId])) this.told.add(taskId);
  }

  /**
   * Catch up on what the supervisor was never told of (ADR-0030, ADR-0057
   * R4): at Act, every task failed or held with work waiting on it that no
   * event it gathered was about since the task last settled — it failed while
   * the supervisor was Off, or the plan was loaded with it — raises one
   * `failure_standing`, all of them in the one wake, and none for a task the
   * user stopped (ADR-0029). Marked told as it is raised, so it is raised once:
   * a turn that leaves it standing is woken for it once more, as for any
   * failure, and never again. `ended`: the run is over, and the wake is its
   * closing turn's. False when there was nothing to raise.
   */
  private catchUp(ended = false): boolean {
    if (this.level !== 'act') return false;
    const plan = this.host.tasks();
    const waits = this.host.startWaits();
    const reader = this.digestReader();
    const byId = new Map(flattenTasks([...plan]).map((t) => [t.id, t]));
    let raised = false;
    for (const taskId of standingCandidates(plan, waits)) {
      if (this.told.has(taskId) || this.guards.allStopped([taskId])) continue;
      const standing = standingBlock(plan, waits, taskId);
      if (!standing || standing.holdsBack === 0) continue;
      const task = byId.get(taskId);
      const why = task?.status === 'failed' ? cut(failureWhy(task), WHY_CHARS) : '';
      const waiting = namedFirst(reader.blockedBy(taskId), reader.describe);
      this.gather({ kind: 'failure_standing', taskId, detail: untoldDetail(standing, reader.describe, waiting, why, ended), ...(ended ? { closing: true as const } : {}) });
      raised = true;
    }
    return raised;
  }

  /**
   * A task settled on its own: the guards remember a failure's shape, and the
   * supervisor hears of it. The end of a task whose result a planner turn
   * asked for is that turn's report instead, which wakes the planner at every
   * level (ADR-0037, R2). A loop's check that failed a round with rounds left
   * is none of these while its loop goes on: no one is asked, so it counts for
   * no guard, wakes no one, and owes its report only once the loop is over
   * (ADR-0045 L3, L7). A body task that fails stops the loop, so the report
   * its check owes goes then.
   */
  taskSettled(task: Readonly<Task>): void {
    const repeating = repeatingChecks([...this.host.tasks()]);
    this.reportStoppedLoops(repeating, task.id);
    if (repeating.has(task.id)) return;
    // Settling again is a new failure, if it failed: its turn may be woken for it once more (ADR-0057 R4), and nobody was told of it yet.
    this.standingWoken.delete(task.id);
    this.told.delete(task.id);
    this.guards.settled(task);
    const to = this.reportAddress(task);
    if (to && reportEnded(task)) {
      this.gather({ kind: 'task_report', taskId: task.id, report: this.reportOf(task, to) });
      this.host.reported(task.id, to);
      return;
    }
    const event = this.settledEvent(task);
    if (event) this.gather(event);
    void this.raiseLandedBlockers(task.id);
  }

  /**
   * Whatever a task ended as, a blocker it found in another task's landed work
   * is owed a fix while the run can still land one. Its files are matched
   * against what each landing changed only when one of its blockers cites a
   * file, which needs git; a task reference alone is answered at once.
   */
  private async raiseLandedBlockers(reporterId: string): Promise<void> {
    const reporter = flattenTasks([...this.host.tasks()]).find((t) => t.id === reporterId);
    const citesFile = reporter?.handoff?.findings.some((f) => f.severity === 'blocker' && f.evidence?.some((ref) => ref.kind === 'file'));
    const paths = citesFile && this.host.landedPaths ? await this.landedPathsOf() : undefined;
    for (const landedBlocker of landedBlockers(this.host.tasks(), reporterId, paths && ((id) => paths.get(id)))) {
      this.gather({ kind: 'landed_blocker', taskId: landedBlocker.owner, landedBlocker });
    }
  }

  /** The files every landed task changed, as far as the run can say. */
  private async landedPathsOf(): Promise<Map<string, readonly string[]>> {
    const read = this.host.landedPaths;
    const landed = flattenTasks([...this.host.tasks()]).filter((t) => t.status === 'completed');
    const out = new Map<string, readonly string[]>();
    await Promise.all(landed.map(async (t) => {
      const key = `${t.id}@${t.verdict?.decidedAt ?? ''}`;
      let paths = this.landedPathsRead.get(key);
      if (!paths) {
        // A read that failed is tried again at the next report: the run may say once its record is back.
        paths = read ? read(t.id).catch(() => { this.landedPathsRead.delete(key); return undefined; }) : Promise.resolve(undefined);
        this.landedPathsRead.set(key, paths);
      }
      const got = await paths;
      if (got) out.set(t.id, got);
    }));
    return out;
  }

  /**
   * The reports owed by loops' checks between rounds whose loop has stopped
   * (ADR-0045 L7): the check is the failure it is stored as now, and no
   * further round will settle it. `settling` is the task settling now, whose
   * own report its settling sends.
   */
  private reportStoppedLoops(repeating: ReadonlySet<string>, settling?: string): void {
    for (const check of this.host.tasks()) {
      const to = check.reportTo;
      if (!to || check.id === settling || !betweenRounds(check) || repeating.has(check.id)) continue;
      this.gather({ kind: 'task_report', taskId: check.id, report: this.reportOf(check, to) });
      this.host.reported(check.id, to);
    }
  }

  private reportOf(task: Readonly<Task>, to: TaskReportTo): RunEventInput['report'] {
    // A child has no user's turn: its report wakes it as any event does, under its own wake-up rules (ADR-0056 M6).
    const authority = actorAuthority(to.actor);
    const rounds = outOfRoundsNote(task);
    const tail = this.host.reportTail(task.id);
    const named = (id: string) => taskRefOf([...this.host.tasks()], id);
    const whose = named(task.id) ?? task.id;
    const text = to.research ? researchReport(task, tail, named, whose) : runUpdateReport(task, tail, named, whose);
    return { authority, text: rounds ? `${rounds.charAt(0).toUpperCase()}${rounds.slice(1)} ${text}` : text, passed: task.status === 'completed' };
  }

  private reportAddress(task: Readonly<Task>): TaskReportTo | undefined {
    if (task.reportTo) return task.reportTo;
    // A child plan ending is what its parent decides on, so its report wakes it at once, as research does (ADR-0057 R4).
    if (task.type === 'delegated') return researchReportTo({ kind: 'supervisor', level: this.level });
    if (!task.research) return;
    return task.researchOrigin ?? researchReportTo(task.addedBy === 'supervisor'
      ? { kind: 'supervisor', level: this.level } : { kind: 'planner-turn' });
  }

  /**
   * The run finished; a handoff deferred to the supervisor is resent once its
   * wake-up turn on it is over. The update says whether its landed work is
   * merged already: an automatic Merge all at the run's end comes before it,
   * and a live planner is told of that nowhere else (ADR-0029).
   *
   * The end is concluded for a follower that cannot answer it (`ordewell run`)
   * once no turn of the supervisor's can continue the run: at once below Act,
   * and at Act once its closing turn, retry included, is over, with the wake
   * it owes for a failure it left standing (ADR-0057 R4), unless that turn
   * opened the run again (ADR-0029).
   */
  runFinished(): void {
    this.running = false;
    this.endOwed = true;
    // A skip of a body task stops its loop and settles nothing.
    this.reportStoppedLoops(repeatingChecks([...this.host.tasks()]));
    const { total, completed, failed, blocked, skipped } = executionSummary(flattenTasks([...this.host.tasks()]));
    const landed = this.host.landedWork();
    const merge = landed === 'merged' ? `; everything it landed is merged into ${this.host.mergeTarget?.() ?? 'the user\'s branch'}, so there is nothing to merge`
      : landed === 'pending' ? '; its landed work is not merged yet' : '';
    this.gather({ kind: 'run_finished', detail: `${completed} of ${total} tasks completed${failed > 0 ? `, ${failed} failed` : ''}${blocked > 0 ? `, ${blocked} blocked` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}${merge}` });
    if (!this.supervisor.awaitsRunEnd) this.handOver();
    this.settle();
  }

  /**
   * The run waits on a person, or a supervisor's turn ended: if nothing runs,
   * nothing can start, and what holds the rest is a task on hold or one
   * waiting on a person, that is an event, as a task waiting for input is
   * (ADR-0057 R4). It is told once for each distinct set of holds: a turn
   * that leaves the set it saw in place is not woken to it again. Nothing is
   * told while a turn is in flight or a wake is owed: that turn sees the holds.
   * At Act a failure with work waiting that no wake was about joins it, as
   * {@link catchUp} raises it.
   */
  runIdle(): void {
    if (!this.running || this.supervisor.turning || this.supervisor.wakeOwed) return;
    if ((this.host.plan()?.pendingTurns ?? []).some((t) => t.source === 'supervisor')) return;
    // The holds below leave a failure out: one no wake was about is raised here, once (ADR-0057 R4).
    this.catchUp();
    const idle = this.idleHolds();
    if (!idle || idle.key === this.holdsSeen) return;
    this.holdsSeen = idle.key;
    const { describe } = this.digestReader();
    const history = this.host.plan()?.conversationHistory;
    this.gather({
      kind: 'run_held',
      taskIds: idle.holds.map((h) => h.taskId),
      detail: runHeldDetail(idle.holds, describe, (taskId) => heldBy(history, taskId)),
    });
  }

  /**
   * A wake-up turn at Act ended and left a task it was woken for failed or
   * held, with work waiting on it (ADR-0057 R4): the supervisor is woken once
   * more for it now, while other tasks still run, rather than when the run
   * goes idle, which may be never. Once per task for each failure or hold, so
   * a turn that leaves it standing again is not woken a third time; the wake
   * goes through {@link observe}, so the wake-up rate guard counts it. A run
   * idle behind its holds is {@link runIdle}'s, the backstop, and a task the
   * user stopped waits for them (ADR-0029).
   *
   * `runEnd`: the closing turn is over, as {@link judgeClosing} judges it.
   * With the run over, no idle backstop follows and nothing else wakes it, so
   * every task failed or held with work waiting is the closing turn's, and the
   * wake holds the run's end until its own turn is over (ADR-0029).
   */
  private failuresStanding(tasks: readonly string[], runEnd: boolean): void {
    const plan = this.host.tasks();
    const waits = this.host.startWaits();
    for (const [taskId, key] of this.standingWoken) {
      const now = standingBlock(plan, waits, taskId);
      if (!now || standingKey(now) !== key) this.standingWoken.delete(taskId);
    }
    const closing = runEnd && !this.running;
    if (this.level !== 'act' || (!closing && (!this.running || this.idleHolds()))) return;
    // A turn that failed is retried with the same inputs, which see the task as it stands.
    if ((this.host.plan()?.pendingTurns ?? []).some((t) => t.source === 'supervisor')) return;
    const { describe } = this.digestReader();
    for (const taskId of closing ? standingCandidates(plan, waits) : new Set(tasks)) {
      const standing = standingBlock(plan, waits, taskId);
      if (!standing || standing.holdsBack === 0 || this.guards.allStopped([taskId])) continue;
      const key = standingKey(standing);
      if (this.standingWoken.get(taskId) === key) continue;
      this.standingWoken.set(taskId, key);
      this.gather({ kind: 'failure_standing', taskId, detail: standingDetail(standing, describe, closing), ...(closing ? { closing: true as const } : {}) });
    }
  }

  /**
   * The closing turn's judgment of what it left standing, made from state
   * rather than where a turn happens to end: once no turn of the
   * supervisor's is in flight, none owes the run's end and no retry is owed,
   * whether the turn that ended it was the first attempt, its retry, or the
   * user's turn that carried the retry. A run the turn opened again, or a
   * supervisor no longer at Act, owes it nothing.
   */
  private judgeClosing(): void {
    if (!this.closingOwed) return;
    if (this.running || this.level !== 'act') {
      this.closingOwed = false;
      return;
    }
    if (this.supervisor.turning || this.supervisor.awaitsRunEnd || this.supervisor.retryOwed) return;
    this.closingOwed = false;
    this.failuresStanding([], true);
    if (!this.supervisor.awaitsRunEnd) this.handOver();
  }

  /** The holds the run stands idle behind now, and their key; undefined when it is not idle behind any. */
  private idleHolds(): { holds: ReturnType<typeof runHolds>; key: string } | undefined {
    const tasks = this.host.tasks();
    const waits = this.host.startWaits();
    if (!planWakeFacts(tasks, waits, true).nothingCanStart) return undefined;
    const holds = runHolds(tasks, waits);
    return holds.length === 0 ? undefined : { holds, key: runHoldsKey(holds) };
  }

  /** The end-of-run handoff as the surfaces get it: marked as the supervisor's first while it is at Act (ADR-0029). */
  handoff(handoff: IsolationHandoff): IsolationHandoff {
    this.handoffDeferred = this.level === 'act';
    return this.handoffDeferred ? { ...handoff, deferredTo: 'supervisor' } : handoff;
  }

  /** Whether a wake-up will open a planner turn by itself. */
  get wakeOwed(): boolean {
    return this.supervisor.wakeOwed;
  }

  /** Whether wake-ups alone may open a planner turn now. */
  mayWake(): boolean {
    return this.supervisor.mayWake();
  }

  /** Whether a report the planner asked for may open a turn now; see {@link Supervisor.mayReport}. */
  mayReport(): boolean {
    return this.supervisor.mayReport();
  }

  /** The planner gate refused the turn that would take the supervisor's inputs; see {@link Supervisor.refused}. */
  wakeUpsRefused(err: unknown): void {
    this.supervisor.refused(err);
    this.settle();
  }

  /**
   * Run one turn opened without the user, held to the run's level or, on a
   * report owed to the user's turn, to that turn's authority (ADR-0037, R3);
   * see {@link Supervisor.turn}.
   */
  wakeUp<T>(reply: (signal: AbortSignal, turn: WakeUpTurn) => Promise<T>, signal?: AbortSignal, authority: TurnAuthority = 'supervisor'): Promise<T> {
    // A retried closing turn has no caller to hear it end: the turn itself says so.
    return this.supervisor.turn(reply, signal, authority).finally(() => this.settle());
  }

  /**
   * A user's turn that carries the supervisor's inputs: once it lands, the
   * retry those inputs were owed is answered, and the run's end may stand.
   * A failure leaves the inputs waiting for a wake-up turn of their own.
   */
  async carry<T>(turn: Promise<T>): Promise<T> {
    const landed = await turn;
    this.supervisor.carried();
    this.settle();
    return landed;
  }

  /** The command seam's loop guard: a supervisor's call checked against what this run remembers. */
  readonly guard: LoopGuard = (actor, command: ExecutionCommand, target: GuardTarget | undefined) =>
    (actor.kind === 'supervisor' ? this.guards.check(command, target, [...this.host.tasks()], this.retryLimit()) : null);

  /** A call went through the seam: a supervisor's retry is counted, and a hold it left is told. */
  executed(record: ExecutionRecord): void {
    this.guards.done(record, [...this.host.tasks()]);
    // Not caught up as untold: a hold a call left is its caller's, and the idle run_held names who (ADR-0057 R4).
    const held = heldByCall(record);
    if (held) this.told.add(held);
    else if (record.outcome === 'done' && record.task && STARTING_COMMANDS.has(record.command)) this.told.delete(record.task.id);
  }

  /** The oscillation guard on a supervisor's edit taking the plan from `before` to `after`; a trip is told to the user. */
  checkEdit(before: readonly Task[], after: readonly Task[]): GuardTrip | null {
    const trip = this.guards.checkEdit(before, after);
    if (trip) this.guardTripped(trip);
    return trip;
  }

  /** One of the supervisor's edits landed. */
  edited(before: readonly Task[], after: readonly Task[]): void {
    this.guards.edited(before, after);
  }

  /** A loop guard stopped the supervisor: the user hears of it once, as the supervisor's message. */
  guardTripped(trip: GuardTrip): void {
    if (this.guards.firstReport(trip)) this.host.supervisorNote(trip.escalation);
  }

  /** What supervision remembers, for the plan's save (ADR-0029). */
  snapshot(): SupervisionSnapshot {
    return { guards: this.guards.snapshot(), wake: this.supervisor.snapshot() };
  }

  /** Put back what a save remembered, for a plan adopted off disk. */
  restore(snapshot: SupervisionSnapshot | undefined): void {
    this.guards.restore(snapshot?.guards);
    this.supervisor.restore(snapshot?.wake);
  }

  /** The plan is gone: nothing supervision gathered, remembered or owes carries over. */
  reset(): void {
    // Its closing turn goes with the plan, so the end of its run stands as it
    // is: a follower waiting on it hears so, here, before the tasks are gone (ADR-0029).
    if (this.endOwed && !this.running) {
      this.endOwed = false;
      this.host.runConcluded();
    }
    this.supervisor.reset();
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.told.clear();
    this.handoffDeferred = false;
    this.running = false;
    this.changedAfterRun = false;
    this.endOwed = false;
    this.holdsSeen = undefined;
    this.standingWoken.clear();
    this.closingOwed = false;
    this.guards.forget();
  }

  private settings(): RunSettings | undefined {
    return this.host.plan()?.runSettings;
  }

  /** Retries an Act supervisor may make of one task (a loop guard), as the run holds them. */
  private retryLimit(): number {
    const fromRun = this.changedAfterRun ? undefined : this.settings()?.supervisorRetryLimit;
    return fromRun ?? this.host.userSettings().supervisorRetryLimit;
  }

  /**
   * The supervisor failed for the rest of the run: the run carries on as Off.
   * At Off, the turns that failed were report turns, and they stop instead.
   * Said in the transcript, where its notes would have been, and as a notice
   * that names how to turn it back on, since nothing else will.
   */
  private goUnsupervised(reason: string): void {
    const settings = this.settings();
    if (!settings || settings.unsupervised) return;
    const text = this.level === 'off'
      ? `Report turns stopped: ${reason}. The reports the planner asked for reach it with your next message.`
      : `The supervisor stopped: ${reason}. Its setting reads Off for the rest of this run, which carries on unsupervised, and what happens meanwhile is kept for it. `
        + 'To turn it back on for this run, set the supervisor level again in /settings in this session: it is then told what it missed.';
    settings.unsupervised = reason;
    this.host.systemNote(text);
    this.host.notice('warn', text);
    this.handOver();
    this.settle();
  }

  /** The wake-up rate guard tripped: the run carries on at Watch, and the user is told in the supervisor's voice. */
  private dropToWatch(reason: string): void {
    const settings = this.settings();
    if (!settings || LEVEL_RANK[settings.supervisorLevel ?? 'off'] <= LEVEL_RANK.watch) return;
    settings.supervisorLevel = 'watch';
    this.host.changed();
    this.handOver();
    const text = `Loop guard, wake-up rate: I ${reason}, so I am at Watch for the rest of this run: I tell you what needs you and suggest, and act only when you say so.`;
    this.host.supervisorNote(text);
    this.host.notice('warn', text);
    this.settle();
  }

  /**
   * Send a handoff deferred to an Act supervisor again, unmarked, once the
   * supervisor no longer has it: its wake-up turn on the run's end is over, it
   * was lowered, or it failed.
   */
  private handOver(): void {
    if (!this.handoffDeferred) return;
    this.handoffDeferred = false;
    this.host.resendHandoff();
  }

  /**
   * The one place the run's end is judged concluded (ADR-0029): no run is
   * under way, and no supervisor at Act can still continue it — none of its
   * turns is in flight, none owes the end, and no failed one owes a retry.
   * A closing turn the planner cannot take now, waiting on its usage limit,
   * its context, or the user's next message after their Stop of the turn it
   * queued behind, does not hold the end: it may be hours off, and the
   * follower is told why the supervisor did not answer.
   *
   * Every input it reads changes in this module, in the {@link Supervisor} it
   * owns, or on the plan's waiting inputs, whose every change the planner
   * turns report here: each such change calls this, and the end is told once.
   */
  settle(): void {
    this.supervisor.settled();
    // First: a wake the closing turn owes holds the run's end.
    this.judgeClosing();
    if (!this.endOwed || this.running) return;
    let held: string | undefined;
    if (this.level === 'act') {
      if (this.supervisor.turning) return;
      if (this.supervisor.awaitsRunEnd || this.supervisor.retryOwed) {
        held = this.plannerHeld();
        if (held === undefined) return;
      }
    }
    this.endOwed = false;
    this.host.runConcluded(held);
  }

  /** Why no planner turn can open by itself now; undefined when one can. */
  private plannerHeld(): string | undefined {
    const plan = this.host.plan();
    if (plan?.plannerContextPause) return 'the planner is paused on its context, and waits for you to retry its compaction or stop it';
    if (plan?.plannerResend?.at) return 'the planner hit its usage limit, and its turn goes again once the limit resets';
    if (plan?.plannerResend) return 'the planner hit its usage limit, and its turn waits for your next message';
    // A wake still gathering unparks them as it is delivered (a Stop earlier in the run parked them), and its turn takes them along.
    if (this.host.wakeUpsParked() && !this.supervisor.wakeOwed) return 'you stopped the planner\'s turn it waited behind, and it goes with your next message';
    return undefined;
  }

  /** How one run update reads the plan: `#3 "Title"` for a task, and what a task blocks, each walked once. */
  private digestReader(): DigestReader {
    const plan = [...this.host.tasks()];
    let names: Map<string, string> | undefined;
    let blocked: Map<string, string[]> | undefined;
    let byId: Map<string, Task> | undefined;
    return {
      // The role its brief's note told the task, so a wake hands the supervisor no licence the task was not given.
      role: (taskId) => {
        byId ??= new Map(flattenTasks(plan).map((t) => [t.id, t]));
        const task = byId.get(taskId);
        const role = task && notedRole(task);
        return role && FAN_OUT_ROLE_WORDS[role];
      },
      describe: (taskId) => {
        names ??= new Map(flattenTasksWithParents(plan).map(({ task, ref }) => [task.id, `${ref} "${task.title}"`]));
        return names.get(taskId) ?? taskId;
      },
      blockedBy: (id) => {
        if (!blocked) {
          blocked = new Map();
          for (const [taskId, failures] of blockingFailures(plan)) {
            for (const failure of failures) {
              const tasks = blocked.get(failure);
              if (tasks) tasks.push(taskId);
              else blocked.set(failure, [taskId]);
            }
          }
        }
        const found = blocked.get(id);
        if (found) return found;
        // What a task still at work holds back is what the same rule would block were it to fail.
        const failed = (tasks: readonly Task[]): Task[] => tasks.map((t) => t.id === id ? { ...t, status: 'failed' } : t.subtasks ? { ...t, subtasks: failed(t.subtasks) } : t);
        return [...blockingFailures(failed(plan))].flatMap(([taskId, failures]) => failures.includes(id) ? [taskId] : []);
      },
    };
  }

  /** The event a task settling on its own is for the supervisor; null for one it hears of another way. */
  private settledEvent(task: Readonly<Task>): RunEventInput | null {
    const taskId = task.id;
    if (task.status === 'completed') return { kind: 'task_passed', taskId };
    if (task.status === 'failed') {
      const detail = failureWhy(task);
      return { kind: 'task_failed', taskId, ...(detail ? { detail } : {}) };
    }
    if (task.status !== 'awaiting_user') return null;
    switch (task.awaitingReason) {
      case 'checkpoint': {
        const question = this.host.checkpointQuestion(taskId);
        return { kind: 'waiting_input', taskId, detail: `at a checkpoint${question ? `: ${question}` : ''}` };
      }
      case 'conflict': return { kind: 'landing_conflict', taskId };
      case 'landing-failed': {
        const refused = this.host.landingError?.(taskId);
        return { kind: 'landing_failed', taskId, ...(refused ? { detail: refused } : {}) };
      }
      case 'files-changed':
        return { kind: 'waiting_input', taskId, detail: 'the ops task changed tracked files in the user\'s checkout; nothing was committed, and the user marks it complete or retries it' };
      // Heard from the orchestrator's wait, with the runner and its reset.
      case 'usage-limit': return null;
      default: {
        const said = this.host.recentOutput(taskId);
        return { kind: 'waiting_input', taskId, ...(said ? { detail: said } : {}) };
      }
    }
  }
}

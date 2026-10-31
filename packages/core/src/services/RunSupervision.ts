import { flattenTasks, flattenTasksWithParents, type RunSettings, type SupervisionSnapshot, type Task, type TaskReportTo, type TurnAuthority } from '../models/Task';
import { actorAuthority, type ExecutionActor, type ExecutionRecord, type SupervisorLevel } from '../models/Execution';
import type { IsolationHandoff } from '../interfaces/IWorktreeIsolation';
import type { GlobalRunSettings } from './SettingsService';
import type { RunOrigin } from './TaskOrchestrator';
import type { ExecutionCommand, LoopGuard } from './ExecutionCommands';
import type { WakeUpTurn } from './PlannerConversation';
import { Supervisor, type DigestReader, type RunEventInput, type SupervisorHost, type SupervisorOptions } from './Supervisor';
import { planWakeFacts, type WakeCacheClock } from './WakePolicy';
import type { StartWait } from './readiness';
import { SupervisionMemory, type GuardTarget, type GuardTrip } from './LoopGuards';
import { SUPERVISOR_LEVEL_LABEL } from './runSettingsText';
import { executionSummary } from './SessionMessage';
import { blockingFailures, repeatingChecks } from './blocking';
import { betweenRounds, loopRoundOf, outOfRounds } from '../models/Loop';
import { reportEnded, researchReport, runUpdateReport } from './taskReport';
import { researchReportTo } from './ResearchTasks';
import { taskRefOf } from './TaskRefs';

/** Supervisor levels, lowest first: an automatic lowering only ever goes down. */
const LEVEL_RANK: Record<SupervisorLevel, number> = { off: 0, watch: 1, act: 2 };

/** A run the supervisor or a subplanner opens continues the last; every other actor asks for the user (ADR-0029, ADR-0030, ADR-0056 M6). */
export function runOrigin(actor: ExecutionActor): RunOrigin {
  return actorAuthority(actor.kind);
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
  /** The plan the run belongs to: its `runSettings` are the run's own, saved with it. Null with no plan. */
  plan(): { runSettings?: RunSettings } | null;
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
   * the run cleared up, waiting for Merge all, or null: the run did not
   * isolate, or landed nothing.
   */
  landedWork(): 'merged' | 'pending' | null;
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

  constructor(private readonly host: RunSupervisionHost, options: SupervisorOptions = {}) {
    this.supervisor = new Supervisor({
      run: () => {
        const settings = this.settings();
        return settings ? { level: settings.supervisorLevel ?? 'off', ...(settings.unsupervised ? { unsupervised: settings.unsupervised } : {}) } : null;
      },
      deliver: (...delivered) => host.deliver(...delivered),
      pump: () => host.pump(),
      saveState: () => host.save(),
      digestReader: () => this.digestReader(),
      wakeFacts: () => ({ ...planWakeFacts(this.host.tasks(), this.host.startWaits(), this.running), ...this.host.plannerCache() }),
      readBudget: () => this.settings()?.wakeUpReadBudget ?? host.userSettings().wakeUpReadBudget,
      retryLimit: () => this.retryLimit(),
      restartPlanner: () => host.restartPlanner(),
      abandonTurn: () => host.abandonTurn(),
      goUnsupervised: (reason) => this.goUnsupervised(reason),
      wakeUpEnded: () => {
        if (!this.supervisor.awaitsRunEnd) this.handOver();
      },
      dropToWatch: (reason) => this.dropToWatch(reason),
      notice: (level, message) => host.notice(level, message),
    }, options);
  }

  /** The level the supervisor acts at now: the run's, lowered during it perhaps, and Off once it failed. */
  get level(): SupervisorLevel {
    return this.supervisor.level;
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
    const continued = plan.runSettings !== undefined && origin !== 'user';
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
    this.running = true;
    this.changedAfterRun = false;
    this.supervisor.runStarted(continued);
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
      if (level !== undefined && level !== 'act') this.handOver();
      return;
    }
    if (level !== undefined && (level !== (settings.supervisorLevel ?? 'off') || settings.unsupervised !== undefined)) {
      settings.supervisorLevel = level;
      delete settings.unsupervised;
      this.host.systemNote(`You set the supervisor to ${SUPERVISOR_LEVEL_LABEL[level]}.`);
      if (level === 'off') this.supervisor.standDown();
      // At Off too: a report the planner asked for still opens a turn (ADR-0037, R2), and what failed before is behind it.
      this.supervisor.setByUser();
      if (level !== 'act') this.handOver();
    }
    if (changes.mergeAtGatesAutomatically !== undefined) settings.mergeAtGatesAutomatically = changes.mergeAtGatesAutomatically;
    if (changes.supervisorRetryLimit !== undefined) settings.supervisorRetryLimit = changes.supervisorRetryLimit;
    if (changes.wakeUpReadBudget !== undefined) settings.wakeUpReadBudget = changes.wakeUpReadBudget;
    this.host.save();
  }

  /** A run event for the supervisor to batch; see {@link Supervisor.observe}. */
  observe(event: RunEventInput): void {
    this.supervisor.observe(event);
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
    this.guards.settled(task);
    const to = this.reportAddress(task);
    if (to && reportEnded(task)) {
      this.supervisor.observe({ kind: 'task_report', taskId: task.id, report: this.reportOf(task, to) });
      this.host.reported(task.id, to);
      return;
    }
    const event = this.settledEvent(task);
    if (event) this.supervisor.observe(event);
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
      this.supervisor.observe({ kind: 'task_report', taskId: check.id, report: this.reportOf(check, to) });
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
    if (!task.research) return;
    return task.researchOrigin ?? researchReportTo(task.addedBy === 'supervisor'
      ? { kind: 'supervisor', level: this.level } : { kind: 'planner-turn' });
  }

  /**
   * The run finished; a handoff deferred to the supervisor is resent once its
   * wake-up turn on it is over. The update says whether its landed work is
   * merged already: an automatic Merge all at the run's end comes before it,
   * and a live planner is told of that nowhere else (ADR-0029).
   */
  runFinished(): void {
    this.running = false;
    // A skip of a body task stops its loop and settles nothing.
    this.reportStoppedLoops(repeatingChecks([...this.host.tasks()]));
    const { total, completed, failed, blocked, skipped } = executionSummary(flattenTasks([...this.host.tasks()]));
    const landed = this.host.landedWork();
    const merge = landed === 'merged' ? '; everything it landed is merged into the user\'s branch, so there is nothing to merge'
      : landed === 'pending' ? '; its landed work waits for Merge all' : '';
    this.supervisor.observe({ kind: 'run_finished', detail: `${completed} of ${total} tasks completed${failed > 0 ? `, ${failed} failed` : ''}${blocked > 0 ? `, ${blocked} blocked` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}${merge}` });
    if (!this.supervisor.awaitsRunEnd) this.handOver();
  }

  /** The end-of-run handoff as the surfaces get it: marked as the supervisor's first while it is at Act (ADR-0029). */
  handoff(handoff: IsolationHandoff): IsolationHandoff {
    this.handoffDeferred = this.level === 'act';
    return this.handoffDeferred ? { ...handoff, deferredTo: 'supervisor' } : handoff;
  }

  /** Whether wake-ups alone may open a planner turn now. */
  mayWake(): boolean {
    return this.supervisor.mayWake();
  }

  /** Whether a report the planner asked for may open a turn now; see {@link Supervisor.mayReport}. */
  mayReport(): boolean {
    return this.supervisor.mayReport();
  }

  /**
   * Run one turn opened without the user, held to the run's level or, on a
   * report owed to the user's turn, to that turn's authority (ADR-0037, R3);
   * see {@link Supervisor.turn}.
   */
  wakeUp<T>(reply: (signal: AbortSignal, turn: WakeUpTurn) => Promise<T>, signal?: AbortSignal, authority: TurnAuthority = 'supervisor'): Promise<T> {
    return this.supervisor.turn(reply, signal, authority);
  }

  /** The command seam's loop guard: a supervisor's call checked against what this run remembers. */
  readonly guard: LoopGuard = (actor, command: ExecutionCommand, target: GuardTarget | undefined) =>
    (actor.kind === 'supervisor' ? this.guards.check(command, target, [...this.host.tasks()], this.retryLimit()) : null);

  /** A call went through the seam: a supervisor's retry is counted. */
  executed(record: ExecutionRecord): void {
    this.guards.done(record, [...this.host.tasks()]);
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
    this.supervisor.reset();
    this.handoffDeferred = false;
    this.running = false;
    this.changedAfterRun = false;
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
   * Said in the transcript, where its notes would have been, and as a notice.
   */
  private goUnsupervised(reason: string): void {
    const settings = this.settings();
    if (!settings || settings.unsupervised) return;
    const text = this.level === 'off'
      ? `Report turns stopped: ${reason}. The reports the planner asked for reach it with your next message.`
      : `The supervisor stopped: ${reason}. The run carries on unsupervised; what it was not told reaches the planner with your next message.`;
    settings.unsupervised = reason;
    this.host.systemNote(text);
    this.host.notice('warn', text);
    this.handOver();
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

  /** How one run update reads the plan: `#3 "Title"` for a task, and what a failure blocks, each walked once. */
  private digestReader(): DigestReader {
    const plan = [...this.host.tasks()];
    let names: Map<string, string> | undefined;
    let blocked: Map<string, string[]> | undefined;
    return {
      describe: (taskId) => {
        names ??= new Map(flattenTasksWithParents(plan).map(({ task, ref }) => [task.id, `${ref} "${task.title}"`]));
        return names.get(taskId) ?? taskId;
      },
      blockedBy: (failedId) => {
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
        return blocked.get(failedId) ?? [];
      },
    };
  }

  /** The event a task settling on its own is for the supervisor; null for one it hears of another way. */
  private settledEvent(task: Readonly<Task>): RunEventInput | null {
    const taskId = task.id;
    if (task.status === 'completed') return { kind: 'task_passed', taskId };
    if (task.status === 'failed') {
      const detail = `${outOfRoundsNote(task)} ${task.verdict?.reason ?? ''}`.trim();
      return { kind: 'task_failed', taskId, ...(detail ? { detail } : {}) };
    }
    if (task.status !== 'awaiting_user') return null;
    switch (task.awaitingReason) {
      case 'checkpoint': {
        const question = this.host.checkpointQuestion(taskId);
        return { kind: 'waiting_input', taskId, detail: `at a checkpoint${question ? `: ${question}` : ''}` };
      }
      case 'conflict': return { kind: 'landing_conflict', taskId };
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

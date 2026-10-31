import type { SupervisorLevel } from '../models/Execution';
import type { TurnAuthority } from '../models/Task';
import { createWakePolicy, cut, isHeldEvent, LEFT_OUT_ROOM, REPORT_LEAD, RIDE_ALONG_CHARS, SINCE_LAST, WAKE_MAX_CHARS, type RunEvent, type RunEventKind, type WakeBatch, type WakeFacts, type WakePolicy, type WakePolicySnapshot } from './WakePolicy';
import { classifyRunnerStop } from './runnerExit';
import { WAKE_UP_RATE, wakeUpRateTripped, type WakeUpRate } from './LoopGuards';
import { PlannerContextPausedError, PlannerTurnDiscardedError, PlannerTurnFailedError, PlannerTurnStoppedError, PlannerUsageLimitError, type PlanChange, type WakeBrief, type WakeUpTurn } from './PlannerConversation';

/** How long an event due at once waits for others to join its wake-up: what "at once" means (ADR-0057 R4). */
export const WAKE_DEBOUNCE_MS = 5_000;

/** How long a wake-up turn may run before it counts as hung and is stopped. */
export const WAKE_UP_TURN_TIMEOUT_MS = 10 * 60_000;

/** How long a stopped wake-up turn has to end before the conversation is taken back from it. */
export const HUNG_TURN_GRACE_MS = 30_000;

/**
 * Reads a wake-up turn may make when the plan sets none. A supervisor reads
 * to explain a failure — the task, its log, its diff, a neighbour's — and a
 * wake-up has no user message to keep it short (ADR-0029).
 */
export const DEFAULT_WAKE_UP_READ_BUDGET = 12;

/** How long one event's detail runs in a digest: what happened, never the log behind it. */
const DETAIL_CHARS = 240;

/**
 * The most a digest takes to name a task: a long title goes before the line
 * does (ADR-0057 R5). Short enough that a line cut to `RIDE_ALONG_CHARS` still
 * says what happened, whichever event it is.
 */
const TASK_NAME_CHARS = 60;

/** How many tasks a digest names in a list before it counts them (ADR-0057 R5). */
const NAMED_TASKS = 3;

/** A run event as the host reports it; the supervisor stamps it. */
export type RunEventInput = Omit<RunEvent, 'at' | 'taskIds'>;

/** What the run started with, as saved on the plan. */
export interface SupervisedRun {
  level: SupervisorLevel;
  /** Why the supervisor stopped for the rest of the run; absent while it watches. */
  unsupervised?: string;
}

/**
 * What the supervisor gathered but has not delivered, saved on the plan so a
 * daemon restart still delivers a batch that was inside its debounce window
 * (ADR-0029). Undelivered batches already wait as `pendingTurns`; this is only
 * the state the policy and the wake-up rate keep before a batch exists.
 */
export interface SupervisorSnapshot {
  /** The events inside the debounce window and the passes since the last wake-up. */
  policy: WakePolicySnapshot;
  /** When each wake-up since the last pass was delivered, for the wake-up rate guard. */
  wakeUps: number[];
  /** The user's Stop stands: a reload is not them starting the run again (ADR-0029). */
  stopped?: true;
}

export interface SupervisorHost {
  /** The current run's saved settings; null when no run has started. */
  run(): SupervisedRun | null;
  /**
   * Hand the planner a wake-up digest as the supervisor's input; it settles as
   * the turn that takes it does. `report` marks one carrying a report the
   * planner asked for, which opens a turn at every level, with whose authority
   * (ADR-0037, R2, R3). `idle` marks what a load gave back: it asks for no
   * turn, and waits with the saved inputs while the session stays as loaded
   * (ADR-0029). `tasks` are the tasks it is wholly about, absent when any of it
   * is about the run.
   */
  deliver(digest: string, report?: TurnAuthority, idle?: true, tasks?: readonly string[]): Promise<unknown>;
  /** Start whatever planner turn is now due. */
  pump(): void;
  /** Save what the supervisor gathered: a restart must still deliver a debounced batch (ADR-0029). */
  saveState(): void;
  /** Whether every one of these tasks is one the user stopped: an update about them alone opens no turn (ADR-0029). */
  stoppedByUser(tasks: readonly string[] | undefined): boolean;
  /** What a digest reads of the plan, built once as it goes out: reading it per name is what made a large one quadratic. */
  digestReader(): DigestReader;
  /** What the plan and the planner's prompt cache say now, for the decision the policy makes (ADR-0057 R4). */
  wakeFacts(): WakeFacts;
  /** Reads a wake-up turn may make, as the plan sets them. */
  readBudget(): number;
  /** Retries the supervisor may make of one task in a run, as the plan sets them. */
  retryLimit(): number;
  /** End the planner's process but keep its session id, so the retry resumes it (ADR-0009). */
  restartPlanner(): void;
  /** Free the conversation from a turn that did not end when stopped, taking back what it wrote. */
  abandonTurn(): void;
  /** The run carries on as Off: save why, and tell the user. */
  goUnsupervised(reason: string): void;
  /** A turn that took a wake-up ended, however it ended; see {@link Supervisor.awaitsRunEnd}. */
  wakeUpEnded(): void;
  /** An Act supervisor tripped the wake-up rate: the run carries on at Watch. `reason` says what it did. */
  dropToWatch(reason: string): void;
  notice(level: 'info' | 'warn', message: string): void;
}

/** What a digest reads of the plan. */
export interface DigestReader {
  /** How a digest names a task: `#3 "Title"`. */
  describe(taskId: string): string;
  /** The tasks a failed task blocks now, through their dependencies (ADR-0034). */
  blockedBy(taskId: string): string[];
}

export interface SupervisorOptions {
  debounceMs?: number;
  wakeUpRate?: WakeUpRate;
  turnTimeoutMs?: number;
  hungGraceMs?: number;
  now?: () => number;
}

/** A wake-up turn ran past its time and was stopped. */
export class WakeUpTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the wake-up turn did not finish within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'WakeUpTimeoutError';
  }
}

/**
 * The supervisor of a run (ADR-0029, #27): the planner conversation that wrote
 * the plan, woken during the run by the events that need attention. This
 * module decides when it wakes and what it is told, and keeps the run from
 * ever depending on it.
 *
 * Events reach it from the session; {@link WakePolicy} batches them, and each
 * due batch becomes a digest handed to the planner turns as the supervisor's
 * input. A turn on wake-ups alone is a wake-up turn, run through {@link turn}:
 * timed out if it hangs, retried once with the planner restarted if it fails,
 * and after that the run goes unsupervised — it carries on as Off, and what
 * was not delivered waits for the user's next message. A planner usage limit
 * is waited out instead, by the planner's turns, which send the wake-up again
 * at the reset (`PlannerResend`). What the supervisor may do in its turns is the
 * level's, checked at the command seam and the edit path, never here.
 */
export class Supervisor {
  private policy: WakePolicy;
  private tick: ReturnType<typeof setTimeout> | null = null;
  /** Wake-up turns failed in a row this run; the second ends supervision. */
  private failures = 0;
  /** The run's end was reported: the scheduler can announce it more than once. */
  private finished = false;
  private runEndPending = false;
  /** Ends the wake-up turn in flight as discarded; null while none is. */
  private discardTurn: (() => void) | null = null;
  /** When each wake-up since the last pass was delivered, for the wake-up rate guard. */
  private wakeUps: number[] = [];
  /** What it holds came back with a load, and no run event has joined it: going out, it wakes nobody (ADR-0029). */
  private loaded = false;
  /** The user's Stop stands until they start work again: what it gathers waits for them (ADR-0029). */
  private stopped = false;
  private readonly debounceMs: number;
  private readonly wakeUpRate: WakeUpRate;
  private readonly turnTimeoutMs: number;
  private readonly hungGraceMs: number;
  private readonly now: () => number;

  constructor(private readonly host: SupervisorHost, options: SupervisorOptions = {}) {
    this.debounceMs = options.debounceMs ?? WAKE_DEBOUNCE_MS;
    this.wakeUpRate = options.wakeUpRate ?? WAKE_UP_RATE;
    this.turnTimeoutMs = options.turnTimeoutMs ?? WAKE_UP_TURN_TIMEOUT_MS;
    this.hungGraceMs = options.hungGraceMs ?? HUNG_TURN_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.policy = this.newPolicy();
  }

  private newPolicy(): WakePolicy {
    return createWakePolicy({ debounceMs: this.debounceMs, facts: () => this.host.wakeFacts() });
  }

  /**
   * The level the supervisor acts at now: the run's, lowered during it perhaps,
   * and Off once it failed, or from the user's Stop until they start work
   * again, so a turn still open when they pressed it restarts nothing.
   */
  get level(): SupervisorLevel {
    return this.stopped ? 'off' : this.runLevel;
  }

  /** The level that decides what is gathered: a Stop holds events back, and loses none of them. */
  private get runLevel(): SupervisorLevel {
    const run = this.host.run();
    return !run || run.unsupervised !== undefined ? 'off' : run.level;
  }

  /** The run has a supervisor at Watch or Act that has not failed in it. */
  get watching(): boolean {
    return this.level !== 'off';
  }

  /** The run's end was gathered for a wake-up whose turn has not ended yet. */
  get awaitsRunEnd(): boolean {
    return this.runEndPending;
  }

  /** Whether wake-ups alone may open a turn now: the supervisor watches. A usage limit holds every turn, and is the planner turns' to wait out. */
  mayWake(): boolean {
    return this.watching;
  }

  /**
   * Whether a report the planner asked for may open a turn now: at every
   * level (ADR-0037, R2), until the turns opened without the user have failed
   * for the run, when another would only fail too, or the user stopped it
   * (ADR-0029). It then waits for the user's next message, as the supervisor's
   * undelivered wake-ups do.
   */
  mayReport(): boolean {
    return !this.stopped && this.failures < 2 && this.host.run()?.unsupervised === undefined;
  }

  /**
   * What a wake-up turn is held to. One on the supervisor's inputs is held to
   * the run's level: the brief is the level's as the turn opens, and what the
   * turn may change and run is read as it does it, so a level lowered meanwhile
   * applies at once. The brief is advice, since the seam enforces the level.
   * One on a report for a task the user's turn started acts as that turn did
   * (ADR-0037, R3), until the user's Stop: nobody asked it to go on past that.
   */
  wakeUpTurn(authority: TurnAuthority = 'supervisor'): WakeUpTurn {
    const readBudget = this.host.readBudget();
    if (authority === 'user') {
      return {
        readBudget,
        refused: (change) => (this.stopped ? changeRefusal('off', change) : undefined),
        brief: reportBrief(readBudget),
        actor: () => (this.stopped ? { kind: 'supervisor', level: 'off' } : { kind: 'planner-turn' }),
      };
    }
    return {
      readBudget,
      refused: (change) => changeRefusal(this.level, change),
      brief: this.level === 'act' ? actBrief(readBudget, this.host.retryLimit()) : this.level === 'watch' ? watchBrief(readBudget) : offBrief(readBudget),
      // A supervisor starts a task only at Act, so a report of one acts at the run's level now: never above the one it started at, and lowered with the run.
      actor: () => ({ kind: 'supervisor', level: this.level }),
    };
  }

  /**
   * A run event. Ignored unless the supervisor watches — at Off, or once it
   * failed, nothing is gathered — but for a report the planner asked for,
   * gathered at every level (ADR-0037, R2). Past the user's Stop it goes
   * straight to the inputs waiting for them.
   */
  observe(event: RunEventInput): void {
    if (this.runLevel === 'off' && event.kind !== 'task_report') return;
    if (event.kind === 'run_finished') {
      if (this.finished) return;
      this.finished = true;
      this.runEndPending = true;
    }
    if (event.kind === 'task_passed' || event.report?.passed) this.wakeUps = [];
    if (event.kind !== 'task_passed') this.loaded = false;
    this.policy.push({ ...event, at: this.now() });
    if (this.stopped) this.standDown();
    else this.arm();
    this.host.saveState();
  }

  /** What it gathered but has not delivered, for the plan (ADR-0029). */
  snapshot(): SupervisorSnapshot {
    return { policy: this.policy.snapshot(), wakeUps: [...this.wakeUps], ...(this.stopped ? { stopped: true } : {}) };
  }

  /**
   * Take a save's gathered state back. All of it goes out once due, so a held
   * failure or a run's end is not stranded in the policy, but the session being
   * opened wakes nobody (ADR-0029): the supervisor's own events join the saved
   * inputs for the next one, unless a run event has joined them by then. A
   * report the planner asked for is owed at every level, and opens its turn
   * (ADR-0037, R2).
   */
  restore(snapshot: SupervisorSnapshot | undefined): void {
    this.disarm();
    this.policy.restore(snapshot?.policy);
    this.wakeUps = [...(snapshot?.wakeUps ?? [])];
    this.stopped = snapshot?.stopped === true;
    this.loaded = (snapshot?.policy.attention.length ?? 0) > 0;
    if (!this.loaded) return;
    // Not yet: what is due is read from the plan, and this load has not put its tasks in the store.
    this.tick = setTimeout(() => {
      this.tick = null;
      this.arm();
    }, 0);
  }

  /**
   * A run started. One the user started gives its supervisor a clean record;
   * one that `continues` the last — the supervisor's own restart, a reset
   * resuming — keeps it.
   */
  runStarted(continues = false): void {
    this.finished = false;
    this.loaded = false;
    if (continues) return;
    this.failures = 0;
    this.wakeUps = [];
    // A new run gathers its own events: what the previous one left undelivered
    // was already handed to the user's next turn, and must not wake this one.
    // A report is the planner's answer, whichever run it ended in.
    const reports = this.policy.snapshot().attention.filter((e) => e.kind === 'task_report');
    this.disarm();
    this.policy = this.newPolicy();
    for (const report of reports) this.policy.push(report);
    this.arm();
  }

  /**
   * The user set the run's level (ADR-0030). Their fresh consent starts the
   * wake-up rate window and the failure count again; the loop guards' own
   * memory is not the supervisor's, and stays.
   */
  setByUser(): void {
    this.failures = 0;
    this.wakeUps = [];
  }

  /**
   * The user's Stop (ADR-0029): nothing it gathered or gathers opens a turn
   * until they start work again. It all joins the inputs waiting, as a stand
   * down's does, for the user's next message or the first turn after their
   * start; the tasks it was about say the same in the plan and the inbox.
   */
  userStopped(): void {
    this.stopped = true;
    this.standDown();
  }

  /** The user started work again: what their Stop held goes with the next turn, which this does not open. */
  userStarted(): void {
    this.stopped = false;
  }

  /** The plan these events were about is gone: nothing gathered or waited on carries over. */
  reset(): void {
    this.disarm();
    this.discardTurn?.();
    this.failures = 0;
    this.stopped = false;
    this.finished = false;
    this.runEndPending = false;
    this.wakeUps = [];
    this.loaded = false;
    this.policy = this.newPolicy();
  }

  /**
   * Run one wake-up turn. A turn that runs past its time is stopped, and one
   * that does not end when stopped has the conversation taken from it, so the
   * run is never left waiting on a hung planner. A failure is counted before
   * the caller hears of it, so the retry the caller's next pump makes is
   * already the supervisor's decision. `authority` is whose the turn is, as
   * {@link wakeUpTurn} reads it.
   */
  async turn<T>(run: (signal: AbortSignal, turn: WakeUpTurn) => Promise<T>, signal?: AbortSignal, authority: TurnAuthority = 'supervisor'): Promise<T> {
    const controller = new AbortController();
    const relay = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relay, { once: true });
    let timedOut = false;
    let discarded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // A run that throws before its first await fails the turn like any other failure, rather than escaping the count.
    const answered = (async () => run(controller.signal, this.wakeUpTurn(authority)))();
    // Raced below; once the race is lost, the turn's own failure is nobody's to hear.
    answered.catch(() => {});
    const hung = new Promise<never>((_, reject) => {
      // Its grace would abandon whatever turn holds the conversation by then:
      // once the plan scope ends, the turn ends with it, untimed.
      this.discardTurn = () => {
        discarded = true;
        reject(new PlannerTurnDiscardedError());
      };
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        grace = setTimeout(() => {
          this.host.abandonTurn();
          reject(new WakeUpTimeoutError(this.turnTimeoutMs));
        }, this.hungGraceMs);
      }, this.turnTimeoutMs);
    });
    try {
      const landed = await Promise.race([answered, hung]);
      this.failures = 0;
      return landed;
    } catch (err) {
      const failure = timedOut && !discarded ? new WakeUpTimeoutError(this.turnTimeoutMs) : err;
      this.failed(failure, authority);
      throw failure;
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
      this.discardTurn = null;
      signal?.removeEventListener('abort', relay);
    }
  }

  private failed(err: unknown, authority: TurnAuthority): void {
    // The user's stop, or a plan change: the supervisor did not fail.
    if (err instanceof PlannerTurnStoppedError || err instanceof PlannerTurnDiscardedError) return;
    // Not the supervisor's failure: the turn's wake-ups wait with its other
    // inputs, and go again at the reset. With no reset to wait for, the run
    // carries on without its supervisor.
    if (err instanceof PlannerUsageLimitError) {
      if (err.resendAt === null) this.giveUp(`the planner hit its usage limit and ${err.held ?? 'did not say when it resets'}`);
      return;
    }
    // Nor is a planner paused on its context: its wake-ups wait with the
    // pause for the user's Retry compaction, and a restart would drop the
    // input the retry sends.
    if (err instanceof PlannerContextPausedError) return;
    const reason = err instanceof Error ? err.message : String(err);
    // A backend that throws its limit rather than saying it gives no reset to read.
    // A turn that said its failure was classified as it settled, by the runner's
    // own field where it has one, and its words are not read again here.
    if (!(err instanceof WakeUpTimeoutError) && !(err instanceof PlannerTurnFailedError) && classifyRunnerStop(reason) === 'usage-limit') {
      this.giveUp('the planner hit its usage limit and did not say when it resets');
      return;
    }
    this.failures++;
    this.host.restartPlanner();
    // A turn on reports owed to the user's turn is the planner's, not the
    // supervisor's (ADR-0037, R3); at Off only reports open one at all.
    const report = authority === 'user' || this.level === 'off';
    if (this.failures < 2) {
      this.host.notice('warn', `${report ? 'The planner\'s report turn' : 'The supervisor\'s wake-up turn'} failed (${brief(reason)}). Retrying once with the planner restarted.`);
      return;
    }
    this.giveUp(`${report ? 'the planner\'s report turn' : 'its wake-up turn'} failed twice (${brief(reason)})`);
  }

  /** The run goes on without a supervisor, and nothing that happened is lost (see {@link standDown}). */
  private giveUp(reason: string): void {
    this.host.goUnsupervised(reason);
    this.standDown();
  }

  /**
   * The supervisor no longer wakes this run — it failed, or the user turned
   * it off. What the policy still holds joins the batches already waiting,
   * for the user's next message.
   */
  standDown(): void {
    this.disarm();
    this.runEndPending = false;
    const held = this.policy.poll(Number.POSITIVE_INFINITY);
    if (held) this.deliver(held);
  }

  /** Deliver what is gathered once due. */
  private arm(): void {
    const due = this.policy.dueAt();
    if (due === null) return;
    this.disarm();
    this.tick = setTimeout(() => {
      this.tick = null;
      const batch = this.policy.poll(this.now());
      if (!batch) {
        this.arm();
        return;
      }
      // A report owed to the user's turn is not the supervisor waking itself, nor is an update that opens no turn.
      const own = batch.attention.filter((e) => e.report?.authority !== 'user');
      if (own.length > 0 && !this.idle(own) && !this.host.stoppedByUser(tasksOf(own))) this.countWakeUp();
      this.deliver(batch);
    }, Math.max(0, due - this.now()));
  }

  /**
   * The wake-up rate guard (ADR-0029): an Act supervisor woken more often than
   * the rate allows, with no task passing in between, is spinning, and is
   * lowered to Watch before the wake-up that tipped it is delivered.
   */
  private countWakeUp(): void {
    if (this.level !== 'act') return;
    const now = this.now();
    this.wakeUps.push(now);
    if (!wakeUpRateTripped(this.wakeUps, now, this.wakeUpRate)) return;
    const count = this.wakeUps.length;
    const minutes = Math.max(1, Math.round((now - this.wakeUps[0]) / 60_000));
    this.wakeUps = [];
    this.host.dropToWatch(`woke ${count} times in ${minutes} minute${minutes === 1 ? '' : 's'} with no task passing in between`);
  }

  /** The supervisor's own events are what a load gave back, with no report to ask for a turn. */
  private idle(own: readonly RunEvent[]): boolean {
    return this.loaded && !own.some((e) => e.kind === 'task_report');
  }

  private disarm(): void {
    if (this.tick) clearTimeout(this.tick);
    this.tick = null;
  }

  /**
   * A batch goes to the planner as the turns that act on it: the supervisor's
   * own, and one for the reports owed to tasks the user's turn started, which
   * acts as that turn did (ADR-0037, R3) and so never shares a turn with the
   * supervisor's events.
   */
  private deliver(batch: WakeBatch): void {
    const theirs = batch.attention.filter((e) => e.report?.authority === 'user');
    const own = batch.attention.filter((e) => e.report?.authority !== 'user');
    const { describe, blockedBy } = this.host.digestReader();
    const digest = (part: WakeBatch) => wakeUpDigest(part, describe, blockedBy);
    // A failure is the wake-up turn's to handle, in {@link turn}; the batch stays pending meanwhile.
    if (own.length > 0) {
      const runEnd = own.some((e) => e.kind === 'run_finished');
      const asked = own.some((e) => e.kind === 'task_report') ? 'supervisor' : undefined;
      const text = digest({ attention: own, sinceLast: batch.sinceLast });
      const tasks = tasksOf(own);
      if (this.idle(own)) void this.host.deliver(text, undefined, true, tasks).catch(() => {});
      else void this.host.deliver(text, asked, undefined, tasks).catch(() => {}).then(() => {
        if (runEnd) this.runEndPending = false;
        this.host.wakeUpEnded();
      });
    }
    if (theirs.length > 0) {
      void this.host.deliver(digest({ attention: theirs, sinceLast: own.length > 0 ? [] : batch.sinceLast }), 'user', undefined, tasksOf(theirs)).catch(() => {});
    }
  }
}

/** The tasks these events are wholly about; undefined when any of them is about the run. */
function tasksOf(events: readonly RunEvent[]): string[] | undefined {
  const tasks = events.map((e) => e.taskIds ?? (e.taskId === undefined ? [] : [e.taskId]));
  return tasks.some((ids) => ids.length === 0) ? undefined : [...new Set(tasks.flat())];
}

const EDITS_REFUSED =
  'Plan edits are refused in a wake-up turn: you are the supervisor at Watch, and nothing was changed. ' +
  'Do not call submit_plan or edit_plan, or emit plan or taskOps JSON, this turn. Reply in prose instead: ' +
  'say what you would change and why, and ask the user. Their reply is an ordinary message, and you make the change then.';

const EDITS_TURNED_OFF =
  'Plan edits are refused: the supervisor was turned off for this run, and nothing was changed. ' +
  'Reply in prose: say what you would change and why, and leave it to the user.';

const WHOLE_PLAN_REFUSED =
  'A whole new plan is refused in a wake-up turn: as the supervisor you change the plan task by task, with edit_plan, ' +
  'so the user can follow each change. Nothing was changed. Make the edits you need, or ask the user if the plan needs starting over.';

/** Why a wake-up turn at `level` may not make `change`; undefined when it may. */
function changeRefusal(level: SupervisorLevel, change: PlanChange): string | undefined {
  switch (level) {
    case 'act': return change === 'plan' ? WHOLE_PLAN_REFUSED : undefined;
    case 'watch': return EDITS_REFUSED;
    case 'off': return EDITS_TURNED_OFF;
  }
}

/**
 * What a wake-up turn is told after its run update, never saved: who it is,
 * and what its level lets it do. Sent whole once per context, and then a line
 * on a change (ADR-0057 R5, `PlannerBriefing`).
 */
function watchBrief(readBudget: number): WakeBrief {
  return {
    key: 'watch',
    whole: [
      'You are this plan\'s supervisor, woken by the run update above; the user did not write to you.',
      'Tell the user, in a few lines, what needs their attention and what you suggest, so they can answer.',
      readsLine(readBudget),
      'At Watch you only suggest. Running, stopping, retrying, skipping or messaging tasks, answering approvals or checkpoints and editing the plan are refused in this turn: the user\'s reply is how a suggestion is applied.',
    ].join('\n'),
    line: `You are the supervisor at Watch now: you suggest and the user decides, as you were told, with up to ${readBudget} reads a turn.`,
  };
}

function actBrief(readBudget: number, retryLimit: number): WakeBrief {
  return {
    key: 'act',
    whole: [
      'You are this plan\'s supervisor, woken by the run update above; the user did not write to you.',
      'At Act you may act on it yourself: run, stop and retry tasks, message their runners, deny or escalate approvals, approve or reject checkpoints, change tasks with edit_plan, and merge_all. Nobody is asked first. A task you add is approved to run, an ops task included.',
      'When a task that failed, is blocked or waits for input should not hold up the rest, skip_task it with your reason: none of its work lands, and its dependents go ahead once the work it waited on is done, told why. You never mark work complete; only the user vouches for it.',
      'A task waiting at a checkpoint is answered with answer_checkpoint: approve and it goes on, or reject with a reason, which the runner reads and acts on. A checkpoint that asks for the user\'s judgement on an irreversible or outward effect (a deletion, a push, a payment, a message to someone) is theirs: escalate it to the user rather than approving it. Leave it waiting and tell them what it asks and why you did not answer. When you reject, give the reason the runner should act on.',
      readsLine(readBudget),
      'To change a task and run it again, call edit_plan and then retry_task in the same reply: the edit is in the plan as edit_plan answers, so the retry runs it as edited.',
      'A task paused on a usage limit can be resumed early with from "session" once the user says the limit has been reset.',
      `Loop guards hold you: you may retry one task up to ${retryLimit} times this run, and a skip of a task you retried counts as one more; a retry after a failure must change its prompt or model; you may not re-add a task you removed or undo an edit of your own. A refused call says why and what would be accepted. When a guard stops you, escalate to the user rather than trying again.`,
      'Then tell the user, in a few lines, what happened, what you did and why, and what needs them.',
    ].join('\n'),
    line: `You are the supervisor at Act now: you act and then tell the user, as you were told, with up to ${readBudget} reads a turn and ${retryLimit} retries of a task.`,
  };
}

/**
 * A wake-up turn's brief once the supervisor is off for the run: what wakes it
 * then is only a report it asked for as the supervisor (ADR-0037, R2).
 */
function offBrief(readBudget: number): WakeBrief {
  return {
    key: 'off',
    whole: [
      'You are this plan\'s supervisor, woken by the run update above: the result of a task you started, which you asked for. The user did not write to you.',
      'The supervisor is off for this run, so you cannot act in this turn: running, stopping or retrying tasks and editing the plan are refused.',
      readsLine(readBudget),
      'Tell the user, in a few lines, how it went and what you suggest; their reply is how a suggestion is applied.',
    ].join('\n'),
    line: `The supervisor is off for this run now: you cannot act on the run update, as you were told; tell the user how it went, with up to ${readBudget} reads a turn.`,
  };
}

/**
 * A report turn's brief for a task the user's turn started (ADR-0037, R3): it
 * acts as that turn did, at whatever level the supervisor is.
 */
function reportBrief(readBudget: number): WakeBrief {
  return {
    key: 'report',
    whole: [
      'The run update above is the result of a task you started in the user\'s turn, which had not ended when that turn did. The user did not write to you.',
      'You act as in that turn: carry on with what the user asked, if it needs more, as you would have had the result come in it.',
      readsLine(readBudget),
      'Then tell the user, in a few lines, how it went and what, if anything, you did about it.',
    ].join('\n'),
    line: `This run update is the result of a task you started in the user's turn: you act as in that turn, as you were told, with up to ${readBudget} reads a turn.`,
  };
}

function readsLine(readBudget: number): string {
  return `Read more with task_output, task_diff or task_query if you need to: up to ${readBudget} reads this turn. The update names what happened; it does not hold the logs.`;
}

/** One line of a digest, and how much it matters when not all of them fit. */
interface DigestItem {
  kind: RunEventKind;
  line: string;
  rank: 0 | 1 | 2;
}

/** How the overflow line counts each kind of event: read after a number, one or many. */
const OVERFLOW_WORDS: Record<RunEventKind, string> = {
  task_passed: 'passed',
  task_failed: 'failed',
  waiting_input: 'waiting for input',
  waiting_approval: 'waiting for approval',
  task_idle: 'gone quiet',
  landing_conflict: 'in conflict',
  usage_limit: 'at a usage limit',
  auto_merge_stopped: 'with a merge stopped',
  run_finished: 'ended',
  task_report: 'reported',
};

/** Room kept for the overflow line, which is never left out, and for the note on updates a turn cannot carry beside this one. */
const OVERFLOW_ROOM = 400 + LEFT_OUT_ROOM;

/**
 * What a wake-up tells the planner: each event that woke it, with its task
 * and a short detail, and what rode along in a line each (ADR-0057 R5). A
 * digest, never a log — the supervisor reads more itself. Past the cap what
 * woke it goes first, whole items only, and the rest is counted.
 */
export function wakeUpDigest(batch: WakeBatch, describe: (taskId: string) => string, blockedBy: (taskId: string) => string[] = () => []): string {
  const name = (taskId: string) => {
    const whole = describe(taskId);
    return whole.length > TASK_NAME_CHARS ? `${whole.slice(0, TASK_NAME_CHARS - 2)}…"` : whole;
  };
  const passed = [...new Set(batch.sinceLast.flatMap((e) => e.taskId ?? []))];
  const items: DigestItem[] = [
    ...batch.attention.map((e) => attentionItem(e, name, blockedBy)),
    ...passed.map((taskId): DigestItem => ({ kind: 'task_passed', rank: 2, line: `- ${cut(`task ${name(taskId)} passed`, RIDE_ALONG_CHARS - 2)}` })),
  ];
  const shown = new Set<DigestItem>();
  let used = 'Run update:'.length + SINCE_LAST.length + OVERFLOW_ROOM;
  // Whole items by rank, stopping at the first that does not fit: a smaller one past it would read as more important than it.
  for (const item of [...items].sort((a, b) => a.rank - b.rank)) {
    if (used + item.line.length + 1 > WAKE_MAX_CHARS) break;
    used += item.line.length + 1;
    shown.add(item);
  }
  const left = items.filter((item) => !shown.has(item));
  const passes = items.filter((item) => item.kind === 'task_passed' && shown.has(item));
  return [
    'Run update:',
    ...items.filter((item) => item.kind !== 'task_passed' && shown.has(item)).map((item) => item.line),
    ...(passes.length > 0 ? [SINCE_LAST, ...passes.map((item) => item.line)] : []),
    ...(left.length > 0 ? [overflowLine(left)] : []),
  ].join('\n');
}

/** What did not fit, counted by kind, and where to read it (ADR-0057 R5). */
function overflowLine(left: readonly DigestItem[]): string {
  const counts = new Map<RunEventKind, number>();
  for (const { kind } of left) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return `+${left.length} more: ${[...counts].map(([kind, count]) => `${count} ${OVERFLOW_WORDS[kind]}`).join(', ')}; task_query reads them.`;
}

function attentionItem(event: RunEvent, describe: (taskId: string) => string, blockedBy: (taskId: string) => string[]): DigestItem {
  // Read as the update goes out: a retry that passed since has lifted the block.
  const blocked = event.kind === 'task_failed' && event.taskId !== undefined ? blockedBy(event.taskId) : [];
  const line = attentionLine(event, describe, blocked);
  // A failure holding work back is why the wake came, whatever else it was held for.
  if (!isHeldEvent(event) || blocked.length > 0) return { kind: event.kind, rank: 0, line: `- ${line}` };
  return { kind: event.kind, rank: 1, line: `- ${cut(line, RIDE_ALONG_CHARS - 2)}` };
}

function attentionLine(event: RunEvent, describe: (taskId: string) => string, blocked: readonly string[]): string {
  const task = event.taskId === undefined ? 'a task' : `task ${describe(event.taskId)}`;
  const detail = event.detail ? brief(event.detail) : '';
  const colon = detail ? `: ${detail}` : '';
  switch (event.kind) {
    case 'task_failed': {
      const blocks = blocked.length === 0 ? '' : `; it blocks ${blocked.length === 1 ? 'task' : 'tasks'} ${namedFirst(blocked, describe)}`;
      return `${task} failed${colon}${blocks}`;
    }
    case 'waiting_input': return `${task} is waiting for input${colon}`;
    case 'waiting_approval': return `${task} is waiting for approval${colon}`;
    case 'task_idle': return `${task} has gone quiet${detail ? ` (${detail})` : ''}`;
    case 'landing_conflict': return `${task} finished, but its work conflicts and could not land${colon}`;
    case 'auto_merge_stopped': return event.taskId === undefined
      ? `automatic Merge all at the end of the run stopped${colon}; the run is handed over to the user to merge`
      : `automatic Merge all at the merge gate of ${task} stopped${colon}; the gate waits for the user`;
    case 'run_finished': return `the run finished${colon}`;
    // Its result whole, not a digest line: the planner asked for it, and reads it here (ADR-0037, R2).
    case 'task_report': return `${task}${REPORT_LEAD} ${(event.report?.text ?? '').split('\n').join('\n  ')}`;
    case 'task_passed': return `${task} passed`;
    case 'usage_limit': {
      const ids = event.taskIds ?? (event.taskId === undefined ? [] : [event.taskId]);
      const many = ids.length > 1;
      const resume = event.resumeAt
        ? `${many ? 'resume on their' : 'resumes on its'} own at ${event.resumeAt}`
        : `${many ? 'wait' : 'waits'} for a retry, as the reset time could not be read`;
      // What happened and when it ends come first: the list of tasks is the part that grows.
      const paused = `${event.runner ?? 'its runner'}'s usage limit paused ${many ? `${ids.length} tasks` : 'a task'}, which ${resume}`;
      return ids.length === 0 ? paused : `${paused}: ${namedFirst(ids, describe)}`;
    }
  }
}

function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The first few tasks by name and how many more: the list never grows with the plan (ADR-0057 R5). */
function namedFirst(ids: readonly string[], describe: (taskId: string) => string): string {
  if (ids.length <= NAMED_TASKS) return listed(ids.map(describe));
  return `${ids.slice(0, NAMED_TASKS).map(describe).join(', ')} and ${ids.length - NAMED_TASKS} more`;
}

/** One line, cut to fit a digest. */
function brief(text: string): string {
  return cut(text.replace(/\s+/g, ' ').trim(), DETAIL_CHARS);
}

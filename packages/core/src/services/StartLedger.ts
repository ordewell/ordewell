import type { Continuation } from './attemptKind';

/**
 * Why a task is held out of auto-scheduling. `chosen`: someone chose it — a
 * stop, a completion taken back, a revert, a child a Continue could not
 * reopen — so starting the plan again or editing it keeps it, or a task the
 * user or supervisor stopped would run at the next Execute plan.
 * `failed-start`: a start that could not reach its runner, which a new run is
 * the "start it again" for.
 */
export type HoldKind = 'chosen' | 'failed-start';

/** The holds as the start rule reads them (`StartRuleInput.onHold`). */
export interface HeldStarts {
  has(taskId: string): boolean;
  get(taskId: string): string | undefined;
}

/** A start the user's act asked for that waits to be made: a force start behind its dependencies, or one judged by the whole rule. */
export interface QueuedStart {
  /** The merge gate as it stood when the user forced the start: every surface confirms that one first (ADR-0020). */
  readonly pastGate: readonly string[];
  /** What it last said of what holds it back, so it says so once. */
  notice?: string;
  /**
   * Judged by the whole start rule, as the scheduler judges a task, rather
   * than as a force start: asked for by the user's act, and past nothing.
   */
  readonly asScheduled?: true;
}

/**
 * What the orchestrator answers of one owed start as the ledger offers it.
 * `waits`: something holds it back, so it stays owed. `full`: no slot, so it
 * and every one after it of its kind stay owed. `ends`: settled some other
 * way, so it is owed no more. `start`: owed no more, and this makes it.
 */
export type Offer<Start> = 'waits' | 'full' | 'ends' | { start: Start };

/** The orchestrator as the ledger's drain calls back into it, to judge an owed start and claim it. */
export interface StartClaimant<Admission> {
  queued(taskId: string, start: QueuedStart): Offer<() => Promise<void>>;
  repair(taskId: string, admission: Admission): Offer<() => void>;
  resume(taskId: string): Offer<() => void>;
}

type StopReason = 'user' | 'restart';

/** The plan a load brought in, as the ledger judges what of the last one it keeps. */
export interface LoadedPlan {
  has(taskId: string): boolean;
}

/**
 * The owed-start ledger: what the orchestrator withholds from a task's start,
 * and what it owes one, across its attempts. It lives outside the attempt
 * record because ending an attempt must not forget that the user held the
 * task, or asked for its start. Control paths do not edit it by hand: each
 * says what happened to the task — it was retried, forced, skipped, left the
 * plan — and the ledger decides what that ends, so a path cannot forget one
 * of the things it should end.
 *
 * A held task stays `pending`, "not executed", but the scheduler skips it
 * until the user retries or force-starts, which would otherwise loop forever
 * on a task whose spawn always throws. What it owes is made by
 * {@link offer}: a start queued by the user's act, a conflict repair a slot or
 * a start hold put off outside a scheduler, and a resume at a usage limit's
 * reset a slot elsewhere in the tree put off (ADR-0055 D18). Nothing else
 * would make those, so each is what keeps its run open. It also keeps what a
 * claim takes over: a Continue's message for a child it reopens, and the
 * children a Continue could not reopen, which the next run keeps failed.
 *
 * And it keeps the checks carried on with no scheduler, which a tick starts
 * itself rather than the drain: those of a delegated task that passed with
 * nothing scheduled after it (ADR-0055 D8). Held here and not on the plan,
 * because a Stop ends them and a reload does not bring them back; an edit
 * does neither. The loops carried on so are `LoopRounds`' (ADR-0045 L5).
 */
export class StartLedger<Admission> {
  private readonly held = new Map<string, { reason: string; kind: HoldKind }>();
  private readonly waiting = new Map<string, QueuedStart>();
  private readonly repairs = new Set<string>();
  private readonly resumes = new Set<string>();
  private readonly reopens = new Map<string, Continuation>();
  private readonly kept = new Set<string>();
  private readonly checks = new Set<string>();

  constructor(private readonly claimant: StartClaimant<Admission>) {}

  readonly holds: HeldStarts = {
    has: (taskId) => this.held.has(taskId),
    get: (taskId) => this.held.get(taskId)?.reason,
  };

  /** The queued starts as the start rule reads them (`StartRuleInput.queued`). */
  readonly queued: Pick<ReadonlySet<string>, 'has'> = { has: (taskId) => this.waiting.has(taskId) };

  /** Hold the task with the reason the surfaces show; a later hold replaces an earlier one, its kind with it. */
  hold(taskId: string, reason: string, kind: HoldKind): void {
    this.held.set(taskId, { reason, kind });
  }

  holdReason(taskId: string): string | null {
    return this.held.get(taskId)?.reason ?? null;
  }

  /** Queue the task's start; one queued again replaces the earlier, what it said with it. */
  queue(taskId: string, start: QueuedStart): void {
    this.waiting.set(taskId, start);
  }

  /** A repair the task's conflict is owed, which nothing but {@link offer} would start. */
  oweRepair(taskId: string): void {
    this.repairs.add(taskId);
  }

  /** A resume the reset was owed that a slot elsewhere in the tree put off. */
  keepResume(taskId: string): void {
    this.resumes.add(taskId);
  }

  /** A Continue for a child it reopens: the task's next claim continues with it. */
  oweReopen(taskId: string, continuation: Continuation): void {
    this.reopens.set(taskId, continuation);
  }

  /** A child a Continue could not reopen: held, and kept failed by the run the Continue begins. */
  keepChild(taskId: string, reason: string): void {
    this.kept.add(taskId);
    this.hold(taskId, reason, 'chosen');
  }

  /** A check of a delegated task that passed with no scheduler to start it (ADR-0055 D8): carried, never queued, since one that stops being ready simply stops being owed. */
  carryCheck(checkId: string): void {
    this.checks.add(checkId);
  }

  /** The run that carried them is over, by what gives it up or clears it up: what it carried goes with it. */
  runEnded(): void {
    this.checks.clear();
  }

  carriesCheck(checkId: string): boolean {
    return this.checks.has(checkId);
  }

  /** The carried checks that `owed` counts as owed now: the ledger keeps what is carried, the plan says what of it has work. */
  carried(owed: (checkId: string) => boolean): string[] {
    return [...this.checks].filter((id) => owed(id));
  }

  owesRepair(taskId: string): boolean {
    return this.repairs.has(taskId);
  }

  get owesRepairs(): boolean {
    return this.repairs.size > 0;
  }

  get keptChildren(): readonly string[] {
    return [...this.kept];
  }

  /**
   * Whether a start is owed that nobody will ask for again: an owed repair, a
   * kept resume, or a queued start `queuedMoves` counts. What reads this
   * names which queued starts count, since one waiting on the user is owed a
   * Stop but is not work under way.
   */
  pendingUnasked(queuedMoves: (taskId: string) => boolean = () => true): boolean {
    return this.repairs.size > 0 || this.resumes.size > 0 || [...this.waiting.keys()].some(queuedMoves);
  }

  /** A claim of the task: the reopen a Continue owed it is what it continues with, and is taken, and a carried check is started. */
  claimed(taskId: string): Continuation | null {
    const reopen = this.reopens.get(taskId) ?? null;
    this.reopens.delete(taskId);
    this.checks.delete(taskId);
    return reopen;
  }

  /**
   * Offer every owed start its start: the queued ones, each made in turn, then
   * the repairs and the resumes. One a path ended while an earlier start was
   * being made, as a Stop does, is not offered.
   */
  async offer(admission: Admission): Promise<void> {
    for (const [id, start] of [...this.waiting]) {
      if (this.waiting.get(id) !== start) continue;
      const offer = this.claimant.queued(id, start);
      if (offer === 'waits' || offer === 'full') continue;
      // Out of the queue first: the start it makes may queue it again.
      this.waiting.delete(id);
      if (offer !== 'ends') await offer.start();
    }
    this.offerEach(this.repairs, (id) => this.claimant.repair(id, admission));
    this.offerEach(this.resumes, (id) => this.claimant.resume(id));
  }

  private offerEach(owed: Set<string>, judge: (taskId: string) => Offer<() => void>): void {
    for (const id of [...owed]) {
      if (!owed.has(id)) continue;
      const offer = judge(id);
      if (offer === 'full') return;
      if (offer === 'waits') continue;
      owed.delete(id);
      if (offer !== 'ends') offer.start();
    }
  }

  /** Retried, or continued or resumed in its session: the user's ask to run it again, which is all it is owed now. */
  retried(taskId: string): void {
    this.release(taskId);
    this.repairs.delete(taskId);
    this.resumes.delete(taskId);
    this.reopens.delete(taskId);
    this.kept.delete(taskId);
  }

  /** A force start took it, now or queued behind its dependencies: the start is the user's own act. */
  forced(taskId: string): void {
    this.release(taskId);
  }

  /** A force start made now: what was queued for it is the start being made. */
  forcedNow(taskId: string): void {
    this.waiting.delete(taskId);
  }

  /** Moved off the runner whose usage limit paused it: its next start routes around the limit (ADR-0018 U1). */
  moved(taskId: string): void {
    this.release(taskId);
    this.resumes.delete(taskId);
  }

  /** Its loop runs it again, as a body task's next round or the check's (ADR-0045 L5). */
  roundStarted(taskId: string): void {
    this.release(taskId);
    this.waiting.delete(taskId);
  }

  /** Marked complete and landed. */
  completed(taskId: string): void {
    this.settled(taskId);
  }

  /**
   * Ended skipped: by the user, by its loop's close, or as a resolver whose
   * conflict is gone. A reopen it was owed stays: a revive continues it.
   */
  skipped(taskId: string): void {
    this.settled(taskId);
  }

  /** Its owed repair cancelled: the conflict waits on the user instead. */
  cancelled(taskId: string): void {
    this.repairs.delete(taskId);
  }

  /** Gone from the plan: what is kept for an id that no longer exists would be inherited by nothing. */
  left(taskId: string): void {
    this.settled(taskId);
    this.reopens.delete(taskId);
    this.kept.delete(taskId);
  }

  /**
   * The run stopped. A failed start's hold goes, since the next run is its
   * start again, and with it what the stopped run owed a start by itself: a
   * repair, a resume, what it carried on. A chosen hold stays. Only the user's
   * Stop withdraws what they asked to start, queued or reopened, and the
   * children a Continue kept; the stop a run begins with is not theirs
   * (ADR-0034).
   */
  stopped(reason: StopReason): void {
    for (const [id, { kind }] of this.held) if (kind !== 'chosen') this.held.delete(id);
    this.repairs.clear();
    this.resumes.clear();
    this.runEnded();
    if (reason !== 'user') return;
    this.waiting.clear();
    this.reopens.clear();
    this.kept.clear();
  }

  /**
   * A plan was loaded. `keepsChosen`: it is the plan edited, or the same plan
   * begun again, so a chosen hold of a task it still has stays; only a retry,
   * a force start or another plan releases one. Every other hold goes.
   * `edited`: the plan is the one the queued starts were asked of, so those of
   * tasks it still has stay, and so do the checks it carried on that it still has. The repairs and resumes it
   * owed are judged again from the plan; what a Continue owed outlasts the
   * load, which is how its run begins.
   */
  planLoaded(plan: LoadedPlan, opts: { keepsChosen: boolean; edited: boolean }): void {
    for (const [id, { kind }] of this.held) {
      if (!opts.keepsChosen || kind !== 'chosen' || !plan.has(id)) this.held.delete(id);
    }
    for (const id of [...this.waiting.keys()]) if (!opts.edited || !plan.has(id)) this.waiting.delete(id);
    this.repairs.clear();
    this.resumes.clear();
    for (const id of [...this.checks]) if (!opts.edited || !plan.has(id)) this.checks.delete(id);
  }

  private settled(taskId: string): void {
    this.release(taskId);
    this.waiting.delete(taskId);
    this.repairs.delete(taskId);
    this.resumes.delete(taskId);
  }

  private release(taskId: string): void {
    this.held.delete(taskId);
  }
}

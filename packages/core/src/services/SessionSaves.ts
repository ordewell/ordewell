import type { LegacyPlanState } from '../models/Task';
import type { PlanStore } from './PlanStore';
import type { StatusGate } from './SessionEventRelay';
import type { OrchestratorObserver } from './TaskOrchestrator';
import { describeHeld, type SessionHeld } from './sessionLease';

/**
 * How long what no decision depends on waits in memory for a save: usage above
 * all, which every runner reports many times a minute. A crash loses this much
 * of it; a saved file holds the whole plan, so saving per report is what a
 * plan's size multiplies.
 */
const SAVE_INTERVAL_MS = 5000;
/** The closest two saves of a changed status come, as a burst of starts would otherwise write the plan once each. */
const STATUS_SAVE_INTERVAL_MS = 1000;

export interface SessionSavesDeps {
  /** The plan to save; null with none open, or once the Session let its lease go and may write nothing. */
  plan(): LegacyPlanState | null;
  /** Fold what the plan carries beside its tasks into it and write it; throws as the disk refuses. */
  write(plan: LegacyPlanState): void;
  /** Null while this Session may save; otherwise the host that holds its session (ADR-0049). */
  heldElsewhere(): SessionHeld | null;
  store: Pick<PlanStore, 'revision' | 'statusMark'>;
  /** The relay's status updates, held and let go only from here: what holds them saves as it ends. */
  status: StatusGate;
  notice(message: string): void;
}

/** When a change made before an announcement is owed its save. */
export type SaveOwed = 'status' | 'usage';

/**
 * What an orchestrator event owes the disk before it is announced: a changed
 * status or usage, paced as {@link SessionSaves.owed} says; a save `after`
 * the event's effect, made before its announcement; or one save `once` for
 * all the effect asks of it.
 */
export type SavePolicy = SaveOwed | 'after' | 'once';

/**
 * The one table of what each orchestrator event owes the disk (ADR-0029). An
 * event not here owes none, or, as an automatic merge's record does, saves as
 * a plan mutation ({@link SessionSaves.mutation}).
 */
const SAVE_OWED = {
  onTaskChanged: 'status',
  onTick: 'status',
  onUsageChanged: 'usage',
  // The run record names branches and worktrees on disk, so it is saved as it
  // changes rather than at the end: a crash must still find them.
  onIsolationChanged: 'after',
  // A script's effects do not wait for a save, and a reload that finds it
  // unstarted would offer to run them again as if they never ran (ADR-0035).
  onScriptClaimed: 'after',
  // The run's settings, taken as it starts, are on the plan it announces.
  onRunStarted: 'after',
  onExecutionComplete: 'after',
  // Saved the moment it settles: a shared run has no run record to save it
  // mid-run, so a crash would otherwise lose every verdict since the last
  // Session operation.
  onTaskSettled: 'once',
} as const satisfies { readonly [E in keyof OrchestratorObserver]?: SavePolicy };

/** An event {@link SAVE_OWED} gives a save. */
export type SavedEvent = keyof typeof SAVE_OWED;

/** What a saved event changes before its save, where its announcement alone would announce it unsaved. */
export type SavedEffects = Pick<OrchestratorObserver, SavedEvent>;

/**
 * The Session's one save seam (ADR-0029): when a save is owed, how often one
 * may be made, and what a refusing disk does to the act that asked for it.
 * A save the act waits on ({@link first}) refuses the act; one made after the
 * act has happened never throws, and the user hears once a failing stretch
 * that the disk is behind. Each is made before the announcement it is owed
 * for, so no surface sees a decision the disk lacks.
 */
export class SessionSaves {
  /** The host a save was refused for, so the refusal is said once rather than at every save. */
  private refusedFor: string | null = null;
  /** User controls in flight; see {@link control}. */
  private controlsInFlight = 0;
  /** A save is owed, for the end of {@link SAVE_INTERVAL_MS}; see {@link soon}. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The store's status mark as last saved, or as loaded. */
  private savedStatuses: string | undefined;
  private savedRevision: number | undefined;
  private savedAt = 0;
  private due = 0;
  private held = false;
  /** The user was told the disk is refusing this session's saves, and none has landed since. */
  private failureSaid = false;
  /** Status updates held by {@link hold}: whoever holds them saves as it ends. */
  private holds = 0;

  constructor(private readonly deps: SessionSavesDeps) {}

  /**
   * A save the act depends on: a disk that refuses it refuses the act. Any
   * save may come in the middle of a planner turn, and finds nothing of it to
   * write: a turn holds what it writes until the mutation that lands it.
   */
  first(): void {
    if (this.held) return;
    // A save that settles after destroy would claim the lease again, and hold
    // the session from every other host until this process exits (ADR-0049 L7).
    const plan = this.deps.plan();
    if (!plan) return;
    // A host that does not hold the session must not write over the one that
    // does (ADR-0049): the last writer would otherwise win.
    const held = this.deps.heldElsewhere();
    if (held) {
      this.refused(held);
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.deps.write(plan);
    this.marked();
    this.failureSaid = false;
  }

  /**
   * A save nothing that follows may depend on: a full disk must not take the
   * daemon down, nor leave a stop or a close half done, its run live and its
   * lease held, nor silence an observer whose throw the orchestrator would
   * swallow along with what it had left to announce. Said once a failing
   * stretch, since the timer tries again for as long as the disk refuses.
   */
  after(): void {
    try {
      this.first();
    } catch (err) {
      console.error('[Session] save failed:', err);
      if (this.failureSaid) return;
      this.failureSaid = true;
      this.deps.notice(`This session could not be saved: ${err instanceof Error ? err.message : String(err)}. A reload shows it as it was last saved.`);
    }
  }

  /**
   * What a change owes the disk. A task's status is what a decision and a
   * reload read, so a changed one is saved within the second, and at once if
   * no save came in the one before: a save writes the whole plan, and a wide
   * run starts tasks far faster than that is worth. A settled task and a
   * user's control are not paced, and neither is a script, saved as it
   * starts. What changed beside a status goes with it;
   * usage, and anything else, can wait for the timer.
   */
  owed(change: SaveOwed): void {
    if (change === 'usage') return this.soon();
    if (this.controlsInFlight > 0) return this.after();
    // Saved as it ends, or not at all if it aborts.
    if (this.holds > 0) return;
    if (this.deps.store.revision === this.savedRevision) return;
    if (this.deps.store.statusMark() === this.savedStatuses) return this.soon();
    const sinceSaved = Date.now() - this.savedAt;
    if (sinceSaved >= STATUS_SAVE_INTERVAL_MS) this.after();
    else this.soon(STATUS_SAVE_INTERVAL_MS - sinceSaved);
  }

  /** One save for all `act` asks of it, made as it ends, however it ends: the plan is written whole, so each save is what a plan's size multiplies. */
  once(act: () => void): void {
    this.held = true;
    try {
      act();
    } finally {
      this.held = false;
      this.after();
    }
  }

  /**
   * Run a user control and save what it changed before any surface hears of
   * it. Not a status hold, as {@link sync} is: these await spawns and git, so
   * a hold would stall every task's status for as long, and an
   * `execution_complete` the control triggers would overtake the status held
   * back — which a surface treats as the end of the stream. Instead each status
   * announced while one runs is saved first (see {@link owed}).
   */
  async control<T>(op: () => Promise<T>): Promise<T> {
    this.controlsInFlight++;
    try {
      const result = await op();
      this.after();
      // The user's own act shows as it ends: nothing of it waits for the second to run out.
      this.deps.status.flushStatus(this.deps.plan());
      return result;
    } finally {
      this.controlsInFlight--;
    }
  }

  /**
   * A control that finishes synchronously: its status is held until it is
   * saved. Its effect has landed by then, so a failed save is said rather than
   * thrown: the caller would report a control that took as one that failed,
   * and a surface would keep showing what it answered.
   */
  sync<T>(op: () => T): T {
    const result = this.hold(op);
    this.after();
    this.deps.status.releaseStatus(this.deps.plan());
    return result;
  }

  /**
   * A plan mutation, its status held until it is saved: whether `op` changed
   * anything. A save the act depends on (the default) throws before its
   * status goes, so no surface hears of a change the disk refused.
   */
  mutation(op: () => boolean, save: 'first' | 'after' = 'first'): boolean {
    const changed = this.hold(op);
    if (changed) this[save]();
    this.deps.status.releaseStatus(this.deps.plan());
    return changed;
  }

  /** Make the save owed, before the plan it is owed for goes. */
  settle(): void {
    if (this.timer) this.after();
  }

  /**
   * A plan adopted from outside, its status held until it is saved: `put`
   * loads it into the store, which then holds what the disk does, and `adopt`
   * adds what taking it over owes. Whether a load saves is its caller's to say
   * (`persist`), so a task `put` puts back is not saved by its status.
   */
  load(put: () => void, adopt: () => void, persist: boolean): void {
    this.hold(put);
    this.loaded();
    adopt();
    // The file has the plan as it came, and this carries what adopting it added.
    if (persist) this.after();
    this.deps.status.releaseStatus(this.deps.plan());
  }

  /**
   * `announce` with each event {@link SAVE_OWED} names given its save: the
   * event's effect (from `effects`) first, then its save, then `announce`'s
   * own handler, so no surface hears of what the disk lacks.
   */
  observe(announce: OrchestratorObserver, effects: SavedEffects = {}): OrchestratorObserver {
    const saved = <A extends unknown[]>(event: SavedEvent, effect: ((...data: A) => void) | undefined, told: ((...data: A) => void) | undefined) => (...data: A): void => {
      const owed: SavePolicy = SAVE_OWED[event];
      if (owed === 'once') {
        this.once(() => effect?.(...data));
      } else {
        effect?.(...data);
        if (owed === 'after') this.after();
        else this.owed(owed);
      }
      told?.(...data);
    };
    const wired: Required<SavedEffects> = {
      onTaskChanged: saved('onTaskChanged', effects.onTaskChanged, announce.onTaskChanged),
      onTick: saved('onTick', effects.onTick, announce.onTick),
      onUsageChanged: saved('onUsageChanged', effects.onUsageChanged, announce.onUsageChanged),
      onIsolationChanged: saved('onIsolationChanged', effects.onIsolationChanged, announce.onIsolationChanged),
      onScriptClaimed: saved('onScriptClaimed', effects.onScriptClaimed, announce.onScriptClaimed),
      onRunStarted: saved('onRunStarted', effects.onRunStarted, announce.onRunStarted),
      onExecutionComplete: saved('onExecutionComplete', effects.onExecutionComplete, announce.onExecutionComplete),
      onTaskSettled: saved('onTaskSettled', effects.onTaskSettled, announce.onTaskSettled),
    };
    return { ...announce, ...wired };
  }

  /** The next failed save is said, whatever the ones before it already said: a Stop is answered on its own. */
  sayNextFailure(): void {
    this.failureSaid = false;
  }

  /** Another host holds the session, and has been said to: no save from here says so again. */
  heldBy(held: SessionHeld): void {
    this.refusedFor = held.holder.hostId;
  }

  private refused(held: SessionHeld): void {
    if (this.refusedFor === held.holder.hostId) return;
    this.refusedFor = held.holder.hostId;
    this.deps.notice(`${describeHeld(held)} Nothing of this session is saved from here meanwhile.`);
  }

  /** The store holds what the disk does, as a plan is loaded or saved: nothing of it is owed yet. */
  private loaded(): void {
    this.savedRevision = this.deps.store.revision;
    this.savedStatuses = this.deps.store.statusMark();
  }

  /** `op` with status updates held back: a store op signals as it goes, which would announce what the save owed after it has not yet written. */
  private hold<T>(op: () => T): T {
    this.holds++;
    try {
      return this.deps.status.holdStatus(op);
    } finally {
      this.holds--;
    }
  }

  private marked(): void {
    this.savedAt = Date.now();
    this.loaded();
  }

  /** Owe a save, made once, by the soonest it was asked for, however often this is called before it comes. */
  private soon(within = SAVE_INTERVAL_MS): void {
    if (!this.deps.plan()) return;
    const due = Date.now() + within;
    if (this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.after();
    }, within);
    // A process with nothing else to do does not wait for this: settling and destroy save.
    this.timer.unref?.();
  }
}

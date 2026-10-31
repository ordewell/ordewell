import type { LegacyPlanState, PendingPlanTurn, PlannerContextPause, PlanTurnSource, RunnerId, SkillLoad, TurnAuthority } from '../models/Task';
import { ConversationBusyError, ConversationEditError, PlannerContextPausedError, PlannerTurnDiscardedError, PlannerTurnStoppedError, PlannerUsageLimitError } from './PlannerConversation';
import { PlannerResend, type PlannerLimit } from './PlannerResend';
import type { TurnFailure } from './runnerExit';
import type { SkillInvocation } from './skillInvocation';

/**
 * How long a turn may hold new starts. Past it the run goes on without the
 * turn's answer, which still lands: an edit is checked against the tasks as
 * they are when it applies, so a task that started meanwhile refuses it.
 */
export const START_HOLD_TIMEOUT_MS = 5 * 60_000;

export interface PlanTurnInput {
  source: PlanTurnSource;
  text: string;
  skills?: readonly SkillLoad[];
  /** A supervisor input carrying a report the planner asked for; see {@link PendingPlanTurn.report}. */
  report?: TurnAuthority;
  /** A wake-up of what a load gave back: nothing new happened, so while the session stays as loaded it waits with the saved inputs (ADR-0029). */
  idle?: true;
  /** Stops the turn that takes this input. Not saved: a replayed input has no caller left to stop it. */
  signal?: AbortSignal;
}

/**
 * One turn's input: the user's messages joined, with the skills they loaded,
 * and the wake-up digests delivered with them. `source` is `supervisor` only
 * when nothing in the turn came from the user — a wake-up turn (ADR-0029).
 */
export interface TurnPrompt extends SkillInvocation {
  source: PlanTurnSource;
  wakeUps: string[];
  /**
   * A wake-up turn's: who it acts for (ADR-0037, R3) — the supervisor, or the
   * user's turn whose report it delivers. Absent on the user's own turn.
   */
  authority?: TurnAuthority;
  /** The message was force sent: the turn replaces the one it stopped. */
  forced?: true;
  /** The turn is the user's Retry compaction of a planner paused on its context, on the inputs the pause kept. */
  recovery?: PlannerContextPause;
}

export interface PlanTurnsHost {
  /** The inputs a turn is about to take; the Session saves what is left of them. */
  turnStarting?(inputs: readonly PendingPlanTurn[]): void;
  plan(): LegacyPlanState | null;
  /** A planner turn this module did not open holds the conversation: an opening, a compaction, plan generation. */
  conversationBusy(): boolean;
  /** Whether wake-ups alone may open a turn now; when not, they wait for one that may, or for the user's next message. */
  mayWake(): boolean;
  /** Whether a report the planner asked for may open a turn now, whatever the supervisor's level (ADR-0037, R2). */
  mayReport(): boolean;
  /** Save the pending list. */
  persist(): void;
  /** The wait on the planner's usage limit changed with no turn to say so: save the plan, and announce it. */
  announce(): void;
  /**
   * Stop the planner turn holding the conversation for a force send: it ends
   * as stopped by one, not by the user. The run's tasks are not touched.
   */
  interrupt(): void;
  /** Hold the scheduler's new starts; the returned release is idempotent. */
  holdStarts(): () => void;
  /** Tick after a release, so what became ready during the turn starts: the armed scheduler's work, and queued force starts. */
  resumeStarts(): Promise<void>;
  /**
   * One planner turn on `prompt`. `taken` must run inside the mutation that
   * lands the turn's outcome, so the saved plan loses the inputs together
   * with the change they made.
   */
  run(prompt: TurnPrompt, opts: { taken: () => void; signal?: AbortSignal }): Promise<LegacyPlanState>;
  /** Tell the user what no caller is waiting to hear: a replayed input's failed turn, a resume that failed. */
  notice(message: string): void;
  /**
   * Settles once the planner a turn would use is known (ADR-0009); null when
   * it already is. Opened before, a turn plans with the fallback the
   * installed-planner probe may replace.
   */
  plannerDetecting(): Promise<void> | null;
  /** Throws {@link PlannerNotReadyError} when the planner in use now cannot plan. */
  assertPlannerReady(): void;
  /** The runner the planner runs as now, whose account a usage limit belongs to; null when it is not a coding agent. */
  plannerRunner(): RunnerId | null;
}

interface Waiter {
  resolve(plan: LegacyPlanState): void;
  reject(err: unknown): void;
  signal?: AbortSignal;
}

/** The turn in flight, compared by identity: an abandoned one finds another, or none, in its place. */
interface Running {
  release: () => void;
  /** The inputs it took, which stay on the plan until it ends. */
  ids: ReadonlySet<string>;
  /** A force send stopped it. */
  forceStopped?: true;
  /** It retries a pause on the planner's context, which stays saved until the turn lands or is stopped. */
  recovery?: true;
}

type Outcome = { ok: true; plan: LegacyPlanState } | { ok: false; err: unknown };

/** One planner message for a batch: the inputs in the order they came, each with the skills it loaded. */
export function turnPrompt(batch: readonly PendingPlanTurn[]): TurnPrompt {
  const fromUser = batch.filter((t) => t.source === 'user');
  return {
    source: fromUser.length > 0 ? 'user' : 'supervisor',
    text: fromUser.map((t) => t.text).join('\n\n'),
    skills: fromUser.flatMap((t) => t.skills ?? []),
    wakeUps: batch.filter((t) => t.source === 'supervisor').map((t) => t.text),
    ...(fromUser.length === 0 ? { authority: authorityOf(batch[0]) } : {}),
    ...(batch.some((t) => t.forced) ? { forced: true } : {}),
  };
}

/** Who a wake-up input's turn acts for: the user's turn only for a report it is owed (ADR-0037, R3). */
function authorityOf(input: PendingPlanTurn | undefined): TurnAuthority {
  return input?.report === 'user' ? 'user' : 'supervisor';
}

/**
 * Live planner turns (ADR-0029): every input to the planner conversation after
 * its opening — a user's message, and later a wake-up batch — goes through
 * {@link enqueue}, during a run or not. Turns run one at a time and at once;
 * inputs that arrive during a turn are taken together by the next one.
 *
 * A turn holds the scheduler's new starts while it runs and always lets them
 * go when it ends — settled, stopped, failed, timed out on its hold, or
 * abandoned with its plan — so a planner that crashes cannot freeze the run.
 *
 * Inputs wait on the plan (`pendingTurns`), saved as they arrive, and leave it
 * in the save that lands their turn's outcome; a turn that ends without one
 * drops the user's then. A wake-up batch is only delivered by a turn that
 * lands with it, so it stays through a failed one — unless the user stopped
 * the turn, which was their answer to it. A turn that ends on the planner's
 * usage limit keeps every input it took, and no turn opens until the limit's
 * wait ends ({@link PlannerResend}): what arrives meanwhile waits with them,
 * and they all go as one turn. A force send is not an answer to
 * it (ADR-0023, F5): a turn it stopped keeps its wake-ups waiting, undelivered,
 * for the supervisor's next turn. The user's Stop also drops the user's inputs
 * waiting behind the turn it stopped ({@link stopQueued}). A reload keeps
 * what no turn answered for the next input, without opening a turn unless a
 * report the planner asked for waits ({@link restoreResend}).
 */
export class PlanTurns {
  private readonly waiters = new Map<string, Waiter>();
  private running: Running | null = null;
  /** A turn is due but waits for the planner to be found. */
  private detecting = false;
  /** The refusal last told to the user, so an input that keeps arriving is not refused aloud again and again. */
  private refusalTold: string | null = null;
  /** The user stopped the turn wake-ups waited behind: they wait for the next input to open one, not for the stop's release. */
  private quiet = false;
  /** A loaded session stays idle even if an outgoing turn's release pumps the queue. */
  private restored = false;
  /** A saved report's wake-up after a load, which waits for the load to finish. */
  private reportWake: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private readonly resend: PlannerResend;

  constructor(private readonly host: PlanTurnsHost, private readonly holdTimeoutMs = START_HOLD_TIMEOUT_MS) {
    this.resend = new PlannerResend({
      plan: () => host.plan(),
      plannerRunner: () => host.plannerRunner(),
      due: () => {
        host.announce();
        this.pump();
      },
      changed: () => host.announce(),
      notice: (message) => host.notice(message),
    });
  }

  /**
   * A turn ended on the planner's usage limit: arm the wait for its inputs,
   * unless a planner tool's change in it (`answered`) already took them
   * (ADR-0022 P2). Saved with the failure the turn records.
   */
  usageLimit(said: TurnFailure, answered = false): PlannerLimit {
    return answered ? this.resend.limitedAfterChange(said) : this.resend.limited(said);
  }

  /**
   * A turn ended with the planner paused on its context (ADR-0002): the pause
   * is armed on the inputs it took, which stay pending, and no turn opens
   * until the user's Retry compaction or Stop. Saved with the failure the turn
   * records.
   */
  contextPaused(details: Pick<PlannerContextPause, 'model' | 'reason' | 'done' | 'doneTruncated'>): PlannerContextPause {
    const pause: PlannerContextPause = { ...details, at: new Date().toISOString(), inputs: [...(this.running?.ids ?? [])] };
    const plan = this.host.plan();
    if (plan) plan.plannerContextPause = pause;
    return pause;
  }

  /**
   * The conversation's opening paused on the planner's context: its goal
   * waits with the pause, ahead of what was sent behind it, whose senders are
   * answered now as any sent during a pause are.
   */
  waitOnPause(input: PlanTurnInput): void {
    const plan = this.host.plan();
    const pause = plan?.plannerContextPause;
    if (!plan || !pause) return;
    const goal = this.pending(input, false);
    plan.pendingTurns = [goal, ...(plan.pendingTurns ?? [])];
    pause.inputs = [goal.id, ...pause.inputs];
    this.host.persist();
    for (const t of plan.pendingTurns) if (t.source === 'user') this.settle(t.id, (w) => w.resolve(plan));
  }

  /** Whether the planner is paused on its context. */
  private paused(): boolean {
    return this.host.plan()?.plannerContextPause !== undefined;
  }

  /**
   * The user's Retry compaction: the turn the planner paused on opens again,
   * on the inputs the pause kept and no others — what arrived since waits for
   * the turn after it, so none of it reaches a summary. Settles with the plan
   * that turn lands, or that it paused again on; rejects as a stopped or
   * failed turn does, the pause kept but for a stop.
   */
  async retryCompaction(signal?: AbortSignal): Promise<LegacyPlanState> {
    const plan = this.host.plan();
    const pause = plan?.plannerContextPause;
    if (!plan || !pause) throw new ConversationEditError('The planner is not paused on its context: there is nothing to retry.');
    if (this.running || this.detecting || this.host.conversationBusy()) throw new ConversationBusyError('retry compaction');
    const detecting = this.host.plannerDetecting();
    if (detecting) await detecting;
    if (this.host.plan() !== plan || plan.plannerContextPause !== pause) throw new PlannerTurnDiscardedError();
    if (this.running || this.host.conversationBusy()) throw new ConversationBusyError('retry compaction');
    this.host.assertPlannerReady();
    const kept = new Set(pause.inputs);
    const batch = (plan.pendingTurns ?? []).filter((t) => kept.has(t.id));
    if (batch.length === 0) throw new ConversationEditError('What the paused turn was answering no longer waits: stop the planner to clear the pause.');
    this.restored = false;
    this.quiet = false;
    const outcome = await this.run(plan, batch, { recovery: pause, signal });
    if (outcome.ok) return outcome.plan;
    if (outcome.err instanceof PlannerContextPausedError) return plan;
    throw outcome.err;
  }

  /** Keep what waits on the planner's usage limit from being sent at the reset; see {@link PlannerResend.cancel}. */
  cancelResend(): boolean {
    if (!this.resend.cancel()) return false;
    this.host.announce();
    return true;
  }

  /**
   * The conversation's opening ended on the planner's usage limit: its goal
   * waits with the limit, ahead of what was sent behind it, whose senders are
   * answered now as any sent during the wait are.
   */
  waitOnLimit(input: PlanTurnInput): void {
    const plan = this.host.plan();
    if (!plan) return;
    plan.pendingTurns = [this.pending(input, false), ...(plan.pendingTurns ?? [])];
    this.host.persist();
    for (const t of plan.pendingTurns) if (t.source === 'user') this.settle(t.id, (w) => w.resolve(plan));
  }

  /**
   * A plan adopted off disk keeps its inputs until a new input asks for a
   * turn. A report the planner asked for is one (ADR-0037, R2): saved behind
   * a turn that never landed, it wakes the planner once the load is done, as
   * one still in the supervisor's batch does. Only a saved usage-limit wait
   * keeps it for the user's next message; `mayReport` holds it once two
   * automatic turns have failed, and a chain of reports is not capped per
   * message (ADR-0037, R4).
   */
  restoreResend(): void {
    this.restored = true;
    this.resend.restore();
    if (this.reportWake) clearTimeout(this.reportWake);
    this.reportWake = null;
    if (!this.host.plan()?.pendingTurns?.some((t) => t.report !== undefined)) return;
    this.reportWake = setTimeout(() => {
      this.reportWake = null;
      if (!this.restored || this.resend.holds() || !this.host.mayReport()) return;
      this.restored = false;
      this.pump();
    }, 0);
  }

  /** Whether a turn this module opened is in flight. */
  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * Hand the planner an input; it settles with the plan the turn that takes it
   * lands, or rejects as that turn does. While another of these turns runs the
   * input waits for the next; while a turn of another kind holds the
   * conversation it is refused, as a reply always was.
   */
  enqueue(input: PlanTurnInput): Promise<LegacyPlanState> {
    // A wake-up is never refused: it waits for the conversation like any input
    // that arrives during a turn, and is delivered when it frees.
    if (input.source === 'user' && this.host.plan() && !this.running && this.host.conversationBusy()) return Promise.reject(new ConversationBusyError('send a message'));
    const plan = this.host.plan();
    if (input.idle && this.restored && plan) {
      plan.pendingTurns = [...(plan.pendingTurns ?? []), this.pending(input, false)];
      this.host.persist();
      return Promise.resolve(plan);
    }
    return this.admit(input, false);
  }

  /**
   * Force send (ADR-0023, F5): stop the planner turn in flight — whatever
   * kind holds the conversation — and answer this input in the turn that
   * replaces it, alone, ahead of every input waiting but an earlier forced
   * one; the rest keep their order behind it. Nothing can start between the
   * two: the input waits before the stop, and the next turn takes it first.
   * With no turn in flight it is a plain send.
   */
  forceSend(input: PlanTurnInput): Promise<LegacyPlanState> {
    if (!this.running && !this.host.conversationBusy()) return this.enqueue(input);
    const settled = this.admit(input, true);
    if (this.running) this.running.forceStopped = true;
    this.host.interrupt();
    return settled;
  }

  /**
   * An input that waits behind the conversation's opening rather than being
   * refused by it: the opening is the turn its sender was answering, so it
   * goes in the next turn once the opening lets the conversation go. A forced
   * one stops nothing — the opening has the goal — and only goes first.
   */
  follow(input: PlanTurnInput, forced = false): Promise<LegacyPlanState> {
    return this.admit(input, forced);
  }

  private admit(input: PlanTurnInput, forced: boolean): Promise<LegacyPlanState> {
    const plan = this.host.plan();
    if (!plan) return Promise.reject(new Error('No planning conversation to continue'));
    const entry = this.pending(input, forced);
    this.restored = false;
    this.quiet = false;
    if (this.resend.arrived()) this.host.announce();
    const pending = plan.pendingTurns ?? [];
    const at = forced ? pending.findIndex((t) => !t.forced && !this.running?.ids.has(t.id)) : -1;
    plan.pendingTurns = at === -1 ? [...pending, entry] : [...pending.slice(0, at), entry, ...pending.slice(at)];
    this.host.persist();
    // Its sender is answered now, not hours from now at the reset: the message
    // is saved, and the turn that sends it is nobody's call to wait on.
    if (input.source === 'user' && (this.resend.holds() || this.paused())) {
      this.pump();
      return Promise.resolve(plan);
    }
    const settled = new Promise<LegacyPlanState>((resolve, reject) => {
      this.waiters.set(entry.id, { resolve, reject, signal: input.signal });
    });
    this.pump();
    return settled;
  }

  private pending(input: PlanTurnInput, forced: boolean): PendingPlanTurn {
    return {
      id: `turn-${Date.now()}-${++this.seq}`,
      source: input.source,
      text: input.text,
      timestamp: new Date().toISOString(),
      ...(input.skills && input.skills.length > 0 ? { skills: [...input.skills] } : {}),
      ...(forced ? { forced: true } : {}),
      ...(input.report ? { report: input.report } : {}),
    };
  }

  /**
   * Start the next turn if one is due: nothing of ours is in flight, the
   * conversation is free, and inputs wait. The host calls it when any planner
   * turn lets the conversation go. A loaded session waits for a new input.
   *
   * Every turn passes the planner gate here, whatever brought its input: it
   * waits for the installed-planner probe, then everything is judged afresh —
   * the plan, what still waits, and the planner in use at that moment.
   */
  pump(): void {
    if (this.restored || this.running || this.detecting || this.resend.holds() || this.paused()) return;
    const plan = this.host.plan();
    if (!plan || this.host.conversationBusy()) return;
    const batch = this.liveBatch(plan);
    if (batch.length === 0) return;
    const detecting = this.host.plannerDetecting();
    if (detecting) {
      this.detecting = true;
      void detecting.then(() => {
        this.detecting = false;
        this.pump();
      });
      return;
    }
    try {
      this.host.assertPlannerReady();
    } catch (err) {
      this.refuse(plan, err);
      return;
    }
    this.refusalTold = null;
    void this.run(plan, batch);
  }

  /**
   * The planner cannot plan, so no turn opens, and nothing it would have
   * answered is lost. A caller still waiting hears why and holds its own
   * message, so that message leaves the list, as a refusal before it was
   * queued would have left it; a message restored from a save has nobody else
   * holding it, so it stays for the next turn, as wake-ups do.
   *
   * Everything waiting is refused, not just the next turn's batch: behind a
   * forced input, the rest would otherwise wait for a pump nothing calls.
   */
  private refuse(plan: LegacyPlanState, err: unknown): void {
    const waiting = plan.pendingTurns ?? [];
    const heard = new Set(waiting.filter((t) => t.source === 'user' && this.waiters.has(t.id)).map((t) => t.id));
    if (this.take(plan, heard)) this.host.persist();
    for (const t of waiting) this.settle(t.id, (w) => w.reject(err));
    const kept = waiting.filter((t) => t.source === 'user' && !heard.has(t.id));
    if (kept.length === 0) return;
    const told = `${reasonOf(err)} ${keptUnanswered(kept)}`;
    if (told === this.refusalTold) return;
    this.refusalTold = told;
    this.host.notice(told);
  }

  /**
   * The user's Stop of planner work: what waits for it is part of what they
   * stopped, at any stage — a turn waiting at the planner gate, or an opening
   * or a reply live. Every user input still waiting ends as a stopped turn's
   * inputs do — dropped, each caller told it was stopped — so the stopped
   * turn's release finds none of them to open. The live turn's own inputs are
   * its to settle. At the gate the waiting batch is the stopped turn, so its
   * wake-ups go with it. Behind a live turn they are not what the user
   * answered: they stay undelivered, as a reload keeps them (ADR-0029), and go
   * with the next turn something else opens — the user's next message or the
   * supervisor's next wake-up — never off the release of the turn the user
   * stopped. A force send never comes here: it keeps the queue (ADR-0023).
   * False when nothing waited.
   */
  stopQueued(): boolean {
    const plan = this.host.plan();
    // Paused, nothing but a Retry (`running`) carries the turn on: a /compact the user runs meanwhile is stopped with it, and the pause ends.
    if (plan && this.paused() && !this.running) return this.dropPause(plan);
    if (!plan || (!this.detecting && !this.running && !this.host.conversationBusy())) return false;
    const live = this.running?.ids;
    const waiting = (plan.pendingTurns ?? []).filter((t) => !live?.has(t.id));
    const stopped = this.detecting ? waiting : waiting.filter((t) => t.source === 'user');
    if (stopped.length < waiting.length) this.quiet = true;
    if (stopped.length === 0) return false;
    this.take(plan, new Set(stopped.map((t) => t.id)));
    this.host.persist();
    for (const t of stopped) this.settle(t.id, (w) => w.reject(new PlannerTurnStoppedError()));
    return true;
  }

  /**
   * The user's Stop of a planner paused on its context: the paused turn ends
   * as a stopped one would — the user's inputs waiting dropped, each caller
   * told — and the pause goes with it. Wake-ups stay undelivered, as behind
   * any stopped turn, for the next input to carry.
   */
  private dropPause(plan: LegacyPlanState): boolean {
    const stopped = (plan.pendingTurns ?? []).filter((t) => t.source === 'user');
    if (stopped.length < (plan.pendingTurns ?? []).length) this.quiet = true;
    this.take(plan, new Set(stopped.map((t) => t.id)));
    delete plan.plannerContextPause;
    this.host.announce();
    for (const t of stopped) this.settle(t.id, (w) => w.reject(new PlannerTurnStoppedError()));
    return true;
  }

  /**
   * The plan these turns served is gone (a new plan, another session adopted,
   * the session closed): the hold goes now, and every caller still waiting
   * hears that its turn was discarded. The turn in flight is the
   * conversation's to abandon; whatever it settles lands nothing here.
   */
  abandon(): void {
    this.resend.reset();
    if (this.reportWake) clearTimeout(this.reportWake);
    this.reportWake = null;
    this.running?.release();
    this.running = null;
    this.quiet = false;
    this.restored = false;
    for (const waiter of this.waiters.values()) waiter.reject(new PlannerTurnDiscardedError());
    this.waiters.clear();
  }

  /**
   * What the next turn takes: what waits, oldest first, less any input whose
   * caller stopped it before its turn began — or a forced input alone. With
   * no user input, only wake-ups that may open a turn now, and of one
   * authority: a report owed to the user's turn and the supervisor's own
   * inputs take turns of their own (ADR-0037, R3), the older first.
   */
  private liveBatch(plan: LegacyPlanState): PendingPlanTurn[] {
    const pending = plan.pendingTurns ?? [];
    const stopped = pending.filter((t) => this.waiters.get(t.id)?.signal?.aborted);
    if (stopped.length > 0) {
      this.take(plan, new Set(stopped.map((t) => t.id)));
      this.host.persist();
      for (const t of stopped) this.settle(t.id, (w) => w.reject(new PlannerTurnStoppedError()));
    }
    const live = plan.pendingTurns ?? [];
    if (live[0]?.forced) return [live[0]];
    if (live.some((t) => t.source === 'user')) return live;
    if (this.quiet) return [];
    // A report turn that may not open waits for the user's next message, even beside a supervisor input (ADR-0037 R2).
    const eligible = this.host.mayReport() ? live : live.filter((t) => t.report === undefined);
    const authorities = [...new Set(eligible.map(authorityOf))];
    return authorities.map((authority) => eligible.filter((t) => authorityOf(t) === authority)).find((group) => this.mayOpen(group)) ?? [];
  }

  /** A report the planner asked for opens a turn at every level (ADR-0037, R2); the supervisor's own wake-ups only while it watches. */
  private mayOpen(wakeUps: readonly PendingPlanTurn[]): boolean {
    return wakeUps.some((t) => t.report !== undefined) ? this.host.mayReport() : this.host.mayWake();
  }

  private async run(plan: LegacyPlanState, batch: readonly PendingPlanTurn[], opts: { recovery?: PlannerContextPause; signal?: AbortSignal } = {}): Promise<Outcome> {
    const ids = new Set(batch.map((t) => t.id));
    const running: Running = { release: this.host.holdStarts(), ids, ...(opts.recovery ? { recovery: true } : {}) };
    this.running = running;
    const timeout = setTimeout(() => {
      running.release();
      this.host.resumeStarts().catch((err: unknown) => this.host.notice(`New tasks could not start: ${reasonOf(err)}`));
    }, this.holdTimeoutMs);
    const signals = [...batch.flatMap((t) => this.waiters.get(t.id)?.signal ?? []), ...(opts.signal ? [opts.signal] : [])];
    let outcome: Outcome;
    try {
      this.host.turnStarting?.(batch);
      const landed = await this.host.run({ ...turnPrompt(batch), ...(opts.recovery ? { recovery: opts.recovery } : {}) }, {
        taken: () => {
          this.take(plan, ids);
          // The retry landed: the pause goes in the save that carries its answer.
          if (running.recovery && plan.plannerContextPause === opts.recovery) delete plan.plannerContextPause;
        },
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      });
      outcome = { ok: true, plan: landed };
    } catch (err) {
      outcome = { ok: false, err };
    }
    clearTimeout(timeout);
    // Abandoned: the hold is gone and every waiter has heard.
    if (this.running !== running) return outcome;
    const forceStopped = !outcome.ok && running.forceStopped === true;
    const limited = !outcome.ok && outcome.err instanceof PlannerUsageLimitError;
    const paused = !outcome.ok && outcome.err instanceof PlannerContextPausedError;
    const stopped = !outcome.ok && (isInterruption(outcome.err) || forceStopped);
    // A retry that failed for another reason leaves the planner paused as it was, on the same inputs.
    const kept = limited || paused || (running.recovery === true && !outcome.ok && !stopped);
    if (outcome.ok) this.resend.landed();
    try {
      // A turn that landed nothing still had its say; the user's inputs go
      // with it. A failure, or a force send, leaves the wake-ups undelivered,
      // and a usage limit or a pause on the planner's context leaves
      // everything, to be sent again.
      const dropped = kept
        ? new Set<string>()
        : outcome.ok || (isInterruption(outcome.err) && !forceStopped)
          ? ids
          : new Set(batch.filter((t) => t.source === 'user').map((t) => t.id));
      const took = this.take(plan, dropped);
      // A stopped retry was the user's answer to the pause.
      const unpaused = running.recovery === true && stopped && plan.plannerContextPause === opts.recovery;
      if (unpaused) delete plan.plannerContextPause;
      // Its wake-ups wait behind the forced inputs, each of which takes a turn alone first.
      if (forceStopped) plan.pendingTurns = [...(plan.pendingTurns ?? []).filter((t) => t.forced), ...(plan.pendingTurns ?? []).filter((t) => !t.forced)];
      if (unpaused) this.host.announce();
      else if (took || forceStopped) this.host.persist();
      running.release();
      await this.host.resumeStarts();
    } catch (err) {
      if (outcome.ok) outcome = { ok: false, err };
    } finally {
      running.release();
      this.running = null;
      const ended = outcome;
      const waiting = new Set((plan.pendingTurns ?? []).map((t) => t.id));
      for (const t of batch) {
        // A user's message waiting on the limit or the pause is answered now: its turn is the user's to retry, and the failure is in the transcript.
        if ((limited || paused) && t.source === 'user') {
          this.settle(t.id, (w) => w.resolve(plan));
          continue;
        }
        // Kept wake-ups are heard of from the turn that delivers them: the supervisor counts on it.
        if ((forceStopped || kept) && waiting.has(t.id)) continue;
        const delivered = this.settle(t.id, (w) => (ended.ok ? w.resolve(ended.plan) : w.reject(ended.err)));
        if (!delivered && !ended.ok && !isInterruption(ended.err) && !running.recovery && t.source === 'user') this.host.notice(replayFailed(t, ended.err));
      }
      this.pump();
    }
    return outcome;
  }

  /** Drop these inputs from the plan's list; true when any were still there. */
  private take(plan: LegacyPlanState, ids: ReadonlySet<string>): boolean {
    const pending = plan.pendingTurns ?? [];
    const kept = pending.filter((t) => !ids.has(t.id));
    if (kept.length === pending.length) return false;
    plan.pendingTurns = kept;
    return true;
  }

  private settle(id: string, how: (waiter: Waiter) => void): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter) return false;
    this.waiters.delete(id);
    how(waiter);
    return true;
  }
}

function isInterruption(err: unknown): boolean {
  return err instanceof PlannerTurnStoppedError || err instanceof PlannerTurnDiscardedError;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function keptUnanswered(inputs: readonly PendingPlanTurn[]): string {
  const line = inputs[0].text.split('\n')[0];
  const more = inputs.length > 1 ? ` and ${inputs.length - 1} more` : '';
  return `"${line}"${more}, sent before the session reloaded, still waits and goes with your next message.`;
}

function replayFailed(input: PendingPlanTurn, err: unknown): string {
  const line = input.text.split('\n')[0];
  return `The planner could not answer "${line}", sent before the session reloaded: ${reasonOf(err)}. Send it again to retry.`;
}

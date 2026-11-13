import type { OpenLease, ReservedLease } from './executionLease';
import { PlannerTurnStoppedError } from './PlannerConversation';

export interface TurnGateHost {
  /** A planner turn's lease from the tree's pool; a refusal keeps the Session, which hears {@link TurnGate.freed} (ADR-0059 L1). */
  reserve(): { lease: ReservedLease } | { refused: string };
  /** Whether a turn waits for a slot of the tree before it opens: a subplanner's does (ADR-0055 D18). */
  placed(): boolean;
  /** Whether the installed-planner probe has answered (ADR-0009). */
  plannerAnswered(): boolean;
  /** Settles once it has. */
  plannerDetected(): Promise<void>;
  /** A turn now waits on the probe, or no longer does: the surfaces are told. */
  detecting(waiting: boolean): void;
  /** Throws while another host holds the session this Session has open (ADR-0049 L5). */
  refuseHeld(): void;
  /** Throws why the planner cannot plan now, judged once the probe has answered (ADR-0009). */
  assertReady(): void;
  /** A turn {@link PlanTurns} opened is under way: its end, not the conversation's, gives the lease back. */
  queuedTurnRunning(): boolean;
  /** A planner turn holds the conversation. */
  conversationBusy(): boolean;
  /** The lease went back: a subplanner between turns is a parked row with no process (ADR-0055 D18). */
  parked(): void;
  /** No opening waited for the slot the pool offered: the queue's next turn may take it. */
  pump(): void;
}

/**
 * What a turn is judged as. A `session` turn — a reply, a compaction — works
 * on the session this Session has open, so another host's hold refuses it. A
 * `goal` is judged by the session it writes (ADR-0049 L5): under a minted id
 * that is a new one, so a Session that lost its lease may still plan, and
 * under a host's fixed id the caller claims that session itself once admitted.
 */
export type AdmissionKind = 'session' | 'goal';

/** A turn admitted and not yet open: settled once, by its admission or by why it must not open. */
interface Waiter {
  /** It waits for a slot of the tree, not for the probe. */
  slot: boolean;
  /** Once: a later call finds it gone. */
  settle(outcome: { err: unknown } | null): void;
}

/**
 * Admission of a planner turn, from the gate to its lease's end. A turn waits
 * for the installed-planner probe and is judged afresh once it answers; a
 * subplanner's then waits for a slot of the tree, taken as the turn's lease
 * and kept from its admission to its end, however many times it takes the
 * conversation (ADR-0059 L1, ADR-0055 D18). One lease serves the Session: a
 * planner turn holds the conversation alone, and whatever else was admitted
 * beside it meets the conversation's own refusal.
 *
 * A wait ends at once, not when what it waits for comes, on its caller's
 * abort or on {@link endAll} — a Stop, a newer goal, its plan scope ending —
 * since a turn that learnt of these only afterwards would open on a session
 * that moved on.
 */
export class TurnGate {
  private lease: ReservedLease | null = null;
  private readonly waiters = new Set<Waiter>();
  /** The probe the waiters are parked on, which the surfaces were told of; null once it answered. */
  private detection: Promise<void> | null = null;
  /** A fresh plan's admission is carried across the old scope's end: see {@link carry}. */
  private carrying = false;

  constructor(private readonly host: TurnGateHost) {}

  /**
   * Admit a turn {@link PlanTurns} does not open — an opening, plan
   * generation, a compaction — and run `enter`, which takes the conversation.
   * The one judgment, in its order: wait for the probe; refuse a held
   * session, then a planner that cannot plan; then, for a subplanner, wait
   * for a slot, judging afresh if it had to, since a takeover or a spent
   * budget may land in that wait. `enter` runs in the tick the turn is
   * admitted, at once when nothing was waited on: awaited first, the turn
   * would take the conversation a tick late, and a message sent alongside it
   * would no longer be refused as one sent during it.
   *
   * What `enter` returns is awaited. A refusal, an end of the wait, or a
   * failure of `enter` gives the slot back unless a turn holds the
   * conversation by then, whose own end does; a caller that must not wait on
   * the turn it opened returns it wrapped.
   */
  async admit<T>(kind: AdmissionKind, signal: AbortSignal | undefined, enter: () => T | Promise<T>): Promise<T> {
    try {
      const planner = this.plannerWait(kind, signal);
      if (planner) await planner;
      const slot = this.host.placed() ? this.slotWait(signal) : null;
      if (slot) {
        await slot;
        this.judge(kind);
      }
      return await enter();
    } catch (err) {
      this.dropped();
      throw err;
    }
  }

  /** Take the lease if none is held; why the pool refused it otherwise. */
  claim(): string | null {
    if (this.lease) return null;
    const reserved = this.host.reserve();
    if ('refused' in reserved) return reserved.refused;
    this.lease = reserved.lease;
    return null;
  }

  /**
   * The pool has a slot for the turn it refused. Every turn waiting for one
   * is let through on the one lease, as if none had waited; with none
   * waiting, the queue's next turn may take it. Refused again, they wait on:
   * the pool kept the Session once more.
   */
  freed(): void {
    const waiting = [...this.waiters].filter((w) => w.slot);
    if (waiting.length === 0) {
      this.host.pump();
      return;
    }
    if (this.claim() !== null) return;
    for (const waiter of waiting) waiter.settle(null);
  }

  /** Where a planner's process starts, opened around its adapter. Undefined with no lease: nothing has a turn to start it for. */
  open(signal: AbortSignal): Promise<OpenLease> | undefined {
    return this.lease?.open({ workspace: { kind: 'checkout' }, required: [] }, signal);
  }

  /**
   * The turn is over. A turn's own corrective retries come before this, in
   * the one process, and its slot goes only once that process has.
   */
  settled(): void {
    const lease = this.lease;
    if (!lease || this.carrying) return;
    this.lease = null;
    this.host.parked();
    lease.release('turn ended');
  }

  /** The conversation let a turn go. One {@link PlanTurns} opened ends with that turn, which may take the conversation again. */
  released(): void {
    if (!this.host.queuedTurnRunning()) this.settled();
  }

  /**
   * A turn admitted, or a conversation turn, ended without being one of the
   * queue's: nothing else would give back the slot it took, which would stay
   * out of the tree's pool. A turn holding the lease by then is its own to end.
   */
  dropped(): void {
    if (!this.host.conversationBusy()) this.released();
  }

  /**
   * Run the old plan scope's end for a goal this gate let in, keeping its
   * lease through it: given back, the pool offers it on at once, and a
   * sibling's kept turn leaves this one none. That end takes the process of
   * any turn this one replaces, as {@link settled} would.
   */
  carry(scopeEnd: () => void): void {
    const outer = this.carrying;
    this.carrying = true;
    try {
      scopeEnd();
    } finally {
      this.carrying = outer;
    }
  }

  /** End every turn waiting before it opens, each with `why`; false when none was. */
  endAll(why: () => Error): boolean {
    const waiting = [...this.waiters];
    for (const waiter of waiting) waiter.settle({ err: why() });
    return waiting.length > 0;
  }

  /** A turn admitted waits to open. */
  get waiting(): boolean {
    return this.waiters.size > 0;
  }

  /** A turn waits on the installed-planner probe. */
  get detecting(): boolean {
    return this.detection !== null;
  }

  /** What the queue's turns wait on before they are judged: the probe, or null once it answered. */
  probe(): Promise<void> | null {
    return this.host.plannerAnswered() ? null : this.detected();
  }

  /** Whether a lease is held. */
  get holding(): boolean {
    return this.lease !== null;
  }

  private judge(kind: AdmissionKind): void {
    if (kind === 'session') this.host.refuseHeld();
    this.host.assertReady();
  }

  private plannerWait(kind: AdmissionKind, signal: AbortSignal | undefined): Promise<void> | null {
    if (this.host.plannerAnswered()) {
      this.judge(kind);
      return null;
    }
    return this.wait(signal, false, (waiter) => {
      void this.detected().then(() => {
        // Ended meanwhile: its caller has heard, and the probe's answer must not open it after all.
        if (!this.waiters.has(waiter)) return;
        let outcome: { err: unknown } | null = null;
        try {
          this.judge(kind);
        } catch (err) {
          outcome = { err };
        }
        waiter.settle(outcome);
      });
    });
  }

  /** Null with a slot in hand. */
  private slotWait(signal: AbortSignal | undefined): Promise<void> | null {
    if (this.claim() === null) return null;
    return this.wait(signal, true, () => undefined);
  }

  private wait(signal: AbortSignal | undefined, slot: boolean, armed: (waiter: Waiter) => void): Promise<void> {
    if (signal?.aborted) return Promise.reject(new PlannerTurnStoppedError());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => { waiter.settle({ err: new PlannerTurnStoppedError() }); };
      const waiter: Waiter = {
        slot,
        settle: (outcome) => {
          if (!this.waiters.delete(waiter)) return;
          signal?.removeEventListener('abort', onAbort);
          if (outcome) reject(outcome.err);
          else resolve();
        },
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      armed(waiter);
    });
  }

  private detected(): Promise<void> {
    if (!this.detection) {
      this.detection = this.host.plannerDetected().then(() => {
        this.detection = null;
        this.host.detecting(false);
      });
      this.host.detecting(true);
    }
    return this.detection;
  }
}

import type { ApprovalRequestMessage, LegacyPlanState, SessionMessage } from '@ordewell/core';
// The browser-safe entry, so the webview's tests can run the host's view too.
import {
  drainNext, EMPTY_CONVERSATION, EMPTY_HOLD, followTurn, fromTranscript, holdPrompt, NO_TURN, reconcileApprovals, stopTurn, takeAt, unsendAll, unsendLatest,
  type ConversationInput, type ConversationView, type DisplayBlock, type GatedConversation, type LocalEntry, type PromptHold,
  type TurnGate,
} from '@ordewell/core/plan-utils';
import { diffConversation } from './shared/conversationPatch';
import type { HostToWebview } from './shared/protocol';

const FLUSH_MS = 30;

export type SavedConversation = Pick<LegacyPlanState, 'conversationHistory' | 'researchLog' | 'plannerUsage' | 'pendingTurns'>;

/**
 * The planner conversation the chat webview draws (#53), held on the host:
 * session events and local notices fold into core's view here, and the webview
 * only ever mirrors it.
 *
 * It goes out as block patches, not snapshots. A snapshot re-sends every block
 * — every command's full output — on each text delta, so a delta late in a
 * long session would cost the whole session so far. Core's reducer keeps each
 * untouched block's identity, so a patch costs only the blocks that changed.
 * Deltas also arrive faster than a frame, so patches wait `FLUSH_MS` and go out
 * as one per burst, which is one webview render rather than one per token.
 *
 * It also holds the queued prompts — what the user typed while a turn was in
 * flight — because they belong to this conversation: a reset or a reloaded
 * session drops them along with the view they were written against.
 */
export class ConversationViewHost {
  private view: ConversationView = EMPTY_CONVERSATION;
  private sent: readonly DisplayBlock[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gate: TurnGate = NO_TURN;
  private held: PromptHold = EMPTY_HOLD;
  /** The open turn produced output since the last flush; see `plannerTurnAlive`. */
  private alive = false;

  constructor(private readonly post: (msg: HostToWebview) => void) {}

  get blocks(): readonly DisplayBlock[] {
    return this.view.blocks;
  }

  receive(msg: SessionMessage): void {
    if (msg.type === 'planner_liveness') {
      this.post({ type: 'plannerLiveness' });
      return;
    }
    const wasOpen = this.gate.open;
    this.update(followTurn(this.view, this.gate, msg));
    if (this.gate.open !== wasOpen) {
      this.announceTurn();
    } else if (wasOpen !== null && 'turnId' in msg && msg.turnId === wasOpen) {
      // Only an event tagged with the turn the gate holds open: untagged or
      // late traffic of an ended or stopped one must never re-lock the input.
      this.alive = true;
      this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  note(role: LocalEntry['role'], text: string): void {
    this.fold({ type: 'local_entry', role, text });
  }

  holdPrompt(text: string): void {
    this.showHeld(holdPrompt(this.held, text));
  }

  /**
   * The host decides what comes back, not the webview: a prompt the turn's end
   * drained in the meantime has already gone, and must not also reappear.
   */
  unsendPrompt(): void {
    const latest = unsendLatest(this.held);
    if (!latest) return;
    this.post({ type: 'promptUnsent', text: latest.text });
    this.showHeld(latest.rest);
  }

  /**
   * The oldest queued prompt, taken out of the hold for the caller to send.
   * Asked by whoever owns the host's turn once it has fully ended — the
   * `planner_turn_ended` event comes while the turn is still unwinding, too
   * early to start the next one.
   */
  nextPrompt(): string | undefined {
    const next = drainNext(this.held);
    if (!next) return undefined;
    this.showHeld(next.rest);
    return next.text;
  }

  /**
   * Take one held prompt out by position for a "Send now" on its row: the
   * caller force sends it, and the rest stay held in the order they were typed.
   */
  takePrompt(index: number): string | undefined {
    const taken = takeAt(this.held, index);
    if (!taken) return undefined;
    this.showHeld(taken.rest);
    return taken.text;
  }

  /**
   * The user stopped the planner. The turn ends on screen now rather than when
   * the backend notices the abort, and whatever it still streams until its
   * real end is dropped. Queued prompts go back to the input rather than
   * following the stop — the host may not have opened the turn yet, so they
   * are released whether or not one is.
   */
  stop(): void {
    const all = unsendAll(this.held);
    if (all) {
      this.post({ type: 'promptUnsent', text: all.text });
      this.showHeld(all.rest);
    }
    if (this.gate.open === null) {
      // The webview locks its composer at send, before the host has opened the
      // turn. Announcing the closed turn releases that gate even when there is
      // nothing here to stop; otherwise later plan updates stay dropped.
      this.post({ type: 'plannerTurn', active: false });
      return;
    }
    this.update(stopTurn(this.view, this.gate));
    this.announceTurn();
  }

  /** The view a saved session reopens with, built from its records alone (#51). */
  reload(saved: SavedConversation): void {
    this.replace(fromTranscript(saved.conversationHistory, saved.researchLog, saved.plannerUsage, saved.pendingTurns));
  }

  /**
   * The planner's requests the Session says are still waiting. A reload is
   * drawn from the transcript, which keeps no approval card, and a request is
   * announced once — so without this a card still waiting was gone, and
   * nothing was left to answer it with.
   */
  waiting(requests: readonly ApprovalRequestMessage[]): void {
    this.show(reconcileApprovals(this.view, requests));
  }

  /**
   * A new session or a cleared plan. A turn the webview asked for that never
   * opened here belongs to the old session too: replace() stops whatever is
   * open and announces the closed turn either way (see stop()).
   */
  reset(): void {
    this.replace(EMPTY_CONVERSATION);
  }

  /** A new webview holds nothing, so it is sent every block. */
  resync(): void {
    this.sent = [];
    this.flush();
    this.post({ type: 'heldPrompts', prompts: this.held });
    this.postTurn();
  }

  flush(): void {
    this.send(false);
  }

  private send(replaced: boolean): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const patch = diffConversation(this.sent, this.view.blocks);
    this.sent = this.view.blocks;
    if (patch) this.post(replaced ? { ...patch, replaced } : patch);
    if (this.alive && this.gate.open !== null) this.post({ type: 'plannerTurnAlive' });
    this.alive = false;
  }

  // A turn still open belongs to the view being replaced; stopping it keeps
  // its late output out of the new one. Its queued prompts are dropped, not
  // given back: they were written for a conversation that is gone.
  private replace(view: ConversationView): void {
    if (this.held.length > 0) this.showHeld(EMPTY_HOLD);
    this.stop();
    this.view = view;
    this.send(true);
  }

  private showHeld(held: PromptHold): void {
    this.held = held;
    this.post({ type: 'heldPrompts', prompts: held });
  }

  // The turn opening or closing flushes first, so the webview never learns of
  // the change ahead of the blocks it was drawn with.
  private announceTurn(): void {
    this.flush();
    this.postTurn();
  }

  private postTurn(): void {
    const open = this.gate.open !== null;
    this.post({ type: 'plannerTurn', active: open, ...(open && this.gate.openedAt ? { startedAt: this.gate.openedAt } : {}) });
  }

  private fold(input: ConversationInput): void {
    this.update(followTurn(this.view, this.gate, input));
  }

  private update({ view, gate }: GatedConversation): void {
    this.gate = gate;
    this.show(view);
  }

  private show(next: ConversationView): void {
    if (next === this.view) return;
    this.view = next;
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }
}

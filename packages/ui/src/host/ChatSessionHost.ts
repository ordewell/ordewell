import type { DaemonErrorCode, RunnerId } from '@ordewell/core';
// The browser-safe entry: the desktop renderer runs this too.
import { sendNowGivesBack } from '@ordewell/core/plan-utils';
import type { ConversationViewHost } from './ConversationViewHost';

/** How one planner turn is asked for: a Send now stops the turn in flight and is answered in the one replacing it. */
export interface ChatTurn {
  readonly now: boolean;
  /** The runners a fresh session's first turn plans with, as the chat's pills had them. */
  readonly runners?: readonly RunnerId[];
}

/** How a turn ended, in the daemon's codes, which an in-process session maps its errors to. */
export type TurnOutcome = { readonly ok: true } | { readonly ok: false; readonly code?: DaemonErrorCode };

/**
 * What a surface's session answers for the chat: the in-process Session in the
 * extension, the daemon's routes in the desktop app (ADR-0063 H7).
 */
export interface SessionPort {
  /**
   * Whether a planner turn holds the session as the surface last saw it: a
   * prompt typed now is held, and Send now stops that turn.
   */
  generating(): boolean;
  /**
   * Whether a turn this surface asked for is still waiting on its answer. The
   * release after a turn asks only this: over a daemon the answer can come in
   * before the frame that ends the turn, and a prompt held for that turn must
   * not wait on the frame.
   */
  answering(): boolean;
  /**
   * One planner turn answering `text`. It resolves once the surface's handling
   * of the turn has returned (its plan shown, its error reported), with how
   * the turn ended.
   */
  converse(text: string, turn: ChatTurn): Promise<TurnOutcome>;
}

/**
 * The planner chat's prompt actions, the same on every surface (ADR-0017 Q1,
 * Q2): what is typed during a turn is held, the held prompts go glued once the
 * turn is over, and Send now takes everything held with the draft last and
 * stops the turn in flight. It keeps nothing of its own: the hold lives in the
 * conversation it was written against, so a surface may build one per message.
 * A slash command is the surface's to run before it gets here.
 */
export class ChatSessionHost {
  constructor(
    private readonly conversation: ConversationViewHost,
    private readonly port: SessionPort,
  ) {}

  /**
   * A prompt sent from the chat. Typed during a turn it is held: starting
   * another turn now would race the one in flight. A button's message (not
   * typed) is not the user's words, so it is neither held nor shown as theirs.
   */
  async send(text: string, typed: boolean, runners?: readonly RunnerId[]): Promise<void> {
    if (typed && this.port.generating()) {
      this.conversation.holdPrompt(text);
      return;
    }
    await this.answer(text, typed, runners);
  }

  /**
   * A prompt the chat held because it saw a turn in flight. Whether it is held
   * here is the surface's call; false means that turn has ended since, and the
   * surface sends it as typed.
   */
  hold(text: string): boolean {
    if (!this.port.generating()) return false;
    this.conversation.holdPrompt(text);
    return true;
  }

  unsend(toComposer: boolean): void {
    this.conversation.unsendPrompt(toComposer);
  }

  /**
   * Send now (ADR-0017 Q2, ADR-0023 F5): everything held, glued in the order
   * typed with the draft (which may be empty) last, as one message. With no
   * turn in flight it is a plain send, so the same key works before a turn
   * opens. A forced turn that does not answer gives back what it took, as
   * `sendNowGivesBack` rules for every surface.
   */
  async sendNow(draft: string): Promise<void> {
    const text = this.conversation.takeAll(draft);
    if (!text.trim()) return;
    if (!this.port.generating()) {
      await this.answer(text, true);
      return;
    }
    this.conversation.note('user', text);
    const outcome = await this.port.converse(text, { now: true });
    if (!outcome.ok && sendNowGivesBack(outcome.code)) this.conversation.giveBack(text);
    await this.turnEnded();
  }

  /**
   * A turn the chat did not send (a Retry compaction) or a slash command has
   * returned: what was held goes, unless a turn still holds the session, whose
   * end releases it instead.
   */
  async release(): Promise<void> {
    if (!this.port.generating()) await this.sendHeld();
  }

  /**
   * A planner turn this surface asked for has returned: what was held goes,
   * unless another of its turns is still answering (the Send now that stopped
   * it), whose end releases it instead.
   */
  async turnEnded(): Promise<void> {
    if (!this.port.answering()) await this.sendHeld();
  }

  private async sendHeld(): Promise<void> {
    const next = this.conversation.nextPrompt();
    if (next !== undefined) await this.answer(next, true);
  }

  private async answer(text: string, typed: boolean, runners?: readonly RunnerId[]): Promise<void> {
    if (typed && text.trim()) this.conversation.note('user', text);
    await this.port.converse(text, { now: false, ...(runners ? { runners } : {}) });
    await this.turnEnded();
  }
}

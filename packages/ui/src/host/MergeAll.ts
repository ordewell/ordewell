import type { MergeWordingHandoff } from '@ordewell/core';
// The browser-safe entry: the desktop renderer runs this too.
import { checkoutRule, mergeTarget } from '@ordewell/core/plan-utils';
import {
  mergeAllConfirmation, mergeBesideOpsQuestion, mergePastChecksQuestion, type ConfirmationRequest,
} from './confirmations';

/**
 * The yeses a Merge all has been given, each sent with every later call: the
 * seam names what it holds the merge for one question at a time.
 */
export interface MergeYes {
  /** Work no check has passed (ADR-0055 D9). */
  pastChecks?: true;
  /** An ops task running in the user's checkout (ADR-0020). */
  besideOps?: true;
}

/** What the seam made of one Merge all, in words no transport is needed to read. */
export type MergeAnswer =
  /** The seam took the merge and has its result. A merge git stopped is a result the handoff card shows, not an error. */
  | { kind: 'done' }
  /** The seam held the merge for what `hold` names; `message` is its own words, naming it. */
  | { kind: 'held'; hold: keyof MergeYes; message: string };

/**
 * One Merge all at the seam as the user (ADR-0029). A refusal that is not a
 * hold is thrown, in the seam's own words.
 */
export type MergeCall = (yes: MergeYes) => Promise<MergeAnswer>;

/** What Merge all needs of a surface: the run's handoff, a place to ask, and the seam. */
export interface MergePort {
  /** The run's handoff as the cards show it, to name the branch the merge lands on; none before one exists. */
  handoff(): MergeWordingHandoff | null | undefined;
  /** Whether a run is executing: Merge all then opens the merge gates and the run goes on (ADR-0020). */
  isExecuting(): boolean;
  /**
   * The merge as the session on screen takes it. Taken once per Merge all, so a
   * session switched to while a question is open is not sent the yes.
   */
  mergeCall(): MergeCall;
  /** Ask in the surface's real dialog; a dismissal is read as no. */
  ask<C extends string>(request: ConfirmationRequest<C>): Promise<C | null | undefined>;
}

const HELD_QUESTIONS = { pastChecks: mergePastChecksQuestion, besideOps: mergeBesideOpsQuestion } as const;

/**
 * Merge all and the questions it asks on the way (ADR-0020, ADR-0055 D9, ADR-0062
 * G8), the same on every surface. Every question is the person's: a no to any
 * leaves the run untouched, and a yes is given once, never assumed for the next.
 */
export class MergeAll {
  constructor(private readonly port: MergePort) {}

  /**
   * Merge all from the plan card or the handoff: the merge is confirmed first,
   * naming the branch it lands on and the rule that it must be checked out.
   * Resolves whether it merged; false is a person's no. A refusal the seam
   * makes is thrown, and the surface says it.
   */
  async run(): Promise<boolean> {
    const { port } = this;
    const handoff = port.handoff();
    const rule = handoff ? checkoutRule(handoff) : '';
    if (await port.ask(mergeAllConfirmation(this.target(), rule, port.isExecuting())) !== 'merge') return false;
    return this.merge();
  }

  /**
   * Merge all once the surface asked the opening question itself, in a dialog
   * that says more than ours (the Changes view's preflight, ADR-0062 G8). The
   * questions the seam asks after that are still asked here.
   */
  confirmed(): Promise<boolean> {
    return this.merge();
  }

  private target(): string {
    const handoff = this.port.handoff();
    return handoff ? mergeTarget(handoff) : 'the branch you have checked out';
  }

  private async merge(): Promise<boolean> {
    const call = this.port.mergeCall();
    const target = this.target();
    const yes: MergeYes = {};
    for (;;) {
      const answer = await call({ ...yes });
      if (answer.kind === 'done') return true;
      // Asked again after a yes it already has: not a question a person can settle, so it is the seam's refusal.
      if (yes[answer.hold]) throw new Error(answer.message);
      if (await this.port.ask(HELD_QUESTIONS[answer.hold](answer.message, target)) !== 'merge') return false;
      yes[answer.hold] = true;
    }
  }
}

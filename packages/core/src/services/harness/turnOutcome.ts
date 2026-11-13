import type { AgentEvent } from './AgentAdapter';

/** What a runner's own end signal said of its turn, before an interrupt Ordewell asked for is weighed. */
export type RunnerSaid = 'completed' | 'interrupted';

/** The turn's own failure, in the runner's words: the abort an interrupt causes is not one. */
export type TurnError = Omit<Extract<AgentEvent, { type: 'error' }>, 'type'>;

/** The event that ends a turn. */
export type TurnEnding = Extract<AgentEvent, { type: 'turn_end' } | { type: 'error' }>;

/**
 * How a turn ends once an interrupt may have been asked for (ADR-0018 W1).
 * Every runner's end signal can race the interrupt: the model finishes as the
 * request lands, or the runner names no status at all. The rule is one for
 * all of them, so the completion reminder never follows a user's interrupt on
 * one runner and not another: an interrupt asked for and not refused ends the
 * turn interrupted, whatever the runner said, and only an error of the turn's
 * own outranks it, since a usage limit or a signed-out account is still owed.
 * The verdict is not touched: it comes from `task_complete` alone.
 */
export class TurnOutcome {
  private interruptRequested = false;

  /** A turn opens with nothing asked of it: a request belongs to the turn it was made in. */
  open(): void {
    this.interruptRequested = false;
  }

  request(): void {
    this.interruptRequested = true;
  }

  /** The runner refused the interrupt, which then stopped nothing and must not colour the turn's end. */
  refused(): void {
    this.interruptRequested = false;
  }

  /** Whether an interrupt is asked for in the turn running now and was not refused. */
  get requested(): boolean {
    return this.interruptRequested;
  }

  /** The turn's ending, from what the runner said of it; the request goes with the turn. */
  settle(runnerSaid: RunnerSaid, error?: TurnError): TurnEnding {
    const interrupted = runnerSaid === 'interrupted' || this.interruptRequested;
    this.interruptRequested = false;
    if (error) return { type: 'error', ...error };
    return interrupted ? { type: 'turn_end', interrupted: true } : { type: 'turn_end' };
  }
}

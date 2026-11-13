const FIRST_MS = 500;
const MOST_MS = 8_000;

/**
 * How long a surface waits before following a daemon socket again, one
 * policy for every surface: soon after a drop, since a daemon that closed
 * one socket is usually still there, then backing off while it stays away
 * so a socket it keeps refusing is not asked for in a loop.
 */
export class ReconnectBackoff {
  private failures = 0;

  /** Attempts that failed since the last success: zero is the start of an outage, the moment to say so once. */
  get failed(): number {
    return this.failures;
  }

  /** The wait before the next attempt, counting the one that just failed. */
  next(): number {
    const delay = Math.min(FIRST_MS * 2 ** Math.min(this.failures, 4), MOST_MS);
    this.failures += 1;
    return delay;
  }

  /** The socket is followed again. */
  reset(): void {
    this.failures = 0;
  }
}

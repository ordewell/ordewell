import type { ConfirmDifference, DaemonErrorCode, ErrorBody, LandingBranchHeld } from '../daemonContract';
import type { PlannerNotReady } from '../services/plannerReadiness';
import type { SessionHeld } from '../services/sessionLease';
import type { CommandPayload } from '../services/ExecutionCommands';

/**
 * What a client throws for a non-2xx answer: the daemon's `ErrorBody` read once,
 * so a CLI and a desktop window flatten it the same way and a caller reads
 * `sessionHeld` or `confirmStale` as typed fields instead of casting them out
 * of a body. The message is for display only: nothing may branch on its text,
 * only on `code`.
 */
export class DaemonRefusal extends Error {
  constructor(
    message: string,
    /** Absent when no response came back at all (a desktop call the bridge could not deliver). */
    readonly status?: number,
    readonly fields: Omit<ErrorBody, 'error'> = {},
  ) {
    super(message);
    this.name = 'DaemonRefusal';
  }

  get code(): DaemonErrorCode | undefined { return this.fields.code; }
  get workspace(): string | undefined { return this.fields.workspace; }
  get plannerNotReady(): PlannerNotReady | undefined { return this.fields.plannerNotReady; }
  /** With `session_held`: the host that runs the session (ADR-0049). */
  get sessionHeld(): SessionHeld | undefined { return this.fields.sessionHeld; }
  /** With `landing_branch_held`: the live run that lands on the branch (ADR-0062 G7). */
  get landingBranchHeld(): LandingBranchHeld | undefined { return this.fields.landingBranchHeld; }
  /** With `confirm_stale`: what the person was shown against what is there now (ADR-0062 G3). */
  get confirmStale(): ConfirmDifference | undefined { return this.fields.confirmStale; }
  /** On a command the seam refused after the act ran and stopped. */
  get payload(): CommandPayload | undefined { return this.fields.payload; }
}

/**
 * A non-2xx answer as a {@link DaemonRefusal}. The body is not trusted to be an
 * `ErrorBody`: a proxy's HTML error page arrives as a string, and then the
 * status and `fallback` are all there is. The daemon's own `error` wins over
 * `fallback`, since a refusal is the seam's sentence and that is what is shown.
 */
export function refusalOf(status: number | undefined, data: unknown, fallback: string): DaemonRefusal {
  const { error, ...fields } = (typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {}) as Partial<ErrorBody>;
  return new DaemonRefusal(typeof error === 'string' && error ? error : fallback, status, fields);
}

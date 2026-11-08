import type { RouteBody, RouteResponse } from '@ordewell/core/plan-utils';
import type { RouteId, RouteParams } from '../../shared/routes';

/** A daemon's refusal or a request that never got an answer, worded as the daemon worded it. */
export class DaemonError extends Error {
  /** `body` is the daemon's whole answer, for a refusal that carries more than its sentence (a held session's holder). */
  constructor(message: string, readonly status?: number, readonly code?: string, readonly body?: unknown) {
    super(message);
    this.name = 'DaemonError';
  }
}

function field(data: unknown, key: string): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value: unknown = Reflect.get(data, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * One call to the daemon through main's allowlist, answered with its JSON or
 * thrown as a {@link DaemonError}. The daemon's own `error` wins over main's
 * summary of it: a refusal is the seam's sentence, and that is what is shown.
 *
 * The body and the answer are the route row's own types (core's `DAEMON_ROUTES`),
 * so a caller neither casts the answer nor sends a body the daemon would not read.
 * The route is still only an id: main turns it into a path (ADR-0063 H4).
 */
export async function callDaemon<Id extends RouteId>(route: Id, params?: RouteParams, body?: RouteBody<Id>): Promise<RouteResponse<Id>> {
  const result = await window.ordewell.daemon.call(route, params, body);
  // The bridge hands back JSON it did not parse into a type; the table is what says which type this id answers with.
  if (result.ok) return result.data as RouteResponse<Id>;
  throw new DaemonError(field(result.data, 'error') ?? result.error, result.status, field(result.data, 'code'), result.data);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

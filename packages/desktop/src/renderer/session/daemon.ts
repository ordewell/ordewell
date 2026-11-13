import { refusalOf, type RouteBody, type RouteResponse } from '@ordewell/core/plan-utils';
import type { RouteId, RouteParams } from '../../shared/routes';

/**
 * One call to the daemon through main's allowlist, answered with its JSON or
 * thrown as a `DaemonRefusal`. The daemon's own `error` wins over main's
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
  throw refusalOf(result.status, result.data, result.error);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

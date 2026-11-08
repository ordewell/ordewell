import { DAEMON_ROUTES } from '@ordewell/core';
import type { DaemonRouteId, RouteBody, RouteSpec } from '@ordewell/core';

/**
 * Where a call to a daemon route goes, from the route's row in core's
 * `DAEMON_ROUTES` (ADR-0063 H4, ADR-0006 S3): the one place a path parameter is
 * encoded and a query is written, so a client never joins a URL by hand.
 */

type Rows = typeof DAEMON_ROUTES;

/** The `:name` parameters of a path template. */
type ParamNames<Path extends string> =
  Path extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<Rest>
    : Path extends `${string}:${infer Name}` ? Name
      : never;

type PathParamsOf<Id extends DaemonRouteId> = Record<ParamNames<Rows[Id]['path']>, string>;

/** The query parameters the route's row lists. */
export type QueryKeys<Id extends DaemonRouteId> = Rows[Id] extends { query: readonly (infer Key extends string)[] } ? Key : never;

type QueryOf<Id extends DaemonRouteId> = { [Key in QueryKeys<Id>]?: string | undefined };

type NeedsParams<Id extends DaemonRouteId> = [ParamNames<Rows[Id]['path']>] extends [never] ? false : true;

/** What a call supplies beyond its route id: the row says which of these it takes, and the body's type. */
export type CallParts<Id extends DaemonRouteId> =
  (NeedsParams<Id> extends true ? { params: PathParamsOf<Id> } : { params?: undefined })
  & { query?: QueryOf<Id> }
  & (undefined extends RouteBody<Id> ? { body?: RouteBody<Id> } : { body: RouteBody<Id> });

/** A request ready to send: the row's method and flags, the path with its query, the body. */
export interface RouteRequest {
  method: RouteSpec['method'];
  path: string;
  body?: object;
  turn: boolean;
}

/** One path segment, or the reason it is not one: `.` and `..` survive encoding and a URL parser would resolve them. */
function segment(route: string, name: string, value: string): string {
  if (value === '' || value === '.' || value === '..') throw new TypeError(`${route}: ${name} is not a path segment`);
  return encodeURIComponent(value);
}

/**
 * The path of `spec` with `params` filled in as one encoded segment each, and
 * `query` after it, in the order given: a value left `undefined` is not sent,
 * and a key the row does not list is a bug here, not something to send.
 */
export function routePath(
  route: string,
  spec: RouteSpec,
  params: Readonly<Record<string, string>> = {},
  query: Readonly<Record<string, string | undefined>> = {},
): string {
  const path = spec.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new TypeError(`${route}: ${name} is missing`);
    return segment(route, name, value);
  });
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (!spec.query?.includes(key)) throw new TypeError(`${route}: ${key} is not a query parameter of the route`);
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return pairs.length > 0 ? `${path}?${pairs.join('&')}` : path;
}

/**
 * A session socket's path, or a child plan's through its root, each id one
 * encoded segment as a route's are. The sockets have no row in the route
 * table, and a raw id with `#` would not open, one with `?` or `/` would
 * follow another session. Named with its workspace, a socket hears only that
 * project's session of the id.
 */
export function socketPath(sessionId: string, childId?: string, workspace?: string): string {
  const root = `/ws/session/${segment('session socket', 'sessionId', sessionId)}`;
  const path = childId === undefined ? root : `${root}/child/${segment('child socket', 'childId', childId)}`;
  return workspace === undefined ? path : `${path}?workspace=${encodeURIComponent(workspace)}`;
}

/**
 * The request a call to route `id` makes. A live row is sent with the
 * workspace it is asked from, the body's when it names one, else `workspace`:
 * the daemon keeps one session per id and refuses one another project holds,
 * which it can only tell from a call that says whose it means.
 */
export function routeRequest<Id extends DaemonRouteId>(id: Id, parts: CallParts<Id>, workspace?: string): RouteRequest {
  const spec: RouteSpec = DAEMON_ROUTES[id];
  const query: Record<string, string | undefined> = { ...parts.query };
  if (spec.live !== undefined && spec.query?.includes('workspace') && query.workspace === undefined) {
    const named = (parts.body as { workspace?: unknown } | undefined)?.workspace;
    query.workspace = typeof named === 'string' && named !== '' ? named : workspace;
  }
  return {
    method: spec.method,
    path: routePath(id, spec, parts.params, query),
    ...(parts.body !== undefined ? { body: parts.body as object } : {}),
    turn: spec.turn === true,
  };
}

/** The session whose live host answers a request to a session-scoped route, taken from the route's own parameter. */
export function sessionOf<Id extends DaemonRouteId>(id: Id, params: Readonly<Record<string, string>> | undefined): string | undefined {
  const spec: RouteSpec = DAEMON_ROUTES[id];
  const name = /^\/api\/(?:plans|sessions)\/:(id|sessionId)(?:\/|$)/.exec(spec.path)?.[1];
  return name ? params?.[name] : undefined;
}

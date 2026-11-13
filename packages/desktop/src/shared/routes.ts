/**
 * The only daemon requests the renderer can cause. It names a route id from
 * this table with its parameters; main builds the method, path and query from
 * the row and adds the bearer itself (ADR-0063 H4). A URL, a header or a method
 * never crosses the bridge, so a compromised renderer can reach these routes
 * and nothing else the daemon serves.
 *
 * Pure: no Electron, no Node. The renderer imports the ids for its types.
 */

import { DAEMON_ROUTES, type DaemonRouteId, type HttpMethod, type RouteSpec } from '@ordewell/core/plan-utils';

export type { HttpMethod };

// Picked by id rather than taken whole: a route the daemon adds stays out of
// the renderer's reach until a view needs it and it is named here.
const RENDERER_ROUTES = [
  'server.info',

  'workspaces.list',
  'workspaces.isolationPreview',

  'sessions.list',
  'sessions.get',
  'sessions.load',
  'sessions.close',
  'sessions.delete',
  'sessions.taskLog',
  'sessions.taskLogAttempt',

  'children.list',
  'children.get',
  'children.taskLog',
  'children.taskLogAttempt',
  'children.message',
  'children.taskMessage',

  'plans.generate',
  'plans.execute',
  'plans.stop',
  'plans.stopPlanning',
  'plans.executeCommand',
  'plans.escalations',
  'plans.answerEscalation',
  'plans.taskCommands',
  'plans.mergeGate',
  'plans.revertPreview',
  'plans.isolationDiff',
  'plans.taskDiff',
  'plans.mergePreflight',
  'plans.isolationMerge',
  'plans.isolationDiscard',
  'plans.isolationCleanup',
  'plans.isolationStash',
  'plans.isolationRunWithout',
  'plans.checkpointApprove',
  'plans.checkpointReject',
  'plans.resolveConflict',
  'plans.addTask',
  'plans.cardEdit',
  'plans.updateTask',
  'plans.deleteTask',
  'plans.approveReview',
  'plans.converseStart',
  'plans.converseMessage',
  'plans.converseMessageNow',
  'plans.cancelResend',
  'plans.fork',
  'plans.rewindTargets',
  'plans.rewind',
  'plans.compact',
  'plans.retryCompact',
  'plans.prd',

  'approvals.list',
  'approvals.decide',

  'models.list',

  'runners.list',
  'runners.setEnabled',

  'files.tree',
  'files.content',
  'files.find',
  'files.save',

  'git.repos',
  'git.status',
  // Read by main, to find the worktree a task's terminal opens in.
  'git.branches',
  'git.diff',
  // Merge all's preflight sets the user's overlapping files aside and offers them back (ADR-0062 G8).
  'git.stash',
  'git.stashPop',
  // The Git view (ADR-0062): history to draw, and the actions on the user's checkout of one repository.
  'git.log',
  'git.show',
  'git.branch',
  'git.switch',
  'git.branchDelete',
  'git.stashDrop',
  'git.fetch',
  'git.pull',
  'git.push',
  // The user's own actions on their checkout (ADR-0062 G1-G5): the Changes activity's checkout group.
  'git.stage',
  'git.unstage',
  'git.commit',
  'git.discard',

  'settings.get',
  'settings.update',
  'settings.containers',
  'settings.updateContainers',
] as const satisfies readonly DaemonRouteId[];

// Each row is core's own (`DAEMON_ROUTES`), which the daemon's routers are
// checked against, so the path, query and flags here cannot drift from theirs.
export const ROUTES = Object.fromEntries(RENDERER_ROUTES.map((id) => [id, DAEMON_ROUTES[id]])) as {
  readonly [Id in (typeof RENDERER_ROUTES)[number]]: (typeof DAEMON_ROUTES)[Id];
};

export type RouteId = keyof typeof ROUTES;

export type RouteParams = Readonly<Record<string, string>>;

/** What main sends: never anything the renderer wrote verbatim but the encoded segments, query values and JSON body. */
export interface DaemonRequest {
  method: HttpMethod;
  /** Path and query, already encoded. */
  path: string;
  /** JSON text; absent when the call carried no body. */
  body?: string;
  /** A planner turn, which main waits on with no idle bound. */
  turn?: true;
}

export type BuildResult = { ok: true; request: DaemonRequest } | { ok: false; error: string };

export function isRouteId(value: unknown): value is RouteId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROUTES, value);
}

/**
 * One path segment, or the reason it is not one. Encoding alone would turn a
 * `/` into `%2F`, but `.` and `..` survive it and a router may still resolve
 * them, so they are refused outright, with the empty segment that would fold
 * two path components into one.
 */
export function segmentError(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'is not a string';
  if (value === '' || value === '.' || value === '..') return 'is not a path segment';
  if (/[/\\]/.test(value)) return 'is not a single path segment';
  // A control character has no business in an id, and some servers split on one.
  if ([...value].some((ch) => { const code = ch.charCodeAt(0); return code < 0x20 || code === 0x7f; })) return 'has a control character';
  return undefined;
}

/** Turn a route id, its params and an optional body into a request, or refuse it. */
export function buildRequest(routeId: unknown, params: unknown, body?: unknown): BuildResult {
  if (!isRouteId(routeId)) return { ok: false, error: `unknown route ${JSON.stringify(routeId)}` };
  const spec: RouteSpec = ROUTES[routeId];
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return { ok: false, error: `${routeId}: params must be an object` };
  }
  const given = new Map(Object.entries((params ?? {}) as Record<string, unknown>));

  const pathNames = new Set<string>();
  let failure: string | undefined;
  const path = spec.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    pathNames.add(name);
    const value = given.get(name);
    const problem = value === undefined ? 'is missing' : segmentError(value);
    if (problem) failure ??= `${routeId}: ${name} ${problem}`;
    return encodeURIComponent(String(value ?? ''));
  });
  if (failure) return { ok: false, error: failure };

  const allowedQuery = new Set<string>(spec.query ?? []);
  const query = new URLSearchParams();
  for (const [name, value] of given) {
    if (pathNames.has(name)) continue;
    if (!allowedQuery.has(name)) return { ok: false, error: `${routeId}: unknown param ${name}` };
    if (value === undefined) continue;
    if (typeof value !== 'string') return { ok: false, error: `${routeId}: ${name} is not a string` };
    query.set(name, value);
  }
  const search = query.toString();

  if (body !== undefined && spec.method === 'GET') return { ok: false, error: `${routeId}: a GET carries no body` };
  let text: string | undefined;
  if (body !== undefined) {
    try {
      text = JSON.stringify(body);
    } catch {
      return { ok: false, error: `${routeId}: the body is not JSON` };
    }
  }

  return {
    ok: true,
    request: {
      method: spec.method,
      path: search ? `${path}?${search}` : path,
      ...(text !== undefined ? { body: text } : {}),
      ...(spec.turn ? { turn: true } : {}),
    },
  };
}

/** The session a call belongs to when its live host must answer it, read from the route's own path param. */
export function liveSessionOf(routeId: unknown, params: unknown): string | undefined {
  if (!isRouteId(routeId) || typeof params !== 'object' || params === null) return undefined;
  const spec: RouteSpec = ROUTES[routeId];
  if (!spec.live) return undefined;
  const value: unknown = Reflect.get(params, spec.live);
  return typeof value === 'string' ? value : undefined;
}

/**
 * `params` naming the window's workspace on a live row that lists one and was
 * given none. The daemon keeps one session per id and refuses one another
 * project holds, which it can only tell from a call that says whose it means.
 */
export function namingWorkspace(routeId: unknown, params: unknown, workspace: string | undefined): unknown {
  if (workspace === undefined || liveSessionOf(routeId, params) === undefined) return params;
  const spec: RouteSpec = ROUTES[routeId as RouteId];
  if (!spec.query?.includes('workspace') || Reflect.get(params as object, 'workspace') !== undefined) return params;
  return { ...(params as object), workspace };
}

/** A socket's query: named with its workspace, it hears only that project's session of the id. */
const streamQuery = (workspace: string | undefined): string => (workspace === undefined ? '' : `?workspace=${encodeURIComponent(workspace)}`);

/** The session socket's path, its id checked as one segment like any route's. */
export function sessionStreamPath(sessionId: unknown, workspace?: string): BuildResult {
  const problem = segmentError(sessionId);
  if (problem) return { ok: false, error: `sessionId ${problem}` };
  return { ok: true, request: { method: 'GET', path: `/ws/session/${encodeURIComponent(sessionId as string)}${streamQuery(workspace)}` } };
}

export function childStreamPath(rootId: unknown, childId: unknown, workspace?: string): BuildResult {
  const rootProblem = segmentError(rootId);
  if (rootProblem) return { ok: false, error: `rootId ${rootProblem}` };
  const childProblem = segmentError(childId);
  if (childProblem) return { ok: false, error: `childId ${childProblem}` };
  return {
    ok: true,
    request: {
      method: 'GET',
      path: `/ws/session/${encodeURIComponent(rootId as string)}/child/${encodeURIComponent(childId as string)}${streamQuery(workspace)}`,
    },
  };
}

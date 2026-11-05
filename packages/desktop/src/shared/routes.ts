/**
 * The only daemon requests the renderer can cause. It names a route id from
 * this table with its parameters; main builds the method, path and query from
 * the row and adds the bearer itself (ADR-0060 H4). A URL, a header or a method
 * never crosses the bridge, so a compromised renderer can reach these routes
 * and nothing else the daemon serves.
 *
 * Pure: no Electron, no Node. The renderer imports the ids for its types.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RouteSpec {
  method: HttpMethod;
  /** `:name` marks a path parameter, filled from the same-named param as one segment. */
  path: string;
  /** Query parameters the route reads; any other param is refused. */
  query?: readonly string[];
  /**
   * A planner turn: the daemon answers when the turn ends, which can be long
   * after the socket last carried a byte, so main sets it no idle bound. The
   * turn's progress reaches the view over the session socket meanwhile.
   */
  turn?: true;
  /**
   * The path param naming a session whose live host answers this route. For
   * a session the window joined, main sends it to the holder's daemon
   * (ADR-0060 H8); anything else, and every route without it, stays on the
   * app's own daemon: files, git, the catalog, and opening, closing or
   * deleting a session here.
   */
  live?: 'id' | 'sessionId';
}

const WS = ['workspace'] as const;
/** What the file read routes take to pick the tree (ADR-0061 R2): the repo and the view scope. */
const AT = ['workspace', 'repo', 'scope', 'sessionId', 'taskId'] as const;

// Rows follow the daemon's routers in packages/web/server/routes, named
// `area.verb` as the design's Daemon routes table does.
export const ROUTES = {
  'server.info': { method: 'GET', path: '/api/server' },

  'workspaces.list': { method: 'GET', path: '/api/workspaces' },
  'workspaces.isolationPreview': { method: 'GET', path: '/api/workspaces/isolation-preview', query: WS },

  'sessions.list': { method: 'GET', path: '/api/sessions', query: WS },
  'sessions.get': { method: 'GET', path: '/api/sessions/:id', query: WS, live: 'id' },
  'sessions.load': { method: 'POST', path: '/api/sessions/:id/load', query: WS },
  'sessions.close': { method: 'POST', path: '/api/sessions/:id/close', query: WS },
  'sessions.delete': { method: 'DELETE', path: '/api/sessions/:id', query: WS },
  'sessions.taskLog': { method: 'GET', path: '/api/sessions/:id/tasks/:taskId/log', query: WS, live: 'id' },
  'sessions.taskLogAttempt': { method: 'GET', path: '/api/sessions/:id/tasks/:taskId/log/:attempt', query: WS, live: 'id' },

  'children.list': { method: 'GET', path: '/api/sessions/:id/children', live: 'id' },
  'children.get': { method: 'GET', path: '/api/sessions/:id/children/:childId', live: 'id' },
  'children.taskLog': { method: 'GET', path: '/api/sessions/:id/children/:childId/tasks/:taskId/log', live: 'id' },
  'children.taskLogAttempt': { method: 'GET', path: '/api/sessions/:id/children/:childId/tasks/:taskId/log/:attempt', live: 'id' },
  'children.message': { method: 'POST', path: '/api/sessions/:id/children/:childId/message', live: 'id' },
  'children.taskMessage': { method: 'POST', path: '/api/sessions/:id/children/:childId/tasks/:taskId/message', live: 'id' },

  'plans.generate': { method: 'POST', path: '/api/plans/:sessionId/generate', query: ['workspace', 'runners'], turn: true, live: 'sessionId' },
  'plans.execute': { method: 'POST', path: '/api/plans/:sessionId/execute', live: 'sessionId' },
  'plans.stop': { method: 'POST', path: '/api/plans/:sessionId/stop', live: 'sessionId' },
  'plans.stopPlanning': { method: 'POST', path: '/api/plans/:sessionId/planning/stop', live: 'sessionId' },
  'plans.executeCommand': { method: 'POST', path: '/api/plans/:sessionId/execute-command', live: 'sessionId' },
  'plans.escalations': { method: 'GET', path: '/api/plans/:sessionId/escalations', live: 'sessionId' },
  'plans.answerEscalation': { method: 'POST', path: '/api/plans/:sessionId/escalations/answer', live: 'sessionId' },
  'plans.taskCommands': { method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/commands', live: 'sessionId' },
  'plans.mergeGate': { method: 'GET', path: '/api/plans/:sessionId/tasks/:taskId/merge-gate', live: 'sessionId' },
  'plans.revertPreview': { method: 'GET', path: '/api/plans/:sessionId/tasks/:taskId/revert-preview', live: 'sessionId' },
  'plans.isolationDiff': { method: 'GET', path: '/api/plans/:sessionId/isolation/diff', live: 'sessionId' },
  // Reads of the saved run (ADR-0061, ADR-0062 G8): neither needs the session open here.
  'plans.taskDiff': { method: 'GET', path: '/api/plans/:sessionId/tasks/:taskId/diff', query: ['workspace', 'repo', 'path', 'names'], live: 'sessionId' },
  'plans.mergePreflight': { method: 'GET', path: '/api/plans/:sessionId/isolation/merge-preflight', query: WS, live: 'sessionId' },
  'plans.isolationMerge': { method: 'POST', path: '/api/plans/:sessionId/isolation/merge', live: 'sessionId' },
  'plans.isolationDiscard': { method: 'POST', path: '/api/plans/:sessionId/isolation/discard', live: 'sessionId' },
  'plans.isolationCleanup': { method: 'POST', path: '/api/plans/:sessionId/isolation/cleanup', live: 'sessionId' },
  'plans.isolationStash': { method: 'POST', path: '/api/plans/:sessionId/isolation/stash-and-continue', live: 'sessionId' },
  'plans.isolationRunWithout': { method: 'POST', path: '/api/plans/:sessionId/isolation/run-without', live: 'sessionId' },
  'plans.checkpointApprove': { method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/checkpoint/approve', live: 'sessionId' },
  'plans.checkpointReject': { method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/checkpoint/reject', live: 'sessionId' },
  'plans.resolveConflict': { method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/resolve-conflict', live: 'sessionId' },
  'plans.addTask': { method: 'POST', path: '/api/plans/:sessionId/tasks', live: 'sessionId' },
  'plans.updateTask': { method: 'PUT', path: '/api/plans/:sessionId/tasks/:taskId', live: 'sessionId' },
  'plans.deleteTask': { method: 'DELETE', path: '/api/plans/:sessionId/tasks/:taskId', live: 'sessionId' },
  'plans.approveReview': { method: 'POST', path: '/api/plans/:sessionId/review/approve', live: 'sessionId' },
  'plans.converseStart': { method: 'POST', path: '/api/plans/:sessionId/converse/start', query: WS, turn: true, live: 'sessionId' },
  'plans.converseMessage': { method: 'POST', path: '/api/plans/:sessionId/converse/message', turn: true, live: 'sessionId' },
  'plans.converseMessageNow': { method: 'POST', path: '/api/plans/:sessionId/converse/message/now', turn: true, live: 'sessionId' },
  'plans.cancelResend': { method: 'POST', path: '/api/plans/:sessionId/converse/resend/cancel', live: 'sessionId' },
  'plans.fork': { method: 'POST', path: '/api/plans/:sessionId/conversation/fork', live: 'sessionId' },
  'plans.rewindTargets': { method: 'GET', path: '/api/plans/:sessionId/conversation/rewind-targets', live: 'sessionId' },
  'plans.rewind': { method: 'POST', path: '/api/plans/:sessionId/conversation/rewind', live: 'sessionId' },
  'plans.compact': { method: 'POST', path: '/api/plans/:sessionId/conversation/compact', turn: true, live: 'sessionId' },
  'plans.retryCompact': { method: 'POST', path: '/api/plans/:sessionId/conversation/compact/retry', turn: true, live: 'sessionId' },
  'plans.prd': { method: 'GET', path: '/api/plans/:sessionId/prd', live: 'sessionId' },

  'approvals.list': { method: 'GET', path: '/api/approvals/:sessionId', live: 'sessionId' },
  'approvals.decide': { method: 'POST', path: '/api/approvals/:sessionId/:approvalId', live: 'sessionId' },

  'commands.list': { method: 'GET', path: '/api/commands' },
  'commands.run': { method: 'POST', path: '/api/commands/:name' },

  'models.list': { method: 'GET', path: '/api/models', query: WS },

  'runners.list': { method: 'GET', path: '/api/runners', query: WS },
  'runners.setEnabled': { method: 'PUT', path: '/api/runners/:id' },

  'files.tree': { method: 'GET', path: '/api/files/tree', query: [...AT, 'dir'] },
  'files.content': { method: 'GET', path: '/api/files/content', query: [...AT, 'path'] },
  'files.find': { method: 'GET', path: '/api/files/find', query: [...AT, 'query', 'text', 'limit'] },
  'files.save': { method: 'PUT', path: '/api/files/content' },

  'git.repos': { method: 'GET', path: '/api/git/repos', query: WS },
  'git.status': { method: 'GET', path: '/api/git/status', query: [...WS, 'repo', 'scope'] },
  // Read by main, to find the worktree a task's terminal opens in.
  'git.branches': { method: 'GET', path: '/api/git/branches', query: AT },
  'git.diff': { method: 'GET', path: '/api/git/diff', query: [...AT, 'kind', 'from', 'to', 'path'] },
  // Merge all's preflight sets the user's overlapping files aside and offers them back (ADR-0062 G8).
  'git.stash': { method: 'POST', path: '/api/git/stash' },
  'git.stashPop': { method: 'POST', path: '/api/git/stash-pop' },
  // The Git view (ADR-0062): history to draw, and the actions on the user's checkout of one repository.
  'git.log': { method: 'GET', path: '/api/git/log', query: [...AT, 'ref', 'cursor', 'limit'] },
  // `git.show` reads a commit, leaving `git.commit` free for the POST that makes one.
  'git.show': { method: 'GET', path: '/api/git/commit', query: [...AT, 'sha', 'path'] },
  'git.branch': { method: 'POST', path: '/api/git/branch' },
  'git.switch': { method: 'POST', path: '/api/git/switch' },
  'git.branchDelete': { method: 'POST', path: '/api/git/branch-delete' },
  'git.stashDrop': { method: 'POST', path: '/api/git/stash-drop' },
  'git.fetch': { method: 'POST', path: '/api/git/fetch' },
  'git.pull': { method: 'POST', path: '/api/git/pull' },
  'git.push': { method: 'POST', path: '/api/git/push' },
  // The user's own actions on their checkout (ADR-0062 G1-G5): the Changes activity's checkout group.
  'git.stage': { method: 'POST', path: '/api/git/stage' },
  'git.unstage': { method: 'POST', path: '/api/git/unstage' },
  'git.commit': { method: 'POST', path: '/api/git/commit' },
  'git.discard': { method: 'POST', path: '/api/git/discard' },

  'settings.get': { method: 'GET', path: '/api/settings', query: ['workspace', 'sessionId'] },
  'settings.update': { method: 'PATCH', path: '/api/settings' },
  'settings.containers': { method: 'GET', path: '/api/settings/containers', query: ['workspace', 'prove'] },
  'settings.updateContainers': { method: 'PATCH', path: '/api/settings/containers', query: WS },
} as const satisfies Record<string, RouteSpec>;

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

/** The session socket's path, its id checked as one segment like any route's. */
export function sessionStreamPath(sessionId: unknown): BuildResult {
  const problem = segmentError(sessionId);
  if (problem) return { ok: false, error: `sessionId ${problem}` };
  return { ok: true, request: { method: 'GET', path: `/ws/session/${encodeURIComponent(sessionId as string)}` } };
}

export function childStreamPath(rootId: unknown, childId: unknown): BuildResult {
  const rootProblem = segmentError(rootId);
  if (rootProblem) return { ok: false, error: `rootId ${rootProblem}` };
  const childProblem = segmentError(childId);
  if (childProblem) return { ok: false, error: `childId ${childProblem}` };
  return {
    ok: true,
    request: {
      method: 'GET',
      path: `/ws/session/${encodeURIComponent(rootId as string)}/child/${encodeURIComponent(childId as string)}`,
    },
  };
}

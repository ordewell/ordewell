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
  'sessions.get': { method: 'GET', path: '/api/sessions/:id', query: WS },
  'sessions.load': { method: 'POST', path: '/api/sessions/:id/load', query: WS },
  'sessions.close': { method: 'POST', path: '/api/sessions/:id/close', query: WS },
  'sessions.delete': { method: 'DELETE', path: '/api/sessions/:id', query: WS },
  'sessions.taskLog': { method: 'GET', path: '/api/sessions/:id/tasks/:taskId/log', query: WS },
  'sessions.taskLogAttempt': { method: 'GET', path: '/api/sessions/:id/tasks/:taskId/log/:attempt', query: WS },

  'children.list': { method: 'GET', path: '/api/sessions/:id/children' },
  'children.get': { method: 'GET', path: '/api/sessions/:id/children/:childId' },
  'children.taskLog': { method: 'GET', path: '/api/sessions/:id/children/:childId/tasks/:taskId/log' },
  'children.taskLogAttempt': { method: 'GET', path: '/api/sessions/:id/children/:childId/tasks/:taskId/log/:attempt' },
  'children.message': { method: 'POST', path: '/api/sessions/:id/children/:childId/message' },
  'children.taskMessage': { method: 'POST', path: '/api/sessions/:id/children/:childId/tasks/:taskId/message' },

  'plans.generate': { method: 'POST', path: '/api/plans/:sessionId/generate', query: ['workspace', 'runners'] },
  'plans.execute': { method: 'POST', path: '/api/plans/:sessionId/execute' },
  'plans.stop': { method: 'POST', path: '/api/plans/:sessionId/stop' },
  'plans.stopPlanning': { method: 'POST', path: '/api/plans/:sessionId/planning/stop' },
  'plans.executeCommand': { method: 'POST', path: '/api/plans/:sessionId/execute-command' },
  'plans.escalations': { method: 'GET', path: '/api/plans/:sessionId/escalations' },
  'plans.answerEscalation': { method: 'POST', path: '/api/plans/:sessionId/escalations/answer' },
  'plans.taskCommands': { method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/commands' },
  'plans.mergeGate': { method: 'GET', path: '/api/plans/:sessionId/tasks/:taskId/merge-gate' },
  'plans.revertPreview': { method: 'GET', path: '/api/plans/:sessionId/tasks/:taskId/revert-preview' },
  'plans.isolationDiff': { method: 'GET', path: '/api/plans/:sessionId/isolation/diff' },
  'plans.isolationMerge': { method: 'POST', path: '/api/plans/:sessionId/isolation/merge' },
  'plans.resolveConflict': { method: 'POST', path: '/api/plans/:sessionId/tasks/:taskId/resolve-conflict' },
  'plans.addTask': { method: 'POST', path: '/api/plans/:sessionId/tasks' },
  'plans.updateTask': { method: 'PUT', path: '/api/plans/:sessionId/tasks/:taskId' },
  'plans.deleteTask': { method: 'DELETE', path: '/api/plans/:sessionId/tasks/:taskId' },
  'plans.approveReview': { method: 'POST', path: '/api/plans/:sessionId/review/approve' },
  'plans.converseStart': { method: 'POST', path: '/api/plans/:sessionId/converse/start', query: WS },
  'plans.converseMessage': { method: 'POST', path: '/api/plans/:sessionId/converse/message' },
  'plans.converseMessageNow': { method: 'POST', path: '/api/plans/:sessionId/converse/message/now' },
  'plans.cancelResend': { method: 'POST', path: '/api/plans/:sessionId/converse/resend/cancel' },
  'plans.fork': { method: 'POST', path: '/api/plans/:sessionId/conversation/fork' },
  'plans.rewindTargets': { method: 'GET', path: '/api/plans/:sessionId/conversation/rewind-targets' },
  'plans.rewind': { method: 'POST', path: '/api/plans/:sessionId/conversation/rewind' },
  'plans.compact': { method: 'POST', path: '/api/plans/:sessionId/conversation/compact' },
  'plans.retryCompact': { method: 'POST', path: '/api/plans/:sessionId/conversation/compact/retry' },
  'plans.prd': { method: 'GET', path: '/api/plans/:sessionId/prd' },

  'approvals.list': { method: 'GET', path: '/api/approvals/:sessionId' },
  'approvals.decide': { method: 'POST', path: '/api/approvals/:sessionId/:approvalId' },

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
  // Read by main, to find the worktree a task's terminal opens in.
  'git.branches': { method: 'GET', path: '/api/git/branches', query: AT },

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
    request: { method: spec.method, path: search ? `${path}?${search}` : path, ...(text !== undefined ? { body: text } : {}) },
  };
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

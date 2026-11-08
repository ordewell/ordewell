import type { Context, MiddlewareHandler } from 'hono';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { failure } from './errors';

/**
 * The workspace a request names, for every pool lookup its handler makes. A
 * caller naming none reaches a session by its id alone, as before workspaces
 * were checked.
 */
export function callerWorkspace(c: Context): string | undefined {
  return c.req.query('workspace') || undefined;
}

/**
 * Every route under a session id reaches the live session through
 * `pool.live` with the workspace the client names, before its handler runs.
 * The pool keeps one session per id, so a request from another project's copy
 * of the id would otherwise read, drive or replace the project holding it; one
 * guard on the whole router also covers a route added after this one.
 *
 * It is judged once, before the handler reads a body or awaits anything, so it
 * is the early answer and not the safeguard: a handler passes
 * {@link callerWorkspace} to the lookup it acts through, at the point it acts.
 */
export function sameWorkspace(pool: OrchestratorPool, param: 'id' | 'sessionId'): MiddlewareHandler {
  return async (c, next) => {
    const workspace = callerWorkspace(c);
    if (workspace) {
      try {
        pool.live(c.req.param(param) ?? '', workspace);
      } catch (err) {
        return failure(c, err, 'reach session');
      }
    }
    await next();
  };
}

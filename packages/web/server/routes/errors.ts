import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  AlreadyExecutingError,
  ConversationBusyError,
  ConversationEditError,
  NoPlanError,
  PlanEditError,
  PlannerNotReadyError,
  PlannerTurnDiscardedError,
  PlannerTurnStoppedError,
  SessionHeldError,
  SessionNotFoundError,
  TaskControlError,
  WorkspaceNotAProjectError,
  WorkspaceNotFoundError,
  type DaemonErrorCode,
  type ErrorBody,
} from '@ordewell/core';

interface Classified {
  status: ContentfulStatusCode;
  code: DaemonErrorCode;
}

/** A request body that is missing, not JSON, or not an object: the request's fault, never a fault of the daemon. */
export class InvalidBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBodyError';
  }
}

/** An id the tree does not hold, whatever else it might name. */
export class ChildNotFoundError extends Error {
  constructor() {
    super('This tree has no such child plan.');
    this.name = 'ChildNotFoundError';
  }
}

/**
 * The body of a route that needs one object. Every route that read
 * `c.req.json()` directly turned a client's typo into a 500 with the parser's
 * message and a logged stack, while its neighbours answered 400.
 */
export async function jsonObject<T extends object = Record<string, unknown>>(c: Context): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new InvalidBodyError('The request body must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidBodyError('The request body must be a JSON object.');
  }
  return parsed as T;
}

/**
 * The one table from a thrown class to a status and a stable code. A refusal is
 * the request being wrong (400) or arriving at a bad moment (409), a missing
 * session is 404, and only what falls through is a fault — collapsing these
 * into 404/500 gave the TUI and VS Code nothing to show but "Internal error",
 * which reads as the edit having silently done nothing.
 *
 * Order matters: `ConversationBusyError` extends `ConversationEditError`.
 */
function classify(err: unknown): Classified | undefined {
  if (err instanceof InvalidBodyError) return { status: 400, code: 'refused' };
  if (err instanceof SessionNotFoundError) return { status: 404, code: 'session_not_found' };
  if (err instanceof ChildNotFoundError) return { status: 404, code: 'child_not_found' };
  // 409: the session exists; another host has it open right now (ADR-0049).
  if (err instanceof SessionHeldError) return { status: 409, code: 'session_held' };
  if (err instanceof NoPlanError) return { status: 400, code: 'no_plan' };
  if (err instanceof AlreadyExecutingError) return { status: 409, code: 'already_executing' };
  if (err instanceof WorkspaceNotAProjectError) return { status: 400, code: 'workspace_not_a_project' };
  if (err instanceof WorkspaceNotFoundError) return { status: 400, code: 'workspace_not_found' };
  // 409: the request is fine; the machine is not set up to serve it yet.
  if (err instanceof PlannerNotReadyError) return { status: 409, code: 'planner_not_ready' };
  // 409, not 5xx: the turn ending is what the user asked for (or a plan they
  // dropped), and a 5xx would log a stack for every Stop.
  if (err instanceof PlannerTurnStoppedError) return { status: 409, code: 'planner_turn_stopped' };
  if (err instanceof PlannerTurnDiscardedError) return { status: 409, code: 'planner_turn_discarded' };
  if (err instanceof ConversationBusyError) return { status: 409, code: 'conversation_busy' };
  if (err instanceof ConversationEditError || err instanceof PlanEditError || err instanceof TaskControlError) {
    return { status: 400, code: 'refused' };
  }
  return undefined;
}

/** A refusal the route itself decided on, in the body shape every client reads. */
export function refuse(c: Context, status: ContentfulStatusCode, message: string, code?: DaemonErrorCode) {
  const body: ErrorBody = code ? { error: message, code } : { error: message };
  return c.json(body, status);
}

/**
 * A JSON error response from a thrown call. What `classify` does not know is a
 * fault and takes the route's `fallback` status; only a 5xx is logged, since a
 * refusal is the request being wrong and travels to the client as-is.
 */
export function failure(
  c: Context,
  err: unknown,
  label: string,
  { fallback = 500, message = 'Internal error' }: { fallback?: ContentfulStatusCode; message?: string } = {},
) {
  const classified = classify(err);
  const status = classified?.status ?? fallback;
  // Log before returning: the message alone travels to the client, so an
  // unexpected throw (a research tool crashing the whole turn, say) left no
  // stack anywhere — server.log showed nothing and the CLI showed one line.
  if (status >= 500) console.error(`[web] ${label} failed:`, err);
  const body: ErrorBody = {
    error: (err instanceof Error && err.message) || message,
    ...(classified ? { code: classified.code } : {}),
    ...(err instanceof WorkspaceNotAProjectError ? { workspace: err.workspace } : {}),
    ...(err instanceof PlannerNotReadyError ? { plannerNotReady: err.reason } : {}),
    ...(err instanceof SessionHeldError ? { sessionHeld: err.held } : {}),
  };
  return c.json(body, status);
}

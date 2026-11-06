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
 */
export async function callDaemon(route: RouteId, params?: RouteParams, body?: unknown): Promise<unknown> {
  const result = await window.ordewell.daemon.call(route, params, body);
  if (result.ok) return result.data;
  throw new DaemonError(field(result.data, 'error') ?? result.error, result.status, field(result.data, 'code'), result.data);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

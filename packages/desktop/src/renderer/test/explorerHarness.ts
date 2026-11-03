import { vi } from 'vitest';
import type { DaemonCallResult, DaemonStatus } from '../../shared/bridge';
import type { RouteId } from '../../shared/routes';

export const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };

export interface Call { route: RouteId; params: Record<string, string | undefined>; body: unknown }
export type Handler = (call: Call) => DaemonCallResult | unknown;

/** Answers a route with `data`, or a prepared result when the handler already returns one. */
function toResult(value: unknown): DaemonCallResult {
  if (typeof value === 'object' && value !== null && 'ok' in value) return value as DaemonCallResult;
  return { ok: true, status: 200, data: value };
}

export function refusal(code: string, message: string, status = 410): DaemonCallResult {
  return { ok: false, status, error: message, data: { error: message, code } };
}

export interface Harness {
  calls: Call[];
  shell: { openInEditor: ReturnType<typeof vi.fn>; reveal: ReturnType<typeof vi.fn> };
  callsTo(route: RouteId): Call[];
}

/** A preload bridge whose daemon answers by route; a route with no handler answers 404. */
export function installBridge(handlers: Partial<Record<RouteId, Handler>>): Harness {
  const calls: Call[] = [];
  const shell = {
    openInEditor: vi.fn(async () => ({ ok: true })),
    reveal: vi.fn(async () => ({ ok: true })),
  };
  Object.defineProperty(window, 'ordewell', {
    configurable: true,
    value: {
      daemon: {
        status: async () => CONNECTED,
        onStatus: () => () => undefined,
        retry: async () => ({ ok: true }),
        // The Session view's host follows a session's socket from the start; no frame ever arrives here.
        subscribe: () => () => undefined,
        subscribeChild: () => () => undefined,
        call: vi.fn(async (route: RouteId, params: Record<string, string | undefined>, body?: unknown): Promise<DaemonCallResult> => {
          const call = { route, params, body };
          calls.push(call);
          const handler = handlers[route];
          return handler ? toResult(handler(call)) : { ok: false, status: 404, error: `no stub for ${route}` };
        }),
        subscribe: () => () => undefined,
        subscribeChild: () => () => undefined,
      },
      shell,
    },
  });
  return { calls, shell, callsTo: (route) => calls.filter((c) => c.route === route) };
}

import { vi } from 'vitest';
import { createTask, type SurfacePlan, type SurfaceTask } from '@ordewell/core';
import type { DaemonCallResult, DaemonStatus, StreamEvent } from '../../../shared/bridge';
import type { RouteId, RouteParams } from '../../../shared/routes';

const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };

type Answer = DaemonCallResult | ((params: RouteParams | undefined, body: unknown) => DaemonCallResult);

/** A plan task as the daemon sends it. */
export function surfaceTask(fields: Partial<SurfaceTask> & { id: string; order: number; title: string }): SurfaceTask {
  const { id, order, title } = fields;
  return { ...createTask({ id, order, title }), subtasks: [], ...fields };
}

export function surfacePlan(tasks: SurfaceTask[], status: SurfacePlan['status'] = 'approved'): SurfacePlan {
  return { tasks, generatedAt: '', lastUpdated: '', status, runners: ['claude-code'] };
}

export const ok = (data: unknown): DaemonCallResult => ({ ok: true, status: 200, data });

/**
 * main's daemon bridge with no main behind it: each route answers what the
 * test said it would, and each session's socket is pushed frames by hand.
 */
export function fakeDaemon(answers: Partial<Record<RouteId, Answer>> = {}) {
  const sockets = new Map<string, Set<(event: StreamEvent) => void>>();
  const call = vi.fn(async (route: RouteId, params?: RouteParams, body?: unknown): Promise<DaemonCallResult> => {
    const answer = answers[route];
    if (typeof answer === 'function') return answer(params, body);
    return answer ?? ok({ ok: true });
  });
  const subscribe = vi.fn((sessionId: string, cb: (event: StreamEvent) => void) => {
    const set = sockets.get(sessionId) ?? new Set();
    set.add(cb);
    sockets.set(sessionId, set);
    return () => { set.delete(cb); };
  });
  Object.defineProperty(window, 'ordewell', {
    configurable: true,
    value: {
      daemon: {
        status: async () => CONNECTED,
        onStatus: () => () => undefined,
        retry: async () => ({ ok: true }),
        call,
        subscribe,
        subscribeChild: () => () => undefined,
      },
    },
  });
  return {
    call,
    subscribe,
    answers,
    /** Each frame as the session's socket would deliver it, numbered in one stream. */
    push(sessionId: string, ...frames: unknown[]): void {
      for (const frame of frames) for (const cb of [...(sockets.get(sessionId) ?? [])]) cb({ kind: 'frame', frame });
    },
    calls(route: RouteId): Array<[RouteParams | undefined, unknown]> {
      return call.mock.calls.filter(([r]) => r === route).map(([, params, body]) => [params, body]);
    },
  };
}

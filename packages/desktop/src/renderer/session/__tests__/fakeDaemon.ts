import { vi } from 'vitest';
import { createTask, type SurfacePlan, type SurfaceTask } from '@ordewell/core';
import type { DaemonCallResult, DaemonStatus, JoinResult, LiveWorkKind, StreamEvent } from '../../../shared/bridge';
import type { RouteId, RouteParams } from '../../../shared/routes';

const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };

type Result = DaemonCallResult | Promise<DaemonCallResult>;
type Answer = Result | ((params: RouteParams | undefined, body: unknown) => Result);

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
  const statusListeners = new Set<(status: DaemonStatus) => void>();
  let current: DaemonStatus = CONNECTED;
  let joinAnswer: (sessionId: string) => JoinResult = () => ({ ok: false, reason: 'free', message: 'Nothing holds this session now.' });
  const join = vi.fn(async (sessionId: string): Promise<JoinResult> => joinAnswer(sessionId));
  const leave = vi.fn(async (_sessionId: string): Promise<void> => undefined);
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
  const reportLiveWork = vi.fn(async (_kinds: readonly LiveWorkKind[]): Promise<void> => undefined);
  Object.defineProperty(window, 'ordewell', {
    configurable: true,
    value: {
      app: { reportLiveWork },
      daemon: {
        status: async () => current,
        onStatus: (cb: (status: DaemonStatus) => void) => { statusListeners.add(cb); return () => { statusListeners.delete(cb); }; },
        retry: async () => ({ ok: true }),
        call,
        subscribe,
        join,
        leave,
        subscribeChild: () => () => undefined,
      },
    },
  });
  return {
    call,
    subscribe,
    /** What the window told main it has live, each time that changed. */
    reportLiveWork,
    join,
    leave,
    answers,
    /** What main says when the window asks to join a session's holder. */
    joinWith(answer: JoinResult | ((sessionId: string) => JoinResult)): void {
      joinAnswer = typeof answer === 'function' ? answer : () => answer;
    },
    /** The session's socket closing, as when its daemon goes away. */
    close(sessionId: string): void {
      for (const cb of [...(sockets.get(sessionId) ?? [])]) cb({ kind: 'closed', code: 1006, reason: '' });
    },
    /** Each frame as the session's socket would deliver it, numbered in one stream. */
    push(sessionId: string, ...frames: unknown[]): void {
      for (const frame of frames) for (const cb of [...(sockets.get(sessionId) ?? [])]) cb({ kind: 'frame', frame });
    },
    /** main's word that the connection changed, to every window listening. */
    setStatus(status: DaemonStatus): void {
      current = status;
      for (const cb of [...statusListeners]) cb(status);
    },
    connected: CONNECTED,
    calls(route: RouteId): Array<[RouteParams | undefined, unknown]> {
      return call.mock.calls.filter(([r]) => r === route).map(([, params, body]) => [params, body]);
    },
  };
}

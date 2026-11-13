// @vitest-environment jsdom
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PlanResponse, SessionResponse } from '@ordewell/core';
import { DaemonRefusal } from '@ordewell/core/plan-utils';
import { callDaemon } from '../daemon';
import { fakeDaemon, ok } from './fakeDaemon';

describe('callDaemon', () => {
  it('answers the type of the route it named and takes that route\'s body', async () => {
    const daemon = fakeDaemon({ 'sessions.get': ok({ plan: null }) });
    const read = callDaemon('sessions.get', { id: 's', workspace: '/w' });
    expectTypeOf(read).toEqualTypeOf<Promise<SessionResponse>>();
    await read;
    const turn = callDaemon('plans.converseMessage', { sessionId: 's' }, { message: 'hi' });
    expectTypeOf(turn).toEqualTypeOf<Promise<PlanResponse>>();
    await turn;
    expect(daemon.calls('plans.converseMessage')).toEqual([[{ sessionId: 's' }, { message: 'hi' }]]);
  });

  it('refuses at compile time a body the route would not read, a body it needs and a route outside the renderer\'s table', () => {
    fakeDaemon();
    const never = async () => {
      // @ts-expect-error converse/message reads `message`, not `text`
      await callDaemon('plans.converseMessage', { sessionId: 's' }, { text: 'hi' });
      // @ts-expect-error a GET reads no body
      await callDaemon('sessions.get', { id: 's' }, { anything: true });
      // @ts-expect-error not an id in the renderer's table
      await callDaemon('children.checkpointApprove', { id: 's' });
    };
    expect(never).toBeTypeOf('function');
  });

  it('throws the daemon\'s own sentence for a refusal, with its code and body', async () => {
    fakeDaemon({ 'sessions.get': { ok: false, status: 404, error: 'HTTP 404', data: { error: 'Session not found', code: 'not_found' } } });
    const error = await callDaemon('sessions.get', { id: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRefusal);
    expect(error).toMatchObject({ message: 'Session not found', status: 404, code: 'not_found' });
  });

  it('hands the held session and the stale confirm over as typed fields, not a body to cast', async () => {
    const sessionHeld = { holder: { pid: 9, since: 'then' } };
    fakeDaemon({ 'sessions.get': { ok: false, status: 409, error: 'HTTP 409', data: { error: 'Held', code: 'session_held', sessionHeld } } });
    const error = await callDaemon('sessions.get', { id: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRefusal);
    expect((error as DaemonRefusal).sessionHeld).toEqual(sessionHeld);
  });

  it('keeps main\'s summary when the daemon sent no body, and has no status when nothing came back', async () => {
    fakeDaemon({ 'sessions.get': { ok: false, error: 'The daemon is not running' } });
    const error = await callDaemon('sessions.get', { id: 'x' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'The daemon is not running', status: undefined, code: undefined });
  });
});

import { describe, expect, it } from 'vitest';
import { DaemonRefusal, refusalOf } from '../daemonRefusal';

describe('refusalOf', () => {
  it('reads the daemon\'s sentence, status and typed fields out of an ErrorBody', () => {
    const sessionHeld = { holder: { pid: 7, since: 'then' } } as never;
    const refusal = refusalOf(409, { error: 'Held elsewhere', code: 'session_held', sessionHeld }, 'fallback');
    expect(refusal).toBeInstanceOf(DaemonRefusal);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({ message: 'Held elsewhere', status: 409, code: 'session_held', sessionHeld });
    expect(refusal.confirmStale).toBeUndefined();
  });

  it('keeps plannerNotReady, confirmStale, landingBranchHeld and payload', () => {
    const body = {
      error: 'no',
      code: 'refused',
      plannerNotReady: { reason: 'no_key' },
      confirmStale: { shown: 'a', now: 'b' },
      landingBranchHeld: { branch: 'x' },
      payload: { messageId: 'm' },
    };
    const refusal = refusalOf(400, body, 'fallback');
    expect(refusal.plannerNotReady).toEqual(body.plannerNotReady);
    expect(refusal.confirmStale).toEqual(body.confirmStale);
    expect(refusal.landingBranchHeld).toEqual(body.landingBranchHeld);
    expect(refusal.payload).toEqual(body.payload);
  });

  it('names the agent a refused new pick is blocked on, with its way in (a stale picker, ADR-0052)', () => {
    const signIn = { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] };
    const refusal = refusalOf(409, {
      error: 'Cursor is not signed in. Then pick it again.',
      code: 'runner_not_ready',
      runnerNotReady: { runner: 'cursor-agent', readiness: { kind: 'blocked', why: 'signed-out', signIn } },
    }, 'fallback');
    expect(refusal.signIn).toEqual(signIn);
    // A refusal for no sign-in has none to offer.
    expect(refusalOf(409, { error: 'no', code: 'runner_not_ready', runnerNotReady: { runner: 'x', readiness: { kind: 'no-usable-model' } } }, 'f').signIn).toBeUndefined();
  });

  it('falls back to the given sentence when the body has none', () => {
    expect(refusalOf(500, { code: 'refused' }, 'HTTP 500').message).toBe('HTTP 500');
    expect(refusalOf(500, { error: '' }, 'HTTP 500').message).toBe('HTTP 500');
  });

  it.each([['an HTML error page', '<html>bad gateway</html>'], ['null', null], ['undefined', undefined], ['an array', ['x']]])(
    'does not trust %s to be an ErrorBody',
    (_, data) => {
      const refusal = refusalOf(502, data, 'Bad gateway');
      expect(refusal).toMatchObject({ message: 'Bad gateway', status: 502 });
      expect(refusal.code).toBeUndefined();
    },
  );

  it('allows a status-less refusal for a call that got no answer', () => {
    expect(refusalOf(undefined, undefined, 'unreachable').status).toBeUndefined();
  });
});

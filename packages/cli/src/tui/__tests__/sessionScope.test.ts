import { describe, expect, it } from 'vitest';
import { SESSION_KEYS, STATE_SCOPE, initialState, type TuiState } from '../state';
import { leaveSession } from '../reducers/incoming';

/**
 * Leaving a session is driven by `STATE_SCOPE` (ADR-0006 R1): the test dirties
 * every field, so a field classified `session` that `leaveSession` forgets, or
 * one classified otherwise that it wipes, fails here by name.
 */

const DIRTY = '__dirty__';

const dirtied = (): TuiState => {
  const state = initialState();
  const dirty: Record<string, unknown> = {};
  for (const key of Object.keys(STATE_SCOPE)) dirty[key] = `${DIRTY}${key}`;
  return { ...state, ...(dirty as Partial<TuiState>), overlay: null };
};

describe('leaveSession', () => {
  it('resets every session-scoped field to a fresh start and touches no other', () => {
    const before = dirtied();
    const after = leaveSession(before);
    const fresh = initialState();
    for (const key of Object.keys(STATE_SCOPE) as (keyof TuiState)[]) {
      if (STATE_SCOPE[key] === 'session') expect(after[key], key).toEqual(fresh[key]);
      else expect(after[key], key).toBe(before[key]);
    }
  });

  it('carries over only what the step names', () => {
    const after = leaveSession(dirtied(), ['conversation', 'planner']);
    expect(after.conversation).toBe(`${DIRTY}conversation`);
    expect(after.planner).toBe(`${DIRTY}planner`);
    expect(after.goal).toBe('');
  });

  it('drops an approval prompt and keeps any other overlay', () => {
    const approval = { kind: 'approval' } as unknown as TuiState['overlay'];
    const help = { kind: 'help', scroll: 0 } as const;
    expect(leaveSession({ ...initialState(), overlay: approval }).overlay).toBeNull();
    expect(leaveSession({ ...initialState(), overlay: help }).overlay).toBe(help);
  });

  it('classifies something as session-scoped', () => {
    expect(SESSION_KEYS).toContain('sessionId');
    expect(SESSION_KEYS).not.toContain('workspace');
  });
});

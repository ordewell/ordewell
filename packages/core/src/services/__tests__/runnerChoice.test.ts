import { describe, expect, it } from 'vitest';
import { orderByChoice, runnerChoice, runnerChoiceRefusal, runnerEntryChoice, runnerEntryReadiness, runnerReadiness, type RunnerReadiness } from '../runnerReadiness';

/**
 * The one readiness-to-choice rule every picker reads (ADR-0052): one short
 * status, the recovery a row offers, and whether a new pick of the runner is
 * refused. The wording is the approved table, not derived from the code.
 */

const signIn = { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] };

describe('runnerChoice', () => {
  it.each<[RunnerReadiness, string | undefined, string | undefined, boolean]>([
    [{ kind: 'blocked', why: 'signed-out', signIn }, 'Signed out', 'Sign in', true],
    [{ kind: 'blocked', why: 'no-credential', signIn }, 'API key needed', 'Add key', true],
    [{ kind: 'no-usable-model' }, 'No usable model', 'Refresh models', true],
    [{ kind: 'discovery-failed' }, "Couldn't load models", 'Retry', false],
    [{ kind: 'pending' }, 'Checking models…', undefined, false],
    [{ kind: 'sign-in-unknown' }, 'Sign-in not checked', undefined, false],
    [{ kind: 'agent-default' }, 'Uses agent default', undefined, false],
    [{ kind: 'ready' }, undefined, undefined, false],
  ])('%j reads "%s" [%s], blocking a new pick: %s', (readiness, text, recovery, blocks) => {
    const choice = runnerChoice(readiness);
    expect(choice.text).toBe(text);
    expect(choice.recovery?.label).toBe(recovery);
    expect(choice.blocksNewChoice).toBe(blocks);
  });

  it('binds each recovery to a kind a surface can act on', () => {
    expect(runnerChoice({ kind: 'blocked', why: 'signed-out', signIn }).recovery?.kind).toBe('sign-in');
    expect(runnerChoice({ kind: 'blocked', why: 'no-credential' }).recovery?.kind).toBe('add-key');
    expect(runnerChoice({ kind: 'no-usable-model' }).recovery?.kind).toBe('refresh-models');
    expect(runnerChoice({ kind: 'discovery-failed' }).recovery?.kind).toBe('retry');
  });

  it('cannot pick an unusable runner, and says nothing over its own reason', () => {
    const choice = runnerChoice({ kind: 'unusable', reason: 'Too old.' });
    expect(choice).toMatchObject({ status: 'unusable', blocksNewChoice: true, group: 'unusable' });
    expect(choice.text).toBeUndefined();
  });

  it('reads an older daemon\'s row, which carries no readiness, from its sign-in alone', () => {
    expect(runnerEntryChoice({ auth: { state: 'signed-out', signIn } }).status).toBe('signed-out');
    expect(runnerEntryChoice({ auth: { state: 'unknown' } }).status).toBe('sign-in-unknown');
    expect(runnerEntryChoice({ usable: false, reason: 'gone' }).status).toBe('unusable');
    expect(runnerEntryChoice({ readiness: { kind: 'no-usable-model' }, auth: { state: 'signed-in' } }).status).toBe('no-usable-model');
  });
});

describe('runnerEntryReadiness', () => {
  it('keeps the way in of an older verdict that names only its login command', () => {
    expect(runnerEntryReadiness({ id: 'claude-code', name: 'Claude Code', auth: { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] } }))
      .toEqual({ kind: 'blocked', why: 'signed-out', signIn: { runner: 'claude-code', label: 'Claude Code', login: ['claude', 'auth', 'login'] } });
  });
});

describe('orderByChoice', () => {
  it('lists every choosable row first, then the blocked, then the unusable, each group in its given order', () => {
    const rows: [string, RunnerReadiness][] = [
      ['a', { kind: 'blocked', why: 'signed-out', signIn }],
      ['b', { kind: 'unusable' }],
      ['c', { kind: 'sign-in-unknown' }],
      ['d', { kind: 'no-usable-model' }],
      ['e', { kind: 'ready' }],
      ['f', { kind: 'discovery-failed' }],
    ];
    expect(orderByChoice(rows, ([, r]) => runnerChoice(r)).map(([id]) => id)).toEqual(['c', 'e', 'f', 'a', 'd', 'b']);
  });
});

describe('runnerChoiceRefusal, the reason a host gives when it refuses a new pick', () => {
  it('names the way in for a signed-out agent', () => {
    expect(runnerChoiceRefusal('Cursor', { kind: 'blocked', why: 'signed-out', signIn }))
      .toBe('Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login. Then pick it again.');
  });

  it('asks for a refresh for a runner whose catalog lists nothing it can run', () => {
    expect(runnerChoiceRefusal('Pi', { kind: 'no-usable-model' }))
      .toBe('Pi lists no model it can run. Run /refresh to load its models again, then pick it.');
  });

  it('refuses nothing that does not block', () => {
    expect(runnerChoiceRefusal('Cursor', { kind: 'discovery-failed' })).toBeNull();
    expect(runnerChoiceRefusal('Cursor', { kind: 'agent-default' })).toBeNull();
    expect(runnerChoiceRefusal('Cursor', runnerReadiness({ usable: true, auth: { state: 'unknown' } }))).toBeNull();
  });
});

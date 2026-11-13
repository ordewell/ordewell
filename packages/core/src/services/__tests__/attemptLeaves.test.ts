import { describe, it, expect } from 'vitest';
import { attemptLeaves, CANCELLED_HOLD, endKeeps, keptLate, type AttemptEnding, type AttemptLeaves } from '../attemptLeaves';
import type { AttemptKind } from '../attemptKind';

const repair: AttemptKind = { kind: 'repair', repair: { n: 1, limit: 2 } };
const change: AttemptKind = { kind: 'change' };

type Row = [AttemptEnding, AttemptKind | null, Partial<AttemptLeaves>];

// ADR-0013's worktree rule and ADR-0015's "a repair that does not land waits on its conflict", end by end.
const TABLE: Row[] = [
  ['stopped', repair, { status: 'conflict', worktree: 'keep', reaches: 'attempt', waitsForLanding: true }],
  ['stopped', change, { status: 'pending', hold: null, worktree: 'keep', reaches: 'attempt', waitsForLanding: true }],
  ['loaded', repair, { status: null, worktree: 'keep', reaches: 'attempt', waitsForLanding: true }],
  ['loaded', change, { status: null, worktree: 'untouched' }],
  ['cancelled', repair, { status: 'conflict', hold: null, worktree: 'keep', reaches: 'task', waitsForLanding: true }],
  ['cancelled', change, { status: 'pending', hold: CANCELLED_HOLD, worktree: 'keep', reaches: 'task', waitsForLanding: true }],
  ['cancelled', null, { status: 'pending', hold: CANCELLED_HOLD, worktree: 'keep', reaches: 'task' }],
  ['released', repair, { status: 'conflict', hold: null, worktree: 'remove', reaches: 'task', waitsForLanding: true }],
  ['released', change, { status: 'pending', hold: CANCELLED_HOLD, worktree: 'remove', reaches: 'task', waitsForLanding: true }],
  ['failed', repair, { status: 'conflict', worktree: 'keep', reaches: 'attempt', waitsForLanding: false }],
  ['failed', change, { status: 'failed', worktree: 'keep', reaches: 'attempt', waitsForLanding: false }],
  ['unsettled', repair, { status: 'conflict', worktree: 'keep', waitsForLanding: false }],
  ['unsettled', change, { status: 'failed', worktree: 'keep', waitsForLanding: false }],
  ['usage-limit', repair, { status: null, worktree: 'keep', reaches: 'attempt', waitsForLanding: false }],
  ['usage-limit', change, { status: null, worktree: 'keep', reaches: 'attempt', waitsForLanding: false }],
  ['skipped', repair, { status: null, worktree: 'keep', reaches: 'task', waitsForLanding: true }],
  ['skipped', null, { status: null, worktree: 'keep', reaches: 'task', waitsForLanding: true }],
  ['retried', repair, { status: null, worktree: 'remove', reaches: 'task', waitsForLanding: true }],
  ['retried', null, { status: null, worktree: 'remove', reaches: 'task', waitsForLanding: true }],
  ['abandoned', repair, { status: 'conflict', worktree: 'untouched' }],
  ['abandoned', change, { status: 'pending', hold: null, worktree: 'untouched' }],
];

describe('attemptLeaves', () => {
  it.each(TABLE)('%s, %o', (ending, kind, expected) => {
    expect(attemptLeaves(ending, kind)).toMatchObject(expected);
  });

  const ENDINGS: AttemptEnding[] = ['stopped', 'loaded', 'cancelled', 'released', 'failed', 'unsettled', 'usage-limit', 'skipped', 'retried', 'abandoned'];

  it('never leaves a repair not started or failed, whatever ends it (ADR-0015)', () => {
    for (const ending of ENDINGS) expect(['conflict', null]).toContain(attemptLeaves(ending, repair).status);
  });

  it('never removes a repair worktree an end keeps for any other attempt (ADR-0013)', () => {
    for (const ending of ENDINGS) {
      if (attemptLeaves(ending, change).worktree === 'keep') expect(attemptLeaves(ending, repair).worktree).toBe('keep');
    }
  });

  it('holds only a task a cancel puts back to not started', () => {
    for (const ending of ENDINGS) {
      for (const kind of [repair, change, null]) {
        const left = attemptLeaves(ending, kind);
        if (left.hold) expect(left.status).toBe('pending');
      }
    }
  });

  it('reads every kind but a repair as a plain attempt', () => {
    const kinds: AttemptKind[] = [change, { kind: 'readOnly' }, { kind: 'ops' }, { kind: 'carryOver', from: 'codex' }, { kind: 'delegated', readOnly: false }];
    for (const ending of ENDINGS) for (const kind of kinds) expect(attemptLeaves(ending, kind)).toEqual(attemptLeaves(ending, null));
  });
});

describe('endKeeps and keptLate', () => {
  it.each<[AttemptEnding, boolean]>([
    ['stopped', true], ['loaded', false], ['cancelled', true], ['released', false], ['skipped', true], ['retried', false],
  ])('%s keeps a plain attempt workspace: %s', (ending, keeps) => {
    expect(endKeeps(ending)).toBe(keeps);
  });

  it('keeps a repair workspace let go late, whatever its ender decided', () => {
    expect(keptLate(repair, false)).toBe(true);
    expect(keptLate(change, false)).toBe(false);
    expect(keptLate(change, true)).toBe(true);
  });
});

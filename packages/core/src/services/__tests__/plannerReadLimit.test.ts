import { describe, it, expect } from 'vitest';
import { PlannerReadLimit, plannerReadLimitOf, type ReadLimit } from '../plannerReadLimit';

function limited(limit: ReadLimit | undefined, turn = { id: 't1' as string | undefined }) {
  return { reads: new PlannerReadLimit({ limit: () => limit, turn: () => turn.id }), turn };
}

describe('PlannerReadLimit', () => {
  it('allows every read when it is off', () => {
    const { reads } = limited(undefined);
    for (let i = 0; i < 50; i++) {
      expect(reads.admit()).toEqual({ allowed: true });
      reads.charge(100_000);
    }
    expect(reads.line()).toBeUndefined();
  });

  it('refuses the read after the call limit, naming the count and where the rest goes', () => {
    const { reads } = limited({ calls: 3, bytes: 1_000_000 });
    for (let i = 0; i < 3; i++) expect(reads.admit().allowed).toBe(true);
    const refused = reads.admit();
    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    expect(refused.reason).toContain('3 reads');
    expect(refused.reason).toMatch(/research agent/);
    expect(refused.reason).toMatch(/research task/);
  });

  it('refuses once the bytes read this turn reach the byte limit', () => {
    const { reads } = limited({ calls: 10, bytes: 2048 });
    expect(reads.admit().allowed).toBe(true);
    reads.charge(2048);
    const refused = reads.admit();
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toContain('2 KB');
  });

  it('starts over on a new planner turn', () => {
    const { reads, turn } = limited({ calls: 1, bytes: 1_000_000 });
    expect(reads.admit().allowed).toBe(true);
    expect(reads.admit().allowed).toBe(false);
    turn.id = 't2';
    expect(reads.admit().allowed).toBe(true);
  });

  it('gives a refunded call back', () => {
    const { reads } = limited({ calls: 1, bytes: 1_000_000 });
    expect(reads.admit().allowed).toBe(true);
    reads.refund();
    expect(reads.admit().allowed).toBe(true);
  });

  it('shows what is left of the turn as a budget line', () => {
    const { reads } = limited({ calls: 10, bytes: 60 * 1024 });
    reads.admit();
    reads.charge(10 * 1024);
    expect(reads.line()).toBe('Own reads left this turn: 9 calls or 50 KB, whichever runs out first; then delegate.');
  });
});

describe('plannerReadLimitOf', () => {
  it('is on with the defaults unless the file or the environment turns it off', () => {
    expect(plannerReadLimitOf(undefined, undefined)).toEqual({ calls: 10, bytes: 60 * 1024 });
    expect(plannerReadLimitOf(false, undefined)).toBeUndefined();
    expect(plannerReadLimitOf(undefined, 'off')).toBeUndefined();
  });

  it('takes 10 calls and 60 KB when on without numbers', () => {
    expect(plannerReadLimitOf(true, undefined)).toEqual({ calls: 10, bytes: 60 * 1024 });
    expect(plannerReadLimitOf(undefined, 'on')).toEqual({ calls: 10, bytes: 60 * 1024 });
  });

  it('reads either number from the file, defaulting the other', () => {
    expect(plannerReadLimitOf({ calls: 4 }, undefined)).toEqual({ calls: 4, bytes: 60 * 1024 });
    expect(plannerReadLimitOf({ kb: 20 }, undefined)).toEqual({ calls: 10, bytes: 20 * 1024 });
  });

  it('lets the environment override the file, either way', () => {
    expect(plannerReadLimitOf(true, 'off')).toBeUndefined();
    expect(plannerReadLimitOf(undefined, '5,30')).toEqual({ calls: 5, bytes: 30 * 1024 });
  });

  it('ignores an environment value it cannot read', () => {
    expect(plannerReadLimitOf({ calls: 4 }, 'lots')).toEqual({ calls: 4, bytes: 60 * 1024 });
  });
});

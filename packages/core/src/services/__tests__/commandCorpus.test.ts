/**
 * The whole corpus, asserted in one comparison.
 *
 * Deliberately not one case per command. A per-entry suite reports a change to
 * the command policy as N unrelated failures scattered through a run; a single
 * table comparison reports it as one diff naming exactly which commands moved
 * and where they moved to, which is the artifact a reviewer needs in order to
 * accept or reject the widening.
 *
 * The expected side of that comparison is the corpus with {@link KNOWN_GAPS}
 * applied on top, so the suite is green on an unmodified tree while the corpus
 * still states the intended policy. Closing a gap therefore fails this test
 * until the gap entry is deleted — which is what makes each classifier change's
 * diff show precisely which commands it moved.
 *
 * Named regression tests for individual reported issues live in
 * `commandPolicy.test.ts`. This file is the coverage net around them.
 */

import { describe, it, expect } from 'vitest';
import { classifyCommand } from '../commandPolicy';
import { CORPUS, KNOWN_GAPS, type CorpusEntry, type KnownGap } from './fixtures/commandCorpus';

/** Identity of a corpus row. The dialect is part of it: the same string classifies differently under each. */
function key(entry: { command: string; dialect?: string }): string {
  return `${entry.dialect ?? 'posix'}: ${entry.command}`;
}

/**
 * One row's answer, rendered for the diff. Scope is included only where the
 * entry declares one, so entries that do not care about scope do not churn
 * when an unrelated grant boundary moves.
 */
function render(tier: string, scope: string | undefined, withScope: boolean): string {
  return withScope ? `${tier} — scope "${scope ?? ''}"` : tier;
}

const gapsByKey = new Map<string, KnownGap>(KNOWN_GAPS.map((gap) => [key(gap), gap]));

function expectedFor(entry: CorpusEntry): string {
  const withScope = entry.scope !== undefined;
  const gap = gapsByKey.get(key(entry));
  if (!gap) return render(entry.tier, entry.scope, withScope);
  return render(gap.actual.tier, gap.actual.scope ?? entry.scope, withScope);
}

describe('command classification corpus', () => {
  it('classifies every command in the corpus as recorded', () => {
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};

    for (const entry of CORPUS) {
      const result = classifyCommand(entry.command, { dialect: entry.dialect ?? 'posix' });
      actual[key(entry)] = render(result.tier, result.scope, entry.scope !== undefined);
      expected[key(entry)] = expectedFor(entry);
    }

    expect(actual).toEqual(expected);
  });

  // Structural guards on the corpus itself. A duplicate row silently drops one
  // of the two answers, and a gap that no longer names a corpus entry is a
  // fix that was reverted or an entry that was renamed out from under it.
  describe('the corpus is well formed', () => {
    it('covers enough ground to catch a widening', () => {
      expect(CORPUS.length).toBeGreaterThanOrEqual(200);
    });

    it('holds no duplicate command and dialect pair', () => {
      const seen = new Set<string>();
      const duplicates = CORPUS.filter((entry) => !seen.add(key(entry))).map(key);
      expect(duplicates).toEqual([]);
    });

    it('names a corpus entry from every known gap', () => {
      const corpusKeys = new Set(CORPUS.map(key));
      const orphaned = KNOWN_GAPS.filter((gap) => !corpusKeys.has(key(gap))).map(key);
      expect(orphaned).toEqual([]);
    });

    it('says what is wrong in every known gap, not just which command', () => {
      const unexplained = KNOWN_GAPS.filter((gap) => gap.describes.trim().length < 40 || !gap.ticket).map(key);
      expect(unexplained).toEqual([]);
    });

    // Ordinary research is the control half of the corpus: without it, a
    // classifier change that refuses everything would pass.
    it('holds a substantial body of commands that must keep running unprompted', () => {
      const permitted = CORPUS.filter((entry) => entry.tier === 'auto');
      expect(permitted.length).toBeGreaterThanOrEqual(100);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { verdictSummary } from '../checkLabel';

describe('verdictSummary', () => {
  it('says the outcome once, whether or not the reason already opens with it', () => {
    expect(verdictSummary({ outcome: 'pass', reason: 'Verified: the runner reported completion through task_complete.' }))
      .toBe('Verified: the runner reported completion through task_complete.');
    expect(verdictSummary({ outcome: 'pass', reason: 'Manually marked complete by user.' }))
      .toBe('Verified: Manually marked complete by user.');
    expect(verdictSummary({ outcome: 'fail', reason: 'Failed verification: the runner exited cleanly but never called task_complete.' }))
      .toBe('Failed verification: the runner exited cleanly but never called task_complete.');
    expect(verdictSummary({ outcome: 'fail', reason: 'The script failed: exit 1.' }))
      .toBe('Failed verification: The script failed: exit 1.');
  });
});

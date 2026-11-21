import { describe, expect, it } from 'vitest';
import { verdictSummary } from '../checkLabel';

describe('verdictSummary', () => {
  it('says the outcome once, whether or not the reason already opens with it', () => {
    expect(verdictSummary({ outcome: 'pass', reason: 'Verified: the runner reported completion through task_complete.' }))
      .toBe('Verified: the runner reported completion through task_complete.');
    expect(verdictSummary({ outcome: 'pass', reason: 'Manually marked complete by user.' }))
      .toBe('Verified: Manually marked complete by user.');
  });

  it('gives a failure\'s reason as it is: it says what failed itself, for the user (F7)', () => {
    expect(verdictSummary({ outcome: 'fail', reason: 'The runner stopped before reporting the task done, so nothing it did counts yet.' }))
      .toBe('The runner stopped before reporting the task done, so nothing it did counts yet.');
    expect(verdictSummary({ outcome: 'fail', reason: 'The script failed: exit 1.' }))
      .toBe('The script failed: exit 1.');
  });
});

import { describe, it, expect } from 'vitest';
import { EMPTY_HOLD, aheadOfDraft, glued, holdPrompt, unsendAll, unsendLatest } from '../promptHold';

describe('prompt hold', () => {
  it('takes back the newest prompt and leaves the older ones to send', () => {
    const held = holdPrompt(holdPrompt(holdPrompt(EMPTY_HOLD, 'one'), 'two'), 'three');

    const unsent = unsendLatest(held);

    expect(unsent).toEqual({ text: 'three', rest: ['one', 'two'] });
    expect(unsendLatest(EMPTY_HOLD)).toBeUndefined();
  });

  it('gives every prompt at once, glued in the order typed, for the turn\'s end, a Send now or a stop', () => {
    const held = holdPrompt(holdPrompt(EMPTY_HOLD, 'one'), 'two');

    expect(unsendAll(held)).toEqual({ text: 'one\ntwo', rest: [] });
    expect(unsendAll(EMPTY_HOLD)).toBeUndefined();
  });

  it('glues held messages into one, oldest first, a line each (ADR-0023, F1, F5)', () => {
    expect(glued(['one', 'two', 'now'])).toBe('one\ntwo\nnow');
    expect(glued(['alone'])).toBe('alone');
  });

  it('puts an unsent prompt back above the draft being typed', () => {
    expect(aheadOfDraft('take this back', 'half a thought')).toBe('take this back\nhalf a thought');
    expect(aheadOfDraft('take this back', '')).toBe('take this back');
  });
});

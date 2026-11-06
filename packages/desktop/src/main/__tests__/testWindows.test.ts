import { describe, expect, it } from 'vitest';
import { TEST_WINDOWS_ENV, wantsHiddenWindows } from '../testWindows';

describe('wantsHiddenWindows', () => {
  it('is on only for the value "hidden" in an unpackaged app', () => {
    expect(wantsHiddenWindows({ [TEST_WINDOWS_ENV]: 'hidden' }, false)).toBe(true);
    expect(wantsHiddenWindows({ [TEST_WINDOWS_ENV]: '1' }, false)).toBe(false);
    expect(wantsHiddenWindows({}, false)).toBe(false);
  });

  it('is never on in a packaged app, whatever the environment says', () => {
    expect(wantsHiddenWindows({ [TEST_WINDOWS_ENV]: 'hidden' }, true)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { elapsedSince, formatElapsed } from '../elapsed';

describe('formatElapsed', () => {
  it('is whole seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(1_000)).toBe('1s');
    expect(formatElapsed(42_000)).toBe('42s');
  });

  it('rounds down to the whole second', () => {
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(1_999)).toBe('1s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('is minutes and zero-padded seconds from a minute', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(185_000)).toBe('3m 05s');
    expect(formatElapsed(3_599_999)).toBe('59m 59s');
  });

  it('is hours and zero-padded minutes from an hour, with no seconds', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
    expect(formatElapsed(3_600_000 + 59_999)).toBe('1h 00m');
    expect(formatElapsed(3_600_000 + 5 * 60_000)).toBe('1h 05m');
    expect(formatElapsed(26 * 3_600_000 + 61 * 60_000)).toBe('27h 01m');
  });

  it('is empty for what is not a duration', () => {
    expect(formatElapsed(-1)).toBe('');
    expect(formatElapsed(-5_000)).toBe('');
    expect(formatElapsed(NaN)).toBe('');
    expect(formatElapsed(Infinity)).toBe('');
  });
});

describe('elapsedSince', () => {
  const start = '2026-10-30T10:00:00.000Z';
  const at = (seconds: number) => Date.parse(start) + seconds * 1000;

  it('reads the time from an ISO start to the time it is given', () => {
    expect(elapsedSince(start, at(42))).toBe('42s');
    expect(elapsedSince(start, at(185))).toBe('3m 05s');
  });

  it('is empty without a start, for a turn logged before they were kept', () => {
    expect(elapsedSince(undefined, at(42))).toBe('');
  });

  it('is empty for a start it cannot read or that lies ahead of the clock', () => {
    expect(elapsedSince('not a time', at(42))).toBe('');
    expect(elapsedSince(start, at(-5))).toBe('');
  });
});

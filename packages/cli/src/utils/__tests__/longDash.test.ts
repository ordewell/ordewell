import { describe, expect, it } from 'vitest';
import { suggestForLongDash } from '../longDash';

const DASHES = ['‐', '‑', '‒', '–', '—', '―', '−'];

describe('suggestForLongDash', () => {
  it.each(['version', 'help', 'workspace', 'port'])('maps an em or en dash before %s', (name) => {
    expect(suggestForLongDash(`—${name}`)).toBe(`--${name}`);
    expect(suggestForLongDash(`–${name}`)).toBe(`--${name}`);
  });

  it.each(DASHES)('accepts U+%s as the dash', (d) => {
    expect(suggestForLongDash(`${d}version`)).toBe('--version');
  });

  it('replaces a run of dashes', () => {
    expect(suggestForLongDash('——version')).toBe('--version');
    expect(suggestForLongDash('-—version')).toBeUndefined();
  });

  it('maps a one-letter name to its short option', () => {
    expect(suggestForLongDash('–h')).toBe('-h');
    expect(suggestForLongDash('—v')).toBe('-v');
  });

  it('returns undefined for unknown names, ordinary commands and real options', () => {
    expect(suggestForLongDash('—bogus')).toBeUndefined();
    expect(suggestForLongDash('—x')).toBeUndefined();
    expect(suggestForLongDash('bogus')).toBeUndefined();
    expect(suggestForLongDash('')).toBeUndefined();
    expect(suggestForLongDash('--version')).toBeUndefined();
    expect(suggestForLongDash('version')).toBeUndefined();
  });
});

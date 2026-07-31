import { describe, it, expect } from 'vitest';
import { iconFor } from '../output';

describe('iconFor', () => {
  it('returns green check for completed', () => {
    expect(iconFor('completed')).toContain('32m');
  });

  it('returns blue spinner for in_progress', () => {
    expect(iconFor('in_progress')).toContain('34m');
  });

  it('returns red x for failed', () => {
    expect(iconFor('failed')).toContain('31m');
  });

  it('returns yellow for blocked', () => {
    expect(iconFor('blocked')).toContain('33m');
  });

  it('returns gray circle for unknown', () => {
    const result = iconFor('something_else');
    expect(result).toContain('90m');
  });
});

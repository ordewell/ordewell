import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { claimTrailerDisclosure, TRAILER_DISCLOSURE } from '../TrailerDisclosure';

describe('claimTrailerDisclosure', () => {
  const fresh = () => mkdtempSync(join(tmpdir(), 'trailer-'));

  it('is true once per machine, then never again', () => {
    const stateDir = fresh();
    expect(claimTrailerDisclosure({ trailerOn: true, stateDir })).toBe(true);
    expect(claimTrailerDisclosure({ trailerOn: true, stateDir })).toBe(false);
  });

  it('with the trailer off is false and claims nothing, so turning it on later still says it', () => {
    const stateDir = fresh();
    expect(claimTrailerDisclosure({ trailerOn: false, stateDir })).toBe(false);
    expect(claimTrailerDisclosure({ trailerOn: true, stateDir })).toBe(true);
  });

  it('names the trailer and the way to turn it off', () => {
    expect(TRAILER_DISCLOSURE).toContain('Planned-with: Ordewell');
    expect(TRAILER_DISCLOSURE).toContain('`ordewell trailer off`');
  });
});

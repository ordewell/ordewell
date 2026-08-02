import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cliVersion } from '../version';

describe('cliVersion', () => {
  it('reports the version this package actually ships', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(cliVersion()).toBe(pkg.version);
  });

  it('is a bare semver string, so scripts can compare it without parsing', () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

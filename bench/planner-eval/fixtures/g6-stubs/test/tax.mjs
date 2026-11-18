import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { taxCents } from '../src/tax.mjs';

describe('taxCents', () => {
  it('takes the rate as a percentage', () => {
    assert.equal(taxCents(1000, 20), 200);
    assert.equal(taxCents(1000, 0), 0);
    assert.equal(taxCents(1000, 100), 1000);
  });

  it('rounds to the nearest cent, half away from zero', () => {
    assert.equal(taxCents(1005, 10), 101);
    assert.equal(taxCents(-1005, 10), -101);
    assert.equal(taxCents(999, 20), 200);
    assert.equal(taxCents(1004, 10), 100);
  });

  it('refuses a rate outside 0 to 100, and cents that are not whole', () => {
    assert.throws(() => taxCents(100, -1), RangeError);
    assert.throws(() => taxCents(100, 101), RangeError);
    assert.throws(() => taxCents(1.5, 10), RangeError);
  });
});

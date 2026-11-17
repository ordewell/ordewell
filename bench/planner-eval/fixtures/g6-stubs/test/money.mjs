import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCents, toCents } from '../src/money.mjs';

describe('toCents', () => {
  it('reads whole, one-decimal and two-decimal amounts', () => {
    assert.equal(toCents('12.34'), 1234);
    assert.equal(toCents('7'), 700);
    assert.equal(toCents('0.5'), 50);
    assert.equal(toCents(' 3.05 '), 305);
  });

  it('reads a negative amount', () => {
    assert.equal(toCents('-0.5'), -50);
    assert.equal(toCents('-12.34'), -1234);
  });

  it('refuses what is not an amount', () => {
    for (const bad of ['', '  ', '1.234', '1,000.00', '$5', '5a', '.', '1.']) {
      assert.throws(() => toCents(bad), RangeError, bad);
    }
  });
});

describe('formatCents', () => {
  it('writes two decimals and a comma between thousands', () => {
    assert.equal(formatCents(123456), '1,234.56');
    assert.equal(formatCents(0), '0.00');
    assert.equal(formatCents(5), '0.05');
    assert.equal(formatCents(100000000), '1,000,000.00');
  });

  it('writes a negative amount with a leading minus', () => {
    assert.equal(formatCents(-5), '-0.05');
    assert.equal(formatCents(-123456), '-1,234.56');
  });

  it('refuses a value that is not whole cents', () => {
    assert.throws(() => formatCents(1.5), RangeError);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lineAmounts, parseLine } from '../src/lines.mjs';

describe('parseLine', () => {
  it('reads the description, quantity and unit price', () => {
    assert.deepEqual(parseLine([' Widget ', '2', '3.00']), { description: 'Widget', quantity: 2, unitCents: 300 });
  });

  it('names the field it refuses', () => {
    assert.throws(() => parseLine(['  ', '1', '1.00']), (e) => e instanceof RangeError && /description/.test(e.message));
    for (const quantity of ['0', '-1', '1.5', 'x']) {
      assert.throws(() => parseLine(['Widget', quantity, '1.00']), (e) => e instanceof RangeError && /quantity/.test(e.message), quantity);
    }
    assert.throws(() => parseLine(['Widget', '1', 'free']), (e) => e instanceof RangeError && /price/.test(e.message));
  });

  it('refuses a missing or extra field', () => {
    assert.throws(() => parseLine(['Widget', '1']), RangeError);
    assert.throws(() => parseLine(['Widget', '1', '1.00', 'x']), RangeError);
  });
});

describe('lineAmounts', () => {
  it('takes net, tax on the net, and gross', () => {
    assert.deepEqual(lineAmounts({ description: 'Widget', quantity: 2, unitCents: 300 }, 20), { net: 600, tax: 120, gross: 720 });
  });

  it('rounds the tax as taxCents does', () => {
    assert.deepEqual(lineAmounts({ description: 'Bolt', quantity: 3, unitCents: 335 }, 10), { net: 1005, tax: 101, gross: 1106 });
  });
});

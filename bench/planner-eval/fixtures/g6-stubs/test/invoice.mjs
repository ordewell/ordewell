import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { invoiceTotals, readInvoice } from '../src/invoice.mjs';

const CSV = 'Description,Quantity,Price\nWidget,2,3.00\n"Bolt, steel",3,3.35\n';

describe('readInvoice', () => {
  it('reads every record after the header as a line', () => {
    assert.deepEqual(readInvoice(CSV), {
      lines: [
        { description: 'Widget', quantity: 2, unitCents: 300 },
        { description: 'Bolt, steel', quantity: 3, unitCents: 335 },
      ],
    });
    assert.deepEqual(readInvoice('description,quantity,price\n'), { lines: [] });
  });

  it('refuses a missing or different header', () => {
    assert.throws(() => readInvoice(''), RangeError);
    assert.throws(() => readInvoice('item,qty,price\nWidget,1,1.00'), RangeError);
  });

  it('names the record a line was refused at', () => {
    assert.throws(() => readInvoice('description,quantity,price\nWidget,1,1.00\nBolt,0,1.00'), (e) => e instanceof RangeError && /^record 2: /.test(e.message));
  });
});

describe('invoiceTotals', () => {
  it('sums each line\'s amounts, with the tax taken per line', () => {
    assert.deepEqual(invoiceTotals(readInvoice(CSV), 10), { net: 1605, tax: 161, gross: 1766 });
    // Per line: 0.5 + 0.5 rounds to 1 + 1; on the sum it would be 1.
    const halves = { lines: [{ description: 'a', quantity: 1, unitCents: 5 }, { description: 'b', quantity: 1, unitCents: 5 }] };
    assert.deepEqual(invoiceTotals(halves, 10), { net: 10, tax: 2, gross: 12 });
  });

  it('totals an invoice with no lines as zero', () => {
    assert.deepEqual(invoiceTotals({ lines: [] }, 20), { net: 0, tax: 0, gross: 0 });
  });
});

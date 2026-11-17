import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderInvoice } from '../src/render.mjs';

describe('renderInvoice', () => {
  it('writes a row per line and the three totals', () => {
    const invoice = { lines: [{ description: 'Widget', quantity: 2, unitCents: 300 }] };
    assert.equal(renderInvoice(invoice, 20), '2 x Widget: 7.20\nNet: 6.00\nTax: 1.20\nTotal: 7.20');
  });

  it('writes thousands with a comma', () => {
    const invoice = { lines: [{ description: 'Server', quantity: 1, unitCents: 250000 }, { description: 'Cable', quantity: 10, unitCents: 150 }] };
    assert.equal(renderInvoice(invoice, 0), '1 x Server: 2,500.00\n10 x Cable: 15.00\nNet: 2,515.00\nTax: 0.00\nTotal: 2,515.00');
  });

  it('writes only the totals for an invoice with no lines', () => {
    assert.equal(renderInvoice({ lines: [] }, 20), 'Net: 0.00\nTax: 0.00\nTotal: 0.00');
  });
});

/**
 * An invoice as plain text.
 */
import { formatCents } from './money.mjs';
import { lineAmounts } from './lines.mjs';
import { invoiceTotals } from './invoice.mjs';

/**
 * The invoice at `ratePercent` as text: one row per line,
 * '<quantity> x <description>: <gross>', then 'Net: <net>', 'Tax: <tax>' and
 * 'Total: <gross>' for the invoice, every amount written by formatCents. Rows
 * are joined with \n, with no newline at the end. An invoice with no lines
 * has the three total rows only.
 *
 *   2 x Widget: 7.20
 *   Net: 6.00
 *   Tax: 1.20
 *   Total: 7.20
 *
 * @param {import('./invoice.mjs').Invoice} invoice
 * @param {number} ratePercent
 * @returns {string}
 */
export function renderInvoice(invoice, ratePercent) {
  throw new Error('not implemented: renderInvoice');
}

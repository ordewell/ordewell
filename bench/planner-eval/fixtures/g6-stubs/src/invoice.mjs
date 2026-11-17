/**
 * An invoice: its lines, read from CSV, and its totals.
 */
import { parseCsv } from './csv.mjs';
import { lineAmounts, parseLine } from './lines.mjs';

/**
 * @typedef {{ lines: import('./lines.mjs').Line[] }} Invoice
 */

/**
 * The invoice a CSV text holds: a header record 'description,quantity,price'
 * (in any case), then one record per line, each read by parseLine. A missing
 * or different header throws a RangeError, and so does a record parseLine
 * refuses, its message starting 'record N: ' where N counts the records after
 * the header from 1. An invoice may have no lines.
 *
 * @param {string} csvText
 * @returns {Invoice}
 */
export function readInvoice(csvText) {
  throw new Error('not implemented: readInvoice');
}

/**
 * The invoice's totals at `ratePercent`: net, tax and gross, each summed over
 * its lines' lineAmounts. Tax is taken per line and summed, never on the
 * summed net. An invoice with no lines totals zero.
 *
 * @param {Invoice} invoice
 * @param {number} ratePercent
 * @returns {{ net: number, tax: number, gross: number }}
 */
export function invoiceTotals(invoice, ratePercent) {
  throw new Error('not implemented: invoiceTotals');
}

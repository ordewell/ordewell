/**
 * One line of an invoice: what was sold, how many, and at what unit price.
 */
import { toCents } from './money.mjs';
import { taxCents } from './tax.mjs';

/**
 * @typedef {object} Line
 * @property {string} description
 * @property {number} quantity a whole number, 1 or more
 * @property {number} unitCents
 */

/**
 * A line from its CSV fields, [description, quantity, unit price]. The
 * description is trimmed and may not be empty, the quantity is a whole number
 * of 1 or more, and the price is read by toCents. Anything else, a missing or
 * extra field included, throws a RangeError whose message names the field
 * ('description', 'quantity' or 'price').
 *
 * @param {string[]} fields
 * @returns {Line}
 */
export function parseLine(fields) {
  throw new Error('not implemented: parseLine');
}

/**
 * A line's amounts at `ratePercent`: net is the quantity times the unit
 * price, tax is taxCents of the net, and gross is net plus tax.
 *
 * @param {Line} line
 * @param {number} ratePercent
 * @returns {{ net: number, tax: number, gross: number }}
 */
export function lineAmounts(line, ratePercent) {
  throw new Error('not implemented: lineAmounts');
}

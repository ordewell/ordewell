/**
 * Tax on an amount of cents.
 */

/**
 * The tax on `cents` at `ratePercent` (20 for 20%), rounded to the nearest
 * cent, half away from zero: taxCents(1005, 10) is 101, taxCents(-1005, 10)
 * is -101, taxCents(999, 20) is 200. A rate below 0 or above 100, or cents
 * that are not a whole number, throw a RangeError.
 *
 * @param {number} cents
 * @param {number} ratePercent
 * @returns {number} a whole number of cents
 */
export function taxCents(cents, ratePercent) {
  throw new Error('not implemented: taxCents');
}

/**
 * Amounts of money as whole cents, so that no sum is ever off by a float.
 */

/**
 * The cents a decimal amount names: '12.34' is 1234, '-0.5' is -50, '7' is
 * 700. Spaces around the amount are ignored. Anything else throws a
 * RangeError: an empty string, more than two decimals, a thousands separator,
 * a currency sign, a letter.
 *
 * @param {string} text
 * @returns {number} a whole number of cents
 */
export function toCents(text) {
  throw new Error('not implemented: toCents');
}

/**
 * Cents as a person reads them: two decimals, a comma between thousands and a
 * leading minus when negative. 123456 is '1,234.56', -5 is '-0.05', 0 is
 * '0.00'. A value that is not a whole number throws a RangeError.
 *
 * @param {number} cents
 * @returns {string}
 */
export function formatCents(cents) {
  throw new Error('not implemented: formatCents');
}

/**
 * Comma-separated text as records of fields.
 */

/**
 * The records of a CSV text, each an array of its fields. A field may be
 * quoted with double quotes, inside which a comma or a line break is literal
 * and two double quotes stand for one. A record ends at \n or \r\n; an empty
 * line is skipped. Fields are not trimmed. A quoted field left open at the end
 * of the text throws a SyntaxError.
 *
 *   parseCsv('a,"b,c"\n"say ""hi""",d') → [['a', 'b,c'], ['say "hi"', 'd']]
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  throw new Error('not implemented: parseCsv');
}

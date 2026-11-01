/*
 * What counts as a line break wherever text an author or a branch chose meets
 * a line of Ordewell's (ADR-0057 R3): every one git or a terminal would honour,
 * not only `\n`. One set, so what is split, quoted and refused cannot differ.
 */
const BREAKS = '\\n\\v\\f\\r\\u0085\\u2028\\u2029';
const LINE_BREAK = new RegExp(`\\r\\n|[${BREAKS}]`);

/** Text of one line: what a schema refuses anything else by. */
export const ONE_LINE = new RegExp(`^[^${BREAKS}]*$`);

export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/** A quoted value, which stays one line: JSON leaves these three as they are. */
export function quotedLine(text: string): string {
  return JSON.stringify(text).replace(/[\u0085\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A name or a path on a line of Ordewell's: as it stands, or quoted where it would break that line. */
export function onOneLine(text: string): string {
  return ONE_LINE.test(text) ? text : quotedLine(text);
}

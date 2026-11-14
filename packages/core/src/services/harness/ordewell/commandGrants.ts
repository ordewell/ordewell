/**
 * "Allow for this task" in a Guarded attempt of the built-in runner (ADR-0070):
 * the grant is a command prefix the runner proposes, such as `npm test`, and
 * it is matched by words, never by characters, so a grant can widen only to
 * plain arguments of the command the user saw.
 */

/**
 * What lets one command line become several, or feed one from another: a
 * line holding any of these is never covered by a grant, and is never
 * offered one, since its prefix says nothing about what else it runs.
 */
const OPERATOR = /[;&|`<>\n\r]|\$\(/;

/** A subcommand or a script, not a flag or a quoted argument: what makes `npm test` narrower than `npm`. */
const PLAIN_WORD = /^[A-Za-z0-9_][\w.:/@+=-]*$/;

function words(line: string): string[] {
  return line.trim().split(/\s+/).filter((word) => word !== '');
}

/**
 * The prefix "Allow for this task" would grant for `line`: the command and its
 * subcommand when the second word is a plain one, and otherwise the whole line,
 * so a grant never rests on the first word alone (`node -e …` grants only that
 * line). Undefined for a line no grant may cover.
 */
export function proposedGrant(line: string): string | undefined {
  if (OPERATOR.test(line)) return undefined;
  const parts = words(line);
  if (parts.length === 0) return undefined;
  if (parts.length >= 2 && PLAIN_WORD.test(parts[1])) return `${parts[0]} ${parts[1]}`;
  return parts.join(' ');
}

/**
 * Whether a granted prefix covers `line`: the line is the prefix, or the
 * prefix followed by plain arguments, word for word. A one-word grant covers
 * only that word, and no grant covers a line with an operator or substitution.
 */
export function grantCovers(prefix: string, line: string): boolean {
  if (OPERATOR.test(line)) return false;
  const granted = words(prefix);
  const parts = words(line);
  if (granted.length === 0 || parts.length < granted.length) return false;
  if (granted.length === 1 && parts.length > 1) return false;
  return granted.every((word, i) => parts[i] === word);
}

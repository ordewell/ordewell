import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { globalDataDir } from './globalDataDir';
import { writePrivateFile } from './privateFile';

/**
 * `~/.ordewell/.env`, where a setting made from a surface outlives the process
 * that took it: the CLI and the TUI load it before they start a daemon, and
 * write it after the daemon accepted a change.
 */
export function globalEnvFile(): string {
  return join(globalDataDir(), '.env');
}

// A shell variable name, which is all the file can hold; anything else could
// be read back as a different line than the one written.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Quotes are shell syntax; taken literally they become part of an API key and
// the provider answers 401.
function unquote(value: string): string {
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote) ? value.slice(1, -1) : value;
}

/**
 * The variable a line sets, read the one way the reader and the writer both
 * use: a byte-order mark, surrounding space, a carriage return, an `export `
 * and space around `=` are not part of it, and a blank line, a comment or a
 * name no shell variable has sets none. The writer finding a line by any other
 * rule left the reader taking a line it never replaced.
 */
function assignmentOf(line: string): { key: string; value: string; exported: boolean } | undefined {
  const trimmed = line.replace(/^\uFEFF/, '').trim();
  const exported = /^export\s/.test(trimmed);
  const body = exported ? trimmed.replace(/^export\s+/, '') : trimmed;
  if (!body || body.startsWith('#')) return undefined;
  const eq = body.indexOf('=');
  if (eq === -1) return undefined;
  const key = body.slice(0, eq).trim();
  return ENV_NAME.test(key) ? { key, value: unquote(body.slice(eq + 1).trim()), exported } : undefined;
}

/**
 * The file's variables, `export` and surrounding quotes dropped, comments
 * skipped; none when it is missing. A name set twice reads as its last line,
 * as a shell sourcing the file reads it. The CLI and the daemon both load the
 * file through this, and both keep a variable their environment already holds
 * over it, so every reader agrees on which line holds a key.
 */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const assignment = assignmentOf(line);
    if (assignment) out[assignment.key] = assignment.value;
  }
  return out;
}

/**
 * Write each variable into the file, owner-only (it holds keys): over the
 * first line that sets it, any later one taken out so no stale copy outlives
 * the write, and appended where none does. An undefined value takes every
 * line of it out. The file's line endings and an `export ` are kept. Refuses,
 * writing nothing, a name that is no shell variable or a value with a line
 * break, which would write a second variable of the value's choosing.
 */
export function writeEnvFileVars(file: string, vars: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!ENV_NAME.test(key)) throw new Error(`"${key}" is not a valid environment variable name.`);
    if (value !== undefined && /[\r\n]/.test(value)) throw new Error(`Refusing to write ${key}: the value contains a line break.`);
  }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text === '' && Object.values(vars).every((value) => value === undefined)) return;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  // The file's last newline, kept as the empty line after it.
  const ended = lines.length > 0 && lines[lines.length - 1] === '';
  if (ended) lines.pop();
  for (const [key, value] of Object.entries(vars)) {
    const at = lines.flatMap((line, index) => (assignmentOf(line)?.key === key ? [index] : []));
    const first = at[0];
    for (const index of at.slice(value === undefined ? 0 : 1).reverse()) lines.splice(index, 1);
    if (value === undefined) continue;
    if (first === undefined) lines.push(`${key}=${value}`);
    else lines[first] = `${assignmentOf(lines[first])?.exported ? 'export ' : ''}${key}=${value}`;
  }
  writePrivateFile(file, lines.length > 0 ? `${lines.join(eol)}${eol}` : '');
}

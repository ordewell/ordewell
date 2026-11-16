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

/** The file's variables as the CLI reads them: `export` and surrounding quotes dropped, comments skipped; none when it is missing. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (ENV_NAME.test(key)) out[key] = unquote(trimmed.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Write each variable into the file, over its own line where it has one and
 * appended where not, owner-only (it holds keys). Refuses, writing nothing, a
 * name that is no shell variable or a value with a line break, which would
 * write a second variable of the value's choosing.
 */
export function writeEnvFileVars(file: string, vars: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!ENV_NAME.test(key)) throw new Error(`"${key}" is not a valid environment variable name.`);
    if (/[\r\n]/.test(value)) throw new Error(`Refusing to write ${key}: the value contains a line break.`);
  }
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  for (const [key, value] of Object.entries(vars)) {
    // By line prefix, not a pattern built from the key.
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index !== -1) {
      lines[index] = `${key}=${value}`;
      continue;
    }
    // Before the file's trailing newline, so the file keeps ending in one.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, `${key}=${value}`);
    else lines.push(`${key}=${value}`);
  }
  const content = lines.join('\n');
  writePrivateFile(file, content.endsWith('\n') ? content : `${content}\n`);
}

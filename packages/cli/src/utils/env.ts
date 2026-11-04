import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SettingsService, globalDataDir, parseAutonomyFlag, writePrivateFile } from '@ordewell/core';

export function findEnvFile(): string {
  return join(globalDataDir(), '.env');
}

// Quotes are shell syntax; taken literally they become part of an API key and
// the provider answers 401.
function unquote(value: string): string {
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote) ? value.slice(1, -1) : value;
}

/**
 * `process.env` as the shell handed it over, before {@link loadEnvFile} filled
 * any gap from `.env`; null until that runs. A planner switch rewrites `.env`
 * and the process environment, so only a value from here outlives it and keeps
 * overriding the saved choice.
 */
let shellEnv: NodeJS.ProcessEnv | null = null;

/**
 * Populate process.env from ~/.ordewell/.env.
 * Shell-exported vars always win — a var already set is left untouched — so this
 * only fills gaps left by setting a key/model in the TUI. No-op if the file doesn't exist.
 */
export function loadEnvFile(): void {
  shellEnv = { ...process.env };
  const filePath = findEnvFile();
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = unquote(trimmed.slice(eq + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * The value `key` had in the shell that launched this process, or undefined
 * before {@link loadEnvFile}, or for a key that only `.env` supplied. A value
 * a command wrote afterwards is not this: only the shell's survives the next
 * launch.
 */
export function shellEnvValue(key: string): string | undefined {
  return shellEnv?.[key];
}

// A shell variable name, which is all `.env` can hold. Rejecting anything else
// keeps a key from being read as a pattern or written as an injected line.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertValidEnvKey(key: string): void {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new Error(`"${key}" is not a valid environment variable name.`);
  }
}

export function writeEnvVar(filePath: string, key: string, value: string): void {
  assertValidEnvKey(key);
  if (/[\r\n]/.test(value)) {
    throw new Error(`Refusing to write ${key}: the value contains a newline.`);
  }

  let content = '';
  if (existsSync(filePath)) {
    content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    // Match by line prefix rather than interpolating the key into a RegExp: an
    // unescaped key could otherwise be read as a pattern.
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index === -1) {
      if (content.length > 0 && !content.endsWith('\n')) content += '\n';
      content += `${key}=${value}\n`;
    } else {
      lines[index] = `${key}=${value}`;
      content = lines.join('\n');
    }
  } else {
    content = `${key}=${value}\n`;
  }

  try {
    writePrivateFile(filePath, content);
  } catch (err) {
    console.error(`Could not write to ${filePath}: ${(err as Error).message}`);
  }
}

const AUTONOMY_KEY = 'ORDEWELL_AUTONOMOUS_MODE';

/**
 * The autonomy level moved from `.env` to the settings file (ADR-0030). Run
 * before {@link loadEnvFile}: a line left there would load as an environment
 * override and hide every later `/settings` change. The settings file's own value wins;
 * an older install's line fills it once, and goes either way.
 */
export function moveAutonomyToSettings(): void {
  const filePath = findEnvFile();
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.trim().replace(/^export\s+/, '').startsWith(`${AUTONOMY_KEY}=`));
  if (index === -1) return;
  const settings = new SettingsService();
  if (settings.getAll().autonomousMode === undefined) {
    const level = parseAutonomyFlag(unquote(lines[index].slice(lines[index].indexOf('=') + 1).trim()));
    if (level !== undefined) settings.setAutonomousMode(level);
  }
  lines.splice(index, 1);
  try {
    writePrivateFile(filePath, lines.join('\n'));
  } catch (err) {
    console.error(`Could not write to ${filePath}: ${(err as Error).message}`);
  }
}

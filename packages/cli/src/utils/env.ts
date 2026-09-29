import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { globalDataDir, writePrivateFile } from '@ordewell/core';

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
 * Populate process.env from ~/.ordewell/.env.
 * Shell-exported vars always win — a var already set is left untouched — so this
 * only fills gaps left by setting a key/model in the TUI. No-op if the file doesn't exist.
 */
export function loadEnvFile(): void {
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

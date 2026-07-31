import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, parse } from 'path';
import { homedir } from 'os';

export function findEnvFile(): string {
  return join(homedir(), '.config', 'ordewell', '.env');
}

/**
 * Populate process.env from ~/.config/ordewell/.env.
 * Shell-exported vars always win — a var already set is left untouched — so this
 * only fills gaps left by setting a key/model in the TUI. No-op if the file doesn't exist.
 */
export function loadEnvFile(): void {
  const filePath = findEnvFile();
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function writeEnvVar(filePath: string, key: string, value: string): void {
  try {
    const { dir } = parse(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let content = '';
    if (existsSync(filePath)) {
      content = readFileSync(filePath, 'utf8');
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}\n`;
      }
    } else {
      content = `${key}=${value}\n`;
    }
    writeFileSync(filePath, content);
  } catch (err) {
    console.error(`Could not write to ${filePath}: ${(err as Error).message}`);
  }
}

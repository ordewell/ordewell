import { SettingsService, globalEnvFile, parseAutonomyFlag, readEnvFile, writeEnvFileVars } from '@ordewell/core';

/** `~/.ordewell/.env`, which the daemon saves a key to as well, read and written by core's one set of rules. */
export function findEnvFile(): string {
  return globalEnvFile();
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
  for (const [key, value] of Object.entries(readEnvFile(findEnvFile()))) {
    if (process.env[key] === undefined) process.env[key] = value;
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

/**
 * Write one variable into `.env`, owner-only. A name that is no shell variable
 * or a value with a line break throws and writes nothing; a write the file
 * system refuses is said rather than thrown, since the daemon took the change.
 */
export function writeEnvVar(filePath: string, key: string, value: string): void {
  try {
    writeEnvFileVars(filePath, { [key]: value });
  } catch (err) {
    // Only a file-system error carries a code; a refused name or value is the caller's mistake.
    if (!(err instanceof Error) || !('code' in err)) throw err;
    console.error(`Could not write to ${filePath}: ${err.message}`);
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
  const value = readEnvFile(filePath)[AUTONOMY_KEY];
  if (value === undefined) return;
  const settings = new SettingsService();
  if (settings.getAll().autonomousMode === undefined) {
    const level = parseAutonomyFlag(value);
    if (level !== undefined) settings.setAutonomousMode(level);
  }
  try {
    writeEnvFileVars(filePath, { [AUTONOMY_KEY]: undefined });
  } catch (err) {
    console.error(`Could not write to ${filePath}: ${(err as Error).message}`);
  }
}

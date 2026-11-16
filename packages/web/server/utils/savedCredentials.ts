import { PROVIDER_CREDENTIAL_ENV, globalEnvFile, readEnvFile, writeEnvFileVars } from '@ordewell/core';

/**
 * Provider keys and endpoints set through the daemon outlive it, in the file
 * the CLI keeps them in (`~/.ordewell/.env`, owner-only). A surface with no
 * file of its own, the desktop app, sets a key only here, and a daemon it
 * starts again inherits nothing that holds it; the CLI and the TUI write the
 * file too, after the daemon accepted the change, so either order lands the
 * same line.
 */

/**
 * Save the credential variables of an accepted settings write; anything else
 * in it is not saved here. Answers the ones it could not save, every one of
 * them when the write failed: each works for this daemon's life, and only its
 * next start would miss it, which the surface that set it says.
 */
export function saveCredentials(env: Readonly<Record<string, string>>, file: string = globalEnvFile()): string[] {
  const credentials = Object.fromEntries(Object.entries(env).filter(([key]) => PROVIDER_CREDENTIAL_ENV.has(key)));
  if (Object.keys(credentials).length === 0) return [];
  try {
    writeEnvFileVars(file, credentials);
    return [];
  } catch (err) {
    console.error(`[web] could not save the provider key to ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return Object.keys(credentials);
  }
}

/**
 * Fill the credential variables `env` lacks from the file, for a daemon a
 * surface started without loading it. What `env` already holds wins, as the
 * shell's export does over the file in the CLI.
 */
export function loadSavedCredentials(env: NodeJS.ProcessEnv = process.env, file: string = globalEnvFile()): void {
  let saved: Record<string, string>;
  try {
    saved = readEnvFile(file);
  } catch (err) {
    console.error(`[web] could not read saved provider keys from ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const [key, value] of Object.entries(saved)) {
    if (PROVIDER_CREDENTIAL_ENV.has(key) && env[key] === undefined) env[key] = value;
  }
}

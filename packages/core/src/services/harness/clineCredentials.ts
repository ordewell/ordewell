import { promises as fs } from 'fs';
import { homedir as osHomedir } from 'os';
import { isAbsolute, join } from 'path';
import type { RunnerCredentials } from '../../plugins/types';

/*
 * The provider key Cline's own login stored, handed to Cline's ACP process,
 * which does not read that store itself and answers every session
 * "Authentication required" without it (ADR-0060, R9). It is read from where
 * Cline keeps it and nowhere else, as ADR-0051 reads OpenCode's: only for the
 * spawn that asks, afresh each time, and what it answers reaches that spawn's
 * environment alone. Nothing here logs it, keeps it, writes it or puts it in
 * an error.
 */

export interface ClineCredentialDeps {
  homedir?: () => string;
}

/** A store is a few providers' settings; anything this big is not one. */
const MAX_STORE_BYTES = 64 * 1024;

/** A provider id as Cline writes one; anything else is not repeated in an error, in case it is a key. */
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,64}$/;

const ROUTES = 'Sign in with `cline auth` (a Cline or ClinePass account, or a provider\'s key), or set CLINE_PROVIDER and CLINE_API_KEY in Ordewell\'s environment.';

/** The hook a Cline profile carries: `CLINE_PROVIDER`, `CLINE_API_KEY` and, unless the user chose one, `CLINE_MODEL` from the entry Cline last used. */
export function clineCredentials(deps: ClineCredentialDeps = {}): RunnerCredentials {
  const homedir = deps.homedir ?? osHomedir;
  return async ({ env }) => {
    // The user's own route: Cline already starts under their variables, and the store is not Ordewell's to read then.
    if (env.CLINE_API_KEY) return null;
    const path = env.CLINE_PROVIDER_SETTINGS_PATH || join(homedir(), '.cline', 'data', 'settings', 'providers.json');
    const text = isAbsolute(path) ? await readSmall(path) : null;
    if (text === undefined) throw refused(`\`${path}\` is missing`);
    const parsed = text === null ? undefined : parseJson(text);
    if (!isRecord(parsed)) throw refused(`\`${path}\` could not be read`);

    const last = parsed.lastUsedProvider;
    if (typeof last !== 'string' || !PROVIDER_ID.test(last)) throw refused(`\`${path}\` names no provider it last used`);
    const providers = isRecord(parsed.providers) ? parsed.providers : {};
    const entry = Object.prototype.hasOwnProperty.call(providers, last) ? providers[last] : undefined;
    const settings = isRecord(entry) && isRecord(entry.settings) ? entry.settings : {};
    const apiKey = nonEmpty(settings.apiKey);
    if (!apiKey) throw refused(`the provider it last used (${last}) has no key in \`${path}\``);

    const model = env.CLINE_MODEL ? undefined : nonEmpty(settings.model);
    return {
      CLINE_PROVIDER: nonEmpty(settings.provider) ?? last,
      CLINE_API_KEY: apiKey,
      ...(model ? { CLINE_MODEL: model } : {}),
    };
  };
}

function refused(reason: string): Error {
  return new Error(`Cline has no provider key Ordewell can hand it: ${reason}. ${ROUTES}`);
}

/** The file's text; undefined when it is not there, null when it cannot be read or is too big to be a store. */
async function readSmall(path: string): Promise<string | undefined | null> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return null;
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

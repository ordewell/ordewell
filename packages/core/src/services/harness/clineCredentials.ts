import { promises as fs } from 'fs';
import { homedir as osHomedir } from 'os';
import { isAbsolute, join } from 'path';
import type { AiProvider } from '../../interfaces/IConfig';
import type { RunnerCredentials } from '../../plugins/types';
import { ordewellProvider } from './ordewellProvider';

/*
 * The provider key Cline's ACP process starts under, which does not read
 * Cline's own store and answers every session "Authentication required"
 * without a key in its environment (ADR-0060, R9). It is the key configured in
 * Ordewell where Cline reaches that provider, else the one Cline's own login
 * stored, read from where Cline keeps it and nowhere else, as ADR-0051 reads
 * OpenCode's: only for the spawn that asks, afresh each time, and what it
 * answers reaches that spawn's environment alone. Nothing here logs it, keeps
 * it, writes it or puts it in an error.
 */

export interface ClineCredentialDeps {
  homedir?: () => string;
}

/** A store is a few providers' settings; anything this big is not one. */
const MAX_STORE_BYTES = 64 * 1024;

/** A provider id as Cline writes one; anything else is not repeated in an error, in case it is a key. */
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Ordewell's vendors Cline 3.0.74 has a provider for, by Cline's id, with the
 * endpoint Cline reaches it at. Cline takes no endpoint from its environment,
 * so a vendor Ordewell reaches elsewhere is not handed over: its key would be
 * sent to Cline's default instead.
 */
const CLINE_PROVIDERS: Partial<Record<AiProvider, { id: string; baseUrl: string }>> = {
  openrouter: { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  openai: { id: 'openai-native', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  xai: { id: 'xai', baseUrl: 'https://api.x.ai/v1' },
  groq: { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1' },
  together: { id: 'together', baseUrl: 'https://api.together.xyz/v1' },
  fireworks: { id: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  cerebras: { id: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1' },
  zhipu: { id: 'zhipuai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  stepfun: { id: 'stepfun', baseUrl: 'https://api.stepfun.com/v1' },
};

const ROUTES = 'Set the key of a provider Cline offers, such as OpenRouter, in Ordewell with `/key`, or sign in with `cline auth` (a Cline or ClinePass account, or a provider\'s key), or set CLINE_PROVIDER and CLINE_API_KEY in Ordewell\'s environment.';

/**
 * The hook a Cline profile carries: `CLINE_PROVIDER`, `CLINE_API_KEY` and,
 * unless the user chose one, `CLINE_MODEL`, from the provider configured in
 * Ordewell, else from the entry Cline last used.
 */
export function clineCredentials(deps: ClineCredentialDeps = {}): RunnerCredentials {
  const homedir = deps.homedir ?? osHomedir;
  return async ({ env }) => {
    // The user's own route: Cline already starts under their variables, and the store is not Ordewell's to read then.
    if (env.CLINE_API_KEY) return null;
    // A key configured in Ordewell is the person's choice for every agent, so it comes before Cline's own store.
    const own = ordewellProvider(env, (vendor, baseUrl) => CLINE_PROVIDERS[vendor]?.baseUrl === baseUrl);
    const provider = own && CLINE_PROVIDERS[own.vendor];
    if (own && provider) {
      const model = env.CLINE_MODEL ? undefined : own.model;
      return { CLINE_PROVIDER: provider.id, CLINE_API_KEY: own.apiKey, ...(model ? { CLINE_MODEL: model } : {}) };
    }
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
  return new Error(`Cline has no provider key Ordewell can hand it: Ordewell holds none for a provider Cline offers, and ${reason}. ${ROUTES}`);
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

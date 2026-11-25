import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setSharedProviderCredentials } from '../../hostCredentials';
import { clineCredentials } from '../clineCredentials';
import { geminiCredentials } from '../geminiCredentials';
import { qwenCredentials } from '../qwenCredentials';

const KEY = 'sk-or-v1-cline-key-never-shown';
const OTHER_KEY = 'sk-ant-other-provider-key';
const ORDEWELL_KEY = 'sk-or-v1-ordewell-own-key-never-shown';

const ROUTES = 'Set the key of a provider Cline offers, such as OpenRouter, in Ordewell with `/key-set`, or sign in with `cline auth` (a Cline or ClinePass account, or a provider\'s key), or set CLINE_PROVIDER and CLINE_API_KEY in Ordewell\'s environment.';
const NONE = 'Cline has no provider key Ordewell can hand it: Ordewell holds none for a provider Cline offers, and ';

let home: string;
let storePath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ordewell-cline-'));
  storePath = join(home, '.cline', 'data', 'settings', 'providers.json');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function store(contents: unknown, path = storePath): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), { mode: 0o600 });
}

/** Cline 3.0.74's store after `cline auth` with an OpenRouter key, then an Anthropic one, then OpenRouter chosen again. */
function signedIn(lastUsedProvider = 'openrouter') {
  return {
    version: 1,
    lastUsedProvider,
    modes: {},
    providers: {
      openrouter: { settings: { provider: 'openrouter', apiKey: KEY, model: 'openai/gpt-4.1-mini' }, updatedAt: '2026-11-01T10:00:00.000Z', tokenSource: 'manual' },
      anthropic: { settings: { provider: 'anthropic', apiKey: OTHER_KEY, model: 'claude-sonnet-5-5' }, updatedAt: '2026-10-01T10:00:00.000Z', tokenSource: 'manual' },
    },
  };
}

const read = (env: Record<string, string | undefined> = {}, kind: 'planner' | 'task' = 'task') =>
  clineCredentials({ homedir: () => home })({ env, kind });

async function refusal(env: Record<string, string | undefined> = {}): Promise<string> {
  const error = await read(env).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain(ROUTES);
  expect(`${message}\n${(error as Error).stack}`).not.toContain(KEY);
  expect(`${message}\n${(error as Error).stack}`).not.toContain(OTHER_KEY);
  expect(`${message}\n${(error as Error).stack}`).not.toContain(ORDEWELL_KEY);
  return message;
}

describe('clineCredentials', () => {
  it('hands the provider, key and model of the entry the user last used, and no other', async () => {
    store(signedIn());
    expect(await read()).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: KEY, CLINE_MODEL: 'openai/gpt-4.1-mini' });

    store(signedIn('anthropic'));
    expect(await read()).toEqual({ CLINE_PROVIDER: 'anthropic', CLINE_API_KEY: OTHER_KEY, CLINE_MODEL: 'claude-sonnet-5-5' });
  });

  it('reads the store CLINE_PROVIDER_SETTINGS_PATH names, the workspace\'s own included, and not the default', async () => {
    store(signedIn('anthropic'));
    const named = join(home, 'elsewhere', 'providers.json');
    store(signedIn('openrouter'), named);

    expect(await read({ CLINE_PROVIDER_SETTINGS_PATH: named })).toMatchObject({ CLINE_API_KEY: KEY });
    rmSync(named);
    expect(await refusal({ CLINE_PROVIDER_SETTINGS_PATH: named })).toBe(`${NONE}\`${named}\` is missing. ${ROUTES}`);
  });

  describe('with a provider configured in Ordewell', () => {
    it('hands Cline the OpenRouter key Ordewell holds, ahead of Cline\'s own store', async () => {
      store(signedIn('anthropic'));
      expect(await read({ OPENROUTER_API_KEY: ORDEWELL_KEY })).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: ORDEWELL_KEY });
    });

    it('hands the vendor AI_PROVIDER names over the first configured one, with the planner\'s model unless the user chose Cline\'s', async () => {
      store(signedIn());
      const env = { OPENROUTER_API_KEY: 'sk-or-v1-not-chosen', XAI_API_KEY: ` ${ORDEWELL_KEY} `, AI_PROVIDER: 'xai', ORCHESTRATOR_MODEL: 'grok-4' };
      expect(await read(env)).toEqual({ CLINE_PROVIDER: 'xai', CLINE_API_KEY: ORDEWELL_KEY, CLINE_MODEL: 'grok-4' });
      expect(await read({ ...env, CLINE_MODEL: 'grok-code-fast' })).toEqual({ CLINE_PROVIDER: 'xai', CLINE_API_KEY: ORDEWELL_KEY });
    });

    it('falls back to Cline\'s store for a vendor Cline cannot reach where Ordewell does: moved off its endpoint, unknown to Cline, or not OpenAI-compatible', async () => {
      store(signedIn());
      const unreachable = {
        OPENROUTER_API_KEY: ORDEWELL_KEY, OPENROUTER_BASE_URL: 'https://proxy.example/v1',
        MOONSHOT_API_KEY: ORDEWELL_KEY,
        GEMINI_API_KEY: ORDEWELL_KEY, AI_PROVIDER: 'google',
        OPENAI_COMPATIBLE_API_KEY: ORDEWELL_KEY, OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1',
      };
      expect(await read(unreachable)).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: KEY, CLINE_MODEL: 'openai/gpt-4.1-mini' });
    });
  });

  describe('with a key saved in Ordewell\'s shared store the host keeps out of its environment', () => {
    const SAVED_KEY = 'sk-or-v1-saved-in-the-shared-store';
    const readShared = (env: Record<string, string | undefined>, shared: Record<string, string>) =>
      clineCredentials({ homedir: () => home, shared: () => shared })({ env, kind: 'task' });

    it('hands Cline the saved OpenRouter key with no Cline store at all, as the daemon whose environment holds it does', async () => {
      expect(await readShared({}, { OPENROUTER_API_KEY: SAVED_KEY, OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' }))
        .toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: SAVED_KEY });
    });

    it('reads the store the host registered, afresh for each spawn, and none once it is removed', async () => {
      const saved: Record<string, string> = {};
      setSharedProviderCredentials(() => saved);
      try {
        expect(await refusal()).toBe(`${NONE}\`${storePath}\` is missing. ${ROUTES}`);
        saved.OPENROUTER_API_KEY = SAVED_KEY;
        saved.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
        expect(await read()).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: SAVED_KEY });
      } finally {
        setSharedProviderCredentials(undefined);
      }
      expect(await refusal()).toBe(`${NONE}\`${storePath}\` is missing. ${ROUTES}`);
    });

    it('asks the store under the spawn\'s own variables, and reads it as the daemon would: AI_PROVIDER picks among them all', async () => {
      const asked: Record<string, string | undefined>[] = [];
      const env = { XAI_API_KEY: ORDEWELL_KEY, AI_PROVIDER: 'openrouter', ORCHESTRATOR_MODEL: 'openai/gpt-5' };
      const shared = { OPENROUTER_API_KEY: SAVED_KEY, OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' };
      const answer = await clineCredentials({ homedir: () => home, shared: (e) => { asked.push({ ...e }); return shared; } })({ env, kind: 'planner' });
      expect(answer).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: SAVED_KEY, CLINE_MODEL: 'openai/gpt-5' });
      expect(asked).toEqual([env]);
      // Without AI_PROVIDER, the first configured in PROVIDER_PRIORITY, as the daemon's environment reads.
      expect(await readShared({ XAI_API_KEY: ORDEWELL_KEY }, shared)).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: SAVED_KEY });
    });

    it('is not sent to Cline\'s default from a saved custom endpoint, whatever the workspace names, and Cline\'s own store answers', async () => {
      const elsewhere = { OPENROUTER_API_KEY: SAVED_KEY, OPENROUTER_BASE_URL: 'https://proxy.example/v1' };
      const workspace = { OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' };
      expect(await readShared(workspace, elsewhere).then(() => 'handed', () => 'refused')).toBe('refused');
      store(signedIn());
      expect(await readShared(workspace, elsewhere)).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: KEY, CLINE_MODEL: 'openai/gpt-4.1-mini' });
      // Nor a saved Custom endpoint or a vendor Cline has no provider for.
      const incompatible = { OPENAI_COMPATIBLE_API_KEY: SAVED_KEY, OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1', MOONSHOT_API_KEY: SAVED_KEY };
      expect(await readShared({}, incompatible)).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: KEY, CLINE_MODEL: 'openai/gpt-4.1-mini' });
    });

    it('gives way to the user\'s own Cline variables, asking nothing of the store', async () => {
      const shared = vi.fn(() => ({ OPENROUTER_API_KEY: SAVED_KEY }));
      expect(await clineCredentials({ homedir: () => home, shared })({ env: { CLINE_PROVIDER: 'anthropic', CLINE_API_KEY: 'from-the-user' } })).toBeNull();
      expect(shared).not.toHaveBeenCalled();
    });

    it('is no other agent\'s: Qwen\'s and Gemini\'s hooks never read it', async () => {
      const shared = vi.fn(() => ({ OPENROUTER_API_KEY: SAVED_KEY, OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1', GEMINI_API_KEY: SAVED_KEY }));
      setSharedProviderCredentials(shared);
      try {
        for (const hook of [qwenCredentials, geminiCredentials]) {
          const answer = await hook({ env: { HOME: home } }).then((a) => a, () => null);
          expect(JSON.stringify(answer ?? {})).not.toContain(SAVED_KEY);
        }
        expect(shared).not.toHaveBeenCalled();
      } finally {
        setSharedProviderCredentials(undefined);
      }
    });
  });

  it('reads nothing and adds nothing when the user hands Cline a key of their own', async () => {
    // A store that would throw if read: the user's variables stand on their own.
    store('not json');
    expect(await read({ CLINE_PROVIDER: 'anthropic', CLINE_API_KEY: 'from-the-user' })).toBeNull();
  });

  it('leaves a model the user chose in the environment to the user', async () => {
    store(signedIn());
    expect(await read({ CLINE_MODEL: 'openai/gpt-5' })).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: KEY });
  });

  it('takes the provider from the entry\'s key where its settings do not name one, and adds no model it has none of', async () => {
    store({ version: 1, lastUsedProvider: 'openrouter', providers: { openrouter: { settings: { apiKey: KEY } } } });
    expect(await read()).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: KEY });
  });

  it('names both routes, and the store, when there is no store', async () => {
    expect(await refusal()).toBe(`${NONE}\`${storePath}\` is missing. ${ROUTES}`);
    // A key Ordewell holds for an endpoint Cline cannot reach is not named, nor is its vendor's variable.
    const elsewhere = await refusal({ OPENROUTER_API_KEY: ORDEWELL_KEY, OPENROUTER_BASE_URL: 'https://proxy.example/v1' });
    expect(elsewhere).toBe(`${NONE}\`${storePath}\` is missing. ${ROUTES}`);
  });

  it('names both routes when the store cannot be read: not JSON, a directory, too big, or not a path it can stand on', async () => {
    const unreadable = (path: string) => `${NONE}\`${path}\` could not be read. ${ROUTES}`;
    store(`{"lastUsedProvider":"openrouter","providers":{"openrouter":{"settings":{"apiKey":"${KEY}"`);
    expect(await refusal()).toBe(unreadable(storePath));

    rmSync(storePath);
    mkdirSync(storePath);
    expect(await refusal()).toBe(unreadable(storePath));

    rmSync(storePath, { recursive: true });
    store({ ...signedIn(), padding: 'x'.repeat(1024 * 1024) });
    expect(await refusal()).toBe(unreadable(storePath));

    expect(await refusal({ CLINE_PROVIDER_SETTINGS_PATH: 'relative/providers.json' })).toBe(unreadable('relative/providers.json'));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names both routes when the store is not the user\'s to read', async () => {
    store(signedIn());
    chmodSync(storePath, 0o000);
    expect(await refusal()).toBe(`${NONE}\`${storePath}\` could not be read. ${ROUTES}`);
  });

  it('names both routes when the store is signed out: no provider last used, no entry for it, or an entry with no key', async () => {
    store({ version: 1, providers: {} });
    expect(await refusal()).toBe(`${NONE}\`${storePath}\` names no provider it last used. ${ROUTES}`);

    store({ version: 1, lastUsedProvider: 'openrouter', providers: { anthropic: signedIn().providers.anthropic } });
    expect(await refusal()).toBe(`${NONE}the provider it last used (openrouter) has no key in \`${storePath}\`. ${ROUTES}`);

    store({ version: 1, lastUsedProvider: 'openrouter', providers: { openrouter: { settings: { provider: 'openrouter', apiKey: '', model: 'm' } } } });
    expect(await refusal()).toBe(`${NONE}the provider it last used (openrouter) has no key in \`${storePath}\`. ${ROUTES}`);
  });

  it('reads the store afresh for each spawn, so a sign-in between two is the second\'s', async () => {
    const credentials = clineCredentials({ homedir: () => home });
    store(signedIn());
    const first = await credentials({ env: {}, kind: 'task' });
    store(signedIn('anthropic'));
    const second = await credentials({ env: {}, kind: 'planner' });

    expect(first?.CLINE_API_KEY).toBe(KEY);
    expect(second?.CLINE_API_KEY).toBe(OTHER_KEY);
  });
});

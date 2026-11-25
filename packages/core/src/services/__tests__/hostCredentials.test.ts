import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IConfig } from '../../interfaces/IConfig';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { removeDir, setEnv } from '../../testEnv';
import { PROVIDER_PRIORITY, VENDORS } from '../apiProviders';
import { setHostCredentials, withHostCredentials } from '../hostCredentials';
import { defaultEnabledRunners, resetInstalledPlanner } from '../InstalledPlanner';
import { ModelResolver } from '../ModelResolver';
import { RunnerInstallation } from '../RunnerInstallation';
import { OrdewellAdapter } from '../harness/ordewell/OrdewellAdapter';
import { MemoryTranscriptStore, scriptedClient, STOP } from '../harness/ordewell/__tests__/loopKit';

/*
 * VS Code holds the keys a user enters in its SecretStorage, never in the
 * extension host's environment, where every spawned process and every other
 * extension would inherit them. The built-in runner reads them all the same
 * (ADR-0070): listed, enabled, given its catalog and started on the key the
 * host lends it, with the environment left as it was.
 */

const CREDENTIALS = PROVIDER_PRIORITY.flatMap((p) => [VENDORS[p].apiKeyEnvVar, ...VENDORS[p].detectEnvVars, ...(VENDORS[p].baseUrlEnvVar ? [VENDORS[p].baseUrlEnvVar] : [])]);

let restoreEnv: () => void = () => {};
const dirs: string[] = [];

beforeEach(() => {
  restoreEnv = setEnv(Object.fromEntries(CREDENTIALS.map((name) => [name, undefined])));
});

afterEach(async () => {
  setHostCredentials(undefined);
  resetInstalledPlanner();
  restoreEnv();
  while (dirs.length) await removeDir(dirs.pop()!);
});

const installation = () => new RunnerInstallation(new RunnerRegistry(), vi.fn(async () => ({ stdout: '' })));

describe('provider credentials a host holds outside its environment', () => {
  it('list, sign in and enable the provider runner, read afresh, with no key in the environment', async () => {
    const held: Record<string, string> = {};
    setHostCredentials(() => held);
    const probe = installation();
    expect(await probe.isInstalled('anthropic')).toBe(false);
    expect(defaultEnabledRunners()).toEqual(['claude-code']);

    held.ANTHROPIC_API_KEY = 'sk-ant-held';
    expect(await probe.filterInstalled([...PROVIDER_PRIORITY])).toEqual(['anthropic']);
    expect(await probe.runnerUsability('anthropic')).toEqual({ usable: true, auth: { state: 'signed-in' } });
    expect(defaultEnabledRunners()).toEqual(['anthropic']);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('fetch the provider runner\'s catalog with the held key', async () => {
    setHostCredentials(() => ({ OPENROUTER_API_KEY: 'sk-or-held' }));
    const authorizations: (string | null)[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization'));
      return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const resolver = new ModelResolver(new RunnerRegistry(), {} as IConfig, { fetchImpl, execImpl: vi.fn(async () => ({ stdout: '' })) });

    const { openrouter } = await resolver.modelsForRunners(['openrouter']);

    expect(openrouter?.map((m) => m.modelId)).toEqual(['openrouter:openai/gpt-4o-mini']);
    expect(authorizations).toEqual(['Bearer sk-or-held']);
  });

  it('start the runner on the held key, over a key the environment holds', async () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-from-env' });
    setHostCredentials(() => ({ OPENROUTER_API_KEY: 'sk-or-held' }));
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-host-credentials-')));
    dirs.push(dir);
    const clients: string[] = [];
    const adapter = new OrdewellAdapter('openrouter', {
      spawn: () => { throw new Error('The in-process runner spawned a process.'); },
      fetch: async () => { throw new Error('offline'); },
      workspaceEnv: async () => ({}),
    }, {
      modelInfoTimeoutMs: 50,
      openStore: () => new MemoryTranscriptStore('the-session', dir),
      createClient: (_provider, apiKey) => {
        clients.push(apiKey);
        return scriptedClient([[STOP]]);
      },
    });

    await adapter.start({ kind: 'task', cwd: dir, model: 'openrouter:mock/test', mode: 'full', flags: { permissionMode: 'full', modeSettings: {} } });
    adapter.dispose();

    expect(clients).toEqual(['sk-or-held']);
    expect(process.env.OPENROUTER_API_KEY).toBe('sk-or-from-env');
  });

  // A credential the host holds only as a fallback (VS Code's ~/.ordewell/.env key) is decided against what the start reads.
  it('show the reader the environment the runner starts under, the workspace\'s included, and start where it lends', async () => {
    const seen: (string | undefined)[] = [];
    setHostCredentials((env): Record<string, string> => {
      seen.push(env.OPENROUTER_BASE_URL);
      return env.OPENROUTER_API_KEY ? {} : { OPENROUTER_API_KEY: 'sk-or-saved', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' };
    });
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-host-credentials-')));
    dirs.push(dir);
    const clients: { apiKey: string; baseUrl: string | undefined }[] = [];
    const adapter = new OrdewellAdapter('openrouter', {
      spawn: () => { throw new Error('The in-process runner spawned a process.'); },
      fetch: async () => { throw new Error('offline'); },
      workspaceEnv: async () => ({ OPENROUTER_BASE_URL: 'https://attacker.example/v1' }),
    }, {
      modelInfoTimeoutMs: 50,
      openStore: () => new MemoryTranscriptStore('the-session', dir),
      createClient: (_provider, apiKey, baseUrl) => {
        clients.push({ apiKey, baseUrl });
        return scriptedClient([[STOP]]);
      },
    });

    await adapter.start({ kind: 'task', cwd: dir, model: 'openrouter:mock/test', mode: 'full', flags: { permissionMode: 'full', modeSettings: {} } });
    adapter.dispose();

    expect(seen).toContain('https://attacker.example/v1');
    expect(clients).toEqual([{ apiKey: 'sk-or-saved', baseUrl: 'https://openrouter.ai/api/v1' }]);
  });

  it('leave the environment as it is when the host holds none', () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-from-env' });
    const env = { ...process.env };
    expect(withHostCredentials(env)).toBe(env);
    setHostCredentials(() => ({}));
    expect(withHostCredentials(env)).toBe(env);
  });
});

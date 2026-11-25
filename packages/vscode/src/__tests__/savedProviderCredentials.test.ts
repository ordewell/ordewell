import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  collectProviderCredentials, getProviderMeta, globalEnvFile, ModelResolver, PROVIDER_PRIORITY, resetInstalledPlanner,
  RunnerInstallation, RunnerRegistry, setHostCredentials, withHostCredentials, workspaceEnvOf,
} from '@ordewell/core';
import { homeEnv, setEnv } from '@ordewell/core/testing';
import { __resetConfig, __setConfig, __setWorkspaceConfig } from '../test/vscode.mock';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { SecretStore } from '../adapters/SecretStore';
import { PlannerSelection } from '../PlannerSelection';
import { ModelDiscovery, type ModelDiscoveryDeps } from '../ModelDiscovery';

// Fake credentials only: nothing here is a real key, and no request leaves the stubbed fetch.
const SAVED_KEY = 'sk-or-saved-FAKE-0000';
const OPENROUTER = 'https://openrouter.ai/api/v1';

/** Every variable a provider key or endpoint is read under, cleared so the developer's shell cannot leak in. */
const CREDENTIAL_VARS = PROVIDER_PRIORITY.flatMap((provider) => {
  const meta = getProviderMeta(provider);
  return [meta.apiKeyEnvVar, ...meta.detectEnvVars, ...(meta.baseUrlEnvVar ? [meta.baseUrlEnvVar] : [])];
});

async function makeStore(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const store = new SecretStore({
    async get(k: string) { return map.get(k); },
    async store(k: string, v: string) { map.set(k, v); },
    async delete(k: string) { map.delete(k); },
    onDidChange() { return { dispose() {} }; },
  } as never);
  await store.load();
  return { store, map };
}

/** A fetch that answers every catalog request with nothing, recording where each went and with which key. */
function recordingFetch() {
  const requests: { url: string; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    requests.push({ url, auth: headers.get('authorization') ?? headers.get('x-api-key') });
    return new Response('{"error":"stub"}', { status: 503, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

let home: string;
let ws: string;
let restoreEnv: () => void;

function saveGlobal(lines: string): void {
  fs.mkdirSync(path.dirname(globalEnvFile()), { recursive: true });
  fs.writeFileSync(globalEnvFile(), lines);
}

/** The extension's composition as extension.ts builds it, over a stubbed fetch and no CLI. */
async function host(secrets: Record<string, string> = {}) {
  const { store, map } = await makeStore(secrets);
  const config = new VsCodeConfig(store);
  setHostCredentials((env) => config.heldProviderEnv(env));
  const registry = new RunnerRegistry();
  const runnerEnv = async () => ({ ...process.env, ...(await workspaceEnvOf(ws)) });
  const { requests, fetchImpl } = recordingFetch();
  const exec = async () => { throw new Error('no CLI in this test'); };
  const modelResolver = new ModelResolver(registry, config, { env: runnerEnv, fetchImpl, execImpl: exec as never });
  const installation = new RunnerInstallation(registry, exec as never, undefined, { env: () => workspaceEnvOf(ws), workspace: () => ws });
  const planner = new PlannerSelection({
    config, modelResolver, plannerModelMemory: {} as never, runnerInstallation: installation,
    chatProvider: {} as never, sendModelConfig: () => {}, log: () => {},
  });
  const pushed = { providers: [] as string[], runners: [] as string[] };
  const chatProvider = new Proxy({
    sendConfiguredProviders: (providers: string[]) => { pushed.providers = providers; },
    setRunnerList: (list: { id: string }[]) => { pushed.runners = list.map((r) => r.id); },
  }, { get: (t, k) => (k in t ? Reflect.get(t, k) : k === 'then' ? undefined : () => {}) });
  const discovery = new ModelDiscovery({
    vscodeApi: { window: { showWarningMessage: vi.fn() } } as never,
    config, runnerRegistry: registry, runnerInstallation: installation, modelResolver,
    chatProvider: chatProvider as never, modelAllowlist: () => ({}), secretStore: store,
    log: () => {}, refreshPlannerState: async () => {}, onApiKeySaved: async () => { modelResolver.invalidate(); },
  } satisfies ModelDiscoveryDeps);
  return { config, store, map, modelResolver, installation, planner, discovery, pushed, requests };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-saved-home-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-saved-ws-'));
  restoreEnv = setEnv({
    ...homeEnv(home),
    ORDEWELL_SETTINGS_PATH: path.join(home, 'settings.json'),
    ORDEWELL_DIRENV: 'false',
    ...Object.fromEntries(CREDENTIAL_VARS.map((name) => [name, undefined])),
  });
  __resetConfig();
  resetInstalledPlanner();
});

afterEach(() => {
  setHostCredentials(undefined);
  restoreEnv();
  __resetConfig();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('a provider key saved in ~/.ordewell/.env (Desktop, TUI /key-set)', () => {
  // Bug: VS Code read only SecretStorage, its settings and the host environment, so a key saved from Desktop or the TUI showed in neither picker.
  it('makes OpenRouter a pickable planner and built-in runner at startup, on its key and endpoint', async () => {
    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);
    const h = await host();

    expect(h.config.configuredProviders).toContain('openrouter');
    expect((await h.planner.backends()).map((b) => b.id)).toContain('openrouter');
    expect(await h.installation.isInstalled('openrouter')).toBe(true);

    // The planner's transport reads these.
    expect(h.config.getProviderApiKey('openrouter')).toBe(SAVED_KEY);
    expect(h.config.getProviderBaseUrl('openrouter')).toBe(OPENROUTER);
    expect(collectProviderCredentials(h.config)).toEqual({ apiKeys: { openrouter: SAVED_KEY }, baseUrls: { openrouter: OPENROUTER } });

    // The built-in runner's catalog goes where its start goes, with the same key.
    await h.modelResolver.modelsForRunners(['openrouter']);
    expect(h.requests.length).toBeGreaterThan(0);
    for (const request of h.requests) {
      expect(request.url.startsWith(OPENROUTER)).toBe(true);
      expect(request.auth).toBe(`Bearer ${SAVED_KEY}`);
    }
    // Lent to the runner, never put in the host's environment or VS Code's own store.
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(h.map.size).toBe(0);
  });

  it('is read again on the discovery refresh: a key saved, replaced or removed since shows as it now is', async () => {
    const h = await host();
    await h.discovery.refresh();
    expect(h.pushed.providers).not.toContain('openrouter');
    expect(h.pushed.runners).not.toContain('openrouter');

    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);
    await h.discovery.refresh();
    expect(h.pushed.providers).toContain('openrouter');
    expect(h.pushed.runners).toContain('openrouter');

    saveGlobal('OPENROUTER_API_KEY=sk-or-replaced-FAKE-1111\n');
    await h.discovery.refresh();
    expect(h.config.getProviderApiKey('openrouter')).toBe('sk-or-replaced-FAKE-1111');
    expect(withHostCredentialsKey()).toBe('sk-or-replaced-FAKE-1111');

    fs.rmSync(globalEnvFile());
    await h.discovery.refresh();
    expect(h.pushed.providers).not.toContain('openrouter');
    expect(h.pushed.runners).not.toContain('openrouter');
    expect(await h.installation.isInstalled('openrouter')).toBe(false);
  });

  it('gives way to SecretStorage, the setting and the host environment, for the planner and the runner alike', async () => {
    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);

    const fromStore = await host({ openrouterKey: 'sk-or-store-FAKE' });
    expect(fromStore.config.getProviderApiKey('openrouter')).toBe('sk-or-store-FAKE');
    expect(withHostCredentialsKey()).toBe('sk-or-store-FAKE');

    __setConfig({ openAiApiKey: 'sk-or-setting-FAKE' });
    const fromSetting = await host();
    expect(fromSetting.config.getProviderApiKey('openrouter')).toBe('sk-or-setting-FAKE');
    expect(withHostCredentialsKey()).toBe('sk-or-setting-FAKE');
    __resetConfig();

    process.env.OPENROUTER_API_KEY = 'sk-or-shell-FAKE';
    const fromShell = await host();
    expect(fromShell.config.getProviderApiKey('openrouter')).toBe('sk-or-shell-FAKE');
    expect(fromShell.config.openrouterKey).toBe('sk-or-shell-FAKE');
    expect(withHostCredentialsKey()).toBe('sk-or-shell-FAKE');
  });

  it('cannot be sent elsewhere by a workspace setting or workspace env, and keeps the endpoint it was saved with', async () => {
    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);
    __setWorkspaceConfig({ openAiBaseUrl: 'https://attacker.example/v1' });
    fs.mkdirSync(path.join(ws, '.ordewell'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.ordewell', 'env'), 'OPENROUTER_BASE_URL=https://attacker.example/v1\n');

    const h = await host();
    expect(h.config.getProviderBaseUrl('openrouter')).toBe(OPENROUTER);
    expect(h.config.openAiBaseUrl).toBe(OPENROUTER);
    expect(collectProviderCredentials(h.config).baseUrls.openrouter).toBe(OPENROUTER);
    await h.modelResolver.modelsForRunners(['openrouter']);
    await h.modelResolver.pickerOptions();
    expect(h.requests.length).toBeGreaterThan(0);
    expect(h.requests.filter((r) => !r.url.startsWith(OPENROUTER))).toEqual([]);

    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\nOPENROUTER_BASE_URL=https://gateway.example/v1\n`);
    const gateway = await host();
    expect(gateway.config.getProviderBaseUrl('openrouter')).toBe('https://gateway.example/v1');
    await gateway.modelResolver.modelsForRunners(['openrouter']);
    expect(gateway.requests.length).toBeGreaterThan(0);
    expect(gateway.requests.every((r) => r.url.startsWith('https://gateway.example/v1') && r.auth === `Bearer ${SAVED_KEY}`)).toBe(true);
  });

  it('leaves a workspace env key the runner\'s alone, and never the planner\'s', async () => {
    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);
    fs.mkdirSync(path.join(ws, '.ordewell'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.ordewell', 'env'), 'OPENROUTER_API_KEY=sk-or-workspace-FAKE\n');

    const h = await host();
    expect(h.config.getProviderApiKey('openrouter')).toBe(SAVED_KEY);
    await h.modelResolver.modelsForRunners(['openrouter']);
    expect(h.requests.length).toBeGreaterThan(0);
    expect(h.requests.every((r) => r.auth === 'Bearer sk-or-workspace-FAKE')).toBe(true);
  });

  it('keeps each key its own provider\'s, and reads no variable but a provider credential from the file', async () => {
    saveGlobal('OPENAI_API_KEY=sk-openai-saved-FAKE\nAI_PROVIDER=openrouter\nORCHESTRATOR_MODEL=fake/model\n');

    const h = await host();
    expect(h.config.configuredProviders).toEqual(['openai']);
    expect(h.config.getProviderApiKey('openrouter')).toBe('');
    expect(h.config.openrouterKey).toBe('');
    expect(h.config.openaiApiKey).toBe('sk-openai-saved-FAKE');
    expect(await h.installation.isInstalled('openai')).toBe(true);
    expect(await h.installation.isInstalled('openrouter')).toBe(false);
    expect(h.config.rawAiProvider).toBe('');
    expect(process.env.AI_PROVIDER).toBeUndefined();
  });

  it('starts with no saved keys when the file is missing or cannot be read', async () => {
    expect(fs.existsSync(globalEnvFile())).toBe(false);
    expect((await host()).config.configuredProviders).toEqual([]);

    // A directory where the file should be: reading it throws.
    fs.mkdirSync(globalEnvFile(), { recursive: true });
    const h = await host();
    expect(h.config.configuredProviders).toEqual([]);
    await expect(h.discovery.refresh()).resolves.toBeUndefined();
  });

  it('pairs Custom\'s saved key with its saved endpoint, and sends it to no other', async () => {
    saveGlobal('OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:9/v1\nOPENAI_COMPATIBLE_API_KEY=sk-custom-saved-FAKE\n');
    const saved = await host();
    expect(saved.config.configuredProviders).toContain('openai_compatible');
    expect(saved.config.getProviderBaseUrl('openai_compatible')).toBe('http://127.0.0.1:9/v1');
    expect(saved.config.getProviderApiKey('openai_compatible')).toBe('sk-custom-saved-FAKE');
    expect(await saved.installation.isInstalled('openai_compatible')).toBe(true);

    // A key this window stored for an endpoint of its own is not sent to the saved one.
    saveGlobal('OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:9/v1\n');
    const stale = await host({ openaiCompatibleKey: 'sk-custom-store-FAKE' });
    expect(stale.config.getProviderBaseUrl('openai_compatible')).toBe('http://127.0.0.1:9/v1');
    expect(stale.config.getProviderApiKey('openai_compatible')).toBe('');
    expect(stale.config.openaiCompatibleApiKey).toBe('');
    expect(withHostCredentialsKey('openai_compatible')).toBe('');
    saveGlobal('OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:9/v1\nOPENAI_COMPATIBLE_API_KEY=sk-custom-saved-FAKE\n');

    // The user's own endpoint wins, and the key saved for another one stays behind.
    __setConfig({ openaiCompatibleBaseUrl: 'http://127.0.0.1:10/v1' });
    const own = await host();
    expect(own.config.getProviderBaseUrl('openai_compatible')).toBe('http://127.0.0.1:10/v1');
    expect(own.config.getProviderApiKey('openai_compatible')).toBe('');
    expect(withHostCredentialsKey('openai_compatible')).toBe('');
  });
});

/** The key the built-in runner would start with, as its start reads it (OrdewellAdapter.start). */
function withHostCredentialsKey(provider: 'openrouter' | 'openai_compatible' = 'openrouter'): string {
  const env = withHostCredentials({ ...process.env });
  return env[getProviderMeta(provider).apiKeyEnvVar] ?? '';
}


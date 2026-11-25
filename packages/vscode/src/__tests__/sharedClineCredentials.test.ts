import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getProviderMeta, globalEnvFile, ModelResolver, PROVIDER_PRIORITY, resetInstalledPlanner, resetRunnerAuth, RunnerInstallation, RunnerRegistry,
  runnerChoice, runnerReadiness, SettingsService, setHostCredentials, setSharedProviderCredentials, withHostCredentials, workspaceEnvOf,
} from '@ordewell/core';
import { homeEnv, setEnv } from '@ordewell/core/testing';
import { __resetConfig, __setConfig, __setWorkspaceConfig } from '../test/vscode.mock';
import { lendHeldCredentials, VsCodeConfig } from '../adapters/VsCodeConfig';
import { SecretStore } from '../adapters/SecretStore';
import { ModelDiscovery, type ModelDiscoveryDeps } from '../ModelDiscovery';

/*
 * Cline is handed a provider key over its environment, never over ACP, and
 * the TUI and Desktop's daemon have the keys saved in `~/.ordewell/.env` in
 * theirs. VS Code keeps that file out of its environment, so the same saved
 * key read as ready in the terminal and "API key needed" here (#61 F1). Fake
 * keys only, a fake home, and no Cline is ever run.
 */

const SAVED_KEY = 'sk-or-saved-FAKE-cline-0000';
const OPENROUTER = 'https://openrouter.ai/api/v1';

const CREDENTIAL_VARS = [
  ...PROVIDER_PRIORITY.flatMap((provider) => {
    const meta = getProviderMeta(provider);
    return [meta.apiKeyEnvVar, ...meta.detectEnvVars, ...(meta.baseUrlEnvVar ? [meta.baseUrlEnvVar] : [])];
  }),
  'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'CLINE_API_KEY', 'CLINE_PROVIDER', 'CLINE_MODEL', 'CLINE_PROVIDER_SETTINGS_PATH', 'OPENAI_BASE_URL',
];

let home: string;
let ws: string;
let restoreEnv: () => void;
let lent: (() => void) | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-cline-home-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-cline-ws-'));
  restoreEnv = setEnv({
    ...homeEnv(home),
    ORDEWELL_SETTINGS_PATH: path.join(home, 'settings.json'),
    ORDEWELL_DIRENV: 'false',
    ...Object.fromEntries(CREDENTIAL_VARS.map((name) => [name, undefined])),
  });
  __resetConfig();
  resetInstalledPlanner();
  resetRunnerAuth();
});

afterEach(() => {
  lent?.();
  lent = undefined;
  setHostCredentials(undefined);
  setSharedProviderCredentials(undefined);
  restoreEnv();
  __resetConfig();
  resetRunnerAuth();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

function saveGlobal(lines: string): void {
  fs.mkdirSync(path.dirname(globalEnvFile()), { recursive: true });
  fs.writeFileSync(globalEnvFile(), lines, { mode: 0o600 });
}

function workspaceEnvFile(lines: string): void {
  fs.mkdirSync(path.join(ws, '.ordewell'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.ordewell', 'env'), lines);
}

function clineStore(apiKey: string): void {
  const file = path.join(home, '.cline', 'data', 'settings', 'providers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, lastUsedProvider: 'anthropic', providers: { anthropic: { settings: { provider: 'anthropic', apiKey } } } }), { mode: 0o600 });
}

async function makeStore(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const store = new SecretStore({
    async get(k: string) { return map.get(k); },
    async store(k: string, v: string) { map.set(k, v); },
    async delete(k: string) { map.delete(k); },
    onDidChange() { return { dispose() {} }; },
  } as never);
  await store.load();
  return store;
}

/** The extension's composition as extension.ts builds it, with a fake `cline` that lists a model only when handed a key. */
async function host(secrets: Record<string, string> = {}) {
  const secretStore = await makeStore(secrets);
  const config = new VsCodeConfig(secretStore);
  lent = lendHeldCredentials(config);
  const registry = new RunnerRegistry();
  const runnerEnv = async () => ({ ...process.env, ...(await workspaceEnvOf(ws)) });
  const spawns: Record<string, string | undefined>[] = [];
  const acpClient = vi.fn(async (_command: string, _args: string[], options?: { env?: Record<string, string | undefined> }) => {
    spawns.push({ ...options?.env });
    return options?.env?.CLINE_API_KEY ? [{ modelId: 'openrouter/fake', modelLabel: 'Fake' }] : 'signed-out' as const;
  });
  const exec = vi.fn(async (cmd: string) => {
    if (cmd.startsWith('cline')) return { stdout: '3.0.74', stderr: '' };
    throw new Error('not installed');
  });
  const modelResolver = new ModelResolver(registry, config, { env: runnerEnv, workspace: () => ws, acpClient: acpClient as never, execImpl: exec as never });
  const installation = new RunnerInstallation(registry, exec as never, Date.now, { env: () => workspaceEnvOf(ws), workspace: () => ws, authExec: exec as never });
  const chatProvider = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : () => {}) });
  const discovery = new ModelDiscovery({
    vscodeApi: { window: { showWarningMessage: vi.fn() } } as never,
    config, runnerRegistry: registry, runnerInstallation: installation, modelResolver,
    chatProvider: chatProvider as never, modelAllowlist: () => ({}), secretStore,
    log: () => {}, refreshPlannerState: async () => {}, onApiKeySaved: async () => { modelResolver.invalidate(); },
  } satisfies ModelDiscoveryDeps);
  const hook = (name: string) => registry.getManifest(name)!.modelDiscovery.acp!.credentials!;
  /** What the hook hands a spawn of `kind`, under the variables AcpAdapter reads it with. */
  const handed = async (kind: 'planner' | 'task', runner = 'cline') => hook(runner)({ env: { ...process.env, ...(await workspaceEnvOf(ws)) }, kind });
  async function readiness() {
    await modelResolver.modelsForRunners(['cline']);
    const ready = runnerReadiness(await installation.runnerUsability('cline'), modelResolver.getRunnerUnlisted().cline);
    return runnerChoice(ready).text;
  }
  return { config, modelResolver, discovery, spawns, handed, readiness };
}

const handedKeys = (spawns: Record<string, string | undefined>[]) => spawns.map((env) => Object.entries(env).filter(([, v]) => v === SAVED_KEY).map(([k]) => k));

describe('Cline on a key saved in Ordewell\'s shared store (~/.ordewell/.env)', () => {
  it('is ready with no Cline store, and its planner\'s and task\'s spawns get the key as Cline\'s alone', async () => {
    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);
    const h = await host();

    expect(await h.readiness()).toBe(runnerChoice({ kind: 'ready' }).text);
    expect(handedKeys(h.spawns)).toEqual([['CLINE_API_KEY']]);
    expect(h.spawns[0]).toMatchObject({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: SAVED_KEY });
    for (const kind of ['planner', 'task'] as const) {
      expect(await h.handed(kind)).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: SAVED_KEY });
    }
    // Never put into the extension host's environment, which every child and extension inherits.
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(process.env.CLINE_API_KEY).toBeUndefined();
  });

  it('turns ready on the deliberate refresh after the key is saved from Desktop or the TUI, and back once it is removed', async () => {
    const h = await host();
    expect(await h.readiness()).toBe('API key needed');
    expect(h.spawns).toEqual([]);

    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);
    await h.discovery.refresh();
    expect(await h.readiness()).toBe(runnerChoice({ kind: 'ready' }).text);
    expect(await h.handed('task')).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: SAVED_KEY });

    fs.rmSync(globalEnvFile());
    await h.discovery.refresh();
    await expect(h.handed('task')).rejects.toThrow('Cline has no provider key Ordewell can hand it');
  });

  it('is not sent to Cline from a custom endpoint it was saved with, whatever the workspace names', async () => {
    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\nOPENROUTER_BASE_URL=https://gateway.example/v1\n`);
    workspaceEnvFile(`OPENROUTER_BASE_URL=${OPENROUTER}\n`);
    __setWorkspaceConfig({ openAiBaseUrl: OPENROUTER });
    const h = await host();

    expect(await h.readiness()).toBe('API key needed');
    expect(h.spawns).toEqual([]);
    await expect(h.handed('planner')).rejects.toThrow('Cline has no provider key Ordewell can hand it');
  });

  it('gives way to the user\'s own Cline variables and to a workspace\'s own key, and comes before Cline\'s own store', async () => {
    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);
    clineStore('sk-ant-cline-store-FAKE');
    const h = await host();
    // As the daemon reads it: a key configured in Ordewell, then Cline's store.
    expect(await h.handed('task')).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: SAVED_KEY });

    workspaceEnvFile('OPENROUTER_API_KEY=sk-or-workspace-FAKE\n');
    expect(await h.handed('task')).toEqual({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: 'sk-or-workspace-FAKE' });

    workspaceEnvFile('CLINE_PROVIDER=anthropic\nCLINE_API_KEY=sk-ant-user-FAKE\n');
    expect(await h.handed('task')).toBeNull();

    // With nothing saved, Cline's own store answers as before.
    fs.rmSync(path.join(ws, '.ordewell', 'env'));
    fs.rmSync(globalEnvFile());
    h.config.reloadSavedCredentials();
    expect(await h.handed('task')).toEqual({ CLINE_PROVIDER: 'anthropic', CLINE_API_KEY: 'sk-ant-cline-store-FAKE' });
  });

  it('never reaches Cline from VS Code\'s own SecretStorage or settings, which stay the built-in runner\'s', async () => {
    __setConfig({ openAiApiKey: 'sk-or-setting-FAKE' });
    const h = await host({ anthropicKey: 'sk-ant-secret-FAKE' });

    expect(await h.readiness()).toBe('API key needed');
    expect(h.spawns).toEqual([]);
    await expect(h.handed('planner')).rejects.toThrow('Cline has no provider key Ordewell can hand it');
    // Still lent where they are today.
    expect(withHostCredentials<Record<string, string | undefined>>({}).OPENROUTER_API_KEY).toBe('sk-or-setting-FAKE');
    expect(withHostCredentials<Record<string, string | undefined>>({}).ANTHROPIC_API_KEY).toBe('sk-ant-secret-FAKE');
  });

  it('is handed to no other agent: Qwen\'s hook never sees the saved key', async () => {
    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);
    new SettingsService().setEnabledRunners(['cline', 'qwen']);
    const h = await host();

    const qwen = await h.handed('task', 'qwen').then((answer) => answer, () => null);
    expect(JSON.stringify(qwen ?? {})).not.toContain(SAVED_KEY);
  });

  it('is lent no longer once the extension lets it go', async () => {
    saveGlobal(`OPENROUTER_API_KEY=${SAVED_KEY}\n`);
    const h = await host();
    lent?.();
    lent = undefined;
    await expect(h.handed('task')).rejects.toThrow('Cline has no provider key Ordewell can hand it');
    expect(withHostCredentials<Record<string, string | undefined>>({}).OPENROUTER_API_KEY).toBeUndefined();
  });
});

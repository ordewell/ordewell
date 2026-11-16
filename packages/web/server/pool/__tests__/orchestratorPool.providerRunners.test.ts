import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PROVIDER_PRIORITY, RunnerInstallation, getProviderMeta, globalEnvFile, isProviderRunner, resetInstalledPlanner } from '@ordewell/core';
import { setEnv } from '@ordewell/core/testing';
import { OrchestratorPool } from '../orchestratorPool';
import { loadSavedCredentials, saveCredentials } from '../../utils/savedCredentials';

/*
 * The built-in runner is one runner per provider (ADR-0070), listed only while
 * its provider is configured: a provider with no key has no row, so no surface
 * shows it signed out or offers a Log in for it.
 */

const CREDENTIALS = PROVIDER_PRIORITY.flatMap((p) => {
  const meta = getProviderMeta(p);
  return [meta.apiKeyEnvVar, ...meta.detectEnvVars, ...(meta.baseUrlEnvVar ? [meta.baseUrlEnvVar] : [])];
});
const realIsInstalled = RunnerInstallation.prototype.isInstalled;

let dir: string;
let restoreEnv: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ordewell-provider-runners-'));
  restoreEnv = setEnv({
    ...Object.fromEntries(CREDENTIALS.map((name) => [name, undefined])),
    AI_PROVIDER: undefined, ORCHESTRATOR_MODEL: undefined, ORDEWELL_ENABLED_RUNNERS: undefined, ORDEWELL_MAX_PARALLEL: undefined,
    ORDEWELL_CLAUDE_CODE_ENABLED: undefined, ORDEWELL_CODEX_ENABLED: undefined, ORDEWELL_OPENCODE_ENABLED: undefined,
    ORDEWELL_SETTINGS_PATH: join(dir, 'settings.json'),
  });
  // The file's home is this test file's own; each case starts without one.
  rmSync(globalEnvFile(), { force: true });
  // The coding agents this machine happens to have are not what this is about:
  // only the provider runners answer, by the real rule.
  vi.spyOn(RunnerInstallation.prototype, 'isInstalled').mockImplementation(function (this: RunnerInstallation, runner: string) {
    return isProviderRunner(runner) ? realIsInstalled.call(this, runner) : Promise.resolve(false);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetInstalledPlanner();
  restoreEnv();
  rmSync(dir, { recursive: true, force: true });
});

const pool = () => new OrchestratorPool({ codexSandbox: { ensure: async () => undefined, refresh: async () => undefined } });

describe('the daemon\'s runner list', () => {
  it('has no provider runner while no provider has a key, and no runner called Ordewell', async () => {
    const p = pool();
    const runners = await p.getInstalledRunners();
    expect(runners).toEqual([]);
    p.destroyAll();
  });

  it('lists a keyed provider under its own id and name, signed in, unable to plan, with nothing to sign in to', async () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test' });
    const p = pool();
    expect(await p.getInstalledRunners()).toEqual([
      { id: 'openrouter', name: 'OpenRouter', enabled: true, auth: { state: 'signed-in' }, plans: false, provider: 'openrouter' },
    ]);
    p.destroyAll();
  });

  it('lists two keyed providers as two runners, both enabled while the user has saved no choice', async () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: 'sk-ant-test' });
    const p = pool();
    const runners = await p.getInstalledRunners();
    expect(runners.map((r) => [r.id, r.name, r.enabled, r.provider])).toEqual([
      ['openrouter', 'OpenRouter', true, 'openrouter'],
      ['anthropic', 'Anthropic', true, 'anthropic'],
    ]);
    expect(p.getRunnerState().enabledRunners).toEqual(['openrouter', 'anthropic']);
    p.destroyAll();
  });

  it('lists a key set through the settings route at the next look, and never rewrites a saved choice to enable it', async () => {
    const p = pool();
    p.setRunnerEnabled('claude-code', true);
    expect(await p.getInstalledRunners()).toEqual([]);

    p.updateSettings({ env: { GEMINI_API_KEY: 'g-test' } });

    expect(await p.getInstalledRunners()).toEqual([expect.objectContaining({ id: 'google', name: 'Google Gemini', enabled: false, provider: 'google' })]);
    expect(p.getRunnerState().enabledRunners).toEqual(['claude-code']);
    p.destroyAll();
  });

  it('marks a coding agent that plans as able to, and carries no provider on it', async () => {
    vi.mocked(RunnerInstallation.prototype.isInstalled).mockImplementation(async (runner: string) => runner === 'claude-code');
    vi.spyOn(RunnerInstallation.prototype, 'runnerUsability').mockResolvedValue({ usable: true, auth: { state: 'unknown' } });
    const p = pool();
    const [claude] = await p.getInstalledRunners();
    expect(claude).toMatchObject({ id: 'claude-code', plans: true });
    expect(claude).not.toHaveProperty('provider');
    p.destroyAll();
  });
});

describe('a provider key set through the daemon', () => {
  it('is saved to the global .env, so a daemon started again loads it', () => {
    const p = pool();
    p.updateSettings({ env: { OPENROUTER_API_KEY: 'sk-or-saved', OPENROUTER_BASE_URL: 'http://127.0.0.1:1/v1', ORDEWELL_MAX_PARALLEL: '2' } });
    p.destroyAll();

    const saved = readFileSync(globalEnvFile(), 'utf8');
    expect(saved).toContain('OPENROUTER_API_KEY=sk-or-saved\n');
    expect(saved).toContain('OPENROUTER_BASE_URL=http://127.0.0.1:1/v1\n');
    // Only credentials: anything else a write sets is this daemon's alone.
    expect(saved).not.toContain('ORDEWELL_MAX_PARALLEL');
    if (process.platform !== 'win32') expect(statSync(globalEnvFile()).mode & 0o777).toBe(0o600);

    const restarted: NodeJS.ProcessEnv = {};
    loadSavedCredentials(restarted);
    expect(restarted).toMatchObject({ OPENROUTER_API_KEY: 'sk-or-saved', OPENROUTER_BASE_URL: 'http://127.0.0.1:1/v1' });
  });

  it('replaces the key it saved before, and keeps the file\'s other lines', () => {
    writeFileSync(globalEnvFile(), '# mine\nAI_PROVIDER=claude-code\nOPENROUTER_API_KEY=old\n');
    const p = pool();
    p.updateSettings({ env: { OPENROUTER_API_KEY: 'new' } });
    p.destroyAll();
    expect(readFileSync(globalEnvFile(), 'utf8')).toBe('# mine\nAI_PROVIDER=claude-code\nOPENROUTER_API_KEY=new\n');
  });

  it('is not saved from an inherited write: a key the client\'s shell exported stays that shell\'s', () => {
    const p = pool();
    p.updateSettings({ env: { OPENROUTER_API_KEY: 'sk-or-shell' }, inherited: true });
    p.destroyAll();
    expect(() => readFileSync(globalEnvFile(), 'utf8')).toThrow();
  });

  it('loads only credentials, and never over a variable the daemon was started with', () => {
    writeFileSync(globalEnvFile(), 'OPENROUTER_API_KEY=from-file\nANTHROPIC_API_KEY="quoted"\nAI_PROVIDER=claude-code\nPATH=/evil\n');
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'from-shell' };
    loadSavedCredentials(env);
    expect(env).toEqual({ OPENROUTER_API_KEY: 'from-shell', ANTHROPIC_API_KEY: 'quoted' });
  });

  it('refuses a value that would write a second line, saving nothing', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    saveCredentials({ OPENROUTER_API_KEY: 'sk-or\nAI_PROVIDER=evil' });
    expect(() => readFileSync(globalEnvFile(), 'utf8')).toThrow();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('line break'));
  });
});

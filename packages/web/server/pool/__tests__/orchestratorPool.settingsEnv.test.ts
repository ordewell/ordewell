import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModelResolver } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

/**
 * The environment write in `updateSettings` sets `process.env` on the daemon,
 * which every runner it spawns inherits. These assert the admission decision
 * and what reached `process.env` — never how the allowlist is spelled.
 */
describe('OrchestratorPool.updateSettings — environment allowlist', () => {
  let dir: string;
  let pool: OrchestratorPool;
  const watched = [
    'ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT',
    'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL',
    'ORDEWELL_AUTONOMOUS_MODE', 'ORDEWELL_APPROVAL_MODE', 'ORDEWELL_APPROVAL_ALLOW',
    'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PATH',
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-env-'));
    for (const key of watched) savedEnv[key] = process.env[key];
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    pool = new OrchestratorPool();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes an allowlisted provider credential', () => {
    pool.updateSettings({ env: { OPENROUTER_API_KEY: 'sk-or-new' } });
    expect(process.env.OPENROUTER_API_KEY).toBe('sk-or-new');
  });

  it('refuses the variables that disable approval prompting', () => {
    const before = process.env.ORDEWELL_AUTONOMOUS_MODE;
    const result = pool.updateSettings({
      env: { ORDEWELL_AUTONOMOUS_MODE: 'true', ORDEWELL_APPROVAL_MODE: 'yolo', ORDEWELL_APPROVAL_ALLOW: 'rm' },
    });

    expect(process.env.ORDEWELL_AUTONOMOUS_MODE).toBe(before);
    expect(process.env.ORDEWELL_APPROVAL_MODE).toBeUndefined();
    expect(process.env.ORDEWELL_APPROVAL_ALLOW).toBeUndefined();
    expect(result.rejectedEnvKeys)
      .toEqual(['ORDEWELL_AUTONOMOUS_MODE', 'ORDEWELL_APPROVAL_MODE', 'ORDEWELL_APPROVAL_ALLOW']);
  });

  it('refuses the settings-path override, which would redirect a recursive mkdir', () => {
    const settingsPath = process.env.ORDEWELL_SETTINGS_PATH;
    const result = pool.updateSettings({ env: { ORDEWELL_SETTINGS_PATH: path.join(dir, 'evil', 'settings.json') } });

    expect(process.env.ORDEWELL_SETTINGS_PATH).toBe(settingsPath);
    expect(result.rejectedEnvKeys).toEqual(['ORDEWELL_SETTINGS_PATH']);
  });

  it('refuses runtime-option, loader and executable-path variables', () => {
    const realPath = process.env.PATH;
    const result = pool.updateSettings({
      env: {
        NODE_OPTIONS: `--require ${path.join(dir, 'pwn.js')}`,
        NODE_PATH: dir,
        LD_PRELOAD: path.join(dir, 'pwn.so'),
        DYLD_INSERT_LIBRARIES: path.join(dir, 'pwn.dylib'),
        PATH: dir,
      },
    });

    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.NODE_PATH).toBeUndefined();
    expect(process.env.LD_PRELOAD).toBeUndefined();
    expect(process.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(process.env.PATH).toBe(realPath);
    expect(result.rejectedEnvKeys)
      .toEqual(['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PATH']);
  });

  it('applies the admitted keys of a mixed write and names only the refused ones', () => {
    const result = pool.updateSettings({
      env: { OPENROUTER_API_KEY: 'sk-or-mixed', NODE_OPTIONS: '--require /tmp/pwn.js' },
    });

    expect(process.env.OPENROUTER_API_KEY).toBe('sk-or-mixed');
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(result.rejectedEnvKeys).toEqual(['NODE_OPTIONS']);
  });

  it('says nothing about rejections when every key was admitted', () => {
    const result = pool.updateSettings({ env: { AI_PROVIDER: 'openrouter' } });
    expect(result.rejectedEnvKeys).toBeUndefined();
  });

  it('invalidates the model catalog on a credential or endpoint change', () => {
    const resolver = new ModelResolver(
      { getManifest: () => undefined } as never,
      { getProviderBaseUrl: () => '', getProviderApiKey: () => '', setProviderModelLists: () => {} } as never,
    );
    const invalidate = vi.spyOn(resolver, 'invalidate');
    vi.spyOn(resolver, 'refreshRunnerModels').mockResolvedValue(undefined as never);
    const p = new OrchestratorPool({ modelResolver: resolver });

    p.updateSettings({ env: { OPENROUTER_API_KEY: 'sk-or-1' } });
    expect(invalidate).toHaveBeenCalledTimes(1);

    p.updateSettings({ env: { OPENROUTER_BASE_URL: 'https://proxy/v1' } });
    expect(invalidate).toHaveBeenCalledTimes(2);
    p.destroyAll();
  });

  it('does not invalidate the model catalog on a planner, model or effort switch', () => {
    const resolver = new ModelResolver(
      { getManifest: () => undefined } as never,
      { getProviderBaseUrl: () => '', getProviderApiKey: () => '', setProviderModelLists: () => {} } as never,
    );
    const invalidate = vi.spyOn(resolver, 'invalidate');
    vi.spyOn(resolver, 'refreshRunnerModels').mockResolvedValue(undefined as never);
    const p = new OrchestratorPool({ modelResolver: resolver });

    p.updateSettings({ env: { AI_PROVIDER: 'codex', ORCHESTRATOR_MODEL: '', ORDEWELL_PLANNER_EFFORT: 'high' } });

    expect(invalidate).not.toHaveBeenCalled();
    p.destroyAll();
  });
});

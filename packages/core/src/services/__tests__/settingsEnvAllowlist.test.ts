import { describe, it, expect } from 'vitest';
import {
  admitSettingsEnv,
  SETTINGS_ENV_ALLOWLIST,
  SETTINGS_ENV_REFUSED,
  PROVIDER_CREDENTIAL_ENV,
} from '../settingsEnvAllowlist';
import { ALL_PROVIDERS } from '../ProviderRegistry';

describe('admitSettingsEnv', () => {
  it('admits a provider credential', () => {
    expect(admitSettingsEnv({ OPENROUTER_API_KEY: 'sk-or-1' })).toEqual({
      accepted: { OPENROUTER_API_KEY: 'sk-or-1' },
      rejected: [],
    });
  });

  it('admits a provider base URL', () => {
    expect(admitSettingsEnv({ OPENAI_COMPATIBLE_BASE_URL: 'https://host/v1' }).accepted)
      .toEqual({ OPENAI_COMPATIBLE_BASE_URL: 'https://host/v1' });
  });

  it('admits the planner configuration a surface actually sends', () => {
    const { accepted, rejected } = admitSettingsEnv({
      AI_PROVIDER: 'codex',
      ORCHESTRATOR_MODEL: 'gpt-x',
      ORDEWELL_PLANNER_EFFORT: 'high',
    });
    expect(rejected).toEqual([]);
    expect(accepted).toEqual({ AI_PROVIDER: 'codex', ORCHESTRATOR_MODEL: 'gpt-x', ORDEWELL_PLANNER_EFFORT: 'high' });
  });

  it('refuses an unknown upper-case key — the old rule admitted every one of these', () => {
    const { accepted, rejected } = admitSettingsEnv({ TOTALLY_MADE_UP: 'x' });
    expect(accepted).toEqual({});
    expect(rejected).toEqual(['TOTALLY_MADE_UP']);
  });

  it('refuses the approval-mode and pre-approved-scope variables', () => {
    const { accepted, rejected } = admitSettingsEnv({
      ORDEWELL_AUTONOMOUS_MODE: 'true',
      ORDEWELL_APPROVAL_MODE: 'yolo',
      ORDEWELL_APPROVAL_ALLOW: 'rm -rf /',
    });
    expect(accepted).toEqual({});
    expect(rejected).toEqual(['ORDEWELL_AUTONOMOUS_MODE', 'ORDEWELL_APPROVAL_MODE', 'ORDEWELL_APPROVAL_ALLOW']);
  });

  it('refuses the settings-path override — the settings service mkdirs recursively for it', () => {
    expect(admitSettingsEnv({ ORDEWELL_SETTINGS_PATH: '/etc/cron.d/pwn' }).rejected)
      .toEqual(['ORDEWELL_SETTINGS_PATH']);
  });

  it('refuses runtime-option, dynamic-loader and executable-path variables', () => {
    const keys = [
      'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'ELECTRON_RUN_AS_NODE',
      'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
      'PATH', 'PATHEXT', 'NODE',
    ];
    const env = Object.fromEntries(keys.map((k) => [k, 'evil']));
    const { accepted, rejected } = admitSettingsEnv(env);
    expect(accepted).toEqual({});
    expect(rejected).toEqual(keys);
  });

  it('refuses a lower-case or mixed-case spelling of a refused key', () => {
    expect(admitSettingsEnv({ node_options: '--require /tmp/x', Path: '/tmp' }).accepted).toEqual({});
  });

  it('reports the refused keys while still applying the admitted ones', () => {
    const { accepted, rejected } = admitSettingsEnv({
      OPENROUTER_API_KEY: 'sk-or-1',
      NODE_OPTIONS: '--require /tmp/x',
    });
    expect(accepted).toEqual({ OPENROUTER_API_KEY: 'sk-or-1' });
    expect(rejected).toEqual(['NODE_OPTIONS']);
  });

  it('refuses a non-string value rather than silently dropping it', () => {
    expect(admitSettingsEnv({ OPENROUTER_API_KEY: 42 }).rejected).toEqual(['OPENROUTER_API_KEY']);
  });
});

describe('SETTINGS_ENV_ALLOWLIST', () => {
  it('never overlaps the refused list', () => {
    for (const key of SETTINGS_ENV_REFUSED) {
      expect(SETTINGS_ENV_ALLOWLIST.has(key)).toBe(false);
    }
  });

  it('covers every registered provider that has a credential', () => {
    for (const meta of Object.values(ALL_PROVIDERS)) {
      if (meta.apiKeyEnvVar) expect(SETTINGS_ENV_ALLOWLIST.has(meta.apiKeyEnvVar)).toBe(true);
      if (meta.baseUrlEnvVar) expect(SETTINGS_ENV_ALLOWLIST.has(meta.baseUrlEnvVar)).toBe(true);
    }
  });

  it('counts credentials and endpoints as catalog-affecting, and planner picks as not', () => {
    expect(PROVIDER_CREDENTIAL_ENV.has('OPENROUTER_API_KEY')).toBe(true);
    expect(PROVIDER_CREDENTIAL_ENV.has('OPENROUTER_BASE_URL')).toBe(true);
    expect(PROVIDER_CREDENTIAL_ENV.has('AI_PROVIDER')).toBe(false);
    expect(PROVIDER_CREDENTIAL_ENV.has('ORCHESTRATOR_MODEL')).toBe(false);
    expect(PROVIDER_CREDENTIAL_ENV.has('ORDEWELL_PLANNER_EFFORT')).toBe(false);
  });
});

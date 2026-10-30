import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SettingsService } from '../../services/SettingsService';
import { getProviderMeta, PROVIDER_DETECT_PRIORITY } from '../../services/ProviderRegistry';
import { recordInstalledPlanner, resetInstalledPlanner } from '../../services/InstalledPlanner';
import { BaseConfig } from '../BaseConfig';
import { AiProvider, PlannerBackendId } from '../IConfig';

class TestConfig extends BaseConfig {
  aiProvider: AiProvider = 'openrouter';
  apiKey = 'test-key';
  planningModel = 'test-model';
  enabledRunners: string[] = [];
  setProviderModelLists(): void {}
}

describe('BaseConfig', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    // wipe known env vars
    for (const key of ['ORDEWELL_RESEARCH_MAX_FILE_SIZE']) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(envBackup)) {
      if (envBackup[key] !== undefined) {
        process.env[key] = envBackup[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe('researchMaxFileSize', () => {
    it('defaults to 50KB when no env var is set', () => {
      const config = new TestConfig();
      expect(config.researchMaxFileSize).toBe(50);
    });

    it('can be overridden via ORDEWELL_RESEARCH_MAX_FILE_SIZE', () => {
      process.env.ORDEWELL_RESEARCH_MAX_FILE_SIZE = '20';
      const config = new TestConfig();
      expect(config.researchMaxFileSize).toBe(20);
    });
  });

  describe('worktree isolation', () => {
    const keys = ['ORDEWELL_WORKTREE_ISOLATION', 'ORDEWELL_WORKTREE_SETUP', 'ORDEWELL_WORKSPACE_REPOS', 'ORDEWELL_WORKTREE_LINKS'];
    const backup: Record<string, string | undefined> = {};
    beforeEach(() => { for (const k of keys) { backup[k] = process.env[k]; delete process.env[k]; } });
    afterEach(() => { for (const k of keys) { if (backup[k] !== undefined) process.env[k] = backup[k]; else delete process.env[k]; } });

    it('is on by default with no setup command', () => {
      const config = new TestConfig();
      expect(config.worktreeIsolation).toBe(true);
      expect(config.worktreeSetupCommand).toBeUndefined();
    });

    it.each(['false', '0'])('ORDEWELL_WORKTREE_ISOLATION=%s turns it off', (value) => {
      process.env.ORDEWELL_WORKTREE_ISOLATION = value;
      expect(new TestConfig().worktreeIsolation).toBe(false);
    });

    it('ORDEWELL_WORKTREE_ISOLATION=true keeps it on', () => {
      process.env.ORDEWELL_WORKTREE_ISOLATION = 'true';
      expect(new TestConfig().worktreeIsolation).toBe(true);
    });

    it('reads the setup command from ORDEWELL_WORKTREE_SETUP and ignores blanks', () => {
      process.env.ORDEWELL_WORKTREE_SETUP = 'npm ci';
      expect(new TestConfig().worktreeSetupCommand).toBe('npm ci');
      process.env.ORDEWELL_WORKTREE_SETUP = '   ';
      expect(new TestConfig().worktreeSetupCommand).toBeUndefined();
    });

    it('has no workspace repos or extra worktree links by default', () => {
      const config = new TestConfig();
      expect(config.workspaceRepos).toEqual([]);
      expect(config.worktreeLinks).toEqual([]);
    });

    it('reads workspace repos and worktree links as comma-separated lists, dropping blanks', () => {
      process.env.ORDEWELL_WORKSPACE_REPOS = 'services/api, web ,,';
      process.env.ORDEWELL_WORKTREE_LINKS = '*.tfstate,.terraform/';
      const config = new TestConfig();
      expect(config.workspaceRepos).toEqual(['services/api', 'web']);
      expect(config.worktreeLinks).toEqual(['*.tfstate', '.terraform/']);
    });
  });

  describe('conflictRepairAttempts', () => {
    const key = 'ORDEWELL_CONFLICT_REPAIR_ATTEMPTS';
    let backup: string | undefined;
    beforeEach(() => { backup = process.env[key]; delete process.env[key]; });
    afterEach(() => { if (backup !== undefined) process.env[key] = backup; else delete process.env[key]; });

    it('allows two repairs per task by default', () => {
      expect(new TestConfig().conflictRepairAttempts).toBe(2);
    });

    it.each([['0', 0], ['1', 1], [' 5 ', 5]])('reads %j from ORDEWELL_CONFLICT_REPAIR_ATTEMPTS', (value, expected) => {
      process.env[key] = value;
      expect(new TestConfig().conflictRepairAttempts).toBe(expected);
    });

    it.each(['-1', '1.5', 'two', ''])('keeps the default for %j, which is not a non-negative integer', (value) => {
      process.env[key] = value;
      expect(new TestConfig().conflictRepairAttempts).toBe(2);
    });
  });

  describe('notifyCommand (ADR-0053)', () => {
    const saved = process.env.ORDEWELL_NOTIFY_COMMAND;
    afterEach(() => {
      if (saved === undefined) delete process.env.ORDEWELL_NOTIFY_COMMAND;
      else process.env.ORDEWELL_NOTIFY_COMMAND = saved;
    });

    it('is empty when the launching environment sets none', () => {
      delete process.env.ORDEWELL_NOTIFY_COMMAND;
      expect(new TestConfig().notifyCommand).toEqual([]);
    });

    it('reads the variable as each escalation appears, not once', () => {
      const config = new TestConfig();
      process.env.ORDEWELL_NOTIFY_COMMAND = '["notify-send", "Ordewell"]';
      expect(config.notifyCommand).toEqual(['notify-send', 'Ordewell']);
      process.env.ORDEWELL_NOTIFY_COMMAND = '["say", "Ordewell"]';
      expect(config.notifyCommand).toEqual(['say', 'Ordewell']);
    });
  });

  describe('plannerNativeShell (ADR-0036 N1)', () => {
    const key = 'ORDEWELL_PLANNER_NATIVE_SHELL';
    let backup: string | undefined;
    beforeEach(() => { backup = process.env[key]; delete process.env[key]; });
    afterEach(() => { if (backup !== undefined) process.env[key] = backup; else delete process.env[key]; });

    it('is off by default', () => {
      expect(new TestConfig().plannerNativeShell).toBe(false);
    });

    it.each(['true', 'TRUE', '1', 'yes', 'on'])('reads %j as on', (value) => {
      process.env[key] = value;
      expect(new TestConfig().plannerNativeShell).toBe(true);
    });

    it.each(['', 'false', '0', 'no', 'off', 'maybe'])('reads %j as off', (value) => {
      process.env[key] = value;
      expect(new TestConfig().plannerNativeShell).toBe(false);
    });
  });

  describe('provider detection & key resolution', () => {
    // Every variable detection reads, so a key in the developer's own shell cannot decide a case.
    const keys = [...new Set(['AI_PROVIDER', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_BASE_URL', ...PROVIDER_DETECT_PRIORITY.flatMap((p) => {
      const meta = getProviderMeta(p);
      return [...meta.detectEnvVars, ...(meta.baseUrlEnvVar ? [meta.baseUrlEnvVar] : [])];
    })])];
    const backup: Record<string, string | undefined> = {};
    beforeEach(() => { for (const k of keys) { backup[k] = process.env[k]; delete process.env[k]; } });
    afterEach(() => {
      for (const k of keys) { if (backup[k] !== undefined) process.env[k] = backup[k]; else delete process.env[k]; }
      resetInstalledPlanner();
    });

    const detect = (config: BaseConfig = new TestConfig()) => (config as unknown as { detectProvider(): PlannerBackendId }).detectProvider();

    it('an explicit AI_PROVIDER wins over an installed coding agent', () => {
      recordInstalledPlanner('claude-code');
      process.env.AI_PROVIDER = 'google';
      expect(detect()).toBe('google');
    });

    it('a vendor key in the environment wins over an installed coding agent', () => {
      recordInstalledPlanner('claude-code');
      process.env.GEMINI_API_KEY = 'gm-key';
      expect(detect()).toBe('google');
    });

    it('an installed coding agent plans when nothing was chosen and no key is set (ADR-0009)', () => {
      recordInstalledPlanner('codex');
      expect(detect()).toBe('codex');
    });

    it('a key the host keeps outside the environment keeps the installed agent out and selects its own vendor', () => {
      // VS Code's secret store, say: a vendor key all the same.
      class StoredKeyConfig extends TestConfig {
        getProviderApiKey(provider: AiProvider): string { return provider === 'anthropic' ? 'sk-ant-stored' : ''; }
      }
      recordInstalledPlanner('claude-code');
      expect(detect(new StoredKeyConfig())).toBe('anthropic');
    });

    it('falls back to openrouter only when no coding agent is installed', () => {
      recordInstalledPlanner(null);
      expect(detect()).toBe('openrouter');
    });

    it('a bare OPENAI_API_KEY resolves to the openai provider, not openrouter', () => {
      process.env.OPENAI_API_KEY = 'sk-openai';
      expect(detect()).toBe('openai');
      const config = new TestConfig();
      // openrouter no longer claims the OpenAI key; openai does.
      expect(config.getProviderApiKey('openrouter')).toBe('');
      expect(config.getProviderApiKey('openai')).toBe('sk-openai');
    });

    it('OPENROUTER_API_KEY still resolves to openrouter', () => {
      process.env.OPENROUTER_API_KEY = 'sk-or';
      expect(detect()).toBe('openrouter');
    });

    it('trims whitespace off a key and a base URL override', () => {
      process.env.OPENROUTER_API_KEY = '  sk-or-v1-abc\r\n';
      process.env.OPENROUTER_BASE_URL = ' https://openrouter.example/api/v1 ';
      const config = new TestConfig();
      try {
        expect(config.getProviderApiKey('openrouter')).toBe('sk-or-v1-abc');
        expect(config.getProviderBaseUrl('openrouter')).toBe('https://openrouter.example/api/v1');
      } finally {
        delete process.env.OPENROUTER_BASE_URL;
      }
    });

    it('treats a whitespace-only key as unset', () => {
      process.env.OPENROUTER_API_KEY = '   ';
      expect(new TestConfig().getProviderApiKey('openrouter')).toBe('');
    });

    it('honors GEMINI_BASE_URL as the google base URL override', () => {
      process.env.GEMINI_BASE_URL = 'https://custom.gemini.example/v1';
      expect(new TestConfig().getProviderBaseUrl('google')).toBe('https://custom.gemini.example/v1');
    });
  });

  describe('autonomousMode (ADR-0030)', () => {
    const saved = { path: process.env.ORDEWELL_SETTINGS_PATH, mode: process.env.ORDEWELL_AUTONOMOUS_MODE };
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-autonomy-'));
      process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
      delete process.env.ORDEWELL_AUTONOMOUS_MODE;
    });
    afterEach(() => {
      for (const [key, value] of [['ORDEWELL_SETTINGS_PATH', saved.path], ['ORDEWELL_AUTONOMOUS_MODE', saved.mode]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reads the level the user saved, as it stands now', () => {
      const config = new TestConfig();
      expect(config.autonomousMode).toBe(false);

      new SettingsService().setAutonomousMode(true);

      expect(config.autonomousMode).toBe(true);
    });
  });
});

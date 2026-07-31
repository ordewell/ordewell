import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BaseConfig } from '../BaseConfig';
import { AiProvider } from '../IConfig';

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

  describe('provider detection & key resolution', () => {
    const keys = ['AI_PROVIDER', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_BASE_URL'];
    const backup: Record<string, string | undefined> = {};
    beforeEach(() => { for (const k of keys) { backup[k] = process.env[k]; delete process.env[k]; } });
    afterEach(() => { for (const k of keys) { if (backup[k] !== undefined) process.env[k] = backup[k]; else delete process.env[k]; } });

    const detect = () => (BaseConfig as unknown as { detectProvider(f: AiProvider): AiProvider }).detectProvider('openrouter');

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

    it('honors GEMINI_BASE_URL as the google base URL override', () => {
      process.env.GEMINI_BASE_URL = 'https://custom.gemini.example/v1';
      expect(new TestConfig().getProviderBaseUrl('google')).toBe('https://custom.gemini.example/v1');
    });
  });
});

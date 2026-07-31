import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebConfig } from '../WebConfig';

const originalEnv = { ...process.env };

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('WebConfig', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.GEMINI_MODEL;
    delete process.env.AI_PROVIDER;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('enabledRunners', () => {
    it('returns the constructor override when provided', () => {
      const config = new WebConfig({ enabledRunners: ['opencode'] });
      expect(config.enabledRunners).toEqual(['opencode']);
    });

    it('reads ORDEWELL_ENABLED_RUNNERS env var (comma-separated)', () => {
      setEnv('ORDEWELL_ENABLED_RUNNERS', 'claude-code, opencode');
      const config = new WebConfig();
      expect(config.enabledRunners).toEqual(['claude-code', 'opencode']);
    });

    it('handles ORDEWELL_ENABLED_RUNNERS with whitespace', () => {
      setEnv('ORDEWELL_ENABLED_RUNNERS', ' claude-code ,  opencode ');
      const config = new WebConfig();
      expect(config.enabledRunners).toEqual(['claude-code', 'opencode']);
    });

    it('falls back to legacy ORDEWELL_CLAUDE_CODE_ENABLED when ORDEWELL_ENABLED_RUNNERS is empty', () => {
      setEnv('ORDEWELL_ENABLED_RUNNERS', '');
      const config = new WebConfig();
      expect(config.enabledRunners).toEqual(['claude-code']);
    });

    it('falls back to legacy ORDEWELL_CLAUDE_CODE_ENABLED=false', () => {
      setEnv('ORDEWELL_CLAUDE_CODE_ENABLED', 'false');
      const config = new WebConfig();
      expect(config.enabledRunners).toEqual(['claude-code']);
    });

    it('falls back to legacy ORDEWELL_OPENCODE_ENABLED=true', () => {
      setEnv('ORDEWELL_OPENCODE_ENABLED', 'true');
      const config = new WebConfig();
      expect(config.enabledRunners).toEqual(['claude-code', 'opencode']);
    });

    it('defaults to claude-code when nothing is configured', () => {
      const config = new WebConfig();
      expect(config.enabledRunners).toEqual(['claude-code']);
    });

    it('constructor override wins over env var', () => {
      setEnv('ORDEWELL_ENABLED_RUNNERS', 'claude-code');
      const config = new WebConfig({ enabledRunners: ['opencode'] });
      expect(config.enabledRunners).toEqual(['opencode']);
    });
  });

  describe('aiProvider with providerModelLists', () => {
    it('returns openrouter when orchestrator model is in OpenRouter list', () => {
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('GEMINI_API_KEY', 'sk-gem-test');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');

      const config = new WebConfig({
        providerModelLists: {
          openrouter: ['openai/gpt-4o'],
          google: ['gemini-2.5-pro'], openai_compatible: [],
        },
      });

      expect(config.aiProvider).toBe('openrouter');
    });

    it('returns google when orchestrator model is in Google list', () => {
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('GEMINI_API_KEY', 'sk-gem-test');
      setEnv('ORCHESTRATOR_MODEL', 'gemini-2.5-pro');

      const config = new WebConfig({
        providerModelLists: {
          openrouter: ['openai/gpt-4o'],
          google: ['gemini-2.5-pro'], openai_compatible: [],
        },
      });

      expect(config.aiProvider).toBe('google');
    });

    it('falls back to key-order detection when model not found in lists', () => {
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('GEMINI_API_KEY', 'sk-gem-test');
      setEnv('ORCHESTRATOR_MODEL', 'unknown/model');

      const config = new WebConfig({
        providerModelLists: {
          openrouter: ['openai/gpt-4o'],
          google: ['gemini-2.5-pro'], openai_compatible: [],
        },
      });

      expect(config.aiProvider).toBe('google');
    });

    it('falls back to key-order detection when no model lists provided', () => {
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');

      const config = new WebConfig();

      expect(config.aiProvider).toBe('openrouter');
    });

    it('returns google when both keys set and model is in neither list', () => {
      setEnv('GEMINI_API_KEY', 'sk-gem-test');
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('ORCHESTRATOR_MODEL', 'unknown/model');

      const config = new WebConfig({
        providerModelLists: {
          openrouter: ['openai/gpt-4o'],
          google: ['gemini-2.5-pro'], openai_compatible: [],
        },
      });

      expect(config.aiProvider).toBe('google');
    });
  });
});

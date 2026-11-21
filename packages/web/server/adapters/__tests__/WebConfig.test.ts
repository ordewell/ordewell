import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getProviderMeta, PROVIDER_DETECT_PRIORITY, recordInstalledPlanner, recordRunnerAuth, resetInstalledPlanner, resetRunnerAuth } from '@ordewell/core';
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

  describe('aiProvider mid-session switch (no re-construction)', () => {
    it('re-resolves when ORCHESTRATOR_MODEL crosses providers', () => {
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('GEMINI_API_KEY', 'sk-gem-test');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');

      const config = new WebConfig({
        providerModelLists: {
          openrouter: ['openai/gpt-4o'],
          google: ['gemini-2.5-pro'],
          openai_compatible: [],
        },
      });

      expect(config.aiProvider).toBe('openrouter');

      setEnv('ORCHESTRATOR_MODEL', 'gemini-2.5-pro');

      expect(config.aiProvider).toBe('google');
    });

    it('re-resolves when AI_PROVIDER switches between explicit CLI planners', () => {
      setEnv('AI_PROVIDER', 'claude-code');

      const config = new WebConfig();

      expect(config.aiProvider).toBe('claude-code');

      setEnv('AI_PROVIDER', 'opencode');

      expect(config.aiProvider).toBe('opencode');
    });

    it('keeps apiKey in sync after a mid-session provider switch', () => {
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('GEMINI_API_KEY', 'sk-gem-test');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');

      const config = new WebConfig({
        providerModelLists: {
          openrouter: ['openai/gpt-4o'],
          google: ['gemini-2.5-pro'],
          openai_compatible: [],
        },
      });

      expect(config.apiKey).toBe('sk-or-test');

      setEnv('ORCHESTRATOR_MODEL', 'gemini-2.5-pro');

      expect(config.apiKey).toBe('sk-gem-test');
    });
  });

  describe('aiProvider with an installed coding agent (ADR-0009)', () => {
    beforeEach(() => {
      // Every variable detection reads, so a key in the developer's own shell cannot decide a case.
      for (const provider of PROVIDER_DETECT_PRIORITY) {
        const meta = getProviderMeta(provider);
        for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
      }
    });
    afterEach(() => resetInstalledPlanner());

    it('does not keep an openrouter answer read before the probe recorded the agent', () => {
      const config = new WebConfig();
      expect(config.aiProvider).toBe('openrouter');

      recordInstalledPlanner('claude-code');

      expect(config.aiProvider).toBe('claude-code');
    });

    // A key in the shell or saved in Ordewell is not a choice to plan with it (ADR-0076).
    it('the installed agent plans though a vendor key is set', () => {
      recordInstalledPlanner('claude-code');
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      const config = new WebConfig();
      expect(config.aiProvider).toBe('claude-code');
      expect(config.orchestratorModel).toBe('');
    });

    it('a planner picked with /planner and persisted keeps its vendor and model after the upgrade', () => {
      // What the terminal UI's /planner writes to ~/.ordewell/.env for a vendor.
      recordInstalledPlanner('claude-code');
      setEnv('OPENAI_API_KEY', 'sk-openai-test');
      setEnv('AI_PROVIDER', 'openai');
      setEnv('ORCHESTRATOR_MODEL', 'openai:gpt-4o');
      const config = new WebConfig();
      expect(config.aiProvider).toBe('openai');
      expect(config.orchestratorModel).toBe('openai:gpt-4o');
    });

    it('keeps an explicit keyless OpenRouter choice instead of replacing it with the agent', () => {
      recordInstalledPlanner('claude-code');
      setEnv('AI_PROVIDER', 'openrouter');
      const config = new WebConfig();
      expect(config.aiProvider).toBe('openrouter');
      expect(config.apiKey).toBe('');
    });

    it('keeps an explicit Codex choice when Claude Code is installed', () => {
      recordInstalledPlanner('claude-code');
      setEnv('AI_PROVIDER', 'codex');
      expect(new WebConfig().aiProvider).toBe('codex');
    });

    it('updates a memoized fallback when the probe records a later agent', () => {
      const config = new WebConfig();
      expect(config.aiProvider).toBe('openrouter');
      recordInstalledPlanner('opencode');
      expect(config.aiProvider).toBe('opencode');
    });

    it('keeps the detected agent when a stale vendor model is set without a key', () => {
      recordInstalledPlanner('claude-code');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');
      const config = new WebConfig({ providerModelLists: { openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] } });
      expect(config.aiProvider).toBe('claude-code');
    });

    it('a stale vendor model with that vendor\'s key still picks the vendor', () => {
      recordInstalledPlanner('claude-code');
      setEnv('ORCHESTRATOR_MODEL', 'gemini-2.5-pro');
      setEnv('GEMINI_API_KEY', 'sk-gem-test');
      const config = new WebConfig({ providerModelLists: { openrouter: ['openai/gpt-4o'], google: ['gemini-2.5-pro'], openai_compatible: [] } });
      expect(config.aiProvider).toBe('google');
    });

    it('an explicit AI_PROVIDER wins over a stale vendor model and the installed agent', () => {
      recordInstalledPlanner('claude-code');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');
      const lists = { openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] };
      setEnv('AI_PROVIDER', 'codex');
      expect(new WebConfig({ providerModelLists: lists }).aiProvider).toBe('codex');
      setEnv('AI_PROVIDER', 'openrouter');
      expect(new WebConfig({ providerModelLists: lists }).aiProvider).toBe('openrouter');
    });

    it('a vendor key with no model saved for it leaves planning to the installed agent', () => {
      recordInstalledPlanner('claude-code');
      setEnv('GEMINI_API_KEY', 'sk-gem-test');
      const config = new WebConfig({ providerModelLists: { openrouter: ['openai/gpt-4o'], google: ['gemini-2.5-pro'], openai_compatible: [] } });
      expect(config.aiProvider).toBe('claude-code');
    });

    it('a model saved for a vendor whose catalog is still cold keeps that vendor, as it will once the catalog lists it', () => {
      recordInstalledPlanner('claude-code');
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');
      const discovered: { lists?: Record<string, string[]> } = {};
      const config = new WebConfig({ providerModelLists: () => discovered.lists });
      expect(config.aiProvider).toBe('openrouter');

      discovered.lists = { openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] };

      expect(config.aiProvider).toBe('openrouter');
    });

    it('with no installed agent a keyless vendor model still names its vendor', () => {
      setEnv('ORCHESTRATOR_MODEL', 'gemini-2.5-pro');
      const config = new WebConfig({ providerModelLists: { openrouter: ['openai/gpt-4o'], google: ['gemini-2.5-pro'], openai_compatible: [] } });
      expect(config.aiProvider).toBe('google');
    });

    it('moves to the model\'s vendor when its key arrives mid-session', () => {
      recordInstalledPlanner('claude-code');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');
      const config = new WebConfig({ providerModelLists: { openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] } });
      expect(config.aiProvider).toBe('claude-code');

      setEnv('OPENROUTER_API_KEY', 'sk-or-test');

      expect(config.aiProvider).toBe('openrouter');
    });
  });

  describe('aiProvider follows explicit choices and credential changes', () => {
    afterEach(() => resetInstalledPlanner());

    it('an explicit vendor AI_PROVIDER wins over a keyed vendor list that holds the model', () => {
      setEnv('AI_PROVIDER', 'google');
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('GEMINI_API_KEY', 'sk-gem-test');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');
      const config = new WebConfig({ providerModelLists: { openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] } });
      expect(config.aiProvider).toBe('google');
    });

    // A session keeps one config while the settings route rewrites keys under
    // it: the same instance must answer what a fresh one would.
    it('the same instance goes back to the agent when the last key is removed', () => {
      recordInstalledPlanner('claude-code');
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      setEnv('ORCHESTRATOR_MODEL', 'openai/gpt-4o');
      const config = new WebConfig({ providerModelLists: { openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] } });
      expect(config.aiProvider).toBe('openrouter');

      setEnv('OPENROUTER_API_KEY', '');

      expect(config.aiProvider).toBe('claude-code');
      expect(config.aiProvider).toBe(new WebConfig().aiProvider);
    });

    it('the same instance follows an endpoint set after a read, as a fresh one does', () => {
      const config = new WebConfig();
      expect(config.aiProvider).toBe('openrouter');

      setEnv('OPENAI_COMPATIBLE_BASE_URL', 'http://localhost:9999/v1');

      expect(config.aiProvider).toBe(new WebConfig().aiProvider);
      expect(config.aiProvider).toBe('openai_compatible');
    });

    it('the same instance follows the agent signing out, as a fresh one does', () => {
      recordInstalledPlanner('claude-code');
      setEnv('OPENROUTER_API_KEY', 'sk-or-test');
      const config = new WebConfig();
      expect(config.aiProvider).toBe('claude-code');

      recordRunnerAuth('claude-code', { state: 'signed-out' });

      try {
        expect(config.aiProvider).toBe('openrouter');
        expect(config.aiProvider).toBe(new WebConfig().aiProvider);
      } finally {
        resetRunnerAuth();
      }
    });
  });
});

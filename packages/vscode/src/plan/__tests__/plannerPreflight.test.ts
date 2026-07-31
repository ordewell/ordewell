import { describe, it, expect } from 'vitest';
import { plannerPreflightError } from '../PlanManager';
import type { AiProvider } from '@ordewell/core';
import type { VsCodeConfig } from '../../adapters/VsCodeConfig';

function config(aiProvider: AiProvider, apiKey: string, planningModel: string): VsCodeConfig {
  return { aiProvider, apiKey, planningModel } as unknown as VsCodeConfig;
}

/**
 * ADR-0009: a harness planner is authenticated by the user's own coding-agent
 * subscription, so the API-key gate must not fire for it. The reported bug was
 * exactly this — Claude Code selected as planner, no key set, and the chat
 * answered "API key not configured" instead of planning.
 */
describe('plannerPreflightError', () => {
  for (const provider of ['claude-code', 'codex', 'opencode'] as AiProvider[]) {
    it(`lets ${provider} plan with no API key`, () => {
      expect(plannerPreflightError(config(provider, '', 'sonnet'))).toBeNull();
    });

    it(`lets ${provider} plan with no model — the agent's default applies`, () => {
      expect(plannerPreflightError(config(provider, '', ''))).toBeNull();
    });
  }

  it('still demands a key from a vendor planner', () => {
    expect(plannerPreflightError(config('openrouter', '', 'openai/gpt-5')))
      .toContain('API key not configured');
  });

  it('still demands a model from a keyed vendor planner', () => {
    expect(plannerPreflightError(config('openrouter', 'sk-or', '')))
      .toContain('No orchestrator model selected');
  });

  it('passes a fully configured vendor planner', () => {
    expect(plannerPreflightError(config('openrouter', 'sk-or', 'openai/gpt-5'))).toBeNull();
  });
});

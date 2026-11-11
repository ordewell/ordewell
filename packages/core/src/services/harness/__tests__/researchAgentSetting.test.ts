import { describe, it, expect } from 'vitest';
import { researchAgentSetting } from '../researchAgentSetting';

describe('researchAgentSetting reads ORDEWELL_RESEARCH_AGENT_MODEL (ADR-0066)', () => {
  it('is absent when the variable is unset or blank', () => {
    expect(researchAgentSetting({ OPENROUTER_API_KEY: 'k' })).toEqual({ kind: 'absent' });
    expect(researchAgentSetting({ ORDEWELL_RESEARCH_AGENT_MODEL: '  ', OPENROUTER_API_KEY: 'k' })).toEqual({ kind: 'absent' });
  });

  it('offers the named model on its provider, with that provider\'s own key and endpoint', () => {
    expect(researchAgentSetting({ ORDEWELL_RESEARCH_AGENT_MODEL: 'openrouter:deepseek/deepseek-v4.1-flash', OPENROUTER_API_KEY: ' sk-or ' })).toEqual({
      kind: 'offered', vendor: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', apiKey: 'sk-or', baseUrl: 'https://openrouter.ai/api/v1',
    });
    // Only the first colon divides: a model id may hold one itself.
    expect(researchAgentSetting({ ORDEWELL_RESEARCH_AGENT_MODEL: 'openai_compatible:qwen3:8b', OPENAI_COMPATIBLE_API_KEY: 'k', OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:8000/v1' })).toEqual({
      kind: 'offered', vendor: 'openai_compatible', model: 'qwen3:8b', apiKey: 'k', baseUrl: 'http://127.0.0.1:8000/v1',
    });
  });

  it('is unavailable, naming the key, when the provider has none', () => {
    const setting = researchAgentSetting({ ORDEWELL_RESEARCH_AGENT_MODEL: 'openrouter:deepseek/deepseek-v4.1-flash' });
    expect(setting.kind).toBe('unavailable');
    expect(setting.kind === 'unavailable' && setting.reason).toContain('OPENROUTER_API_KEY');
  });

  it('refuses Gemini by name, even with its key set', () => {
    const setting = researchAgentSetting({ ORDEWELL_RESEARCH_AGENT_MODEL: 'google:gemini-3-flash', GEMINI_API_KEY: 'k' });
    expect(setting.kind).toBe('unavailable');
    expect(setting.kind === 'unavailable' && setting.reason).toMatch(/Gemini/);
  });

  it.each([
    ['no provider', 'deepseek-v4.1-flash'],
    ['no model', 'openrouter:'],
    ['an unknown provider', 'nonesuch:model'],
    ['a runner in place of a provider', 'opencode:deepseek'],
  ])('is unavailable, quoting the value, with %s', (_why, value) => {
    const setting = researchAgentSetting({ ORDEWELL_RESEARCH_AGENT_MODEL: value, OPENROUTER_API_KEY: 'k' });
    expect(setting.kind).toBe('unavailable');
    expect(setting.kind === 'unavailable' && setting.reason).toContain(`<provider>:<model>`);
  });
});

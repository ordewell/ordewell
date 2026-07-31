import { describe, it, expect } from 'vitest';
import { knownModelId, ORCHESTRATOR_SHORTCUTS } from '../ModelShortcuts';

const optionIds = ['deepseek/deepseek-v4-flash', 'google/gemini-2.5-pro', 'gemini:gemini-2.5-pro'];

describe('knownModelId — only catalog/shortcut ids may be applied directly', () => {
  it('returns the id when it is in the catalog option list', () => {
    expect(knownModelId('gemini:gemini-2.5-pro', optionIds, ORCHESTRATOR_SHORTCUTS)).toBe('gemini:gemini-2.5-pro');
    expect(knownModelId('google/gemini-2.5-pro', optionIds, ORCHESTRATOR_SHORTCUTS)).toBe('google/gemini-2.5-pro');
  });

  it('resolves a shortcut label/id to its canonical id', () => {
    expect(knownModelId('DeepSeek V4 Flash', optionIds, ORCHESTRATOR_SHORTCUTS)).toBe('deepseek/deepseek-v4-flash');
  });

  it('returns null for a free-typed / unknown value (never applied verbatim)', () => {
    expect(knownModelId('gemini-2.5-pro', optionIds, ORCHESTRATOR_SHORTCUTS)).toBeNull();
    expect(knownModelId('totally-made-up', optionIds, ORCHESTRATOR_SHORTCUTS)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(knownModelId('', optionIds, ORCHESTRATOR_SHORTCUTS)).toBeNull();
  });
});

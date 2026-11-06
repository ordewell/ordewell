import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_LABEL, effortLabel, modelLabel, modelShortLabel } from '../assignment';

describe('the words for a model and an effort', () => {
  it('names a model by its label, then its id, then as the runner\'s default', () => {
    expect(modelLabel({ modelId: 'claude-opus-4', modelLabel: 'Opus' })).toBe('Opus');
    expect(modelLabel({ modelId: 'opencode-go/deepseek-v4.1-flash' })).toBe('opencode-go/deepseek-v4.1-flash');
    expect(modelLabel(null)).toBe(DEFAULT_MODEL_LABEL);
  });

  it('drops only a model\'s provider when it is shortened', () => {
    expect(modelShortLabel('opencode-go/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
    expect(modelShortLabel('opus')).toBe('opus');
    expect(modelShortLabel('trailing/')).toBe('trailing/');
  });

  it('writes an effort as a phrase, or short for a narrow line, and keeps an unknown one\'s id', () => {
    expect(effortLabel('xhigh')).toBe('extra high');
    expect(effortLabel('xhigh', { short: true })).toBe('xhigh');
    expect(effortLabel('medium', { short: true })).toBe('med');
    expect(effortLabel('turbo')).toBe('turbo');
    expect(effortLabel('constructor')).toBe('constructor');
  });
});

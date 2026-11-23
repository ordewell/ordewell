import { describe, it, expect } from 'vitest';
import { filterModelsForPrompt, clampThinkingEffort, effectiveAllowlist } from '../ModelAllowlistResolver';

describe('effectiveAllowlist', () => {
  const catalogs = {
    'claude-code': [{ modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', variants: [] }],
    opencode: [
      { modelId: 'gpt-5.6-sol', modelLabel: 'GPT', variants: [] },
      { modelId: 'deepseek-v4-pro', modelLabel: 'DeepSeek', variants: [] },
    ],
  };

  // An empty list is a discovery that failed: what another runner lists still says what this one cannot run.
  it('drops another runner\'s ids for a runner whose discovery came back empty, or is missing', () => {
    const empty = { 'claude-code': [], opencode: catalogs.opencode };
    expect(effectiveAllowlist(['gpt-5.6-sol', 'other-id'], 'claude-code', empty)).toEqual(['other-id']);
    expect(effectiveAllowlist(['gpt-5.6-sol', 'other-id'], 'claude-code', { opencode: catalogs.opencode })).toEqual(['other-id']);
  });

  it('reads a legacy allowlist of another runner\'s slugs as no restriction when this runner\'s discovery came back empty', () => {
    const openrouter = [{ modelId: 'openai/gpt-5', modelLabel: 'GPT-5', variants: [] }, { modelId: 'anthropic/claude-x', modelLabel: 'Claude X', variants: [] }];
    expect(effectiveAllowlist(['openai/gpt-5', 'anthropic/claude-x'], 'claude-code', { 'claude-code': [], openrouter })).toBeUndefined();
  });

  it('is undefined for an unset or empty allowlist', () => {
    expect(effectiveAllowlist(undefined, 'claude-code', catalogs)).toBeUndefined();
    expect(effectiveAllowlist([], 'claude-code', catalogs)).toBeUndefined();
  });

  it('drops ids that were discovered only for another runner', () => {
    expect(
      effectiveAllowlist(['claude-sonnet-4-5', 'gpt-5.6-sol', 'deepseek-v4-pro'], 'claude-code', catalogs),
    ).toEqual(['claude-sonnet-4-5']);
  });

  it('keeps an id no runner has listed — discovery may just be stale', () => {
    expect(effectiveAllowlist(['claude-opus-5'], 'claude-code', catalogs)).toEqual(['claude-opus-5']);
  });

  it('keeps a model both runners serve', () => {
    const shared = { ...catalogs, opencode: [...catalogs.opencode, catalogs['claude-code'][0]] };
    expect(effectiveAllowlist(['claude-sonnet-4-5'], 'claude-code', shared)).toEqual(['claude-sonnet-4-5']);
  });

  it('lifts the restriction when every id belongs to another runner', () => {
    expect(effectiveAllowlist(['gpt-5.6-sol', 'deepseek-v4-pro'], 'claude-code', catalogs)).toBeUndefined();
  });

  it('honors the allowlist verbatim with no catalog to check against', () => {
    expect(effectiveAllowlist(['anything'], 'claude-code', undefined)).toEqual(['anything']);
  });
});

describe('filterModelsForPrompt', () => {
  it('narrows each runner models to the intersection with its allowlist', () => {
    const modelsByRunner = {
      opencode: [
        { modelId: 'a', modelLabel: 'A', variants: [] },
        { modelId: 'b', modelLabel: 'B', variants: [] },
        { modelId: 'c', modelLabel: 'C', variants: [] },
      ],
    };
    const allowlist = { opencode: ['a', 'c'] };

    const result = filterModelsForPrompt(modelsByRunner, allowlist);

    expect(result.opencode).toEqual([
      { modelId: 'a', modelLabel: 'A', variants: [] },
      { modelId: 'c', modelLabel: 'C', variants: [] },
    ]);
  });

  it('honors allowlisted ids not covered by discovery instead of leaking the full list', () => {
    const modelsByRunner = {
      opencode: [
        { modelId: 'a', modelLabel: 'A', variants: [] },
        { modelId: 'b', modelLabel: 'B', variants: [] },
      ],
    };
    const allowlist = { opencode: ['a', 'opencode-go/not-yet-discovered'] };

    const result = filterModelsForPrompt(modelsByRunner, allowlist);

    expect(result.opencode).toEqual([
      { modelId: 'a', modelLabel: 'A', variants: [] },
      { modelId: 'opencode-go/not-yet-discovered', modelLabel: 'not-yet-discovered', variants: [] },
    ]);
  });

  it('never exposes non-allowlisted models even when the intersection is empty', () => {
    const modelsByRunner = {
      opencode: [
        { modelId: 'a', modelLabel: 'A', variants: [] },
        { modelId: 'b', modelLabel: 'B', variants: [] },
      ],
    };
    const allowlist = { opencode: ['phantom'] };

    const result = filterModelsForPrompt(modelsByRunner, allowlist);

    expect(result.opencode!.map((m) => m.modelId)).toEqual(['phantom']);
  });

  it('ignores allowlisted ids that belong to a different runner', () => {
    const modelsByRunner = {
      'claude-code': [
        { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', variants: [] },
        { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku', variants: [] },
      ],
      opencode: [{ modelId: 'gpt-5.6-sol', modelLabel: 'GPT', variants: [] }],
    };
    const allowlist = { 'claude-code': ['claude-haiku-4-5', 'gpt-5.6-sol'] };

    const result = filterModelsForPrompt(modelsByRunner, allowlist);

    expect(result['claude-code']!.map((m) => m.modelId)).toEqual(['claude-haiku-4-5']);
  });

  it('falls back to the full catalog when every allowlisted id is another runner\'s', () => {
    const modelsByRunner = {
      'claude-code': [{ modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', variants: [] }],
      opencode: [{ modelId: 'gpt-5.6-sol', modelLabel: 'GPT', variants: [] }],
    };
    const allowlist = { 'claude-code': ['gpt-5.6-sol'] };

    const result = filterModelsForPrompt(modelsByRunner, allowlist);

    expect(result['claude-code']!.map((m) => m.modelId)).toEqual(['claude-sonnet-4-5']);
  });

  it('returns unfiltered when allowlist is unset (undefined)', () => {
    const modelsByRunner = {
      opencode: [
        { modelId: 'a', modelLabel: 'A', variants: [] },
      ],
    };

    const result = filterModelsForPrompt(modelsByRunner, {});

    expect(result.opencode).toEqual(modelsByRunner.opencode);
  });

  it('returns unfiltered when allowlist is empty array', () => {
    const modelsByRunner = {
      opencode: [
        { modelId: 'a', modelLabel: 'A', variants: [] },
      ],
    };
    const allowlist = { opencode: [] };

    const result = filterModelsForPrompt(modelsByRunner, allowlist);

    expect(result.opencode).toEqual(modelsByRunner.opencode);
  });
});

describe('clampThinkingEffort', () => {
  const variants = (...ids: string[]) => ids.map((id) => ({ id }));

  it('returns undefined for an unset effort', () => {
    expect(clampThinkingEffort(undefined, variants('low'))).toBeUndefined();
  });

  it('returns undefined when the model has no variants', () => {
    expect(clampThinkingEffort('high', [])).toBeUndefined();
  });

  it('passes a supported effort through', () => {
    expect(clampThinkingEffort('medium', variants('low', 'medium', 'high'))).toBe('medium');
  });

  it('maps Claude-only aliases onto the ladder (disabled→none, adaptive→medium)', () => {
    expect(clampThinkingEffort('disabled', variants('none', 'high'))).toBe('none');
    expect(clampThinkingEffort('adaptive', variants('low', 'medium', 'high'))).toBe('medium');
  });

  it('prefers the nearest lower rung, then the nearest higher one', () => {
    expect(clampThinkingEffort('max', variants('low', 'medium', 'high'))).toBe('high');
    expect(clampThinkingEffort('minimal', variants('low', 'high'))).toBe('low');
    expect(clampThinkingEffort('low', variants('high', 'max'))).toBe('high');
  });

  it('returns undefined for an effort outside the known ladder', () => {
    expect(clampThinkingEffort('turbo', variants('low', 'high'))).toBeUndefined();
  });

  it('ranks ultra above max on the ladder (Codex models)', () => {
    expect(clampThinkingEffort('ultra', variants('low', 'medium', 'high', 'xhigh', 'max', 'ultra'))).toBe('ultra');
    expect(clampThinkingEffort('ultra', variants('low', 'medium', 'high', 'xhigh', 'max'))).toBe('max');
    expect(clampThinkingEffort('ultra', variants('low', 'medium', 'high'))).toBe('high');
  });
});

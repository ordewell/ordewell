import { describe, it, expect } from 'vitest';
import { filterModelsForPrompt, coerceAssignments, clampThinkingEffort, effectiveAllowlist } from '../ModelAllowlistResolver';

describe('effectiveAllowlist', () => {
  const catalogs = {
    'claude-code': [{ modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', variants: [] }],
    opencode: [
      { modelId: 'gpt-5.6-sol', modelLabel: 'GPT', variants: [] },
      { modelId: 'deepseek-v4-pro', modelLabel: 'DeepSeek', variants: [] },
    ],
  };

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

describe('coerceAssignments', () => {
  const opencodeTask = (modelId: string, thinkingEffort?: string) => ({
    id: 't1',
    order: 0,
    title: 'test',
    description: '',
    type: 'ai' as const,
    status: 'pending' as const,
    dependencies: [],
    subtasks: [],
    assignedRunner: 'opencode' as const,
    assignedModel: { modelId, modelLabel: modelId, thinkingEffort },
    completionMarker: '',
  });

  it('rewrites out-of-allowlist modelId to allowlist[0] and wipes thinkingEffort', () => {
    const tasks = [opencodeTask('stray-model', 'high')];
    const allowlist = { opencode: ['allowed-a', 'allowed-b'] };

    const result = coerceAssignments(tasks, allowlist);

    expect(result[0].assignedModel!.modelId).toBe('allowed-a');
    expect(result[0].assignedModel!.thinkingEffort).toBeUndefined();
  });

  it('does not snap a task onto another runner\'s model that leaked into its allowlist', () => {
    const tasks = [{
      id: 't1', order: 0, title: '', description: '',
      type: 'ai' as const, status: 'pending' as const,
      dependencies: [], subtasks: [],
      assignedRunner: 'claude-code' as const,
      assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet' },
      completionMarker: '',
    }];
    const modelsByRunner = {
      'claude-code': [{ modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', variants: [] }],
      opencode: [{ modelId: 'gpt-5.6-sol', modelLabel: 'GPT', variants: [] }],
    };

    const result = coerceAssignments(tasks, { 'claude-code': ['gpt-5.6-sol'] }, undefined, modelsByRunner);

    expect(result[0].assignedModel!.modelId).toBe('claude-sonnet-4-5');
  });

  it('carries the catalog label and variants onto a snapped model', () => {
    const tasks = [opencodeTask('stray-model', 'high')];
    const modelsByRunner = {
      opencode: [{ modelId: 'allowed-a', modelLabel: 'Allowed A', variants: [{ id: 'low', label: 'Low' }] }],
    };

    const result = coerceAssignments(tasks, { opencode: ['allowed-a'] }, undefined, modelsByRunner);

    expect(result[0].assignedModel).toMatchObject({
      modelId: 'allowed-a',
      modelLabel: 'Allowed A',
      availableVariants: ['low'],
    });
  });

  it('leaves user tasks untouched', () => {
    const tasks = [{
      id: 'u1', order: 0, title: '', description: '',
      type: 'user' as const, status: 'pending' as const,
      dependencies: [], subtasks: [],
      assignedRunner: 'opencode' as const,
      assignedModel: { modelId: 'stray', modelLabel: 'stray' },
      completionMarker: '',
    }];
    const allowlist = { opencode: ['allowed'] };

    const result = coerceAssignments(tasks, allowlist);

    expect(result[0].assignedModel!.modelId).toBe('stray');
  });

  it('leaves tasks with no allowlist for their runner untouched', () => {
    const tasks = [opencodeTask('stray-model')];
    const allowlist = { 'other-runner': ['allowed'] };

    const result = coerceAssignments(tasks, allowlist);

    expect(result[0].assignedModel!.modelId).toBe('stray-model');
  });

  it('leaves tasks whose modelId is already in the allowlist untouched', () => {
    const tasks = [opencodeTask('allowed-a', 'high')];
    const allowlist = { opencode: ['allowed-a', 'allowed-b'] };

    const result = coerceAssignments(tasks, allowlist);

    expect(result[0].assignedModel!.modelId).toBe('allowed-a');
    expect(result[0].assignedModel!.thinkingEffort).toBe('high');
  });

  it('rewrites tasks assigned to a runner not in allowedRunners', () => {
    const tasks = [{
      id: 't1', order: 0, title: '', description: '',
      type: 'ai' as const, status: 'pending' as const,
      dependencies: [], subtasks: [],
      assignedRunner: 'claude-code' as const,
      assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4' },
      completionMarker: '',
    }];
    const allowlist = { opencode: ['deepseek-v4-flash'] };

    const result = coerceAssignments(tasks, allowlist, ['opencode']);

    expect(result[0].assignedRunner).toBe('opencode');
    expect(result[0].assignedModel!.modelId).toBe('deepseek-v4-flash');
  });

  it('leaves tasks with no allowlist untouched when allowedRunners is not passed', () => {
    const tasks = [{
      id: 't1', order: 0, title: '', description: '',
      type: 'ai' as const, status: 'pending' as const,
      dependencies: [], subtasks: [],
      assignedRunner: 'claude-code' as const,
      assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4' },
      completionMarker: '',
    }];
    const allowlist = { opencode: ['deepseek-v4-flash'] };

    const result = coerceAssignments(tasks, allowlist);

    expect(result[0].assignedRunner).toBe('claude-code');
    expect(result[0].assignedModel!.modelId).toBe('claude-sonnet-4');
  });

  it('fills a missing assignedModel from the allowlist', () => {
    const task = {
      id: 't1', order: 0, title: '', description: '',
      type: 'ai' as const, status: 'pending' as const,
      dependencies: [], subtasks: [],
      assignedRunner: 'opencode' as const,
      completionMarker: '',
    };
    const tasks = [task];
    const allowlist = { opencode: ['allowed'] };

    const result = coerceAssignments(tasks, allowlist);
    expect(result[0].assignedModel!.modelId).toBe('allowed');
  });

  it('fills a missing assignedModel from the discovered catalog when no allowlist is set', () => {
    const task = {
      id: 't1', order: 0, title: '', description: '',
      type: 'ai' as const, status: 'pending' as const,
      dependencies: [], subtasks: [],
      assignedRunner: 'opencode' as const,
      completionMarker: '',
    };
    const modelsByRunner = {
      opencode: [{ modelId: 'discovered-a', modelLabel: 'Discovered A', variants: [] }],
    };

    const result = coerceAssignments([task], {}, undefined, modelsByRunner);
    expect(result[0].assignedModel!.modelId).toBe('discovered-a');
  });

  it('leaves a missing assignedModel undefined when neither allowlist nor catalog has the runner', () => {
    const task = {
      id: 't1', order: 0, title: '', description: '',
      type: 'ai' as const, status: 'pending' as const,
      dependencies: [], subtasks: [],
      assignedRunner: 'opencode' as const,
      completionMarker: '',
    };

    const result = coerceAssignments([task], {});
    expect(result[0].assignedModel).toBeUndefined();
  });

  describe('thinkingEffort clamping against the discovered catalog', () => {
    const variants = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
    const modelsByRunner = {
      opencode: [
        { modelId: 'p/limited', modelLabel: 'Limited', variants: variants('low', 'medium', 'high') },
        { modelId: 'p/plain', modelLabel: 'Plain', variants: [] },
      ],
    };

    it('keeps a valid effort as-is', () => {
      const result = coerceAssignments([opencodeTask('p/limited', 'high')], {}, undefined, modelsByRunner);
      expect(result[0].assignedModel!.thinkingEffort).toBe('high');
    });

    it('maps an unsupported effort to the nearest variant the model offers', () => {
      const result = coerceAssignments([opencodeTask('p/limited', 'xhigh')], {}, undefined, modelsByRunner);
      expect(result[0].assignedModel!.thinkingEffort).toBe('high');
    });

    it('drops the effort entirely when the model has no variants', () => {
      const result = coerceAssignments([opencodeTask('p/plain', 'high')], {}, undefined, modelsByRunner);
      expect(result[0].assignedModel!.thinkingEffort).toBeUndefined();
    });

    it('leaves the effort untouched when the model is not in the catalog', () => {
      const result = coerceAssignments([opencodeTask('p/unknown', 'weird')], {}, undefined, modelsByRunner);
      expect(result[0].assignedModel!.thinkingEffort).toBe('weird');
    });

    it('clamps after an allowlist rewrite lands on a catalogued model', () => {
      const result = coerceAssignments(
        [{ ...opencodeTask('p/limited', 'max') }],
        { opencode: ['p/limited'] },
        undefined,
        modelsByRunner,
      );
      expect(result[0].assignedModel!.thinkingEffort).toBe('high');
    });
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

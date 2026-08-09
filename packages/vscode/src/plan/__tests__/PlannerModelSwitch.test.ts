import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SettingsService, PlannerModelMemory, type DiscoveredModel } from '@ordewell/core';
import { recallPlannerModel } from '../PlannerModelSwitch';

function harnessModel(modelId: string, variantIds: string[] = []): DiscoveredModel {
  return {
    modelId,
    modelLabel: modelId,
    variants: variantIds.map((id) => ({ id, label: id })),
  };
}

describe('recallPlannerModel', () => {
  let dir: string;
  let memory: PlannerModelMemory;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-planner-switch-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    memory = new PlannerModelMemory(new SettingsService());
  });

  afterEach(() => {
    delete process.env.ORDEWELL_SETTINGS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restores the harness model remembered for that provider', () => {
    memory.remember('claude-code', 'claude-sonnet-4-5', 'high');

    const result = recallPlannerModel(
      memory,
      'claude-code',
      [harnessModel('claude-haiku-4-5', ['low']), harnessModel('claude-sonnet-4-5', ['low', 'high'])],
      undefined,
    );

    expect(result).toEqual({ model: 'claude-sonnet-4-5', effort: 'high', source: 'remembered' });
  });

  it('lands a provider with nothing remembered on the first catalog entry', () => {
    const result = recallPlannerModel(memory, 'codex', [harnessModel('gpt-5-codex'), harnessModel('gpt-5-mini')], undefined);

    expect(result).toEqual({ model: 'gpt-5-codex', effort: '', source: 'catalog-default' });
  });

  it('degrades to the catalog default when the remembered id is missing from the catalog', () => {
    memory.remember('opencode', 'zen/retired-model', 'high');

    const result = recallPlannerModel(memory, 'opencode', [harnessModel('zen/glm-4.6')], undefined);

    expect(result).toEqual({ model: 'zen/glm-4.6', effort: '', source: 'catalog-default' });
  });

  it('leaves the model empty when the catalog is empty', () => {
    memory.remember('codex', 'gpt-5-codex', 'high');

    const result = recallPlannerModel(memory, 'codex', [], undefined);

    expect(result).toEqual({ model: '', effort: '', source: 'none' });
  });

  it('restores a vendor model from the picker list, ignoring the harness-only variants field', () => {
    memory.remember('openrouter', 'z-ai/glm-4.6');

    const result = recallPlannerModel(memory, 'openrouter', undefined, [{ id: 'z-ai/glm-4.6' }, { id: 'openai/gpt-5' }]);

    expect(result).toEqual({ model: 'z-ai/glm-4.6', effort: '', source: 'remembered' });
  });

  it('treats an absent vendor list the same as an empty catalog', () => {
    const result = recallPlannerModel(memory, 'openrouter', undefined, undefined);

    expect(result).toEqual({ model: '', effort: '', source: 'none' });
  });
});

import { describe, it, expect } from 'vitest';
import { assignedModelFor, effortsForTask, modelsForTask, modesForTask, runnerAccepts } from '../taskAssignment';
import type { ModelView, TaskView } from '../state';

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'task-a',
  order: 1,
  title: 'Do the thing',
  type: 'ai',
  status: 'pending',
  dependencies: [],
  ...over,
});

const model = (over: Partial<ModelView> = {}): ModelView => ({
  id: 'gpt-5',
  label: 'GPT-5',
  provider: 'OpenAI',
  ...over,
});

describe('runnerAccepts', () => {
  it('accepts any model when the task has no assigned runner', () => {
    expect(runnerAccepts(task(), model({ runners: ['codex'] }))).toBe(true);
  });

  it('accepts a model discovery left runner-agnostic', () => {
    expect(runnerAccepts(task({ assignedRunner: 'codex' }), model({ runners: undefined }))).toBe(true);
    expect(runnerAccepts(task({ assignedRunner: 'codex' }), model({ runners: [] }))).toBe(true);
  });

  it('accepts a model discovered for the task runner', () => {
    expect(runnerAccepts(task({ assignedRunner: 'codex' }), model({ runners: ['codex', 'claude-code'] }))).toBe(true);
  });

  it('rejects a model discovered only for a different runner', () => {
    expect(runnerAccepts(task({ assignedRunner: 'codex' }), model({ runners: ['claude-code'] }))).toBe(false);
  });
});

describe('modelsForTask', () => {
  it('filters the catalog down to runner-compatible models', () => {
    const models = [
      model({ id: 'gpt-5', runners: ['codex'] }),
      model({ id: 'claude', runners: ['claude-code'] }),
      model({ id: 'any', runners: [] }),
    ];
    expect(modelsForTask(models, task({ assignedRunner: 'codex' })).map((m) => m.id)).toEqual(['gpt-5', 'any']);
  });
});

describe('effortsForTask', () => {
  it("prefers the assigned model's current variants over the task's stale snapshot", () => {
    const models = [model({ id: 'gpt-5', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] })];
    const t = task({ assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5', availableVariants: ['stale'] } });
    expect(effortsForTask(models, t)).toEqual([{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }]);
  });

  it('falls back to the availableVariants snapshot when the model is no longer in the catalog', () => {
    const t = task({ assignedModel: { modelId: 'gone', modelLabel: 'Gone', availableVariants: ['low', 'high'] } });
    expect(effortsForTask([], t)).toEqual([{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }]);
  });

  it('returns no efforts for a task with no assigned model', () => {
    expect(effortsForTask([model()], task())).toEqual([]);
  });
});

describe('assignedModelFor', () => {
  it('carries the current effort over when the new model still supports it', () => {
    const m = model({ variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] });
    expect(assignedModelFor(m, 'high')).toEqual({
      modelId: 'gpt-5',
      modelLabel: 'GPT-5',
      thinkingEffort: 'high',
      availableVariants: ['low', 'high'],
    });
  });

  it('drops the effort when the new model does not support it', () => {
    const m = model({ variants: [{ id: 'low', label: 'Low' }] });
    expect(assignedModelFor(m, 'high').thinkingEffort).toBeUndefined();
  });

  it('drops the effort when the new model has no variants at all', () => {
    expect(assignedModelFor(model(), 'high')).toEqual({
      modelId: 'gpt-5',
      modelLabel: 'GPT-5',
      thinkingEffort: undefined,
      availableVariants: [],
    });
  });
});

describe('modesForTask', () => {
  const modes = {
    'claude-code': [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }],
    codex: [{ id: 'agent', label: 'Agent' }],
  };

  it('returns the modes of the task own runner', () => {
    expect(modesForTask(modes, task({ assignedRunner: 'codex' }))).toEqual([{ id: 'agent', label: 'Agent' }]);
  });

  it('returns nothing for a runner that declares no modes', () => {
    expect(modesForTask(modes, task({ assignedRunner: 'aider' }))).toEqual([]);
  });

  it('returns nothing when the task has no runner to scope by', () => {
    expect(modesForTask(modes, task())).toEqual([]);
  });
});

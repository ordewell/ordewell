import { describe, it, expect } from 'vitest';
import { modelsFromSession } from '../harness/acpModels';
import type { AcpSessionState } from '../harness/acpSchema';

const select = (id: string, category: string, current: string, values: string[]) => ({
  type: 'select',
  id,
  name: id,
  category,
  currentValue: current,
  options: values.map((value) => ({ value, name: value.toUpperCase() })),
});

describe('modelsFromSession', () => {
  it('reads the model config option, naming each model as the agent does', () => {
    const state: AcpSessionState = { configOptions: [select('model', 'model', 'small', ['small', 'large'])] };

    expect(modelsFromSession(state)).toEqual([
      { modelId: 'small', modelLabel: 'SMALL', variants: [] },
      { modelId: 'large', modelLabel: 'LARGE', variants: [] },
    ]);
  });

  it('offers the effort option\'s values as variants of the model the session is on, the only one it describes', () => {
    const state: AcpSessionState = {
      configOptions: [
        select('model', 'model', 'small', ['small', 'large']),
        select('effort', 'thought_level', 'low', ['low', 'high']),
      ],
    };

    const [small, large] = modelsFromSession(state);

    expect(small.variants).toEqual([{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }]);
    expect(large.variants).toEqual([]);
  });

  it('flattens grouped values', () => {
    const state: AcpSessionState = {
      configOptions: [{
        type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'a',
        options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }],
      }],
    };

    expect(modelsFromSession(state).map((m) => m.modelId)).toEqual(['a', 'b']);
  });

  it('reads the older models list when there is no model option', () => {
    const state: AcpSessionState = {
      models: { currentModelId: 'x', availableModels: [{ modelId: 'x', name: 'Ex' }, { modelId: 'y', name: 'Why' }] },
    };

    expect(modelsFromSession(state)).toEqual([
      { modelId: 'x', modelLabel: 'Ex', variants: [] },
      { modelId: 'y', modelLabel: 'Why', variants: [] },
    ]);
  });

  it('offers nothing when the session has no model choice (Copilot 1.0.105: mode and allow-all only)', () => {
    const state: AcpSessionState = { configOptions: [select('mode', 'mode', 'agent', ['agent', 'plan'])] };

    expect(modelsFromSession(state)).toEqual([]);
  });
});

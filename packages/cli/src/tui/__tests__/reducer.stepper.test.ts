import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import { openStepper, type StepChoices, type StepperDefinition, type StepperState } from '../reducers/stepper';
import type { TuiState } from '../state';

const press = (state: TuiState, name: string, char?: string): Step => reduce(state, { type: 'key', key: { name, char } });

/** Presses each key in turn, failing the test if any of them asks the runtime to do something. */
function keys(state: TuiState, ...names: string[]): TuiState {
  return names.reduce((s, name) => {
    const { state: next, effects } = press(s, name);
    expect(effects).toEqual([]);
    return next;
  }, state);
}

const MODELS: Record<string, { id: string; label: string; efforts: string[] }[]> = {
  claude: [
    { id: 'opus', label: 'Opus', efforts: ['low', 'high'] },
    { id: 'haiku', label: 'Haiku', efforts: [] },
  ],
  codex: [{ id: 'gpt', label: 'GPT', efforts: ['medium', 'xhigh'] }],
};

const effortsOf = (choices: StepChoices): string[] =>
  MODELS[choices.harness]?.find((m) => m.id === choices.model)?.efforts ?? [];

/**
 * Saves the way a real hook does: the state takes the choice at once, and an
 * effect goes out only when something changed.
 */
function savePlanner(state: TuiState, choices: StepChoices): Step {
  const effort = choices.effort ?? '';
  const { harness, model } = choices;
  if (harness === state.plannerProvider && model === state.orchestratorModel && effort === state.plannerEffort) return { state, effects: [] };
  return {
    state: { ...state, plannerProvider: harness, orchestratorModel: model, plannerEffort: effort },
    effects: [{ type: 'setPlannerChoice', provider: harness, modelId: model, effort, notice: '' }],
  };
}

const saved = (provider: string, modelId: string, effort: string) =>
  ({ type: 'setPlannerChoice' as const, provider, modelId, effort, notice: '' });

const planner: StepperDefinition = {
  title: 'Planner',
  afterSave: 'advance',
  steps: [
    {
      id: 'harness',
      label: 'Harness',
      items: (state) => [
        { id: 'claude', label: 'Claude Code', selected: state.plannerProvider === 'claude' },
        { id: 'codex', label: 'Codex', selected: state.plannerProvider === 'codex' },
        { id: 'opencode', label: 'OpenCode', detail: 'CLI not installed', disabled: true },
      ],
    },
    {
      id: 'model',
      label: 'Model',
      items: (state, choices) => (MODELS[choices.harness] ?? []).map((m) => ({
        id: m.id, label: m.label, selected: m.id === state.orchestratorModel,
      })),
    },
    {
      id: 'effort',
      label: 'Effort',
      skip: (_state, choices) => effortsOf(choices).length === 0,
      items: (state, choices) => effortsOf(choices).map((e) => ({ id: e, label: e, selected: e === state.plannerEffort })),
    },
  ],
  save: savePlanner,
};

const base = initialState({ plannerProvider: 'codex', orchestratorModel: 'gpt', plannerEffort: 'xhigh' });

function opened(state: TuiState = base): TuiState {
  const { state: next, effects } = openStepper(state, planner);
  expect(effects).toEqual([]);
  return next;
}

const stepperOf = (state: TuiState): StepperState => {
  if (state.overlay?.kind !== 'stepper') throw new Error('no stepper open');
  return state.overlay.stepper;
};

/** The step on screen, its highlighted row, and the header, in one comparable shape. */
const at = (state: TuiState) => {
  const s = stepperOf(state);
  return {
    step: s.definition.steps[s.current].id,
    row: s.items[s.index]?.id,
    trail: s.trail.map((t) => (t.active ? `[${t.label}]` : t.value ? `${t.label}: ${t.value}` : t.label)).join(' › '),
  };
};

const marked = (state: TuiState): string | undefined => stepperOf(state).items.find((i) => i.selected)?.id;

describe('stepper', () => {
  it('opens on the first step with the current value highlighted', () => {
    expect(at(opened())).toEqual({ step: 'harness', row: 'codex', trail: '[Harness] › Model › Effort' });
  });

  it('enter on an unchanged step saves nothing and moves on to the next, pre-selected', () => {
    expect(at(keys(opened(), 'enter'))).toEqual({ step: 'model', row: 'gpt', trail: 'Harness: Codex › [Model] › Effort' });
  });

  it("enter saves a changed step at once, with the later steps' pre-selections, and moves on", () => {
    const { state, effects } = press(keys(opened(), 'up'), 'enter');
    expect(effects).toEqual([saved('claude', 'opus', 'low')]);
    expect(state.plannerProvider).toBe('claude');
    expect(at(state)).toEqual({ step: 'model', row: 'opus', trail: 'Harness: Claude Code › [Model] › Effort' });
  });

  it("rebuilds a later step's rows from what an earlier step chose", () => {
    const s = press(keys(opened(), 'up'), 'enter').state;
    expect(stepperOf(s).items.map((i) => i.id)).toEqual(['opus', 'haiku']);
  });

  it("a changed choice drops the later steps' pre-selections, even ones the new rows still offer", () => {
    // Both sizes come in both colours; what a colour pre-selects is its own.
    const shirts: StepperDefinition = {
      title: 'Shirt',
      afterSave: 'advance',
      steps: [
        { id: 'colour', label: 'Colour', items: () => [{ id: 'red', label: 'Red', selected: true }, { id: 'blue', label: 'Blue' }] },
        { id: 'size', label: 'Size', items: (_s, c) => ['s', 'l'].map((id) => ({ id, label: id, selected: id === (c.colour === 'red' ? 's' : 'l') })) },
      ],
      save: (state) => ({ state, effects: [] }),
    };
    const open = openStepper(base, shirts).state;
    expect(at(keys(open, 'down', 'enter')).row).toBe('l');
  });

  it('leaves a step that does not apply out of the header and the walk', () => {
    const s = keys(press(keys(opened(), 'up'), 'enter').state, 'down');
    expect(at(s).trail).toBe('Harness: Claude Code › [Model] › Effort');
    const { state, effects } = press(s, 'enter');
    expect(state.overlay).toBeNull();
    expect(effects).toEqual([saved('claude', 'haiku', '')]);
  });

  it('drops a skipped step from the header when the current values skip it', () => {
    const s = opened(initialState({ plannerProvider: 'claude', orchestratorModel: 'haiku' }));
    expect(at(s).trail).toBe('[Harness] › Model');
  });

  it('esc closes from the first, a middle and the last step, saving nothing more', () => {
    const middle = keys(opened(), 'enter');
    const last = keys(opened(), 'enter', 'enter');
    expect(at(last).step).toBe('effort');
    for (const s of [opened(), middle, last]) {
      const { state, effects } = press(s, 'escape');
      expect(state.overlay).toBeNull();
      expect(effects).toEqual([]);
    }
  });

  it('esc keeps what enter already saved and drops a highlighted row never confirmed', () => {
    const s = keys(press(keys(opened(), 'up'), 'enter').state, 'down');
    const { state, effects } = press(s, 'escape');
    expect(state.overlay).toBeNull();
    expect(effects).toEqual([]);
    expect(state.plannerProvider).toBe('claude');
    expect(state.orchestratorModel).toBe('opus');
  });

  it('left back to a saved step shows the new value as the current one', () => {
    const s = keys(press(keys(opened(), 'up'), 'enter').state, 'left');
    expect(at(s)).toEqual({ step: 'harness', row: 'claude', trail: '[Harness] › Model › Effort' });
    expect(marked(s)).toBe('claude');
  });

  it("tab jumps ahead without taking the highlighted row as the step's choice", () => {
    const s = keys(opened(), 'up', 'tab');
    expect(at(s)).toEqual({ step: 'model', row: 'gpt', trail: 'Harness: Codex › [Model] › Effort' });
  });

  it('shift-tab jumps back to the step as it was chosen', () => {
    const s = keys(opened(), 'enter', 'down', 'shift-tab');
    expect(at(s)).toEqual({ step: 'harness', row: 'codex', trail: '[Harness] › Model › Effort' });
  });

  it('tab and shift-tab stop at the ends', () => {
    expect(at(keys(opened(), 'shift-tab')).step).toBe('harness');
    expect(at(keys(opened(), 'tab', 'tab', 'tab')).step).toBe('effort');
  });

  it("right jumps ahead without taking the highlighted row as the step's choice", () => {
    const s = keys(opened(), 'up', 'right');
    expect(at(s)).toEqual({ step: 'model', row: 'gpt', trail: 'Harness: Codex › [Model] › Effort' });
  });

  it('left jumps back to the step as it was chosen', () => {
    const s = keys(opened(), 'enter', 'down', 'left');
    expect(at(s)).toEqual({ step: 'harness', row: 'codex', trail: '[Harness] › Model › Effort' });
  });

  it('right and left stop at the ends, and left on the first step keeps the stepper open', () => {
    const first = keys(opened(), 'left');
    expect(first.overlay?.kind).toBe('stepper');
    expect(at(first).step).toBe('harness');
    expect(at(keys(opened(), 'right', 'right', 'right')).step).toBe('effort');
  });

  it('enter on the last step closes, saving only a change', () => {
    const s = keys(opened(), 'tab', 'tab');
    expect(at(s)).toEqual({ step: 'effort', row: 'xhigh', trail: 'Harness: Codex › Model: GPT › [Effort]' });
    const unchanged = press(s, 'enter');
    expect(unchanged.state.overlay).toBeNull();
    expect(unchanged.effects).toEqual([]);
    const changed = press(keys(s, 'up'), 'enter');
    expect(changed.state.overlay).toBeNull();
    expect(changed.effects).toEqual([saved('codex', 'gpt', 'medium')]);
  });

  it('a digit chooses its row on a numbered step and saves it', () => {
    const s = keys(opened(), 'enter', 'tab');
    const { state, effects } = press(s, 'char', '1');
    expect(effects).toEqual([saved('codex', 'gpt', 'medium')]);
    expect(state.overlay).toBeNull();
  });

  it('enter on a disabled row stays on the step', () => {
    const s = keys(opened(), 'down');
    const { state, effects } = press(s, 'enter');
    expect(effects).toEqual([]);
    expect(at(state).step).toBe('harness');
  });

  it('with no step applying, hands the hook what there is and opens nothing', () => {
    const saves: StepChoices[] = [];
    const none: StepperDefinition = {
      ...planner,
      steps: planner.steps.map((s) => ({ ...s, skip: () => true })),
      save: (state, choices) => {
        saves.push(choices);
        return { state, effects: [] };
      },
    };
    expect(openStepper(base, none).state.overlay).toBeNull();
    expect(saves).toEqual([{}]);
  });
});

describe('stepper that stays on the step', () => {
  /**
   * A list and two counts, saved straight onto the state: the list is
   * `autonomous`, the counts `maxParallel` and the supervisor's retry limit.
   */
  function counts(): { definition: StepperDefinition; saves: StepChoices[] } {
    const saves: StepChoices[] = [];
    const definition: StepperDefinition = {
      title: 'Run',
      afterSave: 'stay',
      steps: [
        {
          id: 'pace',
          label: 'Pace',
          items: (state) => [{ id: 'fast', label: 'Fast', selected: state.autonomous }, { id: 'slow', label: 'Slow', selected: !state.autonomous }],
        },
        { id: 'workers', label: 'Workers', number: { min: 1, current: (state) => state.maxParallel } },
        { id: 'retries', label: 'Retries', number: { min: 0, current: (state) => state.runSettings.supervisorRetryLimit } },
      ],
      save: (state, choices) => {
        saves.push(choices);
        return {
          state: {
            ...state,
            autonomous: choices.pace === 'fast',
            maxParallel: Number(choices.workers),
            runSettings: { ...state.runSettings, supervisorRetryLimit: Number(choices.retries) },
          },
          effects: [],
        };
      },
    };
    return { definition, saves };
  }
  const start = (definition: StepperDefinition): TuiState =>
    openStepper(initialState({ autonomous: true, maxParallel: 5, runSettings: { ...base.runSettings, supervisorRetryLimit: 2 } }), definition).state;
  const type = (state: TuiState, text: string): TuiState =>
    [...text].reduce((s, char) => {
      const { state: next, effects } = press(s, 'char', char);
      expect(effects).toEqual([]);
      return next;
    }, state);
  const entry = (state: TuiState): string | undefined => stepperOf(state).entry?.text;

  it('enter on a list row saves it and stays on the step, the row marked current', () => {
    const { definition, saves } = counts();
    const s = keys(start(definition), 'down', 'enter');
    expect(saves).toEqual([{ pace: 'slow', workers: '5', retries: '2' }]);
    expect(at(s)).toEqual({ step: 'pace', row: 'slow', trail: '[Pace] › Workers › Retries' });
    expect(marked(s)).toBe('slow');
    expect(s.autonomous).toBe(false);
  });

  it('a step saved earlier shows its new value in the header and on a revisit', () => {
    const { definition } = counts();
    const s = keys(start(definition), 'down', 'enter', 'right');
    expect(at(s).trail).toBe('Pace: Slow › [Workers] › Retries');
    expect(marked(keys(s, 'left'))).toBe('slow');
  });

  it('opens a number step pre-filled with the current value', () => {
    const { definition } = counts();
    const s = keys(start(definition), 'right');
    expect(at(s).step).toBe('workers');
    expect(entry(s)).toBe('5');
  });

  it('the first digit replaces the pre-filled value, later ones append, and enter saves the number', () => {
    const { definition, saves } = counts();
    const s = type(keys(start(definition), 'right'), '17');
    expect(entry(s)).toBe('17');
    const next = keys(s, 'enter');
    expect(saves).toEqual([{ pace: 'fast', workers: '17', retries: '2' }]);
    expect(at(next).step).toBe('workers');
    expect(entry(next)).toBe('17');
    expect(next.maxParallel).toBe(17);
  });

  it('enter does nothing while the number is below the minimum or empty', () => {
    const { definition, saves } = counts();
    const zero = type(keys(start(definition), 'right'), '0');
    expect(entry(keys(zero, 'enter'))).toBe('0');
    const empty = keys(start(definition), 'right', 'backspace');
    expect(entry(empty)).toBe('');
    expect(at(keys(empty, 'enter')).step).toBe('workers');
    expect(saves).toEqual([]);
  });

  it('esc closes with digits typed, without saving them', () => {
    const { definition, saves } = counts();
    const s = type(keys(start(definition), 'right'), '17');
    const { state, effects } = press(s, 'escape');
    expect(state.overlay).toBeNull();
    expect(effects).toEqual([]);
    expect(saves).toEqual([]);
    expect(state.maxParallel).toBe(5);
  });

  it('takes 0 where the minimum is 0', () => {
    const { definition, saves } = counts();
    keys(type(keys(start(definition), 'right', 'right'), '0'), 'enter');
    expect(saves).toEqual([{ pace: 'fast', workers: '5', retries: '0' }]);
  });

  it('typing the pre-filled digit still starts a fresh number', () => {
    const { definition } = counts();
    expect(entry(type(keys(start(definition), 'right'), '55'))).toBe('55');
  });

  it('ignores anything but digits', () => {
    const { definition } = counts();
    expect(entry(type(keys(start(definition), 'right'), '1a-2'))).toBe('12');
  });

  it('↑ and ↓ step the number by one and stop at the minimum', () => {
    const { definition } = counts();
    const s = keys(start(definition), 'right');
    expect(entry(keys(s, 'up', 'up'))).toBe('7');
    expect(entry(keys(s, ...Array<string>(6).fill('down')))).toBe('1');
    expect(entry(keys(type(s, '0'), 'down'))).toBe('1');
    expect(entry(keys(start(definition), 'right', 'right', 'down', 'down', 'down'))).toBe('0');
  });

  it('a digit after ↑ or ↓ starts the number afresh', () => {
    const { definition } = counts();
    expect(entry(type(keys(start(definition), 'right', 'up'), '3'))).toBe('3');
  });

  it('switching steps drops a typed number never confirmed', () => {
    const { definition, saves } = counts();
    const s = keys(type(keys(start(definition), 'right'), '17'), 'right');
    expect(at(s)).toEqual({ step: 'retries', row: undefined, trail: 'Pace: Fast › Workers: 5 › [Retries]' });
    expect(entry(keys(s, 'left'))).toBe('5');
    keys(s, 'enter');
    expect(saves).toEqual([{ pace: 'fast', workers: '5', retries: '2' }]);
  });
});

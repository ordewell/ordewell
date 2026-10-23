import { describe, it, expect, beforeAll } from 'vitest';
import { render } from '../render';
import { style } from '../ansi';
import { initialState, type PickerState, type TuiState } from '../state';
import { reduce } from '../reducer';
import { openStepper, type StepperDefinition } from '../reducers/stepper';

beforeAll(() => {
  style.enabled = false;
});

function pickerScreen(over: Partial<PickerState>, state: Partial<TuiState> = {}): string[] {
  return render(initialState({
    rows: 24,
    cols: 60,
    ...state,
    overlay: {
      kind: 'picker',
      picker: {
        title: 'Planner',
        items: [],
        filter: '',
        index: 0,
        multi: false,
        chosen: [],
        filterable: false,
        action: { kind: 'delete-session' },
        ...over,
      },
    },
  })).map((line) => line.trimEnd());
}

const harnesses = [
  { id: 'claude-code', label: 'Claude Code', detail: 'coding agent', selected: true },
  { id: 'codex', label: 'Codex', detail: 'coding agent' },
  { id: 'opencode', label: 'OpenCode', detail: 'CLI not installed', disabled: true },
];

describe('picker rows', () => {
  it('numbers a fixed list and lines the detail up in its own column', () => {
    const out = pickerScreen({ items: harnesses, hint: 'Who writes the plan.' });
    const top = out.findIndex((l) => l.includes('Planner'));
    expect(out.slice(top, top + 7)).toEqual([
      '╭─ Planner ────────────────────────────────────────────────',
      ' Who writes the plan.',
      '',
      ' ❯ 1. Claude Code ✔  coding agent',
      '   2. Codex          coding agent',
      '   3. OpenCode       CLI not installed',
      '',
    ]);
  });

  it('wraps a long detail under its own column', () => {
    const out = pickerScreen({
      items: [
        { id: 'a', label: 'Alpha', detail: 'a detail long enough that it has to wrap onto a second line' },
        { id: 'b', label: 'Beta' },
      ],
    });
    const top = out.findIndex((l) => l.includes('1. Alpha'));
    expect(out.slice(top, top + 3)).toEqual([
      ' ❯ 1. Alpha  a detail long enough that it has to wrap onto',
      '             a second line',
      '   2. Beta',
    ]);
  });

  it('says how many rows are above and below instead of clipping them', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, label: `model-${i}` }));
    const out = pickerScreen({ items, index: 15, filterable: true, action: { kind: 'delete-session' } });
    const up = out.find((l) => l.includes('↑'));
    const down = out.find((l) => l.includes('↓'));
    expect(up?.trim()).toMatch(/^↑ … \+\d+ more$/);
    expect(down?.trim()).toMatch(/^↓ … \+\d+ more$/);
    const shown = out.filter((l) => /model-\d+/.test(l)).length;
    const hidden = Number(/\+(\d+)/.exec(up!)![1]) + Number(/\+(\d+)/.exec(down!)![1]);
    expect(shown + hidden).toBe(30);
    expect(out.some((l) => l.includes('❯ model-15'))).toBe(true);
  });

  it('shows no marker at the top of a list that starts on screen', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, label: `model-${i}` }));
    const out = pickerScreen({ items, filterable: true, action: { kind: 'delete-session' } });
    expect(out.some((l) => l.includes('↑'))).toBe(false);
    expect(out.some((l) => l.includes('↓'))).toBe(true);
  });

  it('gives a filterable list a filter line and no numbers', () => {
    const out = pickerScreen({
      title: 'Planner model',
      items: [{ id: 'gpt-5', label: 'GPT-5' }, { id: 'o3', label: 'o3' }],
      filter: 'g',
      filterable: true,
      action: { kind: 'delete-session' },
    });
    expect(out).toContain(' filter: g▏');
    expect(out).toContain(' ❯ GPT-5');
    expect(out.join('\n')).not.toMatch(/\d\. GPT/);
  });

  it('keeps the filter line out of a fixed list', () => {
    const out = pickerScreen({ items: harnesses });
    expect(out.join('\n')).not.toContain('filter:');
  });

  it("names the keys that apply in the footer", () => {
    expect(pickerScreen({ items: harnesses })).toContain(' enter selects · esc cancels');
    expect(pickerScreen({ items: harnesses, filterable: true })).toContain(' enter selects · esc cancels · type to filter');
    expect(pickerScreen({ items: harnesses, multi: true, filterable: true }, { cols: 80 })).toContain(
      ' space toggles · enter confirms · esc cancels · type to filter',
    );
  });

  it('ticks a multi-select with boxes, not the current-value mark', () => {
    const out = pickerScreen({ items: harnesses, multi: true, chosen: ['codex'] });
    expect(out).toContain('   2. [✓] Codex        coding agent');
    expect(out.join('\n')).not.toContain('✔');
  });
});

describe('picker paint', () => {
  beforeAll(() => {
    style.enabled = true;
    return () => {
      style.enabled = false;
    };
  });

  it('draws the active row on a bar that survives the colour inside it', () => {
    const out = pickerScreen({ items: harnesses });
    const active = out.find((l) => l.includes('❯'))!;
    expect(active.startsWith(' \x1b[7m')).toBe(true);
    expect(active).toContain('\x1b[1mClaude Code\x1b[0m\x1b[7m');
  });

  it('greys a disabled row whole, reason included', () => {
    const out = pickerScreen({ items: harnesses });
    const row = out.find((l) => l.includes('OpenCode'))!;
    expect(row).toContain(style.grey('OpenCode'));
    expect(row).toContain(style.grey('CLI not installed'));
  });

  it('paints key names bold and their meaning grey', () => {
    const out = pickerScreen({ items: harnesses });
    expect(out).toContain(` ${style.bold('enter')} ${style.grey('selects')}${style.grey(' · ')}${style.bold('esc')} ${style.grey('cancels')}`);
  });
});

describe('stepper', () => {
  const definition: StepperDefinition = {
    title: 'Planner',
    afterSave: 'advance',
    steps: [
      {
        id: 'harness',
        label: 'Harness',
        items: () => [
          { id: 'claude', label: 'Claude Code' },
          { id: 'codex', label: 'Codex', selected: true },
          { id: 'opencode', label: 'OpenCode', detail: 'CLI not installed', disabled: true },
        ],
      },
      { id: 'model', label: 'Model', hint: 'Models this harness runs.', items: () => [{ id: 'gpt', label: 'GPT' }] },
    ],
    save: (state) => ({ state, effects: [] }),
  };
  const screen = (state: TuiState): string[] => render(state).map((line) => line.trimEnd());

  it('draws every step in the header above the active step as a list', () => {
    const out = screen(openStepper(initialState({ rows: 24, cols: 60 }), definition).state);
    const top = out.findIndex((l) => l.includes('Planner'));
    expect(out.slice(top + 1, top + 8)).toEqual([
      ' Harness › Model',
      '',
      '   1. Claude Code',
      ' ❯ 2. Codex ✔',
      '   3. OpenCode     CLI not installed',
      '',
      ' enter next · ←/→ switch step · esc closes',
    ]);
  });

  it('shows a passed step with its value on a later step', () => {
    const opened = openStepper(initialState({ rows: 24, cols: 60 }), definition).state;
    const out = screen(reduce(opened, { type: 'key', key: { name: 'enter' } }).state);
    const top = out.findIndex((l) => l.includes('Planner'));
    expect(out.slice(top + 1, top + 7)).toEqual([
      ' Harness: Codex › Model',
      ' Models this harness runs.',
      '',
      ' ❯ 1. GPT',
      '',
      ' enter done · ←/→ switch step · esc closes',
    ]);
  });

  it('highlights the active step in the header', () => {
    style.enabled = true;
    try {
      const out = render(openStepper(initialState({ rows: 24, cols: 60 }), definition).state);
      expect(out.some((l) => l.includes(style.highlight(style.bold('Harness'))))).toBe(true);
    } finally {
      style.enabled = false;
    }
  });

  it('draws a number step as one input line with its minimum, and says enter sets it where enter stays', () => {
    const counts: StepperDefinition = {
      title: 'Settings',
      afterSave: 'stay',
      steps: [
        { id: 'pace', label: 'Pace', items: () => [{ id: 'fast', label: 'Fast', selected: true }] },
        { id: 'parallel', label: 'Parallel', hint: 'How many tasks run at once.', number: { min: 1, current: () => 7 } },
      ],
      save: (state) => ({ state, effects: [] }),
    };
    const opened = openStepper(initialState({ rows: 24, cols: 60 }), counts).state;
    const list = screen(opened);
    expect(list).toContain(' enter sets · ←/→ switch step · esc closes');
    const out = screen(reduce(opened, { type: 'key', key: { name: 'right' } }).state);
    const top = out.findIndex((l) => l.includes('Settings'));
    expect(out.slice(top + 1, top + 8)).toEqual([
      ' Pace: Fast › Parallel',
      ' How many tasks run at once.',
      '',
      ' ❯ 7▏',
      ' At least 1.',
      '',
      ' enter sets · ↑/↓ change · ←/→ switch step · esc closes',
    ]);
  });
});


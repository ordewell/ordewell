import { parseCount } from '@ordewell/core';
import type { Key } from '../keys';
import { matchingItems, type PickerItem, type TuiState } from '../state';
import { say } from '../transcript';
import { digitRow, editText, step, type Step } from './shared';

/** What each step has chosen so far, keyed by step id. */
export type StepChoices = Readonly<Record<string, string>>;

interface StepBase {
  id: string;
  /** The step's name in the header. */
  label: string;
  hint?: string;
  /** Whether the step applies, given the steps before it; a skipped step is neither asked nor shown. */
  skip?(state: TuiState, choices: StepChoices): boolean;
}

export interface ListStep extends StepBase {
  /** A long list narrows as the user types; a short one is numbered instead, as in a picker. */
  filterable?: boolean;
  /** The rows, given what the steps before this one chose — the current value marked `selected`. */
  items(state: TuiState, choices: StepChoices): PickerItem[];
  number?: undefined;
}

/** A whole number typed in, for a setting with no useful short list of values. */
export interface NumberStep extends StepBase {
  number: {
    min: number;
    current(state: TuiState, choices: StepChoices): number;
  };
}

export type StepDefinition = ListStep | NumberStep;

/**
 * A command that sets several related values, one step each. It lives in the
 * overlay as functions rather than as a data action the way `PickerAction`
 * does: a step's rows depend on the choices before it, so they cannot be
 * computed when the overlay opens, and nothing serialises `TuiState`.
 */
export interface StepperDefinition {
  title: string;
  hint?: string;
  steps: StepDefinition[];
  /**
   * What a saved step does next. `'advance'` moves on to the next applicable
   * step and closes after the last one; `'stay'` keeps the step on screen to
   * show what it saved, and only Esc closes — a settings menu, where every
   * enter is its own save.
   */
  afterSave: 'advance' | 'stay';
  /**
   * Called on every enter with every applicable step's choice, and expected to
   * save only what differs from `state` — updating `state` too, since the rows
   * are rebuilt from it to show the choice as the current one. It runs with
   * the stepper still open: a hook that puts an overlay of its own in its
   * place, such as a confirmation, owns the way back.
   */
  save(state: TuiState, choices: StepChoices): Step;
}

/** One step in the header. `value` is the chosen row's label, on a step already passed. */
export interface StepTrail {
  label: string;
  value?: string;
  active: boolean;
}

export interface StepperState {
  definition: StepperDefinition;
  /** Index into `definition.steps` of the step on screen. */
  current: number;
  /** Every applicable step's value: its pre-selection until the user confirms another. */
  choices: Record<string, string>;
  /** The step on screen as a list — rows, highlight and filter, the way a picker keeps them. */
  items: PickerItem[];
  index: number;
  filter: string;
  /**
   * The step on screen as a number, present only on one: the digits as typed.
   * While `pristine` it still holds the pre-filled value, which the first
   * digit replaces rather than extends.
   */
  entry?: { text: string; pristine: boolean };
  /** Derived on every move so the renderer only has to read it. */
  trail: StepTrail[];
}

/** Opens `definition` on its first applicable step; with none applying there is nothing to ask. */
export function openStepper(state: TuiState, definition: StepperDefinition): Step {
  const { choices, lists } = settle(state, definition, {});
  const first = lists.findIndex((list) => list !== null);
  if (first === -1) return definition.save(state, choices);
  return step({ ...state, overlay: { kind: 'stepper', stepper: show(state, definition, choices, first) } });
}

/**
 * Rebuilds the open stepper's rows from fresh state — runners, models or the
 * daemon's answer to a save, landed after it opened — keeping its step,
 * choices, filter and highlighted row. A step the new data would skip stays
 * on screen as it was; moving the user off it mid-answer would be the more
 * confusing of the two.
 */
export function refreshStepper(state: TuiState): TuiState {
  const overlay = state.overlay;
  if (overlay?.kind !== 'stepper') return state;
  const { definition, current, choices, filter, entry, items, index } = overlay.stepper;
  if (settle(state, definition, choices).lists[current] === null) return state;
  const fresh = show(state, definition, choices, current);
  if (entry) return { ...state, overlay: { kind: 'stepper', stepper: { ...fresh, entry } } };
  const highlighted = matchingItems(items, filter)[index]?.id;
  const at = matchingItems(fresh.items, filter).findIndex((item) => item.id === highlighted);
  const stepper = { ...fresh, filter, index: at !== -1 ? at : filter ? 0 : fresh.index };
  return { ...state, overlay: { kind: 'stepper', stepper } };
}

export function handleStepperKey(state: TuiState, stepper: StepperState, key: Key): Step {
  const reopen = (next: StepperState): Step => step({ ...state, overlay: { kind: 'stepper', stepper: next } });
  const { definition, current, entry, choices } = stepper;
  const def = definition.steps[current];
  const typed = def.number && entry ? parseCount(entry.text, def.number.min) : null;
  const { lists } = settle(state, definition, choices);
  const items = matchingItems(stepper.items, stepper.filter);
  const before = lastIndexBefore(lists, current);
  const after = lists.findIndex((list, i) => i > current && list !== null);

  // Esc closes from any step, even with a filter or digits typed, and undoes
  // nothing: every enter already saved its step, and a row or number never
  // confirmed was never saved.
  if (key.name === 'escape') return step({ ...state, overlay: null });
  // Jumps leave the highlighted row or typed number unconfirmed: tab and the arrows are
  // for reaching one setting, not for answering every one on the way.
  if (key.name === 'tab' || key.name === 'right') return after === -1 ? reopen(stepper) : reopen(show(state, definition, choices, after));
  if (key.name === 'shift-tab' || key.name === 'left') return before === -1 ? reopen(stepper) : reopen(show(state, definition, choices, before));
  if (def.number) {
    const { min } = def.number;
    const shown = entry ?? { text: choices[def.id], pristine: true };
    if (key.name === 'enter') return typed === null ? reopen(stepper) : choose(state, stepper, String(typed));
    if (key.name === 'up' || key.name === 'down') {
      const from = /^\d+$/.test(shown.text) ? Number(shown.text) : Number(choices[def.id]);
      const to = Math.max(min, from + (key.name === 'up' ? 1 : -1));
      return reopen({ ...stepper, entry: { text: String(to), pristine: true } });
    }
    const replacing = shown.pristine && (key.name === 'char' || key.name === 'paste');
    const text = editText(replacing ? '' : shown.text, key);
    const unchanged = text === shown.text && !replacing;
    return unchanged || !/^\d*$/.test(text) ? reopen(stepper) : reopen({ ...stepper, entry: { text, pristine: false } });
  }
  if (key.name === 'up' || key.name === 'scrollup') return reopen({ ...stepper, index: Math.max(0, stepper.index - 1) });
  if (key.name === 'down' || key.name === 'scrolldown') {
    return reopen({ ...stepper, index: Math.max(0, Math.min(items.length - 1, stepper.index + 1)) });
  }
  if (key.name === 'enter') return confirm(state, stepper, items[stepper.index]);

  if (!def.filterable) {
    const row = digitRow(key);
    return row === null || !items[row] ? reopen(stepper) : confirm(state, { ...stepper, index: row }, items[row]);
  }
  const filter = editText(stepper.filter, key);
  return filter === stepper.filter ? reopen(stepper) : reopen({ ...stepper, filter, index: 0 });
}

function confirm(state: TuiState, stepper: StepperState, item: PickerItem | undefined): Step {
  if (!item) return step(state);
  if (item.disabled) {
    return step(say(state, 'error', item.detail ? `${item.label}: ${item.detail}` : `${item.label} is not available.`));
  }
  return choose(state, stepper, item.id);
}

/** Where a saved choice leaves the stepper: on a step to show, or closed. */
type AfterChoice = { flow: 'advance' | 'stay'; step: number } | { flow: 'close' };

/**
 * The one place a saved step's successor is decided, as data rather than as
 * a sentinel index. `'advance'` walks to the next applicable step and closes
 * once none is left; `'stay'` shows the same step again with the choice
 * marked — and closes when the save made that very step stop applying, for
 * then there is nothing left to show.
 */
function afterChoice(definition: StepperDefinition, lists: readonly (PickerItem[] | null)[], current: number): AfterChoice {
  if (definition.afterSave === 'stay') {
    return lists[current] === null ? { flow: 'close' } : { flow: 'stay', step: current };
  }
  const next = lists.findIndex((list, i) => i > current && list !== null);
  return next === -1 ? { flow: 'close' } : { flow: 'advance', step: next };
}

/** Saves `value` as the step's choice, then stays, moves on, or closes after the last step. */
function choose(state: TuiState, stepper: StepperState, value: string): Step {
  const { definition, current } = stepper;
  const id = definition.steps[current].id;
  // A later step's value is only a pre-selection until confirmed, and it was
  // derived from the old answer; kept, it would outlive the choice it came from.
  const kept = value === stepper.choices[id]
    ? stepper.choices
    : Object.fromEntries(definition.steps.slice(0, current).flatMap((s) => (s.id in stepper.choices ? [[s.id, stepper.choices[s.id]]] : [])));
  const { choices } = settle(state, definition, { ...kept, [id]: value });
  const open = { ...state, overlay: { kind: 'stepper' as const, stepper } };
  const saved = definition.save(open, choices);
  if (saved.state.overlay !== open.overlay) return saved;

  // Rebuilt from the saved state, so an earlier choice that changed which steps apply shows at once.
  const { lists } = settle(saved.state, definition, choices);
  const after = afterChoice(definition, lists, current);
  if (after.flow === 'close') return { ...saved, state: { ...saved.state, overlay: null } };
  return { ...saved, state: { ...saved.state, overlay: { kind: 'stepper', stepper: show(saved.state, definition, choices, after.step) } } };
}

/**
 * `stepper` back on screen on the same step, its choices taken afresh from
 * what `state` holds now — for a hook's own overlay to return to once it is
 * answered.
 */
export function reopenStepper(state: TuiState, stepper: StepperState): TuiState {
  const { definition, current } = stepper;
  const { lists } = settle(state, definition, {});
  const at = lists[current] !== null ? current : lists.findIndex((list) => list !== null);
  if (at === -1) return { ...state, overlay: null };
  return { ...state, overlay: { kind: 'stepper', stepper: show(state, definition, {}, at) } };
}

/**
 * Walks the steps in order, building each one's rows from the choices before
 * it. A wanted value a step still offers is kept; one it no longer offers —
 * an earlier step changed under it — falls back to the step's current value,
 * then to its first choosable row. A number step keeps a wanted whole number
 * at or above its minimum and otherwise takes its current value; it has no
 * rows, so its list is empty. A step that does not apply gets `null`.
 */
function settle(
  state: TuiState,
  definition: StepperDefinition,
  wanted: StepChoices,
): { choices: Record<string, string>; lists: (PickerItem[] | null)[] } {
  const choices: Record<string, string> = {};
  const lists = definition.steps.map((def) => {
    if (def.skip?.(state, { ...choices })) return null;
    if (def.number) {
      choices[def.id] = String(parseCount(wanted[def.id], def.number.min) ?? def.number.current(state, { ...choices }));
      return [];
    }
    const items = def.items(state, { ...choices });
    const open = items.filter((item) => !item.disabled);
    const kept = open.find((item) => item.id === wanted[def.id]) ?? open.find((item) => item.selected) ?? open[0];
    if (kept) choices[def.id] = kept.id;
    return items;
  });
  return { choices, lists };
}

/** The stepper on step `current`, which must be one that applies under `wanted`. */
function show(state: TuiState, definition: StepperDefinition, wanted: StepChoices, current: number): StepperState {
  const { choices, lists } = settle(state, definition, wanted);
  const items = lists[current] ?? [];
  const trail = lists.flatMap((list, i): StepTrail[] => {
    if (list === null) return [];
    const def = definition.steps[i];
    const value = i >= current ? undefined : def.number ? choices[def.id] : list.find((item) => item.id === choices[def.id])?.label;
    return [{ label: def.label, active: i === current, ...(value !== undefined ? { value } : {}) }];
  });
  const def = definition.steps[current];
  const id = choices[def.id];
  return {
    definition,
    current,
    choices,
    items,
    index: Math.max(0, items.findIndex((item) => item.id === id)),
    filter: '',
    trail,
    ...(def.number ? { entry: { text: id, pristine: true } } : {}),
  };
}

function lastIndexBefore(lists: (PickerItem[] | null)[], index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) if (lists[i] !== null) return i;
  return -1;
}

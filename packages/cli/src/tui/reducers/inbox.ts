import type { Escalation, EscalationOption } from '@ordewell/core';
import { sanitize, truncate } from '../ansi';
import type { PickerItem, PickerState, PromptAction, TuiState } from '../state';
import { say } from '../transcript';
import { fail, step, type Effect, type Step } from './shared';
import { openTaskView } from './taskView';

/** The answers that start a runner, so the run's stream is held open around them as for `taskAction` (see `taskActionEffect`). */
const SPAWNS_RUNNER = new Set(['retry', 'resume', 'continue', 'force-start', 'run']);

/** Not an option id: the row that opens the escalation's task, as `/open` does. */
const OPEN_TASK = '__open-task';

const NOTHING = 'Nothing is waiting on you.';
const GONE = 'That is no longer waiting on you: the list changed. Run /inbox to see what is.';

/** Absent from an older daemon's snapshot. */
const listOf = (state: TuiState): readonly Escalation[] => state.run.escalations ?? [];

const find = (state: TuiState, id: string): Escalation | undefined => listOf(state).find((e) => e.id === id);

/**
 * Titles, reasons and request text come from a model or a runner, so they are
 * sanitized where they are drawn and held to one line the width of the
 * terminal, as the tool rows are.
 */
const oneLine = (state: TuiState, text: string): string => truncate(sanitize(text).replace(/\s+/g, ' ').trim(), Math.max(1, state.cols));

const labelOf = (state: TuiState, e: Escalation): string =>
  e.task ? oneLine(state, `${e.task.ref} ${e.task.title}`) : 'The run';

export function inboxItems(state: TuiState): PickerItem[] {
  return listOf(state).map((e) => ({ id: e.id, label: labelOf(state, e), detail: oneLine(state, e.reason) }));
}

function optionDetail(option: EscalationOption): string | undefined {
  if (option.confirm) return 'asks first';
  if (option.note === 'required') return 'needs a note';
  if (option.note === 'optional') return 'takes a note';
  return undefined;
}

function answerItems(state: TuiState, e: Escalation): PickerItem[] {
  const options = e.options.map((o): PickerItem => ({ id: o.id, label: o.label, detail: optionDetail(o) }));
  return e.task ? [...options, { id: OPEN_TASK, label: 'Open the task', detail: oneLine(state, `${e.task.ref} ${e.task.title}`) }] : options;
}

function inboxPicker(state: TuiState, index = 0): PickerState {
  return {
    title: 'Waiting on you', items: inboxItems(state), filter: '', index, multi: false, chosen: [], filterable: false, action: { kind: 'inbox' },
  };
}

function answerPicker(state: TuiState, e: Escalation): PickerState {
  return {
    title: labelOf(state, e), hint: oneLine(state, e.reason), items: answerItems(state, e), filter: '', index: 0, multi: false, chosen: [], filterable: false,
    action: { kind: 'inbox-answer', escalationId: e.id },
  };
}

/** `/inbox`: what waits on the person, numbered; one line when nothing does. */
export function openInbox(state: TuiState): Step {
  if (listOf(state).length === 0) return step(say(state, 'system', NOTHING));
  return step({ ...state, overlay: { kind: 'picker', picker: inboxPicker(state) } });
}

/** Choosing an entry shows its options, and the task it belongs to. */
export function chooseEscalation(state: TuiState, id: string): Step {
  const e = find(state, id);
  if (!e) return gone(state);
  return step({ ...state, overlay: { kind: 'picker', picker: answerPicker(state, e) } });
}

export function chooseAnswer(state: TuiState, escalationId: string, itemId: string): Step {
  const e = find(state, escalationId);
  if (!e) return gone(state);
  const closed: TuiState = { ...state, overlay: null };
  if (itemId === OPEN_TASK) {
    return e.task && state.sessionId ? openTaskView(closed, state.sessionId, e.task.id) : step(closed);
  }
  const option = e.options.find((o) => o.id === itemId);
  if (!option) return gone(state);

  if (option.note) {
    return step({
      ...state,
      overlay: {
        kind: 'prompt',
        title: `${option.label}: ${oneLine(state, e.reason)}`,
        hint: option.note === 'required' ? 'A note is required. Enter sends it, esc cancels.' : 'A note is optional: enter alone sends none, esc cancels.',
        value: '',
        action: { kind: 'escalation-note', escalationId, option: option.id, required: option.note === 'required', ...(option.confirm ? { confirm: option.confirm } : {}) },
      },
    });
  }
  return option.confirm ? askFirst(state, escalationId, option) : submit(closed, escalationId, option.id);
}

/** The note typed for an option; empty is refused only where the note is required. */
export function noteEntered(
  state: TuiState,
  action: Extract<PromptAction, { kind: 'escalation-note' }>,
  note: string,
): Step {
  if (!note && action.required) return step(state);
  const closed: TuiState = { ...state, overlay: null };
  const option = find(state, action.escalationId)?.options.find((o) => o.id === action.option);
  if (!option) return gone(closed);
  return option.confirm ? askFirst(state, action.escalationId, option, note) : submit(closed, action.escalationId, option.id, note);
}

/** The card's own question first: choosing the option does not count as the yes (ADR-0053). */
function askFirst(state: TuiState, escalationId: string, option: EscalationOption, note?: string): Step {
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: `${option.label}?`,
      message: sanitize(option.confirm ?? ''),
      action: { kind: 'answer-escalation', escalationId, option: option.id, ...(note ? { note } : {}) },
    },
  });
}

/** The yes given: the answer goes out with it. */
export function confirmedAnswer(state: TuiState, escalationId: string, option: string, note?: string): Step {
  return submit({ ...state, overlay: null }, escalationId, option, note, true);
}

function submit(state: TuiState, escalationId: string, option: string, note?: string, confirmed?: true): Step {
  if (!state.sessionId) return fail(state, 'No active plan.');
  // The daemon refuses a stale id too, in the same words; saying so here costs no round trip.
  if (!find(state, escalationId)) return fail(state, GONE);
  const effect: Effect = {
    type: 'answerEscalation',
    sessionId: state.sessionId,
    id: escalationId,
    option,
    ...(note ? { note } : {}),
    ...(confirmed ? { confirmed } : {}),
    ...(SPAWNS_RUNNER.has(option) && state.status !== 'executing' ? { watch: true as const } : {}),
  };
  return step(state, [effect]);
}

/** Says so plainly, and leaves the person on the list as it is now. */
function gone(state: TuiState): Step {
  const refused = fail(state, GONE).state;
  return step(listOf(state).length === 0 ? { ...refused, overlay: null } : { ...refused, overlay: { kind: 'picker', picker: inboxPicker(state) } });
}

/**
 * The list changed under an open inbox: the rows follow it in place, with the
 * highlight kept on the same escalation. One that was answered elsewhere takes
 * its answers with it, back to the list.
 */
export function refillInbox(state: TuiState): TuiState {
  const overlay = state.overlay;
  if (overlay?.kind !== 'picker') return state;
  const { action } = overlay.picker;
  if (action.kind !== 'inbox' && action.kind !== 'inbox-answer') return state;

  if (action.kind === 'inbox') {
    if (listOf(state).length === 0) return say({ ...state, overlay: null }, 'system', NOTHING);
    const kept = overlay.picker.items[overlay.picker.index]?.id;
    const index = Math.max(0, listOf(state).findIndex((e) => e.id === kept));
    return { ...state, overlay: { kind: 'picker', picker: { ...inboxPicker(state, index) } } };
  }

  const e = find(state, action.escalationId);
  if (!e) return gone(state).state;
  const kept = overlay.picker.items[overlay.picker.index]?.id;
  const items = answerItems(state, e);
  const index = Math.max(0, items.findIndex((i) => i.id === kept));
  return { ...state, overlay: { kind: 'picker', picker: { ...answerPicker(state, e), index } } };
}

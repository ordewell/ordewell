import { taskRef, type AiProvider } from '@ordewell/core';
import { bodyRows, helpScrollMax } from '../layout';
import { findTask, visibleItems, type PickerItem, type PickerState, type TuiState } from '../state';
import type { Key } from '../keys';
import { handleApprovalKey } from './approvals';
import { keyPrompt, newSession, pickRewindTarget, withIdlePlanner } from './commands';
import { chooseBlocked, confirmedHandoff, handleHandoffKey, type BlockedChoice } from '../handoff';
import { DEFAULT_EFFORT, pickerItemsFor } from './pickers';
import { WHEEL_NOTCH, isWheel, pageNotch, scrollPointed } from './pointer';
import { taskActionEffect } from './planPane';
import { assignTaskEffort, assignTaskSkills, assignTaskMode, assignTaskModel, assignTaskRunner } from './taskEdits';
import { say } from '../transcript';
import { clamp, fail, step, type Step } from './shared';

export function handleOverlayKey(state: TuiState, overlay: NonNullable<TuiState['overlay']>, key: Key): Step {
  if (overlay.kind === 'help') return handleHelpKey(state, overlay.scroll ?? 0, key);
  // A sideways notch is not a keystroke, and every overlay below reads an
  // unhandled key as a cue to close or to hold still.
  if (key.name === 'wheelignored') return step(state);
  // Ahead of the wheel rule below: the diff is the one overlay with a list of
  // its own, so a notch scrolls it rather than the panes underneath.
  if (overlay.kind === 'handoff') return handleHandoffKey(state, overlay, key, bodyRows(state));
  // The pickers turn a notch into selection movement, which is what scrolls
  // their list. Everything else here floats over the panes with nothing of its
  // own to scroll, so the notch belongs to the pane underneath rather than in
  // the bin — an approval prompt used to freeze both panes solid.
  if (isWheel(key) && overlay.kind !== 'picker') return scrollPointed(state, key);
  if (overlay.kind === 'approval') return handleApprovalKey(state, overlay, key);
  if (overlay.kind === 'confirm') return handleConfirmKey(state, overlay, key);
  // Cancelling is a choice here, not a dismissal: the run is parked in the
  // daemon until it hears one.
  if (key.name === 'escape' && overlay.kind === 'picker' && overlay.picker.action.kind === 'isolation-blocked') {
    return chooseBlocked(state, 'cancel');
  }
  if (key.name === 'escape') return step({ ...state, overlay: null });
  if (overlay.kind === 'prompt') return handlePromptKey(state, overlay, key);
  return handlePickerKey(state, overlay.picker, key);
}

function handleConfirmKey(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'confirm' }>,
  key: Key,
): Step {
  if (key.name === 'escape') return step({ ...state, overlay: null });
  const { choice } = overlay;
  if (!choice) return key.name === 'enter' ? runConfirm(state, overlay) : step(state);

  if (key.name === 'up' || key.name === 'down') {
    const index = clamp(choice.index + (key.name === 'down' ? 1 : -1), choice.options.length - 1);
    return step({ ...state, overlay: { ...overlay, choice: { ...choice, index } } });
  }
  // Options are numbered from 1 on screen, so the digit names the row.
  const chosen = key.name === 'enter' ? choice.index : key.name === 'char' ? Number(key.char) - 1 : -1;
  const option = choice.options[chosen];
  if (!option) return step(state);
  return option.confirms ? runConfirm(state, overlay) : step({ ...state, overlay: null });
}

function runConfirm(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'confirm' }>,
): Step {
  const closed = { ...state, overlay: null };
  if (overlay.action.kind === 'new-session') return newSession(closed);
  if (overlay.action.kind === 'remove-task') {
    if (!state.sessionId) return step(closed);
    return step(closed, [{ type: 'removeTask', sessionId: state.sessionId, taskId: overlay.action.taskId }]);
  }
  if (overlay.action.kind === 'force-start-gated') {
    if (!state.sessionId) return step(closed);
    return step(closed, [taskActionEffect(closed, state.sessionId, overlay.action.taskId, 'force-start')]);
  }
  if (overlay.action.kind === 'merge-run' || overlay.action.kind === 'discard-run') {
    return confirmedHandoff(state, overlay.action.kind);
  }
  if (overlay.action.kind === 'init-workspace') {
    return step({ ...closed, status: 'planning' }, [{ type: 'startConversation', goal: overlay.action.goal, allowInit: true }]);
  }
  // The planner may have started answering while the popup was open.
  const { index } = overlay.action;
  return withIdlePlanner(closed, (sessionId) => step(closed, [{ type: 'rewindConversation', sessionId, index }]));
}

/**
 * The sheet is taller than most terminals, so it scrolls; anything else closes
 * it. The offsets here run the other way to the panes' — the sheet is
 * top-anchored, so a positive delta moves *down* it.
 */
function handleHelpKey(state: TuiState, scroll: number, key: Key): Step {
  const page = pageNotch(bodyRows(state));
  const move: Record<string, number> = {
    down: 1,
    up: -1,
    pagedown: page,
    pageup: -page,
    scrolldown: WHEEL_NOTCH,
    scrollup: -WHEEL_NOTCH,
  };
  const delta = move[key.name];
  if (delta === undefined) return step({ ...state, overlay: null });
  return step({ ...state, overlay: { kind: 'help', scroll: clamp(scroll + delta, helpScrollMax(state)) } });
}

function handlePromptKey(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'prompt' }>,
  key: Key,
): Step {
  if (key.name === 'enter') {
    const value = overlay.value.trim();
    const closed = { ...state, overlay: null };
    if (!value) return step(closed);

    if (overlay.action.kind === 'api-key') {
      return step(closed, [{ type: 'setApiKey', provider: overlay.action.provider, key: value }]);
    }
    if (!state.sessionId) return fail(closed, 'No active plan to add a task to — describe a goal first, then /add-task <title>.');
    return step(closed, [{ type: 'addTask', sessionId: state.sessionId, title: value }]);
  }

  const value = editText(overlay.value, key);
  return step({ ...state, overlay: { ...overlay, value } });
}

/** The picker filter and the prompt field are single-line fields with no cursor. */
function editText(value: string, key: Key): string {
  if (key.name === 'char') return value + (key.char ?? '');
  // Single-line fields flatten a paste's newlines; a copied API key often
  // drags a trailing newline along, and it must not act as enter here either.
  if (key.name === 'paste') return value + (key.text ?? '').replace(/\n/g, ' ');
  if (key.name === 'backspace') return value.slice(0, -1);
  if (key.name === 'ctrl-u') return '';
  return value;
}

function handlePickerKey(state: TuiState, picker: PickerState, key: Key): Step {
  const items = visibleItems(picker);
  const reopen = (next: PickerState): Step => step({ ...state, overlay: { kind: 'picker', picker: next } });

  if (key.name === 'up' || key.name === 'scrollup') return reopen({ ...picker, index: Math.max(0, picker.index - 1) });
  if (key.name === 'down' || key.name === 'scrolldown') {
    return reopen({ ...picker, index: Math.min(items.length - 1, picker.index + 1) });
  }

  // Space toggles membership in a multi-select; elsewhere it is filter text.
  if (picker.multi && key.name === 'char' && key.char === ' ') {
    const item = items[picker.index];
    if (!item) return reopen(picker);
    const chosen = picker.chosen.includes(item.id)
      ? picker.chosen.filter((id) => id !== item.id)
      : [...picker.chosen, item.id];
    return reopen({ ...picker, chosen });
  }

  if (key.name === 'enter') return choose(state, picker, items[picker.index]);

  const filter = editText(picker.filter, key);
  if (filter === picker.filter) return reopen(picker);
  return reopen({ ...picker, filter, index: 0 });
}

function choose(state: TuiState, picker: PickerState, item: PickerItem | undefined): Step {
  const closed: TuiState = { ...state, overlay: null };

  if (picker.action.kind === 'isolation-blocked') return chooseBlocked(state, (item?.id ?? 'cancel') as BlockedChoice);
  if (picker.action.kind === 'set-allowlist') {
    return step(closed, [{ type: 'setAllowlist', runner: picker.action.runner, modelIds: picker.chosen }]);
  }
  // Multi-select pickers commit `chosen` on enter, so they resolve before the
  // "nothing highlighted" guard: clearing every dependency is a real edit.
  if (picker.action.kind === 'set-runners') {
    const changes = state.runners
      .filter((runner) => runner.enabled !== picker.chosen.includes(runner.id))
      .map((runner) => ({ runner: runner.id, enabled: !runner.enabled }));
    if (changes.length === 0) return step(closed);
    const names = state.runners.filter((r) => picker.chosen.includes(r.id)).map((r) => r.name);
    return step(closed, [{
      type: 'setRunners',
      changes,
      message: names.length > 0
        ? `Runners enabled: ${names.join(', ')}.`
        : 'No runners enabled — the planner has nothing to assign work to.',
    }]);
  }
  if (picker.action.kind === 'set-task-deps') {
    const taskId = picker.action.taskId;
    const task = findTask(state.tasks, taskId);
    if (!task || !state.sessionId) return step(closed);
    return step(closed, [{
      type: 'updateTask',
      sessionId: state.sessionId,
      taskId: task.id,
      changes: { dependencies: picker.chosen },
      message: picker.chosen.length > 0
        ? `Task ${taskRef(task)} now depends on ${picker.chosen.length} task${picker.chosen.length === 1 ? '' : 's'}.`
        : `Task ${taskRef(task)} no longer depends on anything.`,
    }]);
  }
  if (picker.action.kind === 'set-task-skills') {
    const task = findTask(state.tasks, picker.action.taskId);
    if (!task || !state.sessionId) return step(closed);
    return assignTaskSkills(closed, state.sessionId, task, picker.chosen);
  }
  if (!item) return step(state);

  // Placeholder and unavailable rows are on screen to explain themselves, not
  // to be chosen. Keep the picker open so the reason stays readable.
  if (item.disabled) {
    return step(say(state, 'error', item.detail ? `${item.label} — ${item.detail}` : `${item.label} is not available.`));
  }

  switch (picker.action.kind) {
    case 'set-model':
      return step(closed, [{ type: 'setModel', modelId: item.id }]);

    case 'set-planner':
      // The daemon decides what the new backend's model should become — its
      // own remembered choice, that backend's catalog default, or nothing —
      // and the effect that runs this consumes whatever it returns.
      return step(closed, [{ type: 'setPlanner', provider: item.id }]);
    case 'set-planner-effort':
      return step(closed, [{ type: 'setPlannerEffort', effort: item.id === DEFAULT_EFFORT ? '' : item.id }]);

    case 'load-session':
      return step(closed, [{ type: 'loadSession', sessionId: item.id }]);
    case 'rewind':
      return pickRewindTarget(state, Number(item.id));
    case 'delete-session':
      return step(closed, [{ type: 'deleteSession', sessionId: item.id }]);
    case 'set-key':
      return step({ ...state, overlay: keyPrompt(item.id as AiProvider) });
    case 'choose-allowlist-runner': {
      const action = { kind: 'set-allowlist' as const, runner: item.id };
      const items = pickerItemsFor(state, action);
      // An empty catalog is not an empty allowlist. Confirming a picker with no
      // rows would store `[]` — "no restriction" — so refuse to open it rather
      // than let a cold discovery quietly lift the user's limit.
      if (items.length === 0) {
        return step(say(state, 'error', `No models discovered for ${item.label}. Run /refresh, then try again.`));
      }
      return step({
        ...state,
        overlay: {
          kind: 'picker',
          picker: {
            title: `Models allowed for ${item.label}`,
            hint: 'An empty selection lifts the restriction.',
            items,
            filter: '',
            index: 0,
            multi: true,
            // Ids this runner doesn't serve can be sitting in a settings file
            // written before the list was scoped; dropping them here means
            // confirming the picker also repairs the stored allowlist.
            chosen: (state.allowlist[item.id] ?? []).filter((id) => items.some((i) => i.id === id)),
            action,
          },
        },
      });
    }
    case 'set-task-runner': {
      const taskId = picker.action.taskId;
      const task = findTask(state.tasks, taskId);
      if (!task || !state.sessionId) return step(closed);
      return assignTaskRunner(closed, state.sessionId, task, item.id, item.label);
    }
    case 'set-task-mode': {
      const taskId = picker.action.taskId;
      const task = findTask(state.tasks, taskId);
      if (!task || !state.sessionId) return step(closed);
      return assignTaskMode(closed, state.sessionId, task, item.id, item.label);
    }
    case 'set-task-model': {
      const taskId = picker.action.taskId;
      const task = findTask(state.tasks, taskId);
      const model = state.models.find((candidate) => candidate.id === item.id);
      if (!task || !model || !state.sessionId) return step(closed);
      return assignTaskModel(closed, state.sessionId, task, model);
    }
    case 'set-task-effort': {
      const taskId = picker.action.taskId;
      const task = findTask(state.tasks, taskId);
      if (!task || !state.sessionId) return step(closed);
      return assignTaskEffort(closed, state.sessionId, task, item.id === DEFAULT_EFFORT ? undefined : item.id);
    }
  }
}

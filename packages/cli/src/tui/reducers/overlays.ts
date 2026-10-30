import { isApiProvider, overrideNeedsConfirmation } from '@ordewell/core';
import { bodyRows, helpScrollMax } from '../layout';
import { findTask, refFor, visibleItems, type PickerItem, type PickerState, type TuiState } from '../state';
import type { Key } from '../keys';
import { handleApprovalKey, scrollApproval } from './approvals';
import { keyPrompt, newSession, pickRewindTarget, withIdlePlanner } from './commands';
import { chooseBlocked, confirmedHandoff, handleHandoffKey, type BlockedChoice } from '../handoff';
import { DEFAULT_EFFORT, pickerItemsFor } from './pickers';
import { WHEEL_NOTCH, isWheel, pageNotch, scrollPointed } from './pointer';
import { taskActionEffect } from './planPane';
import { assignTaskEffort, assignTaskSkills, assignTaskMode, assignTaskModel, assignTaskRunner } from './taskEdits';
import { say } from '../transcript';
import { clamp, digitRow, editText, fail, step, type Step } from './shared';
import { answerSaveSettings } from './settings';
import { chooseAnswer, chooseEscalation, confirmedAnswer, noteEntered } from './inbox';
import { handleStepperKey } from './stepper';

export function handleOverlayKey(state: TuiState, overlay: NonNullable<TuiState['overlay']>, key: Key): Step {
  if (overlay.kind === 'help') return handleHelpKey(state, overlay, key);
  if (overlay.kind === 'approval') {
    const scrolled = scrollApproval(state, overlay, key);
    if (scrolled) return scrolled;
  }
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
  if (isWheel(key) && overlay.kind !== 'picker' && overlay.kind !== 'stepper') return scrollPointed(state, key);
  if (overlay.kind === 'approval') return handleApprovalKey(state, overlay, key);
  if (overlay.kind === 'confirm') return handleConfirmKey(state, overlay, key);
  if (overlay.kind === 'stepper') return handleStepperKey(state, overlay.stepper, key);
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
  if (key.name === 'escape') {
    return overlay.action.kind === 'save-settings' ? answerSaveSettings(state, overlay.action, false) : step({ ...state, overlay: null });
  }
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
  if (overlay.action.kind === 'mark-override') {
    const { taskId, direction, seen } = overlay.action;
    const task = state.sessionId ? findTask(state.tasks, taskId) : undefined;
    // The popup was open for a while: a task that left the plan is not marked by its id.
    if (!state.sessionId || !task) return fail(closed, 'That task is no longer in the plan: nothing was changed.');
    return step(closed, [taskActionEffect(closed, state.sessionId, taskId, direction, overrideNeedsConfirmation(task) ? { seen } : undefined)]);
  }
  if (overlay.action.kind === 'revert-task') {
    if (!state.sessionId) return step(closed);
    return step(closed, [{ type: 'revertTask', sessionId: state.sessionId, taskId: overlay.action.taskId, seen: overlay.action.seen }]);
  }
  if (overlay.action.kind === 'save-settings') return answerSaveSettings(state, overlay.action, true);
  if (overlay.action.kind === 'answer-escalation') return confirmedAnswer(state, overlay.action.escalationId, overlay.action.option, overlay.action.note);
  if (overlay.action.kind === 'merge-run' || overlay.action.kind === 'discard-run') {
    return confirmedHandoff(state, overlay.action.kind);
  }
  if (overlay.action.kind === 'init-workspace') {
    return step({ ...closed, planner: 'planning' }, [{ type: 'startConversation', goal: overlay.action.goal, allowInit: true }]);
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
function handleHelpKey(state: TuiState, overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'help' }>, key: Key): Step {
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
  return step({ ...state, overlay: { ...overlay, scroll: clamp((overlay.scroll ?? 0) + delta, helpScrollMax(state)) } });
}

function handlePromptKey(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'prompt' }>,
  key: Key,
): Step {
  if (key.name === 'enter') {
    const value = overlay.value.trim();
    const closed = { ...state, overlay: null };
    // An optional note may be empty, which is an answer, not a cancel.
    if (overlay.action.kind === 'escalation-note') return noteEntered(state, overlay.action, value);
    if (!value) return step(closed);

    if (overlay.action.kind === 'api-key') {
      return step(closed, [{ type: 'setApiKey', provider: overlay.action.provider, key: value }]);
    }
    if (!state.sessionId) return fail(closed, 'No active plan to add a task to: describe a goal first, then /add-task <title>.');
    return step(closed, [{ type: 'addTask', sessionId: state.sessionId, title: value }]);
  }

  const value = editText(overlay.value, key);
  return step({ ...state, overlay: { ...overlay, value } });
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

  if (!picker.filterable) {
    const row = digitRow(key);
    if (row === null || !items[row]) return reopen(picker);
    if (!picker.multi) return choose(state, { ...picker, index: row }, items[row]);
    const id = items[row].id;
    const chosen = picker.chosen.includes(id) ? picker.chosen.filter((c) => c !== id) : [...picker.chosen, id];
    return reopen({ ...picker, index: row, chosen });
  }

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
        : 'No runners enabled: the planner has nothing to assign work to.',
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
        ? `Task ${refFor(state, task)} now depends on ${picker.chosen.length} task${picker.chosen.length === 1 ? '' : 's'}.`
        : `Task ${refFor(state, task)} no longer depends on anything.`,
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
    return step(say(state, 'error', item.detail ? `${item.label}: ${item.detail}` : `${item.label} is not available.`));
  }

  switch (picker.action.kind) {
    case 'load-session':
      return step(closed, [{ type: 'loadSession', sessionId: item.id }]);
    case 'inbox':
      return chooseEscalation(state, item.id);
    case 'inbox-answer':
      return chooseAnswer(state, picker.action.escalationId, item.id);
    case 'rewind':
      return pickRewindTarget(state, Number(item.id));
    case 'delete-session':
      return step(closed, [{ type: 'deleteSession', sessionId: item.id }]);
    case 'set-key':
      return isApiProvider(item.id) ? step({ ...state, overlay: keyPrompt(item.id) }) : step(closed);
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
            filterable: true,
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

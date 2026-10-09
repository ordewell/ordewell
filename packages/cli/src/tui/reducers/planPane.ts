import { markAction, taskRef } from '@ordewell/core';
import { applyKey, emptyEditor, type EditorState } from '../editor';
import { taskEditorRoom } from '../geometry';
import { findTask, planRows, selectedPlanRow, type TaskView, type TuiState } from '../state';
import type { Key } from '../keys';
import { scrollDelta, scrollPlan, settlePlan } from './pointer';
import { openTaskTerminalOrView } from './taskView';
import {
  addTask, confirmForceStartPastGate, confirmRemoveTask, openTaskDepsPicker, openTaskEffortPicker, openTaskModePicker, openTaskModelPicker,
  openTaskRunnerPicker, openTaskSkillsPicker, toggleTaskOps,
} from './taskEdits';
import { clampSelection, step, type Effect, type Step, type TaskAction } from './shared';

const PLAN_SHORTCUTS: Record<string, TaskAction> = {
  c: 'cancel',
  f: 'force-start',
  s: 'skip',
};

/** Task actions that spawn a runner, so the pane only learns their fate from the execution stream. */
const SPAWNS_RUNNER: TaskAction[] = ['force-start', 'retry'];

/**
 * A spawn's progress reaches the TUI over the session's execution stream, and
 * nothing else opens one: without it a force-started task sat frozen on its
 * first spinner frame and never settled. A plan run already holds that stream,
 * so a second subscription would report the run finishing twice.
 */
export function taskActionEffect(state: TuiState, sessionId: string, taskId: string, action: TaskAction): Effect {
  const watch = SPAWNS_RUNNER.includes(action) && state.status !== 'executing';
  return watch
    ? { type: 'taskAction', sessionId, taskId, action, watch: true }
    : { type: 'taskAction', sessionId, taskId, action };
}

export function handlePlanKey(state: TuiState, key: Key): Step {
  // While a task's prompt editor is open, every key edits its draft instead of
  // moving the list cursor — otherwise up/down would collapse it out from
  // under the caret. `findTask` walks subtasks too: the editor opens on a
  // subtask as often as a top-level task.
  const editingTask = state.expandedTaskId ? findTask(state.tasks, state.expandedTaskId) : undefined;
  if (editingTask && state.taskEditor) return handleTaskEditKey(state, editingTask, state.taskEditor, key);

  // Expanded without an open editor: the cursor is browsing a parent's
  // revealed subtask rows. Escape backs out of that one step at a time,
  // rather than leaving the plan pane entirely.
  if (key.name === 'escape') {
    if (state.expandedTaskId) return step(settlePlan({ ...state, expandedTaskId: null }));
    return step({ ...state, focus: 'chat' });
  }
  // The cursor walks the visible rows, subtasks included, and an expanded
  // parent stays open so its rows do not vanish under the step. The viewport
  // only follows once the cursor would leave it.
  if (key.name === 'up') {
    return step(settlePlan({ ...state, selectedTask: Math.max(0, state.selectedTask - 1) }));
  }
  if (key.name === 'down') {
    return step(settlePlan({ ...state, selectedTask: clampSelection(state.selectedTask + 1, planRows(state).length) }));
  }

  // pageup/pagedown only — a wheel notch is routed by the pointer well above
  // this, and never reaches the focused pane's handler.
  const scroll = scrollDelta(key, state);
  if (scroll !== null) return scrollPlan(state, scroll, true);

  // Before the row guard: with no tasks there is no row, and this is the way in.
  if (key.name === 'char' && key.char === 'a') return addTask(state, '');

  const row = selectedPlanRow(state);
  if (!row) return step(state);
  const task = row.task;
  if (key.name === 'enter' || key.name === 'right') {
    // A parent's first enter only reveals its subtask rows — jumping straight
    // to the editor would trap the cursor before it ever reaches them. Enter
    // again on the still-selected parent, or on any row without subtasks,
    // opens the editor as before.
    const hasSubtasks = (task.subtasks?.length ?? 0) > 0;
    if (hasSubtasks && state.expandedTaskId !== task.id) {
      return step(settlePlan({ ...state, expandedTaskId: task.id, taskEditor: null }));
    }
    const text = task.prompt ?? task.description ?? task.title;
    return step(settlePlan({
      ...state,
      expandedTaskId: task.id,
      taskEditor: { ...emptyEditor(), text, cursor: text.length },
    }));
  }
  if (!state.sessionId || key.name !== 'char') return step(state);

  // `E` is the plan pane's equivalent of /run: it starts the whole plan, not
  // the selected task, hence the uppercase.
  if (key.char === 'E') return step(state, [{ type: 'execute', sessionId: state.sessionId }]);

  // The run's explicit stop, matching /stop and the uppercase of `E`.
  if (key.char === 'S') return step(state, [{ type: 'stopExecution', sessionId: state.sessionId }]);

  const action = key.char === 'm' ? markAction(task) : PLAN_SHORTCUTS[key.char ?? ''];
  if (action === 'force-start' && task.mergeGate?.length) return confirmForceStartPastGate(state, task);
  if (action) {
    return step(state, [taskActionEffect(state, state.sessionId, task.id, action)]);
  }
  if (key.char === 'O') return toggleTaskOps(state, task, row.parent !== null);
  if (key.char === 'd') return confirmRemoveTask(state, task);
  if (key.char === 't') return openTaskTerminalOrView(state, state.sessionId, task.id);
  // Adds a task, so it is asked for by name — and only where a conflict exists.
  if (key.char === 'x' && task.isolation?.state === 'conflict') {
    return step(state, [{ type: 'resolveConflict', sessionId: state.sessionId, taskId: task.id }]);
  }
  if (key.char === 'R') return openTaskRunnerPicker(state, task);
  if (key.char === 'o') return openTaskModelPicker(state, task);
  if (key.char === 'e') return openTaskEffortPicker(state, task);
  if (key.char === 'M') return openTaskModePicker(state, task);
  if (key.char === 'D') return openTaskDepsPicker(state, task);
  if (key.char === 'K') return openTaskSkillsPicker(state, task);
  return step(state);
}

/** Enter commits the prompt edit and collapses; escape discards it and collapses. */
function handleTaskEditKey(state: TuiState, task: TaskView, editor: EditorState, key: Key): Step {
  if (key.name === 'enter') return commitTaskEdit(state, task, editor);
  if (key.name === 'escape') return step(settlePlan({ ...state, expandedTaskId: null, taskEditor: null }));
  // The page keys still scroll the pane rather than move through the text,
  // same as when nothing is expanded.
  const scroll = scrollDelta(key, state);
  if (scroll !== null) return scrollPlan(state, scroll, true);
  return step(settlePlan({ ...state, taskEditor: applyKey(editor, key, taskEditorRoom(state)) }));
}

function commitTaskEdit(state: TuiState, task: TaskView, editor: EditorState): Step {
  const collapsed = settlePlan({ ...state, expandedTaskId: null, taskEditor: null });
  const prompt = editor.text.trim();
  const original = task.prompt ?? task.description ?? task.title;
  if (!prompt || prompt === original || !state.sessionId) return step(collapsed);
  return step(collapsed, [{
    type: 'updateTask',
    sessionId: state.sessionId,
    taskId: task.id,
    changes: { prompt },
    message: `Task ${taskRef(task)} prompt updated.`,
  }]);
}

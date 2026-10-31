import { manualOverrideConfirmation, manualOverrideStopFirst, markAction, overrideNeedsConfirmation, resumeLabel, taskRowActions, type OverrideDirection, type TaskStatus } from '@ordewell/core';
import { applyKey, emptyEditor, type EditorState } from '../editor';
import { taskEditorRoom } from '../geometry';
import { findTask, planRows, refFor, selectedPlanRow, titledRefFor, type TaskView, type TuiState } from '../state';
import type { Key } from '../keys';
import { scrollDelta, scrollPlan, settlePlan } from './pointer';
import { openTaskView } from './taskView';
import {
  addTask, confirmForceStartPastGate, confirmRemoveTask, openTaskDepsPicker, openTaskEffortPicker, openTaskModePicker, openTaskModelPicker,
  openTaskRunnerPicker, openTaskSkillsPicker, toggleTaskOps,
} from './taskEdits';
import { clampSelection, fail, step, type Effect, type Step, type TaskAction } from './shared';

const PLAN_SHORTCUTS: Record<string, TaskAction> = {
  c: 'cancel',
  f: 'force-start',
  s: 'skip',
};

/** Task actions that spawn a runner, so the pane only learns their fate from the execution stream. */
const SPAWNS_RUNNER: TaskAction[] = ['force-start', 'retry', 'resume-now'];

/**
 * A spawn's progress reaches the TUI over the session's execution stream, and
 * nothing else opens one: without it a force-started task sat frozen on its
 * first spinner frame and never settled. A plan run already holds that stream,
 * so a second subscription would report the run finishing twice.
 */
export function taskActionEffect(state: TuiState, sessionId: string, taskId: string, action: TaskAction, confirmed?: { seen: TaskStatus }): Effect {
  const watch = SPAWNS_RUNNER.includes(action) && state.status !== 'executing';
  return {
    type: 'taskAction', sessionId, taskId, action,
    ...(watch ? { watch: true } : {}),
    ...(confirmed ? { confirmed } : {}),
  };
}

/**
 * Mark complete or Mark not done on `task`, asked first (ADR-0029). An AI or
 * script task's override is explained in the core's words and the daemon gets
 * the user's yes on the command; it is not asked at all while the run could
 * still advance the task — starting, running, scheduled, a queued force start
 * or a usage-limit hold — since the daemon would refuse it. A manual
 * task's is the user's own sign-off: asked on a shortcut, which is one
 * accidental key away, and sent as typed from a slash command. The status the
 * user was asked about travels with the yes, so a task that moved on while the
 * popup was open is refused rather than overridden.
 */
export function confirmMark(state: TuiState, task: TaskView, direction: OverrideDirection, shortcut: boolean): Step {
  const needsYes = overrideNeedsConfirmation(task);
  if (!state.sessionId) return fail(state, 'No active plan.');
  if (!needsYes && !shortcut) return step(state, [taskActionEffect(state, state.sessionId, task.id, direction)]);
  const activity = state.run.activity;
  if (needsYes && activity?.advancesOnItsOwn) {
    return fail(state, manualOverrideStopFirst(direction, `task ${titledRefFor(state, task)}`));
  }
  const label = `task ${titledRefFor(state, task)}`;
  const message = needsYes
    ? manualOverrideConfirmation(direction, label)
    : direction === 'complete'
      ? `Mark ${label} done? It is your own sign-off: what depends on it can start.`
      : `Mark ${label} not done? Your sign-off is taken back and it waits until you retry or start it.`;
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: direction === 'complete' ? `Mark ${titledRefFor(state, task)} complete?` : `Mark ${titledRefFor(state, task)} not done?`,
      message,
      action: { kind: 'mark-override', taskId: task.id, direction, seen: task.status as TaskStatus },
    },
  });
}

/**
 * The whole-plan start, shown as starting at once: the daemon opens the run
 * asynchronously, and until its first task claims there is nothing yet to call
 * executing. A second press while that is under way is the same start.
 */
export function startPlan(state: TuiState, sessionId: string): Step {
  if (state.status === 'starting') return step(state);
  // A run already under way takes Execute as its join: nothing is starting, so
  // the indicator stays executing and the call goes through as before.
  if (state.status === 'executing') return step(state, [{ type: 'execute', sessionId }]);
  return step({ ...state, status: 'starting' }, [{ type: 'execute', sessionId }]);
}

export function handlePlanKey(state: TuiState, key: Key): Step {
  // While a task's prompt editor is open, every key edits its draft instead of
  // moving the list cursor — otherwise up/down would collapse it out from
  // under the caret. `findTask` walks subtasks too: the editor opens on a
  // subtask as often as a top-level task.
  const editingTask = state.expandedTaskId ? findTask(state.tasks, state.expandedTaskId) : undefined;
  if (editingTask && state.taskEditor) return handleTaskEditKey(state, editingTask, state.taskEditor, key);

  // The focused side backs out first: Escape collapses what the plan pane has
  // open — a parent's revealed subtask rows here, the prompt editor above —
  // before it means anything to the task chat or hands focus to it.
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
  const scroll = scrollDelta(key, state, 'plan');
  if (scroll !== null) return scrollPlan(state, scroll, true);

  // Before the row guard: with no tasks there is no row, and this is the way in.
  if (key.name === 'char' && key.char === 'a') return addTask(state, '');
  // The footer names only the keys that fit the selected task; this lists them all.
  if (key.name === 'char' && key.char === '?') return step({ ...state, overlay: { kind: 'help', scroll: 0, sheet: 'keys' } });

  const row = selectedPlanRow(state);
  if (!row) return step(state);
  const task = row.task;
  if (key.name === 'enter' && state.sessionId) return openTaskView(state, state.sessionId, task.id);
  if (key.name === 'right') {
    // A parent's first right arrow only reveals its subtask rows — jumping straight
    // to the editor would trap the cursor before it ever reaches them. Right
    // again on the still-selected parent, or on any row without subtasks,
    // opens the editor as before.
    const hasSubtasks = (task.subtasks?.length ?? 0) > 0;
    if (hasSubtasks && state.expandedTaskId !== task.id) {
      return step(settlePlan({ ...state, expandedTaskId: task.id, taskEditor: null }));
    }
    // A script's body is the planner's to write: the row opens to show it, and nothing in it edits.
    if (task.type === 'script') return step(settlePlan({ ...state, expandedTaskId: task.id, taskEditor: null }));
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
  if (key.char === 'E') return startPlan(state, state.sessionId);

  // The run's explicit stop, matching /stop and the uppercase of `E`.
  if (key.char === 'S') return step(state, [{ type: 'stopExecution', sessionId: state.sessionId }]);

  // A task paused on a usage limit has no runner to cancel; `c` cancels its resume instead.
  const shortcut = key.char === 'c' && resumeLabel(task) ? 'cancel-resume' : PLAN_SHORTCUTS[key.char ?? ''];
  if (key.char === 'r') {
    return taskRowActions(task).includes('resume-now') ? step(state, [taskActionEffect(state, state.sessionId, task.id, 'resume-now')]) : step(state);
  }
  // A mark is never one keystroke: it asks first, whatever the task (ADR-0029).
  if (key.char === 'm') return confirmMark(state, task, markAction(task), true);
  const action = shortcut;
  if (action === 'force-start' && task.mergeGate?.length) return confirmForceStartPastGate(state, task);
  if (action) {
    return step(state, [taskActionEffect(state, state.sessionId, task.id, action)]);
  }
  if (key.char === 'O') return toggleTaskOps(state, task, row.parent !== null);
  if (key.char === 'd') return confirmRemoveTask(state, task);
  // Adds a task, so it is asked for by name — and only where a conflict exists.
  if (key.char === 'x' && task.isolation?.state === 'conflict') {
    return step(state, [{ type: 'resolveConflict', sessionId: state.sessionId, taskId: task.id, ...(state.status === 'executing' ? {} : { watch: true as const }) }]);
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
  const scroll = scrollDelta(key, state, 'plan');
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
    message: `Task ${refFor(state, task)} prompt updated.`,
  }]);
}

/**
 * Act is the one level that acts on the user's behalf, ops tasks included,
 * so choosing it says what it allows (ADR-0029).
 */

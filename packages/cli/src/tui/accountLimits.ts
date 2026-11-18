import { lastServedModel } from '@ordewell/core';
import type { Action } from './reducer';
import { findTask, type TaskView, type TuiState } from './state';

function assignmentKey(task: TaskView): string {
  return `${task.assignedRunner}\0${task.assignedModel?.modelId ?? ''}`;
}

/** The live account follows the latest attempt, even while its reader browses an older log (ADR-0051 G7). */
export function observeTaskServedModel(state: TuiState, action: Extract<Action, { type: 'taskLog' | 'taskLogLoaded' }>): TuiState {
  const task = findTask(state.tasks, action.taskId);
  if (!task) return state;
  const before = state.servedModels[task.id];
  const latest = Math.max(before?.attempt ?? 0, task.attemptUsage?.at(-1)?.attempt ?? 0,
    state.taskView?.taskId === task.id ? state.taskView.attempts.at(-1) ?? 0 : 0);
  if (action.attempt < latest) return state;
  const model = lastServedModel(action.events);
  if (!model && action.attempt === before?.attempt) return state;
  const served = { attempt: action.attempt, ...(model ? { model, assignment: assignmentKey(task) } : {}) };
  // Every usage record names its model: a batch that names the one already known changes nothing on screen.
  if (before && before.attempt === served.attempt && before.model === served.model && before.assignment === served.assignment) return state;
  return { ...state, servedModels: { ...state.servedModels, [task.id]: served } };
}

export function taskServedModel(state: TuiState, task: TaskView): string | undefined {
  const served = state.servedModels[task.id];
  return served?.model && served.assignment === assignmentKey(task) && served.attempt >= (task.attemptUsage?.at(-1)?.attempt ?? 0)
    ? served.model : task.assignedModel?.modelId;
}

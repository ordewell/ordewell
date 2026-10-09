import { dependentsNotice, dependentsOf, pastGateConfirmation, taskRef, titledRefs, titledTaskRef } from '@ordewell/core/plan-utils';
import { findTask, type ModelView, type TaskView, type TuiState } from '../state';
import { assignedModelFor, effortsForTask, modesForTask, runnerAccepts } from '../taskAssignment';
import { picker, pickerItemsFor } from './pickers';
import { fail, step, withSession, type Step } from './shared';

export function openTaskRunnerPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not run on an executor, so they have no runner.');
  const action = { kind: 'set-task-runner' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Runner · ${titledTaskRef(task)}`, pickerItemsFor(state, action), action, {
          hint: 'Changing the runner re-picks this task model, effort and mode for it.',
        }),
      },
    },
  );
}

export function confirmRemoveTask(state: TuiState, task: TaskView): Step {
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: `Remove ${titledTaskRef(task)}?`,
      message: dependentsNotice(dependentsOf(state.tasks, task.id)) ?? 'This cannot be undone.',
      action: { kind: 'remove-task', taskId: task.id },
    },
  });
}

/**
 * Change versus ops (ADR-0020): `O` flips it, and the daemon refuses once the
 * task has started. Said up front where the answer is already known.
 */
export function toggleTaskOps(state: TuiState, task: TaskView, subtask: boolean, to: boolean = !task.ops): Step {
  if (!state.sessionId) return fail(state, 'No active plan.');
  if (task.type !== 'ai') return fail(state, 'Only an AI task can be an ops task — a manual task already runs outside any worktree.');
  if (subtask) return fail(state, 'A subtask runs with its parent; make the parent an ops task instead.');
  if (!!task.ops === to) return fail(state, `${taskRef(task)} is already ${to ? 'an ops' : 'a change'} task.`);
  return step(state, [{
    type: 'updateTask',
    sessionId: state.sessionId,
    taskId: task.id,
    changes: { ops: to },
    message: to
      ? `Task ${taskRef(task)} is an ops task: it runs in your checkout once the work it depends on is merged.`
      : `Task ${taskRef(task)} is a change task: it runs in its own worktree.`,
  }]);
}

/**
 * A force start passes a merge gate (ADR-0020), but only once the user has
 * seen which work it acts without.
 */
export function confirmForceStartPastGate(state: TuiState, task: TaskView): Step {
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: `Force start ${titledTaskRef(task)}?`,
      message: pastGateConfirmation(titledRefs(task.mergeGate ?? [], state.tasks), 'It'),
      action: { kind: 'force-start-gated', taskId: task.id },
    },
  });
}

export function openTaskDepsPicker(state: TuiState, task: TaskView): Step {
  const action = { kind: 'set-task-deps' as const, taskId: task.id };
  const items = pickerItemsFor(state, action);
  if (items.length === 0) return fail(state, `Nothing runs before ${taskRef(task)}, so it has no possible dependencies.`);
  return step({
    ...state,
    overlay: {
      kind: 'picker',
      picker: picker(`Depends on · ${titledTaskRef(task)}`, items, action, {
        hint: 'Only tasks earlier in the plan can be dependencies.',
        multi: true,
        chosen: task.dependencies.filter((id) => items.some((i) => i.id === id)),
      }),
    },
  });
}

export function openTaskSkillsPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not run an executor, so they take no skills.');
  const action = { kind: 'set-task-skills' as const, taskId: task.id };
  const items = pickerItemsFor(state, action);
  if (items.length === 0) {
    return fail(state, 'No task skills found. A skill with applies-to: task in .ordewell/skills/ or ~/.ordewell/skills/ shows up here.');
  }
  return step({
    ...state,
    overlay: {
      kind: 'picker',
      picker: picker(`Skills · ${titledTaskRef(task)}`, items, action, {
        hint: "Attached skills go into this task's prompt when it starts.",
        multi: true,
        chosen: task.skills ?? [],
      }),
    },
  });
}

export function assignTaskSkills(state: TuiState, sessionId: string, task: TaskView, skills: string[]): Step {
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { skills },
    message: skills.length > 0
      ? `Task ${taskRef(task)} skills set to ${skills.join(', ')}.`
      : `Task ${taskRef(task)} has no skills attached.`,
  }]);
}

export function openTaskModePicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not have an executor mode.');
  const modes = modesForTask(state.modesByRunner, task);
  if (modes.length === 0) {
    return fail(state, `${task.assignedRunner ?? 'This runner'} declares no modes.`);
  }
  const action = { kind: 'set-task-mode' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Mode · ${taskRef(task)}`, pickerItemsFor(state, action), action, {
          hint: `Modes declared by ${task.assignedRunner}.`,
        }),
      },
    },
  );
}

export function openTaskModelPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not have an executor model.');
  const action = { kind: 'set-task-model' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Model · ${titledTaskRef(task)}`, pickerItemsFor(state, action), action, {
          hint: task.assignedRunner
            ? `Showing models discovered for ${task.assignedRunner}.`
            : 'Choose the model this task will run with.',
        }),
      },
    },
    [{ type: 'loadModels' }],
  );
}

export function openTaskEffortPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not have a thinking effort.');
  if (!task.assignedModel) return fail(state, 'Choose a model for this task before setting its thinking effort.');
  const action = { kind: 'set-task-effort' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Thinking effort · ${taskRef(task)}`, pickerItemsFor(state, action), action, {
          hint: `${task.assignedModel.modelLabel} · choose runner default or a supported effort`,
        }),
      },
    },
    [{ type: 'loadModels' }],
  );
}

export function assignTaskModel(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  model: ModelView,
): Step {
  const assignedModel = assignedModelFor(model, task.assignedModel?.thinkingEffort);
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    // JSON drops `undefined`; null is intentional here so changing models can
    // also clear a stale legacy top-level effort on the persisted task.
    changes: { assignedModel, thinkingEffort: assignedModel.thinkingEffort ?? null },
    message: `Task ${taskRef(task)} model set to ${model.label}.`,
  }]);
}

/**
 * Sends only the runner. The daemon owns the retarget (Session.setTaskRunner):
 * it re-derives model, effort and mode from the new runner's catalog, and the
 * refreshed plan comes back through the usual plan refresh. Picking a model
 * here would race that and could name one the runner cannot spawn.
 */
export function assignTaskRunner(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  runner: string,
  runnerLabel: string,
): Step {
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { assignedRunner: runner },
    message: `Task ${taskRef(task)} runner set to ${runnerLabel}.`,
  }]);
}

export function assignTaskMode(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  mode: string,
  modeLabel: string,
): Step {
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { taskMode: mode },
    message: `Task ${taskRef(task)} mode set to ${modeLabel}.`,
  }]);
}

export function assignTaskEffort(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  thinkingEffort: string | undefined,
): Step {
  const assignedModel = task.assignedModel
    ? { ...task.assignedModel, thinkingEffort }
    : undefined;
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { assignedModel, thinkingEffort: thinkingEffort ?? null },
    message: `Task ${taskRef(task)} thinking effort set to ${thinkingEffort ?? 'runner default'}.`,
  }]);
}

export function taskModelCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskModelPicker(state, task);
    const model = state.models.find((candidate) => candidate.id === args[1]) ?? {
      id: args[1],
      label: args[1],
      provider: '',
      variants: [],
    };
    if (!runnerAccepts(task, model)) {
      return fail(state, `${model.label} was not discovered for ${task.assignedRunner}.`);
    }
    return assignTaskModel(state, sessionId, task, model);
  });
}

export function taskRunnerCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskRunnerPicker(state, task);
    const runner = state.runners.find((candidate) => candidate.id === args[1]);
    if (!runner) return fail(state, `Unknown runner "${args[1]}".`);
    return assignTaskRunner(state, sessionId, task, runner.id, runner.name);
  });
}

export function taskModeCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskModePicker(state, task);
    const mode = modesForTask(state.modesByRunner, task).find((candidate) => candidate.id === args[1]);
    if (!mode) return fail(state, `Unsupported mode "${args[1]}" for ${task.assignedRunner}.`);
    return assignTaskMode(state, sessionId, task, mode.id, mode.label);
  });
}

export function taskEffortCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskEffortPicker(state, task);
    if (!task.assignedModel) return fail(state, 'Choose a model for this task before setting its thinking effort.');
    const effort = args[1].toLowerCase();
    const value = effort === 'default' || effort === 'none' ? undefined : args[1];
    const supported = effortsForTask(state.models, task);
    if (value && supported.length > 0 && !supported.some((variant) => variant.id === value)) {
      return fail(state, `Unsupported effort "${value}" for ${task.assignedModel.modelLabel}.`);
    }
    return assignTaskEffort(state, sessionId, task, value);
  });
}

export function taskSkillsCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (args.length < 2) return openTaskSkillsPicker(state, task);
    if (task.type !== 'ai') return fail(state, 'Manual tasks do not run an executor, so they take no skills.');
    const value = args.slice(1).join(' ');
    const names = value.toLowerCase() === 'none' ? [] : [...new Set(value.toLowerCase().split(/[,\s]+/).filter(Boolean))];
    const unknown = names.filter((name) => !state.taskSkills.some((s) => s.name === name));
    if (unknown.length > 0) {
      return fail(state, `No task skill named ${unknown.map((n) => `"${n}"`).join(', ')}. Task skills: ${state.taskSkills.map((s) => s.name).join(', ') || 'none'}.`);
    }
    return assignTaskSkills(state, sessionId, task, names);
  });
}

export function taskOpsCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (_sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    const subtask = !state.tasks.some((t) => t.id === taskId);
    const value = args[1]?.toLowerCase();
    if (value !== undefined && value !== 'on' && value !== 'off') return fail(state, 'Usage: /task-ops <id> [on|off]');
    return toggleTaskOps(state, task, subtask, value === undefined ? !task.ops : value === 'on');
  });
}

export function addTask(state: TuiState, title: string): Step {
  if (!state.sessionId) {
    return fail(state, 'No active plan to add a task to — describe a goal first, then /add-task <title>.');
  }
  if (!title) {
    return step({
      ...state,
      overlay: { kind: 'prompt', title: 'New task title', value: '', action: { kind: 'add-task' } },
    });
  }
  return step(state, [{ type: 'addTask', sessionId: state.sessionId, title }]);
}

export function taskCommand(
  state: TuiState,
  token: string | undefined,
  run: (sessionId: string, taskId: string) => Step,
): Step {
  return withSession(state, (sessionId) => {
    if (!token) return fail(state, 'Which task? Pass a task id or its number in the plan.');
    const taskId = resolveTaskId(state, token);
    if (!taskId) return fail(state, `No task matching "${token}" in the current plan.`);
    return run(sessionId, taskId);
  });
}

/** Users refer to tasks by the number shown in the plan pane as often as by id. */
export function resolveTaskId(state: TuiState, token: string): string | null {
  const byId = findTask(state.tasks, token);
  if (byId) return byId.id;

  const order = Number(token);
  if (Number.isInteger(order)) {
    const byOrder = state.tasks.find((t) => t.order === order);
    if (byOrder) return byOrder.id;
  }
  return null;
}

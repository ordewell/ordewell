import { codexSandboxNotice } from '@ordewell/core';
import { noExecutorRefusal, dependentsNotice, dependentsOf, loopLeaveNotice, loopRemovalRefusal, pastGateConfirmation, titledRefs, resolveUserTaskRef } from '@ordewell/core/plan-utils';
import { findTask, refFor, titledRefFor, type ModelView, type TaskView, type TuiState } from '../state';
import { assignedModelFor, effortsForTask, modesForTask, runnerAccepts } from '../taskAssignment';
import { picker, pickerItemsFor } from './pickers';
import { runnerPickRefusal } from '../runnerChoice';
import { fail, step, withSession, type Step } from './shared';

const noExecutor = (task: TaskView, manual: string, script: string): string => noExecutorRefusal(task.type, manual, script);

export function openTaskRunnerPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, noExecutor(task, 'they have no runner.', 'it has no runner.'));
  const action = { kind: 'set-task-runner' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Runner · ${titledRefFor(state, task)}`, pickerItemsFor(state, action), action, {
          hint: 'Changing the runner re-picks this task model, effort and mode for it.',
        }),
      },
    },
  );
}

export function confirmRemoveTask(state: TuiState, task: TaskView): Step {
  // Core refuses a loop's check; asking first would promise a removal it will not make (ADR-0045 L8).
  const refusal = loopRemovalRefusal(task);
  if (refusal) return fail(state, refusal);
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: `Remove ${titledRefFor(state, task)}?`,
      message: [dependentsNotice(dependentsOf(state.tasks, task.id), state.tasks), loopLeaveNotice(state.tasks, task.id)].filter(Boolean).join(' ') || 'This cannot be undone.',
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
  if (task.type === 'script') return fail(state, 'A script task is an ops task already: it runs in your checkout.');
  if (task.type !== 'ai') return fail(state, 'Only an AI task can be an ops task: a manual task already runs outside any worktree.');
  if (subtask) return fail(state, 'A subtask runs with its parent; make the parent an ops task instead.');
  if (!!task.ops === to) return fail(state, `${refFor(state, task)} is already ${to ? 'an ops' : 'a change'} task.`);
  return step(state, [{
    type: 'updateTask',
    sessionId: state.sessionId,
    taskId: task.id,
    changes: { ops: to },
    message: to
      ? `Task ${refFor(state, task)} is an ops task: it runs in your checkout once the work it depends on is merged.`
      : `Task ${refFor(state, task)} is a change task: it runs in its own worktree.`,
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
      title: `Force start ${titledRefFor(state, task)}?`,
      message: pastGateConfirmation(titledRefs(task.mergeGate ?? [], state.tasks), 'It'),
      action: { kind: 'force-start-gated', taskId: task.id },
    },
  });
}

export function openTaskDepsPicker(state: TuiState, task: TaskView): Step {
  const action = { kind: 'set-task-deps' as const, taskId: task.id };
  const items = pickerItemsFor(state, action);
  if (items.length === 0) return fail(state, `No earlier siblings to offer as dependencies for ${refFor(state, task)}.`);
  return step({
    ...state,
    overlay: {
      kind: 'picker',
      picker: picker(`Depends on · ${titledRefFor(state, task)}`, items, action, {
        hint: 'Offers earlier siblings; existing dependencies are kept.',
        multi: true,
        filterable: true,
        chosen: task.dependencies,
      }),
    },
  });
}

export function openTaskSkillsPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, noExecutor(task, 'they take no skills.', 'it takes no skills.'));
  const action = { kind: 'set-task-skills' as const, taskId: task.id };
  const items = pickerItemsFor(state, action);
  if (items.length === 0) {
    return fail(state, 'No task skills found. A skill with applies-to: task in .ordewell/skills/ or ~/.ordewell/skills/ shows up here.');
  }
  return step({
    ...state,
    overlay: {
      kind: 'picker',
      picker: picker(`Skills · ${titledRefFor(state, task)}`, items, action, {
        hint: "Attached skills go into this task's prompt when it starts.",
        multi: true,
        filterable: true,
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
      ? `Task ${refFor(state, task)} skills set to ${skills.join(', ')}.`
      : `Task ${refFor(state, task)} has no skills attached.`,
  }]);
}

export function openTaskModePicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, noExecutor(task, 'they have no executor mode.', 'it has no mode.'));
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
        picker: picker(`Mode · ${refFor(state, task)}`, pickerItemsFor(state, action), action, {
          hint: [`Modes declared by ${task.assignedRunner}.`, codexSandboxNotice(state.modesByRunner)?.line].filter(Boolean).join(' '),
        }),
      },
    },
  );
}

export function openTaskModelPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, noExecutor(task, 'they have no executor model.', 'it has no model.'));
  const action = { kind: 'set-task-model' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Model · ${titledRefFor(state, task)}`, pickerItemsFor(state, action), action, {
          hint: task.assignedRunner
            ? `Showing models discovered for ${task.assignedRunner}.`
            : 'Choose the model this task will run with.',
          filterable: true,
        }),
      },
    },
    [{ type: 'loadModels' }],
  );
}

export function openTaskEffortPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, noExecutor(task, 'they have no thinking effort.', 'it has no thinking effort.'));
  if (!task.assignedModel) return fail(state, 'Choose a model for this task before setting its thinking effort.');
  const action = { kind: 'set-task-effort' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Thinking effort · ${refFor(state, task)}`, pickerItemsFor(state, action), action, {
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
    changes: { assignedModel },
    message: `Task ${refFor(state, task)} model set to ${model.label}.`,
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
    message: `Task ${refFor(state, task)} runner set to ${runnerLabel}.`,
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
    message: `Task ${refFor(state, task)} mode set to ${modeLabel}.`,
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
    changes: { assignedModel },
    message: `Task ${refFor(state, task)} thinking effort set to ${thinkingEffort ?? 'runner default'}.`,
  }]);
}

export function taskModelCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    // The picker is where a task with no model is refused, so a named one never reaches an update.
    if (!args[1] || task.type !== 'ai') return openTaskModelPicker(state, task);
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
    if (!args[1] || task.type !== 'ai') return openTaskRunnerPicker(state, task);
    const runner = state.runners.find((candidate) => candidate.id === args[1]);
    if (!runner) return fail(state, `Unknown runner "${args[1]}".`);
    // Moving the task onto a blocked runner is a new pick (ADR-0052).
    const refusal = runner.id === task.assignedRunner ? null : runnerPickRefusal(runner);
    if (refusal) return fail(state, refusal);
    return assignTaskRunner(state, sessionId, task, runner.id, runner.name);
  });
}

export function taskModeCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1] || task.type !== 'ai') return openTaskModePicker(state, task);
    const mode = modesForTask(state.modesByRunner, task).find((candidate) => candidate.id === args[1]);
    if (!mode) return fail(state, `Unsupported mode "${args[1]}" for ${task.assignedRunner}.`);
    if (mode.unavailable) return fail(state, `Mode "${mode.id}" of ${task.assignedRunner} is unavailable on this host: ${mode.unavailable}`);
    return assignTaskMode(state, sessionId, task, mode.id, mode.label);
  });
}

export function taskEffortCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1] || task.type !== 'ai') return openTaskEffortPicker(state, task);
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
    if (task.type !== 'ai') return fail(state, noExecutor(task, 'they take no skills.', 'it takes no skills.'));
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
    return fail(state, 'No active plan to add a task to: describe a goal first, then /add-task <title>.');
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
  return resolveUserTaskRef(state.tasks, token)?.id ?? null;
}

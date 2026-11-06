import React from 'react';
import type { Task } from '@ordewell/core';
import { RunnerBadge, runnerName } from '../../design/runners';
import { effortLabel, modelLabel } from '../../design/assignment';

/** The runner by name, model and effort, as one line: a tooltip's words for the assignment. Empty for a task with no runner. */
export function assignmentLabel(task: Task): string {
  if (task.type !== 'ai') return '';
  const effort = task.assignedModel?.thinkingEffort;
  return [task.assignedRunner && runnerName(task.assignedRunner), modelLabel(task.assignedModel), effort && effortLabel(effort)].filter(Boolean).join(' · ');
}

/** The runner as its badge (its colour beside its name, never alone), then the model and effort. */
export default function TaskAssignment({ task }: { task: Task }) {
  if (task.type !== 'ai') return null;

  const runner = task.assignedRunner;
  const model = modelLabel(task.assignedModel);
  const effort = task.assignedModel?.thinkingEffort;

  return (
    <span className="task-assignment" title={assignmentLabel(task)}>
      {runner && <><RunnerBadge runner={runner} className="task-assignment-runner" /><span aria-hidden="true"> · </span></>}
      <span className="task-assignment-model">{model}</span>
      {effort && <><span aria-hidden="true"> · </span><span className="task-assignment-effort">{effortLabel(effort)}</span></>}
    </span>
  );
}

/** The expanded card's stand-in for the runner, model and mode pickers while a plan executes and they are hidden. */
export function TaskAssignmentReadout({ task }: { task: Task }) {
  if (task.type !== 'ai') return null;
  return (
    <div className="task-assignment-readonly">
      <span className="task-assignment-readonly-label">Assigned</span>
      <TaskAssignment task={task} />
    </div>
  );
}

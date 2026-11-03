import React from 'react';
import type { Task } from '@ordewell/core';

export default function TaskAssignment({ task }: { task: Task }) {
  if (task.type !== 'ai') return null;

  const runner = task.assignedRunner;
  const model = task.assignedModel?.modelLabel || task.assignedModel?.modelId || 'default model';
  const effort = task.assignedModel?.thinkingEffort;
  const label = [runner, model, effort].filter(Boolean).join(' · ');

  return (
    <span className="task-assignment" title={label}>
      {runner && <><span className="task-assignment-runner">{runner}</span><span aria-hidden="true"> · </span></>}
      <span className="task-assignment-model">{model}</span>
      {effort && <><span aria-hidden="true"> · </span><span className="task-assignment-effort">{effort}</span></>}
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

import type { TaskRowAction, TaskRowView } from '@ordewell/core';
import type { SystemCommand, WebviewToHost } from '@ordewell/ui/protocol';

/** One thing the task tab's header can ask, as the message the session host answers. */
export interface TaskTabAction {
  label: string;
  message: WebviewToHost;
}

const ROW_ACTIONS: Record<TaskRowAction, { label: string; command: SystemCommand }> = {
  cancel: { label: 'Stop', command: 'cancel' },
  'resume-now': { label: 'Resume now', command: 'resumeNow' },
  'cancel-resume': { label: 'Don’t resume', command: 'cancelResume' },
  skip: { label: 'Skip', command: 'skip' },
  'force-start': { label: 'Start now', command: 'forceStart' },
  complete: { label: 'Mark complete', command: 'markComplete' },
  uncomplete: { label: 'Mark not done', command: 'markIncomplete' },
};

/**
 * What the task tab's header offers (docs/desktop/design.md, W6), most
 * pressing first: the first is the header's button and the rest go under ⋯.
 * The same rules as the plan panel's card: core's row actions, a failed
 * task's fresh retry ahead of them (core refuses Run on a failed task), Run
 * only while nothing executes, and Remove only then too.
 */
export function taskTabActions(
  task: { id: string; type: string; status: string },
  row: Pick<TaskRowView, 'actions' | 'revertible' | 'status'>,
  executing: boolean,
): TaskTabAction[] {
  const system = (label: string, command: SystemCommand): TaskTabAction => ({ label, message: { type: 'sendSystemCommand', command, taskId: task.id } });
  const actions: TaskTabAction[] = [];
  if (task.status === 'failed' && task.type !== 'user') actions.push(system('Retry', 'retry'));
  const runnable = task.type === 'ai' && task.status !== 'failed' && !['running', 'quiet', 'done', 'skipped'].includes(row.status);
  const run = runnable && !executing;
  if (run) actions.push(system('Run', 'runTask'));
  for (const action of row.actions) {
    // With Run on offer a start past the gate is the same button: Run asks first when the task is gated.
    if (action === 'force-start' && run) continue;
    actions.push(system(ROW_ACTIONS[action].label, ROW_ACTIONS[action].command));
  }
  if (row.revertible) actions.push(system('Revert…', 'revertTask'));
  if (!executing) actions.push({ label: 'Remove…', message: { type: 'removeTask', taskId: task.id } });
  return actions;
}

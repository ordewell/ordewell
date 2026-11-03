import { serializeTask, type IsolationHandoff, type RunTask, type RunView, type TaskIsolation } from '@ordewell/core';
import { surfaceTask } from '../../../session/__tests__/fakeDaemon';

/** A task as the run reports it, with the isolation and status a test gives it. */
export function runTask(fields: Partial<RunTask> & { id: string; order: number; title: string }): RunTask {
  const { id, order, title } = fields;
  return { ...serializeTask(surfaceTask({ id, order, title })), subtasks: [], ...fields };
}

export function worktree(state: Exclude<TaskIsolation['state'], 'none'>, extra: Partial<Extract<TaskIsolation, { branch: string }>> = {}): TaskIsolation {
  return { state, branch: `ordewell/r1/${state}`, worktree: '/tmp/wt', repos: ['.'], ...extra };
}

export const HANDOFF: IsolationHandoff = {
  repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: '4f2a91c0ffee0000', baseBranch: 'main', landed: [] }],
  landed: [{ taskId: 't1', order: 1, title: 'Add the login button' }],
};

export function runView(tasks: RunTask[], handoff: IsolationHandoff | null = null): RunView {
  return { tasks, runMerge: null, handoff, mergeResult: null };
}

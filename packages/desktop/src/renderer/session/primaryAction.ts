import type { HostState } from '@ordewell/ui';

/** The session's run actions, each the chat's own message for it. */
export type RunAction = 'approve' | 'run' | 'stop' | 'merge';

export const RUN_ACTION_LABEL: Record<RunAction, string> = {
  approve: 'Approve plan',
  run: 'Run',
  stop: 'Stop',
  // The review comes first: the action opens the run's changes, whose Merge all asks the preflight (ADR-0062 G8).
  merge: 'Review & Merge all',
};

const SETTLED: ReadonlySet<string> = new Set(['completed', 'skipped']);

interface StatusTree { status: string; subtasks?: readonly StatusTree[] }

function unfinished(tasks: readonly StatusTree[]): boolean {
  return tasks.some((task) => !SETTLED.has(task.status) || unfinished(task.subtasks ?? []));
}

/**
 * Which run actions the session offers now. The plan dock's own rules
 * (PlanCardGroup): Stop is owed to anything that could still move a task on,
 * even with nothing executing, and a start is offered only when nothing could.
 */
export function runActions(state: HostState): ReadonlySet<RunAction> {
  const actions = new Set<RunAction>();
  const plan = state.plan;
  if (!plan || plan.tasks.length === 0) return actions;
  const advancing = state.isExecuting || state.activity.advancesOnItsOwn || state.run.activity?.advancesOnItsOwn === true;
  const idle = !advancing && !state.starting;
  if (idle && (plan.status === 'draft' || plan.status === 'rejected')) actions.add('approve');
  else if (idle && unfinished(state.run.tasks.length > 0 ? state.run.tasks : plan.tasks)) actions.add('run');
  if (advancing) actions.add('stop');
  if (state.run.handoff || (state.run.runMerge && state.run.runMerge.landed.length > 0)) actions.add('merge');
  return actions;
}

const PRIORITY: readonly RunAction[] = ['approve', 'run', 'stop', 'merge'];

/** The one the title bar shows: Approve plan, then Run, then Stop, then Merge all. */
export function primaryAction(actions: ReadonlySet<RunAction>): RunAction | undefined {
  return PRIORITY.find((action) => actions.has(action));
}

import type { HostState } from '@ordewell/ui';

/**
 * The session's run actions, each the chat's own message for it. A draft is
 * started with Run too: running a plan is what approves it (ADR-0035), and an
 * Approve beside Run read as two gates.
 */
export type RunAction = 'run' | 'stop' | 'merge';

export const RUN_ACTION_LABEL: Record<RunAction, string> = {
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
  const drafted = plan.status === 'draft' || plan.status === 'rejected';
  if (idle && (drafted || unfinished(state.run.tasks.length > 0 ? state.run.tasks : plan.tasks))) actions.add('run');
  if (advancing) actions.add('stop');
  if (state.run.handoff || (state.run.runMerge && state.run.runMerge.landed.length > 0)) actions.add('merge');
  return actions;
}

const PRIORITY: readonly RunAction[] = ['run', 'stop', 'merge'];

/** The one the title bar shows: Run, then Stop, then Merge all. */
export function primaryAction(actions: ReadonlySet<RunAction>): RunAction | undefined {
  return PRIORITY.find((action) => actions.has(action));
}

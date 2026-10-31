import { IDLE_ACTIVITY, serializeTask, type RunInput, type RunMergeView, type RunTask, type RunTaskStatus, type RunView, type SerializedTask, type SerializedTaskStatus, type SurfacePlan, type SurfacePlanState, type SurfaceTask } from './SessionMessage';
import type { IsolationHandoff } from '../interfaces/IWorktreeIsolation';
import { rejoinPlanTree } from '../models/Task';
import { walkPlan } from './PlanTree';

export const EMPTY_RUN: RunView = { tasks: [], runMerge: null, handoff: null, mergeResult: null, activity: IDLE_ACTIVITY, escalations: [] };

type PlanFields = Omit<RunTask, keyof RunTaskStatus>;

/**
 * The one decision of which task fields are status-only: what is named here
 * no plan carries, so only a status update changes it and a plan refresh
 * keeps it. Everything else is the plan's.
 */
function split({ verdict, idleSince, completionReceived, attaching, isolation, checkpoint, queued, continuable, awaitingApproval, mergeGate, forcedPastGate, waitsForApproval, holdReason, loopStranded, handoff, attempted, ...plan }: RunTask): { plan: PlanFields; status: RunTaskStatus } {
  return { plan, status: { verdict, idleSince, completionReceived, attaching, isolation, checkpoint, queued, continuable, awaitingApproval, mergeGate, forcedPastGate, waitsForApproval, holdReason, loopStranded, handoff, attempted } };
}

/**
 * The plan's tasks over what the view already holds: plan fields from the
 * plan, absent meaning none; status-only fields as the stream last said.
 */
function refresh(previous: readonly RunTask[], tasks: readonly SerializedTask[]): RunTask[] {
  const held = new Map([...walkPlan(previous)].map(({ task }) => [task.id, task]));
  const fold = ({ subtasks, ...task }: SerializedTask): RunTask => {
    const was = held.get(task.id);
    const { checkpoint, ...status } = was ? split(was).status : {};
    // The question is answered once the plan says the task no longer waits at it.
    const waits = task.status === 'awaiting_user' && task.awaitingReason === 'checkpoint';
    return { ...task, ...status, ...(waits && checkpoint ? { checkpoint } : {}), subtasks: subtasks.map(fold) };
  };
  return tasks.map(fold);
}

/** A plan carries the task's wait, usage and loop round too, but a status update is the newer word on them. */
function withStatus({ awaitingReason: _reason, resumeAt: _resumeAt, skipReason: _skipped, attemptUsage: _usage, loopRound: _round, ...plan }: PlanFields, { id: _id, ...status }: SerializedTaskStatus): Omit<RunTask, 'subtasks'> {
  return { ...plan, ...status };
}

/** A status update says everything about a task's status: what it leaves out, the task no longer has. */
function applyStatus(tasks: readonly RunTask[], updates: ReadonlyMap<string, SerializedTaskStatus>): RunTask[] {
  return tasks.map((task) => {
    const subtasks = applyStatus(task.subtasks, updates);
    const update = updates.get(task.id);
    return update ? { ...withStatus(split(task).plan, update), subtasks } : { ...task, subtasks };
  });
}

/** `tasks` itself when `change` leaves the task named alone, or no task has that id. */
function changeTask(tasks: RunTask[], taskId: string, change: (task: RunTask) => RunTask): RunTask[] {
  let changed = false;
  const next = tasks.map((task) => {
    const updated = task.id === taskId ? change(task) : task;
    const subtasks = changeTask(updated.subtasks, taskId, change);
    if (updated === task && subtasks === task.subtasks) return task;
    changed = true;
    return { ...updated, subtasks };
  });
  return changed ? next : tasks;
}

const PATCHABLE: ReadonlySet<string> = new Set<keyof PlanFields>([
  'order', 'title', 'type', 'status', 'description', 'dependencies', 'assignedRunner', 'assignedModel', 'taskMode', 'prompt',
  'userSteps', 'autonomy', 'sliceType', 'userStoriesCovered', 'awaitingReason', 'resumeAt', 'skipReason', 'ops', 'skills', 'addedBy', 'attemptUsage',
  'commands', 'script', 'timeoutMs', 'loop', 'loopRound', 'research',
]);

function patchTask(task: RunTask, changes: Record<string, unknown>): RunTask {
  const fields = Object.entries(changes).filter(([key]) => PATCHABLE.has(key));
  if (fields.length === 0) return task;
  // The patch is the `Partial<Task>` PlanEditor applied; past the filter, only plan fields remain.
  return { ...task, ...(Object.fromEntries(fields) as Partial<PlanFields>) };
}

function startTask(task: RunTask): RunTask {
  return task.status === 'in_progress' ? task : running(task);
}

function running({ awaitingReason: _reason, resumeAt: _resumeAt, skipReason: _skipped, checkpoint: _checkpoint, ...task }: RunTask): RunTask {
  return { ...task, status: 'in_progress' };
}

function withoutIsolation(tasks: readonly RunTask[]): RunTask[] {
  return tasks.map(({ isolation: _isolation, ...task }) => ({ ...task, subtasks: withoutIsolation(task.subtasks) }));
}

function handoffOf({ type: _type, ...handoff }: Extract<RunInput, { type: 'isolation_handoff' }>): IsolationHandoff {
  return handoff;
}

/**
 * A status update is the newer word on which landed work is still unmerged
 * (`runMerge`): git can find some of a handed-over run merged after all — a
 * reloaded session asks it — and a handoff offers only what is left, or goes
 * once nothing is. A handoff that landed nothing, offering only the clean-up
 * of what was kept, is not about merging and stays.
 */
function stillToMerge(handoff: IsolationHandoff | null, runMerge: RunMergeView | undefined): IsolationHandoff | null {
  if (!handoff?.landed.length) return handoff;
  if (!runMerge) return null;
  const same = runMerge.landed.length === handoff.landed.length && runMerge.landed.every((t, i) => t.taskId === handoff.landed[i].taskId);
  return same ? handoff : { ...handoff, repos: runMerge.repos, landed: runMerge.landed };
}

/**
 * A saved plan keeps finished tasks in its execution log and the rest pending;
 * rejoined, the log wins for a task in both, being what actually happened.
 */
function planTasks(plan: SurfacePlan | SurfacePlanState): SurfaceTask[] {
  if ('tasks' in plan) return plan.tasks;
  return rejoinPlanTree<SurfaceTask>(plan.pendingTasks, plan.phase === 'executing' ? plan.executionLog : []);
}

export function reduceRun(view: RunView, input: RunInput): RunView {
  switch (input.type) {
    case 'plan_generated':
      return { ...view, tasks: refresh(view.tasks, input.plan.tasks), runSettings: input.plan.runSettings };
    case 'plan_snapshot':
      return {
        ...view,
        tasks: refresh(view.tasks, planTasks(input.plan).map(serializeTask)),
        // A saved plan's phase-tagged form has no run settings to say.
        runSettings: 'tasks' in input.plan ? input.plan.runSettings : view.runSettings,
      };
    case 'status_update':
      return {
        ...view,
        tasks: applyStatus(view.tasks, new Map(input.tasks.map((t) => [t.id, t]))),
        runMerge: input.runMerge ?? null,
        handoff: stillToMerge(view.handoff, input.runMerge),
        usage: input.usage,
        ...(input.activity ? { activity: input.activity } : {}),
        escalations: input.escalations ?? [],
      };
    case 'task_started':
    case 'task_updated': {
      const tasks = changeTask(view.tasks, input.taskId, (task) => (input.type === 'task_started' ? startTask(task) : patchTask(task, input.changes)));
      return tasks === view.tasks ? view : { ...view, tasks };
    }
    case 'isolation_handoff':
      return { ...view, handoff: handoffOf(input) };
    case 'isolation_merge':
      return input.result.outcome === 'merged'
        ? { ...view, mergeResult: input.result, handoff: null, runMerge: null }
        : { ...view, mergeResult: input.result };
    case 'run_closed':
      return { ...view, tasks: withoutIsolation(view.tasks), handoff: null, runMerge: null, mergeResult: null };
    // A checkpoint's whole question and every status `review_needed` implies
    // arrive in the status update that follows; `review_needed`'s own list is
    // flat, so as a plan it would lift subtasks to the top level.
    case 'checkpoint':
    case 'review_needed':
    case 'review_approved':
    case 'execution_complete':
    case 'execution_stopped':
    case 'execution_action':
    case 'task_output':
    case 'task_log':
    case 'isolation_blocked':
    case 'planner_message':
    case 'planner_turn_started':
    case 'planner_skill_loaded':
    case 'planner_turn_ended':
    case 'planner_text_delta':
    case 'planner_thinking_delta':
    case 'planner_text_retracted':
    case 'planner_usage':
    case 'planner_liveness':
    case 'planner_compaction':
    case 'planner_detection':
    case 'subagent_started':
    case 'subagent_finished':
    case 'research_step':
    case 'research_step_done':
    case 'plan_token':
    case 'approval_request':
    case 'approval_settled':
    case 'approval_decided':
      return view;
    default: {
      // Listed rather than defaulted, so a new message fails to compile until
      // someone decides what it does to a run.
      const unhandled: never = input;
      return unhandled;
    }
  }
}

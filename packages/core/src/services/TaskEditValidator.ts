import { Task, flattenTasksWithParents, waitsMidAttempt } from '../models/Task';
import { canSetDependencies } from './PlanTree';
import { NOT_STARTED } from '../taskRow/status';
import { notOnAScriptMessage, opsPlacementRefusal } from './PlannedTask';
import { notAScriptsFields, SCRIPT_BODY_FIELDS } from '../models/ScriptTask';

/**
 * Who is making the edit. The planner (`applyTaskOps`) and the direct-edit
 * path (`PlanEditor.updateTask`, reached by the TUI, the CLI, the webview
 * task card, and `PUT /tasks/:taskId`) are deliberately asymmetric —
 * see CONTEXT.md, "Direct edit vs planner edit". The planner may not reach
 * into a task that is running or already finished; the direct path may,
 * because it is the user editing their own plan, and pays what that costs at
 * the call site (cancelling a live runner, releasing blocked dependents).
 */
export type TaskEditActor = 'planner' | 'direct';

export interface TaskEditCheck {
  ok: boolean;
  error?: string;
  /**
   * Fields a type flip strips of meaning, to be force-cleared by the caller
   * (set to `undefined` in the applied changes) and named in whatever summary
   * reaches the transcript. Only lists fields the target actually had a value
   * for — nothing to clear reads as nothing lost.
   */
  clear?: (keyof Task)[];
  /** Fields a flip forces to a value rather than strips — a user task is always HITL — applied with {@link clear}. */
  set?: Partial<Task>;
}

/**
 * Why the planner may not touch a task execution has reached, worded with what
 * would be accepted instead: the note goes back to the model, mid-run
 * included, so it can act on it rather than retry the same edit (ADR-0029).
 * Null for a task the planner may edit.
 */
export function lockedTaskRefusal(task: Pick<Task, 'title' | 'status'>, action = 'changed'): string | null {
  if (task.status === 'in_progress') return runningRefusal(task, action);
  if (task.status === 'completed') return `"${task.title}" is completed and cannot be ${action}: rearm it to run it again, or add a new task for further work`;
  return null;
}

/**
 * {@link lockedTaskRefusal} for an op that takes the task out of the plan:
 * remove, merge or split. One waiting at a checkpoint or for input still has
 * its runner live, so the plan would carry it over and run its work twice; an
 * update leaves it in place, under the live-runner checks of its fields.
 */
export function reshapeRefusal(task: Pick<Task, 'title' | 'status' | 'awaitingReason'>, action: string): string | null {
  return waitsMidAttempt(task) ? runningRefusal(task, action) : lockedTaskRefusal(task, action);
}

function runningRefusal(task: Pick<Task, 'title'>, action: string): string {
  return `"${task.title}" is running and cannot be ${action} now: the user can stop it first, or change it after it finishes`;
}

/**
 * Why the task card's edit may not land: the card offers its editors only on a
 * task that has not started, and execution reached that task while the edit
 * was waiting on discovery or a skill check. The wider direct path still lets
 * the user change a live task, so this is the card's own precondition.
 */
export function startedEditRefusal(task: Pick<Task, 'title'>): string {
  return `"${task.title}" started before this change was saved, so it was not changed: only a task that has not started can be edited while the plan runs`;
}

const AI_ONLY_FIELDS = ['assignedModel', 'taskMode', 'autonomy', 'ops'] as const satisfies readonly (keyof Task)[];

/** What a task loses on becoming a script task (ADR-0035): everything a runner would read. */
const NOT_KEPT_BY_A_SCRIPT = [...AI_ONLY_FIELDS, 'prompt', 'skills', 'userSteps'] as const satisfies readonly (keyof Task)[];

/**
 * Coherence between `type` and the fields that only make sense for one side
 * of it. Deriving user steps from an AI prompt (or vice versa) would fabricate
 * instructions nobody wrote (ADR-0001: the plan is the source of truth), so a
 * flip that lacks the content the new type needs is refused rather than
 * silently patched — the planner gets that refusal back through the repair
 * loop; a direct edit gets it as a thrown reason. A flip that IS well-formed
 * clears the fields that stopped meaning anything, named for the caller.
 */
function typeCoherenceCheck(target: Task, changes: Partial<Task>): TaskEditCheck | null {
  if (!changes.type || changes.type === target.type) return null;
  // A goal and a prompt are not the same work, and its child would answer for another (ADR-0055 D1): a new task says so.
  if (changes.type === 'delegated' || target.type === 'delegated') return { ok: false, error: `"${target.title}" cannot change between a delegated task and any other: add a new task instead` };
  // What runs, and where, is fixed once it has run (ADR-0020): a script's
  // body and a runner's prompt are not the same work, and its log and verdict
  // would describe the other one.
  if ((changes.type === 'script' || target.type === 'script') && !NOT_STARTED.has(target.status)) {
    return { ok: false, error: `"${target.title}" has started, so whether it is a script task is fixed: add a new task instead` };
  }
  const body = target.type === 'script' ? SCRIPT_BODY_FIELDS.filter((f) => target[f] !== undefined) : [];

  if (changes.type === 'user') {
    if (!Array.isArray(changes.userSteps) || changes.userSteps.length === 0) {
      return { ok: false, error: `"${target.title}" cannot become a manual task without user steps: include "userSteps" in this edit` };
    }
    return {
      ok: true,
      clear: [...AI_ONLY_FIELDS.filter((f) => target[f] !== undefined), ...body],
      // User tasks are held to HITL, so a flip that kept the AI task's slice would be refused by the plan's own rules.
      ...(target.sliceType !== 'HITL' ? { set: { sliceType: 'HITL' as const } } : {}),
    };
  }

  if (changes.type === 'script') {
    if (changes.commands === undefined && changes.script === undefined) {
      return { ok: false, error: `"${target.title}" cannot become a script task without a body: include "commands" or "script" in this edit` };
    }
    return { ok: true, clear: NOT_KEPT_BY_A_SCRIPT.filter((f) => target[f] !== undefined) };
  }

  // changes.type === 'ai'
  if (!changes.prompt || !changes.prompt.trim()) {
    return { ok: false, error: `"${target.title}" cannot become an AI task without a prompt: include "prompt" in this edit` };
  }
  return { ok: true, clear: [...(target.userSteps && target.userSteps.length > 0 ? ['userSteps' as const] : []), ...body] };
}

/**
 * What a script task's edit may hold (ADR-0035). It runs its body with no
 * model, so a runner, model, mode or prompt is refused rather than dropped,
 * and a body belongs on a script task only. A new body replaces the old one,
 * whichever kind it was: the edit writes what runs.
 */
function scriptCheck(target: Task, changes: Partial<Task>): TaskEditCheck | null {
  if ((changes.type ?? target.type) !== 'script') {
    const body = SCRIPT_BODY_FIELDS.filter((f) => changes[f] !== undefined);
    if (body.length === 0) return null;
    return { ok: false, error: `"${target.title}" is not a script task, so it has no ${body.map((f) => `"${f}"`).join(', ')}: set "type": "script" with it, or leave it out` };
  }
  const extra = [...('assignedRunner' in changes && changes.assignedRunner !== undefined ? ['assignedRunner'] : []), ...notAScriptsFields(changes)];
  if (extra.length > 0) return { ok: false, error: `"${target.title}" ${notOnAScriptMessage(extra)}` };
  const replaced = [
    ...(changes.commands !== undefined && !('script' in changes) && target.script !== undefined ? ['script' as const] : []),
    ...(changes.script !== undefined && !('commands' in changes) && target.commands !== undefined ? ['commands' as const] : []),
  ];
  return replaced.length > 0 ? { ok: true, clear: replaced } : null;
}

/**
 * Whether a task may become an ops task, or stop being one (ADR-0020). Only a
 * top-level AI task can be ops, and the flag decides where the task runs, so
 * once it has started it is fixed, like its runner session.
 */
function opsCheck(target: Task, isSubtask: boolean, changes: Partial<Task>): TaskEditCheck | null {
  if (!('ops' in changes) || !!changes.ops === !!target.ops) return null;
  if (!NOT_STARTED.has(target.status)) {
    return { ok: false, error: `"${target.title}" has started, so whether it is an ops task is fixed` };
  }
  if (!changes.ops) return null;
  const refused = opsPlacementRefusal(changes.type ?? target.type, isSubtask);
  return refused ? { ok: false, error: `"${target.title}" ${refused}` } : null;
}

/**
 * The rules governing one task edit that are not about what it runs on: who
 * may make it, and whether the task stays well-formed. Lock rules
 * (running/completed) apply to the planner only. Well-formedness rules — a
 * hand-set dependency list, the one edit that can leave the plan
 * unschedulable, type/content coherence on a flip between AI, manual and
 * script, what a script task may hold, and where an ops task may be —
 * describe the task rather than who asked, so they run for
 * both, through the same {@link canSetDependencies} guard the pickers and the
 * API read. What the task's runner, model, effort and mode end up as is the
 * assignment resolver's (`resolveAssignment`), and the rules the plan's tasks
 * are held to together are `checkPlanInvariants`', both for both actors too.
 *
 * `tasks` is the plan tree: the target is found at any depth, and its
 * dependencies are checked against the whole plan tree.
 */
export function validateTaskEdit(
  actor: TaskEditActor,
  tasks: readonly Task[],
  taskId: string,
  changes: Partial<Task>,
): TaskEditCheck {
  const found = flattenTasksWithParents(tasks).find(({ task }) => task.id === taskId);
  if (!found) return { ok: false, error: 'Task not found' };
  const { task: target, parent } = found;

  const locked = actor === 'planner' ? lockedTaskRefusal(target, 'modified') : null;
  if (locked) return { ok: false, error: locked };

  if (changes.dependencies) {
    const depCheck = canSetDependencies(tasks, taskId, changes.dependencies);
    if (!depCheck.ok) return depCheck;
  }

  const coherence = typeCoherenceCheck(target, changes);
  if (coherence && !coherence.ok) return coherence;

  const script = scriptCheck(target, changes);
  if (script && !script.ok) return script;

  const ops = opsCheck(target, parent !== null, changes);
  if (ops) return ops;

  if (!script) return coherence ?? { ok: true };
  return { ...coherence, ok: true, clear: [...coherence?.clear ?? [], ...script.clear ?? []] };
}

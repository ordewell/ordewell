import { titledTaskRef, titledTaskRefOf } from '../services/TaskRefs';
import { checkOf, type TaskLoop } from '../models/Loop';

interface Named {
  id: string;
  order: number;
  title: string;
  subtasks?: readonly Named[];
  loop?: TaskLoop;
}

/** Each id as "#N title", subtasks dotted, by the plan's tree; one it no longer holds stays a bare id. */
export function titledRefs(ids: readonly string[], tasks: readonly Named[]): string[] {
  return ids.map((id) => titledTaskRefOf(tasks, id) ?? id);
}

/**
 * What removing a task does to the tasks that depend on it, or null when none
 * do. Named rather than counted: the removal rewrites their dependency lists,
 * and a bare "Remove task?" would hide that.
 */
export function dependentsNotice(dependents: readonly { id?: string; order: number; title: string }[], tasks: readonly Named[] = []): string | null {
  if (dependents.length === 0) return null;
  const subject = dependents.length === 1 ? '1 task depends' : `${dependents.length} tasks depend`;
  return `${subject} on it and will lose that dependency: ${dependents.map((t) => (t.id ? titledTaskRefOf(tasks, t.id) : undefined) ?? titledTaskRef(t)).join(', ')}.`;
}

/**
 * What removing a loop's body task does to its loop (ADR-0045 L8), or null for
 * a task in none: it leaves the body, and a loop left with no body is dropped.
 * A check is not here: core refuses its removal (`loopRemovalRefusal`).
 */
export function loopLeaveNotice(tasks: readonly Named[], taskId: string): string | null {
  const check = checkOf(tasks, taskId);
  if (!check?.loop) return null;
  const [named] = titledRefs([check.id], tasks);
  return check.loop.body.length > 1
    ? `It is in the body of ${named}'s loop, and leaves it.`
    : `It is the whole body of ${named}'s loop, so the loop is dropped with it.`;
}

/**
 * What a start past a merge gate is asked with (ADR-0020): the work the task
 * would act without, named. `subject` is how the asking surface refers to the
 * task — "It" under a title that already names it.
 */
export function pastGateConfirmation(unmerged: readonly string[], subject = 'This task'): string {
  return `${subject} waits for Merge all: the work of ${unmerged.join(', ')} is not merged into your branch yet, so it would act without it. Starting it now is kept on the task.`;
}

/** Which way a manual override moves a task: the direction of Mark complete or Mark not done. */
export type OverrideDirection = 'complete' | 'uncomplete';

/**
 * What a user is asked before they override an AI or script task by hand
 * (ADR-0029), the same words on every surface. `label` names the task. Marking
 * complete vouches for work no verdict passed; marking not done undoes only the
 * completion, never the work or what already ran on it.
 */
export function manualOverrideConfirmation(direction: OverrideDirection, label: string): string {
  return direction === 'complete'
    ? `Mark ${label} complete? You vouch for its work although no passing verdict said it was done. Any changes it kept may land in your run, and the tasks that depend on it are released to start on a future run.`
    : `Mark ${label} not done? This clears its completion and holds it until you retry or start it. The work it did stays where it is, and tasks that already ran on its result are not undone.`;
}

/** What a revert does (ADR-0054), told with the list of tasks it takes: the same words on every surface. */
export const revertEffect = 'Its landed work comes off the integration branch, newest first, and each task listed is held as not started until you retry it. Nothing in your own branch changes.';

/** One task of a revert's confirmation: `dependent` is one that goes with the task the user chose. */
export function revertListLine(task: { order: number; title: string; repos: readonly string[]; dependent: boolean }): string {
  const repos = task.repos.length === 1 && task.repos[0] === '.' ? '' : ` (${task.repos.join(', ')})`;
  return `#${task.order} ${task.title}${repos}${task.dependent ? ' (goes with it)' : ''}`;
}

/** Why a manual override waits for the run to stop (ADR-0029); `label` names the task. */
export function manualOverrideStopFirst(direction: OverrideDirection, label: string): string {
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} cannot be marked ${direction === 'complete' ? 'complete' : 'not done'} while the plan is starting, running or waiting to resume, because the run could still move it on. Stop the run first, and mark it once everything has stopped.`;
}

export interface NewTaskFields {
  title: string;
  description: string;
  prompt: string;
  type: 'ai';
}

/**
 * What a hand-added task starts as: an AI task whose description is its title
 * and whose prompt, unless one was typed, is too. Null for a title with nothing
 * in it, rather than a nameless task. Assignments are left for the session to
 * derive from the runner's catalog.
 */
export function newTaskFields(title: string, prompt?: string): NewTaskFields | null {
  const name = title.trim();
  if (!name) return null;
  return { title: name, description: name, prompt: prompt?.trim() ? prompt : name, type: 'ai' };
}

/**
 * Why a manual or script task offers no executor choice (a runner, model,
 * effort or mode), worded for whichever of the two it is; a script task runs
 * no model (ADR-0035). `manual` and `script` finish the sentence for each.
 */
export function noExecutorRefusal(type: string, manual: string, script: string): string {
  return type === 'script' ? `A script task runs no model, so ${script}` : `Manual tasks do not run an executor, so ${manual}`;
}

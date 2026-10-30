import type { IsolationRevertResult, IsolationRevertTask, IsolationRun, IsolationTaskRef, RevertCommand } from '../interfaces/IWorktreeIsolation';
import { checkOf, loopEnded } from '../models/Loop';
import type { Task } from '../models/Task';
import { quotedList } from '../utils/quotedList';
import { changedReposOf } from './isolationRecord';

/*
 * What a revert of one task takes and whether it may go ahead (ADR-0054): the
 * plan's half of the question, with no git in it, and the words every refusal
 * is told in. GitWorktreeIsolation answers the other half, in its turn.
 */

export type RevertRefusalReason = 'no-landing' | 'no-own-merge' | 'checked-out' | 'in-a-loop' | 'live-dependent' | 'in-branch' | 'git';

export interface RevertRefusal {
  reason: RevertRefusalReason;
  message: string;
  /** `live-dependent`: the tasks in the way. */
  tasks?: IsolationTaskRef[];
  /** `in-branch`: what undoes the work there, newest first, for the user to run. */
  commands?: RevertCommand[];
}

/** The tasks a revert would take, the one asked for first; `refusal` says why it may not go ahead, and with no landing there is nothing to take. */
export interface RevertScope {
  taskIds: string[];
  refusal?: RevertRefusal;
}

/** A task a preview lists; `dependent` is one that goes with the task the user chose, and `ref` how the plan calls it, a subtask's full path. */
export interface RevertPreviewTask extends IsolationRevertTask {
  dependent: boolean;
  ref?: string;
}

/** What a revert would do now, for a surface to confirm with the user before anything changes. */
export type TaskRevertPreview =
  | { revertible: true; tasks: RevertPreviewTask[] }
  | ({ revertible: false } & RevertRefusal);

export interface RevertScopeInput {
  tasks: readonly Readonly<Task>[];
  run: IsolationRun | null;
  /** Tasks at work, or that go on by themselves: nothing they stand on may be taken from under them. */
  live: ReadonlySet<string>;
}

const ref = ({ id, order, title }: Readonly<Task>): IsolationTaskRef => ({ taskId: id, order, title });

/**
 * Whether a task has work of its own on the integration branch, this attempt's
 * or an earlier one's. A retry, a failed spawn or a continue that conflicted
 * leaves a record that is not `merged`, or none, over merges still on the branch.
 */
function landedWork(run: IsolationRun | null, taskId: string): boolean {
  const record = run?.tasks[taskId];
  return run?.landings?.[taskId] !== undefined || (record?.status === 'merged' && changedReposOf(record).length > 0);
}

/** Everything that depends on the task, directly or not, a check counting on its body as it does at a merge gate (ADR-0045 L9). */
function dependentsOf(tasks: readonly Readonly<Task>[], taskId: string): Readonly<Task>[] {
  const found = new Set<string>([taskId]);
  const queue = [taskId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const task of tasks) {
      if (found.has(task.id) || ![...task.dependencies, ...task.loop?.body ?? []].includes(id)) continue;
      found.add(task.id);
      queue.push(task.id);
    }
  }
  found.delete(taskId);
  return tasks.filter((task) => found.has(task.id));
}

/** The tasks a revert of this one stands to change the ground of, landed or not: no start of one may be claimed while it runs. */
export function revertReach(taskId: string, tasks: readonly Readonly<Task>[]): ReadonlySet<string> {
  return new Set([taskId, ...dependentsOf(tasks, taskId).map((t) => t.id)]);
}

/** The check of a loop the task is in, while that loop has not ended. */
function openLoop(tasks: readonly Readonly<Task>[], task: Readonly<Task>): Readonly<Task> | undefined {
  const check = task.loop ? task : checkOf(tasks, task.id);
  return check && !loopEnded(check) ? check : undefined;
}

export function revertScope(taskId: string, { tasks, run, live }: RevertScopeInput): RevertScope {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !landedWork(run, taskId)) {
    return { taskIds: [], refusal: { reason: 'no-landing', message: `${task ? `Task "${task.title}"` : 'That task'} landed nothing on the integration branch, so there is nothing to revert.` } };
  }
  const dependents = dependentsOf(tasks, taskId);
  const taken = [task, ...dependents.filter((t) => landedWork(run, t.id))];
  const taskIds = taken.map((t) => t.id);

  const looped = taken.find((t) => openLoop(tasks, t));
  if (looped) {
    const check = openLoop(tasks, looped)!;
    return { taskIds, refusal: { reason: 'in-a-loop', message: `Task "${looped.title}" is in the loop of task "${check.title}", which has not ended: a loop's rounds decide what it lands, so a revert would be working against them. Nothing was reverted. Let the loop end first.` } };
  }

  const held = [task, ...dependents].filter((t) => live.has(t.id));
  if (held.length > 0) {
    const one = held.length === 1;
    const subject = `${one ? 'Task' : 'Tasks'} ${quotedList(held.map((t) => t.title))}`;
    const stands = held.some((t) => t.id === taskId) ? `${one ? 'is' : 'are'} still running or waiting on you` : `${one ? 'depends' : 'depend'} on it and ${one ? 'is' : 'are'} still running or waiting on you, from a tip that holds this work`;
    return { taskIds, refusal: { reason: 'live-dependent', tasks: held.map(ref), message: `${subject} ${stands}. Nothing was reverted. Let ${one ? 'it' : 'them'} finish, or stop ${one ? 'it' : 'them'}, first.` } };
  }
  return { taskIds };
}

/** What a user is told of work already in their branch. */
export function inBranchRefusal(commands: readonly RevertCommand[]): RevertRefusal {
  const one = commands.length === 1;
  return {
    reason: 'in-branch',
    commands: [...commands],
    message: `This work is already merged into your branch, which Ordewell never writes to. To undo it there, run ${one ? 'this' : 'these, in order'}: ${commands.map((c) => c.command).join('; ')}`,
  };
}

/** How a revert that did not go through ended, in a sentence. */
export function revertStopped(result: Exclude<IsolationRevertResult, { outcome: 'reverted' }>): string {
  switch (result.outcome) {
    case 'in-branch': return inBranchRefusal(result.commands).message;
    case 'refused': return result.reason;
    case 'conflict': return `Reverting task "${result.task.title}" conflicts with what landed after it${result.repo === '.' ? '' : ` in ${result.repo}`}: ${result.files.join(', ')}. Nothing was reverted, and the integration branch is as it was.`;
    case 'failed': return `${result.task ? `Reverting task "${result.task.title}"` : 'The revert'} stopped${result.repo && result.repo !== '.' ? ` in ${result.repo}` : ''}: ${result.error}.`;
  }
}

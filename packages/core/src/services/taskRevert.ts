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

export type RevertRefusalReason = 'no-landing' | 'no-own-merge' | 'checked-out' | 'uncommitted-changes' | 'in-a-loop' | 'live-dependent' | 'in-branch' | 'git';

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
  /** The resolvers out to a task's conflict, which would land the attempt a revert ends. */
  resolvers: (taskId: string) => readonly Readonly<Task>[];
}

const ref = ({ id, order, title }: Readonly<Task>): IsolationTaskRef => ({ taskId: id, order, title });

/**
 * Whether a task has work of its own on the integration branch, this attempt's
 * or an earlier one's. A retry, a failed spawn or a continue that conflicted
 * leaves a record that is not `merged`, or none, over merges still on the branch.
 */
function landedWork(run: IsolationRun | null, taskId: string): boolean {
  const record = run?.tasks[taskId];
  return run?.landings?.[taskId] !== undefined || run?.carried?.[taskId] !== undefined || (record?.status === 'merged' && changedReposOf(record).length > 0);
}

/** Whether a task of a run that did not keep its merges from the start can have landed in an attempt no record speaks for: nothing says it did not. */
function mayHaveLanded(run: IsolationRun | null, task: Readonly<Task>): boolean {
  const record = run?.tasks[task.id];
  return !run?.keepsEveryLanding && !landedWork(run, task.id) && task.type === 'ai' && !task.ops && !record?.readOnly && (task.attempted === true || record !== undefined);
}

/** What stops a revert being all of what it says: a task that goes with it whose merges no record can name, or a dependent that may have some. */
function unnamedLanding(run: IsolationRun | null, taken: readonly Readonly<Task>[], dependents: readonly Readonly<Task>[]): Readonly<Task> | undefined {
  return taken.find((t) => !run?.tasks[t.id] && !run?.landedTasks?.[t.id]) ?? dependents.find((t) => mayHaveLanded(run, t));
}

/** What a task depends on in the plan, a check counting on its body as it does at a merge gate (ADR-0045 L9). */
const dependenciesOf = (task: Readonly<Task>): string[] => [...task.dependencies, ...task.loop?.body ?? []];

/** What a task depends on, directly or not, for {@link IsolationRun.landedOn} to keep as it lands. */
export function landedOnOf(taskId: string, tasks: readonly Readonly<Task>[]): string[] {
  const found = new Set<string>();
  const queue = [taskId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const task = tasks.find((t) => t.id === id);
    for (const dependency of task ? dependenciesOf(task) : []) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      queue.push(dependency);
    }
  }
  return [...found];
}

/** Everything that depends on the task, directly or not, by the plan or by what a landing kept: the plan lets go of a task that leaves it, and of what stood on it through that task. */
function dependentIds(tasks: readonly Readonly<Task>[], run: IsolationRun | null, taskId: string): Set<string> {
  const edges = new Map(tasks.map((t) => [t.id, dependenciesOf(t)]));
  for (const [id, landedOn] of Object.entries(run?.landedOn ?? {})) edges.set(id, [...edges.get(id) ?? [], ...landedOn]);
  const found = new Set<string>([taskId]);
  const queue = [taskId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const [other, dependencies] of edges) {
      if (found.has(other) || !dependencies.includes(id)) continue;
      found.add(other);
      queue.push(other);
    }
  }
  found.delete(taskId);
  return found;
}

/** The tasks a revert of this one stands to change the ground of, landed or not: no start of one may be claimed while it runs. */
export function revertReach(taskId: string, tasks: readonly Readonly<Task>[], run: IsolationRun | null): ReadonlySet<string> {
  return new Set([taskId, ...dependentIds(tasks, run, taskId)]);
}

/** A task that landed and left the plan with no record of what it depended on, or of what to call it: whether it stands on the work nothing can say. */
function unreadLanding(run: IsolationRun | null, tasks: readonly Readonly<Task>[]): string | undefined {
  if (!run) return undefined;
  const planned = new Set(tasks.map((t) => t.id));
  const landed = [...Object.keys(run.landings ?? {}), ...Object.keys(run.carried ?? {}), ...Object.keys(run.tasks)].filter((id) => !planned.has(id) && landedWork(run, id));
  const unread = landed.find((id) => !run.landedOn?.[id] || !(run.tasks[id] ?? run.landedTasks?.[id]));
  return unread === undefined ? undefined : (run.tasks[unread] ?? run.landedTasks?.[unread])?.title ?? unread;
}

/** The check of a loop the task is in, while that loop has not ended. */
function openLoop(tasks: readonly Readonly<Task>[], task: Readonly<Task>): Readonly<Task> | undefined {
  const check = task.loop ? task : checkOf(tasks, task.id);
  return check && !loopEnded(check) ? check : undefined;
}

export function revertScope(taskId: string, { tasks, run, live, resolvers }: RevertScopeInput): RevertScope {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !landedWork(run, taskId)) {
    return { taskIds: [], refusal: { reason: 'no-landing', message: `${task ? `Task "${task.title}"` : 'That task'} landed nothing on the integration branch, so there is nothing to revert.` } };
  }
  const reached = dependentIds(tasks, run, taskId);
  const dependents = tasks.filter((t) => reached.has(t.id));
  const taken = [task, ...dependents.filter((t) => landedWork(run, t.id))];
  const leftThePlan = [...reached].filter((id) => !tasks.some((t) => t.id === id) && landedWork(run, id));
  const taskIds = [...taken.map((t) => t.id), ...leftThePlan];

  const looped = taken.find((t) => openLoop(tasks, t));
  if (looped) {
    const check = openLoop(tasks, looped)!;
    return { taskIds, refusal: { reason: 'in-a-loop', message: `Task "${looped.title}" is in the loop of task "${check.title}", which has not ended: a loop's rounds decide what it lands, so a revert would be working against them. Nothing was reverted. Let the loop end first.` } };
  }

  const unnamed = unnamedLanding(run, taken, dependents);
  if (unnamed) {
    return { taskIds, refusal: { reason: 'no-own-merge', message: `Ordewell has no record of which merges landed task "${unnamed.title}", so it cannot tell what a revert would have to take. Nothing was reverted.` } };
  }

  const unread = unreadLanding(run, tasks);
  if (unread !== undefined) {
    return { taskIds, refusal: { reason: 'no-own-merge', message: `Task "${unread}" landed and left the plan, and Ordewell has no record of what it depended on, so it cannot tell whether that work stands on this. Nothing was reverted.` } };
  }

  const held = [task, ...dependents].filter((t) => live.has(t.id));
  if (held.length > 0) {
    const one = held.length === 1;
    const subject = `${one ? 'Task' : 'Tasks'} ${quotedList(held.map((t) => t.title))}`;
    const stands = held.some((t) => t.id === taskId) ? `${one ? 'is' : 'are'} still running or waiting on you` : `${one ? 'depends' : 'depend'} on it and ${one ? 'is' : 'are'} still running or waiting on you, from a tip that holds this work`;
    return { taskIds, refusal: { reason: 'live-dependent', tasks: held.map(ref), message: `${subject} ${stands}. Nothing was reverted. Let ${one ? 'it' : 'them'} finish, or stop ${one ? 'it' : 'them'}, first.` } };
  }

  const resolving = taken.flatMap((t) => resolvers(t.id).filter((r) => live.has(r.id)).map((resolver) => ({ resolver, conflicted: t })));
  if (resolving.length > 0) {
    const [{ resolver, conflicted }] = resolving;
    return { taskIds, refusal: { reason: 'live-dependent', tasks: resolving.map((r) => ref(r.resolver)), message: `Task "${resolver.title}" is at work on the conflict of task "${conflicted.title}", and its merge would land what the revert ends. Nothing was reverted. Let it finish, or stop it, first.` } };
  }
  return { taskIds };
}

/**
 * What a user is told of work something of theirs holds. A revert cannot tell a
 * review from a merge (ADR-0054), so what is not their own branch may only be
 * in the way, and they are told how to clear it. Their own branch never is.
 */
export function inBranchRefusal(commands: readonly RevertCommand[]): RevertRefusal {
  const one = commands.length === 1;
  const held = [...new Set(commands.flatMap((c) => c.heldBy))];
  const branches = held.filter((ref) => ref !== 'HEAD');
  const detached = held.includes('HEAD');
  const named = [...(branches.length > 0 ? [quotedList(branches)] : []), ...(detached ? ['a detached HEAD'] : [])].join(' and ');
  const clear = [...(branches.length > 0 ? [`delete ${quotedList(branches)}`] : []), ...(detached ? ['check out something else'] : [])].join(' and ');
  const review = commands.every((c) => !c.merged) ? `. If that is only a review, ${clear} first, then revert again.` : '';
  return {
    reason: 'in-branch',
    commands: [...commands],
    message: `This work is already in ${named}, which Ordewell never writes to. To undo it there, run ${one ? 'this' : 'these, in order'}: ${commands.map((c) => c.command).join('; ')}${review}`,
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

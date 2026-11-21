import { flattenTasksWithParents, runsAsOps, type Task } from '../models/Task';
import { heldDependencies } from './blocking';

/**
 * A change task that cannot do its own work without a sibling's that has not
 * landed parks instead of waiting inside its attempt (`wait_for`): the attempt
 * ends with no verdict, as a usage-limit pause does (ADR-0018 U1), its
 * worktree and runner session are kept, the tasks it waits for become its
 * dependencies in the plan, and the scheduler continues its session once they
 * have landed. The plan stays what runs: the wait is an edge anyone reads, and
 * the start rule needs nothing new (ADR-0034). This module is the rule for
 * what a wait may name, and what the continuation is told.
 */

/** How many times one task may park in a run: a third wait is a task that cannot finish without others', which its check is for. */
export const MAX_PARKS = 2;

/** What a task saves as it parks, read by the start that continues it. */
export interface Parked {
  /** The attempt that parked, which the continuation goes on from. */
  attempt: number;
  /** The tasks it waits for, which its dependencies now hold. */
  waitsOn: string[];
  /** Times it has parked this run, this one included. */
  count: number;
}

export type ParkDecision = { ok: true; dependencies: string[] } | { ok: false; refusal: string };

const named = (t: Task, label: string) => `#${label} "${t.title}"`;

/**
 * Whether `taskId` may park on `waitOn`, and the dependencies it would then
 * hold. Refused, with what to do instead: work that has landed (take it in),
 * work that may never land (failed, skipped, or that lands nothing), a task
 * that waits on this one (the edge would be a cycle), a runner that cannot
 * continue a session, and a task that has parked {@link MAX_PARKS} times.
 */
export function parkDecision(plan: readonly Task[], taskId: string, waitOn: readonly string[], opts: { resumable: boolean; parkedBefore: number }): ParkDecision {
  const flat = flattenTasksWithParents([...plan]);
  const byId = new Map(flat.map(({ task, label }) => [task.id, { task, label }]));
  const self = byId.get(taskId);
  if (!self) return { ok: false, refusal: 'This task is no longer in the plan.' };
  const finish = 'Finish your own part and end as your brief says, naming each check that needs that work, and the task whose work it needs, in a finding.';
  if (!opts.resumable) return { ok: false, refusal: `wait_for is not available: this task's runner cannot continue its session. ${finish}` };
  if (opts.parkedBefore >= MAX_PARKS) return { ok: false, refusal: `This task has waited ${opts.parkedBefore} times this run, the most it may. ${finish}` };
  if (waitOn.length === 0) return { ok: false, refusal: 'Name at least one task to wait for.' };
  const held = heldDependencies([...plan]);
  const waitsFor = (id: string, target: string): boolean => {
    const seen = new Set<string>();
    for (const stack = [id]; stack.length > 0;) {
      const at = stack.pop()!;
      if (at === target) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      const t = byId.get(at)?.task;
      if (!t) continue;
      stack.push(...held(t).map((d) => d.id), ...(t.loop?.body ?? []));
    }
    return false;
  };
  const refusals: string[] = [];
  const added: string[] = [];
  for (const id of new Set(waitOn)) {
    const entry = byId.get(id);
    if (!entry) { refusals.push(`${JSON.stringify(id)} names no task in the plan.`); continue; }
    const { task, label } = entry;
    const name = named(task, label);
    if (id === taskId) refusals.push(`${name} is this task.`);
    else if (task.status === 'completed') refusals.push(`${name} has landed: take its work in now, as "Work landing beside yours" says, rather than waiting.`);
    else if (task.status === 'failed' || task.status === 'skipped') refusals.push(`${name} ${task.status === 'failed' ? 'failed' : 'was skipped'}, so its work may never land. ${finish}`);
    else if ((task.type !== 'ai' && task.type !== 'delegated') || task.readOnly || runsAsOps(task)) refusals.push(`${name} lands no work on the run's branch, so there is nothing to wait for.`);
    else if (waitsFor(id, taskId)) refusals.push(`${name} waits for this task, directly or through others, so it cannot land before it. ${finish}`);
    else if (!self.task.dependencies.includes(id)) added.push(id);
  }
  if (refusals.length > 0) return { ok: false, refusal: `Not waiting; nothing changed.\n${refusals.join('\n')}` };
  return { ok: true, dependencies: [...self.task.dependencies, ...added] };
}

/** The first message of the continuation, once what it waited for has landed: take it in, then go on. */
export function parkResumeMessage(landed: readonly string[], takeIn: string): string {
  return `(Ordewell) The work you waited for has landed: ${landed.join(', ')}. ${takeIn}, resolving any conflict so that both sides' intent survives, then go on with your brief from where you stopped.`;
}

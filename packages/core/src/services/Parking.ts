import { flattenTasksWithParents, runsAsOps, type Parked, type Task } from '../models/Task';
import { heldDependencies, planBlocks } from './blocking';
import { sessionOwner } from './continuation';
import { resolveTaskRef } from './TaskRefs';

export type { Parked } from '../models/Task';

/**
 * A change task that cannot do its own work without a sibling's that has not
 * landed parks instead of waiting inside its attempt (`wait_for`, ADR-0074):
 * the attempt ends with no verdict, as a usage-limit pause does (ADR-0018 U1),
 * its worktree and runner session are kept, the tasks it waits for become its
 * dependencies in the plan, and its next start continues that session once
 * they have landed. The plan stays what runs: the wait is an edge anyone
 * reads, and the start rule needs nothing new (ADR-0034). This module is the
 * rule for what a wait may name, when it is over, and what the task is told.
 */

/** How many times one task may park between fresh attempts: a third wait is a task that cannot finish without others', which its check is for. */
export const MAX_PARKS = 2;

export type ParkDecision = { ok: true; waitsOn: string[]; added: string[] } | { ok: false; refusal: string };

const named = (t: Task, label: string) => `#${label} "${t.title}"`;

const FINISH = 'Finish your own part and end as your brief says, naming each check that needs that work, and the task whose work it needs, in a finding.';

/**
 * Whether `taskId` may park on the tasks `waitOn` names (an id, "#3" or a
 * title), and which of them the plan would gain as its dependencies. Refused
 * whole, with what to do instead: work that has landed (take it in), work
 * that may never land (failed, skipped, or that lands nothing), a task that
 * waits on this one or holds it (the edge would be a cycle), and a task that
 * has parked {@link MAX_PARKS} times.
 */
export function parkDecision(plan: readonly Task[], taskId: string, waitOn: readonly (string | number)[], opts: { parkedBefore: number }): ParkDecision {
  const flat = flattenTasksWithParents([...plan]);
  const byId = new Map(flat.map(({ task, label, parent }) => [task.id, { task, label, parent }]));
  const self = byId.get(taskId);
  if (!self) return { ok: false, refusal: 'This task is no longer in the plan.' };
  if (opts.parkedBefore >= MAX_PARKS) return { ok: false, refusal: `This task has waited ${opts.parkedBefore} times since it last started afresh, the most it may. ${FINISH}` };
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
  // A task's work includes its subtasks', so a task cannot wait for one of its own ancestors or descendants.
  const ancestors = new Set<string>();
  for (let at = self.parent; at; at = byId.get(at.id)?.parent ?? null) ancestors.add(at.id);
  const within = (id: string): boolean => {
    for (let at = byId.get(id)?.parent ?? null; at; at = byId.get(at.id)?.parent ?? null) if (at.id === taskId) return true;
    return false;
  };
  const refusals: string[] = [];
  const waitsOn: string[] = [];
  for (const ref of waitOn) {
    const found = resolveTaskRef([...plan], ref);
    const entry = found && byId.get(found.id);
    if (!entry) { refusals.push(`${JSON.stringify(String(ref))} names no task in the plan.`); continue; }
    if (waitsOn.includes(entry.task.id)) continue;
    const { task, label } = entry;
    const name = named(task, label);
    if (task.id === taskId) refusals.push(`${name} is this task.`);
    else if (ancestors.has(task.id) || within(task.id)) refusals.push(`${name} ${ancestors.has(task.id) ? 'holds' : 'is part of'} this task, so neither lands without the other.`);
    else if (task.status === 'completed') refusals.push(`${name} has landed: take its work in now, as "Work landing beside yours" says, rather than waiting.`);
    else if (task.status === 'failed' || task.status === 'skipped') refusals.push(`${name} ${task.status === 'failed' ? 'failed' : 'was skipped'}, so its work may never land. ${FINISH}`);
    else if ((task.type !== 'ai' && task.type !== 'delegated') || task.readOnly || runsAsOps(task)) refusals.push(`${name} lands no work on the run's branch, so there is nothing to wait for.`);
    else if (waitsFor(task.id, taskId)) refusals.push(`${name} waits for this task, directly or through others, so it cannot land before it. ${FINISH}`);
    else waitsOn.push(task.id);
  }
  if (refusals.length > 0) return { ok: false, refusal: `Not waiting; nothing changed.\n${refusals.join('\n')}` };
  return { ok: true, waitsOn, added: waitsOn.filter((id) => !self.task.dependencies.includes(id)) };
}

/** The latest attempt the task's ledger counts, 0 when none has run. */
function lastAttempt(task: Readonly<Task>): number {
  return Math.max(0, ...(task.attemptUsage ?? []).map((u) => u.attempt));
}

/** The park the task's next start goes on from: one no attempt has run since. Null otherwise. */
export function owedPark(task: Readonly<Task>): Parked | null {
  const { parked } = task;
  return parked && parked.attempt >= lastAttempt(task) ? parked : null;
}

/**
 * What the task it waits for has become: landed, still to land, or lost —
 * failed for good, skipped, blocked, gone from the plan, or no longer waited
 * for because someone took the edge out. A loop's check between rounds is
 * still to land (ADR-0045 L3).
 */
type Awaited = 'landed' | 'pending' | 'lost';

/** Whether a task's work cannot land without someone's retry: failed for good, or blocked (ADR-0034). */
function stuck(plan: readonly Task[]): (t: Task) => boolean {
  const { blocked, repeating } = planBlocks(plan);
  return (t) => blocked.has(t.id) || (t.status === 'failed' && !repeating.has(t.id));
}

function awaited(plan: readonly Task[], task: Readonly<Task>, id: string, blocked: (t: Task) => boolean): { state: Awaited; name: string; why?: string } {
  const entry = flattenTasksWithParents([...plan]).find((e) => e.task.id === id);
  if (!entry) return { state: 'lost', name: JSON.stringify(id), why: 'left the plan' };
  const name = named(entry.task, entry.label);
  if (entry.task.status === 'completed') return { state: 'landed', name };
  if (entry.task.status === 'skipped') return { state: 'lost', name, why: 'was skipped' };
  if (blocked(entry.task)) return { state: 'lost', name, why: entry.task.status === 'failed' ? 'failed' : 'is blocked by a failure' };
  if (!task.dependencies.includes(id)) return { state: 'lost', name, why: 'is no longer among what this task waits for' };
  return { state: 'pending', name };
}

/**
 * The edges each parked task added for work that will not land now, which
 * the scheduler takes back so the task goes on without it rather than wait
 * for a retry nobody may make (ADR-0074 P7).
 */
export function lostWaits(plan: readonly Task[]): Map<string, string[]> {
  const blocked = stuck(plan);
  const lost = new Map<string, string[]>();
  for (const { task } of flattenTasksWithParents([...plan])) {
    const park = task.status === 'pending' || task.status === 'approved' ? owedPark(task) : null;
    if (!park) continue;
    const gone = park.added.filter((id) => task.dependencies.includes(id) && awaited(plan, task, id, blocked).state === 'lost');
    if (gone.length > 0) lost.set(task.id, gone);
  }
  return lost;
}

/**
 * What a parked task's next start is told, and the session it continues: its
 * own, where its runner saved one it can resume, else none, and the attempt
 * starts afresh from the parked attempt's files (ADR-0074 P4). Its worktree is
 * restored from the integration tip with its own work merged back (ADR-0018
 * K1), so what landed is in it already.
 */
export function parkResume(task: Readonly<Task>, plan: readonly Task[]): { message: string; resumeSessionId?: string } | null {
  const park = owedPark(task);
  if (!park) return null;
  const blocked = stuck(plan);
  const states = park.waitsOn.map((id) => awaited(plan, task, id, blocked));
  const landed = states.filter((s) => s.state === 'landed').map((s) => s.name);
  const lost = states.filter((s) => s.state === 'lost');
  const parts: string[] = [];
  if (landed.length > 0) parts.push(`(Ordewell) The work you waited for has landed: ${landed.join(', ')}. It is in your working tree now, beside your own work.`);
  if (lost.length > 0) {
    parts.push(`${landed.length > 0 ? '' : '(Ordewell) '}The work you waited for will not land now: ${lost.map((s) => `${s.name} ${s.why}`).join('; ')}. ${FINISH}`);
  }
  parts.push('Go on with your brief from where you stopped.');
  const owner = sessionOwner(task as Task);
  const resumable = task.runnerSessionId && (!owner || owner === task.assignedRunner);
  return { message: parts.join(' '), ...(resumable ? { resumeSessionId: task.runnerSessionId } : {}) };
}

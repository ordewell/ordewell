import { flattenTasksWithParents, type Task } from './Task';

/*
 * A loop (ADR-0045): a check that repeats with its fix until it passes. The
 * loop is declared on its check, and its body is the top-level tasks that fix
 * what the check finds. Ordewell runs the rounds itself: the check, and while
 * it fails with rounds left, the body and then the check again. Nothing here
 * is stored but the loop and the round the check is in; whether a check is
 * between rounds is read from its status and verdict, as a block is.
 */

/** How many times a loop's check runs when the loop sets no `maxRounds`. */
export const DEFAULT_LOOP_ROUNDS = 3;

/** The most rounds a loop may set: past it, the fix is not converging, and a person should look. */
export const MAX_LOOP_ROUNDS = 10;

export interface TaskLoop {
  /** The top-level tasks, by id, that run to fix what the check found. */
  body: string[];
  /** The most times the check runs in one set of rounds. */
  maxRounds: number;
}

/** What the loop rules read of a task; structural, so a surface's own task shape answers them too. */
export interface LoopSubject {
  id: string;
  status: string;
  loop?: TaskLoop;
  /** The round of the check's latest run; absent is round 1. */
  loopRound?: number;
  verdict?: { outcome: string; reported?: string };
}

/** The round of a check's latest run, or the one it is running. */
export function loopRoundOf(check: Pick<LoopSubject, 'loopRound'>): number {
  return check.loopRound ?? 1;
}

/**
 * The check ran and found the work wanting (ADR-0045 L2): the runner reported
 * `failed`, or a script that ran exited non-zero or ran out of time. A check
 * that could not run — `blocked`, a runner that exited without reporting, a
 * script that never started — found nothing for a fix to answer.
 */
function foundWanting(check: LoopSubject): boolean {
  return check.verdict?.outcome === 'fail' && check.verdict.reported === 'failed';
}

/**
 * A check between rounds (ADR-0045 L3): it found the work wanting with rounds
 * left, so its body is fixing what it found and it runs again once the fix
 * has landed. Its stored status stays `failed`; this is what keeps that from
 * counting as a failure.
 */
export function betweenRounds(check: LoopSubject): boolean {
  return !!check.loop && check.status === 'failed' && foundWanting(check) && loopRoundOf(check) < check.loop.maxRounds;
}

/** A check that found the work wanting in its last round: the loop is over, and the check failed. */
export function outOfRounds(check: LoopSubject): boolean {
  return !!check.loop && check.status === 'failed' && foundWanting(check) && loopRoundOf(check) >= check.loop.maxRounds;
}

/**
 * A check whose loop is over: it passed, it was skipped, or it found the work
 * wanting in its last round. Anything else — not run yet, at work, between
 * rounds, or a run that could not check — leaves its rounds to come.
 */
export function loopEnded(check: LoopSubject): boolean {
  return check.status === 'completed' || check.status === 'skipped' || outOfRounds(check);
}

/** The check whose loop has `taskId` in its body, if any. */
export function checkOf<T extends Pick<LoopSubject, 'loop'>>(tasks: readonly T[], taskId: string): T | undefined {
  return tasks.find((t) => t.loop?.body.includes(taskId));
}

/** Whether a task is a loop's check or in a loop's body. */
export function inLoop(tasks: readonly Pick<LoopSubject, 'id' | 'loop'>[], task: Pick<LoopSubject, 'id' | 'loop'>): boolean {
  return !!task.loop || checkOf(tasks, task.id) !== undefined;
}

const SHAPE = 'is not {"body": ["<task id>", ...], "maxRounds"?: <rounds>}';

function roundsMessage(value: unknown): string {
  return `has "maxRounds" ${JSON.stringify(value)}: a loop runs its check from 1 to ${MAX_LOOP_ROUNDS} times, or ${DEFAULT_LOOP_ROUNDS} when it is left out`;
}

function isRoundCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LOOP_ROUNDS;
}

/**
 * A loop as a planner's or a surface's JSON wrote it, read defensively: an
 * absent or `null` loop is none, which is how an edit drops one, and an
 * absent `maxRounds` is {@link DEFAULT_LOOP_ROUNDS}. The body's entries are
 * references as written, for the caller to resolve. `error` completes a
 * sentence that names the task.
 */
export function loopSpec(value: unknown): { loop: TaskLoop | undefined } | { error: string } {
  if (value === undefined || value === null) return { loop: undefined };
  if (typeof value !== 'object' || Array.isArray(value)) return { error: `has a "loop" that ${SHAPE}` };
  const { body, maxRounds } = value as Record<string, unknown>;
  if (!Array.isArray(body) || !body.every((id) => typeof id === 'string' || typeof id === 'number')) return { error: `has a "loop" whose "body" ${SHAPE}` };
  if (body.length === 0) return { error: 'has a "loop" with an empty "body": name the tasks that fix what it finds' };
  if (maxRounds !== undefined && !isRoundCount(maxRounds)) return { error: roundsMessage(maxRounds) };
  return { loop: { body: body.map(String), maxRounds: maxRounds ?? DEFAULT_LOOP_ROUNDS } };
}

/** One rule a plan's loops break, pinned to the task it is about. */
export interface LoopError {
  taskId: string;
  field: 'loop' | 'dependencies';
  message: string;
}

/**
 * The rules a plan's loops are held to (ADR-0045 L1), whoever wrote them.
 * They keep the graph a loop runs on acyclic and its body for its check
 * alone: the check is a top-level AI or script task, the body is top-level
 * AI or script tasks of one loop only, none of them a check, each depending
 * on the check and otherwise only on what the check depends on or on each
 * other, and nothing outside the loop depends on the body. No task in a loop
 * has subtasks, since a round runs each task again whole.
 */
export function loopErrors(tasks: readonly Task[]): LoopError[] {
  const rows = flattenTasksWithParents(tasks);
  const byId = new Map(rows.map((row) => [row.task.id, row]));
  const errors: LoopError[] = [];
  const bodyOwner = new Map<string, Task>();

  for (const { task: check, parent } of rows) {
    const loop = check.loop;
    if (!loop) continue;
    const where = parent ? `subtask "${check.title}" of "${parent.title}"` : `Task "${check.title}"`;
    const fail = (message: string) => errors.push({ taskId: check.id, field: 'loop', message: `${where} ${message}` });
    if (parent) fail('has a "loop", but only a top-level task can be a loop\'s check');
    if (check.type === 'user') fail('is a manual task, so it cannot be a loop\'s check: a check is an AI task, which reports through task_complete, or a script task, whose exit status decides');
    if (check.subtasks?.length) fail('is a loop\'s check, which has no subtasks: each round runs it again whole');
    if (!isRoundCount(loop.maxRounds)) fail(roundsMessage(loop.maxRounds));
    if (!Array.isArray(loop.body) || loop.body.length === 0) fail('has a "loop" with an empty "body": name the tasks that fix what it finds');
    const named = new Set<string>();
    for (const id of loop.body ?? []) {
      const row = byId.get(id);
      if (named.has(id)) { fail(`names "${row?.task.title ?? id}" twice in its loop's "body"`); continue; }
      named.add(id);
      if (!row) { fail(`names "${id}" in its loop's "body", which is no task in the plan`); continue; }
      const body = row.task;
      if (body.id === check.id) { fail('names itself in its loop\'s "body": the body is the tasks that fix what it finds'); continue; }
      if (row.parent) { fail(`names subtask "${body.title}" of "${row.parent.title}" in its loop's "body": only a top-level task can be in a loop's body`); continue; }
      const other = bodyOwner.get(id);
      if (other) { fail(`names "${body.title}" in its loop's "body", which is in the body of "${other.title}"'s loop too: a task belongs to one loop only`); continue; }
      bodyOwner.set(id, check);
      if (body.loop) fail(`names "${body.title}" in its loop's "body", which has a loop of its own: a loop has no loop inside its body`);
      if (body.type === 'user') fail(`names manual task "${body.title}" in its loop's "body": a body is AI or script tasks, which Ordewell runs again each round`);
      if (body.subtasks?.length) fail(`names "${body.title}" in its loop's "body", which has subtasks: each round runs a body task again whole, so make each step a task of the body`);
    }
  }

  for (const [bodyId, check] of bodyOwner) {
    const body = byId.get(bodyId)!.task;
    const where = `Task "${body.title}" is in the body of "${check.title}"'s loop`;
    if (!body.dependencies.includes(check.id)) {
      errors.push({ taskId: body.id, field: 'dependencies', message: `${where}, so it depends on "${check.title}": the check's report is what it fixes. Add "${check.title}" to its dependencies` });
    }
    for (const dep of body.dependencies) {
      if (dep === check.id || check.dependencies.includes(dep) || bodyOwner.get(dep) === check) continue;
      errors.push({ taskId: body.id, field: 'dependencies', message: `${where}, so it depends only on "${check.title}", on what "${check.title}" depends on, or on other tasks of that body; "${byId.get(dep)?.task.title ?? dep}" is none of these` });
    }
  }

  for (const { task } of rows) {
    for (const dep of task.dependencies) {
      const check = bodyOwner.get(dep);
      if (!check || bodyOwner.get(task.id) === check) continue;
      const body = byId.get(dep)!.task;
      const message = task.id === check.id
        ? `Task "${task.title}" depends on "${body.title}" from its own loop's body: the body runs after the check, so the check cannot wait for it`
        : `Task "${task.title}" depends on "${body.title}", which is in the body of "${check.title}"'s loop and runs only if "${check.title}" fails: depend on "${check.title}" instead`;
      errors.push({ taskId: task.id, field: 'dependencies', message });
    }
  }
  return errors;
}

/**
 * Why a task may not be removed while it is a loop's check: its body would
 * be left as tasks that run whatever happens. Removing a body task takes it
 * out of its loop instead (ADR-0045 L8). Null when the removal may go ahead.
 */
export function loopRemovalRefusal(task: Pick<Task, 'title' | 'loop'>): string | null {
  return task.loop ? `"${task.title}" is a loop's check: remove its body tasks first, or drop its loop ("loop": null), so they do not run on their own` : null;
}

/** Why tasks in a loop may not be merged or split: a round runs its check and each body task again as they are (ADR-0045 L8). */
export function loopReshapeRefusal(tasks: readonly Pick<LoopSubject, 'id' | 'loop'>[], target: Pick<Task, 'id' | 'title' | 'loop'>, action: 'merged' | 'split'): string | null {
  if (target.loop) return `"${target.title}" is a loop's check and cannot be ${action}: drop its loop first ("loop": null)`;
  return checkOf(tasks, target.id) ? `"${target.title}" is in a loop's body and cannot be ${action}: take it out of the loop first` : null;
}

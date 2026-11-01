import type { Task } from './Task';
import { GRANTS, type Grant } from '../services/Mandate';
import { flattenTasks } from './Task';
import { taggedReadOnlyMode, type RunnerModeInfo } from '../services/ModeResolver';

/** A delegated task's budget: tokens, and optionally wall-clock time (ADR-0056 M5). */
export interface DelegatedBudget {
  tokens: number;
  wallClockMs?: number;
}

/** What a task declares it works on (ADR-0057 R6). Advisory: nothing gates on it. */
export interface TaskScope {
  paths?: string[];
  provides?: string[];
  consumes?: string[];
}

/** What a delegated task does not have: it holds a goal, not a runner prompt, so it has no mode, skills or steps, and it never runs in the checkout (ADR-0055 D1). */
export const NOT_A_DELEGATED_TASKS_FIELDS = ['prompt', 'taskMode', 'skills', 'userSteps', 'ops', 'commands', 'script', 'timeoutMs', 'research'] as const satisfies readonly (keyof Task)[];

/** The fields only a delegated task has. */
export const DELEGATED_FIELDS = ['goal', 'budget', 'grants', 'protectedPaths', 'scope'] as const satisfies readonly (keyof Task)[];

/** Refused until something asks for it by name: a planner with no node behind it has no mandate to read. */
export const DELEGATION_UNAVAILABLE = 'delegation is not available in this session';

export function notOnADelegatedMessage(fields: readonly string[]): string {
  return `is a delegated task, which holds a goal for a child plan: leave out ${fields.map((f) => `"${f}"`).join(', ')}`;
}

export interface DelegationError {
  taskId: string;
  field: string;
  message: string;
}

export interface DelegationRules {
  /** The modes of each runner, for what makes an AI task read-only (ADR-0031). */
  runnerModes?: Partial<Record<string, readonly RunnerModeInfo[]>>;
  /** Whether a script can run sealed on this host (ADR-0036 S6); unknown reads as yes, since `checkPlanInvariants` is pure. */
  canSeal?: boolean;
}

function isBudget(value: unknown): value is DelegatedBudget {
  if (typeof value !== 'object' || value === null) return false;
  const { tokens } = value as { tokens?: unknown };
  return typeof tokens === 'number' && Number.isInteger(tokens) && tokens > 0;
}

/** A positive whole number of milliseconds, or none at all. */
function wallClockOk(budget: DelegatedBudget): boolean {
  const { wallClockMs } = budget;
  return wallClockMs === undefined || (Number.isInteger(wallClockMs) && wallClockMs > 0);
}

/** Whether `task` is an AI task that runs read-only, as its mode says (ADR-0031). */
function readsOnly(task: Task, runnerModes: DelegationRules['runnerModes']): boolean {
  if (task.type !== 'ai') return false;
  const mode = runnerModes ? taggedReadOnlyMode(runnerModes[task.assignedRunner]) : 'plan';
  return mode !== undefined && task.taskMode === mode;
}

/** Whether a task runs at the workspace root behind a merge gate, so it cannot be cut from the integration tip. */
function atAGate(task: Task): boolean {
  return (task.type === 'script' && !task.readOnly) || task.ops === true;
}

/** Everything `taskId` depends on, directly or through other tasks. */
function reaches(tasks: readonly Task[], from: Task, target: (task: Task) => boolean): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const walk = (task: Task): boolean => task.dependencies.some((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const dep = byId.get(id);
    return dep !== undefined && (target(dep) || walk(dep));
  });
  return walk(from);
}

/**
 * The rules a delegated task is held to on every route (ADR-0055 D1, D7, D8),
 * as `loopErrors` holds a loop: what it must carry, and its check. A check is a
 * task that directly depends on it, a read-only AI task or a script marked
 * `readOnly`, and on a `readOnly` delegated task only the first: it never lands,
 * so a script there would judge the unchanged baseline. Passing proves a list
 * of paths was written, not that it is whole (D7).
 */
export function delegationErrors(tasks: readonly Task[], rules: DelegationRules = {}): DelegationError[] {
  const errors: DelegationError[] = [];
  const delegated = tasks.filter((t) => t.type === 'delegated');
  const fail = (task: Task, field: string, message: string) => errors.push({ taskId: task.id, field, message });

  for (const task of delegated) {
    const where = `Task "${task.title}"`;
    if (typeof task.goal !== 'string' || !task.goal.trim()) fail(task, 'goal', `${where} is a delegated task with no "goal": say what its child plan must achieve`);
    if (!isBudget(task.budget)) fail(task, 'budget', `${where} is a delegated task with no "budget": give it {"tokens": <a whole number>}, and "wallClockMs" if it has a time limit`);
    else if (!wallClockOk(task.budget)) fail(task, 'budget', `${where} has a "wallClockMs" that is not a whole number of milliseconds above 0`);
    const paths = task.protectedPaths;
    if (!task.readOnly && (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p.trim()))) {
      fail(task, 'protectedPaths', `${where} is a delegated task that lands, with no "protectedPaths": name the paths its child may not change, what its check runs and the configuration that runs it`);
    }
    const unknown = (task.grants ?? []).filter((grant) => !GRANTS.includes(grant as Grant));
    if (unknown.length > 0) fail(task, 'grants', `${where} asks in "grants" for ${unknown.map((g) => `"${g}"`).join(', ')}, which no grant is: one of ${GRANTS.join(', ')}`);

    const dependents = tasks.filter((t) => t.dependencies.includes(task.id));
    if (task.readOnly) {
      for (const script of dependents.filter((t) => t.type === 'script')) {
        fail(script, 'dependencies', `Task "${script.title}" depends on "${task.title}", which is a read-only delegated task, which lands nothing, so a script has nothing to run on: make the check a read-only AI task, which reads its handoff`);
      }
    }
    if (!dependents.some((t) => judges(t, task, rules.runnerModes))) {
      fail(task, 'dependencies', `${where} is a delegated task with no check: add a read-only AI task${task.readOnly ? ', which reads its handoff,' : ', or a script task marked "readOnly",'} that depends on it directly`);
    }
  }

  for (const task of tasks.filter((t) => t.type === 'script' && t.readOnly)) {
    if (rules.canSeal === false) fail(task, 'readOnly', `Task "${task.title}" is a read-only script task, and this machine has no sandbox to seal one in: make the check a read-only AI task`);
  }

  // A body at a gate waits for a merge the delegated task's hold keeps back (D9), and the check waits on that body.
  for (const check of tasks.filter((t) => t.loop)) {
    if (!reaches(tasks, check, (t) => t.type === 'delegated')) continue;
    for (const id of check.loop?.body ?? []) {
      const body = tasks.find((t) => t.id === id);
      if (body && atAGate(body)) {
        fail(body, 'loop', `Task "${check.title}" names "${body.title}" in its loop's "body", which waits at a merge gate for work a delegated task's check holds back: make the fix a change task, cut from the integration tip`);
      }
    }
  }
  return errors;
}

/** Whether `task` can judge `delegated`: a read-only AI task, or a read-only script of one that lands (D8). */
function judges(task: Task, delegated: Task, runnerModes: DelegationRules['runnerModes']): boolean {
  return readsOnly(task, runnerModes) || (!delegated.readOnly && task.type === 'script' && task.readOnly === true);
}

/** The checks of a delegated task: what depends on it directly and can judge it (D8). */
export function checksOf(tasks: readonly Task[], delegated: Task, rules: Pick<DelegationRules, 'runnerModes'> = {}): Task[] {
  return tasks.filter((t) => t.dependencies.includes(delegated.id) && judges(t, delegated, rules.runnerModes));
}

/**
 * The checks that hold every merge but the user's (ADR-0055 D9): each of a
 * delegated task with landed work not yet merged that has neither passed nor
 * been skipped. Work that has not landed holds nothing, and a read-only task
 * never lands.
 */
export function checksHoldingMerge(tasks: readonly Task[], awaitsMerge: (taskId: string) => boolean, rules: Pick<DelegationRules, 'runnerModes'> = {}): Task[] {
  return tasks
    .filter((t) => t.type === 'delegated' && awaitsMerge(t.id))
    .flatMap((t) => checksOf(tasks, t, rules))
    .filter((check) => check.status !== 'completed' && check.status !== 'skipped');
}

/** Whether `task` is the check of a delegated task of `tasks`: what a model may not skip past, since that lets the work past its only check (D8). */
export function checksDelegatedTask(tasks: readonly Task[], task: Task, rules: Pick<DelegationRules, 'runnerModes'> = {}): boolean {
  if (!readsOnly(task, rules.runnerModes) && !(task.type === 'script' && task.readOnly)) return false;
  return tasks.some((t) => t.type === 'delegated' && task.dependencies.includes(t.id));
}

/** The tasks a child's plan counts: its whole list, subtasks included. */
export function planSize(tasks: readonly Task[]): number {
  return flattenTasks(tasks).length;
}

/**
 * Whether one path of a repository falls under a protected path: a file it
 * names, a directory it names with or without a trailing slash, or a `*`
 * pattern. Case and separators as git prints them; nothing resolves a link,
 * since a diff lists what the branch changed by name.
 */
export function underProtectedPath(file: string, protectedPath: string): boolean {
  const rule = protectedPath.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (!rule) return false;
  if (rule.includes('*')) return globRegExp(rule).test(file);
  const bare = rule.replace(/\/+$/, '');
  return file === bare || file.startsWith(`${bare}/`);
}

function globRegExp(rule: string): RegExp {
  const pattern = rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*/g, (star) => (star === '*' ? '[^/]*' : '(?:.*/)?'));
  return new RegExp(`^${pattern}(?:/.*)?$`);
}

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

/** How long a scope's item is, and how many of each it holds: each can reach a line Ordewell writes (ADR-0057 R6). */
export const SCOPE_LIMITS = { item: 200, items: 50 } as const;

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

/** Whether nothing here can say what mode `task` runs in: its runner was switched off since, removed, or belongs to another machine. */
function runnerUnread(task: Task, runnerModes: DelegationRules['runnerModes']): boolean {
  return task.type === 'ai' && runnerModes !== undefined && runnerModes[task.assignedRunner] === undefined;
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
    if (task.scope !== undefined && !scopeOk(task.scope)) fail(task, 'scope', `${where} has a "scope" that is not lists of text: "paths", "provides" and "consumes", at most ${SCOPE_LIMITS.items} items of one line and ${SCOPE_LIMITS.item} characters each`);
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

function scopeOk(scope: unknown): boolean {
  if (typeof scope !== 'object' || scope === null) return false;
  const { paths, provides, consumes } = scope as Record<string, unknown>;
  const itemOk = (item: unknown) => typeof item === 'string' && item.trim().length > 0 && item.length <= SCOPE_LIMITS.item && !/[\r\n]/.test(item);
  return [paths, provides, consumes].every((list) => list === undefined || (Array.isArray(list) && list.length <= SCOPE_LIMITS.items && list.every(itemOk)));
}

/** Whether `task` can judge `delegated`: a read-only AI task, or a read-only script of one that lands (D8). */
function judges(task: Task, delegated: Task, runnerModes: DelegationRules['runnerModes']): boolean {
  return readsOnly(task, runnerModes) || (!delegated.readOnly && task.type === 'script' && task.readOnly === true);
}

/**
 * The checks of a delegated task: what depends on it directly and can judge it
 * (D8). One whose runner cannot be read may be its only check, so it counts,
 * and the hold fails closed (D9). Only a plan being written is held to
 * `judges` alone: a task nothing can read is no check to accept one on.
 */
export function checksOf(tasks: readonly Task[], delegated: Task, rules: Pick<DelegationRules, 'runnerModes'> = {}): Task[] {
  return tasks.filter((t) => t.dependencies.includes(delegated.id) && (judges(t, delegated, rules.runnerModes) || runnerUnread(t, rules.runnerModes)));
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

/**
 * What this plan's checks are made of (ADR-0057 R10): the words of whatever
 * depends directly on a delegated task, which is all a pure reader of the plan
 * can tell a check by. A pin may hold none of them whole.
 */
export function checkWords(tasks: readonly Task[]): string[] {
  const delegated = new Set(tasks.filter((t) => t.type === 'delegated').map((t) => t.id));
  return tasks.filter((t) => t.dependencies.some((id) => delegated.has(id))).flatMap((t) => [t.title, t.prompt ?? '', t.script ?? '', ...(t.commands ?? []).map((argv) => argv.join(' '))]);
}

/** Whether `task` is the check of a delegated task of `tasks`: what a model may not skip past, since that lets the work past its only check (D8). */
export function checksDelegatedTask(tasks: readonly Task[], task: Task, rules: Pick<DelegationRules, 'runnerModes'> = {}): boolean {
  if (!readsOnly(task, rules.runnerModes) && !runnerUnread(task, rules.runnerModes) && !(task.type === 'script' && task.readOnly)) return false;
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

/** What comes before a rule's first `*`: all two patterns can be told apart by without matching one against the other. */
function fixedStart(rule: string): string {
  const bare = rule.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  const star = bare.indexOf('*');
  return star === -1 ? bare : bare.slice(0, star);
}

/** Whether two declared paths can name one file. Advisory, so two patterns are read generously: what they start with decides it. */
export function pathsMeet(a: string, b: string): boolean {
  if (underProtectedPath(a.replace(/\/+$/, ''), b) || underProtectedPath(b.replace(/\/+$/, ''), a)) return true;
  if (!a.includes('*') || !b.includes('*')) return false;
  const [one, other] = [fixedStart(a), fixedStart(b)];
  return one.startsWith(other) || other.startsWith(one);
}

/** The narrower of two declared paths that meet: what a planner reads the overlap as. */
function narrower(a: string, b: string): string {
  return b.includes('*') || (!a.includes('*') && a.length >= b.length) ? a : b;
}

/** Whether an edge of the plan puts one of two tasks after the other. */
function ordered(tasks: readonly Task[], a: Task, b: Task): boolean {
  return reaches(tasks, a, (t) => t.id === b.id) || reaches(tasks, b, (t) => t.id === a.id);
}

/**
 * What a plan's scopes leave for its planner to settle (ADR-0057 R6), a
 * sentence each. It refuses nothing, since a scope is advisory: this is the
 * answer the tool gives, and two tasks an edge orders have nothing to settle.
 */
export function scopeOverlaps(tasks: readonly Task[]): string[] {
  const scoped = tasks.filter((t) => t.type === 'delegated' && t.scope);
  const said: string[] = [];
  scoped.forEach((a, i) => {
    for (const b of scoped.slice(i + 1)) {
      if (ordered(tasks, a, b)) continue;
      const declared = (a.scope?.paths ?? []).flatMap((one) => (b.scope?.paths ?? []).filter((other) => pathsMeet(one, other)).map((other) => narrower(one, other)));
      if (declared.length > 0) said.push(`Tasks "${a.title}" and "${b.title}" both declare ${[...new Set(declared)].join(', ')}, and nothing orders them: give one a dependency on the other, or name an owner.`);
      for (const name of a.scope?.provides ?? []) {
        if (b.scope?.provides?.includes(name)) said.push(`Tasks "${a.title}" and "${b.title}" both provide "${name}", and nothing orders them: name one owner.`);
      }
      for (const [producer, consumer] of [[a, b], [b, a]] as const) {
        for (const name of producer.scope?.provides ?? []) {
          if (consumer.scope?.consumes?.includes(name)) said.push(`Task "${consumer.title}" consumes "${name}", which "${producer.title}" provides, and nothing orders them: a dependency puts the producer first; without one it gets a line when "${producer.title}" lands.`);
        }
      }
    }
  });
  return said;
}

function globRegExp(rule: string): RegExp {
  const pattern = rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*/g, (star) => (star === '*' ? '[^/]*' : '(?:.*/)?'));
  return new RegExp(`^${pattern}(?:/.*)?$`);
}

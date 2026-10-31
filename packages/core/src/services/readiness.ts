import { runsAsOps, type Task } from '../models/Task';
import type { PlanStore } from './PlanStore';
import type { IsolationRunController } from './IsolationRunController';
import { classifyAttempt, mergeExcludes } from './attemptKind';
import { planBlocks } from './blocking';
import { scriptBodyOf } from '../models/ScriptTask';
import { betweenRounds, checkOf, loopRoundOf } from '../models/Loop';

/**
 * Why a task cannot start now: the one start rule (ADR-0034), which the
 * scheduler, the explicit starts, the command seam's refusals, the task row's
 * merge gate and the planner's notes all read. {@link startWaits} lists every
 * one that holds, in this order, so the first is the reason a task waits.
 */
export type StartWait =
  /** Under way, waiting on the user, or ended: only a retry, a continue or a resume starts it again. */
  | { kind: 'started' }
  /**
   * A loop's check between rounds (ADR-0045 L3): it runs again, as round
   * `round` of `maxRounds`, once its body has passed and landed; `waiting` is
   * the body that has not yet. Whether anything will run it then is no part
   * of the rule: a Stop or a reload leaves that to a start of it (L5).
   */
  | { kind: 'repeating'; round: number; maxRounds: number; waiting: string[] }
  /** Mark complete is landing its work. */
  | { kind: 'completing' }
  /** A task added to resolve its conflict has it: a conflict has one worker (ADR-0015). */
  | { kind: 'resolver'; resolver: string }
  /** An AI task with no prompt yet, or a script task with no body to run: there is nothing to run. */
  | { kind: 'no-prompt' }
  /** Outside the user's approval record (ADR-0035). */
  | { kind: 'unapproved' }
  /** Pulled out of the scheduler: cancelled, marked not done, or a start that could not reach its runner. */
  | { kind: 'on-hold'; reason?: string }
  /** The failed tasks it waits on through its dependencies (ADR-0034). */
  | { kind: 'blocked'; failed: string[] }
  /** In a loop's body, whose check has not found the work wanting this round: it runs only if `check` fails (ADR-0045 L4). */
  | { kind: 'loop-check'; check: string }
  /** What its dependencies still hold it back for (see {@link unmetDependencies}). */
  | { kind: 'dependencies'; waiting: string[] }
  /** A force start queued behind the dependencies still under way or yet to run, which starts once they finish. */
  | { kind: 'queued'; waiting: string[] }
  /** An ops task, a script task among them, and a Merge all is under way (ADR-0020). */
  | { kind: 'merging' }
  /** Its runner hit its usage limit: nothing more starts on that runner until the reset. */
  | { kind: 'usage-limit'; runner: string }
  /** A planner turn holds new starts until its reply ends (ADR-0029). */
  | { kind: 'start-hold' }
  /** Its merge gate (ADR-0020): the ancestors whose landed work is not in the user's branch yet. */
  | { kind: 'merge-gate'; unmerged: string[] }
  /** A user task: the user does it by hand, and nothing starts it. */
  | { kind: 'by-hand' };

export type StartWaitKind = StartWait['kind'];

/**
 * A start the user forced, which goes past what the scheduler waits for: a
 * hold, a failed dependency (ADR-0034), its runner's usage limit, and the
 * merge gate they confirmed (ADR-0020). Made now, it is the user's own act
 * and goes past the whole gate and a planner turn's start hold. Queued behind
 * its dependencies, it starts later with nobody asking, so it waits for a
 * start hold as the scheduler's starts do, and goes past only the gate it was
 * confirmed past: `pastGate`. `asScheduled` is one the start rule has already
 * passed whole, carried back to the queue if it has to wait again.
 */
export type ForcedStart = { queued: false } | { queued: true; pastGate: readonly string[]; asScheduled?: true };

/** What the start rule reads: the plan, the holds, and the open isolated run. */
export interface StartRuleInput {
  store: Pick<PlanStore, 'allTasks' | 'get' | 'isCompleted' | 'isSkipped' | 'isOps' | 'resolveTaskRunner'>;
  /** Task ids pulled out of the scheduler (cancelled, marked not done, or a start that could not reach its runner), with why when the caller has it. */
  onHold: Pick<ReadonlySet<string>, 'has'> & Partial<Pick<ReadonlyMap<string, string>, 'get'>>;
  /** The user's approval record (ADR-0035). */
  approved: (taskId: string) => boolean;
  /**
   * The open isolated run's records — `openRecord` answers undefined for a
   * shared-root run — and which landed work still waits to be merged into
   * the user's branch.
   */
  runs: Pick<IsolationRunController, 'openRecord' | 'awaitsMerge'>;
  /** A Merge all is under way, so no work it excludes may start (ADR-0020). */
  merging: boolean;
  /** A planner turn holds new starts (ADR-0029). */
  startsHeld: boolean;
  /** Tasks Mark complete is landing. */
  completing: Pick<ReadonlySet<string>, 'has'>;
  /** Force starts queued behind their dependencies. */
  queued: Pick<ReadonlySet<string>, 'has'>;
  /** The task out to resolve this task's conflict, if one is; none when the caller knows of no conflicts. */
  conflictResolver?: (taskId: string) => string | undefined;
}

/** What the scheduler picks from: the start rule's input, and the slots. */
export interface ReadinessInput extends StartRuleInput {
  /** Attempts already holding a slot. */
  active: number;
  maxParallel: number;
  /** The tasks to pick from; the whole plan unless set. */
  within?: ReadonlySet<string>;
}

/** One AI or script task the start rule held back, with why, for the scheduler's log. */
export interface ReadyTaskExclusion {
  task: Readonly<Task>;
  waits: StartWait[];
}

export interface Readiness {
  /** The tasks to start, lowest order first, capped at the free slots. */
  ready: Task[];
  /** How many tasks nothing holds back, before the slot cap. */
  candidateCount: number;
  /** AI tasks with a prompt, and script tasks, the start rule held back, with why. */
  excluded: ReadyTaskExclusion[];
  /** Tasks held back by nothing but their merge gate ({@link onlyAtGate}), in plan order. */
  gated: Task[];
}

/**
 * Every reason `task` cannot start now, in {@link StartWait}'s order; none
 * when it can. `forced` judges a start the user forced rather than the
 * scheduler's own. A slot is not part of it: the claim takes one.
 */
export function startWaits(task: Readonly<Task>, input: StartRuleInput, forced?: ForcedStart): StartWait[] {
  return waitsOf(task, input, forced, judgeOnce(input.store));
}

/** Every task's {@link startWaits}, the plan judged once however many tasks it holds. */
export function planStartWaits(input: StartRuleInput): Map<string, StartWait[]> {
  const plan = judgeOnce(input.store);
  return new Map(input.store.allTasks.map((task) => [task.id, waitsOf(task, input, undefined, plan)]));
}

/**
 * The scheduler's pick: what nothing holds back, lowest order first, no more
 * than the free slots of `maxParallel` with `active` taken.
 */
export function selectReadyTasks(input: ReadinessInput): Readiness {
  const plan = judgeOnce(input.store);
  const judged = input.store.allTasks
    .filter((task) => !input.within || input.within.has(task.id))
    .map((task) => ({ task, waits: waitsOf(task, input, undefined, plan) }));
  const candidates = judged.filter(({ waits }) => waits.length === 0).map(({ task }) => task).sort((a, b) => a.order - b.order);
  return {
    ready: candidates.slice(0, Math.max(0, input.maxParallel - input.active)),
    candidateCount: candidates.length,
    excluded: judged.filter(({ task, waits }) => (task.type === 'script' || (task.type === 'ai' && task.prompt)) && waits.length > 0),
    gated: judged.filter(({ waits }) => onlyAtGate(waits)).map(({ task }) => task),
  };
}

/**
 * Held back by nothing but its merge gate, besides the user's own hand: what
 * a Merge all lets start, and what merging at gates automatically merges for.
 */
function onlyAtGate(waits: readonly StartWait[]): boolean {
  return waits.some((w) => w.kind === 'merge-gate') && waits.every((w) => w.kind === 'merge-gate' || w.kind === 'by-hand');
}

/** The wait of `kind` among `waits`, if it holds. */
export function waitOf<K extends StartWaitKind>(waits: readonly StartWait[], kind: K): Extract<StartWait, { kind: K }> | undefined {
  return waits.find((w): w is Extract<StartWait, { kind: K }> => w.kind === kind);
}

/** What one judgement of the whole plan reads, worked out once however many tasks it judges. */
interface PlanJudgement {
  blocked(): ReadonlyMap<string, string[]>;
  /** The loops' checks between rounds whose loop goes on (ADR-0045 L3). */
  repeating(): ReadonlySet<string>;
  /** The runners a task waits on the usage limit of. */
  limited(): ReadonlySet<string>;
}

function judgeOnce(store: StartRuleInput['store']): PlanJudgement {
  let blocks: ReturnType<typeof planBlocks> | undefined;
  let limited: ReadonlySet<string> | undefined;
  const judged = () => (blocks ??= planBlocks(store.allTasks));
  return {
    blocked: () => judged().blocked,
    repeating: () => judged().repeating,
    limited: () => (limited ??= new Set(store.allTasks
      .filter((t) => t.status === 'awaiting_user' && t.awaitingReason === 'usage-limit')
      .map((t) => store.resolveTaskRunner(t)))),
  };
}

function waitsOf(task: Readonly<Task>, input: StartRuleInput, forced: ForcedStart | undefined, plan: PlanJudgement): StartWait[] {
  const { store, runs } = input;
  const byHand = task.type === 'user';
  const queued = input.queued.has(task.id);
  const waits: StartWait[] = [];
  if (task.status !== 'pending' && task.status !== 'approved') {
    // Its loop starts its check again, or a start of it does the same (ADR-0045 L5).
    if (task.loop && plan.repeating().has(task.id)) {
      const waiting = task.loop.body.filter((id) => !landed(id, store, runs));
      waits.push({ kind: 'repeating', round: loopRoundOf(task) + 1, maxRounds: task.loop.maxRounds, waiting });
    } else waits.push({ kind: 'started' });
  }
  if (input.completing.has(task.id)) waits.push({ kind: 'completing' });
  const resolver = input.conflictResolver?.(task.id);
  if (resolver) waits.push({ kind: 'resolver', resolver });
  if (task.type === 'ai' ? !task.prompt : task.type === 'script' && !scriptBodyOf(task)) waits.push({ kind: 'no-prompt' });
  if (!input.approved(task.id)) waits.push({ kind: 'unapproved' });
  if (!forced && input.onHold.has(task.id)) {
    const reason = input.onHold.get?.(task.id);
    waits.push({ kind: 'on-hold', ...(reason ? { reason } : {}) });
  }
  const failed = forced ? [] : plan.blocked().get(task.id) ?? [];
  if (failed.length > 0) waits.push({ kind: 'blocked', failed });
  // A body runs only for its check: until the check fails this round, that is
  // what it waits for, not a dependency to finish. A force start still queues
  // behind the check, as behind any dependency under way.
  const check = forced || queued ? undefined : checkOf(store.allTasks, task.id);
  const forCheck = !!check && UNDECIDED.has(check.status);
  if (forCheck) waits.push({ kind: 'loop-check', check: check.id });
  // A forced start goes past a failure, so only what is still under way holds it.
  const deps = (forced || queued ? underWay(task, store, runs, plan) : unmetDependencies(task, store, runs)).filter((id) => !forCheck || id !== check.id);
  const waiting = [...deps, ...bodyAtWork(task, store, runs)];
  if (waiting.length > 0) waits.push(queued ? { kind: 'queued', waiting } : { kind: 'dependencies', waiting });
  if (input.merging && mergeExcludes(classifyAttempt(opsOf(task, store) ? 'ops' : 'change'))) waits.push({ kind: 'merging' });
  // A script task runs on no runner, so no runner's limit holds it (ADR-0035).
  if (!forced && task.type === 'ai') {
    const runner = store.resolveTaskRunner(task);
    if (plan.limited().has(runner)) waits.push({ kind: 'usage-limit', runner });
  }
  if (input.startsHeld && !byHand && forced?.queued !== false) waits.push({ kind: 'start-hold' });
  // A start forced now passes the whole gate, which the user confirmed; a queued one only what they confirmed then.
  const confirmed = forced?.queued ? forced.pastGate : [];
  const unmerged = forced?.queued === false ? [] : mergeGate(task, store, runs).filter((id) => !confirmed.includes(id));
  if (unmerged.length > 0) waits.push({ kind: 'merge-gate', unmerged });
  if (byHand) waits.push({ kind: 'by-hand' });
  return waits;
}

/**
 * A check's body still at work, or passed and not landed yet: a check started
 * again mid-round — a retry, a force start — waits for it, so that it checks
 * that fix rather than racing it and passing with the fix landing after it
 * unchecked (ADR-0045 L5, L7). The loop's own next round waits for its whole
 * body to land already, so this holds only a start of the check from outside.
 */
function bodyAtWork(task: Readonly<Task>, store: Pick<PlanStore, 'get' | 'isCompleted'>, runs: Pick<IsolationRunController, 'openRecord'>): string[] {
  return (task.loop?.body ?? []).filter((id) => {
    const status = store.get(id)?.status;
    return status === 'in_progress' || status === 'awaiting_user' || (status === 'completed' && !landed(id, store, runs));
  });
}

/** A check's statuses before it has found anything this round: not run yet, under way, or waiting on the user. */
const UNDECIDED: ReadonlySet<string> = new Set(['pending', 'approved', 'in_progress', 'awaiting_user']);

/** What the dependency rule reads of the plan. */
type DependencyStore = Pick<PlanStore, 'allTasks' | 'get' | 'isCompleted' | 'isSkipped'>;

/**
 * A task's dependencies the dependency rule holds it to. A body task's
 * dependency on its own check between rounds is met: the check's report is
 * what it fixes, and the check runs again only after it (ADR-0045 L4).
 */
function heldTo(task: Readonly<Pick<Task, 'dependencies'> & Partial<Pick<Task, 'id'>>>, store: Pick<PlanStore, 'get'>): readonly string[] {
  return task.dependencies.filter((id) => {
    const dep = store.get(id);
    return !(dep && task.id !== undefined && betweenRounds(dep) && dep.loop?.body.includes(task.id));
  });
}

/**
 * The tasks a task's dependencies still hold it back for, nearest first and
 * each named once: a dependency not met yet, or, through a skipped one, the
 * nearest unmet tasks behind it. In an isolated run a dependency is met once
 * its work is on the integration branch, not merely once it passed: the
 * dependent's worktree is cut from that branch, so starting earlier would
 * hand it a tree without the work it depends on. A skipped dependency lands
 * nothing of its own, but the work it waited on is still what the dependent
 * builds on. Behind a skip, a failed or blocked task holds nothing back:
 * skipping is how the user releases the dependents of work that cannot
 * finish (ADR-0034), so only work still under way or yet to run is waited for.
 */
export function unmetDependencies(
  task: Readonly<Pick<Task, 'dependencies'> & Partial<Pick<Task, 'id'>>>,
  store: DependencyStore,
  runs: Pick<IsolationRunController, 'openRecord'>,
): string[] {
  return waitingBehind(heldTo(task, store), store, runs, { pastFailures: false });
}

/**
 * A task's unmet dependencies, less the failed or blocked ones a forced start
 * goes past. A blocked one is gone past for its failure only: the work under
 * way or yet to run that it waits on is still waited for, through it.
 */
function underWay(task: Readonly<Task>, store: DependencyStore, runs: Pick<IsolationRunController, 'openRecord'>, plan: PlanJudgement): string[] {
  return waitingBehind(heldTo(task, store), store, runs, { pastFailures: true, plan: () => ({ blocked: plan.blocked(), repeating: plan.repeating() }) });
}

/** The blocked rule's reading of the plan a dependency walk needs. */
type JudgedBlocks = { blocked: ReadonlyMap<string, string[]>; repeating: ReadonlySet<string> };

/**
 * Breadth first, so a task that is also a direct dependency is judged as one.
 * A skipped task is walked through to what it waited on, behind which a
 * failed or blocked task is a dead end. `pastFailures` makes a failed task a
 * dead end anywhere, and walks through a blocked one to what it waits on. A
 * loop's check between rounds whose loop goes on is no failure: it is work
 * under way (ADR-0045 L3).
 */
function waitingBehind(
  depIds: readonly string[],
  store: DependencyStore,
  runs: Pick<IsolationRunController, 'openRecord'>,
  opts: { pastFailures: boolean; plan?: () => JudgedBlocks },
): string[] {
  const seen = new Set<string>();
  const waiting: string[] = [];
  // Only a walk through a skip or past a failure needs it, and most never take one.
  let blocks: JudgedBlocks | undefined;
  const judged = () => (blocks ??= opts.plan?.() ?? planBlocks(store.allTasks));
  const isBlocked = (id: string): boolean => judged().blocked.has(id);
  const dependenciesOf = (id: string, behindSkip: boolean) => (store.get(id)?.dependencies ?? []).map((dep) => ({ id: dep, behindSkip }));
  const queue = depIds.map((id) => ({ id, behindSkip: false }));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { id, behindSkip } = next;
    if (seen.has(id)) continue;
    seen.add(id);
    if (landed(id, store, runs)) continue;
    if (store.isSkipped(id)) {
      queue.push(...dependenciesOf(id, true));
      continue;
    }
    const failed = store.get(id)?.status === 'failed' && !judged().repeating.has(id);
    if (!behindSkip && !opts.pastFailures) waiting.push(id);
    else if (!failed && !isBlocked(id)) waiting.push(id);
    else if (opts.pastFailures && !behindSkip && !failed) queue.push(...dependenciesOf(id, false));
  }
  return waiting;
}

/** Completed, and in an isolated run merged into the integration branch. */
export function landed(id: string, store: Pick<PlanStore, 'isCompleted'>, runs: Pick<IsolationRunController, 'openRecord'>): boolean {
  if (!store.isCompleted(id)) return false;
  const record = runs.openRecord(id);
  return !record || record.status === 'merged';
}

/**
 * The merge gate (ADR-0020): the completed ancestors of a task that runs
 * outside a worktree — an ops task, a script task among them (ADR-0035), or a
 * user task — whose landed work is not
 * in the user's branch yet. What it acts on, or what the user checks by hand,
 * is their checkout, which does not hold that work until it is merged. Every
 * ancestor counts, not only the direct dependencies: a dependency on a
 * verification that landed nothing still means the work it verified. Empty
 * for a change task, and for any task of a run that never isolated. Judged
 * whatever the task's status: a retry of a failed ops task acts on the
 * checkout as a first start does. A loop's check counts its body as what it
 * acts on too: it runs again to check their work (ADR-0045 L9).
 */
export function mergeGate(
  task: Readonly<Task>,
  store: Pick<PlanStore, 'get' | 'isCompleted' | 'isOps'>,
  runs: Pick<IsolationRunController, 'awaitsMerge'>,
): string[] {
  if (task.type !== 'user' && !opsOf(task, store)) return [];
  return ancestors(task, store).filter((id) => store.isCompleted(id) && runs.awaitsMerge(id));
}

/**
 * Whether a task runs as an ops task. One the plan does not hold yet — a held
 * edit adds it, or `run_script` is about to (ADR-0035) — has no root in the
 * store to ask, so it is judged by its own type and flag, as a top-level task.
 */
function opsOf(task: Readonly<Task>, store: Pick<PlanStore, 'get' | 'isOps'>): boolean {
  return store.get(task.id) ? store.isOps(task.id) : runsAsOps(task);
}

/** Every task a task depends on, directly or through others, nearest first, and a check's body; a cycle is walked once. */
function ancestors(task: Readonly<Task>, store: Pick<PlanStore, 'get'>): string[] {
  const seen = new Set<string>([task.id]);
  const queue = [...task.dependencies, ...task.loop?.body ?? []];
  const found: string[] = [];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    found.push(id);
    queue.push(...(store.get(id)?.dependencies ?? []));
  }
  return found;
}

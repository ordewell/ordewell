import type { Task, TaskSkillSnapshot } from '../models/Task';
import type { IsolationRunController } from './IsolationRunController';
import type { RepairAttempt } from './Landing';
import { composeAugmentedPrompt, composeContinuationPrompt } from './promptAugment';

/** A continue the user asked for: their message, and the runner session it resumes (ADR-0018, K1). */
export interface Continuation {
  message: string;
  resumeSessionId: string;
}

/**
 * What one attempt of a task is. Everything that differs between attempts —
 * where it runs, what it is told, whether its tree is checked, whether it
 * keeps Merge all out — is read from this, never from loose flags.
 *
 * - `change`: a change task's attempt, in its worktree when the run isolates.
 * - `ops`: an ops task's attempt, from the workspace root (ADR-0020).
 * - `repair`: a conflict repair, in the worktree kept for it (ADR-0015).
 * - `continuation`: the task's saved runner session resumed with the user's
 *   message (ADR-0018), running where the task it continues runs.
 */
export type AttemptKind =
  | { readonly kind: 'change' }
  | { readonly kind: 'ops' }
  | { readonly kind: 'repair'; readonly repair: RepairAttempt }
  | ({ readonly kind: 'continuation'; readonly ops: boolean } & Readonly<Continuation>);

/**
 * The kind of an attempt about to start, from whether its task is ops and
 * what it is owed. Without a repair or a continue it is the kind of a fresh
 * attempt — what the scheduler reasons about before any attempt exists. A
 * repair outranks the ops mark: its work already sits in a kept worktree,
 * waiting to land.
 */
export function classifyAttempt(
  ops: boolean,
  owed: { repair?: RepairAttempt | null; continuation?: Continuation | null } = {},
): AttemptKind {
  if (owed.continuation) return { kind: 'continuation', ops, ...owed.continuation };
  if (owed.repair) return { kind: 'repair', repair: owed.repair };
  return ops ? { kind: 'ops' } : { kind: 'change' };
}

/** An ops task's attempt, fresh or continued, acts from the user's checkout (ADR-0020). */
function inCheckout(kind: AttemptKind): boolean {
  return kind.kind === 'ops' || (kind.kind === 'continuation' && kind.ops);
}

/**
 * Merge all and ops work never overlap (ADR-0020): the merge rewrites the
 * checkout an ops attempt acts from, and it is the one collision the planner
 * cannot order, because the merge is the user's. Both sides read this: an
 * attempt it holds does not start while a merge is under way, and a merge
 * does not start while one runs.
 */
export function mergeExcludes(kind: AttemptKind): boolean {
  return inCheckout(kind);
}

/**
 * Whether starting the attempt makes the run decide whether it isolates
 * (ADR-0020). Work in the checkout needs no worktree, so a run of only ops
 * tasks never asks and is never blocked by a dirty tree.
 */
export function decidesIsolation(kind: AttemptKind): boolean {
  return !inCheckout(kind);
}

/**
 * Whether the attempt is given its task's skills: a fresh attempt is. A
 * repair resolves a merge, not the task's work; a continue resumes a session
 * that already holds them.
 */
export function takesSkills(kind: AttemptKind): boolean {
  return kind.kind === 'change' || kind.kind === 'ops';
}

/**
 * Whether the workspace's tracked files are compared from the attempt's start
 * to its end (ADR-0020). A runner in the checkout cannot be stopped from
 * writing, only caught.
 */
export function checksTree(kind: AttemptKind): boolean {
  return inCheckout(kind);
}

/**
 * Where an attempt runs: the workspace root for work in the checkout, the
 * worktree kept for a repair, else wherever the run puts a change. Returns
 * the controller's own promise, so deciding adds no turn of its own before
 * the spawn checks its attempt is still current.
 */
export function attemptCwd(
  kind: AttemptKind,
  task: Task,
  runs: Pick<IsolationRunController, 'attemptCwd' | 'workspaceCwd'>,
): Promise<{ cwd: string; worktree: boolean }> {
  if (inCheckout(kind)) return runs.workspaceCwd(task);
  return runs.attemptCwd(task, { repair: kind.kind === 'repair' });
}

/** What an attempt's prompt is built from. The callbacks are read only for the kinds that need them. */
export interface AttemptPromptSources {
  task: Task;
  plan: readonly Task[];
  completionTool: boolean;
  planMapEnabled?: boolean;
  /** The task's skills, resolved where the attempt runs; a repair and a continue are given none. */
  skills: readonly TaskSkillSnapshot[];
  /** What a repair is asked to do; read once its worktree has been reopened. */
  repairPrompt: (task: Task) => string;
  /** What an ops task's last attempt did. */
  previousAttempt: (taskId: string) => string | undefined;
}

/**
 * The prompt an attempt is spawned with. Every kind goes through the same
 * augmenting, so the marker is the task's own and the verdict is watched for
 * unchanged.
 */
export function attemptPrompt(kind: AttemptKind, src: AttemptPromptSources): string {
  const { task, plan, completionTool, planMapEnabled } = src;
  switch (kind.kind) {
    case 'continuation':
      return composeContinuationPrompt(task, kind.message, { ops: kind.ops, completionTool });
    case 'repair':
      // A merge to resolve is not the task's own work, so its skills do not apply.
      return composeAugmentedPrompt({ ...task, prompt: src.repairPrompt(task) }, plan, { planMapEnabled, completionTool });
    case 'ops':
      // Its effects outlive a failed attempt and are never rolled back, so
      // the next one is told what the last one did.
      return composeAugmentedPrompt(task, plan, { planMapEnabled, skills: src.skills, previousAttempt: src.previousAttempt(task.id), completionTool });
    case 'change':
      return composeAugmentedPrompt(task, plan, { planMapEnabled, skills: src.skills, completionTool });
  }
}

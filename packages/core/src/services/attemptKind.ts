import type { PreviousWork } from '../interfaces/IWorktreeIsolation';
import type { RunnerId, Task, TaskSkillSnapshot } from '../models/Task';
import type { StoredHandoff } from '../models/Handoff';
import { betweenRounds, loopRoundOf } from '../models/Loop';
import type { LeaseWorkspace } from './executionLease';
import type { RepairAttempt } from './Landing';
import { composeAugmentedPrompt, composeContinuationPrompt, continuedWorkNote, READ_ONLY_CONTINUED_NOTE } from './promptAugment';

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
 * - `readOnly`: a read-only task's attempt (ADR-0046), in a worktree of its
 *   own when the run isolates, which is thrown away whatever it changed:
 *   it lands nothing, and its report is all that comes back.
 * - `ops`: an ops task's attempt, from the workspace root (ADR-0020). A
 *   script task's attempt is one too (ADR-0035), though it is told nothing:
 *   it runs its body, with no runner or prompt.
 * - `repair`: a conflict repair, in the worktree kept for it (ADR-0015).
 * - `continuation`: the task's saved runner session resumed with the user's
 *   message (ADR-0018), running where the task it continues runs; `work`
 *   is what the task is.
 * - `carryOver`: a change task paused on `from`'s usage limit and moved to
 *   another runner (ADR-0018, U1). A fresh session — none can cross runners —
 *   in a worktree that starts from the paused attempt's work.
 * - `delegated`: a delegated task's attempt, a child plan in its worktree
 *   (ADR-0055 D3). `readOnly` lands nothing, and its worktree goes as a
 *   read-only task's does.
 */
export type AttemptKind =
  | { readonly kind: 'change' }
  | { readonly kind: 'readOnly' }
  | { readonly kind: 'ops' }
  | { readonly kind: 'repair'; readonly repair: RepairAttempt }
  | ({ readonly kind: 'continuation'; readonly work: TaskWork } & Readonly<Continuation>)
  | { readonly kind: 'carryOver'; readonly from: RunnerId }
  | { readonly kind: 'delegated'; readonly readOnly: boolean };

/**
 * What a task's work is, whichever attempt does it: a change that lands, an
 * ops task's effects from the checkout (ADR-0020), or a read-only task's,
 * which lands nothing (ADR-0046), or a child plan's (ADR-0055), which lands
 * unless it is read-only.
 */
export type TaskWork = 'change' | 'ops' | 'readOnly' | 'delegated' | 'delegatedReadOnly';

/**
 * The kind of an attempt about to start, from what its task's work is and
 * what it is owed. Without a repair, a continue or a carry-over it is the
 * kind of a fresh attempt. A repair outranks the ops mark: its work already
 * sits in a kept worktree, waiting to land. An ops task carries nothing over,
 * as its work is never in a worktree, and neither does a read-only task,
 * whose worktree was thrown away.
 */
export function classifyAttempt(
  work: TaskWork,
  owed: { repair?: RepairAttempt | null; continuation?: Continuation | null; carriedFrom?: RunnerId | null } = {},
): AttemptKind {
  if (owed.continuation) return { kind: 'continuation', work, ...owed.continuation };
  if (owed.repair) return { kind: 'repair', repair: owed.repair };
  if (work === 'delegated' || work === 'delegatedReadOnly') return { kind: 'delegated', readOnly: work === 'delegatedReadOnly' };
  if (work !== 'change') return { kind: work };
  return owed.carriedFrom ? { kind: 'carryOver', from: owed.carriedFrom } : { kind: 'change' };
}

/** An ops task's attempt, fresh or continued, acts from the user's checkout (ADR-0020). */
function inCheckout(kind: AttemptKind): boolean {
  return kind.kind === 'ops' || (kind.kind === 'continuation' && kind.work === 'ops');
}

/**
 * Whether the attempt lands nothing (ADR-0046): a read-only task's, fresh or
 * continued. Its worktree goes whatever it changed, and its report is its result.
 */
export function landsNothing(kind: AttemptKind): boolean {
  if (kind.kind === 'delegated') return kind.readOnly;
  return kind.kind === 'readOnly' || (kind.kind === 'continuation' && (kind.work === 'readOnly' || kind.work === 'delegatedReadOnly'));
}

/**
 * Whether the attempt's runner is told to write the commit message its work
 * lands with (ADR-0047): a change task's, fresh, continued or carried over.
 * Ops and read-only work commits nothing, and a repair resolves a merge.
 */
export function writesCommit(kind: AttemptKind): boolean {
  if (kind.kind === 'delegated') return !kind.readOnly;
  return kind.kind === 'change' || kind.kind === 'carryOver' || (kind.kind === 'continuation' && (kind.work === 'change' || kind.work === 'delegated'));
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
 * Whether the attempt is given its task's skills: one in a fresh session is.
 * A repair resolves a merge, not the task's work; a continue resumes a
 * session that already holds them.
 */
export function takesSkills(kind: AttemptKind): boolean {
  return kind.kind === 'change' || kind.kind === 'readOnly' || kind.kind === 'ops' || kind.kind === 'carryOver';
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
 * worktree kept for a repair, a fresh throwaway one for work that lands
 * nothing, else wherever the run puts a change, restoring the previous
 * attempt's work for a continue and a carry-over. What a lease opens
 * (ADR-0059): the kind is resolved here, before a backend sees it.
 */
export function attemptWorkspace(kind: AttemptKind): LeaseWorkspace {
  if (inCheckout(kind)) return { kind: 'checkout' };
  if (kind.kind === 'repair') return { kind: 'worktree', intent: 'repair' };
  if (landsNothing(kind)) return { kind: 'worktree', intent: 'readOnly' };
  return { kind: 'worktree', intent: kind.kind === 'continuation' || kind.kind === 'carryOver' ? 'restore' : 'fresh' };
}

/** What an attempt's prompt is built from. The callbacks are read only for the kinds that need them. */
export interface AttemptPromptSources {
  task: Task;
  plan: readonly Task[];
  planMapEnabled?: boolean;
  /** What became of the previous attempt's work where this one runs; absent in the checkout. */
  previousWork?: PreviousWork;
  /** The task's skills, resolved where the attempt runs; a repair and a continue are given none. */
  skills: readonly TaskSkillSnapshot[];
  /** What a repair is asked to do; read once its worktree has been reopened. */
  repairPrompt: (task: Task) => string;
  /** What an ops task's last attempt did. */
  previousAttempt: (taskId: string) => string | undefined;
  /** The last attempt's authored handoff, read before this attempt opens its log. */
  previousHandoff: (taskId: string) => StoredHandoff | undefined;
  /** The legacy report captured while the check was between rounds, before repeat cleared it. */
  previousRound?: { round: number; report?: string };
}

/**
 * The prompt an attempt is spawned with. Every kind goes through the same
 * augmenting; how it ends, through `task_complete`, is the runner's
 * instructions (`TASK_COMPLETION_CONTRACT`) for every kind alike, so the
 * verdict is watched for unchanged.
 */
export function attemptPrompt(kind: AttemptKind, src: AttemptPromptSources): string {
  const { task, plan, planMapEnabled } = src;
  // At spawn the check is already in progress: repeat counted the round on
  // after betweenRounds held, and cleared the previous verdict and report.
  const between = betweenRounds(task);
  const round = loopRoundOf(task) + (between ? 1 : 0);
  const loop = task.type === 'ai' && task.loop && round > 1 && takesSkills(kind)
    ? {
      round,
      previousHandoff: src.previousHandoff(task.id),
      previousReport: between ? task.outputSummary?.report : src.previousRound?.round === round - 1 ? src.previousRound.report : undefined,
    }
    : undefined;
  switch (kind.kind) {
    case 'continuation': {
      const where = kind.work === 'readOnly' ? READ_ONLY_CONTINUED_NOTE : continuedWorkNote(src.previousWork);
      return composeContinuationPrompt(task, `${kind.message}\n\n${where}`, { ops: kind.work === 'ops' });
    }
    case 'repair':
      // A merge to resolve is not the task's own work, so its skills do not apply.
      return composeAugmentedPrompt({ ...task, prompt: src.repairPrompt(task) }, plan, { planMapEnabled });
    case 'ops':
      // Its effects outlive a failed attempt and are never rolled back, so
      // the next one is told what the last one did.
      return composeAugmentedPrompt(task, plan, { planMapEnabled, skills: src.skills, previousAttempt: src.previousAttempt(task.id), loop });
    case 'change':
      return composeAugmentedPrompt(task, plan, { planMapEnabled, skills: src.skills, loop });
    case 'readOnly':
      return composeAugmentedPrompt(task, plan, { planMapEnabled, skills: src.skills, loop, readOnly: true });
    case 'carryOver':
      return composeAugmentedPrompt(task, plan, { planMapEnabled, skills: src.skills, carriedOver: { from: kind.from, work: src.previousWork }, loop });
    case 'delegated':
      // A subplanner reads its goal, not a runner's brief.
      return task.goal ?? '';
  }
}

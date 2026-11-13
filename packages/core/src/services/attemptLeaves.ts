import type { AttemptKind } from './attemptKind';

/**
 * What ended an attempt, as far as what it leaves behind goes. Not the
 * attempt's own end reason (`AttemptEnd`): a verdict that failed and one whose
 * settling threw leave differently, and a delete leaves as a cancel does but
 * for its worktree.
 *
 * - `stopped`: the run's Stop. `loaded`: the plan was replaced under it.
 * - `cancelled`: the task's Stop. `released`: the task left the plan.
 * - `failed`: a failed verdict. `unsettled`: settling its verdict threw.
 * - `usage-limit`: its runner's limit paused it (ADR-0018, U1).
 * - `skipped`, `retried`: the user's Skip and Retry of the task.
 * - `abandoned`: a spawn whose ender left its task in progress, as a load does.
 *
 * A spawn that failed is not here: what it leaves is decided by why it failed
 * (`SpawnFailure`), not by the end alone.
 */
export type AttemptEnding =
  | 'stopped' | 'loaded' | 'cancelled' | 'released' | 'failed' | 'unsettled' | 'usage-limit' | 'skipped' | 'retried' | 'abandoned';

/** The start hold a cancelled task is put on, so the scheduler does not start it again at once. */
export const CANCELLED_HOLD = 'cancelled; retry or force start to run it again';

/** What an ended attempt leaves behind, as {@link attemptLeaves} decides it. */
export interface AttemptLeaves {
  /**
   * What the task becomes: `conflict` waits on the user as its conflict did,
   * `pending` is not started, `failed` blocks its dependents (ADR-0034). Null
   * when the ender's own step settles it (a Skip, a Retry, a limit's pause) or
   * there is no task left to settle (a load).
   */
  readonly status: 'conflict' | 'pending' | 'failed' | null;
  /** The start hold a task back to not started is put on, or null. */
  readonly hold: string | null;
  /** What becomes of the worktree (ADR-0013): kept for inspection and Mark complete, removed, or not let go by this end. */
  readonly worktree: 'keep' | 'remove' | 'untouched';
  /**
   * Whose worktree it is: `attempt`, only one the attempt ran in; `task`,
   * whatever the task kept, attempt or not, as a Skip of a failed task keeps
   * the worktree its failure left.
   */
  readonly reaches: 'attempt' | 'task';
  /** Whether the let-go waits for the attempt's landing in flight, so a worktree is never torn down under its merge (ADR-0013). */
  readonly waitsForLanding: boolean;
  /** Why it is let go, as the execution backend is told. */
  readonly reason: string;
}

const left = (
  status: AttemptLeaves['status'],
  worktree: AttemptLeaves['worktree'],
  reaches: AttemptLeaves['reaches'],
  waitsForLanding: boolean,
  reason: string,
  hold: string | null = null,
): AttemptLeaves => ({ status, hold, worktree, reaches, waitsForLanding, reason });

/**
 * What an attempt of this kind leaves as this ends it: the one policy every
 * end applies (ADR-0013, ADR-0015). `kind` is null when no attempt was live,
 * as a Skip or a Retry of a task that is not running finds it.
 *
 * A conflict repair that does not land goes back to waiting on its conflict
 * (ADR-0015), whatever ended it, never to not started and never failed, so
 * it blocks nothing: only a Skip and a Retry, which settle the conflict
 * themselves, and a limit's pause, which resumes it, leave it otherwise.
 * Every other attempt a Stop or a cancel ends is back to not started, a
 * cancelled one on a hold. A failed verdict and a verdict that could not be
 * settled fail the task.
 *
 * A Stop, a cancel, a failure, a Skip and a limit's pause keep the worktree:
 * a runner is often stopped because it looked stuck after doing the work,
 * which Mark complete can still land. A Retry and a delete remove it: a retry
 * starts over from the integration tip, and a deleted task has nowhere to land.
 * A load keeps only a repair's, which holds work that passed; a running
 * attempt's is left for the next run's prepare or a prune.
 */
export function attemptLeaves(ending: AttemptEnding, kind: AttemptKind | null): AttemptLeaves {
  const repair = kind?.kind === 'repair';
  switch (ending) {
    case 'stopped':
      return left(repair ? 'conflict' : 'pending', 'keep', 'attempt', true, 'stopped');
    case 'loaded':
      return repair ? left(null, 'keep', 'attempt', true, 'stopped') : left(null, 'untouched', 'attempt', false, 'stopped');
    case 'cancelled':
      return repair ? left('conflict', 'keep', 'task', true, 'cancelled') : left('pending', 'keep', 'task', true, 'cancelled', CANCELLED_HOLD);
    case 'released':
      // The hold keeps it from starting while its worktree goes; leaving the plan drops it.
      return repair ? left('conflict', 'remove', 'task', true, 'left the plan') : left('pending', 'remove', 'task', true, 'left the plan', CANCELLED_HOLD);
    case 'failed':
      return left(repair ? 'conflict' : 'failed', 'keep', 'attempt', false, 'failed');
    case 'unsettled':
      // Its landing may be what threw, so the let-go does not wait on it.
      return left(repair ? 'conflict' : 'failed', 'keep', 'attempt', false, 'unsettled');
    case 'usage-limit':
      return left(null, 'keep', 'attempt', false, 'usage limit');
    case 'skipped':
      return left(null, 'keep', 'task', true, 'skipped');
    case 'retried':
      return left(null, 'remove', 'task', true, 'retried');
    case 'abandoned':
      // What its spawn made is the spawn's to let go, by its ender's decision ({@link keptLate}).
      return left(repair ? 'conflict' : 'pending', 'untouched', 'attempt', false, 'ended while opening');
  }
}

/**
 * What an ender decides for a workspace still being made as it ends, before
 * it knows the attempt it took: whether a plain attempt's worktree is kept.
 * {@link keptLate} adds what the kind decides once the spawn lets it go.
 */
export function endKeeps(ending: AttemptEnding): boolean {
  return attemptLeaves(ending, null).worktree === 'keep';
}

/**
 * Whether a workspace an ender could not reach, made while the attempt was
 * still opening, is kept as it is let go late: as the ender decided, and a
 * repair's always, since it reopened a worktree that holds work that passed
 * and is only handed back.
 */
export function keptLate(kind: AttemptKind, enderKeeps: boolean): boolean {
  return kind.kind === 'repair' || enderKeeps;
}

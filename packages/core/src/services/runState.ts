/**
 * What a run a usage-limit hold holds goes back to once released: a task
 * started alone never becomes a scheduled run, and a run that ended on a
 * failure is still the one a retry continues (ADR-0018 U1, ADR-0034).
 */
export type HeldFrom = 'idle' | 'scheduling' | 'endedOnFailure';

/**
 * Where the full-plan run stands, as one value; every getter that reports on
 * the run derives from it (ADR-0034; ADR-0018 U1).
 * - `idle`: no full-plan run since the plan loaded or the user stopped one. A
 *   task started on its own may still be at work, and a loop it started goes
 *   on (ADR-0045 L5).
 * - `scheduling`: the scheduler drives the plan, starting ready tasks as slots
 *   free. A run that waits on the user, a hold or a merge gate stays here.
 * - `held`: a usage-limit pause holds the run, and `from` is what it goes back
 *   to. It stays open and starts nothing new until the reset, a Resume now, a
 *   retry, a skip or a move to another runner continues it. Execute takes the
 *   plan in without ending it.
 * - `endedOnFailure`: the run ended with failed tasks and the tasks they
 *   block; a retry or a skip continues it.
 * - `finished`: every task completed or was skipped.
 */
export type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scheduling' }
  | { readonly kind: 'held'; readonly from: HeldFrom }
  | { readonly kind: 'endedOnFailure' }
  | { readonly kind: 'finished' };

export type RunEvent =
  /** The scheduler drives the plan: a run started, or one held or ended continued as the plan's run. */
  | { readonly type: 'schedule' }
  /** The user's Stop, or the restart a new run begins with. */
  | { readonly type: 'stop' }
  /** A plan loaded over the run: one the scheduler drives keeps going, any other is forgotten with the plan it was in. */
  | { readonly type: 'load' }
  /** A retry, skip or continue of a task: a run that ended on a failure goes on, and one a reset holds goes back to a scheduled run. */
  | { readonly type: 'continue' }
  /** The plan was taken into a run a reset holds: it stays held, and the reset gives back the plan's run. */
  | { readonly type: 'join' }
  /** A usage-limit pause with a reset to wait for. */
  | { readonly type: 'hold' }
  /** The last wait on a reset went, however it went. */
  | { readonly type: 'release' }
  /** The settle step found nothing left that can start: every task finished, or only failed and blocked ones are left. */
  | { readonly type: 'end'; readonly outcome: 'finished' | 'failed' }
  /** The plan is unfinished again — a retry, Mark not done, an added task — so a finished run is not. */
  | { readonly type: 'reopen' };

export const IDLE_RUN: RunState = { kind: 'idle' };

/**
 * The one place a run's state changes: every write to it is an event through
 * here, so what a hold returns to and what each control leaves behind are
 * read in one table rather than at each place that changes the run.
 */
export function nextRunState(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case 'schedule':
      return { kind: 'scheduling' };
    case 'stop':
      return IDLE_RUN;
    case 'load':
      // A held or ended run belongs to the plan it was in, not to the load:
      // kept, the next retry would restart a run nobody started, and a
      // usage-limit move would arm the scheduler.
      return state.kind === 'scheduling' ? state : IDLE_RUN;
    case 'continue':
      if (state.kind === 'endedOnFailure') return { kind: 'scheduling' };
      // Still held, since its reset is still owed; the reset then gives back the plan's run.
      if (state.kind === 'held' && state.from === 'endedOnFailure') return { kind: 'held', from: 'scheduling' };
      return state;
    case 'join':
      return state.kind === 'held' ? { kind: 'held', from: 'scheduling' } : state;
    case 'hold':
      if (state.kind === 'held') return state;
      // A finished run a pause comes to is unfinished, as the settle step
      // would find it: it goes back to no run, not to finished.
      return { kind: 'held', from: state.kind === 'finished' ? 'idle' : state.kind };
    case 'release':
      return state.kind === 'held' ? { kind: state.from } : state;
    case 'end':
      // A hold keeps the run open: closed, it would be handed over or merged
      // before the work the reset resumes.
      if (state.kind === 'held') return state;
      return event.outcome === 'finished' ? { kind: 'finished' } : { kind: 'endedOnFailure' };
    case 'reopen':
      return state.kind === 'finished' ? IDLE_RUN : state;
  }
}

/** What a hold holds the run from; null when nothing holds it. */
export function heldFrom(state: RunState): HeldFrom | null {
  return state.kind === 'held' ? state.from : null;
}

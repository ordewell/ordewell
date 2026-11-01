import type { IWorktreeIsolation } from '../interfaces/IWorktreeIsolation';
import { SessionHeldError, type SessionHeld } from './sessionLease';

/** The changes to a run in flight, as a closing Session waits them out. */
export interface RunChanges {
  /** One is under way. */
  readonly changing: boolean;
  /** Every one under way has ended and none follows: nothing of this run changes git past here, so its lease can go. */
  closeChanges(): Promise<void>;
}

/**
 * The isolation a session's run works through, refusing every change to the
 * run while another host holds the session (ADR-0049). Both hosts continue
 * the same run id, so they name the same worktrees and branches: a second
 * host's `prepare` removes the first's live worktree and re-creates it under
 * its runner, and its prune sweeps worktrees it does not know are live.
 * Reads of git go through. So a Stop's release still running as its Session
 * closes reaches no repository a next host holds.
 */
export function leasedIsolation(isolation: IWorktreeIsolation, held: () => SessionHeld | null): IWorktreeIsolation & RunChanges {
  const underWay = new Set<Promise<unknown>>();
  let closed = false;
  const guarded = <A extends unknown[], R>(change: (...args: A) => Promise<R>) => (...args: A): Promise<R> => {
    if (closed) return Promise.reject(new Error('This session has closed, so its run changes nothing more.'));
    const holder = held();
    if (holder) return Promise.reject(new SessionHeldError(holder));
    const changed = change(...args);
    const ended: Promise<unknown> = Promise.resolve(changed).catch(() => undefined).finally(() => underWay.delete(ended));
    underWay.add(ended);
    return changed;
  };
  const { taskDiff, blobOn } = isolation;
  return {
    isActive: (root) => isolation.isActive(root),
    gitShortfall: () => isolation.gitShortfall(),
    stash: guarded((root) => isolation.stash(root)),
    startRun: guarded((root, stateRoot) => isolation.startRun(root, stateRoot)),
    prepare: guarded((task, run, intent, opts) => isolation.prepare(task, run, intent, opts)),
    reopen: guarded((task, run) => isolation.reopen(task, run)),
    verifyRepair: (task, run) => isolation.verifyRepair(task, run),
    repairPaths: (task, run) => isolation.repairPaths?.(task, run) ?? Promise.resolve([]),
    integrate: guarded((task, run, persist, commit) => isolation.integrate(task, run, persist, commit)),
    readLanded: (run, taskIds) => isolation.readLanded(run, taskIds),
    revert: guarded((run, taskIds, watch) => isolation.revert(run, taskIds, watch)),
    release: guarded((run, taskId, opts) => isolation.release(run, taskId, opts)),
    handoff: guarded((run) => isolation.handoff(run)),
    pruneOrphans: guarded((run) => isolation.pruneOrphans(run)),
    reviewDiff: (run) => isolation.reviewDiff(run),
    ...(taskDiff ? { taskDiff: (run, taskId, options) => taskDiff.call(isolation, run, taskId, options) } : {}),
    ...(blobOn ? { blobOn: (root, branch, file) => blobOn.call(isolation, root, branch, file) } : {}),
    findInHead: (run) => isolation.findInHead(run),
    snapshotTree: (root, exclude) => isolation.snapshotTree(root, exclude),
    changedSince: (root, snapshot) => isolation.changedSince(root, snapshot),
    mergeIntoCheckedOut: guarded((run) => isolation.mergeIntoCheckedOut(run)),
    discard: guarded((run, opts) => isolation.discard(run, opts)),
    sweep: guarded((run) => isolation.sweep(run)),
    get changing() { return underWay.size > 0; },
    closeChanges: async () => {
      // A change leads to the next through a promise or a save, so the set is read again past both.
      do {
        await Promise.all(underWay);
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (underWay.size > 0);
      closed = true;
    },
  };
}

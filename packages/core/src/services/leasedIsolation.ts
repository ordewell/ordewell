import type { IWorktreeIsolation } from '../interfaces/IWorktreeIsolation';
import { SessionHeldError, type SessionHeld } from './sessionLease';

/**
 * The isolation a session's run works through, refusing every change to the
 * run while another host holds the session (ADR-0049). Both hosts continue
 * the same run id, so they name the same worktrees and branches: a second
 * host's `prepare` removes the first's live worktree and re-creates it under
 * its runner, and its prune sweeps worktrees it does not know are live.
 * Reads of git go through.
 */
export function leasedIsolation(isolation: IWorktreeIsolation, held: () => SessionHeld | null): IWorktreeIsolation {
  const guarded = <A extends unknown[], R>(change: (...args: A) => Promise<R>) => (...args: A): Promise<R> => {
    const holder = held();
    return holder ? Promise.reject(new SessionHeldError(holder)) : change(...args);
  };
  const { taskDiff } = isolation;
  return {
    isActive: (root) => isolation.isActive(root),
    stash: guarded((root) => isolation.stash(root)),
    startRun: guarded((root) => isolation.startRun(root)),
    prepare: guarded((task, run, intent, opts) => isolation.prepare(task, run, intent, opts)),
    reopen: guarded((task, run) => isolation.reopen(task, run)),
    verifyRepair: (task, run) => isolation.verifyRepair(task, run),
    integrate: guarded((task, run, persist, commit) => isolation.integrate(task, run, persist, commit)),
    readLanded: (run, taskIds) => isolation.readLanded(run, taskIds),
    revert: guarded((run, taskIds, watch) => isolation.revert(run, taskIds, watch)),
    release: guarded((run, taskId, opts) => isolation.release(run, taskId, opts)),
    handoff: guarded((run) => isolation.handoff(run)),
    pruneOrphans: guarded((run) => isolation.pruneOrphans(run)),
    reviewDiff: (run) => isolation.reviewDiff(run),
    ...(taskDiff ? { taskDiff: (run, taskId, options) => taskDiff.call(isolation, run, taskId, options) } : {}),
    findInHead: (run) => isolation.findInHead(run),
    snapshotTree: (root, exclude) => isolation.snapshotTree(root, exclude),
    changedSince: (root, snapshot) => isolation.changedSince(root, snapshot),
    mergeIntoCheckedOut: guarded((run) => isolation.mergeIntoCheckedOut(run)),
    discard: guarded((run, opts) => isolation.discard(run, opts)),
    sweep: guarded((run) => isolation.sweep(run)),
  };
}

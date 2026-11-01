import type { IsolationRemoval, IsolationRun, IWorktreeIsolation } from '../interfaces/IWorktreeIsolation';
import { listChildSessions, loadChildSession, type ChildSessionPlace } from '../utils/sessionStore';
import { absorbRemoval, noRemoval, repoRootOf } from './isolationRecord';
import { stateRootOf } from './stateRoot';

/**
 * Its repos as seen from the checkout under the state root: the delegated
 * task's worktree it was rooted in may have gone before it, and one repository
 * answers the same from either place.
 */
function fromCheckout(run: IsolationRun): IsolationRun {
  return { ...run, repos: run.repos.map((repo) => ({ ...repo, root: repoRootOf(stateRootOf(run), repo.path) })) };
}

/**
 * One child's run, with everything under it, for a fresh attempt or a removal
 * of its delegated task (ADR-0055 D15). Its state stays on disk under the root:
 * only the worktrees and branches its records name go.
 */
export async function discardChildRun(place: ChildSessionPlace, isolation: Pick<IWorktreeIsolation, 'discard'>): Promise<IsolationRemoval> {
  const removal = noRemoval();
  const run = loadChildSession(place)?.plan.isolation?.run;
  if (!run) return removal;
  for (const { childSession } of Object.values(run.tasks)) {
    if (childSession) absorbRemoval(removal, await discardChildRun({ ...place, sessionId: childSession }, isolation));
  }
  absorbRemoval(removal, await isolation.discard(fromCheckout(run), { integration: 'delete' }));
  return removal;
}

/**
 * What deleting a root owes its children (ADR-0055 D11): `deleteSession` removes
 * files and no worktree, and a child's run is named only by a file that goes
 * with the root's, so each is discarded first as Session's `discardRun` does.
 * Unlanded work is kept on a branch; what git could not let go is in `refused`,
 * for the caller to stop on while the records still name it.
 */
export async function discardChildRuns(rootSessionId: string, baseDir: string, isolation: Pick<IWorktreeIsolation, 'discard'>): Promise<IsolationRemoval> {
  const removal = noRemoval();
  for (const sessionId of listChildSessions(rootSessionId, baseDir)) {
    const run = loadChildSession({ baseDir, rootSessionId, sessionId })?.plan.isolation?.run;
    if (run) absorbRemoval(removal, await isolation.discard(fromCheckout(run), { integration: 'delete' }));
  }
  return removal;
}

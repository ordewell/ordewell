/**
 * The two chains `GitWorktreeIsolation` serialises its work on.
 *
 * - **turn**: one per isolation instance. Landings and Merge all take it, so
 *   a merge never reads an integration branch mid-landing; anything that
 *   removes the integration worktrees or settles a recorded landing takes it
 *   too, or it could roll back the merge of a landing still in flight.
 * - **admin**: one per state root, shared by every repo of its group, and by a
 *   tree, whose children are handed their parent's isolation (ADR-0055 D11).
 *   Worktree and branch bookkeeping: concurrent `git worktree add`s race on
 *   git's shared admin files.
 *
 * Lock order is turn, then admin. Nothing holding admin may wait on a turn:
 * a landing holds its turn while it waits on admin, so that would deadlock.
 */
export class IsolationLocks {
  private turns: Promise<unknown> = Promise.resolve();
  private readonly adminChains = new Map<string, Promise<unknown>>();

  inTurn<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.turns.then(fn, fn);
    this.turns = turn.catch(() => undefined);
    return turn;
  }

  admin<T>(stateRoot: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.adminChains.get(stateRoot) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    this.adminChains.set(stateRoot, next.catch(() => undefined));
    return next;
  }
}

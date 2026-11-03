import { useEffect, useSyncExternalStore } from 'react';
import type { FrameApi } from '../../frame/api';
import { callDaemon, messageOf } from '../../session/daemon';
import { parseSessions } from '../../sessions';
import { useDaemonStatus } from '../../useDaemonStatus';
import { deriveSession, type ScopeTask } from '../scope/scopeStore';
import { useScope } from '../scope/useScope';
import { readBranches, readRepos, type Branches, type Owner, type RepoState } from './gitData';

/*
 * What the Git view's sidebar and graph share: the repositories, the branches
 * of the one the person picked, and the runs those branches belong to. One
 * read feeds both, so a fetch in the sidebar redraws the graph's labels.
 */

/** A run as a branch names it: the goal it was started with and the tasks it has landed. */
export interface RunInfo {
  sessionId: string;
  goal: string;
  tasks: ScopeTask[];
}

export interface GitState {
  repos: RepoState[];
  /** The repository `branches` was read for. */
  repo: string | undefined;
  branches: Branches | undefined;
  /** Why the last read failed, in the daemon's words; shown in place of the lists. */
  error: string | undefined;
  loading: boolean;
  runs: Readonly<Record<string, RunInfo>>;
  /** Counts each read, so a view that drew from an earlier one knows to read again. */
  round: number;
}

export function ownersOf(branches: Branches | undefined): Owner[] {
  if (!branches) return [];
  const owners: Owner[] = [];
  for (const branch of [...branches.local, ...branches.ordewell]) {
    if (branch.owner) owners.push(branch.owner);
    for (const run of branch.landingFor ?? []) owners.push(run);
  }
  for (const tree of branches.worktrees) if (tree.owner) owners.push(tree.owner);
  return owners;
}

export class GitStore {
  private state: GitState = { repos: [], repo: undefined, branches: undefined, error: undefined, loading: false, runs: {}, round: 0 };
  private readonly listeners = new Set<() => void>();
  private reads = 0;
  private goals: Map<string, string> | undefined;

  constructor(private readonly workspace: string) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): GitState => this.state;

  private set(patch: Partial<GitState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Reads the repositories and the branches of `repo`. A read that a later one
   * overtook is dropped, so a quick change of repository never shows the
   * earlier one's branches under the later one's name.
   */
  async refresh(repo: string): Promise<void> {
    const mine = ++this.reads;
    this.set({ loading: true });
    try {
      const [repos, branches] = await Promise.all([readRepos(this.workspace), readBranches(this.workspace, repo)]);
      if (mine !== this.reads) return;
      const runs = await this.runsFor(ownersOf(branches));
      if (mine !== this.reads) return;
      this.set({ repos, repo, branches, runs, error: undefined, loading: false, round: this.state.round + 1 });
    } catch (error) {
      if (mine !== this.reads) return;
      this.set({ repo, branches: undefined, error: messageOf(error), loading: false, round: this.state.round + 1 });
    }
  }

  /** The runs the owners name, read once each: a run's goal and its tasks do not change under a branch list. */
  async runsFor(owners: readonly Owner[]): Promise<Record<string, RunInfo>> {
    const runs = { ...this.state.runs };
    const missing = [...new Set(owners.map((o) => o.sessionId))].filter((id) => !runs[id]);
    if (missing.length === 0) return runs;
    this.goals ??= await this.readGoals();
    await Promise.all(missing.map(async (sessionId) => {
      let tasks: ScopeTask[] = [];
      try {
        tasks = deriveSession(sessionId, await callDaemon('sessions.get', { id: sessionId, workspace: this.workspace })).tasks;
      } catch {
        // A run whose state cannot be read is still named by its id.
      }
      runs[sessionId] = { sessionId, goal: this.goals?.get(sessionId) ?? '', tasks };
    }));
    return runs;
  }

  private async readGoals(): Promise<Map<string, string>> {
    try {
      return new Map((parseSessions(await callDaemon('sessions.list', { workspace: this.workspace })) ?? []).map((s) => [s.id, s.goal]));
    } catch {
      return new Map();
    }
  }
}

const stores = new WeakMap<FrameApi, GitStore>();

export function gitStoreFor(api: FrameApi): GitStore {
  let store = stores.get(api);
  if (!store) { store = new GitStore(api.workspace); stores.set(api, store); }
  return store;
}

/** The Git view's state for the repository the window has picked, read again once the daemon is connected or the pick changes. */
export function useGit(api: FrameApi): { git: GitStore; state: GitState; repo: string; setRepo(repo: string): void } {
  const git = gitStoreFor(api);
  const state = useSyncExternalStore(git.subscribe, git.getSnapshot);
  const { store: scope, state: scoped } = useScope(api);
  const connected = useDaemonStatus()?.state === 'connected';
  const repo = scoped.repo;
  useEffect(() => { if (connected) void git.refresh(repo); }, [git, connected, repo]);
  return { git, state, repo, setRepo: (next) => scope.setRepo(next) };
}

/** The name a run goes by in a sentence: `run r7`, and its goal when it is known. */
export function runName(runs: Readonly<Record<string, RunInfo>>, owner: { sessionId: string; runId: string }): string {
  const goal = runs[owner.sessionId]?.goal;
  return goal ? `run ${owner.runId} of “${goal}”` : `run ${owner.runId}`;
}

import { useEffect, useSyncExternalStore } from 'react';
import type { FrameApi } from '../../frame/api';
import { callDaemon, messageOf } from '../../session/daemon';
import { parseSessions } from '../../sessions';
import { useDaemonStatus } from '../../useDaemonStatus';
import { deriveSession, repositoryOf, type ScopeTask } from '../scope/scopeStore';
import { useScope } from '../scope/useScope';
import { readBranches, readCommit, readLog, readRepos, type Branches, type CommitDetail, type CommitSummary, type Owner, type RepoState } from './gitData';

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

/** The remote-moving actions of a repository: one at a time, whoever started it. */
export type SyncKind = 'fetch' | 'pull' | 'push';

/** A page of the sidebar's history: the daemon's own default, so a first look reads no more than the log does unasked. */
export const HISTORY_PAGE = 50;
/** The daemon's ceiling on one log read: a read again keeps the person's place up to here, and no further. */
const HISTORY_MAX = 500;

/** Commit cards' reads kept per store; past this, the oldest is forgotten and read again if it is hovered again. */
const COMMIT_CACHE = 200;

/** The Git sidebar's two views of a repository: its branch tree, or its history as lanes. */
export type GitSidebarView = 'branches' | 'history';

/**
 * Where one history is kept: a repository and the ref it is read from, the
 * checkout's own when `ref` is undefined. A ref never holds a NUL, so the two
 * cannot run into each other.
 */
export function historyKey(repo: string, ref?: string): string {
  return ref === undefined ? repo : `${repo}\0${ref}`;
}

/** The sidebar's history of one repository at one ref, kept by the store so a switch of view, ref or repository loses neither the commits nor the pick. */
export interface History {
  commits: CommitSummary[];
  /** Where the next page starts; null at the root. */
  cursor: string | null;
  /** The branch tips it was read at: a fetch, a switch or a commit moves one, and it is read again. */
  tips: string;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  /** A read again is in flight over the rows on screen: the next page waits for the cursor it brings. */
  rereading?: boolean;
  /** A Load more is in flight. */
  more: boolean;
  moreError?: string;
  selected?: string;
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
  /** The fetch, pull or push running on each repository now, from any surface that started it. */
  syncing: Readonly<Record<string, SyncKind>>;
  /** Each repository's sidebar history at each ref browsed, by historyKey, read only once the History view asks for it. */
  history: Readonly<Record<string, History>>;
  /** The sidebar's view: the window's, so it outlives an activity switch and a change of repository. */
  view: GitSidebarView;
  /**
   * The branch each repository's History is browsing, when it is not the
   * checkout's own. Browsing only reads: the checkout, which Fetch, Pull and
   * Push act on, stays where it is.
   */
  browsing: Readonly<Record<string, string>>;
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
  private state: GitState = { repos: [], repo: undefined, branches: undefined, error: undefined, loading: false, runs: {}, round: 0, syncing: {}, history: {}, view: 'branches', browsing: {} };
  private readonly listeners = new Set<() => void>();
  private reads = 0;
  private goals: Map<string, string> | undefined;
  /** The one history read in flight per historyKey; a newer one replaces it, and the older one's answer is dropped. */
  private readonly historyReads = new Map<string, { token: number; tips: string; more: boolean }>();
  private historyTokens = 0;
  /** Bumped by a Refresh the person asked for, so the history is read again though no tip moved: a tag alone moves none. */
  private readonly historyRereads = new Map<string, number>();
  /** A commit's message and files by repository and sha: a sha names the same commit for good, so it is read once. */
  private readonly commits = new Map<string, { read: Promise<CommitDetail>; value?: CommitDetail }>();

  constructor(private readonly workspace: string) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): GitState => this.state;

  /** A commit's message and files, already read; undefined until a commitDetail read has answered. */
  cachedCommit(repo: string, sha: string): CommitDetail | undefined {
    return this.commits.get(`${repo}\0${sha}`)?.value;
  }

  /**
   * A commit's message and files, read from the daemon once per sha however
   * often its card opens. A failed read is forgotten, so the next opening asks
   * again rather than keeping the failure.
   */
  commitDetail(repo: string, sha: string): Promise<CommitDetail> {
    const key = `${repo}\0${sha}`;
    const have = this.commits.get(key);
    if (have) return have.read;
    const entry: { read: Promise<CommitDetail>; value?: CommitDetail } = {
      read: readCommit(this.workspace, repo, sha).then(
        (value) => { entry.value = value; return value; },
        (error: unknown) => { if (this.commits.get(key) === entry) this.commits.delete(key); throw error; },
      ),
    };
    if (this.commits.size >= COMMIT_CACHE) this.commits.delete(this.commits.keys().next().value!);
    this.commits.set(key, entry);
    return entry.read;
  }

  private set(patch: Partial<GitState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Runs `work` as the one fetch, pull or push on `repo`, and says so to every
   * button that shows it. The palette and both sidebars start through here, so a
   * second start while one runs is refused (`false`) rather than queued behind
   * git, and the mark is lifted however `work` ends.
   */
  async sync(repo: string, kind: SyncKind, work: () => Promise<void>): Promise<boolean> {
    if (this.state.syncing[repo]) return false;
    this.set({ syncing: { ...this.state.syncing, [repo]: kind } });
    try {
      await work();
    } finally {
      const rest = { ...this.state.syncing };
      delete rest[repo];
      this.set({ syncing: rest });
    }
    return true;
  }

  /**
   * Reads the repositories and the branches of `repo`. A read that a later one
   * overtook is dropped, so a quick change of repository never shows the
   * earlier one's branches under the later one's name. With `history`, a
   * history already read is read again too, as a Refresh the person pressed
   * means it.
   */
  async refresh(repo: string, { history = false }: { history?: boolean } = {}): Promise<void> {
    const mine = ++this.reads;
    this.set({ loading: true });
    try {
      const [repos, branches] = await Promise.all([readRepos(this.workspace), readBranches(this.workspace, repo)]);
      if (mine !== this.reads) return;
      const runs = await this.runsFor(ownersOf(branches));
      if (mine !== this.reads) return;
      if (history) this.historyRereads.set(repo, (this.historyRereads.get(repo) ?? 0) + 1);
      this.set({ repos, repo, branches, runs, error: undefined, loading: false, round: this.state.round + 1, ...this.forgetGone(repo, branches) });
    } catch (error) {
      if (mine !== this.reads) return;
      this.set({ repo, branches: undefined, error: messageOf(error), loading: false, round: this.state.round + 1 });
    }
  }

  /**
   * A browsed branch the read no longer lists was deleted: History goes back to
   * the checkout's, and what was read of it, or is still being read, goes too,
   * so a branch made again under the name is never shown the old one's commits.
   */
  private forgetGone(repo: string, branches: Branches): Partial<GitState> {
    const ref = this.state.browsing[repo];
    if (ref === undefined || [...branches.local, ...branches.ordewell, ...branches.remote].some((b) => b.name === ref)) return {};
    const key = historyKey(repo, ref);
    this.historyReads.delete(key);
    const browsing = { ...this.state.browsing };
    delete browsing[repo];
    const history = { ...this.state.history };
    delete history[key];
    return { browsing, history };
  }

  private patchHistory(key: string, patch: Partial<History>): void {
    const was = this.state.history[key] ?? { commits: [], cursor: null, tips: '', status: 'loading', more: false };
    this.set({ history: { ...this.state.history, [key]: { ...was, ...patch } } });
  }

  /** Shows the sidebar's branch tree or its history; the window keeps the choice. */
  setView(view: GitSidebarView): void {
    if (this.state.view !== view) this.set({ view });
  }

  /**
   * Shows the history of `ref` in `repo`'s sidebar, the checkout's own when
   * `ref` is undefined. It only reads: nothing is switched, and no tab opens.
   */
  browse(repo: string, ref: string | undefined): void {
    const browsing = { ...this.state.browsing };
    // The checked-out branch is the checkout's own history, read and kept once.
    const checkedOut = this.state.repo === repo && !this.state.branches?.detached ? this.state.branches?.current : undefined;
    if (ref === undefined || ref === checkedOut) delete browsing[repo];
    else browsing[repo] = ref;
    this.set({ view: 'history', browsing });
  }

  /**
   * What the history of `repo` was read against: every branch tip, so a branch
   * read again over the same tips (the sidebar shown again, a fetch that
   * brought nothing) costs no log read. A detached checkout moves no tip when
   * it commits, so its head counts as one; a failed branch read, or a detached
   * head not known, says nothing, so those count each read.
   * A fetch that brought only tags moves no tip either: an explicit Refresh
   * reads them in.
   */
  historyTips(repo: string): string | undefined {
    const { repo: read, branches, round, repos } = this.state;
    if (read !== repo) return undefined;
    const head = branches?.detached ? repos.find((r) => r.repo === repo)?.head : undefined;
    if (!branches || (branches.detached && !head)) return `round ${round}`;
    const reread = this.historyRereads.get(repo) ?? 0;
    return JSON.stringify([reread, branches.current, head ?? null, ...[...branches.local, ...branches.ordewell, ...branches.remote].map((b) => [b.name, b.sha])]);
  }

  /**
   * Reads the history of `repo` at `ref` (the checkout's when undefined) when
   * it has none at the branch tips now known, or when the last read failed;
   * asked again while that read is in flight, it sends nothing. A read again
   * keeps the commits on screen and as many of them as were shown, within the
   * daemon's ceiling, so the person's place stands.
   */
  async loadHistory(repo: string, ref?: string): Promise<void> {
    const tips = this.historyTips(repo);
    if (tips === undefined) return;
    const key = historyKey(repo, ref);
    const have = this.state.history[key];
    const inFlight = this.historyReads.get(key);
    // A page in flight at these tips is still good; only moved tips overtake it.
    if (inFlight && inFlight.tips === tips) return;
    if (!inFlight && have && have.tips === tips && have.status === 'ready') return;
    const token = ++this.historyTokens;
    this.historyReads.set(key, { token, tips, more: false });
    const limit = Math.min(HISTORY_MAX, Math.max(HISTORY_PAGE, have?.commits.length ?? 0));
    this.patchHistory(key, { status: have?.status === 'ready' ? 'ready' : 'loading', error: undefined, rereading: true, more: false, moreError: undefined });
    try {
      const page = await readLog(this.workspace, repo, { ...(ref !== undefined ? { ref } : {}), limit });
      if (this.historyReads.get(key)?.token !== token) return;
      this.historyReads.delete(key);
      this.patchHistory(key, { commits: page.commits, cursor: page.cursor, tips, status: 'ready', rereading: false });
    } catch (error) {
      if (this.historyReads.get(key)?.token !== token) return;
      this.historyReads.delete(key);
      this.patchHistory(key, { tips, status: 'error', error: messageOf(error), rereading: false });
    }
  }

  /** The next page of `repo`'s history at `ref`, once: never beside another read of it, and dropped if a read again overtook it. */
  async loadMoreHistory(repo: string, ref?: string): Promise<void> {
    const key = historyKey(repo, ref);
    const have = this.state.history[key];
    if (!have || have.status !== 'ready' || !have.cursor || this.historyReads.has(key)) return;
    const token = ++this.historyTokens;
    this.historyReads.set(key, { token, tips: have.tips, more: true });
    this.patchHistory(key, { more: true, moreError: undefined });
    try {
      const page = await readLog(this.workspace, repo, { ...(ref !== undefined ? { ref } : {}), cursor: have.cursor, limit: HISTORY_PAGE });
      if (this.historyReads.get(key)?.token !== token) return;
      this.historyReads.delete(key);
      const commits = this.state.history[key]?.commits ?? [];
      const known = new Set(commits.map((c) => c.sha));
      this.patchHistory(key, { commits: [...commits, ...page.commits.filter((c) => !known.has(c.sha))], cursor: page.cursor, more: false });
    } catch (error) {
      if (this.historyReads.get(key)?.token !== token) return;
      this.historyReads.delete(key);
      this.patchHistory(key, { more: false, moreError: messageOf(error) });
    }
  }

  selectCommit(repo: string, ref: string | undefined, sha: string): void {
    const key = historyKey(repo, ref);
    if (this.state.history[key]?.selected !== sha) this.patchHistory(key, { selected: sha });
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
  // The workspace folder that is no repository has no git of its own: the Git view reads one of its repositories (ADR-0064 R2).
  const repo = repositoryOf(scoped);
  useEffect(() => { if (connected) void git.refresh(repo); }, [git, connected, repo]);
  return { git, state, repo, setRepo: (next) => scope.setRepo(next) };
}

/** The name a run goes by in a sentence: `run r7`, and its goal when it is known. */
export function runName(runs: Readonly<Record<string, RunInfo>>, owner: { sessionId: string; runId: string }): string {
  const goal = runs[owner.sessionId]?.goal;
  return goal ? `run ${owner.runId} of “${goal}”` : `run ${owner.runId}`;
}

/** The sync action running on `repo` now, for the buttons that offer one. */
export function useSyncing(api: FrameApi, repo: string): SyncKind | undefined {
  const git = gitStoreFor(api);
  return useSyncExternalStore(git.subscribe, () => git.getSnapshot().syncing[repo]);
}

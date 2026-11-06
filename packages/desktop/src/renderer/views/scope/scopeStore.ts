import { filesApi, type RepoInfo } from '../../files/api';
import type { FrameApi, ViewScope } from '../../frame/api';
import { parseSessions } from '../../sessions';

/**
 * Which view scope each repository of the workspace is looking at (design:
 * Scope model, ADR-0064 R2), and what the open session offers to switch to.
 * The Explorer, its file tabs and the title bar's switcher read this one place,
 * so a switch in the title bar moves them all and a later slice's terminal
 * follows it too.
 */

export type TaskScopeState = 'running' | 'landed' | 'conflict' | 'repairing' | 'kept';

export interface ScopeTask {
  id: string;
  order: number;
  title: string;
  state: TaskScopeState;
  /** Paths of the repos the task changed; empty means "not said", which a single-repo workspace reads as its one repo. */
  repos: string[];
}

export interface ScopeSession {
  sessionId: string;
  /** The integration branch of each repo the run landed in; empty while the run has landed nothing anywhere. */
  integration: Array<{ repo: string; branch: string }>;
  tasks: ScopeTask[];
}

export interface ScopeState {
  repos: RepoInfo[];
  /** The repo the Explorer is showing; `.` until the repos are read. */
  repo: string;
  scopes: Readonly<Record<string, ViewScope>>;
  session: ScopeSession | undefined;
  /** Why the last scope fell back to the checkout; shown until dismissed or a scope is chosen. */
  notice: string | undefined;
}

const CHECKOUT: ViewScope = { kind: 'checkout' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TASK_STATES: Record<string, TaskScopeState> = {
  active: 'running', integrated: 'landed', conflict: 'conflict', repairing: 'repairing', kept: 'kept',
};

/**
 * What a session's saved state offers as scopes: a task has a worktree to look
 * at once its isolation has a state, and the integration branch exists once
 * the run's handoff names one. Defensive: an older daemon's answer may lack any of it.
 */
export function deriveSession(sessionId: string, data: unknown): ScopeSession {
  const session: ScopeSession = { sessionId, integration: [], tasks: [] };
  const run = isRecord(data) && isRecord(data.run) ? data.run : undefined;
  if (!run) return session;
  const visit = (tasks: unknown): void => {
    if (!Array.isArray(tasks)) return;
    for (const task of tasks) {
      if (!isRecord(task)) continue;
      const isolation = isRecord(task.isolation) ? task.isolation : undefined;
      const state = typeof isolation?.state === 'string' ? TASK_STATES[isolation.state] : undefined;
      if (state && typeof task.id === 'string') {
        session.tasks.push({
          id: task.id,
          order: typeof task.order === 'number' ? task.order : session.tasks.length + 1,
          title: typeof task.title === 'string' ? task.title : task.id,
          state,
          repos: Array.isArray(isolation?.repos) ? isolation.repos.filter((r): r is string => typeof r === 'string') : [],
        });
      }
      visit(task.subtasks);
    }
  };
  visit(run.tasks);
  const handoff = isRecord(run.handoff) ? run.handoff : undefined;
  if (handoff && Array.isArray(handoff.repos)) {
    for (const repo of handoff.repos) {
      if (isRecord(repo) && typeof repo.path === 'string' && typeof repo.integrationBranch === 'string') {
        session.integration.push({ repo: repo.path, branch: repo.integrationBranch });
      }
    }
  }
  return session;
}

/** Whether a task's worktree covers `repo`: a task that names no repos belongs to a single-repo workspace's one. */
export function taskTouches(task: ScopeTask, repo: string, repoCount: number): boolean {
  if (task.repos.length === 0) return repoCount <= 1;
  return task.repos.some((path) => path === repo || path.endsWith(`/${repo}`) || (repo === '.' && repoCount <= 1));
}

/** The scopes a repo can be switched to, in the order the menu lists them. */
export function optionsFor(state: ScopeState, repo: string): Array<{ scope: ViewScope; label: string; detail?: string; mark?: string }> {
  const branch = state.repos.find((r) => r.repo === repo)?.branch;
  const options: Array<{ scope: ViewScope; label: string; detail?: string; mark?: string }> = [
    { scope: CHECKOUT, label: 'Your checkout', ...(branch ? { detail: branch } : {}) },
  ];
  const session = state.session;
  if (!session) return options;
  const integration = session.integration.find((entry) => entry.repo === repo || (repo === '.' && state.repos.length <= 1));
  if (integration) options.push({ scope: { kind: 'integration', sessionId: session.sessionId }, label: 'Integration branch', detail: integration.branch });
  for (const task of session.tasks) {
    if (!taskTouches(task, repo, state.repos.length)) continue;
    options.push({
      scope: { kind: 'task', sessionId: session.sessionId, taskId: task.id },
      label: `Task #${task.order} worktree`,
      detail: task.title,
      mark: task.state === 'landed' ? '✓' : task.state === 'running' ? '◐' : task.state === 'conflict' ? '!' : task.state === 'repairing' ? '◐' : '·',
    });
  }
  return options;
}

export function sameScope(a: ViewScope, b: ViewScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'checkout' || b.kind === 'checkout') return true;
  if (a.sessionId !== (b as { sessionId: string }).sessionId) return false;
  return a.kind === 'integration' || (a.kind === 'task' && b.kind === 'task' && a.taskId === b.taskId);
}

/** A scope as a short name: tab titles and the sidebar header. */
export function scopeName(scope: ViewScope, session: ScopeSession | undefined): string {
  switch (scope.kind) {
    case 'checkout': return 'Your checkout';
    case 'integration': return 'Integration branch';
    case 'task': {
      const task = session?.tasks.find((t) => t.id === scope.taskId);
      return task ? `Task #${task.order}` : 'Task worktree';
    }
  }
}

export class ScopeStore {
  private state: ScopeState = { repos: [], repo: '.', scopes: {}, session: undefined, notice: undefined };
  private readonly listeners = new Set<() => void>();
  private refreshing: Promise<void> | undefined;

  constructor(private readonly api: FrameApi) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): ScopeState => this.state;

  private set(patch: Partial<ScopeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  scopeOf(repo: string = this.state.repo): ViewScope {
    return this.state.scopes[repo] ?? CHECKOUT;
  }

  select(repo: string, scope: ViewScope): void {
    this.set({ repo, scopes: { ...this.state.scopes, [repo]: scope }, notice: undefined });
  }

  setRepo(repo: string): void {
    this.set({ repo });
  }

  setSession(session: ScopeSession | undefined): void {
    this.set({ session });
  }

  /**
   * A scope that is gone never silently becomes another one (ADR-0064 R2), so
   * the repo goes back to the checkout and the reason stays on screen.
   */
  fallBack(repo: string, reason: string): void {
    this.set({ scopes: { ...this.state.scopes, [repo]: CHECKOUT }, notice: reason });
  }

  dismissNotice(): void {
    this.set({ notice: undefined });
  }

  /** Reads the repos and the newest session; concurrent calls share one read. */
  refresh(): Promise<void> {
    this.refreshing ??= this.load().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async load(): Promise<void> {
    const workspace = this.api.workspace;
    const [repos, session] = await Promise.all([
      filesApi.repos(workspace).catch(() => undefined),
      this.newestSession(workspace),
    ]);
    const patch: Partial<ScopeState> = { session };
    if (repos) {
      patch.repos = repos;
      if (!repos.some((r) => r.repo === this.state.repo)) patch.repo = repos[0]?.repo ?? '.';
    }
    this.set(patch);
  }

  /**
   * Until the session slice says which session is open, the scopes follow the
   * newest one: the one a person has most likely just been working with.
   */
  private async newestSession(workspace: string): Promise<ScopeSession | undefined> {
    const list = await window.ordewell.daemon.call('sessions.list', { workspace });
    if (!list.ok) return undefined;
    const newest = parseSessions(list.data)?.[0];
    if (!newest) return undefined;
    const got = await window.ordewell.daemon.call('sessions.get', { id: newest.id, workspace });
    return got.ok ? deriveSession(newest.id, got.data) : { sessionId: newest.id, integration: [], tasks: [] };
  }
}

const stores = new WeakMap<FrameApi, ScopeStore>();

/** The window's one store, made on first use for its frame. */
export function scopeStoreFor(api: FrameApi): ScopeStore {
  let store = stores.get(api);
  if (!store) { store = new ScopeStore(api); stores.set(api, store); }
  return store;
}

import { callDaemon } from '../../session/daemon';

/*
 * The Git view's reads and actions on the daemon (ADR-0064 R5, ADR-0062).
 * Every answer is checked here, so the views draw only what parsed; a shape
 * this app cannot read is an error with a sentence, never a half-drawn list.
 */

export interface RepoState {
  repo: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** Whose a branch or worktree is, as the saved runs say. */
export interface Owner {
  sessionId: string;
  runId: string;
  taskId?: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  current: boolean;
  /** The tip's committer date (ISO 8601); absent from a daemon that predates it. */
  date?: string;
  /** The tip's subject line; absent likewise. */
  subject?: string;
  owner?: Owner;
  /** Live runs that land on this branch. */
  landingFor?: Array<{ sessionId: string; runId: string }>;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  main: boolean;
  owner?: Owner;
}

export interface StashInfo {
  ref: string;
  sha: string;
  message: string;
}

export interface Branches {
  repo: string;
  current: string | null;
  detached: boolean;
  local: BranchInfo[];
  ordewell: BranchInfo[];
  remote: BranchInfo[];
  stashes: StashInfo[];
  worktrees: WorktreeInfo[];
}

export interface CommitSummary {
  sha: string;
  parents: string[];
  /** Names git decorates the commit with: `HEAD`, branches, remote branches and tags, tags unmarked. */
  refs: string[];
  subject: string;
  author: string;
  email: string;
  date: string;
}

export interface LogPage {
  repo: string;
  ref: string;
  commits: CommitSummary[];
  cursor: string | null;
}

export interface CommitFile {
  path: string;
  status: string;
  added: number | null;
  removed: number | null;
}

export interface CommitDetail {
  commit: CommitSummary & { body: string };
  files: CommitFile[];
  patch?: string;
}

export interface ActionResult {
  repo: RepoState;
  warning?: string;
  stash?: { sha: string; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;

function parseOwner(value: unknown): Owner | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.runId !== 'string') return undefined;
  return { sessionId: value.sessionId, runId: value.runId, ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}) };
}

export function parseRepoState(value: unknown): RepoState | undefined {
  if (!isRecord(value) || typeof value.repo !== 'string') return undefined;
  return {
    repo: value.repo,
    branch: str(value.branch) ?? null,
    detached: value.detached === true,
    head: str(value.head) ?? null,
    upstream: str(value.upstream) ?? null,
    ahead: num(value.ahead),
    behind: num(value.behind),
  };
}

export function parseRepos(data: unknown): RepoState[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.repos)) return undefined;
  const repos = data.repos.map(parseRepoState);
  return repos.every((r): r is RepoState => r !== undefined) ? repos : undefined;
}

function parseBranch(value: unknown): BranchInfo | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.sha !== 'string') return undefined;
  const owner = parseOwner(value.owner);
  const landing = Array.isArray(value.landingFor) ? value.landingFor.map(parseOwner).filter((o): o is Owner => o !== undefined) : [];
  return {
    name: value.name,
    sha: value.sha,
    upstream: str(value.upstream) ?? null,
    ahead: num(value.ahead),
    behind: num(value.behind),
    current: value.current === true,
    ...(str(value.date) ? { date: str(value.date) } : {}),
    ...(str(value.subject) ? { subject: str(value.subject) } : {}),
    ...(owner ? { owner } : {}),
    ...(landing.length > 0 ? { landingFor: landing.map(({ sessionId, runId }) => ({ sessionId, runId })) } : {}),
  };
}

function parseList<T>(value: unknown, one: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(one);
  return items.every((item): item is T => item !== undefined) ? items : undefined;
}

export function parseBranches(data: unknown): Branches | undefined {
  if (!isRecord(data) || typeof data.repo !== 'string') return undefined;
  const local = parseList(data.local, parseBranch);
  const ordewell = parseList(data.ordewell, parseBranch);
  const remote = parseList(data.remote, parseBranch);
  const stashes = parseList(data.stashes, (s): StashInfo | undefined =>
    isRecord(s) && typeof s.ref === 'string' && typeof s.sha === 'string' ? { ref: s.ref, sha: s.sha, message: str(s.message) ?? '' } : undefined);
  const worktrees = parseList(data.worktrees, (w): WorktreeInfo | undefined => {
    if (!isRecord(w) || typeof w.path !== 'string') return undefined;
    const owner = parseOwner(w.owner);
    return { path: w.path, branch: str(w.branch) ?? null, head: str(w.head) ?? null, main: w.main === true, ...(owner ? { owner } : {}) };
  });
  if (!local || !ordewell || !remote || !stashes || !worktrees) return undefined;
  return { repo: data.repo, current: str(data.current) ?? null, detached: data.detached === true, local, ordewell, remote, stashes, worktrees };
}

function parseCommit(value: unknown): CommitSummary | undefined {
  if (!isRecord(value) || typeof value.sha !== 'string') return undefined;
  const parents = strings(value.parents);
  const refs = strings(value.refs);
  if (!parents || !refs) return undefined;
  return {
    sha: value.sha, parents, refs,
    subject: str(value.subject) ?? '', author: str(value.author) ?? '', email: str(value.email) ?? '', date: str(value.date) ?? '',
  };
}

export function parseLog(data: unknown): LogPage | undefined {
  if (!isRecord(data) || typeof data.repo !== 'string') return undefined;
  const commits = parseList(data.commits, parseCommit);
  if (!commits) return undefined;
  return { repo: data.repo, ref: str(data.ref) ?? '', commits, cursor: str(data.cursor) ?? null };
}

export function parseCommitDetail(data: unknown): CommitDetail | undefined {
  if (!isRecord(data)) return undefined;
  const commit = parseCommit(data.commit);
  const files = parseList(data.files, (f): CommitFile | undefined =>
    isRecord(f) && typeof f.path === 'string'
      ? { path: f.path, status: str(f.status) ?? 'M', added: typeof f.added === 'number' ? f.added : null, removed: typeof f.removed === 'number' ? f.removed : null }
      : undefined);
  if (!commit || !files || !isRecord(data.commit)) return undefined;
  return { commit: { ...commit, body: str(data.commit.body) ?? '' }, files, ...(typeof data.patch === 'string' ? { patch: data.patch } : {}) };
}

function parseAction(data: unknown): ActionResult | undefined {
  if (!isRecord(data)) return undefined;
  const repo = parseRepoState(data.repo);
  if (!repo) return undefined;
  const stash = isRecord(data.stash) && typeof data.stash.sha === 'string' ? { sha: data.stash.sha, message: str(data.stash.message) ?? '' } : undefined;
  return { repo, ...(typeof data.warning === 'string' ? { warning: data.warning } : {}), ...(stash ? { stash } : {}) };
}

function unreadable(what: string): never {
  throw new Error(`The daemon sent ${what} this app cannot read.`);
}

export async function readRepos(workspace: string): Promise<RepoState[]> {
  return parseRepos(await callDaemon('git.repos', { workspace })) ?? unreadable('a repository list');
}

export async function readBranches(workspace: string, repo: string): Promise<Branches> {
  return parseBranches(await callDaemon('git.branches', { workspace, repo })) ?? unreadable('a branch list');
}

export async function readLog(workspace: string, repo: string, page: { ref?: string; cursor?: string; limit?: number } = {}): Promise<LogPage> {
  const params = {
    workspace, repo,
    ...(page.ref !== undefined ? { ref: page.ref } : {}),
    ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    ...(page.limit !== undefined ? { limit: String(page.limit) } : {}),
  };
  return parseLog(await callDaemon('git.log', params)) ?? unreadable('a history page');
}

/** A commit's message and files; with `path`, that file's patch as well. */
export async function readCommit(workspace: string, repo: string, sha: string, path?: string): Promise<CommitDetail> {
  const data = await callDaemon('git.show', { workspace, repo, sha, ...(path !== undefined ? { path } : {}) });
  return parseCommitDetail(data) ?? unreadable('a commit');
}

/** What the person sees named in a confirm, as the daemon will check it against the repository now. */
export type GitAction =
  | { route: 'git.branch'; name: string; from?: string; switch?: boolean }
  | { route: 'git.switch'; branch: string }
  | { route: 'git.branchDelete'; branch: string; unmerged: boolean }
  | { route: 'git.stash'; message?: string }
  | { route: 'git.stashPop'; stash: string }
  | { route: 'git.stashDrop'; stash: string }
  | { route: 'git.fetch' }
  | { route: 'git.pull'; remote: string; branch: string }
  | { route: 'git.push'; remote: string; branch: string };

function actionBody(action: GitAction): Record<string, unknown> {
  switch (action.route) {
    case 'git.branch': return { name: action.name, ...(action.from !== undefined ? { from: action.from } : {}), ...(action.switch !== undefined ? { switch: action.switch } : {}) };
    case 'git.switch': return { branch: action.branch };
    case 'git.branchDelete': return { branch: action.branch, confirm: { branch: action.branch, unmerged: action.unmerged } };
    case 'git.stash': return action.message !== undefined ? { message: action.message } : {};
    case 'git.stashPop':
    case 'git.stashDrop': return { stash: action.stash };
    case 'git.fetch': return {};
    case 'git.pull':
    case 'git.push': return { confirm: { remote: action.remote, branch: action.branch } };
  }
}

/** One action on the user's checkout of `repo`; a refusal throws a `DaemonError` carrying the daemon's code and body. */
export async function runGitAction(workspace: string, repo: string, action: GitAction): Promise<ActionResult> {
  const data = await callDaemon(action.route, {}, { workspace, repo, ...actionBody(action) });
  return parseAction(data) ?? unreadable('an action result');
}

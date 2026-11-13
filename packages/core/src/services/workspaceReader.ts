import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type {
  FileChangeStatus, FileContentResponse, FileFindMatch, FileFindResponse, FileTreeEntry, FileTreeResponse, GitDiffFile, GitDiffResponse,
  GitBranchesResponse, GitBranchInfo, GitCommitResponse, GitCommitSummary, GitLogResponse, GitRepoInfo, GitReposResponse,
  GitStatusChange, GitStatusResponse, GitWorktreeInfo, MergePreflightRepo, MergePreflightResponse, OrdewellRefOwner, ReadAt, ReadTarget, ViewScopeKind,
} from '../daemonContract';
import type { IConfig } from '../interfaces/IConfig';
import type { IsolationRun } from '../interfaces/IWorktreeIsolation';
import { savedPatchOf } from '../models/Handoff';
import { runsAsOps, type LegacyPlanState, type Task } from '../models/Task';
import { realPathOf } from '../utils/realPath';
import { listSessions, loadSession } from '../utils/sessionStore';
import { readTaskPatch } from '../utils/taskLogStore';
import { augmentedPath, withPath } from '../utils/shellPath';
import { cleanEnv, defaultExecFile, MAX_BUFFER, NO_HOOKS, tryGit, type GitExecFn, type GitInvoker } from './gitExec';
import { repoRootOf, SELF_REPO } from './isolationRecord';
import { landingsIn } from './LandingLedger';
import { hasGitEntry, workspaceRepoGroup } from './repoGroup';
import { stateRootOf } from './stateRoot';
import {
  allowedPath, readOnlyGitArgs, readSavedPatch, readTaskDiff, TASK_DIFF_NO_RECORD, TASK_DIFF_NO_RUN, TASK_DIFF_READ_ONLY, taskDiffUnavailable,
  type TaskDiffRead, type TaskDiffResult,
} from './taskDiffRead';

/**
 * The workspace reader (ADR-0064): what a person's own surfaces read of a
 * workspace's files and git, confined to one view scope of one repository.
 * It serves the user principal, so it shares nothing with the planner's
 * envelope (ADR-0008) but `allowedPath`, and it never takes a session's lease.
 */

export type WorkspaceReadErrorCode = 'gone' | 'path_refused' | 'path_not_found' | 'refused';

export class WorkspaceReadError extends Error {
  constructor(readonly code: WorkspaceReadErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceReadError';
  }
}

export interface WorkspaceReaderDeps {
  config: Pick<IConfig, 'workspaceRepos'>;
  resolvePath?: () => Promise<string>;
  exec?: GitExecFn;
  /** The largest file `content` answers with its text; a larger one answers `too-large` (ADR-0064 R5). */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_FIND_LIMIT = 200;
const MAX_FIND_LIMIT = 2000;
const PREVIEW_CHARS = 200;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 500;
const ORDEWELL_REFS = /^ordewell(-preserved)?\//;
// One field per placeholder, NUL between, a record separator after: a subject holds anything else.
const COMMIT_FORMAT = ['%H', '%P', '%D', '%s', '%an', '%ae', '%aI'].join('%x00') + '%x1e';
const CONFLICTED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const SKILLS = '.ordewell/skills';
// Git's own test for a binary file: a NUL among the first 8000 bytes.
const BINARY_SNIFF = 8000;

/** One resolved view scope: where its files are, read from disk or from one commit. */
interface Scope {
  at: ReadAt;
  /** Absolute, real: the directory the scope's paths are relative to, for a disk scope. */
  root: string | null;
  /** Where git runs for this scope. */
  cwd: string;
  /** The scope root's place in its repository, `/`-terminated or empty. */
  prefix: string;
  /** What the scope's changes are against: the checkout's HEAD, a run's or a task's starting commit. Null on an unborn branch. */
  base: string | null;
  /** Which task changed a path: the task a task scope is, or the run's landings on its integration branch. */
  changedBy: { task: string } | { landings: Array<{ taskId: string; merge: string }> } | null;
  /** Paths Ordewell linked into a task's worktree from the workspace: not the task's work. */
  linked: string[];
}

export interface FindOptions { query: string; text?: boolean; limit?: number }
export interface LogOptions { ref?: string; cursor?: string; limit?: number }
export interface DiffOptions { kind?: 'staged' | 'unstaged'; from?: string; to?: string; path?: string }

const execBuffer = promisify(execFile);

/**
 * A person may name any workspace path but one that leaves the workspace or
 * reaches git's or Ordewell's internals; `.ordewell/skills/` is committed by
 * design (ADR-0024), so it is the one part of `.ordewell` shown (ADR-0064 R3).
 */
export function userPath(file: string): boolean {
  if (allowedPath(file)) return true;
  if (file === SKILLS) return true;
  return file.startsWith(`${SKILLS}/`) && allowedPath(file.slice(SKILLS.length + 1));
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const SHA = /^[a-f0-9]{40,64}$/;
/** A run's own refs: `ordewell/<run>/…` and `ordewell-preserved/<run>/…`. */
const RUN_OF_REF = /^ordewell(?:-preserved)?\/([^/]+)\//;

function gone(why: string): never {
  throw new WorkspaceReadError('gone', why);
}

/** A directory a person may list: a user path, the root, or `.ordewell` itself, which shows only its skills. */
function listable(dir: string): boolean {
  return dir === '' || dir === '.ordewell' || userPath(dir);
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function nulList(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/** `git diff --name-status -z`, as path → status letter. */
function nameStatus(out: string): Map<string, FileChangeStatus> {
  const fields = nulList(out);
  const changes = new Map<string, FileChangeStatus>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const letter = fields[i][0];
    changes.set(fields[i + 1], letter === 'A' || letter === 'D' || letter === 'U' ? letter : 'M');
  }
  return changes;
}

function parseCommits(out: string): GitCommitSummary[] {
  return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((record) => {
    const [sha, parents, refs, subject, author, email, date] = record.split('\0');
    return {
      sha, parents: parents ? parents.split(' ') : [], subject, author, email, date,
      refs: refs ? refs.split(', ').flatMap((r) => r.replace(/^tag: /, '').split(' -> ')) : [],
    };
  });
}

/** `upstream:track,nobracket`: "ahead 1, behind 2", "gone" or nothing. */
function trackOf(track: string): { ahead: number; behind: number } {
  return { ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0) };
}

function parseWorktrees(out: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = [];
  let current: GitWorktreeInfo | null = null;
  for (const field of out.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), branch: null, head: null, main: worktrees.length === 0 };
      worktrees.push(current);
    } else if (current && field.startsWith('HEAD ')) current.head = field.slice(5);
    else if (current && field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '');
  }
  return worktrees;
}

function byKindThenName(a: FileTreeEntry, b: FileTreeEntry): number {
  const dirA = a.kind === 'directory' || a.kind === 'repository';
  const dirB = b.kind === 'directory' || b.kind === 'repository';
  if (dirA !== dirB) return dirA ? -1 : 1;
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A folder as the file system names it, to compare the names a run's record,
 * its state root and git give one place: on Windows a record may hold an 8.3
 * short name where git prints the long one, which the JS realpath keeps apart.
 */
function realOrSelf(file: string): string {
  try {
    return realPathOf(file);
  } catch {
    return path.resolve(file);
  }
}

function refusePath(file: string): never {
  throw new WorkspaceReadError('path_refused', `Refused path "${file}": name a workspace-relative path, without traversal, git's internals or Ordewell's state.`);
}

export function createWorkspaceReader(deps: WorkspaceReaderDeps) {
  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const baseExec = deps.exec ?? defaultExecFile;
  // No hook runs, no optional lock is taken, nothing is fetched: a read leaves the repository as it found it (ADR-0064 R6).
  const invoker: GitInvoker = {
    resolvePath: deps.resolvePath ?? (() => augmentedPath()),
    exec: (file, args, opts) => baseExec(file, [...NO_HOOKS, ...args], { ...opts, env: { ...opts.env, GIT_OPTIONAL_LOCKS: '0' } }),
  };

  async function gitOut(cwd: string, args: string[]): Promise<string> {
    const result = await tryGit(invoker, cwd, [...await readOnlyGitArgs(invoker, cwd), ...args]);
    if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || String(result.code ?? 'unknown error')}`);
    return result.stdout;
  }

  /** A blob's bytes: the string seam would mangle a binary file. */
  async function blobBytes(cwd: string, object: string): Promise<Buffer> {
    const env = withPath(cleanEnv(), await invoker.resolvePath());
    const common = await readOnlyGitArgs(invoker, cwd);
    const { stdout } = await execBuffer('git', [...NO_HOOKS, ...common, 'cat-file', 'blob', object], {
      cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'buffer', maxBuffer: MAX_BUFFER, windowsHide: true,
    });
    return stdout;
  }

  function repoOf(target: ReadTarget): string {
    const group = workspaceRepoGroup(target.workspace, deps.config.workspaceRepos);
    if (target.repo !== undefined) {
      if (!group.includes(target.repo)) throw new WorkspaceReadError('refused', `No repository "${target.repo}" in this workspace: it has ${group.map((r) => `"${r}"`).join(', ') || 'none'}.`);
      return target.repo;
    }
    if (group.length === 1) return group[0];
    throw new WorkspaceReadError('refused', group.length === 0 ? 'This workspace holds no repository.' : `Name a repository: this workspace has ${group.length}.`);
  }

  async function checkoutScope(target: ReadTarget, repo: string): Promise<Scope> {
    const root = fs.realpathSync(repoRootOf(target.workspace, repo));
    const prefix = repo === SELF_REPO ? (await gitOut(root, ['rev-parse', '--show-prefix'])).trim() : '';
    const head = await tryGit(invoker, root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    const branch = await tryGit(invoker, root, ['symbolic-ref', '-q', '--short', 'HEAD']);
    return {
      at: { repo, scope: 'checkout', source: 'disk', commit: head.ok ? head.stdout.trim() : null, branch: branch.ok ? branch.stdout.trim() : null },
      root, cwd: root, prefix, base: head.ok ? head.stdout.trim() : null, changedBy: null, linked: [],
    };
  }

  /** A session's saved run, read from its record on disk without adopting the session (ADR-0064 R4). */
  function savedRun(workspace: string, sessionId: string): { plan: LegacyPlanState; run: IsolationRun | undefined } {
    const loaded = loadSession(sessionId, workspace);
    if (!loaded) gone(`No session "${sessionId}" is saved in this workspace.`);
    return { plan: loaded.plan, run: loaded.plan.isolation?.run };
  }

  function runOf(target: ReadTarget, repo: string): { run: IsolationRun; repo: IsolationRun['repos'][number] } {
    if (!target.sessionId) throw new WorkspaceReadError('refused', `Name the session whose ${target.scope ?? 'checkout'} scope to read.`);
    const { run } = savedRun(target.workspace, target.sessionId);
    if (!run) gone(`Session "${target.sessionId}" has no isolated run: it has no integration branch or task worktrees.`);
    const entry = run.repos.find((r) => r.path === repo);
    if (!entry) gone(`The run of session "${target.sessionId}" does not cover repository ${repo}.`);
    // The record is on disk, where a task can write: a repository it names outside the run's state root is not the run's.
    if (!fs.existsSync(entry.root) || !inside(realOrSelf(stateRootOf(run)), realOrSelf(entry.root))) gone(`Repository ${repo} of this run is no longer where its record says.`);
    return { run, repo: entry };
  }

  async function branchTip(cwd: string, branch: string): Promise<string | null> {
    const tip = await tryGit(invoker, cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
    return tip.ok ? tip.stdout.trim() : null;
  }

  async function prefixOf(cwd: string, repo: string): Promise<string> {
    return repo === SELF_REPO ? (await gitOut(cwd, ['rev-parse', '--show-prefix'])).trim() : '';
  }

  async function integrationScope(target: ReadTarget, repo: string): Promise<Scope> {
    const { run, repo: entry } = runOf(target, repo);
    const commit = await branchTip(entry.root, entry.integrationBranch);
    if (commit === null) gone(`The integration branch ${entry.integrationBranch} is gone: the run was merged or discarded.`);
    const landings = landingsIn(run, repo).filter(({ merge }) => SHA.test(merge));
    return {
      at: { repo, scope: 'integration', source: 'commit', commit, branch: entry.integrationBranch },
      root: null, cwd: entry.root, prefix: await prefixOf(entry.root, repo), base: SHA.test(entry.baseRef) ? entry.baseRef : null,
      changedBy: { landings }, linked: [],
    };
  }

  /** A task's worktree while it is there, else its branch; once both are gone, `gone` (ADR-0064 R2). */
  async function taskScope(target: ReadTarget, repo: string): Promise<Scope> {
    if (!target.taskId) throw new WorkspaceReadError('refused', 'Name the task whose scope to read.');
    const { run, repo: runRepo } = runOf(target, repo);
    const record = run.tasks[target.taskId];
    if (!record) gone(`Task "${target.taskId}" has no worktree or branch in this run.`);
    // Ordewell runs no git in a read-only task's worktree, which its sealed runs may have written (ADR-0046); its report is its result.
    if (record.readOnly) gone(`Task "${target.taskId}" is read-only: Ordewell reads nothing from its worktree. Its report is its result.`);
    const entry = record.repos[repo];
    if (!entry) gone(`Task "${target.taskId}" has no share of repository ${repo}.`);
    const prefix = await prefixOf(runRepo.root, repo);
    const base = entry.baseRef && SHA.test(entry.baseRef) ? entry.baseRef : null;
    const changedBy = { task: record.taskId };
    if (record.status !== 'merged' && fs.existsSync(entry.worktree)) {
      const worktree = fs.realpathSync(entry.worktree);
      if (!inside(realOrSelf(stateRootOf(run)), realOrSelf(worktree))) gone(`The worktree of task "${target.taskId}" is no longer where its record says.`);
      const toplevel = await tryGit(invoker, worktree, ['rev-parse', '--show-toplevel']);
      if (!toplevel.ok || realOrSelf(toplevel.stdout.trim()) !== realOrSelf(worktree)) gone(`The worktree of task "${target.taskId}" is no longer a repository.`);
      const root = fs.realpathSync(path.join(worktree, prefix));
      const head = await tryGit(invoker, root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
      return {
        at: { repo, scope: 'task', source: 'disk', commit: head.ok ? head.stdout.trim() : null, branch: record.branch },
        root, cwd: root, prefix, base, changedBy, linked: entry.linked,
      };
    }
    const commit = await branchTip(runRepo.root, record.branch);
    if (commit === null) gone(`Task "${target.taskId}" is gone: its worktree was pruned and its branch ${record.branch} deleted.`);
    return {
      at: { repo, scope: 'task', source: 'commit', commit, branch: record.branch },
      root: null, cwd: runRepo.root, prefix, base, changedBy, linked: [],
    };
  }

  async function scopeOf(target: ReadTarget): Promise<Scope> {
    const kind: ViewScopeKind = target.scope ?? 'checkout';
    const repo = repoOf(target);
    if (kind === 'checkout') return checkoutScope(target, repo);
    if (kind === 'integration') return integrationScope(target, repo);
    if (kind === 'task') return taskScope(target, repo);
    throw new WorkspaceReadError('refused', `Unknown scope "${String(kind)}".`);
  }

  /** Which task changed each path below `spec`, by the scope's record: the last landing that touched it wins. */
  async function changersOf(scope: Scope, spec: string[], changed: Iterable<string>): Promise<Map<string, string>> {
    const by = new Map<string, string>();
    if (scope.changedBy === null) return by;
    if ('task' in scope.changedBy) {
      for (const file of changed) by.set(file, scope.changedBy.task);
      return by;
    }
    for (const { taskId, merge } of scope.changedBy.landings) {
      const parent = await tryGit(invoker, scope.cwd, ['rev-parse', '--verify', '-q', `${merge}^1`]);
      if (!parent.ok) continue;
      const files = await gitOut(scope.cwd, ['diff', '--no-ext-diff', '--no-renames', '--relative', '--name-only', '-z', parent.stdout.trim(), merge, '--', ...spec]);
      for (const file of nulList(files)) by.set(file, taskId);
    }
    return by;
  }

  /** The real path of `file` on a disk scope, refused when it leaves the scope root or resolves onto a refused path. */
  function onDisk(scope: { root: string }, file: string, allowed: (rel: string) => boolean = userPath): string {
    const full = path.join(scope.root, file);
    let real: string;
    try {
      real = fs.realpathSync(full);
    } catch {
      throw new WorkspaceReadError('path_not_found', `No file "${file}" in this scope.`);
    }
    const rel = path.relative(scope.root, real).split(path.sep).join('/');
    if (!inside(scope.root, real) || (rel !== '' && !allowed(rel))) refusePath(file);
    return real;
  }

  /** What changed below `dir` against the scope's base, by path relative to the scope root, and its untracked files. */
  async function changesBelow(scope: Scope, dir: string): Promise<{ changed: Map<string, FileChangeStatus>; untracked: string[] }> {
    const spec = dir === '' ? ['.'] : [`:(literal)${dir}`];
    const base = scope.base ?? EMPTY_TREE;
    const to = scope.root === null && scope.at.commit !== null ? [scope.at.commit] : [];
    const changed = nameStatus(await gitOut(scope.cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative', '--name-status', '-z', base, ...to, '--', ...spec]));
    const untracked = scope.root === null ? [] : nulList(await gitOut(scope.cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...spec]))
      .filter((file) => !scope.linked.some((link) => file === link || file.startsWith(`${link}/`)));
    return { changed, untracked };
  }

  /** Which of `paths` git ignores, a directory named with its trailing slash. */
  async function ignoredOf(scope: Scope, paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const common = await readOnlyGitArgs(invoker, scope.cwd);
    const result = await tryGit(invoker, scope.cwd, [...common, 'check-ignore', '-z', '--stdin'], paths.join('\0') + '\0');
    // Exit 1 is git's "none of them".
    if (!result.ok && result.code !== 1) throw new Error(`git check-ignore failed: ${result.stderr.trim()}`);
    return new Set(nulList(result.stdout));
  }

  async function tree(target: ReadTarget, dir: string): Promise<FileTreeResponse> {
    const rel = dir.split('\\').join('/').replace(/\/+$/, '');
    if (!listable(rel)) refusePath(dir);
    const scope = await scopeOf(target);
    const join = (name: string) => (rel === '' ? name : `${rel}/${name}`);
    const entries = scope.root === null ? await entriesAt(scope, rel, dir) : entriesOnDisk({ ...scope, root: scope.root }, rel, dir);
    const { changed, untracked } = await changesBelow(scope, rel);
    const childOf = (file: string): string | null => {
      const below = rel === '' ? file : file.startsWith(`${rel}/`) ? file.slice(rel.length + 1) : null;
      return below === null ? null : below.split('/')[0];
    };
    const statuses = new Map<string, FileChangeStatus>();
    const changers = await changersOf(scope, rel === '' ? ['.'] : [`:(literal)${rel}`], [...changed.keys(), ...untracked]);
    // A directory is credited to a task only when that task alone changed what is below it.
    const changerOf = new Map<string, string | null>();
    for (const [file, taskId] of changers) {
      const child = childOf(file);
      if (child === null || !(changed.has(file) || untracked.includes(file))) continue;
      changerOf.set(child, changerOf.has(child) && changerOf.get(child) !== taskId ? null : taskId);
    }
    for (const [file, status] of changed) {
      const child = childOf(file);
      if (child === null) continue;
      const direct = join(child) === file;
      statuses.set(child, direct ? status : 'M');
      // A file deleted from disk is still listed, so a person sees what went.
      if (direct && status === 'D' && !entries.some((e) => e.name === child)) entries.push({ name: child, path: file, kind: 'file', ignored: false });
    }
    for (const file of untracked) {
      const child = childOf(file);
      if (child !== null && !statuses.has(child)) statuses.set(child, '?');
    }
    // A commit holds no ignored file but one forced in, and the rules on disk are not the commit's.
    const ignored = scope.root === null ? new Set<string>() : await ignoredOf(scope, entries.filter((e) => e.kind !== 'symlink').map((e) => (e.kind === 'file' ? e.path : `${e.path}/`)));
    for (const entry of entries) {
      const status = statuses.get(entry.name);
      if (status) entry.status = status;
      const taskId = status ? changerOf.get(entry.name) : undefined;
      if (taskId) entry.taskId = taskId;
      entry.ignored = ignored.has(entry.path) || ignored.has(`${entry.path}/`);
    }
    return { at: scope.at, dir: rel, entries: entries.sort(byKindThenName) };
  }

  function entriesOnDisk(scope: Scope & { root: string }, rel: string, dir: string): FileTreeEntry[] {
    const real = rel === '' ? scope.root : onDisk(scope, rel, listable);
    if (!fs.statSync(real).isDirectory()) throw new WorkspaceReadError('path_not_found', `"${dir}" is not a directory.`);
    const entries: FileTreeEntry[] = [];
    for (const dirent of fs.readdirSync(real, { withFileTypes: true })) {
      const entryPath = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      const shown = userPath(entryPath) || (entryPath === '.ordewell' && fs.existsSync(path.join(scope.root, SKILLS)));
      if (!shown) continue;
      const kind: FileTreeEntry['kind'] = dirent.isSymbolicLink() ? 'symlink'
        : dirent.isDirectory() ? (hasGitEntry(path.join(real, dirent.name)) ? 'repository' : 'directory') : 'file';
      entries.push({ name: dirent.name, path: entryPath, kind, ignored: false });
    }
    return entries;
  }

  /** `ls-tree -z` of one path or one directory's children, relative to the scope root. */
  async function treeEntries(scope: Scope, spec: string): Promise<Array<{ mode: string; type: string; object: string; path: string }>> {
    if (scope.at.commit === null) return [];
    return nulList(await gitOut(scope.cwd, ['ls-tree', '-z', scope.at.commit, '--', spec])).flatMap((row) => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
      return match ? [{ mode: match[1], type: match[2], object: match[3], path: match[4] }] : [];
    });
  }

  async function entriesAt(scope: Scope, rel: string, dir: string): Promise<FileTreeEntry[]> {
    if (rel !== '') {
      const [self] = await treeEntries(scope, rel);
      if (!self) throw new WorkspaceReadError('path_not_found', `No directory "${dir}" in this scope.`);
      if (self.type !== 'tree') throw new WorkspaceReadError('path_not_found', `"${dir}" is not a directory.`);
    }
    const listed = await treeEntries(scope, rel === '' ? './' : `${rel}/`);
    const skills = rel === '' && (await treeEntries(scope, SKILLS)).length > 0;
    const entries: FileTreeEntry[] = [];
    for (const item of listed) {
      if (!(userPath(item.path) || (item.path === '.ordewell' && skills))) continue;
      const kind: FileTreeEntry['kind'] = item.mode === '120000' ? 'symlink' : item.type === 'tree' ? 'directory' : item.type === 'commit' ? 'repository' : 'file';
      entries.push({ name: item.path.slice(item.path.lastIndexOf('/') + 1), path: item.path, kind, ignored: false });
    }
    return entries;
  }

  function limitOf(limit: number | undefined): number {
    return Math.max(1, Math.min(MAX_FIND_LIMIT, Math.floor(limit ?? DEFAULT_FIND_LIMIT)));
  }

  /** Quick open matches names; a text search reads what git would, ignored files left out (ADR-0064 R5). */
  async function find(target: ReadTarget, options: FindOptions): Promise<FileFindResponse> {
    const scope = await scopeOf(target);
    const limit = limitOf(options.limit);
    const query = options.query;
    if (query.trim() === '') throw new WorkspaceReadError('refused', 'Name something to find.');
    const matches: FileFindMatch[] = [];
    let truncated = false;
    if (options.text) {
      const where = scope.root !== null ? ['--untracked', '--exclude-standard'] : [];
      const object = scope.root !== null ? [] : [scope.at.commit ?? EMPTY_TREE];
      const result = await tryGit(invoker, scope.cwd, [
        ...await readOnlyGitArgs(invoker, scope.cwd), 'grep', ...where, '-I', '-n', '-z', '-i', '-F', '--no-color', '--full-name',
        `--max-count=${limit + 1}`, '-e', query, ...object, '--', '.',
      ]);
      if (!result.ok && result.code !== 1) throw new Error(`git grep failed: ${result.stderr.trim()}`);
      for (const line of result.stdout.split('\n')) {
        const [named, number, ...rest] = line.split('\0');
        if (number === undefined) continue;
        const repoPath = object.length ? named.slice(object[0].length + 1) : named;
        const file = repoPath.startsWith(scope.prefix) ? repoPath.slice(scope.prefix.length) : null;
        if (file === null || !userPath(file)) continue;
        if (matches.length === limit) { truncated = true; break; }
        matches.push({ path: file, line: Number(number), preview: rest.join('\0').trim().slice(0, PREVIEW_CHARS) });
      }
      return { at: scope.at, query, mode: 'text', matches, truncated };
    }
    const needle = query.toLowerCase();
    for (const file of await filesOf(scope)) {
      if (!file.toLowerCase().includes(needle) || !userPath(file)) continue;
      if (matches.length === limit) { truncated = true; break; }
      matches.push({ path: file });
    }
    return { at: scope.at, query, mode: 'name', matches, truncated };
  }

  /** Every file of the scope, relative to its root: what git tracks or would, on disk; what the commit holds, otherwise. */
  async function filesOf(scope: Scope): Promise<string[]> {
    if (scope.root === null) {
      if (scope.at.commit === null) return [];
      return nulList(await gitOut(scope.cwd, ['ls-tree', '-r', '-z', '--name-only', scope.at.commit, '--', '.']));
    }
    const root = scope.root;
    const listed = nulList(await gitOut(scope.cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--', '.']));
    return [...new Set(listed)].filter((file) => fs.existsSync(path.join(root, file)));
  }

  async function status(target: ReadTarget): Promise<GitStatusResponse> {
    const scope = await scopeOf(target);
    if (scope.root === null) throw new WorkspaceReadError('refused', 'A scope read from a commit has no working tree status.');
    const fields = nulList(await gitOut(scope.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']));
    const answer: GitStatusResponse = { at: scope.at, staged: [], unstaged: [], untracked: [], conflicted: [] };
    const local = (file: string) => (file.startsWith(scope.prefix) ? file.slice(scope.prefix.length) : null);
    for (let i = 0; i < fields.length; i++) {
      const xy = fields[i].slice(0, 2);
      const file = local(fields[i].slice(3));
      // A rename or copy carries its source as the next field.
      const from = xy[0] === 'R' || xy[0] === 'C' ? local(fields[++i]) : null;
      if (file === null || !userPath(file)) continue;
      if (xy === '??') answer.untracked.push(file);
      else if (CONFLICTED.has(xy)) answer.conflicted.push(file);
      else {
        if (xy[0] !== ' ') answer.staged.push({ path: file, status: xy[0], ...(from !== null ? { from } : {}) });
        if (xy[1] !== ' ') answer.unstaged.push({ path: file, status: xy[1] });
      }
    }
    const byPath = (a: GitStatusChange, b: GitStatusChange) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    answer.staged.sort(byPath);
    answer.unstaged.sort(byPath);
    answer.untracked.sort();
    answer.conflicted.sort();
    return answer;
  }

  /** A ref a person names, as the commit it is now: never an option git would read, never a range. */
  async function commitOf(scope: Scope, ref: string): Promise<string> {
    if (ref === '' || ref.startsWith('-') || ref.includes('..') || /[\s\0]/.test(ref)) throw new WorkspaceReadError('refused', `Refused ref "${ref}".`);
    const resolved = await tryGit(invoker, scope.cwd, ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`]);
    if (!resolved.ok) throw new WorkspaceReadError('path_not_found', `No commit "${ref}" in repository ${scope.at.repo}.`);
    return resolved.stdout.trim();
  }

  async function diff(target: ReadTarget, options: DiffOptions): Promise<GitDiffResponse> {
    const file = options.path === undefined ? undefined : checked(options.path);
    const scope = await scopeOf(target);
    let range: string[];
    let from: string | null;
    let to: string | null;
    if (options.from !== undefined || options.to !== undefined) {
      from = options.from !== undefined ? await commitOf(scope, options.from) : scope.base;
      to = options.to !== undefined ? await commitOf(scope, options.to) : scope.root === null ? scope.at.commit : null;
      range = [from ?? EMPTY_TREE, ...(to !== null ? [to] : [])];
    } else if (options.kind !== undefined) {
      if (scope.at.scope !== 'checkout') throw new WorkspaceReadError('refused', 'Only the checkout has an index to diff.');
      from = options.kind === 'staged' ? scope.base : null;
      to = null;
      range = options.kind === 'staged' ? ['--cached', scope.base ?? EMPTY_TREE] : [];
    } else {
      from = scope.base;
      to = scope.root === null ? scope.at.commit : null;
      range = [from ?? EMPTY_TREE, ...(to !== null ? [to] : [])];
    }
    const { files, patch } = await diffFiles(scope, range, file);
    return { at: scope.at, from, to, files, ...(patch !== undefined ? { patch } : {}) };
  }

  /** A diff's files with their counts, then, when one is named, that file's patch alone (ADR-0064 R5). */
  async function diffFiles(scope: Scope, range: string[], file: string | undefined): Promise<{ files: GitDiffFile[]; patch?: string }> {
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative', ...range];
    const spec = file === undefined ? ['.'] : [`:(literal)${file}`];
    const statuses = nameStatus(await gitOut(scope.cwd, [...args, '--name-status', '-z', '--', ...spec]));
    const counts = nulList(await gitOut(scope.cwd, [...args, '--numstat', '-z', '--', ...spec]));
    const files: GitDiffFile[] = [];
    for (const entry of counts) {
      const [added, removed, name] = entry.split('\t');
      if (name === undefined || !userPath(name)) continue;
      files.push({ path: name, status: statuses.get(name) ?? 'M', added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) });
    }
    if (file === undefined) return { files };
    return { files, patch: await gitOut(scope.cwd, [...args, '--', ...spec]) };
  }

  /**
   * One page of a ref's history. The cursor pins the tip the first page read
   * and counts what was shown, so a page follows on from the last even as the
   * branch moves (ADR-0064 R5).
   */
  async function log(target: ReadTarget, options: LogOptions): Promise<GitLogResponse> {
    const scope = await scopeOf(target);
    const limit = Math.max(1, Math.min(MAX_LOG_LIMIT, Math.floor(options.limit ?? DEFAULT_LOG_LIMIT)));
    const ref = options.ref ?? scope.at.branch ?? 'HEAD';
    let tip: string;
    let skip = 0;
    if (options.cursor !== undefined) {
      const cursor = /^([a-f0-9]{40,64}):(\d+)$/.exec(options.cursor);
      if (!cursor) throw new WorkspaceReadError('refused', 'Refused log cursor: pass back the one a page answered.');
      [tip, skip] = [cursor[1], Number(cursor[2])];
    } else if (options.ref === undefined && scope.at.commit === null) {
      return { repo: scope.at.repo, ref, commits: [], cursor: null };
    } else {
      tip = options.ref === undefined && scope.at.commit !== null ? scope.at.commit : await commitOf(scope, ref);
    }
    const out = await gitOut(scope.cwd, ['log', '--no-color', '--no-show-signature', `--format=${COMMIT_FORMAT}`, `--skip=${skip}`, `--max-count=${limit + 1}`, tip, '--']);
    const commits = parseCommits(out);
    const more = commits.length > limit;
    return { repo: scope.at.repo, ref, commits: commits.slice(0, limit), cursor: more ? `${tip}:${skip + limit}` : null };
  }

  async function commit(target: ReadTarget, sha: string, file?: string): Promise<GitCommitResponse> {
    const named = file === undefined ? undefined : checked(file);
    const scope = await scopeOf(target);
    const resolved = await commitOf(scope, sha);
    const out = await gitOut(scope.cwd, ['show', '-s', '--no-color', '--no-show-signature', `--format=${COMMIT_FORMAT.replace('%x1e', '%x00%b%x1e')}`, resolved, '--']);
    const end = out.lastIndexOf('\x1e');
    const record = end < 0 ? out : out.slice(0, end);
    const body = record.split('\0')[7] ?? '';
    const [summary] = parseCommits(record.split('\0').slice(0, 7).join('\0') + '\x1e');
    // Against its first parent, as a merge's own change is read; a root commit against nothing.
    const { files, patch } = await diffFiles(scope, [summary.parents[0] ?? EMPTY_TREE, resolved], named);
    return { repo: scope.at.repo, commit: { ...summary, body: body.trim() }, files, ...(patch !== undefined ? { patch } : {}) };
  }

  async function branches(target: ReadTarget): Promise<GitBranchesResponse> {
    const scope = await scopeOf(target);
    const cwd = scope.cwd;
    const refs = await gitOut(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)%00%(committerdate:iso-strict)%00%(contents:subject)', 'refs/heads', 'refs/remotes']);
    const answer: GitBranchesResponse = { repo: scope.at.repo, current: null, detached: false, local: [], ordewell: [], remote: [], stashes: [], worktrees: [] };
    for (const line of refs.split('\n').filter(Boolean)) {
      // The subject is last and git folds it to one line; NUL cannot occur in a commit message, so no subject can split a field.
      const [refname, sha, upstream, track, head, date, subject] = line.split('\0');
      const local = refname.startsWith('refs/heads/');
      const name = refname.replace(/^refs\/(heads|remotes)\//, '');
      if (!local && name.endsWith('/HEAD')) continue;
      const branch: GitBranchInfo = { name, sha, upstream: upstream || null, ...trackOf(track), current: head === '*', date: date ?? '', subject: subject ?? '' };
      if (branch.current) answer.current = name;
      (local ? (ORDEWELL_REFS.test(name) ? answer.ordewell : answer.local) : answer.remote).push(branch);
    }
    answer.detached = answer.current === null && (await tryGit(invoker, cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).ok;
    const stashes = await tryGit(invoker, cwd, ['stash', 'list', '--no-color', '--format=%gd%x00%H%x00%gs']);
    if (stashes.ok) {
      for (const line of stashes.stdout.split('\n').filter(Boolean)) {
        const [ref, sha, message] = line.split('\0');
        answer.stashes.push({ ref, sha, message });
      }
    }
    answer.worktrees = parseWorktrees(await gitOut(cwd, ['worktree', 'list', '--porcelain', '-z']));
    const owners = ownersIn(target.workspace, scope.at.repo);
    for (const branch of answer.ordewell) {
      const owner = owners.branches.get(branch.name) ?? owners.runs.get(RUN_OF_REF.exec(branch.name)?.[1] ?? '');
      if (owner) branch.owner = owner;
    }
    for (const branch of answer.local) {
      const landing = owners.landings.get(branch.name);
      if (landing) branch.landingFor = landing;
    }
    for (const worktree of answer.worktrees) {
      const owner = owners.worktrees.get(realOrSelf(worktree.path)) ?? (worktree.branch ? owners.branches.get(worktree.branch) : undefined);
      if (owner) worktree.owner = owner;
    }
    return answer;
  }

  /** What the workspace's saved runs say of one repository's refs: whose each branch and worktree is, and what each lands on. */
  function ownersIn(workspace: string, repo: string) {
    const owners = {
      runs: new Map<string, OrdewellRefOwner>(),
      branches: new Map<string, OrdewellRefOwner>(),
      worktrees: new Map<string, OrdewellRefOwner>(),
      landings: new Map<string, Array<{ sessionId: string; runId: string }>>(),
    };
    for (const meta of listSessions(workspace)) {
      const run = loadSession(meta.id, workspace)?.plan.isolation?.run;
      const entry = run?.repos.find((r) => r.path === repo);
      if (!run || !entry) continue;
      const of = { sessionId: meta.id, runId: run.id };
      owners.runs.set(run.id, of);
      owners.branches.set(entry.integrationBranch, of);
      if (entry.baseBranch) owners.landings.set(entry.baseBranch, [...(owners.landings.get(entry.baseBranch) ?? []), of]);
      for (const record of Object.values(run.tasks)) {
        const share = record.repos[repo];
        if (!share) continue;
        const owner = { ...of, taskId: record.taskId };
        owners.branches.set(record.branch, owner);
        owners.worktrees.set(realOrSelf(share.worktree), owner);
      }
    }
    return owners;
  }

  async function repos(workspace: string): Promise<GitReposResponse> {
    const group = workspaceRepoGroup(workspace, deps.config.workspaceRepos);
    const answer: GitRepoInfo[] = [];
    for (const repo of group) {
      const cwd = repoRootOf(workspace, repo);
      const head = await tryGit(invoker, cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
      const branch = await tryGit(invoker, cwd, ['symbolic-ref', '-q', '--short', 'HEAD']);
      const info: GitRepoInfo = { repo, branch: branch.ok ? branch.stdout.trim() : null, detached: !branch.ok && head.ok, head: head.ok ? head.stdout.trim() : null, upstream: null, ahead: 0, behind: 0 };
      if (info.branch !== null) {
        const tracked = await gitOut(cwd, ['for-each-ref', '--format=%(upstream:short)%00%(upstream:track,nobracket)', `refs/heads/${info.branch}`]);
        const [upstream, track] = tracked.trim().split('\0');
        if (upstream) Object.assign(info, { upstream }, trackOf(track ?? ''));
      }
      answer.push(info);
    }
    return { repos: answer };
  }

  function checked(file: string): string {
    if (!userPath(file)) refusePath(file);
    return file.split('\\').join('/');
  }

  function answer(at: ReadAt, file: string, bytes: Buffer): FileContentResponse {
    if (bytes.subarray(0, BINARY_SNIFF).includes(0)) return { at, path: file, kind: 'binary', size: bytes.length };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { at, path: file, kind: 'binary', size: bytes.length };
    }
    return { at, path: file, kind: 'text', text, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  }

  async function content(target: ReadTarget, file: string): Promise<FileContentResponse> {
    const rel = checked(file);
    const scope = await scopeOf(target);
    if (scope.root !== null) {
      const real = onDisk({ ...scope, root: scope.root }, rel);
      const stat = fs.statSync(real);
      if (!stat.isFile()) throw new WorkspaceReadError('path_not_found', `"${file}" is not a file.`);
      if (stat.size > maxFileBytes) return { at: scope.at, path: rel, kind: 'too-large', size: stat.size, limit: maxFileBytes };
      return answer(scope.at, rel, fs.readFileSync(real));
    }
    const [blob] = await treeEntries(scope, rel);
    if (!blob || blob.path !== rel) throw new WorkspaceReadError('path_not_found', `No file "${file}" in this scope.`);
    // A link in a commit has no disk to resolve against, so it is shown as a link and never followed (ADR-0064 R3).
    if (blob.mode === '120000') refusePath(file);
    if (blob.type !== 'blob') throw new WorkspaceReadError('path_not_found', `"${file}" is not a file.`);
    const size = Number((await gitOut(scope.cwd, ['cat-file', '-s', blob.object])).trim());
    if (size > maxFileBytes) return { at: scope.at, path: rel, kind: 'too-large', size, limit: maxFileBytes };
    return answer(scope.at, rel, await blobBytes(scope.cwd, blob.object));
  }

  /**
   * Why a task with no record in the saved run has no diff, by what the plan
   * says it is: what tells a task that works in the checkout, or lands
   * nothing, from one whose worktree is not saved yet. A task's status here
   * cannot tell a preparing task from an ended one: loading a session fails
   * every task that was running, so a surface judges that by the live status.
   */
  function withoutRecord(plan: LegacyPlanState, task: Task, run: IsolationRun | undefined): TaskDiffResult {
    if (runsAsOps(task)) return taskDiffUnavailable('not-attributable', 'Task diff is not available for an ops task: it works in the checkout, where its changes are not told apart from anyone else\'s.');
    if (task.readOnly) return taskDiffUnavailable('read-only', TASK_DIFF_READ_ONLY);
    if (run) return taskDiffUnavailable('no-record', TASK_DIFF_NO_RECORD);
    if (plan.mergedRun) return taskDiffUnavailable('not-attributable', 'Task diff is not available: this session\'s run was merged and closed, and its task records went with it.');
    return taskDiffUnavailable('no-run', TASK_DIFF_NO_RUN);
  }

  /**
   * A task's diff as the run reads it for a verdict and VS Code, through
   * `readTaskDiff`, or the patch a read-only task saved (ADR-0050). Names are
   * those a person may be shown (ADR-0064 R3).
   */
  async function taskDiff(workspace: string, sessionId: string, taskId: string, options: Pick<TaskDiffRead, 'repo' | 'path'> & { names?: boolean }): Promise<TaskDiffResult> {
    if (options.path !== undefined) checked(options.path);
    const { plan, run } = savedRun(workspace, sessionId);
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) gone(`No task "${taskId}" in session "${sessionId}".`);
    const saved = savedPatchOf(task.handoff);
    const read = saved
      ? readSavedPatch(readTaskPatch({ baseDir: workspace, sessionId }, taskId, saved.attempt), saved, options)
      : run?.tasks[taskId] ? await readTaskDiff(invoker, run, taskId, options) : withoutRecord(plan, task, run);
    if (!options.names || !read.available) return read;
    return { available: true, text: read.text.split('\0').filter((name) => name && userPath(name)).join('\0') };
  }

  /**
   * The user's checkout of a target's repository, resolved as a read resolves
   * it: what a write to it starts from (ADR-0062 G1).
   */
  async function checkout(target: Pick<ReadTarget, 'workspace' | 'repo'>): Promise<CheckoutScope> {
    const repo = repoOf(target);
    const scope = await checkoutScope(target, repo);
    return { repo, root: scope.root as string, prefix: scope.prefix, at: scope.at };
  }

  /**
   * Where a write of `file` lands in a checkout, confined as a read is (R3):
   * the file may not exist yet, so the nearest directory that does is what
   * must resolve inside the checkout (ADR-0062 G10).
   */
  function writable(root: string, file: string): string {
    const rel = checked(file);
    if (fs.existsSync(path.join(root, rel))) return onDisk({ root }, rel);
    let existing = path.dirname(path.join(root, rel));
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const real = path.join(fs.realpathSync(existing), path.relative(existing, path.join(root, rel)));
    const relReal = path.relative(root, real).split(path.sep).join('/');
    if (!inside(root, real) || relReal === '' || !userPath(relReal)) refusePath(file);
    return real;
  }

  /**
   * What stands in Merge all's way in each repository (ADR-0062 G8): the
   * person's uncommitted files the merge would bring in, which a stash of
   * those files alone clears, and whether anything else is uncommitted.
   */
  async function mergePreflight(workspace: string, sessionId: string): Promise<MergePreflightResponse> {
    const { run } = savedRun(workspace, sessionId);
    if (!run) gone(`Session "${sessionId}" has no isolated run, so nothing to merge.`);
    const repos: MergePreflightRepo[] = [];
    for (const entry of run.repos) {
      // The record is on disk: a repository it names must still be one of the workspace's.
      const target = { workspace, repo: repoOf({ workspace, repo: entry.path }) };
      const scope = await checkoutScope(target, target.repo);
      const tip = await branchTip(scope.cwd, entry.integrationBranch);
      const incoming = new Set<string>();
      if (tip !== null) {
        const fork = await tryGit(invoker, scope.cwd, ['merge-base', 'HEAD', tip]);
        const from = fork.ok ? fork.stdout.trim() : EMPTY_TREE;
        for (const file of nulList(await gitOut(scope.cwd, ['diff', '--no-ext-diff', '--no-renames', '--relative', '--name-only', '-z', from, tip]))) incoming.add(file);
      }
      const now = await status(target);
      const dirty = new Set<string>([...now.untracked, ...now.conflicted]);
      for (const change of [...now.staged, ...now.unstaged]) {
        dirty.add(change.path);
        if (change.from) dirty.add(change.from);
      }
      const overlap = [...dirty].filter((file) => incoming.has(file)).sort();
      repos.push({ repo: target.repo, branch: entry.startedDetached ? null : entry.baseBranch ?? null, overlap, otherDirty: dirty.size > overlap.length });
    }
    return { runId: run.id, repos, stashMessage: `ordewell: before Merge all of ${run.id}` };
  }

  return { repos, tree, content, find, status, diff, log, commit, branches, taskDiff, checkout, writable, mergePreflight };
}

/** A repository's checkout, resolved for a write: `root` is real, `prefix` the root's place in its repository. */
export interface CheckoutScope {
  repo: string;
  root: string;
  prefix: string;
  at: ReadAt;
}

export type WorkspaceReader = ReturnType<typeof createWorkspaceReader>;

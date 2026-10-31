import { readTaskDiff, type TaskDiffRead, type TaskDiffResult } from './taskDiffRead';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { IConfig } from '../interfaces/IConfig';
import type {
  IsolationAvailability,
  IIsolationPreview,
  IsolationHandoff,
  IsolationInactiveReason,
  IsolationMergeBlock,
  IsolationMergeBlockReason,
  IsolationMergeResult,
  IsolationOutcome,
  IsolationPreview,
  IsolationPruneResult,
  IsolationRemoval,
  IsolationRepo,
  IsolationRepoRevert,
  IsolationRevertResult,
  IsolationRun,
  IsolationTaskRecord,
  IsolationTaskRef,
  IsolationTaskRepo,
  IntegrationDisposal,
  IWorktreeIsolation,
  LandedTask,
  LandedWork,
  PreparedTask,
  PrepareIntent,
  PreviewRepo,
  RepoHead,
  PreservedWork,
  RepairEvidence,
  RevertCommand,
  RevertWatch,
  SetupFailure,
  TreeSnapshot,
} from '../interfaces/IWorktreeIsolation';
import type { Task } from '../models/Task';
import type { HandoffCommit } from '../models/Handoff';
import { shellQuoted } from '../utils/shell';
import { augmentedPath } from '../utils/shellPath';
import { ensureStateDirIgnored, STATE_DIR } from '../utils/fsHelpers';
import { sanitizeSlug } from '../utils/prdStore';
import { absorbRemoval, handoffOf, integrationBranchFor, landedInRepo, noRemoval, PrepareFailedError, repoRootOf, SELF_REPO } from './isolationRecord';
import { defaultExecFile, git, tryGit, type GitExecFn, type GitInvoker, type GitResult } from './gitExec';
import { IsolationLocks } from './isolationLocks';
import { bootstrap, installDirs, isEnvFile, lexists, LINKED_ARTIFACTS, listDir, SetupCommandError } from './worktreeBootstrap';
import { linkPath } from './worktreeLink';
import { landingMessage, messageArgs, revertMessage, runMergeMessage, type LandingCommit, type LandingSubject } from './landingMessage';
import { childDirs, groupPaths, hasGitEntry, workspaceRepoGroup } from './repoGroup';

export type { GitExecFn } from './gitExec';

export interface WorktreeIsolationDeps {
  config: Pick<IConfig, 'worktreeIsolation' | 'worktreeSetupCommand' | 'workspaceRepos' | 'worktreeLinks'>;
  /** Test seam: every git invocation goes through this. */
  execFileImpl?: GitExecFn;
  resolvePath?: () => Promise<string>;
  platform?: NodeJS.Platform;
  mintRunId?: () => string;
  /** Whether the commits Ordewell writes end with the Planned-with trailer; read as each is written, so a change reaches the next landing. */
  plannedWith?: () => boolean;
}

const INTEGRATION_DIR = 'integration';

// Ordewell's own messages land as written: the user's `commit.cleanup` would
// otherwise apply, and `strip` drops a stated `#42 Fix …` subject or a
// `# Changes` line. A config override rather than `--cleanup`, which `git
// merge` only learned in 2.23.
const VERBATIM = ['-c', 'commit.cleanup=whitespace'];

// The names Ordewell gives its own branches and task workspaces; the run id is
// the one segment it owns. Greedy, so a workspace that itself sits in a task
// workspace resolves to the innermost run.
const RUN_BRANCH = /^ordewell\/([^/]+)\/[^/]+$/;
const RUN_WORKTREE = /.*[\\/]\.ordewell[\\/]worktrees[\\/]([^\\/]+)[\\/]/;

// Where work a removal would otherwise delete is kept. Deliberately outside
// `ordewell/`, every branch of which some clean-up or sweep may delete.
const PRESERVED_BRANCHES = 'ordewell-preserved';

// How far below the workspace root a repository is looked for. Deeper ones are
// not scanned for: a walk of the whole tree would visit every dependency folder.
const NESTED_REPO_DEPTH = 2;
const GITLINK_MODE = '160000';

// A look that runs on every window focus must leave the repository as it found
// it: `status` would otherwise refresh the index under a lock a commit in the
// editor then trips over, and run the user's fsmonitor hook.
const READ_ONLY = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

/** One repo's share of a worktree about to be removed, as {@link GitWorktreeIsolation.preserve} reads it; its rescue commit is named from the subject. */
interface RemovalTarget extends LandingSubject {
  /** Absent once the worktree is gone, or for a branch no worktree has. */
  worktree?: string;
  /** Artifacts linked in from the real workspace, which are never the task's work. */
  linked: string[];
  /** The task branch whose tip is kept when no worktree is left; null when there is none. */
  branch: string | null;
  /** The last segment of the branch it is kept on. */
  name: string;
}

/**
 * The repo group a workspace forms, or the reason it forms none. `nested` is
 * the repositories found inside a lone repository, which cannot be isolated
 * with it and are shared live instead; empty for a folder group.
 */
type GroupScan = { paths: string[]; nested: string[]; toplevel?: string } | { refused: IsolationAvailability };

interface QueuedMerge {
  task: Task;
  run: IsolationRun;
  persist: () => void;
  settle: (outcome: IsolationOutcome) => void;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Whether `p`, below `base`, is where its name says, with no link on the way
 * down from `base`: a path the record or a package.json names may run
 * through a link a task put in its worktree, or in place of one. A path that
 * no longer exists has nothing left to unlink.
 */
function resolvesAsNamed(base: string, p: string): boolean {
  try {
    return fs.realpathSync(p) === path.join(fs.realpathSync(base), path.relative(base, p));
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].trim();
}

/** What git said when it stopped, in a line; a hook that printed nothing leaves only how it ended. */
function stoppedOn(result: GitResult): string {
  return firstLine(result.stderr) || firstLine(result.stdout) || `exit status ${result.code ?? 'unknown'}`;
}

/** What a failed `git merge-tree --write-tree --name-only -z` conflicted over: exit 1 after a tree is a conflict; without one, git could not even try. */
function mergeTreeConflict(trial: GitResult): string[] | null {
  const [tree, ...files] = trial.stdout.split('\0').filter(Boolean);
  return trial.code === 1 && /^[0-9a-f]{40,64}$/.test(tree ?? '') ? [...new Set(files)] : null;
}

/** The paths of `git status --porcelain -z`; a rename or copy names both of its paths. */
function statusPaths(porcelain: string): string[] {
  const fields = porcelain.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && fields[i + 1]) paths.push(fields[++i]);
  }
  return paths;
}

/** The directories above `file`, outermost first. */
function directoriesOf(file: string): string[] {
  const parts = file.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * The untracked files that stand where `incoming` has git write a file: the
 * same path, a file where one of its directories must go, or a directory's
 * worth of files where it writes a file.
 */
function collidingPaths(untracked: string[], incoming: Set<string>): string[] {
  const incomingDirs = new Set([...incoming].flatMap(directoriesOf));
  return untracked.filter((file) => incoming.has(file) || incomingDirs.has(file) || directoriesOf(file).some((dir) => incoming.has(dir)));
}

/** The files `git diff --check` reports leftover conflict markers in; its whitespace warnings are not asked about. */
function leftoverMarkerFiles(check: string): string[] {
  const files = check.split(/\r?\n/).flatMap((line) => /^(.+):\d+: leftover conflict marker$/.exec(line)?.[1] ?? []);
  return [...new Set(files)];
}

/**
 * Tracked file → its state, from `git diff --raw -z --no-abbrev`: the mode and
 * blob on the right-hand side, all zeros for a deleted file.
 */
function rawDiffStates(raw: string): Record<string, string> {
  const parts = raw.split('\0');
  const states: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].trim();
    const file = parts[i + 1];
    if (!meta.startsWith(':') || !file) continue;
    const [, mode, , blob] = meta.slice(1).split(' ');
    states[file] = `${mode}:${blob}`;
  }
  return states;
}

/** One merge that landed a task in a repo. */
interface RepoLanding {
  record: LandedTask;
  merge: string;
}

/** What {@link GitWorktreeIsolation.landedLines} reads: {@link LandedWork}, with each repo's landings newest first. */
type LandedLines = Extract<LandedWork, { ok: false }> | (Extract<LandedWork, { ok: true }> & { lines: Map<string, RepoLanding[]> });

/** The merges that landed a task in a repo, oldest first. */
function landingsOf(run: IsolationRun, taskId: string, repoPath: string): string[] {
  const latest = run.tasks[taskId]?.repos[repoPath]?.landedTip;
  return run.landings?.[taskId]?.[repoPath] ?? (latest ? [latest] : []);
}

/** Whether a task has work on the integration branch in a repo: a later attempt's record says nothing of the merges before it. */
function landedIn(run: IsolationRun, taskId: string, repoPath: string): boolean {
  const record = run.tasks[taskId];
  return landingsOf(run, taskId, repoPath).length > 0 || run.carried?.[taskId]?.[repoPath] !== undefined || (record?.status === 'merged' && record.repos[repoPath]?.changed === true);
}

/** Why a task that landed in a repo cannot be reverted by its own merges there; only a merge made since `taskTip` was recorded can have been a resolver's. */
function noOwnMerge(run: IsolationRun, task: LandedTask, repoPath: string): string {
  return run.carried?.[task.taskId]?.[repoPath] || run.tasks[task.taskId]?.repos[repoPath]?.taskTip
    ? `Task "${task.title}" landed work through the merge of the task that resolved its conflict, and that work has no merge of its own to revert. Nothing was reverted.`
    : `Task "${task.title}" landed before Ordewell kept a record of its merge, so it cannot tell which merge to revert. Nothing was reverted.`;
}

/**
 * The title of another task recorded as landed by the same merge. No landing
 * makes one for two tasks: a run saved when a landing recorded the branch's tip
 * whether or not it had moved can say so, and reverting that merge would take
 * the work of whichever task really made it (ADR-0054).
 */
function alsoLandedBy(run: IsolationRun, repoPath: string, taskId: string, merge: string): string | undefined {
  const ids = new Set([...Object.keys(run.tasks), ...Object.keys(run.landings ?? {})]);
  const other = [...ids].find((id) => id !== taskId && landingsOf(run, id, repoPath).includes(merge));
  return other === undefined ? undefined : (run.tasks[other] ?? run.landedTasks?.[other])?.title ?? other;
}

/** Every branch Ordewell makes is under one of these: an integration branch, a task's, a kept one's, or what a removal preserved. */
const OWN_BRANCHES = ['refs/heads/ordewell/', `refs/heads/${PRESERVED_BRANCHES}/`];

/** Ordewell's own branches are no one's: nothing on one is the user's, whatever it holds (ADR-0054). */
const isOwnBranch = (ref: string): boolean => OWN_BRANCHES.some((own) => ref.startsWith(own));

const landedTask = ({ taskId, order, title, commit }: IsolationTaskRecord): LandedTask => ({ taskId, order, title, ...(commit ? { commit } : {}) });

/**
 * A repo with no branch of its own to name takes Merge all as a merge commit:
 * with no base branch to read, that commit is the only thing that tells it from
 * a review checkout of the integration tip (ADR-0054).
 */
const landsAsMergeCommit = (repo: IsolationRepo): boolean => !repo.baseBranch;

const repoName = (repo: Pick<IsolationRepo, 'path'>): string => (repo.path === SELF_REPO ? 'the repository' : repo.path);

function revertCommand(repo: IsolationRepo, record: IsolationTaskRef, merge: string, heldBy: string[], merged: boolean): RevertCommand {
  // Single quotes: the user pastes this, and double quotes would still run a `$(...)` in a directory's name.
  const at = repo.path === SELF_REPO ? '' : `-C ${/^[\w./-]+$/.test(repo.path) ? repo.path : shellQuoted(repo.path)} `;
  return { task: { taskId: record.taskId, order: record.order, title: record.title }, repo: repo.path, commit: merge, command: `git ${at}revert -m 1 ${merge}`, heldBy, merged };
}

/**
 * One order out of each repo's newest-first line: a task goes once it heads
 * every line it is on, and among those the higher plan order first. Repos a
 * group's landings do not share say nothing of each other, so plan order is
 * what is left to say it.
 */
function newestFirst(lines: readonly LandedTask[][]): LandedTask[] {
  const left = lines.map((line) => [...line]);
  const order: LandedTask[] = [];
  for (let heads = left.flatMap((line) => line.slice(0, 1)); heads.length > 0; heads = left.flatMap((line) => line.slice(0, 1))) {
    const free = heads.filter((head) => left.every((line) => !line.includes(head) || line[0] === head));
    const next = (free.length > 0 ? free : heads).reduce((a, b) => (b.order > a.order ? b : a));
    order.push(next);
    for (const line of left) if (line[0] === next) line.shift();
  }
  return order;
}

/** Where a landing or a release leaves a task; a repair in flight ends there too, whatever the outcome. */
function settleStatus(record: IsolationTaskRecord, status: IsolationTaskRecord['status']): void {
  record.status = status;
  delete record.repairBase;
}

function realDir(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function sameDir(a: string, b: string): boolean {
  return realDir(a) === realDir(b);
}

function resolves(target: string): boolean {
  try { fs.statSync(target); return true; } catch { return false; }
}

/** An inactive availability naming `repos`; `.` is not a name, so a group of one names none. */
function inactive(reason: IsolationInactiveReason, repos: string[]): IsolationAvailability {
  const named = repos.filter((r) => r !== SELF_REPO);
  return named.length > 0 ? { active: false, reason, repos: named } : { active: false, reason };
}

/**
 * macOS immutable flags stop a recursive removal with ENOTEMPTY and leave the
 * throwaway worktree behind (ADR-0046). The tree is being discarded, so its
 * flags are cleared first; elsewhere `chflags` does not exist and is not needed.
 */
function clearImmutableFlags(platform: NodeJS.Platform, dir: string): void {
  if (platform !== 'darwin') return;
  spawnSync('/usr/bin/chflags', ['-R', 'nouchg', dir], { stdio: 'ignore' });
}

/**
 * What a task workspace has linked in, read off the directory when no record
 * says: its links, the artifacts linked into every workspace, and the install
 * directories mirrored there.
 */
function leftoverLinks(dir: string): string[] {
  const named = listDir(dir).filter((name) => LINKED_ARTIFACTS.has(name) || isEnvFile(name) || isLink(path.join(dir, name)));
  return [...new Set([...named, ...installDirs(dir)])];
}

function isLink(target: string): boolean {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

class GitWorktreeIsolation implements IWorktreeIsolation {
  private readonly resolvePath: () => Promise<string>;
  private readonly platform: NodeJS.Platform;
  private readonly mintRunId: () => string;

  private readonly gitInvoker: GitInvoker;
  private readonly locks = new IsolationLocks();
  private waiting: QueuedMerge[] = [];
  private draining = false;

  constructor(private readonly deps: WorktreeIsolationDeps) {
    this.resolvePath = deps.resolvePath ?? (() => augmentedPath());
    this.gitInvoker = { exec: deps.execFileImpl ?? defaultExecFile, resolvePath: this.resolvePath };
    this.platform = deps.platform ?? process.platform;
    this.mintRunId = deps.mintRunId ?? (() => randomBytes(4).toString('hex'));
  }

  taskDiff(run: IsolationRun, taskId: string, options: TaskDiffRead): Promise<TaskDiffResult> {
    return readTaskDiff(this.gitInvoker, run, taskId, options);
  }

  async isActive(workspaceRoot: string): Promise<IsolationAvailability> {
    if (!this.deps.config.worktreeIsolation) return { active: false, reason: 'disabled' };

    const version = await this.tryGit(undefined, ['--version']);
    if (!version.ok) return { active: false, reason: 'git-missing' };

    const scan = await this.scanGroup(workspaceRoot);
    if ('refused' in scan) return scan.refused;
    // A commitless repo is shared rather than isolated; only a group of nothing but those is refused.
    const committed = await this.committedRepos(workspaceRoot, scan.paths);
    if (committed.length === 0) return inactive('no-commits', scan.paths);

    const dirty: string[] = [];
    for (const repoPath of committed) {
      const tracked = await this.trackedChanges(repoRootOf(workspaceRoot, repoPath));
      if (tracked === null) return { active: false, reason: 'not-git' };
      if (tracked) dirty.push(repoPath);
    }
    if (dirty.length > 0) return inactive('dirty', dirty);
    if (committed.includes(SELF_REPO)) return scan.nested.length > 0 ? { active: true, shared: scan.nested } : { active: true };
    return { active: true, repos: committed, shared: this.sharedPaths(workspaceRoot, committed) };
  }

  /**
   * The same discovery `isActive` and `startRun` use, read for display: which
   * repositories a run would isolate and where each stands now. Reads only,
   * and takes no turn behind a run's own git work.
   */
  async preview(workspaceRoot: string): Promise<IsolationPreview> {
    try {
      return await this.previewGroup(workspaceRoot);
    } catch (err) {
      return { status: 'failed', repos: [], shared: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async previewGroup(workspaceRoot: string): Promise<IsolationPreview> {
    const enabled = this.deps.config.worktreeIsolation;
    if (!(await this.tryGit(undefined, ['--version'])).ok) {
      // Without git the group is read off the files alone; nothing about any repo is known.
      const repos = workspaceRepoGroup(workspaceRoot, this.deps.config.workspaceRepos)
        .map((repoPath): PreviewRepo => ({ path: repoPath, head: { kind: 'unknown' } }));
      return { status: enabled ? 'git-missing' : 'disabled', repos, shared: [] };
    }

    const scan = await this.scanGroup(workspaceRoot);
    if ('refused' in scan) return { status: enabled ? 'no-repo' : 'disabled', repos: [], shared: [] };

    const repos: PreviewRepo[] = [];
    for (const repoPath of scan.paths) {
      const root = repoRootOf(workspaceRoot, repoPath);
      const head = await this.headOf(root);
      const repo: PreviewRepo = { path: repoPath, head };
      if (scan.toplevel !== undefined) {
        // git names the real path, so a workspace opened through a symlink (macOS's /var, /tmp) is read by its own.
        const top = path.relative(realDir(workspaceRoot), scan.toplevel).split(path.sep).join('/');
        if (top !== '') repo.top = top;
      }
      if (enabled && (head.kind === 'branch' || head.kind === 'detached')) {
        const tracked = await this.trackedChanges(root, { readOnly: true });
        if (tracked !== null) repo.dirty = tracked;
      }
      repos.push(repo);
    }

    if (!enabled) return { status: 'disabled', repos, shared: [] };
    const unreadable = repos.find((r) => r.head.kind === 'unknown' || (r.head.kind !== 'unborn' && r.dirty === undefined));
    if (unreadable) return { status: 'failed', repos, shared: [], error: `git could not be read in ${unreadable.path === SELF_REPO ? 'the workspace' : unreadable.path}` };
    const committed = repos.filter((r) => r.head.kind !== 'unborn').map((r) => r.path);
    if (committed.length === 0) return { status: 'no-commits', repos, shared: [] };
    const shared = committed.includes(SELF_REPO) ? scan.nested : this.sharedPaths(workspaceRoot, committed);
    return { status: repos.some((r) => r.dirty) ? 'dirty' : 'ready', repos, shared };
  }

  private async headOf(root: string): Promise<RepoHead> {
    const branch = (await this.tryGit(root, [...READ_ONLY, 'symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
    const commit = await this.tryGit(root, [...READ_ONLY, 'rev-parse', '--verify', '-q', '--short', 'HEAD']);
    if (commit.ok) return branch ? { kind: 'branch', branch, commit: commit.stdout.trim() } : { kind: 'detached', commit: commit.stdout.trim() };
    // `symbolic-ref` answers for a branch with no commit; an unreadable repository answers neither.
    return branch ? { kind: 'unborn', branch } : { kind: 'unknown' };
  }

  /**
   * A workspace inside a repository is a group of one at `.`, and any
   * repositories nested in it are shared live. A folder that is not forms a
   * group from `workspaceRepos` when set, otherwise from the repositories
   * directly inside it.
   */
  private async scanGroup(workspaceRoot: string): Promise<GroupScan> {
    // cwd may not exist; any failure here is "not a repository" as far as the caller can act on it.
    const toplevel = await this.tryGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
    if (toplevel.ok) return { paths: [SELF_REPO], nested: await this.nestedRepos(workspaceRoot, toplevel.stdout.trim()), toplevel: toplevel.stdout.trim() };
    const paths = groupPaths(workspaceRoot, this.deps.config.workspaceRepos);
    return paths.length > 0 ? { paths, nested: [] } : { refused: { active: false, reason: 'not-git' } };
  }

  private async committedRepos(workspaceRoot: string, paths: string[]): Promise<string[]> {
    const committed: string[] = [];
    for (const repoPath of paths) {
      if ((await this.tryGit(repoRootOf(workspaceRoot, repoPath), ['rev-parse', '--verify', '-q', 'HEAD'])).ok) committed.push(repoPath);
    }
    return committed;
  }

  /** Whether tracked files differ from HEAD; null when git cannot tell. Untracked and ignored files never count: the bootstrap step accounts for them. */
  private async trackedChanges(root: string, opts: { readOnly?: boolean } = {}): Promise<boolean | null> {
    const status = await this.tryGit(root, [...(opts.readOnly ? READ_ONLY : []), 'status', '--porcelain', '--untracked-files=no']);
    return status.ok ? status.stdout.trim() !== '' : null;
  }

  /**
   * Repositories below the workspace that the outer repository does not own as
   * submodules. Isolating the outer one would leave them out of every task
   * worktree, so they are linked live into each task instead. A nested repo the
   * outer repo ignores is shared too: no linked artifact stands in for it, and
   * leaving it out would make it vanish with no word.
   */
  private async nestedRepos(workspaceRoot: string, toplevel: string): Promise<string[]> {
    const found: string[] = [];
    const walk = (rel: string, depth: number): void => {
      for (const name of childDirs(path.join(workspaceRoot, rel))) {
        const child = rel ? `${rel}/${name}` : name;
        if (hasGitEntry(path.join(workspaceRoot, child))) found.push(child);
        else if (depth < NESTED_REPO_DEPTH) walk(child, depth + 1);
      }
    };
    walk('', 1);
    if (found.length === 0) return [];

    const owned = await this.submodulePaths(workspaceRoot, toplevel);
    const prefix = (await this.tryGit(workspaceRoot, ['rev-parse', '--show-prefix'])).stdout.trim();
    return found.filter((rel) => !owned.has(`${prefix}${rel}`));
  }

  /** Paths, relative to the repository's top level, that are submodules: staged gitlinks and `.gitmodules` entries. */
  private async submodulePaths(workspaceRoot: string, toplevel: string): Promise<Set<string>> {
    const paths = new Set<string>();
    const staged = await this.tryGit(workspaceRoot, ['ls-files', '-s', '-z']);
    for (const entry of staged.stdout.split('\0')) {
      const [meta, file] = entry.split('\t');
      if (file !== undefined && meta.startsWith(`${GITLINK_MODE} `)) paths.add(file);
    }
    const declared = await this.tryGit(workspaceRoot, ['config', '-z', '-f', path.join(toplevel, '.gitmodules'), '--get-regexp', '^submodule\\..*\\.path$']);
    for (const entry of declared.stdout.split('\0')) {
      const value = entry.split('\n')[1];
      if (value) paths.add(value.replace(/\/+$/, ''));
    }
    return paths;
  }

  async stash(workspaceRoot: string): Promise<void> {
    const scan = await this.scanGroup(workspaceRoot);
    for (const repoPath of await this.committedRepos(workspaceRoot, 'paths' in scan ? scan.paths : [SELF_REPO])) {
      const root = repoRootOf(workspaceRoot, repoPath);
      if (await this.trackedChanges(root)) await this.git(root, ['stash', 'push', '-m', 'ordewell: stashed before an isolated run']);
    }
  }

  startRun(workspaceRoot: string): Promise<IsolationRun> {
    return this.admin(workspaceRoot, async () => {
      const scan = await this.scanGroup(workspaceRoot);
      const paths = 'paths' in scan ? scan.paths : [SELF_REPO];
      const nested = 'paths' in scan ? scan.nested : [];
      const run: IsolationRun = { id: this.mintRunId(), workspaceRoot, repos: [], shared: [], sharedRepos: [], tasks: {}, keepsEveryLanding: true };
      for (const repoPath of paths) {
        const repo = await this.startRepo(run, repoPath);
        if (repo) run.repos.push(repo);
        else run.sharedRepos.push(repoPath);
      }
      if (run.repos.length === 0) throw new Error(`No repository could be isolated: ${run.sharedRepos.join(', ')}`);
      // A lone repository shares the repositories nested in it; a folder shares its loose entries.
      run.shared = paths.includes(SELF_REPO)
        ? nested
        : this.sharedPaths(workspaceRoot, run.repos.map((r) => r.path));
      return run;
    });
  }

  /** The repo's share of a new run, or null when it cannot be isolated and is to be shared instead. */
  private async startRepo(run: IsolationRun, repoPath: string): Promise<IsolationRepo | null> {
    const root = repoRootOf(run.workspaceRoot, repoPath);
    const head = await this.tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (!head.ok) return null;
    const baseRef = head.stdout.trim();
    const branch = (await this.tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
    const repo: IsolationRepo = {
      path: repoPath,
      root,
      baseRef,
      ...(branch ? { baseBranch: branch } : { startedDetached: true as const }),
      integrationBranch: integrationBranchFor(run.id),
    };
    if (!(await this.tryGit(root, ['branch', repo.integrationBranch, baseRef])).ok) return null;
    if (await this.acceptsWorktree(run, repo)) return repo;
    await this.tryGit(root, ['branch', '-D', repo.integrationBranch]);
    return null;
  }

  /**
   * Whether git will add a worktree for this repo. Only trying tells — a
   * repository format it cannot extend, an admin directory it cannot write —
   * and a refusal found here shares the repo for the whole run instead of
   * failing its first task. `--no-checkout` keeps the try cheap.
   */
  private async acceptsWorktree(run: IsolationRun, repo: IsolationRepo): Promise<boolean> {
    const dir = this.integrationDir(run, repo);
    ensureStateDirIgnored(run.workspaceRoot);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const added = await this.tryGit(repo.root, ['worktree', 'add', '-q', '--no-checkout', dir, repo.integrationBranch]);
    await this.removeWorktreeDir(run, repo, dir, []);
    return added.ok;
  }

  /**
   * What each task workspace links live from the real workspace: everything
   * outside the isolated repos except `.ordewell` and `.git`. A directory that
   * holds a deeper repo is recreated rather than linked, so the repo's worktree
   * can sit at its real path inside it.
   */
  private sharedPaths(workspaceRoot: string, isolated: string[]): string[] {
    if (isolated.includes(SELF_REPO)) return [];
    const shared: string[] = [];
    const walk = (rel: string): void => {
      for (const name of listDir(path.join(workspaceRoot, rel))) {
        if (!rel && (name === STATE_DIR || name === '.git')) continue;
        const child = rel ? `${rel}/${name}` : name;
        if (isolated.includes(child)) continue;
        if (isolated.some((p) => p.startsWith(`${child}/`))) walk(child);
        // A link that leads nowhere, such as an editor's lock file, has nothing to share, and linking it would fail every task.
        else if (resolves(path.join(workspaceRoot, child))) shared.push(child);
      }
    };
    walk('');
    return shared;
  }

  prepare(task: Task, run: IsolationRun, intent: PrepareIntent = 'fresh', opts: { readOnly?: boolean } = {}): Promise<PreparedTask> {
    // The turn first, for any intent: a group's integration tips are only a consistent set between landings. A fresh task branched mid-landing
    // would hold a merge that is rolled back a moment later, and land it through its own.
    return this.inTurn(() => this.admin(run.workspaceRoot, async () => {
      const previous = run.tasks[task.id];
      const replaced = previous ? await this.removeTask(run, previous, { dropRecord: true, intent }) : noRemoval();
      const [refused] = replaced.refused;
      if (refused) {
        throw new Error(`The worktree of its last attempt (${refused.worktree}) holds work Ordewell could not keep (${refused.reason}). Save or remove it by hand, then start the task again`);
      }
      const { branch, dir } = this.namesFor(run, task);
      // What the record did not name: a crash between `worktree add` and the save, or a record lost to another save, leaves a registration, a
      // directory or a branch that would fail the add below, or be reset by it.
      const leftover = await this.clearLeftovers(run, task, { branch, dir });
      const [stuck] = leftover.refused;
      if (stuck) {
        throw new Error(`The worktree of its last attempt (${stuck.worktree}) holds work Ordewell could not keep (${stuck.reason}). Save or remove it by hand, then start the task again`);
      }
      const preserved = intent === 'restore'
        ? [...replaced.preserved, ...leftover.preserved, ...(previous?.continuationWork ?? [])]
        : [...replaced.preserved, ...leftover.preserved];

      const record: IsolationTaskRecord = {
        taskId: task.id, order: task.order, title: task.title, branch, workspace: dir, status: 'active', repos: {},
        ...(opts.readOnly ? { readOnly: true } : {}),
        // A restore continues the same work, so its merges keep the subject its landing stated; a fresh attempt states its own.
        ...(intent === 'restore' && previous?.commit ? { commit: previous.commit } : {}),
      };
      let cwd = dir;
      const copied: string[] = [];
      const setupFailed: SetupFailure[] = [];
      let restoration: PreparedTask['restoration'];
      try {
        ensureStateDirIgnored(run.workspaceRoot);
        for (const repo of run.repos) {
          const worktree = path.join(dir, repo.path);
          const tip = (await this.git(repo.root, ['rev-parse', repo.integrationBranch])).trim();
          fs.mkdirSync(path.dirname(worktree), { recursive: true });
          // -B stays for a branch with no work to lose: clearLeftovers kept and removed what a crashed attempt left, so nothing is reset here that was not kept.
          await this.git(repo.root, ['worktree', 'add', '-q', '-B', branch, worktree, tip]);
          record.repos[repo.path] = { worktree, linked: [], baseRef: tip };
        }

        if (intent === 'restore') {
          restoration = await this.restorePrevious(record, preserved);
        }

        // A group re-takes its loose paths for every task, so a file the user
        // adds mid-run is shared from the next task on; a lone repository's
        // shared paths are the repositories nested in it, fixed for the run.
        const self = run.repos.find((r) => r.path === SELF_REPO);
        if (!self) run.shared = this.sharedPaths(run.workspaceRoot, run.repos.map((r) => r.path));

        for (const repo of run.repos) {
          const entry = record.repos[repo.path];
          const inRepo = await this.inWorkspacePlace(repo, entry.worktree);
          if (repo.path === SELF_REPO) cwd = inRepo;
          const options = { links: this.deps.config.worktreeLinks, platform: this.platform, resolvePath: this.resolvePath };
          let boot;
          try {
            boot = await bootstrap(repo, inRepo, { ...options, setupCommand: this.deps.config.worktreeSetupCommand });
          } catch (err) {
            if (!(err instanceof SetupCommandError)) throw err;
            // The setting is not scoped to one repository: a user-level VS Code
            // setting or an exported variable follows the user into every
            // workspace, and a group runs it in every repo. A command that does
            // not fit this repo must not stop the run, so the repo gets the
            // default links instead, from a checkout wiped of whatever the
            // command left half-done.
            await this.git(entry.worktree, ['reset', '-q', '--hard']);
            await this.git(entry.worktree, ['clean', '-ffdxq']);
            boot = await bootstrap(repo, inRepo, options);
            setupFailed.push({ repo: repo.path, detail: err.detail });
          }
          entry.linked = boot.linked;
          copied.push(...boot.copied.map((name) => path.posix.join(repo.path, name)));
        }

        // After the bootstrap: a nested repo already live through a linked
        // artifact (`vendor/`, `.venv/`) is left as it is, so the whole artifact
        // stays linked. A lone repository's shared paths sit inside its worktree,
        // so they are recorded like its bootstrapped artifacts and kept out of
        // its commit.
        for (const rel of run.shared) {
          const source = path.join(run.workspaceRoot, rel);
          const target = path.join(cwd, rel);
          // A shared path that vanished mid-run is left out rather than failing
          // the task: a group re-scans for every task, a lone repository's
          // nested repositories are fixed for the run.
          if (!resolves(source) || lexists(target)) continue;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (linkPath(source, target, this.platform) === 'copy') copied.push(rel);
          const entry = self ? record.repos[SELF_REPO] : undefined;
          if (entry) entry.linked.push(rel);
        }
      } catch (err) {
        record.status = 'failed';
        await this.removeTask(run, record, { dropRecord: false, preserve: false });
        // The attempt this one replaced is gone with its record; where its work went is the one thing left to say.
        throw preserved.length > 0 ? new PrepareFailedError(err, preserved) : err;
      }
      run.tasks[task.id] = record;
      return {
        cwd, branch, copied,
        ...(setupFailed.length > 0 ? { setupFailed } : {}),
        ...(preserved.length > 0 ? { preserved } : {}),
        ...(restoration ? { restoration } : {}),
      };
    }));
  }

  /**
   * What a task's own names still hold when no record does: a worktree git
   * has registered (prunable or live) or a directory at its path, and the
   * branch itself. Under the session lease only this host prepares in the run
   * (ADR-0049), so a registration no live record holds is a crashed attempt's.
   * Its work is kept as {@link removeTask} keeps it; one that cannot be kept
   * leaves everything in place and is refused. A name another record of the
   * run holds is never touched, and fails the prepare instead.
   */
  private async clearLeftovers(run: IsolationRun, task: Task, names: { branch: string; dir: string }): Promise<IsolationRemoval> {
    const removal = noRemoval();
    const holder = Object.values(run.tasks).find((r) => r.taskId !== task.id && (
      r.branch === names.branch || path.resolve(r.workspace) === path.resolve(names.dir) || isInside(r.workspace, names.dir)));
    if (holder) throw new Error(`Its worktree path or branch is held by the record of task ${holder.order} (${holder.title}); Ordewell will not remove it`);
    const found: { repo: IsolationRepo; worktree: string; target: RemovalTarget }[] = [];
    for (const repo of run.repos) {
      await this.tryGit(repo.root, ['worktree', 'prune']);
      const listed = await this.tryGit(repo.root, ['worktree', 'list', '--porcelain']);
      const registered = listed.stdout.split(/\r?\n\r?\n/).map((block) => ({
        worktree: /^worktree (.+)$/m.exec(block)?.[1],
        branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1],
      }));
      const at = new Set([path.join(names.dir, repo.path)]);
      for (const entry of registered) {
        // Outside the run's own directories it is not ours to remove, whatever branch it has; git's refusal then stands.
        if (entry.worktree && entry.branch === names.branch && isInside(this.runRoot(run), path.resolve(entry.worktree))) at.add(entry.worktree);
      }
      const base = { branch: names.branch, name: path.basename(names.dir), title: task.title };
      for (const worktree of at) {
        // `worktree prune` ran above, so a registration is a directory that exists; a path with neither has nothing to keep or remove.
        if (!fs.existsSync(worktree)) continue;
        const linked = leftoverLinks(path.join(worktree, await this.prefixOf(repo)));
        found.push({ repo, worktree, target: { ...base, worktree, linked } });
      }
      found.push({ repo, worktree: names.dir, target: { ...base, linked: [] } });
    }
    for (const { repo, worktree, target } of found) {
      try {
        const kept = await this.preserve(run, repo, target);
        if (kept && !removal.preserved.some((p) => p.repo === kept.repo && p.branch === kept.branch)) removal.preserved.push(kept);
      } catch (err) {
        removal.refused.push({ worktree, reason: firstLine(err instanceof Error ? err.message : String(err)) });
        return removal;
      }
    }
    for (const { repo, worktree, target } of found) {
      if (target.worktree) await this.removeWorktreeDir(run, repo, worktree, target.linked);
    }
    for (const repo of run.repos) await this.tryGit(repo.root, ['branch', '-D', names.branch]);
    this.removeTaskWorkspace(run, names.dir);
    return removal;
  }

  private async restorePrevious(record: IsolationTaskRecord, preserved: PreservedWork[]): Promise<'restored' | 'fallback'> {
    for (const kept of preserved) {
      const { worktree } = record.repos[kept.repo];
      try {
        // Named for the task: git's default names the internal branch, and this merge lands with the task.
        await this.git(worktree, [...VERBATIM, 'merge', '--no-edit', ...messageArgs(this.message('restore-merge', record)), kept.commit]);
      } catch (err) {
        const unmerged = await this.git(worktree, ['diff', '--name-only', '--diff-filter=U']);
        if (!unmerged.trim()) throw err;
        record.continuationWork = preserved;
        // A restore puts back the whole task or none of it, as a landing does.
        for (const entry of Object.values(record.repos)) {
          await this.tryGit(entry.worktree, ['merge', '--abort']);
          await this.git(entry.worktree, ['reset', '--hard', entry.baseRef!]);
        }
        return 'fallback';
      }
    }
    return 'restored';
  }

  reopen(task: Task, run: IsolationRun): Promise<PreparedTask> {
    return this.admin(run.workspaceRoot, async () => {
      const record = run.tasks[task.id];
      if (record?.status !== 'conflict') throw new Error(`Task ${task.order} has no conflict to repair`);
      let cwd = record.workspace;
      const repairBase: Record<string, string> = {};
      for (const repo of run.repos) {
        const entry = record.repos[repo.path];
        if (!entry) continue;
        if (!fs.existsSync(entry.worktree)) throw new Error(`The worktree of task ${task.order} is gone: ${entry.worktree}`);
        if (repo.path === SELF_REPO) cwd = await this.inWorkspacePlace(repo, entry.worktree);
        // A record from before `changed` was kept names only the repo that stopped it.
        if (entry.changed || repo.path === record.conflictRepo) {
          repairBase[repo.path] = (await this.git(repo.root, ['rev-parse', '--verify', repo.integrationBranch])).trim();
        }
      }
      const files = (record.conflictFiles ?? []).map((file) => (record.conflictRepo && record.conflictRepo !== SELF_REPO ? `${record.conflictRepo}/${file}` : file));
      record.repairs = (record.repairs ?? 0) + 1;
      record.repairBase = repairBase;
      record.repairedFiles = [...new Set([...(record.repairedFiles ?? []), ...files])];
      record.status = 'repairing';
      return { cwd, branch: record.branch, copied: [] };
    });
  }

  async verifyRepair(task: Task, run: IsolationRun): Promise<RepairEvidence> {
    const record = run.tasks[task.id];
    if (!record?.repairBase) return { ok: false, reason: 'failed', repo: record?.conflictRepo ?? SELF_REPO };
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (!entry) continue;
      try {
        await this.commitWorktree(repo, entry, this.message('work', record));
      } catch {
        return { ok: false, reason: 'failed', repo: repo.path };
      }
    }
    for (const repo of run.repos) {
      const base = record.repairBase[repo.path];
      if (base === undefined) continue;
      const contains = await this.tryGit(repo.root, ['merge-base', '--is-ancestor', base, record.branch]);
      if (!contains.ok) return { ok: false, reason: contains.code === 1 ? 'not-merged' : 'failed', repo: repo.path };
      const check = await this.tryGit(repo.root, ['-c', 'core.quotePath=false', 'diff', '--check', base, record.branch]);
      // Exit 2 is "found something", which is whitespace just as often; anything else is git failing.
      if (!check.ok && check.code !== 2) return { ok: false, reason: 'failed', repo: repo.path };
      const files = leftoverMarkerFiles(check.stdout);
      if (files.length > 0) return { ok: false, reason: 'conflict-markers', repo: repo.path, files };
    }
    return { ok: true };
  }

  /**
   * The place in a repo's worktree that matches where the workspace sits in
   * the real repo: the worktree itself, or a subdirectory of it when the
   * workspace root is a subdirectory of the repository.
   */
  private async inWorkspacePlace(repo: IsolationRepo, worktree: string): Promise<string> {
    const prefix = await this.prefixOf(repo);
    return prefix ? path.join(worktree, prefix) : worktree;
  }

  private async prefixOf(repo: IsolationRepo): Promise<string> {
    return (await this.git(repo.root, ['rev-parse', '--show-prefix'])).trim();
  }

  integrate(task: Task, run: IsolationRun, persist: () => void = () => undefined, commit?: HandoffCommit): Promise<IsolationOutcome> {
    const record = run.tasks[task.id];
    if (record && commit) record.commit = commit;
    if (record?.readOnly) {
      // Whatever a read-only task changed was never meant to land (ADR-0046).
      record.status = 'failed';
      record.landingError = 'a read-only task lands nothing';
      return Promise.resolve('failed');
    }
    return new Promise((settle) => {
      this.waiting.push({ task, run, persist, settle });
      // Deferred a microtask so verdicts landing in the same tick queue up
      // together and plan order, not arrival order, decides who merges first.
      if (!this.draining) {
        this.draining = true;
        queueMicrotask(() => void this.drain());
      }
    });
  }

  release(run: IsolationRun, taskId: string, opts: { keep: boolean }): Promise<IsolationRemoval> {
    return this.admin(run.workspaceRoot, async () => {
      const record = run.tasks[taskId];
      if (!record) return noRemoval();
      // A read-only task's worktree is never kept for inspection: nothing in it is work (ADR-0046).
      const removal = opts.keep && !record.readOnly ? noRemoval() : await this.removeTask(run, record, { dropRecord: true });
      if (opts.keep || removal.refused.length > 0) {
        // Off `active` so a crash-recovery prune does not mistake a kept attempt for an orphan.
        if (record.status === 'active') record.status = 'kept';
        else if (record.status === 'repairing') settleStatus(record, 'conflict');
      }
      return removal;
    });
  }

  handoff(run: IsolationRun): Promise<IsolationHandoff> {
    return this.inTurn(() => this.admin(run.workspaceRoot, async () => {
      // A branch checked out in a worktree cannot be checked out in the main
      // one, and the user is about to review it.
      await this.removeIntegrationWorktrees(run);
      await this.settleLanding(run);
      return handoffOf(run);
    }));
  }

  pruneOrphans(run: IsolationRun): Promise<IsolationPruneResult> {
    return this.inTurn(() => this.admin(run.workspaceRoot, async () => {
      // A half-finished merge from a crash is easier to drop than to repair;
      // the branch refs are the only state that matters. What a landing had
      // merged goes back too, since the run was saved as not having it.
      await this.removeIntegrationWorktrees(run);
      await this.settleLanding(run);
      const kept: IsolationPruneResult['kept'] = [];
      const removal = noRemoval();
      for (const record of Object.values(run.tasks)) {
        if (record.readOnly) absorbRemoval(removal, await this.removeTask(run, record, { dropRecord: true }));
        else if (record.status === 'active') {
          // Adopting a plan is not proof its runner died: another host may
          // have adopted the same record mid-run. Deleting an active worktree
          // that still holds work would take the runner's commits and edits
          // with it, so it is kept exactly as an interrupted attempt's is.
          if (await this.holdsUnlandedWork(run, record)) {
            record.status = 'kept';
            kept.push({ taskId: record.taskId, order: record.order, title: record.title });
          } else {
            absorbRemoval(removal, await this.removeTask(run, record, { dropRecord: true }));
          }
        } else if (record.status === 'merged') absorbRemoval(removal, await this.removeTask(run, record, { dropRecord: false }));
        // The work a repair was given is committed on the branch; only the attempt died.
        else if (record.status === 'repairing') settleStatus(record, 'conflict');
      }
      absorbRemoval(removal, await this.removeUnowned(run));
      for (const repo of run.repos) await this.tryGit(repo.root, ['worktree', 'prune']);
      return { kept, ...removal };
    }));
  }

  /**
   * Whether an attempt record still holds work nobody else has: commits its
   * branch carries that the integration branch does not, or edits in its
   * worktree. Only an attempt that left neither behind is safe to prune.
   */
  private async holdsUnlandedWork(run: IsolationRun, record: IsolationTaskRecord): Promise<boolean> {
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (!entry) continue;
      if (await this.brings(repo, record.branch)) return true;
      if (await this.worktreeHasChanges(entry, await this.prefixOf(repo))) return true;
    }
    return false;
  }

  /**
   * Changes in a worktree, ignoring the artifacts Ordewell bootstrapped there
   * so a prepared-but-untouched attempt still reads as empty. `prefix` is where
   * the workspace sits in the repo, which is what the recorded link names are
   * relative to. A worktree git cannot read is treated as holding work: it is
   * out of sync, and deleting it is the one action that cannot be undone.
   */
  private async worktreeHasChanges(entry: IsolationTaskRepo, prefix: string): Promise<boolean> {
    if (!fs.existsSync(entry.worktree)) return false;
    // Asked for explicitly: the user's `status.showUntrackedFiles=no` would otherwise hide new files, and a worktree of nothing else would be deleted unkept.
    const status = await this.tryGit(entry.worktree, ['status', '--porcelain', '-z', '--untracked-files=normal']);
    if (!status.ok) return true;
    const linked = new Set(entry.linked);
    return statusPaths(status.stdout).some((p) => {
      const rel = (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p).replace(/\/+$/, '');
      return !linked.has(rel) && !linked.has(rel.split('/')[0]);
    });
  }

  async findInHead(run: IsolationRun): Promise<string[]> {
    const changed: string[] = [];
    for (const record of Object.values(run.tasks)) {
      if (record.status !== 'merged') continue;
      const merged = await this.headContains(run, record);
      if (merged === !!record.inHead) continue;
      if (merged) record.inHead = true;
      else delete record.inHead;
      changed.push(record.taskId);
    }
    return changed;
  }

  private async headContains(run: IsolationRun, record: IsolationTaskRecord): Promise<boolean> {
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      // Every merge of the task, since a later attempt's record says nothing of those before it. A task landed before its tip was recorded counts as merged once the whole integration branch is.
      const landed = [...landingsOf(run, record.taskId, repo.path), ...(entry?.changed && !entry.landedTip ? [repo.integrationBranch] : [])];
      for (const commit of landed) {
        if (!(await this.inUserBranch(repo, commit)) && !(await this.integrationGone(repo))) return false;
      }
    }
    return true;
  }

  /**
   * Is this work merged, so a gate may open and a run may close (ADR-0054)?
   * Strict, since a false yes clears a run: only the user's own branch counts.
   * That is the branch the run started on, a fast-forward of it included, under
   * any name its reflog gives it. Git is asked every time and wherever the user
   * stands, since a saved fact goes with the record it is on. A revert asks
   * something else, of {@link holdersOf}.
   */
  private async inUserBranch(repo: IsolationRepo, commit: string): Promise<boolean> {
    const sha = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', `${commit}^{commit}`]);
    if (!sha.ok) return false;
    const merge = sha.stdout.trim();
    if (!repo.baseBranch) return this.mergedIntoCheckout(repo, merge);
    const holding = await this.branchesHolding(repo, merge);
    if (!holding?.length) return false;
    return (await this.userBranches(repo))?.some((ref) => holding.includes(ref)) ?? false;
  }

  /**
   * The branch the run started on, as it stands now. The reflog speaks first: a
   * branch whose reflog says it was renamed from that name is the one, so a new
   * branch taking the old name is never the user's. It has to hold the commit the
   * run started from, or the rename was before the run and says nothing of it.
   * With no such branch it is the one of that name. Null when git cannot say.
   */
  private async userBranches(repo: IsolationRepo): Promise<string[] | null> {
    const named = `refs/heads/${repo.baseBranch}`;
    const branches = await this.tryGit(repo.root, ['for-each-ref', '--format=%(refname)', 'refs/heads/']);
    if (!branches.ok) return null;
    const renamed: string[] = [];
    for (const ref of branches.stdout.split(/\r?\n/).filter((branch) => branch && !isOwnBranch(branch))) {
      // `git branch -m` takes the reflog along and writes the old name in it, whether or not a new branch has since taken that name.
      const log = await this.tryGit(repo.root, ['log', '-g', '-1', '--format=%H', '-F', `--grep-reflog=Branch: renamed ${named} to `, ref]);
      if (!log.ok) return null;
      if (log.stdout.trim() && (await this.tryGit(repo.root, ['merge-base', '--is-ancestor', repo.baseRef, ref])).ok) renamed.push(ref);
    }
    return renamed.length > 0 ? renamed : [named];
  }

  /**
   * A run with no base branch has only what is checked out for the user's own
   * branch, and it has to show a merge: `merge` off its first-parent line, and no
   * tip of Ordewell's that holds `merge` on it, or it stands on that tip as a
   * review does, whatever merged it there.
   */
  private async mergedIntoCheckout(repo: IsolationRepo, merge: string): Promise<boolean> {
    if (!(await this.tryGit(repo.root, ['merge-base', '--is-ancestor', merge, 'HEAD'])).ok) return false;
    const line = await this.tryGit(repo.root, ['rev-list', '--first-parent', 'HEAD']);
    if (!line.ok) return false;
    const onLine = new Set(line.stdout.split(/\r?\n/));
    const own = await this.tryGit(repo.root, ['for-each-ref', '--contains', merge, '--format=%(objectname)', ...OWN_BRANCHES]);
    if (!own.ok) return false;
    return ![merge, ...own.stdout.split(/\r?\n/).filter(Boolean)].some((commit) => onLine.has(commit));
  }

  /**
   * May a revert touch this merge (ADR-0054)? Not while anything of the user's
   * holds it: what that is goes unread, since a review and a merge look alike and
   * a revert refuses when it cannot be sure. So these are every local branch that
   * is not Ordewell's, the base branch always, and a detached HEAD, as 'HEAD',
   * unless it stands on a tip of Ordewell's. Null when git cannot say, which is
   * no answer: a revert needs to know that nothing holds the merge.
   */
  private async holdersOf(repo: IsolationRepo, merge: string): Promise<string[] | null> {
    const holding = await this.branchesHolding(repo, merge);
    if (!holding) return null;
    const holders = holding
      .filter((ref) => ref === `refs/heads/${repo.baseBranch}` || !isOwnBranch(ref))
      .map((ref) => ref.replace(/^refs\/heads\//, ''));
    const detached = !(await this.tryGit(repo.root, ['symbolic-ref', '-q', 'HEAD'])).ok;
    if (!detached) return holders;
    const inHead = await this.tryGit(repo.root, ['merge-base', '--is-ancestor', merge, 'HEAD']);
    if (!inHead.ok) return inHead.code === 1 ? holders : null;
    const onOwnTip = await this.tryGit(repo.root, ['for-each-ref', '--points-at', 'HEAD', '--format=%(refname)', ...OWN_BRANCHES]);
    if (!onOwnTip.ok) return null;
    return onOwnTip.stdout.trim() ? holders : [...holders, 'HEAD'];
  }

  /** Every local branch that holds `commit`; null when git cannot say, which is not the same as none. */
  private async branchesHolding(repo: IsolationRepo, commit: string): Promise<string[] | null> {
    const holding = await this.tryGit(repo.root, ['for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/heads/']);
    return holding.ok ? holding.stdout.split(/\r?\n/).filter(Boolean) : null;
  }

  /**
   * The repo's integration branch is gone — deleted by hand, or by a squash
   * merge's clean-up — in a repo git can read. Merge all merges that branch by
   * name, so no merge can bring the work in again, and it is not offered as
   * work to merge. A repo git cannot read at all (moved, or git failing)
   * proves nothing either way and counts as not merged. So does a ref it cannot
   * read: `rev-parse --verify -q` exits 1 for that as for one not there, where
   * this lists nothing and warns, so gone is an empty answer with nothing said.
   */
  private async integrationGone(repo: IsolationRepo): Promise<boolean> {
    if (!(await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', 'HEAD'])).ok) return false;
    const listed = await this.tryGit(repo.root, ['for-each-ref', '--format=%(refname)', `refs/heads/${repo.integrationBranch}`]);
    return listed.ok && !listed.stdout.trim() && !listed.stderr.trim();
  }

  async snapshotTree(workspaceRoot: string, exclude: readonly string[]): Promise<TreeSnapshot | null> {
    const scan = await this.scanGroup(workspaceRoot);
    if ('refused' in scan) return null;
    const repos = (await this.committedRepos(workspaceRoot, scan.paths)).filter((repoPath) => !exclude.includes(repoPath));
    if (repos.length === 0) return null;
    const snapshot: TreeSnapshot = {};
    for (const repoPath of repos) {
      const states = await this.trackedStates(repoRootOf(workspaceRoot, repoPath));
      if (states) snapshot[repoPath] = states;
    }
    return snapshot;
  }

  async changedSince(workspaceRoot: string, snapshot: TreeSnapshot): Promise<string[]> {
    const changed: string[] = [];
    for (const [repoPath, before] of Object.entries(snapshot)) {
      const now = await this.trackedStates(repoRootOf(workspaceRoot, repoPath));
      if (!now) continue;
      for (const [file, state] of Object.entries(now)) {
        if (before[file] !== state) changed.push(repoPath === SELF_REPO ? file : `${repoPath}/${file}`);
      }
    }
    return changed.sort();
  }

  /**
   * Each tracked file that differs from HEAD, with what it holds. `git stash
   * create` records the working tree as a commit without touching the tree,
   * the index or the stash, so a file changed again is told apart from one
   * left as it was. Null when git cannot tell — a merge in progress, say.
   */
  private async trackedStates(root: string): Promise<Record<string, string> | null> {
    const stash = await this.tryGit(root, ['stash', 'create']);
    if (!stash.ok) return null;
    const commit = stash.stdout.trim();
    if (!commit) return {};
    const diff = await this.tryGit(root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', 'HEAD', commit]);
    return diff.ok ? rawDiffStates(diff.stdout) : null;
  }

  /**
   * One section per repo with changes. A repo below the workspace root gets a
   * header and paths prefixed with its own, so the whole reads as one patch
   * over the workspace; a repo that is the workspace needs neither.
   */
  async reviewDiff(run: IsolationRun): Promise<string> {
    let diff = '';
    for (const repo of run.repos) {
      const prefixes = repo.path === SELF_REPO ? [] : [`--src-prefix=a/${repo.path}/`, `--dst-prefix=b/${repo.path}/`];
      const section = await this.git(repo.root, ['diff', ...prefixes, repo.baseRef, repo.integrationBranch]);
      if (section === '') continue;
      if (repo.path !== SELF_REPO) diff += `# ${repo.path}: ${repo.integrationBranch} against ${repo.baseRef.slice(0, 12)}\n`;
      diff += section;
    }
    return diff;
  }

  mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult> {
    return this.inTurn(() => this.mergeAll(run));
  }

  private async mergeAll(run: IsolationRun): Promise<IsolationMergeResult> {
    const partial = await this.settleLanding(run);
    if (partial.length > 0) return { outcome: 'blocked', blocked: partial.map((repo) => ({ repo, reason: 'partial-landing', files: [] })) };
    // Every repo, not only those with work: the confirmations promise each is on its starting branch.
    const misplaced = await this.offBaseBranch(run.repos);
    const repos = await this.reposWithWork(run);
    if (misplaced.length > 0) return { outcome: 'blocked', blocked: misplaced };
    // One repo needs no preflight: its merge lands or is aborted whole, as it always has.
    if (run.repos.length === 1 || !(await this.canPreflight())) return this.mergeInTurn(run, repos);
    const blocked: IsolationMergeBlock[] = [];
    for (const repo of repos) {
      const block = await this.preflight(repo);
      if (block) blocked.push(block);
    }
    return blocked.length > 0 ? { outcome: 'blocked', blocked } : this.mergeInTurn(run, repos);
  }

  /** Repos whose integration branch holds commits their base does not; one git cannot tell about is kept, so its merge says what is wrong. */
  private async reposWithWork(run: IsolationRun): Promise<IsolationRepo[]> {
    const withWork: IsolationRepo[] = [];
    for (const repo of run.repos) {
      const ahead = await this.tryGit(repo.root, ['rev-list', '--count', `${repo.baseRef}..${repo.integrationBranch}`]);
      if (!ahead.ok || Number(ahead.stdout.trim()) > 0) withWork.push(repo);
    }
    return withWork;
  }

  /**
   * A merge goes into whatever is checked out, which is only what the user
   * meant if it is the branch the run started on. A run that started on a
   * detached HEAD named no branch, so anything is as good as it was.
   */
  private async offBaseBranch(repos: IsolationRepo[]): Promise<IsolationMergeBlock[]> {
    const off: IsolationMergeBlock[] = [];
    for (const repo of repos) {
      if (!repo.baseBranch) continue;
      const current = (await this.tryGit(repo.root, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
      if (current === repo.baseBranch) continue;
      off.push({
        repo: repo.path, reason: 'wrong-branch', files: [], expected: repo.baseBranch,
        ...(current ? { actual: current } : (await this.rebaseInProgress(repo.root)) ? { rebasing: true as const } : {}),
      });
    }
    return off;
  }

  /** `git merge-tree --write-tree`, which merges without touching a tree, arrived in git 2.38. */
  private canPreflight(): Promise<boolean> {
    return this.gitAtLeast(2, 38);
  }

  private async gitAtLeast(wantMajor: number, wantMinor: number): Promise<boolean> {
    const version = await this.tryGit(undefined, ['--version']);
    const [, major, minor] = /(\d+)\.(\d+)/.exec(version.stdout) ?? [];
    return Number(major) > wantMajor || (Number(major) === wantMajor && Number(minor) >= wantMinor);
  }

  /** Why this repo could not take its merge right now, found without touching the user's tree; null when it can. */
  private async preflight(repo: IsolationRepo): Promise<IsolationMergeBlock | null> {
    const block = (reason: IsolationMergeBlockReason, files: string[] = []): IsolationMergeBlock => ({ repo: repo.path, reason, files });
    if (await this.mergeInProgress(repo.root)) return block('merge-in-progress');

    const trial = await this.tryGit(repo.root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', repo.integrationBranch]);
    if (!trial.ok) {
      const files = mergeTreeConflict(trial);
      return files ? block('conflict', files) : block('git-error');
    }

    // Git would refuse to merge over these, or worse, leave a half-merge in a tree holding the user's edits.
    const incoming = await this.tryGit(repo.root, ['diff', '--name-only', '--no-renames', '-z', `HEAD...${repo.integrationBranch}`]);
    const status = await this.tryGit(repo.root, ['status', '--porcelain', '-z', '--untracked-files=no']);
    // Ignored files are left out: a merge writes over those without a word.
    const untracked = await this.tryGit(repo.root, ['ls-files', '--others', '--exclude-standard', '-z']);
    const staged = await this.tryGit(repo.root, ['diff', '--cached', '--name-only', '-z']);
    if (!incoming.ok || !status.ok || !untracked.ok || !staged.ok) return block('git-error');
    const touched = new Set(incoming.stdout.split('\0').filter(Boolean));
    const inTheWay = [
      ...statusPaths(status.stdout).filter((file) => touched.has(file)),
      ...collidingPaths(untracked.stdout.split('\0').filter(Boolean), touched),
      // A merge commit is refused over anything staged, overlapping or not; a fast-forward is not.
      ...(staged.stdout && !(await this.fastForwards(repo)) ? staged.stdout.split('\0').filter(Boolean) : []),
    ];
    return inTheWay.length > 0 ? block('uncommitted-changes', [...new Set(inTheWay)]) : null;
  }

  /** Whether merging the integration branch moves HEAD without a merge commit: the checked-out HEAD is its ancestor, and the merge is allowed to. */
  private async fastForwards(repo: IsolationRepo): Promise<boolean> {
    return !landsAsMergeCommit(repo) && (await this.tryGit(repo.root, ['merge-base', '--is-ancestor', 'HEAD', repo.integrationBranch])).ok;
  }

  /** Merge each repo in turn, stopping at the first that does not take its merge. Only a merge started here is ever aborted. */
  private async mergeInTurn(run: IsolationRun, repos: IsolationRepo[]): Promise<IsolationMergeResult> {
    const landed: string[] = [];
    const stopped = (outcome: 'conflict' | 'failed', repo: IsolationRepo, extra: { files?: string[]; error?: string } = {}): IsolationMergeResult => ({
      outcome,
      repo: repo.path,
      ...(extra.files ? { files: extra.files } : {}),
      ...(extra.error ? { error: extra.error } : {}),
      ...(landed.length > 0 ? { landed } : {}),
    });
    for (const repo of repos) {
      // The user keeps working in this tree during a run. An unfinished merge
      // there is theirs: git refuses ours, and the abort below would otherwise
      // throw away their resolution as if it were ours.
      if (await this.mergeInProgress(repo.root)) return stopped('failed', repo);
      const message = runMergeMessage(this.bringsToHead(run, repo), this.deps.plannedWith?.() ?? false);
      const merge = await this.tryGit(repo.root, [...VERBATIM, 'merge', '--no-edit', ...(landsAsMergeCommit(repo) ? ['--no-ff'] : []), ...messageArgs(message), repo.integrationBranch]);
      if (merge.ok) {
        landed.push(repo.path);
        continue;
      }
      const files = await this.unmergedPaths(repo.root);
      // Not `abortMerge`: its `reset --hard` fallback is for Ordewell's own
      // integration worktree, and here it would discard uncommitted work.
      if (await this.mergeInProgress(repo.root)) await this.tryGit(repo.root, ['merge', '--abort']);
      return files.length > 0 ? stopped('conflict', repo, { files }) : stopped('failed', repo, { error: stoppedOn(merge) });
    }
    return { outcome: 'merged' };
  }

  /** The landed tasks that changed `repo` and are not in the user's HEAD yet, in plan order: what Merge all brings there. */
  private bringsToHead(run: IsolationRun, repo: IsolationRepo): IsolationTaskRecord[] {
    return Object.values(run.tasks)
      .filter((record) => record.status === 'merged' && !record.inHead && landedInRepo(run, record, repo.path))
      .sort((a, b) => a.order - b.order);
  }

  discard(run: IsolationRun, opts: { integration: IntegrationDisposal }): Promise<IsolationRemoval> {
    return this.inTurn(() => this.admin(run.workspaceRoot, async () => {
      await this.removeIntegrationWorktrees(run);
      const removal = noRemoval();
      for (const record of Object.values(run.tasks)) {
        absorbRemoval(removal, await this.removeTask(run, record, { dropRecord: record.status !== 'merged' }));
      }
      absorbRemoval(removal, await this.removeUnowned(run));
      if (opts.integration !== 'keep') {
        for (const repo of run.repos) {
          if (opts.integration === 'delete') await this.tryGit(repo.root, ['branch', '-D', repo.integrationBranch]);
          else await this.deleteIfMerged(repo, repo.integrationBranch);
        }
        // A refused worktree keeps its record: the one pointer left to what is still in it.
        const refused = new Set(removal.refused.flatMap((r) => (r.task ? [r.task.taskId] : [])));
        run.tasks = Object.fromEntries(Object.entries(run.tasks).filter(([taskId]) => refused.has(taskId)));
        this.removeIfEmpty(this.runRoot(run));
      }
      for (const repo of run.repos) await this.tryGit(repo.root, ['worktree', 'prune']);
      return removal;
    }));
  }

  sweep(run: IsolationRun): Promise<void> {
    return this.admin(run.workspaceRoot, async () => {
      const failed: string[] = [];
      for (const repo of run.repos) {
        if (!(await this.sweepRepo(run, repo))) failed.push(repo.path);
      }
      if (failed.length > 0) throw new Error(`git failed clearing merged branches of earlier runs in ${failed.join(', ')}`);
    });
  }

  /** False when git failed anywhere; the other branches are still tried. */
  private async sweepRepo(run: IsolationRun, repo: IsolationRepo): Promise<boolean> {
    await this.tryGit(repo.root, ['worktree', 'prune']);
    const worktrees = await this.tryGit(repo.root, ['worktree', 'list', '--porcelain']);
    const refs = await this.tryGit(repo.root, ['for-each-ref', '--format=%(refname)', 'refs/heads/ordewell/']);
    if (!worktrees.ok || !refs.ok) return false;

    const checkedOut = new Set<string>();
    const liveRuns = new Set<string>();
    for (const line of worktrees.stdout.split(/\r?\n/)) {
      if (line.startsWith('branch refs/heads/')) checkedOut.add(line.slice('branch refs/heads/'.length));
      const runId = line.startsWith('worktree ') ? RUN_WORKTREE.exec(line)?.[1] : undefined;
      if (runId) liveRuns.add(runId);
    }

    let ok = true;
    for (const ref of refs.stdout.split(/\r?\n/).filter(Boolean)) {
      const branch = ref.slice('refs/heads/'.length);
      const runId = RUN_BRANCH.exec(branch)?.[1];
      if (!runId || runId === run.id || liveRuns.has(runId) || checkedOut.has(branch)) continue;
      if ((await this.deleteIfMerged(repo, branch)) === 'failed') ok = false;
    }
    return ok;
  }

  /**
   * Delete `branch` only if the repo's checked-out HEAD already contains it —
   * HEAD, not an upstream: what the user has checked out is what they merged
   * into — and that is a merge, not a review checkout standing on the branch.
   * `-d` rather than `-D`, so git also refuses a branch a worktree has checked
   * out.
   */
  private async deleteIfMerged(repo: IsolationRepo, branch: string): Promise<'deleted' | 'kept' | 'failed'> {
    const merged = await this.tryGit(repo.root, ['merge-base', '--is-ancestor', branch, 'HEAD']);
    if (!merged.ok) return merged.code === 1 ? 'kept' : 'failed';
    if (!(await this.inUserBranch(repo, branch))) return 'kept';
    return (await this.tryGit(repo.root, ['branch', '-d', branch])).ok ? 'deleted' : 'failed';
  }

  private async drain(): Promise<void> {
    try {
      while (this.waiting.length > 0) {
        // Only ever the lowest order among tasks already waiting: blocking for a
        // lower one that has not finished would deadlock against its dependents.
        const runId = this.waiting[0].run.id;
        let pick = -1;
        this.waiting.forEach((entry, i) => {
          if (entry.run.id === runId && (pick < 0 || entry.task.order < this.waiting[pick].task.order)) pick = i;
        });
        const [entry] = this.waiting.splice(pick, 1);
        entry.settle(await this.inTurn(() => this.land(entry.task, entry.run, entry.persist)).catch((): IsolationOutcome => 'failed'));
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Land a task in every repo it changed, or in none. The tips are recorded
   * on the run and persisted before the first merge, so a rollback — now, or
   * after a crash — knows exactly what to return to.
   */
  private async land(task: Task, run: IsolationRun, persist: () => void): Promise<IsolationOutcome> {
    const record = run.tasks[task.id];
    if (!record) return 'failed';
    if (record.status === 'merged') return 'merged';
    // A landing left half-rolled-back would have this one merged on top of it.
    if ((await this.settleLanding(run)).length > 0) return this.stopLanding(record, 'failed');

    const changed: IsolationRepo[] = [];
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (!entry) continue;
      // Named before git is asked: a worktree removed under a running attempt
      // fails every git call with the same opaque error, and the user needs to
      // know the directory is gone, not that a command exited non-zero.
      if (!fs.existsSync(entry.worktree)) {
        return this.stopLanding(record, 'failed', repo, undefined, `its worktree is gone (${entry.worktree})`);
      }
      try {
        await this.commitWorktree(repo, entry, this.message('work', record));
        entry.taskTip = (await this.git(repo.root, ['rev-parse', '--verify', `refs/heads/${record.branch}^{commit}`])).trim();
      } catch (err) {
        const detail = firstLine(err instanceof Error ? err.message : String(err));
        return this.stopLanding(record, 'failed', repo, undefined, `git could not commit its work (${detail})`);
      }
      // A resolver may have landed this branch already; what it changed stays recorded.
      if (await this.brings(repo, record.branch)) {
        entry.changed = true;
        changed.push(repo);
      } else {
        entry.changed ??= false;
      }
    }

    const landedTips: [IsolationRepo, string][] = [];
    if (changed.length > 0) {
      try {
        const tips: Record<string, string> = {};
        for (const repo of changed) tips[repo.path] = (await this.git(repo.root, ['rev-parse', '--verify', repo.integrationBranch])).trim();
        run.landing = { taskId: task.id, tips };
        persist();
      } catch {
        delete run.landing;
        return this.stopLanding(record, 'failed');
      }
      for (const repo of changed) {
        const merged = await this.mergeTask(run, repo, record);
        if (merged.outcome === 'merged') {
          landedTips.push([repo, merged.tip]);
          continue;
        }
        const { outcome, files, error } = merged;
        return (await this.settleLanding(run)).length === 0 ? this.stopLanding(record, outcome, repo, files, error) : this.stopLanding(record, 'failed', repo);
      }
    }

    const carried = await this.carriedIn(run, record, landedTips);
    // No await between these: a persist must never see the landing cleared
    // without the task merged, nor a merge a rollback may yet take off counted as landed.
    for (const [repo, tip] of landedTips) {
      record.repos[repo.path].landedTip = tip;
      ((run.landings ??= {})[task.id] ??= {})[repo.path] = [...landingsOf(run, task.id, repo.path).filter((merge) => merge !== tip), tip];
      (run.landedTasks ??= {})[task.id] = landedTask(record);
    }
    for (const { other, repo, tip } of carried) {
      const tips = ((run.carried ??= {})[other.taskId] ??= {});
      tips[repo.path] = [...tips[repo.path] ?? [], tip];
      (run.landedTasks ??= {})[other.taskId] = landedTask(other);
    }
    delete run.landing;
    settleStatus(record, 'merged');
    delete record.continuationWork;
    delete record.conflictRepo;
    delete record.conflictFiles;
    delete record.landingError;
    // The work is on the integration branches already; a stuck cleanup must
    // not turn that into a failure. `pruneOrphans` sweeps up whatever it leaves.
    await this.admin(run.workspaceRoot, () => this.removeTask(run, record, { dropRecord: false })).catch(() => undefined);
    return 'merged';
  }

  /** What a task's merges just brought in of a task yet to land: a conflict's resolver, which took that task's branch with it. */
  private async carriedIn(run: IsolationRun, record: IsolationTaskRecord, landedTips: readonly [IsolationRepo, string][]): Promise<{ other: IsolationTaskRecord; repo: IsolationRepo; tip: string }[]> {
    const carried: { other: IsolationTaskRecord; repo: IsolationRepo; tip: string }[] = [];
    for (const [repo, merge] of landedTips) {
      for (const other of Object.values(run.tasks)) {
        const entry = other.repos[repo.path];
        if (other === record || other.status === 'merged' || !entry?.changed || !entry.taskTip) continue;
        if (await this.broughtBy(repo, entry.taskTip, merge)) carried.push({ other, repo, tip: entry.taskTip });
      }
    }
    return carried;
  }

  /** Whether a landing's merge is what put `tip` on the integration branch. */
  private async broughtBy(repo: IsolationRepo, tip: string, merge: string): Promise<boolean> {
    return (await this.tryGit(repo.root, ['merge-base', '--is-ancestor', tip, merge])).ok
      && !(await this.tryGit(repo.root, ['merge-base', '--is-ancestor', tip, `${merge}^1`])).ok;
  }

  async readLanded(run: IsolationRun, taskIds: readonly string[]): Promise<LandedWork> {
    const read = await this.landedLines(run, taskIds);
    return read.ok ? { ok: true, tasks: read.tasks, inBranch: read.inBranch } : read;
  }

  /**
   * Each repo's share of the tasks' landings, newest first. The integration
   * branch is one line of landings, so its first parents say the order, in
   * each repo and however the record was saved; records alone could not tell
   * it across a group.
   */
  private async landedLines(run: IsolationRun, taskIds: readonly string[]): Promise<LandedLines> {
    const records = taskIds.flatMap((id): LandedTask | [] => run.tasks[id] ?? run.landedTasks?.[id] ?? []);
    const lines = new Map<string, RepoLanding[]>();
    const inBranch: RevertCommand[] = [];
    if (!(await this.gitAtLeast(2, 40))) return { ok: false, reason: 'git', error: 'A revert needs git 2.40 or newer, to merge without touching a worktree. Nothing was reverted.' };
    for (const repo of run.repos) {
      const landed = records.filter(({ taskId }) => landedIn(run, taskId, repo.path));
      if (landed.length === 0) continue;
      const unmerged = landed.find(({ taskId }) => landingsOf(run, taskId, repo.path).length === 0 || run.carried?.[taskId]?.[repo.path]);
      if (unmerged) return { ok: false, reason: 'no-own-merge', error: noOwnMerge(run, unmerged, repo.path) };
      const held = await this.integrationHeldBy(run, repo);
      if (!held) return { ok: false, reason: 'git', error: `Git could not say where the integration branch${repo.path === SELF_REPO ? '' : ` of ${repo.path}`} is checked out, and a revert that cannot be sure refuses. Nothing was reverted.` };
      if (held.worktree) return { ok: false, reason: 'checked-out', error: `The integration branch${repo.path === SELF_REPO ? '' : ` of ${repo.path}`} is checked out in ${held.worktree}, and a revert has to commit to it. Check out another branch there first. Nothing was reverted.` };
      const off = await this.integrationOffBranch(run, repo);
      if (off) return { ok: false, reason: 'checked-out', error: `The integration worktree ${this.integrationDir(run, repo)} is ${off}, and a revert has to commit to that branch there. Check it out there first. Nothing was reverted.` };
      const line = await this.tryGit(repo.root, ['rev-list', '--first-parent', repo.integrationBranch]);
      const position = new Map(line.stdout.split(/\r?\n/).filter(Boolean).map((commit, i) => [commit, i]));
      const at = ({ merge }: RepoLanding) => position.get(merge) ?? -1;
      const landings = landed.flatMap((record) => landingsOf(run, record.taskId, repo.path).map((merge) => ({ record, merge }))).sort((a, b) => at(a) - at(b));
      lines.set(repo.path, landings);
      for (const { record, merge } of landings) {
        const shared = alsoLandedBy(run, repo.path, record.taskId, merge);
        if (shared) return { ok: false, reason: 'no-own-merge', error: `Tasks "${record.title}" and "${shared}" are recorded as landed by the same merge, so Ordewell cannot tell whose work a revert of it would take. Nothing was reverted.` };
        const heldBy = await this.holdersOf(repo, merge);
        if (!heldBy) return { ok: false, reason: 'git', error: `Git could not say what holds the merge of task "${record.title}" in ${repoName(repo)}, and a revert that cannot be sure refuses. Nothing was reverted.` };
        if (heldBy.length > 0) inBranch.push(revertCommand(repo, record, merge, heldBy, await this.inUserBranch(repo, merge)));
        else if (!position.has(merge)) return { ok: false, reason: 'git', error: `The merge of task "${record.title}" is not on the integration branch in ${repoName(repo)}.` };
        const carried = await this.carriedBy(run, repo, merge);
        if (carried) return { ok: false, reason: 'no-own-merge', error: `The work of task "${carried}" landed through the merge of task "${record.title}", so reverting that merge would take it too, and it has no merge of its own to go with it. Nothing was reverted.` };
      }
    }
    const tasks = newestFirst([...lines.values()].map((line) => [...new Set(line.map((l) => l.record))])).map((record) => ({
      taskId: record.taskId, order: record.order, title: record.title,
      repos: [...lines].filter(([, line]) => line.some((l) => l.record === record)).map(([repoPath]) => repoPath),
    }));
    return { ok: true, lines, tasks, inBranch };
  }

  /**
   * The title of a task whose work `merge` brought in without being its own
   * landing: a conflicted task its resolver took along. Reverting it would
   * remove work no record lets go of, whether that task made no merge, landed
   * one later or lost its record to a retry. `run.carried` keeps what a record
   * dropped since can no longer say; the records still answer for a run saved
   * before it, and for a task whose branch went in by any other merge.
   */
  private async carriedBy(run: IsolationRun, repo: IsolationRepo, merge: string): Promise<string | undefined> {
    const kept = Object.entries(run.carried ?? {}).flatMap(([taskId, repos]) => (repos[repo.path] ?? []).map((tip) => ({ taskId, tip })));
    const recorded = Object.values(run.tasks).flatMap(({ taskId, repos }) => (repos[repo.path]?.changed && repos[repo.path].taskTip ? [{ taskId, tip: repos[repo.path].taskTip! }] : []));
    for (const { taskId, tip } of [...kept, ...recorded]) {
      if (landingsOf(run, taskId, repo.path).includes(merge)) continue;
      if (await this.broughtBy(repo, tip, merge)) return (run.tasks[taskId] ?? run.landedTasks?.[taskId])?.title ?? taskId;
    }
    return undefined;
  }

  revert(run: IsolationRun, taskIds: readonly string[], watch: RevertWatch): Promise<IsolationRevertResult> {
    return this.inTurn(() => this.revertInTurn(run, taskIds, watch));
  }

  private async revertInTurn(run: IsolationRun, taskIds: readonly string[], watch: RevertWatch): Promise<IsolationRevertResult> {
    const partial = await this.settleLanding(run);
    if (partial.length > 0) return { outcome: 'failed', error: `a landing could not be rolled back in ${partial.join(', ')}` };
    const refusal = watch.refusal();
    if (refusal) return { outcome: 'refused', reason: refusal };
    const read = await this.landedLines(run, taskIds);
    if (!read.ok) return read.reason === 'git' ? { outcome: 'failed', error: read.error } : { outcome: 'refused', reason: read.error };
    if (read.inBranch.length > 0) return { outcome: 'in-branch', commands: read.inBranch };
    if (read.tasks.length === 0) return { outcome: 'refused', reason: 'None of this has landed any more, so there is nothing to revert.' };

    const repos = run.repos.filter((repo) => read.lines.has(repo.path));
    const tips: Record<string, string> = {};
    for (const repo of repos) tips[repo.path] = (await this.git(repo.root, ['rev-parse', '--verify', repo.integrationBranch])).trim();
    const reverts = Object.fromEntries([...read.lines.keys()].map((repoPath) => [repoPath, { commits: [] as string[] }]));
    run.landing = { taskId: read.tasks[0].taskId, tips, reverts };
    watch.persist();

    for (const repo of repos) {
      const strayed = async (): Promise<IsolationRevertResult> => {
        const unsettled = await this.settleLanding(run);
        const left = `the integration branch of ${repoName(repo)} is not what the revert made in ${this.integrationDir(run, repo)}, so the revert did not reach it`;
        return { outcome: 'failed', repo: repo.path, error: unsettled.length > 0 ? `${left}, and the integration branch could not be put back in ${unsettled.join(', ')}` : left };
      };
      let onto = tips[repo.path];
      for (const { record, merge } of read.lines.get(repo.path)!) {
        const stopped = await this.revertLanding(run, repo, record, merge, onto, (commit) => {
          reverts[repo.path].commits.push(commit);
          watch.persist();
        });
        if ('strayed' in stopped) return strayed();
        if (!('onto' in stopped)) {
          const unsettled = await this.settleLanding(run);
          const task = { taskId: record.taskId, order: record.order, title: record.title };
          if (unsettled.length > 0) return { outcome: 'failed', task, repo: repo.path, error: `${'error' in stopped ? stopped.error : 'it conflicted'}, and the integration branch could not be put back in ${unsettled.join(', ')}` };
          return 'files' in stopped ? { outcome: 'conflict', task, repo: repo.path, files: stopped.files } : { outcome: 'failed', task, repo: repo.path, error: stopped.error };
        }
        onto = stopped.onto;
      }
      // A line of landings a later one had already taken out makes no commit, and the branch may have moved under that too.
      const at = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', repo.integrationBranch]);
      if (at.stdout.trim() !== onto) return strayed();
    }

    // Judged again with the commits made: a plan loaded while they were being made has not seen them, and the rollback leaves it nothing to see.
    const late = watch.refusal();
    if (late) {
      const unsettled = await this.settleLanding(run);
      return unsettled.length > 0 ? { outcome: 'failed', error: `${late} The integration branch could not be put back in ${unsettled.join(', ')}` } : { outcome: 'refused', reason: late };
    }

    // No await between these: a persist must never see the records gone with the tasks not back, or the tips cleared with either undone.
    delete run.landing;
    for (const { taskId } of read.tasks) {
      const record = run.tasks[taskId];
      if (record?.status === 'merged') delete run.tasks[taskId];
      // A later attempt that never landed holds a worktree only its record names. With the task going back its conflict is over, and nothing repairs or lands it now.
      else if (record?.status === 'conflict') {
        settleStatus(record, 'kept');
        delete record.conflictRepo;
        delete record.conflictFiles;
      }
      delete run.landings?.[taskId];
      delete run.landedTasks?.[taskId];
      delete run.landedOn?.[taskId];
    }
    run.reverted = true;
    watch.settled(read.tasks.map((t) => t.taskId));
    return { outcome: 'reverted', tasks: read.tasks };
  }

  /**
   * Revert one merge that landed a task, as a commit Ordewell words, on top of
   * `onto`, and say the tip that leaves or what stopped it. All of it is off to
   * the side until the branch moves, from the tip it was asked to move from: the
   * merge is a tree, the commit is saved before it goes on the branch, and the
   * worktree comes last, by a two-tree read that leaves every other path as it is,
   * staged or not (ADR-0054).
   */
  private async revertLanding(run: IsolationRun, repo: IsolationRepo, record: LandedTask, merge: string, onto: string, save: (commit: string) => void): Promise<{ files: string[] } | { error: string } | { strayed: true } | { onto: string }> {
    const trial = await this.tryGit(repo.root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${merge}`, onto, `${merge}^1`]);
    if (!trial.ok) {
      const files = mergeTreeConflict(trial);
      return files ? { files } : { error: `git could not revert it (${stoppedOn(trial)})` };
    }
    const tree = trial.stdout.split('\0')[0].trim();
    // A later landing took all of it out already, so there is nothing to commit.
    if ((await this.tryGit(repo.root, ['rev-parse', `${onto}^{tree}`])).stdout.trim() === tree) return { onto };
    // `commit-tree` reads no `commit.gpgsign`, and a repository that signs its commits signs this one.
    const sign = (await this.tryGit(repo.root, ['config', '--type=bool', 'commit.gpgsign'])).stdout.trim() === 'true' ? ['-S'] : [];
    const commit = await this.tryGit(repo.root, ['commit-tree', ...sign, tree, '-p', onto, ...messageArgs(revertMessage(record, merge, this.deps.plannedWith?.() ?? false))]);
    if (!commit.ok) return { error: `git could not commit its revert (${stoppedOn(commit)})` };
    const made = commit.stdout.trim();
    save(made);

    const held = await this.integrationHeldBy(run, repo);
    if (!held) return { error: 'git could not say where the integration branch is checked out' };
    if (held.worktree || (await this.integrationOffBranch(run, repo))) return { strayed: true };
    const ref = `refs/heads/${repo.integrationBranch}`;
    if (!(await this.tryGit(repo.root, ['update-ref', ref, made, onto])).ok) return { strayed: true };
    const dir = this.integrationDir(run, repo);
    if (!fs.existsSync(path.join(dir, '.git'))) return { onto: made };
    const read = await this.readAcross(dir, onto, made);
    if (read.ok) return { onto: made };
    // Only the branch moved, so only the branch goes back: a rollback's read would start from a tree this worktree never took.
    if (!(await this.tryGit(repo.root, ['update-ref', ref, onto, made])).ok) return { strayed: true };
    return { error: `a change in ${dir} is in its way (${stoppedOn(read)}): commit or clear it there first` };
  }

  private stopLanding(record: IsolationTaskRecord, outcome: Exclude<IsolationOutcome, 'merged'>, repo?: IsolationRepo, files?: string[], error?: string): IsolationOutcome {
    settleStatus(record, outcome);
    if (error) record.landingError = error;
    else delete record.landingError;
    if (repo) record.conflictRepo = repo.path;
    else delete record.conflictRepo;
    if (files && files.length > 0) record.conflictFiles = files;
    else delete record.conflictFiles;
    return outcome;
  }

  /** Merge the task branch into one repo's integration branch. A merge that does not complete is aborted: it is Ordewell's own. */
  private async mergeTask(run: IsolationRun, repo: IsolationRepo, record: IsolationTaskRecord): Promise<{ outcome: 'merged'; tip: string } | { outcome: Exclude<IsolationOutcome, 'merged'>; files: string[]; error?: string }> {
    let dir: string;
    try {
      dir = await this.ensureIntegrationWorktree(run, repo);
    } catch (err) {
      return { outcome: 'failed', files: [], error: await this.integrationWorktreeError(repo, err) };
    }
    const off = await this.integrationOffBranch(run, repo);
    if (off) return { outcome: 'failed', files: [], error: `its integration worktree ${dir} is ${off}` };
    const merge = await this.tryGit(dir, [...VERBATIM, 'merge', '--no-ff', '--no-edit', ...messageArgs(this.message('merge', record)), record.branch]);
    if (merge.ok) {
      const tip = await this.mergeMade(run, repo, record);
      return tip ? { outcome: 'merged', tip } : { outcome: 'failed', files: [], error: `its merge did not reach the integration branch: the integration worktree ${dir} left it` };
    }
    // A hook that refuses the merge commit leaves a merge in progress with nothing unmerged: a failure, not a conflict.
    const files = await this.unmergedPaths(dir);
    if (await this.mergeInProgress(dir)) await this.abortMerge(dir);
    return files.length > 0 ? { outcome: 'conflict', files } : { outcome: 'failed', files, error: `git could not merge its work (${stoppedOn(merge)})` };
  }

  /**
   * The merge that just landed a task, read off the integration branch and not
   * HEAD: its tip with the landing's recorded tip and the task's for parents.
   * Nothing else may be called this task's landing, or a revert of it would
   * take whatever really made that commit (ADR-0054).
   */
  private async mergeMade(run: IsolationRun, repo: IsolationRepo, record: IsolationTaskRecord): Promise<string | null> {
    const listed = await this.tryGit(repo.root, ['rev-list', '--parents', '-n', '1', repo.integrationBranch]);
    const [tip, onto, brought, ...more] = listed.stdout.trim().split(' ');
    return listed.ok && onto === run.landing?.tips[repo.path] && brought === record.repos[repo.path].taskTip && more.length === 0 ? tip : null;
  }

  /**
   * Why the integration worktree could not be prepared. Git refuses to check a
   * branch out in two worktrees at once, so the usual cause is the integration
   * branch sitting in the user's own checkout; naming it is the actionable part
   * of git's error, which would otherwise be dropped.
   */
  private async integrationWorktreeError(repo: IsolationRepo, err: unknown): Promise<string> {
    const holder = (await this.worktreeHolding(repo, repo.integrationBranch))?.worktree;
    if (holder) return `the integration branch is checked out in ${holder}`;
    return `git could not prepare its integration worktree (${firstLine(err instanceof Error ? err.message : String(err))})`;
  }

  /**
   * Return every repo of the landing in flight to its recorded tip, then
   * forget the landing. Resolves to the repos still holding part of it: a tip
   * git would not move stays recorded, so the next attempt tries again rather
   * than building on top of it.
   */
  private async settleLanding(run: IsolationRun): Promise<string[]> {
    const landing = run.landing;
    if (!landing) return [];
    const unsettled: string[] = [];
    for (const repo of run.repos) {
      const tip = landing.tips[repo.path];
      if (tip !== undefined && !(await this.restoreTip(run, repo, tip, landing.reverts?.[repo.path]))) unsettled.push(repo.path);
    }
    if (unsettled.length === 0) delete run.landing;
    return unsettled;
  }

  /**
   * Put a repo's integration branch back at `tip`. Only ever a branch
   * Ordewell owns, and only when what sits on it is one merge on top of `tip`
   * — the one the serialized queue made — or, for a revert, its own commits and
   * nothing else; anything else is left alone, since
   * resetting it could drop work that is not this landing's. The branch
   * moves with Ordewell's integration worktree if it is checked out there,
   * and not at all if it is checked out anywhere else, or if git cannot say
   * and that worktree is not on it: a checkout may be under the branch.
   */
  private async restoreTip(run: IsolationRun, repo: IsolationRepo, tip: string, reverts?: IsolationRepoRevert): Promise<boolean> {
    const current = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', repo.integrationBranch]);
    if (!current.ok) return false;
    const head = current.stdout.trim();
    if (head === tip) return true;
    if (!(await (reverts ? this.isRevertsOn(repo, head, tip, reverts) : this.isOneMergeOn(repo, head, tip)))) return false;

    const dir = this.integrationDir(run, repo);
    const held = await this.worktreeHolding(repo, repo.integrationBranch);
    // With no list, the run's own worktree can still answer for itself, and a branch moved without it would leave it out of step.
    if (!held && (!fs.existsSync(path.join(dir, '.git')) || (await this.integrationOffBranch(run, repo)))) return false;
    const holder = held ? held.worktree : dir;
    if (holder === null) return (await this.tryGit(repo.root, ['update-ref', `refs/heads/${repo.integrationBranch}`, tip, head])).ok;
    if (!sameDir(holder, dir)) return false;
    if (reverts) return this.takeCommitsOff(holder, head, tip);
    return (await this.tryGit(holder, ['reset', '-q', '--hard', tip])).ok;
  }

  /**
   * Take a revert off the integration worktree, leaving what has been staged or
   * changed there since where it is: a hard reset would take it (ADR-0054). Git
   * refuses over a path the revert touched, and then it stays, recorded, until
   * that change is cleared.
   */
  private async takeCommitsOff(dir: string, from: string, tip: string): Promise<boolean> {
    return (await this.readAcross(dir, from, tip)).ok && (await this.tryGit(dir, ['reset', '-q', '--soft', tip])).ok;
  }

  /** Bring a worktree from one tree to another, every path neither changes left as it is. Git refuses, and writes nothing, over a change on a path they do. */
  private async readAcross(dir: string, from: string, to: string): Promise<GitResult> {
    await this.tryGit(dir, ['update-index', '-q', '--refresh']);
    return this.tryGit(dir, ['read-tree', '-m', '-u', from, to]);
  }

  private async isOneMergeOn(repo: IsolationRepo, head: string, tip: string): Promise<boolean> {
    const parent = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', `${head}^1`]);
    const merge = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', `${head}^2`]);
    return merge.ok && parent.stdout.trim() === tip;
  }

  /**
   * Whether `head` is `tip` with this revert's own commits on it and nothing
   * else: the line it saved, each on the last (ADR-0054). A commit is saved before
   * the branch moves, so the line can run past `head` and never short of it.
   */
  private async isRevertsOn(repo: IsolationRepo, head: string, tip: string, { commits }: IsolationRepoRevert): Promise<boolean> {
    const listed = await this.tryGit(repo.root, ['rev-list', '--reverse', '--parents', `${tip}..${head}`]);
    if (!listed.ok) return false;
    let onto = tip;
    for (const [i, entry] of listed.stdout.split(/\r?\n/).filter(Boolean).entries()) {
      const [commit, ...parents] = entry.split(' ');
      if (parents.length !== 1 || parents[0] !== onto || commit !== commits[i]) return false;
      onto = commit;
    }
    return onto === head;
  }

  /** {@link worktreeHolding} for the repo's integration branch, not counting Ordewell's own: a commit from anywhere else cannot reach it. */
  private async integrationHeldBy(run: IsolationRun, repo: IsolationRepo): Promise<{ worktree: string | null } | null> {
    const held = await this.worktreeHolding(repo, repo.integrationBranch);
    return held?.worktree && sameDir(held.worktree, this.integrationDir(run, repo)) ? { worktree: null } : held;
  }

  /**
   * Where the run's own integration worktree stands, when that is not the
   * integration branch: git commits to whatever HEAD says, so a commit made
   * there would never reach the branch. Null too when there is no such worktree
   * yet, since one made for the work is on it (ADR-0054).
   */
  private async integrationOffBranch(run: IsolationRun, repo: IsolationRepo): Promise<string | null> {
    const dir = this.integrationDir(run, repo);
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    const head = (await this.tryGit(dir, ['symbolic-ref', '-q', 'HEAD'])).stdout.trim();
    if (head === `refs/heads/${repo.integrationBranch}`) return null;
    return `${head ? `on ${head.replace(/^refs\/heads\//, '')}` : 'detached'}, not on ${repo.integrationBranch}`;
  }

  /** The worktree that has `branch` checked out, null in it when none does; null for all of it when git cannot say, which is not the same as none. */
  private async worktreeHolding(repo: IsolationRepo, branch: string): Promise<{ worktree: string | null } | null> {
    // Not `-z`: that needs git 2.36, and the Merge-all fallback serves older git.
    const listed = await this.tryGit(repo.root, ['worktree', 'list', '--porcelain']);
    if (!listed.ok) return null;
    let worktree: string | null = null;
    for (const line of listed.stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length);
      else if (line === `branch refs/heads/${branch}`) return { worktree };
    }
    return { worktree: null };
  }

  /** Whether the task branch holds commits the repo's integration branch does not. */
  private async brings(repo: IsolationRepo, branch: string): Promise<boolean> {
    const ahead = await this.tryGit(repo.root, ['rev-list', '--count', `${repo.integrationBranch}..${branch}`]);
    return ahead.ok && Number(ahead.stdout.trim()) > 0;
  }

  private async commitWorktree(repo: IsolationRepo, entry: Pick<IsolationTaskRepo, 'worktree' | 'linked'>, message: string, opts: { rescue?: boolean } = {}): Promise<void> {
    // Bootstrapped links are untracked, and an ignore rule like `node_modules/`
    // does not match a symlink — without this they would be committed. Staging
    // one that is a junction would even walk into the main tree's contents.
    // Only links git does not already ignore need excluding: naming an ignored
    // path such as `.env` in an exclude pathspec makes `add` refuse.
    const prefix = await this.prefixOf(repo);
    const excludes: string[] = [];
    for (const name of entry.linked) {
      if ((await this.tryGit(entry.worktree, ['check-ignore', '-q', '--', prefix + name])).ok) continue;
      excludes.push(`:(exclude,literal)${(prefix + name).replace(/\\/g, '/')}`);
    }
    await this.git(entry.worktree, ['add', '-A', '--', '.', ...excludes]);
    const staged = await this.tryGit(entry.worktree, ['diff', '--cached', '--quiet']);
    if (staged.ok) return;
    // A rescue exists only so a removal deletes nothing: a hook that refuses
    // the commit, or a signing prompt nobody will answer, must not stop it.
    const commit = opts.rescue ? ['-c', 'commit.gpgsign=false', 'commit', '--no-verify'] : ['commit'];
    await this.git(entry.worktree, [...VERBATIM, ...commit, '-q', ...messageArgs(message)]);
  }

  /** A message Ordewell writes, with the trailer if the user's setting says so right now. */
  private message(kind: LandingCommit, from: LandingSubject): string {
    return landingMessage(kind, from, this.deps.plannedWith?.() ?? false);
  }

  private integrationDir(run: IsolationRun, repo: IsolationRepo): string {
    return path.join(this.runRoot(run), INTEGRATION_DIR, repo.path);
  }

  private async ensureIntegrationWorktree(run: IsolationRun, repo: IsolationRepo): Promise<string> {
    return this.admin(run.workspaceRoot, async () => {
      const dir = this.integrationDir(run, repo);
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      await this.tryGit(repo.root, ['worktree', 'prune']);
      ensureStateDirIgnored(run.workspaceRoot);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await this.git(repo.root, ['worktree', 'add', '-q', dir, repo.integrationBranch]);
      return dir;
    });
  }

  private async removeIntegrationWorktrees(run: IsolationRun): Promise<void> {
    for (const repo of run.repos) await this.removeWorktreeDir(run, repo, this.integrationDir(run, repo), []);
  }

  /**
   * A task's worktrees and branch go, and with `dropRecord` its record — but
   * never work that has not landed: that is kept on a branch first
   * ({@link preserve}), and a task whose work cannot be kept in every repo
   * loses nothing, record included. `preserve: false` is only for what a
   * failed `prepare` made a moment ago, which holds no work yet. A read-only
   * task's holds none either (ADR-0046), and keeping it would mean running
   * git, as the user, in a worktree its sealed commands wrote, `.git` file
   * and all.
   */
  private async removeTask(run: IsolationRun, record: IsolationTaskRecord, opts: { dropRecord: boolean; preserve?: boolean; intent?: PrepareIntent }): Promise<IsolationRemoval> {
    const task = { taskId: record.taskId, order: record.order, title: record.title };
    const removal = noRemoval();
    for (const repo of opts.preserve === false || record.readOnly ? [] : run.repos) {
      const entry = record.repos[repo.path];
      const target: RemovalTarget = { worktree: entry?.worktree, linked: entry?.linked ?? [], branch: record.branch, name: path.basename(record.workspace), title: record.title, commit: record.commit };
      try {
        const kept = await this.preserve(run, repo, target, opts.intent);
        if (kept) removal.preserved.push({ task, ...kept });
      } catch (err) {
        removal.refused.push({ task, worktree: entry?.worktree ?? record.workspace, reason: firstLine(err instanceof Error ? err.message : String(err)) });
        return removal;
      }
    }
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (entry) await this.removeWorktreeDir(run, repo, entry.worktree, entry.linked);
      await this.tryGit(repo.root, ['branch', '-D', record.branch]);
    }
    this.removeTaskWorkspace(run, record.workspace);
    if (opts.dropRecord) delete run.tasks[record.taskId];
    return removal;
  }

  /**
   * Keep what one repo's share of a worktree holds that has not landed, before
   * it is removed: edits never committed go into a rescue commit on whatever
   * the worktree has checked out, and that tip gets a branch of its own under
   * `ordewell-preserved/<run-id>/`. With no worktree left, it is the task
   * branch's tip that is kept. Null when there is nothing to keep — the tip is
   * on the integration branch, or, outside a restore, in what the user has
   * checked out. Throws when there is work git cannot keep, and the caller
   * then removes nothing.
   */
  private async preserve(run: IsolationRun, repo: IsolationRepo, target: RemovalTarget, intent: PrepareIntent = 'fresh'): Promise<Omit<PreservedWork, 'task'> | null> {
    const tip = await this.tipToKeep(repo, target);
    if (tip === null) return null;
    // A restore starts from integration, even if the user's HEAD already contains this tip.
    for (const into of intent === 'restore' ? [repo.integrationBranch] : [repo.integrationBranch, 'HEAD']) {
      if ((await this.tryGit(repo.root, ['merge-base', '--is-ancestor', tip, into])).ok) return null;
    }
    return { repo: repo.path, branch: await this.preservedBranch(run, repo, target.name, tip), commit: tip };
  }

  private async tipToKeep(repo: IsolationRepo, target: RemovalTarget): Promise<string | null> {
    const { worktree } = target;
    if (worktree && fs.existsSync(worktree)) {
      // Asked outside a worktree, git would answer for the repository around it.
      if (!hasGitEntry(worktree)) throw new Error('it is not a git worktree any more');
      if (await this.worktreeHasChanges({ worktree, linked: target.linked }, await this.prefixOf(repo))) {
        await this.commitWorktree(repo, { worktree, linked: target.linked }, this.message('rescue', target), { rescue: true });
      }
      return (await this.git(worktree, ['rev-parse', '--verify', 'HEAD'])).trim();
    }
    if (target.branch === null) return null;
    const branch = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', `refs/heads/${target.branch}`]);
    return branch.ok ? branch.stdout.trim() : null;
  }

  /** A new branch at `tip` named for the task; never one that already holds something else. */
  private async preservedBranch(run: IsolationRun, repo: IsolationRepo, name: string, tip: string): Promise<string> {
    const base = `${PRESERVED_BRANCHES}/${run.id}/${name}`;
    for (let n = 1; n < 100; n++) {
      const branch = n === 1 ? base : `${base}-${n}`;
      const existing = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
      if (existing.ok && existing.stdout.trim() === tip) return branch;
      if (existing.ok) continue;
      await this.git(repo.root, ['branch', '--no-track', branch, tip]);
      return branch;
    }
    throw new Error(`no free branch name under ${base}`);
  }

  /**
   * What is left of a task workspace once its worktrees are gone: the shared
   * links and the directories that held deeper repos. Links are unlinked
   * first, so removing the rest can never walk into the real workspace.
   */
  private removeTaskWorkspace(run: IsolationRun, dir: string): void {
    if (!isInside(this.runRoot(run), dir) || !fs.existsSync(dir)) return;
    this.unlinkLinksUnder(dir);
    clearImmutableFlags(this.platform, dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private unlinkLinksUnder(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) this.unlinkIfLink(target);
      else if (entry.isDirectory()) this.unlinkLinksUnder(target);
    }
  }

  /**
   * Task workspaces and branches under this run that no record accounts for —
   * what a crash or a lost save leaves. No record says what was linked in, so
   * whatever a workspace still has linked is left out of what counts as work.
   */
  private async removeUnowned(run: IsolationRun): Promise<IsolationRemoval> {
    const removal = noRemoval();
    const keep = async (repo: IsolationRepo, target: RemovalTarget, worktree: string): Promise<boolean> => {
      try {
        const kept = await this.preserve(run, repo, target);
        // A leftover workspace's branch is left over too, and is kept at the same tip.
        if (kept && !removal.preserved.some((p) => p.repo === kept.repo && p.branch === kept.branch)) removal.preserved.push(kept);
        return true;
      } catch (err) {
        removal.refused.push({ worktree, reason: firstLine(err instanceof Error ? err.message : String(err)) });
        return false;
      }
    };
    const owned = new Set(Object.values(run.tasks).map((r) => path.resolve(r.workspace)));
    const root = this.runRoot(run);
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        const dir = path.join(root, entry);
        if (entry === INTEGRATION_DIR || owned.has(path.resolve(dir))) continue;
        let kept = true;
        for (const repo of run.repos) {
          const worktree = path.join(dir, repo.path);
          const linked = leftoverLinks(path.join(worktree, await this.prefixOf(repo)));
          if (!(await keep(repo, { worktree, linked, branch: null, name: entry, title: entry }, worktree))) kept = false;
        }
        if (!kept) continue;
        for (const repo of run.repos) await this.removeWorktreeDir(run, repo, path.join(dir, repo.path), []);
        this.removeTaskWorkspace(run, dir);
      }
    }
    const taskBranches = Object.values(run.tasks).map((r) => r.branch);
    for (const repo of run.repos) {
      const ownedBranches = new Set([repo.integrationBranch, ...taskBranches]);
      const listed = await this.tryGit(repo.root, ['branch', '--list', `ordewell/${run.id}/*`, '--format=%(refname:short)']);
      for (const branch of listed.stdout.split('\n').map((b) => b.trim()).filter(Boolean)) {
        if (ownedBranches.has(branch)) continue;
        const name = branch.slice(branch.lastIndexOf('/') + 1);
        if (await keep(repo, { linked: [], branch, name, title: name }, branch)) await this.tryGit(repo.root, ['branch', '-D', branch]);
      }
    }
    return removal;
  }

  private async removeWorktreeDir(run: IsolationRun, repo: IsolationRepo, dir: string, linked: string[]): Promise<void> {
    // Links first, so no removal path can ever walk through one into the main
    // worktree's node_modules. A mirrored install is a real directory of links;
    // it is found again from package.json when no record names it. Only
    // where the way to it is still the run's own directories: a link a task
    // put in place of one would lead the unlinking into a directory of the
    // user's.
    for (const name of new Set([...linked, ...installDirs(dir)])) {
      const target = path.join(dir, name);
      if (!resolvesAsNamed(this.runRoot(run), path.dirname(target))) continue;
      this.unlinkIfLink(target);
      this.unlinkLinksUnder(target);
    }
    for (const name of resolvesAsNamed(this.runRoot(run), dir) ? fs.readdirSync(dir) : []) {
      if (LINKED_ARTIFACTS.has(name) || isEnvFile(name)) this.unlinkIfLink(path.join(dir, name));
    }
    await this.tryGit(repo.root, ['worktree', 'remove', '--force', dir]);
    if (fs.existsSync(dir) && isInside(this.runRoot(run), dir)) {
      clearImmutableFlags(this.platform, dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await this.tryGit(repo.root, ['worktree', 'prune']);
    // A deeper repo's worktree leaves the directories above it behind.
    for (let parent = path.dirname(dir); isInside(this.runRoot(run), parent); parent = path.dirname(parent)) this.removeIfEmpty(parent);
  }

  private unlinkIfLink(target: string): void {
    try {
      if (fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target, { force: true });
    } catch { /* nothing there */ }
  }

  private removeIfEmpty(dir: string): void {
    try { fs.rmdirSync(dir); } catch { /* not empty, or already gone */ }
  }

  private runRoot(run: IsolationRun): string {
    return path.join(run.workspaceRoot, STATE_DIR, 'worktrees', run.id);
  }

  private namesFor(run: IsolationRun, task: Task): { branch: string; dir: string } {
    const slug = sanitizeSlug(task.title).slice(0, 40).replace(/-+$/, '') || 'task';
    let name = `${task.order}-${slug}`;
    const clash = Object.values(run.tasks).some((r) => r.taskId !== task.id && r.branch === `ordewell/${run.id}/${name}`);
    if (clash) name = `${name}-${sanitizeSlug(task.id) || 'x'}`;
    return { branch: `ordewell/${run.id}/${name}`, dir: path.join(this.runRoot(run), name) };
  }

  private async unmergedPaths(cwd: string): Promise<string[]> {
    const listed = await this.tryGit(cwd, ['diff', '--name-only', '-z', '--diff-filter=U']);
    return [...new Set(listed.stdout.split('\0').filter(Boolean))];
  }

  private async mergeInProgress(cwd: string): Promise<boolean> {
    if ((await this.tryGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok) return true;
    return (await this.tryGit(cwd, ['ls-files', '-u'])).stdout.trim() !== '';
  }

  /** A rebase leaves HEAD detached, so it is told from a checkout the user detached on purpose. */
  private async rebaseInProgress(cwd: string): Promise<boolean> {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const found = await this.tryGit(cwd, ['rev-parse', '--git-path', dir]);
      if (found.ok && fs.existsSync(path.resolve(cwd, found.stdout.trim()))) return true;
    }
    return false;
  }

  private async abortMerge(cwd: string): Promise<void> {
    if (!(await this.tryGit(cwd, ['merge', '--abort'])).ok) await this.tryGit(cwd, ['reset', '--hard']);
  }

  private inTurn<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.inTurn(fn);
  }

  private admin<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.admin(workspaceRoot, fn);
  }

  private tryGit(cwd: string | undefined, args: string[]): Promise<GitResult> {
    return tryGit(this.gitInvoker, cwd, args);
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return git(this.gitInvoker, cwd, args);
  }
}

/** The preview alone, for a surface that shows isolation without ever running it. */
export function createIsolationPreview(deps: Pick<WorktreeIsolationDeps, 'config' | 'execFileImpl' | 'resolvePath'>): IIsolationPreview {
  return new GitWorktreeIsolation(deps);
}

export function createWorktreeIsolation(deps: WorktreeIsolationDeps): IWorktreeIsolation {
  return new GitWorktreeIsolation(deps);
}
